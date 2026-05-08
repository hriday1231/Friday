/**
 * WakeWordDetector — always-on local wake word using existing Whisper pipeline.
 *
 * Flow:
 *  1. AnalyserNode polls RMS every 100ms.
 *  2. When RMS > threshold, ~2s of mono PCM at 16 kHz is captured via an
 *     AudioWorklet (no MediaRecorder, no webm — produces WAV directly so
 *     whisper-cli works without ffmpeg).
 *  3. WAV bytes sent to main process via transcribeAudio (whisper.cpp).
 *  4. If transcript contains any configured phrase → onWake(strippedText) fired.
 *  5. Detector pauses COOLDOWN_MS before listening again.
 */

// Inline AudioWorklet processor that posts Float32 PCM frames back to main.
// Same shape as the one in ChatInterface — kept inline here so wakeWord is
// self-contained and the detector can run before the chat UI loads.
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

class WakeWordDetector {
  /**
   * @param {object}   opts
   * @param {string[]} opts.phrases   – Lower-case phrases to match (e.g. ['hey friday'])
   * @param {Function} opts.onWake    – async (commandText: string) => void
   * @param {number}   [opts.energyThreshold=0.012]
   * @param {number}   [opts.cooldownMs=3000]
   * @param {number}   [opts.captureMs=2000]
   */
  constructor({ phrases = ['hey friday'], onWake, energyThreshold = 0.012, cooldownMs = 3000, captureMs = 2000 } = {}) {
    this.phrases         = phrases.map(p => p.toLowerCase().trim());
    this.onWake          = onWake;
    this.energyThreshold = energyThreshold;
    this.cooldownMs      = cooldownMs;
    this.captureMs       = captureMs;

    this._stream         = null;
    this._audioCtx       = null;
    this._analyser       = null;
    this._workletReady   = false;
    this._running        = false;
    this._capturing      = false;
    this._pollTimer      = null;
    this._cooldownTimer  = null;
    this._chunkTimeout   = null;
    this._captureWorklet = null;
  }

  /** Start listening. Requests mic permission if not already granted. */
  async start() {
    if (this._running) return;
    try {
      this._stream   = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      // 16 kHz matches whisper.cpp's native sample rate — no resampling.
      this._audioCtx = new AudioContext({ sampleRate: 16000 });

      // Load the inline PCM-capture worklet once.
      const blob = new Blob([_WAKE_WORKLET_CODE], { type: 'application/javascript' });
      const url  = URL.createObjectURL(blob);
      try {
        await this._audioCtx.audioWorklet.addModule(url);
        this._workletReady = true;
      } finally {
        URL.revokeObjectURL(url);
      }

      const src      = this._audioCtx.createMediaStreamSource(this._stream);
      this._analyser = this._audioCtx.createAnalyser();
      this._analyser.fftSize = 512;
      src.connect(this._analyser);
      this._running  = true;
      this._schedulePoll();
      console.log('[WakeWord] Listening for:', this.phrases);
    } catch (err) {
      console.warn('[WakeWord] Could not start — mic unavailable:', err.message);
    }
  }

  stop() {
    this._running = false;
    if (this._pollTimer)     { clearTimeout(this._pollTimer);     this._pollTimer     = null; }
    if (this._cooldownTimer) { clearTimeout(this._cooldownTimer); this._cooldownTimer = null; }
    if (this._chunkTimeout)  { clearTimeout(this._chunkTimeout);  this._chunkTimeout  = null; }
    try { this._captureWorklet?.disconnect(); } catch {}
    this._captureWorklet = null;
    // Release the mic immediately — the user's mic indicator should go dark
    // the moment the wake word is disabled.
    this._stream?.getTracks().forEach(t => t.stop());
    this._audioCtx?.close().catch(() => {});
    this._stream     = null;
    this._audioCtx   = null;
    this._analyser   = null;
    this._workletReady = false;
    console.log('[WakeWord] Stopped');
  }

  /** Temporarily pause RMS polling (e.g. while Whisper recorder is active or
   *  TTS is speaking back through the mic). Caller must resume(). */
  pause() {
    if (!this._running) return;
    this._running = false;
    if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; }
  }
  resume() {
    if (this._running || !this._stream) return;
    this._running = true;
    this._schedulePoll();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _getRms() {
    if (!this._analyser) return 0;
    const buf = new Float32Array(this._analyser.fftSize);
    this._analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    return Math.sqrt(sum / buf.length);
  }

  _schedulePoll() {
    if (!this._running) return;
    this._pollTimer = setTimeout(() => this._poll(), 100);
  }

  _poll() {
    if (!this._running) return;
    if (!this._capturing && this._getRms() > this.energyThreshold) {
      this._captureChunk();
    } else {
      this._schedulePoll();
    }
  }

  _captureChunk() {
    if (!this._stream || !this._running || !this._workletReady) {
      this._capturing = false;
      this._schedulePoll();
      return;
    }
    this._capturing = true;

    // Build a fresh worklet node + silent gain branch each capture so we can
    // disconnect cleanly when the chunk window closes.
    let worklet, source, silencer;
    try {
      worklet  = new AudioWorkletNode(this._audioCtx, 'wake-pcm-capture');
      source   = this._audioCtx.createMediaStreamSource(this._stream);
      silencer = this._audioCtx.createGain();
      silencer.gain.value = 0;
      source.connect(worklet);
      worklet.connect(silencer);
      silencer.connect(this._audioCtx.destination);
    } catch (err) {
      console.warn('[WakeWord] Worklet wiring failed:', err.message);
      this._capturing = false;
      this._schedulePoll();
      return;
    }

    const frames = [];
    worklet.port.onmessage = (e) => { frames.push(e.data); };
    this._captureWorklet = worklet;

    this._chunkTimeout = setTimeout(async () => {
      this._chunkTimeout = null;
      try { worklet.disconnect(); source.disconnect(); silencer.disconnect(); } catch {}
      this._captureWorklet = null;
      try {
        const wav = WakeWordDetector._encodeWav(frames, 16000);
        await this._processWav(wav);
      } catch (err) {
        console.warn('[WakeWord] Encode/process failed:', err.message);
      }
      this._capturing = false;
      if (this._running) this._schedulePoll();
    }, this.captureMs);
  }

  async _processWav(wavBytes) {
    if (!window.electronAPI?.transcribeAudio) return;
    try {
      const result = await window.electronAPI.transcribeAudio(wavBytes, 'audio/wav');
      if (!result?.success || !result.transcript) return;

      const lower = result.transcript.toLowerCase().trim();
      const matched = this.phrases.find(p => lower.includes(p));
      if (!matched) return;

      // Strip the wake phrase from the transcript, keep any command after it
      const afterWake = lower.replace(matched, '').trim();

      console.log('[WakeWord] Activated! Command:', afterWake || '(none)');
      this._running = false; // pause during cooldown

      try {
        await this.onWake(afterWake);
      } catch (err) {
        console.warn('[WakeWord] onWake error:', err.message);
      }

      // Re-arm after the cooldown — but only if stop() hasn't fired in the
      // meantime. We track the timer so stop() can cancel it.
      this._cooldownTimer = setTimeout(() => {
        this._cooldownTimer = null;
        if (this._stream?.active) {
          this._running = true;
          this._schedulePoll();
        }
      }, this.cooldownMs);
    } catch {
      // Whisper not configured or failed — silently skip
    }
  }

  /**
   * Encode an array of Float32 PCM chunks into a 16-bit mono WAV Uint8Array.
   * Exposed as a static so the settings page can reuse the same encoder.
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
