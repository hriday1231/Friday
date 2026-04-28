/**
 * RAGEmbedder — calls Ollama's embedding API for dense vector retrieval.
 * Gracefully falls back if Ollama or nomic-embed-text is unavailable.
 *
 * Exposed as window.RAGEmbedder (singleton).
 */
class RAGEmbedder {
  constructor() {
    this._baseUrl   = (typeof process !== 'undefined' && process.env?.OLLAMA_BASE_URL)
                      || 'http://localhost:11434';
    this._model     = 'nomic-embed-text';
    this._available = null; // null=unknown, true=yes, false=no
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

  /** Embed one string. Returns float[] or null on any failure. */
  async embed(text) {
    if (this._available === false) return null;
    try {
      const resp = await fetch(`${this._baseUrl}/api/embeddings`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ model: this._model, prompt: text }),
        signal:  AbortSignal.timeout(20000)
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

  // ── Batch embed ───────────────────────────────────────────────────────────

  /**
   * Embed an array of texts.
   * Calls onProgress(done, total) after each chunk.
   * Returns float[][] (null entries for failures).
   */
  async embedBatch(texts, onProgress) {
    const results = [];
    for (let i = 0; i < texts.length; i++) {
      results.push(await this.embed(texts[i]));
      onProgress?.(i + 1, texts.length);
      // Yield to keep the UI responsive every 10 chunks
      if (i % 10 === 9) await new Promise(r => setTimeout(r, 0));
    }
    return results;
  }

  // ── Hybrid search (BM25 + cosine via RRF) ────────────────────────────────

  /**
   * Reciprocal Rank Fusion combining semantic and BM25 rankings.
   *
   * @param {number[]}    queryEmb   - embedded query vector
   * @param {number[][]|null[]} chunkEmbs - embedded chunks (null = skip)
   * @param {Array}       bm25Results  - [{index, score, text}] from BM25Lite
   * @param {string[]}    allChunks  - full chunk array (for index lookup)
   * @param {number}      topK
   * @returns {string[]} top-K chunks in original document order
   */
  hybridSearch(queryEmb, chunkEmbs, bm25Results, allChunks, topK = 6) {
    const RRF_K  = 60;
    const scores = new Map(); // chunkIndex → combined RRF score

    // Semantic ranking
    if (queryEmb && chunkEmbs?.some(e => e !== null)) {
      const semRanked = chunkEmbs
        .map((emb, i) => ({ i, s: emb ? this.cosine(queryEmb, emb) : -1 }))
        .filter(x => x.s >= 0)
        .sort((a, b) => b.s - a.s);

      semRanked.forEach(({ i }, rank) => {
        scores.set(i, (scores.get(i) || 0) + 1 / (RRF_K + rank + 1));
      });
    }

    // BM25 ranking
    bm25Results.forEach(({ index }, rank) => {
      scores.set(index, (scores.get(index) || 0) + 1 / (RRF_K + rank + 1));
    });

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .sort((a, b) => a[0] - b[0])        // restore doc order for readability
      .map(([i]) => allChunks[i]);
  }

  get isAvailable() { return this._available === true; }
}

window.RAGEmbedder = new RAGEmbedder();
