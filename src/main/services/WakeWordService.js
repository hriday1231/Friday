/**
 * WakeWordService — local wake-word detection via OpenWakeWord (ONNX).
 *
 * Pipeline (three chained ONNX models, all run in the main process):
 *   raw int16 audio @ 16 kHz
 *      → melspectrogram.onnx     → mel frames (32-dim per frame)
 *      → embedding_model.onnx    → 96-dim embedding (per 76-frame window)
 *      → <phrase>.onnx           → wake probability ∈ [0, 1]
 *
 * Streaming approach:
 *   - Caller pushes Float32 audio frames at 16 kHz (any size).
 *   - We buffer audio into 80ms chunks (1280 samples) and run melspec per chunk.
 *   - Each chunk yields ~5 new mel frames. A 76-frame mel window produces one
 *     embedding; we shift the window by 8 frames between embedding calls.
 *   - The wake model runs over a rolling buffer of the last 16 embeddings.
 *   - When probability > threshold and cooldown elapsed, onWake(prob) fires.
 *
 * Models are downloaded once to <userData>/friday/wakeword/ and cached forever.
 * Source: github.com/dscripka/openWakeWord/releases/tag/v0.5.1 (Apache-2.0).
 */

const path = require('path');
const fs = require('fs');
const https = require('https');
const ort = require('onnxruntime-node');

const OPENWAKEWORD_RELEASE = 'v0.5.1';
const RELEASE_BASE = `https://github.com/dscripka/openWakeWord/releases/download/${OPENWAKEWORD_RELEASE}`;

const SAMPLE_RATE      = 16000;
const CHUNK_SAMPLES    = 1280;   // 80 ms @ 16 kHz
const MEL_DIM          = 32;     // mel frames are 32-dim
const EMB_WINDOW       = 76;     // embedding model expects 76 mel frames
const EMB_DIM          = 96;     // embeddings are 96-dim
const WAKE_WINDOW      = 16;     // wake model expects 16 embeddings
// Each 80ms chunk produces FRAMES_PER_CHUNK new mel frames (measured: 5 on the
// stock openWakeWord v0.5.1 melspec model). The embedding window slides by this
// many frames per chunk, so we get exactly one new embedding per chunk in
// steady state — and one wake check per 80 ms.
const FRAMES_PER_CHUNK = 5;

const PHRASE_MODELS = {
  hey_jarvis:  { file: 'hey_jarvis_v0.1.onnx',  display: 'Hey Jarvis'  },
  alexa:       { file: 'alexa_v0.1.onnx',       display: 'Alexa'       },
  hey_mycroft: { file: 'hey_mycroft_v0.1.onnx', display: 'Hey Mycroft' },
  hey_rhasspy: { file: 'hey_rhasspy_v0.1.onnx', display: 'Hey Rhasspy' },
};

class WakeWordService {
  /**
   * @param {object}   opts
   * @param {string}   opts.modelDir   – Directory for cached ONNX files
   * @param {Function} opts.onWake     – Called as onWake(prob: number) on detection
   * @param {number}   [opts.threshold=0.5]   – Wake probability threshold
   * @param {number}   [opts.cooldownMs=2000] – Min ms between wake events
   */
  constructor({ modelDir, onWake, threshold = 0.35, cooldownMs = 1500 } = {}) {
    this.modelDir   = modelDir;
    this.onWake     = onWake || (() => {});
    this.threshold  = threshold;
    this.cooldownMs = cooldownMs;

    this._melsec        = null;
    this._embedding     = null;
    this._wake          = null;
    this._phraseId      = null;
    this._loaded        = false;
    this._loading       = null; // Promise for in-flight load
    this._paused        = false;

    // Streaming buffers
    this._audioBuf = new Int16Array(0);
    this._melBuf   = [];   // each entry: Float32Array(32)
    this._embBuf   = [];   // each entry: Float32Array(96)
    this._lastWakeAt = 0;
    this._pendingRun = false; // re-entrancy guard
  }

  static get PHRASES() { return PHRASE_MODELS; }

  /**
   * Idempotently download + load all required models for the given phrase.
   * Safe to call multiple times; if already loaded with the same phrase, no-op.
   */
  async load(phraseId) {
    if (!PHRASE_MODELS[phraseId]) {
      throw new Error(`Unknown wake-word phrase: ${phraseId}`);
    }
    if (this._loaded && this._phraseId === phraseId) return;
    if (this._loading) await this._loading;
    if (this._loaded && this._phraseId === phraseId) return;

    this._loading = (async () => {
      try {
        await this._ensureModels(phraseId);
        const dir = this.modelDir;
        this._melsec    = await ort.InferenceSession.create(path.join(dir, 'melspectrogram.onnx'));
        this._embedding = await ort.InferenceSession.create(path.join(dir, 'embedding_model.onnx'));
        this._wake      = await ort.InferenceSession.create(path.join(dir, PHRASE_MODELS[phraseId].file));
        this._phraseId  = phraseId;
        this._loaded    = true;
        this.reset();
        // Pre-warm: run ~2.5 s of silence through the pipeline so the mel +
        // embedding buffers are already full when the user starts speaking.
        // Without this, the first detection has to wait ~2.5 s for buffers to
        // fill — that's what made the test button feel sluggish on first try.
        await this._prewarm();
        console.log(`[WakeWord] Loaded "${PHRASE_MODELS[phraseId].display}", buffers pre-warmed`);
      } finally {
        this._loading = null;
      }
    })();
    await this._loading;
  }

  async _prewarm() {
    // Push 2.5 s of zero audio through processing so buffers fill up. We
    // suppress the onWake callback during this — we don't want a spurious
    // detection on synthetic silence (and the threshold should prevent it
    // anyway, but defensive is cheap).
    const realOnWake = this.onWake;
    this.onWake = () => {};
    try {
      const silence = new Float32Array(SAMPLE_RATE * 2.5);
      await this.pushAudio(silence);
    } finally {
      this.onWake = realOnWake;
      this._lastWakeAt = 0; // make sure cooldown isn't holding from pre-warm
    }
  }

  unload() {
    this._melsec    = null;
    this._embedding = null;
    this._wake      = null;
    this._loaded    = false;
    this._phraseId  = null;
    this.reset();
  }

  pause()  { this._paused = true; }
  resume() { this._paused = false; this.reset(); }

  /** Clear streaming state. Call when starting a new listening session. */
  reset() {
    this._audioBuf = new Int16Array(0);
    this._melBuf   = [];
    this._embBuf   = [];
    this._lastWakeAt = 0;
  }

  /**
   * Push raw audio samples (16 kHz mono, Float32 in [-1, 1]). Will buffer and
   * process complete 80 ms chunks; partial chunks wait for the next push.
   */
  async pushAudio(float32Audio) {
    if (!this._loaded || this._paused) return;
    if (!float32Audio || float32Audio.length === 0) return;

    // Float32 → Int16
    const int16 = new Int16Array(float32Audio.length);
    for (let i = 0; i < float32Audio.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Audio[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    // Append to rolling audio buffer
    const merged = new Int16Array(this._audioBuf.length + int16.length);
    merged.set(this._audioBuf, 0);
    merged.set(int16, this._audioBuf.length);
    this._audioBuf = merged;

    // Re-entrancy guard: only one pipeline run at a time
    if (this._pendingRun) return;
    this._pendingRun = true;
    try {
      while (this._audioBuf.length >= CHUNK_SAMPLES && !this._paused) {
        const chunk = this._audioBuf.slice(0, CHUNK_SAMPLES);
        this._audioBuf = this._audioBuf.slice(CHUNK_SAMPLES);
        await this._processChunk(chunk);
      }
    } finally {
      this._pendingRun = false;
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  async _processChunk(int16Chunk) {
    // ── 1. Melspectrogram ──────────────────────────────────────────────────
    // Input: int16 cast to float32, shape [1, N]. Output: [1, 1, F, 32] where
    // F = FRAMES_PER_CHUNK (5) for the stock 80 ms input.
    const chunkF32 = new Float32Array(int16Chunk.length);
    for (let i = 0; i < int16Chunk.length; i++) chunkF32[i] = int16Chunk[i];
    let melOut;
    try {
      melOut = await this._melsec.run({
        input: new ort.Tensor('float32', chunkF32, [1, int16Chunk.length]),
      });
    } catch (err) {
      console.warn('[WakeWord] melspec inference failed:', err.message);
      return;
    }
    const melResult = melOut.output;
    const F = melResult.dims[melResult.dims.length - 2];
    const melData = melResult.data;
    // OpenWakeWord normalizes mel features as (mel / 10) + 2 before embedding.
    for (let f = 0; f < F; f++) {
      const frame = new Float32Array(MEL_DIM);
      for (let i = 0; i < MEL_DIM; i++) frame[i] = (melData[f * MEL_DIM + i] / 10) + 2;
      this._melBuf.push(frame);
    }
    // Keep just enough history for one embedding window plus a little slack.
    while (this._melBuf.length > EMB_WINDOW + FRAMES_PER_CHUNK * 2) this._melBuf.shift();

    // ── 2. Embedding ───────────────────────────────────────────────────────
    // Run exactly once per chunk on the latest 76 frames. This matches the
    // openWakeWord reference behavior: each new 80 ms of audio produces one
    // new embedding (the 76-frame window slides forward by FRAMES_PER_CHUNK).
    if (this._melBuf.length < EMB_WINDOW) return;
    const start = this._melBuf.length - EMB_WINDOW;
    const embInput = new Float32Array(EMB_WINDOW * MEL_DIM);
    for (let f = 0; f < EMB_WINDOW; f++) {
      const frame = this._melBuf[start + f];
      for (let i = 0; i < MEL_DIM; i++) embInput[f * MEL_DIM + i] = frame[i];
    }
    let embOut;
    try {
      embOut = await this._embedding.run({
        input_1: new ort.Tensor('float32', embInput, [1, EMB_WINDOW, MEL_DIM, 1]),
      });
    } catch (err) {
      console.warn('[WakeWord] embedding inference failed:', err.message);
      return;
    }
    const embData = embOut.conv2d_19.data;
    const emb = new Float32Array(EMB_DIM);
    for (let i = 0; i < EMB_DIM; i++) emb[i] = embData[i];
    this._embBuf.push(emb);
    while (this._embBuf.length > WAKE_WINDOW) this._embBuf.shift();

    // ── 3. Wake check ──────────────────────────────────────────────────────
    if (this._embBuf.length < WAKE_WINDOW) return;
    const wakeInput = new Float32Array(WAKE_WINDOW * EMB_DIM);
    for (let e = 0; e < WAKE_WINDOW; e++) {
      const emb_e = this._embBuf[e];
      for (let i = 0; i < EMB_DIM; i++) wakeInput[e * EMB_DIM + i] = emb_e[i];
    }
    let wakeOut;
    try {
      wakeOut = await this._wake.run({
        'x.1': new ort.Tensor('float32', wakeInput, [1, WAKE_WINDOW, EMB_DIM]),
      });
    } catch (err) {
      console.warn('[WakeWord] wake-word inference failed:', err.message);
      return;
    }
    const outKey = Object.keys(wakeOut)[0];
    const prob = wakeOut[outKey].data[0];

    if (process.env.WAKE_DEBUG && prob > 0.05) {
      console.log(`[WakeWord] p=${prob.toFixed(3)}`);
    }

    if (prob > this.threshold) {
      const now = Date.now();
      if (now - this._lastWakeAt > this.cooldownMs) {
        this._lastWakeAt = now;
        // Note: we deliberately do NOT clear _melBuf or _embBuf here.
        // The cooldown timer alone prevents re-fires, and keeping the buffers
        // primed means we don't pay the ~2.5 s bootstrap cost again.
        console.log(`[WakeWord] DETECTED "${PHRASE_MODELS[this._phraseId].display}" (p=${prob.toFixed(3)})`);
        try { this.onWake(prob); } catch (e) { console.error('[WakeWord] onWake threw:', e.message); }
      }
    }
  }

  // ── Model download ─────────────────────────────────────────────────────────

  async _ensureModels(phraseId) {
    fs.mkdirSync(this.modelDir, { recursive: true });
    const required = ['melspectrogram.onnx', 'embedding_model.onnx', PHRASE_MODELS[phraseId].file];
    for (const f of required) {
      const dst = path.join(this.modelDir, f);
      if (fs.existsSync(dst) && fs.statSync(dst).size > 100 * 1024) continue;
      console.log(`[WakeWord] downloading ${f}…`);
      await this._download(`${RELEASE_BASE}/${f}`, dst);
      const size = fs.statSync(dst).size;
      console.log(`[WakeWord] ${f}: ${(size / 1024).toFixed(0)} KB`);
    }
  }

  _download(url, dst) {
    return new Promise((resolve, reject) => {
      const get = (u, redirects = 0) => {
        if (redirects > 5) return reject(new Error('Too many redirects'));
        https.get(u, { headers: { 'User-Agent': 'friday-wake-word' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return get(res.headers.location, redirects + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode} fetching ${u}`));
          }
          const tmp = dst + '.part';
          const file = fs.createWriteStream(tmp);
          res.pipe(file);
          file.on('finish', () => {
            file.close((err) => {
              if (err) return reject(err);
              try { fs.renameSync(tmp, dst); resolve(); }
              catch (e) { reject(e); }
            });
          });
          file.on('error', (err) => {
            try { fs.unlinkSync(tmp); } catch {}
            reject(err);
          });
        }).on('error', reject);
      };
      get(url);
    });
  }
}

module.exports = WakeWordService;
