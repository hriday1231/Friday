/**
 * DocIndex — per-session document chunking, indexing, and retrieval.
 *
 * Retrieval strategy (best available):
 *   1. Hybrid  — cosine similarity (nomic-embed-text) + BM25 via RRF  (best)
 *   2. BM25    — pure keyword matching, instant, no Ollama needed      (fallback)
 *   3. Full    — inject entire document when it's short enough         (small docs)
 *
 * Exposed as window.DocIndex (singleton).
 */

const RAG_THRESHOLD = 3;    // min chunks before RAG activates
const CHUNK_SIZE    = 1400; // target chars per chunk (~350 tokens)
const CHUNK_OVERLAP = 200;  // overlap to preserve cross-boundary context

class DocIndex {
  constructor() {
    // docId → { chunks, bm25, embeddings, embStatus }
    // embStatus: 'none' | 'pending' | 'done' | 'failed'
    this._entries = new Map();
  }

  // ── Sync BM25 index (instant) ─────────────────────────────────────────────

  /**
   * Chunk and BM25-index a document synchronously. Idempotent.
   * Returns chunk count.
   */
  index(docId, text) {
    if (this._entries.has(docId)) return this._entries.get(docId).chunks.length;
    const chunks = this._chunk(text);
    const bm25   = new BM25Lite();
    bm25.index(chunks);
    this._entries.set(docId, { chunks, bm25, embeddings: null, embStatus: 'none' });
    return chunks.length;
  }

  // ── Async semantic index (background) ────────────────────────────────────

  /**
   * Index + embed a document asynchronously.
   * Calls onProgress(done, total, phase) where phase is:
   *   'embedding'  — in progress (done/total chunks embedded)
   *   'done'       — all embeddings ready
   *   'failed'     — Ollama unavailable or model missing (BM25 still works)
   *
   * Returns chunk count.
   */
  async asyncIndex(docId, text, onProgress) {
    const chunkCount = this.index(docId, text);
    const entry      = this._entries.get(docId);
    if (!entry) return chunkCount;

    // Skip if already embedded or in progress
    if (entry.embStatus === 'done' || entry.embStatus === 'pending') return chunkCount;

    const embedder = window.RAGEmbedder;
    if (!embedder) return chunkCount;

    entry.embStatus = 'pending';

    // Quick availability probe before committing to the full batch
    const probe = await embedder.embed('ping');
    if (!probe) {
      entry.embStatus = 'failed';
      onProgress?.(-1, entry.chunks.length, 'failed');
      return chunkCount;
    }

    try {
      entry.embeddings = await embedder.embedBatch(entry.chunks, (done, total) => {
        onProgress?.(done, total, 'embedding');
      });
      entry.embStatus = 'done';
      onProgress?.(entry.chunks.length, entry.chunks.length, 'done');
    } catch {
      entry.embStatus = 'failed';
      onProgress?.(-1, entry.chunks.length, 'failed');
    }

    return chunkCount;
  }

  // ── Retrieval ─────────────────────────────────────────────────────────────

  /**
   * Retrieve the most relevant chunks for a query.
   * Automatically uses the best available strategy.
   * @returns {Promise<string[]>}
   */
  async query(docId, queryText, topK = 6) {
    const entry = this._entries.get(docId);
    if (!entry) return [];
    if (entry.chunks.length < RAG_THRESHOLD) return entry.chunks; // small: return all

    // BM25 results (always computed — used in both hybrid and fallback)
    const bm25Results = entry.bm25.search(queryText, topK * 2);

    // Hybrid if semantic embeddings are ready
    if (entry.embStatus === 'done' && entry.embeddings && window.RAGEmbedder?.isAvailable) {
      try {
        const queryEmb = await window.RAGEmbedder.embed(queryText);
        if (queryEmb) {
          return window.RAGEmbedder.hybridSearch(
            queryEmb, entry.embeddings, bm25Results, entry.chunks, topK
          );
        }
      } catch { /* fall through */ }
    }

    // BM25 fallback
    return bm25Results
      .sort((a, b) => a.index - b.index)
      .slice(0, topK)
      .map(r => r.text);
  }

  /** Synchronous BM25-only query (no embeddings). */
  querySync(docId, queryText, topK = 6) {
    const entry = this._entries.get(docId);
    if (!entry) return [];
    if (entry.chunks.length < RAG_THRESHOLD) return entry.chunks;
    return entry.bm25.search(queryText, topK)
      .sort((a, b) => a.index - b.index)
      .map(r => r.text);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  embStatus(docId)  { return this._entries.get(docId)?.embStatus ?? 'none'; }
  has(docId)        { return this._entries.has(docId); }
  chunkCount(docId) { return this._entries.get(docId)?.chunks.length ?? 0; }
  remove(docId)     { this._entries.delete(docId); }
  clear()           { this._entries.clear(); }

  // ── Chunker ───────────────────────────────────────────────────────────────

  /**
   * Split text into overlapping chunks respecting document structure.
   * Priority for split points: paragraph break > heading > newline > sentence.
   * Detects headings and prepends them as "[Section: ...]" context to each chunk.
   */
  _chunk(text) {
    if (!text || text.length === 0) return [];
    const chunks    = [];
    let   start     = 0;
    let   lastHead  = '';

    while (start < text.length) {
      let end = Math.min(start + CHUNK_SIZE, text.length);

      if (end < text.length) {
        const minBP = start + CHUNK_SIZE * 0.4; // don't split too early

        // 1. Double newline (paragraph)
        let bp = text.lastIndexOf('\n\n', end);
        if (bp > minBP) { end = bp + 2; }
        else {
          // 2. Heading start (\n#)
          bp = text.lastIndexOf('\n#', end);
          if (bp > minBP) { end = bp + 1; }
          else {
            // 3. Single newline
            bp = text.lastIndexOf('\n', end);
            if (bp > minBP) { end = bp + 1; }
            else {
              // 4. Sentence boundary
              bp = text.lastIndexOf('. ', end);
              if (bp > minBP) { end = bp + 2; }
            }
          }
        }
      }

      const raw = text.slice(start, end).trim();
      if (raw.length > 30) {
        // Track headings so we can annotate chunks that fall under them
        const headMatch = raw.match(/^(#{1,6}\s+.+)/m);
        if (headMatch) lastHead = headMatch[1].trim().replace(/^#+\s*/, '');

        // Prepend section context when the chunk doesn't start with a heading
        const chunk = (lastHead && !raw.match(/^#{1,6}\s/))
          ? `[Section: ${lastHead}]\n${raw}`
          : raw;
        chunks.push(chunk);
      }

      start = Math.max(end - CHUNK_OVERLAP, start + 1);
    }

    return chunks;
  }
}

window.DocIndex = new DocIndex();
