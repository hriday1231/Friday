/**
 * MemoryEmbedder — calls Ollama's embedding API from the main (Node.js) process.
 *
 * Used for:
 *   - Embedding memory facts when they are saved
 *   - Embedding user queries to retrieve relevant memories at inference time
 *
 * Falls back gracefully when Ollama / nomic-embed-text is unavailable.
 */
class MemoryEmbedder {
  constructor() {
    this._model     = 'nomic-embed-text';
    this._available = null; // null=unknown, true=yes, false=no
    this._cache     = new Map(); // short-lived cache: text → Promise<embedding>
  }

  get _baseUrl() {
    if (process.env.OLLAMA_BASE_URL) return process.env.OLLAMA_BASE_URL;
    try { return require('../settings/SettingsStore').getOllamaBaseUrl() || 'http://localhost:11434'; } catch { return 'http://localhost:11434'; }
  }

  // ── Cosine similarity ──────────────────────────────────────────────────────

  cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na  += a[i] * a[i];
      nb  += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom > 0 ? dot / denom : 0;
  }

  // ── Single embed ──────────────────────────────────────────────────────────

  async embed(text) {
    if (this._available === false) return null;

    // De-duplicate concurrent calls for the same text (e.g. memory + episodes + few-shots)
    if (this._cache.has(text)) return this._cache.get(text);

    const promise = this._embedRaw(text);
    this._cache.set(text, promise);
    // Evict after resolution so the cache doesn't grow unbounded
    promise.finally(() => setTimeout(() => this._cache.delete(text), 5000));
    return promise;
  }

  async _embedRaw(text) {
    try {
      const resp = await fetch(`${this._baseUrl}/api/embeddings`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ model: this._model, prompt: text }),
        signal:  AbortSignal.timeout(3000)
      });
      if (!resp.ok) { this._available = false; return null; }
      const data = await resp.json();
      if (!Array.isArray(data.embedding)) { this._available = false; return null; }
      this._available = true;
      return data.embedding;
    } catch {
      this._available = false;
      return null;
    }
  }

  get isAvailable() { return this._available === true; }
}

module.exports = new MemoryEmbedder();
