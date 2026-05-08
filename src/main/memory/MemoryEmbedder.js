/**
 * MemoryEmbedder — calls Ollama's embedding API from the main (Node.js) process.
 *
 * Used for:
 *   - Embedding memory facts when they are saved
 *   - Embedding user queries to retrieve relevant memories at inference time
 *
 * Falls back gracefully when Ollama / nomic-embed-text is unavailable.
 *
 * Availability is cached with a TTL (60s) so a brief Ollama restart doesn't
 * permanently disable retrieval for the rest of the Electron session.
 */

const UNAVAILABLE_TTL_MS = 60_000; // re-probe Ollama after this long
const EMBED_TIMEOUT_MS   = 10_000; // Ollama cold-start of an embedding model
                                   // can take several seconds on first call.

class MemoryEmbedder {
  constructor() {
    this._model           = 'nomic-embed-text';
    this._unavailableUntil = 0;       // timestamp; 0 = currently considered available
    this._cache           = new Map(); // short-lived cache: text → Promise<embedding>
  }

  /** The current embedding model name (used by PersistentStore for invalidation). */
  get modelName() { return this._model; }

  get _baseUrl() {
    if (process.env.OLLAMA_BASE_URL) return process.env.OLLAMA_BASE_URL;
    try { return require('../settings/SettingsStore').getOllamaBaseUrl() || 'http://localhost:11434'; } catch { return 'http://localhost:11434'; }
  }

  // ── Cosine similarity ──────────────────────────────────────────────────────

  /**
   * Cosine similarity between two equal-dimensional vectors.
   * Returns 0 (not NaN) for mismatched-dim or empty inputs — so callers get a
   * deterministic "no match" signal instead of a silent NaN-cascade.
   */
  cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return 0;
    if (a.length === 0 || a.length !== b.length) return 0;
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
    // Time-bounded unavailability: don't permanently disable retrieval if
    // Ollama bounced briefly. After UNAVAILABLE_TTL_MS we'll probe again.
    if (this._unavailableUntil && Date.now() < this._unavailableUntil) return null;

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
        signal:  AbortSignal.timeout(EMBED_TIMEOUT_MS)
      });
      if (!resp.ok) { this._unavailableUntil = Date.now() + UNAVAILABLE_TTL_MS; return null; }
      const data = await resp.json();
      if (!Array.isArray(data.embedding)) { this._unavailableUntil = Date.now() + UNAVAILABLE_TTL_MS; return null; }
      this._unavailableUntil = 0;
      return data.embedding;
    } catch {
      this._unavailableUntil = Date.now() + UNAVAILABLE_TTL_MS;
      return null;
    }
  }

  get isAvailable() { return !this._unavailableUntil || Date.now() >= this._unavailableUntil; }
}

module.exports = new MemoryEmbedder();
