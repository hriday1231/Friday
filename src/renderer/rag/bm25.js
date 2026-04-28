/**
 * BM25Lite — dependency-free BM25 retrieval for the renderer process.
 *
 * Usage:
 *   const bm = new BM25Lite();
 *   bm.index(['chunk one text', 'chunk two text', ...]);
 *   const results = bm.search('query text', 5);
 *   // results: [{ index, score, text }, ...]
 */
class BM25Lite {
  static tokenize(text) {
    return text.toLowerCase().match(/[a-z0-9]+/g) || [];
  }

  constructor(k1 = 1.5, b = 0.75) {
    this.k1   = k1;
    this.b    = b;
    this.docs = [];
    this.idf  = {};
    this.avgLen = 0;
  }

  index(documents) {
    this.docs = documents.map(text => {
      const tokens = BM25Lite.tokenize(text);
      const tf = {};
      for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
      return { text, tf, len: tokens.length };
    });

    this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / (this.docs.length || 1);

    const N  = this.docs.length;
    const df = {};
    for (const doc of this.docs) {
      const seen = new Set(Object.keys(doc.tf));
      for (const t of seen) df[t] = (df[t] || 0) + 1;
    }

    this.idf = {};
    for (const [t, n] of Object.entries(df)) {
      this.idf[t] = Math.log((N - n + 0.5) / (n + 0.5) + 1);
    }
  }

  search(query, topK = 5) {
    const qTokens = BM25Lite.tokenize(query);
    if (!qTokens.length) return [];

    const scores = this.docs.map((doc, i) => {
      let score = 0;
      for (const qt of qTokens) {
        const idf = this.idf[qt] || 0;
        if (idf === 0) continue;
        const tf  = doc.tf[qt] || 0;
        const num = tf * (this.k1 + 1);
        const den = tf + this.k1 * (1 - this.b + this.b * doc.len / this.avgLen);
        score += idf * (num / den);
      }
      return { index: i, score, text: doc.text };
    });

    return scores
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
