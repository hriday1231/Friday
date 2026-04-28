/**
 * WakeWordDetector — always-on local wake word using existing Whisper pipeline.
 *
 * Flow:
 *  1. AnalyserNode polls RMS every 100ms.
 *  2. When RMS > threshold, a 2.5s chunk is recorded via MediaRecorder.
 *  3. Chunk sent to main process via transcribeAudio (whisper.cpp).
 *  4. If transcript contains any configured phrase → onWake(strippedText) fired.
 *  5. Detector pauses COOLDOWN_MS before listening again.
 */
class WakeWordDetector {
  /**
   * @param {object}   opts
   * @param {string[]} opts.phrases   – Lower-case phrases to match (e.g. ['hey friday'])
   * @param {Function} opts.onWake    – async (commandText: string) => void
   * @param {number}   [opts.energyThreshold=0.012]
   * @param {number}   [opts.cooldownMs=3000]
   */
  constructor({ phrases = ['hey friday'], onWake, energyThreshold = 0.012, cooldownMs = 3000 } = {}) {
    this.phrases         = phrases.map(p => p.toLowerCase().trim());
    this.onWake          = onWake;
    this.energyThreshold = energyThreshold;
    this.cooldownMs      = cooldownMs;

    this._stream         = null;
    this._audioCtx       = null;
    this._analyser       = null;
    this._running        = false;
    this._capturing      = false;
    this._pollTimer      = null;
  }

  /** Start listening. Requests mic permission if not already granted. */
  async start() {
    if (this._running) return;
    try {
      this._stream   = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      this._audioCtx = new AudioContext();
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
    if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; }
    this._stream?.getTracks().forEach(t => t.stop());
    this._audioCtx?.close().catch(() => {});
    this._stream   = null;
    this._audioCtx = null;
    this._analyser = null;
    console.log('[WakeWord] Stopped');
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
    if (!this._stream || !this._running) return;
    this._capturing = true;

    const chunks = [];
    let mr;
    try {
      mr = new MediaRecorder(this._stream);
    } catch (e) {
      this._capturing = false;
      this._schedulePoll();
      return;
    }

    mr.ondataavailable = e => { if (e.data?.size > 0) chunks.push(e.data); };
    mr.onstop = async () => {
      const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
      await this._processChunk(blob);
      this._capturing = false;
      if (this._running) this._schedulePoll();
    };

    mr.start();
    // Record for 2.5 s
    setTimeout(() => {
      if (mr.state === 'recording') mr.stop();
    }, 2500);
  }

  async _processChunk(blob) {
    if (!window.electronAPI?.transcribeAudio) return;
    try {
      const buf    = await blob.arrayBuffer();
      const result = await window.electronAPI.transcribeAudio(new Uint8Array(buf), blob.type);
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

      setTimeout(() => {
        if (this._stream?.active) {
          this._running = true;
          this._schedulePoll();
        }
      }, this.cooldownMs);
    } catch (err) {
      // Whisper not configured or failed — silently skip
    }
  }
}

window.WakeWordDetector = WakeWordDetector;
