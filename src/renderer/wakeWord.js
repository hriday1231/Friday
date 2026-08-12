/**
 * WakeWordDetector - always-on local wake-word powered by OpenWakeWord.
 *
 * Renderer side: captures 16 kHz mono PCM via AudioWorklet and streams it to
 * the main process (electronAPI.wakeWordPushAudio). Main runs the ONNX
 * inference pipeline (see src/main/services/WakeWordService.js) and fires
 * back a 'wake-detected' event when the configured phrase is heard.
 *
 * On wake:
 *   1. Pause streaming (cooldown handled by main).
 *   2. Record a short command clip via the same audio path.
 *   3. Send the clip to whisper-cli for STT.
 *   4. Fire onWake(commandText) - empty string means "just heard the phrase".
 *
 * Public API kept compatible with the previous detector so renderer.js and
 * settings.js don't need code changes:
 *   new WakeWordDetector({ phrases, onWake, ... })
 *   .start() / .stop() / .pause() / .resume()
 *   .static _encodeWav(frames, sampleRate)  - used by settings test button
 */

const _WAKE_WORKLET_CODE = `
class PCMCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch && ch.length > 0) this.port.postMessage(new Float32Array(ch));
    return true;
  }
}
registerProcessor('wake-pcm-capture', PCMCaptureProcessor);
`;

// Command-capture parameters. We use VAD instead of a fixed window: as soon as
// the user stops talking we end the capture, ship it to Whisper, and submit.
const CMD_MAX_MS              = 6000;   // hard ceiling - safety net
const CMD_NO_SPEECH_TIMEOUT   = 1500;   // give up if nothing audible after wake
const CMD_SILENCE_END_MS      = 600;    // sustained silence after speech → end
const CMD_RMS_SPEECH_THRESH   = 0.014;  // RMS above this counts as "speech"
const CMD_VAD_POLL_MS         = 40;     // how often to check the rolling RMS

class WakeWordDetector {
  /**
   * @param {object}   opts
   * @param {string[]} [opts.phrases]   - Phrase IDs (e.g., ['hey_jarvis']). First wins.
   * @param {Function} opts.onWake      - async (commandText: string) => void
   */
  constructor({ phrases = ['hey_jarvis'], onWake } = {}) {
    // The OpenWakeWord pipeline is one-phrase-at-a-time (each phrase is its
    // own ONNX model). We honor the first entry for backward-compat.
    this.phraseId        = (phrases[0] || 'hey_jarvis').toLowerCase().replace(/\s+/g, '_');
    this.onWake          = onWake || (() => {});

    this._stream       = null;
    this._audioCtx     = null;
    this._captureNode  = null;
    this._silencer     = null;
    this._sourceNode   = null;
    this._running      = false;
    this._capturingCmd = false;
    this._cmdFrames    = [];
    this._cmdVadTimer  = null;
    this._cmdVadState  = null; // { startedAt, hasSpoken, silenceStart }

    this._unsubWake    = null;
  }

  async start() {
    if (this._running) return;
    try {
      this._stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      this._audioCtx = new AudioContext({ sampleRate: 16000 });

      // Load the inline PCM-capture worklet.
      const blob = new Blob([_WAKE_WORKLET_CODE], { type: 'application/javascript' });
      const url  = URL.createObjectURL(blob);
      try { await this._audioCtx.audioWorklet.addModule(url); }
      finally { URL.revokeObjectURL(url); }

      this._sourceNode  = this._audioCtx.createMediaStreamSource(this._stream);
      this._captureNode = new AudioWorkletNode(this._audioCtx, 'wake-pcm-capture');
      this._silencer    = this._audioCtx.createGain();
      this._silencer.gain.value = 0;
      this._sourceNode.connect(this._captureNode);
      this._captureNode.connect(this._silencer);
      this._silencer.connect(this._audioCtx.destination);

      // Frames from the worklet arrive as 128-sample Float32Array chunks
      // (~8 ms each, one per render quantum). 125 IPC sends/sec is wasteful;
      // we accumulate 10 frames at a time so we ship one ~80 ms chunk per
      // send - matching the wake-word service's processing granularity and
      // cutting IPC traffic by ~10×.
      const BATCH_FRAMES = 10;       // 10 * 128 samples = 1280 samples = 80 ms @ 16 kHz
      let batchBuf = [];
      let batchLen = 0;
      this._captureNode.port.onmessage = (ev) => {
        if (!this._running) return;
        const frame = ev.data;
        if (this._capturingCmd) {
          // Post-wake command capture: keep frames in renderer for WAV encoding.
          this._cmdFrames.push(frame);
          return;
        }
        batchBuf.push(frame);
        batchLen += frame.length;
        if (batchBuf.length >= BATCH_FRAMES) {
          const merged = new Float32Array(batchLen);
          let off = 0;
          for (const f of batchBuf) { merged.set(f, off); off += f.length; }
          batchBuf = [];
          batchLen = 0;
          try { window.electronAPI?.wakeWordPushAudio?.(merged); } catch {}
        }
      };

      // Boot the backend pipeline.
      const startRes = await window.electronAPI?.wakeWordStart?.(this.phraseId);
      if (!startRes?.success) {
        console.warn('[WakeWord] backend failed to start:', startRes?.error);
        this._cleanup();
        return;
      }

      // Listen for wake events from main.
      this._unsubWake = window.electronAPI?.onWakeDetected?.((data) => this._onWakeDetected(data));

      this._running = true;
      console.log('[WakeWord] Listening for phrase:', this.phraseId);
    } catch (err) {
      console.warn('[WakeWord] Could not start - mic unavailable:', err.message);
      this._cleanup();
    }
  }

  stop() {
    this._running = false;
    this._capturingCmd = false;
    if (this._cmdVadTimer) { clearTimeout(this._cmdVadTimer); this._cmdVadTimer = null; }
    this._cmdVadState = null;
    try { this._unsubWake?.(); } catch {}
    this._unsubWake = null;
    window.electronAPI?.wakeWordStop?.().catch(() => {});
    this._cleanup();
    console.log('[WakeWord] Stopped');
  }

  pause() {
    if (!this._running) return;
    this._running = false;
    window.electronAPI?.wakeWordStop?.().catch(() => {});
  }

  async resume() {
    if (this._running || !this._stream) return;
    const startRes = await window.electronAPI?.wakeWordStart?.(this.phraseId);
    if (startRes?.success) this._running = true;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  async _onWakeDetected(_data) {
    if (!this._running) return;
    // Switch into post-wake command-capture mode. End is decided by a tiny
    // VAD running on the rolling RMS of the captured frames - see _vadTick.
    this._capturingCmd = true;
    this._cmdFrames = [];
    this._running = false;
    this._cmdVadState = {
      startedAt:    Date.now(),
      hasSpoken:    false,
      silenceStart: null,
    };
    this._vadTick();
  }

  /**
   * Poll the recent capture buffer ~25 times/sec, deciding when to stop.
   *   1. If we never hear speech within CMD_NO_SPEECH_TIMEOUT → bail.
   *   2. Once speech is detected, end on CMD_SILENCE_END_MS of sustained quiet.
   *   3. Hard ceiling at CMD_MAX_MS (safety net for noisy environments).
   */
  _vadTick() {
    if (!this._capturingCmd || !this._cmdVadState) return;
    const state = this._cmdVadState;
    const elapsed = Date.now() - state.startedAt;

    // Compute RMS over the most recent ~80 ms of captured audio.
    let energy = 0, count = 0;
    // Frames are 128-sample chunks (~8 ms each); take last 10 ≈ 80 ms.
    const tail = this._cmdFrames.slice(-10);
    for (const f of tail) {
      for (let i = 0; i < f.length; i++) { energy += f[i] * f[i]; count++; }
    }
    const rms = count > 0 ? Math.sqrt(energy / count) : 0;
    const speakingNow = rms > CMD_RMS_SPEECH_THRESH;

    let done = false;
    let reason = '';

    if (elapsed >= CMD_MAX_MS) {
      done = true; reason = 'max-time';
    } else if (!state.hasSpoken) {
      if (speakingNow) { state.hasSpoken = true; state.silenceStart = null; }
      else if (elapsed >= CMD_NO_SPEECH_TIMEOUT) { done = true; reason = 'no-speech'; }
    } else {
      // Already heard speech - watching for end-of-utterance silence.
      if (speakingNow) {
        state.silenceStart = null;
      } else {
        if (state.silenceStart === null) state.silenceStart = Date.now();
        else if (Date.now() - state.silenceStart >= CMD_SILENCE_END_MS) {
          done = true; reason = 'silence';
        }
      }
    }

    if (done) {
      console.log(`[WakeWord] command capture ended (${reason}, ${elapsed}ms, spoke=${state.hasSpoken})`);
      this._cmdVadTimer = null;
      this._cmdVadState = null;
      this._finishCommandCapture(state.hasSpoken);
    } else {
      this._cmdVadTimer = setTimeout(() => this._vadTick(), CMD_VAD_POLL_MS);
    }
  }

  async _finishCommandCapture(hadSpeech) {
    const frames = this._cmdFrames;
    this._cmdFrames = [];
    this._capturingCmd = false;

    let commandText = '';
    // Skip STT entirely if we never heard speech - saves whisper-cli launch + ~300ms.
    if (hadSpeech) {
      try {
        const wav = WakeWordDetector._encodeWav(frames, 16000);
        const result = await window.electronAPI?.transcribeAudio?.(wav, 'audio/wav');
        if (result?.success && result.transcript) commandText = result.transcript.trim();
      } catch (err) {
        console.warn('[WakeWord] post-wake transcription failed:', err.message);
      }
    }

    try { await this.onWake(commandText); }
    catch (err) { console.warn('[WakeWord] onWake threw:', err.message); }

    // Re-arm wake detection in main.
    try {
      const startRes = await window.electronAPI?.wakeWordStart?.(this.phraseId);
      if (startRes?.success) this._running = true;
    } catch (err) {
      console.warn('[WakeWord] re-arm failed:', err.message);
    }
  }

  _cleanup() {
    try { this._captureNode?.disconnect(); } catch {}
    try { this._silencer?.disconnect(); }    catch {}
    try { this._sourceNode?.disconnect(); }  catch {}
    this._captureNode = null;
    this._silencer    = null;
    this._sourceNode  = null;
    this._stream?.getTracks().forEach(t => t.stop());
    this._audioCtx?.close().catch(() => {});
    this._stream = null;
    this._audioCtx = null;
  }

  /**
   * Encode an array of Float32 PCM chunks into a 16-bit mono WAV Uint8Array.
   * Reused by the settings test button (settings.js calls this static directly).
   */
  static _encodeWav(float32Chunks, sampleRate = 16000) {
    const totalLen = float32Chunks.reduce((s, c) => s + (c?.length || 0), 0);
    const merged   = new Float32Array(totalLen);
    let offset = 0;
    for (const chunk of float32Chunks) { if (chunk?.length) { merged.set(chunk, offset); offset += chunk.length; } }

    const int16 = new Int16Array(merged.length);
    for (let i = 0; i < merged.length; i++) {
      const s = Math.max(-1, Math.min(1, merged[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    const numChannels   = 1;
    const bitsPerSample = 16;
    const byteRate      = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign    = numChannels * (bitsPerSample / 8);
    const dataSize      = int16.length * 2;
    const buffer        = new ArrayBuffer(44 + dataSize);
    const v             = new DataView(buffer);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    str(0,  'RIFF');
    v.setUint32( 4, 36 + dataSize, true);
    str(8,  'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16,            true);
    v.setUint16(20, 1,             true);
    v.setUint16(22, numChannels,   true);
    v.setUint32(24, sampleRate,    true);
    v.setUint32(28, byteRate,      true);
    v.setUint16(32, blockAlign,    true);
    v.setUint16(34, bitsPerSample, true);
    str(36, 'data');
    v.setUint32(40, dataSize, true);
    new Int16Array(buffer, 44).set(int16);
    return new Uint8Array(buffer);
  }
}

window.WakeWordDetector = WakeWordDetector;
