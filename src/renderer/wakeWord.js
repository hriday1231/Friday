/**
 * WakeWordDetector — always-on local wake-word powered by OpenWakeWord.
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
 *   4. Fire onWake(commandText) — empty string means "just heard the phrase".
 *
 * Public API kept compatible with the previous detector so renderer.js and
 * settings.js don't need code changes:
 *   new WakeWordDetector({ phrases, onWake, ... })
 *   .start() / .stop() / .pause() / .resume()
 *   .static _encodeWav(frames, sampleRate)  — used by settings test button
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

const COMMAND_CAPTURE_MS = 4000; // how much audio to grab after wake fires

class WakeWordDetector {
  /**
   * @param {object}   opts
   * @param {string[]} [opts.phrases]   - Phrase IDs (e.g., ['hey_jarvis']). First wins.
   * @param {Function} opts.onWake      - async (commandText: string) => void
   * @param {number}   [opts.commandCaptureMs=4000]
   */
  constructor({ phrases = ['hey_jarvis'], onWake, commandCaptureMs = COMMAND_CAPTURE_MS } = {}) {
    // The OpenWakeWord pipeline is one-phrase-at-a-time (each phrase is its
    // own ONNX model). We honor the first entry for backward-compat.
    this.phraseId        = (phrases[0] || 'hey_jarvis').toLowerCase().replace(/\s+/g, '_');
    this.onWake          = onWake || (() => {});
    this.commandCaptureMs = commandCaptureMs;

    this._stream       = null;
    this._audioCtx     = null;
    this._captureNode  = null;
    this._silencer     = null;
    this._sourceNode   = null;
    this._running      = false;
    this._capturingCmd = false;
    this._cmdFrames    = [];
    this._cmdEndTimer  = null;

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

      this._captureNode.port.onmessage = (e) => {
        if (!this._running) return;
        const frame = e.data;
        // While recording a post-wake command clip, accumulate frames locally
        // and don't ship them to wake-word inference (we're past the wake).
        if (this._capturingCmd) {
          this._cmdFrames.push(frame);
        } else {
          // Stream to main process for ONNX inference.
          try { window.electronAPI?.wakeWordPushAudio?.(frame); } catch {}
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
      console.warn('[WakeWord] Could not start — mic unavailable:', err.message);
      this._cleanup();
    }
  }

  stop() {
    this._running = false;
    this._capturingCmd = false;
    if (this._cmdEndTimer) { clearTimeout(this._cmdEndTimer); this._cmdEndTimer = null; }
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
    // Switch into post-wake command-capture mode for COMMAND_CAPTURE_MS.
    this._capturingCmd = true;
    this._cmdFrames = [];
    this._running = false; // freeze wake-word stream while we capture command

    this._cmdEndTimer = setTimeout(async () => {
      this._cmdEndTimer = null;
      const frames = this._cmdFrames;
      this._cmdFrames = [];
      this._capturingCmd = false;

      let commandText = '';
      try {
        const wav = WakeWordDetector._encodeWav(frames, 16000);
        const result = await window.electronAPI?.transcribeAudio?.(wav, 'audio/wav');
        if (result?.success && result.transcript) {
          commandText = result.transcript.trim();
        }
      } catch (err) {
        console.warn('[WakeWord] post-wake transcription failed:', err.message);
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
    }, this.commandCaptureMs);
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
