/**
 * PersistentStore — SQLite-backed storage for sessions, messages, and memory.
 *
 * Uses sql.js (pure-JS SQLite, zero native compilation) so it works on any
 * machine without build tools.
 *
 * Storage layout:
 *   <userData>/friday/friday.db   — SQLite database
 *   <userData>/friday/meta.json   — legacy JSON (migrated on first run, then renamed)
 *
 * All queries are synchronous (sql.js keeps the DB in memory).
 * Disk writes are debounced (flush ≤500ms after last write) with immediate
 * flush for destructive operations.
 *
 * Public API is identical to the old JSON-backed store — no other files change.
 */

const fs   = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const memoryEmbedder = require('../memory/MemoryEmbedder');

const FLUSH_DELAY_MS = 500; // debounce disk writes

class PersistentStore {
  constructor(userDataPath) {
    this._dir     = path.join(userDataPath, 'friday');
    this._dbPath  = path.join(this._dir, 'friday.db');
    this._metaPath = path.join(this._dir, 'meta.json');
    this._msgDir  = path.join(this._dir, 'messages');
    this._db      = null;     // sql.js Database instance — set by init()
    this._flushTimer = null;  // debounce handle
    fs.mkdirSync(this._dir, { recursive: true });
  }

  // ─── Initialisation (must be awaited once before use) ──────────────────────

  async init() {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();

    // Load existing DB file, or create fresh
    if (fs.existsSync(this._dbPath)) {
      const buf = fs.readFileSync(this._dbPath);
      this._db = new SQL.Database(buf);
    } else {
      this._db = new SQL.Database();
    }

    this._db.run('PRAGMA journal_mode = WAL;');
    this._db.run('PRAGMA foreign_keys = ON;');
    this._runMigrations();

    // One-time import from legacy JSON store
    if (fs.existsSync(this._metaPath)) {
      this._importFromJson();
    }
  }

  // ─── Schema migrations ─────────────────────────────────────────────────────

  _runMigrations() {
    this._db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id                  TEXT PRIMARY KEY,
        title               TEXT,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        pinned              INTEGER DEFAULT 0,
        summary             TEXT,
        summary_up_to_index INTEGER DEFAULT 0,
        tags                TEXT,
        episode_digest      TEXT,
        episode_embedding   TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role       TEXT NOT NULL,
        content    TEXT,
        parts      TEXT,
        usage      TEXT,
        display    TEXT,
        type       TEXT DEFAULT 'chat',
        images     TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS memory (
        id              TEXT PRIMARY KEY,
        content         TEXT NOT NULL,
        source          TEXT DEFAULT 'manual',
        category        TEXT DEFAULT 'fact',
        mode            TEXT DEFAULT 'any',
        embedding       TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        last_reinforced INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS documents (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        name       TEXT NOT NULL,
        type       TEXT DEFAULT 'text',
        text       TEXT NOT NULL,
        pages      INTEGER,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS feedback (
        id                 TEXT PRIMARY KEY,
        session_id         TEXT,
        user_message       TEXT NOT NULL,
        assistant_response TEXT NOT NULL,
        rating             INTEGER NOT NULL,
        correction         TEXT,
        model              TEXT,
        agent_id           TEXT DEFAULT 'friday',
        app_mode           TEXT DEFAULT 'chat',
        embedding          TEXT,
        created_at         INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_feedback_rating ON feedback(rating, created_at);
      CREATE INDEX IF NOT EXISTS idx_documents_session ON documents(session_id);

      CREATE INDEX IF NOT EXISTS idx_messages_session
        ON messages(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_updated
        ON sessions(updated_at);
    `);
    // Migrations for existing DBs
    try { this._db.run(`ALTER TABLE memory    ADD COLUMN category  TEXT DEFAULT 'fact'`); } catch {}
    try { this._db.run(`ALTER TABLE memory    ADD COLUMN mode      TEXT DEFAULT 'any'`);  } catch {}
    try { this._db.run(`ALTER TABLE sessions  ADD COLUMN mode      TEXT DEFAULT 'chat'`); } catch {}
    try { this._db.run(`ALTER TABLE sessions  ADD COLUMN workspace TEXT`);               } catch {}
    try { this._db.run(`ALTER TABLE messages  ADD COLUMN parts     TEXT`);               } catch {}
    try { this._db.run(`ALTER TABLE messages  ADD COLUMN usage     TEXT`);               } catch {}
    try { this._db.run(`ALTER TABLE messages  ADD COLUMN display   TEXT`);               } catch {}
    this._scheduleSave();
  }

  // ─── Legacy JSON import ────────────────────────────────────────────────────

  _importFromJson() {
    console.log('[PersistentStore] Migrating legacy JSON data to SQLite…');
    try {
      const meta = JSON.parse(fs.readFileSync(this._metaPath, 'utf8'));

      // Insert sessions
      const insertSession = this._db.prepare(`
        INSERT OR IGNORE INTO sessions
          (id, title, created_at, updated_at, pinned, summary, summary_up_to_index,
           tags, episode_digest, episode_embedding)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `);
      for (const s of (meta.sessions || [])) {
        insertSession.run([
          s.id, s.title || null,
          s.created_at || Date.now(), s.updated_at || Date.now(),
          s.pinned ? 1 : 0,
          s.summary || null,
          s.summaryUpToIndex || 0,
          s.tags ? JSON.stringify(s.tags) : null,
          s.episodeDigest || null,
          s.episodeEmbedding ? JSON.stringify(s.episodeEmbedding) : null,
        ]);
      }
      insertSession.free();

      // Insert messages from individual session files
      const insertMsg = this._db.prepare(`
        INSERT OR IGNORE INTO messages (id, session_id, role, content, type, images, created_at)
        VALUES (?,?,?,?,?,?,?)
      `);
      const msgDir = this._msgDir;
      if (fs.existsSync(msgDir)) {
        for (const file of fs.readdirSync(msgDir)) {
          if (!file.endsWith('.json')) continue;
          const sessionId = file.slice(0, -5);
          try {
            const msgs = JSON.parse(fs.readFileSync(path.join(msgDir, file), 'utf8'));
            for (const m of msgs) {
              insertMsg.run([
                m.id || randomUUID(), sessionId,
                m.role, m.content || '',
                m.type || 'chat',
                m.images ? JSON.stringify(m.images) : null,
                m.created_at || Date.now(),
              ]);
            }
          } catch { /* skip corrupt file */ }
        }
      }
      insertMsg.free();

      // Insert memory
      const insertMem = this._db.prepare(`
        INSERT OR IGNORE INTO memory
          (id, content, source, embedding, created_at, updated_at, last_reinforced)
        VALUES (?,?,?,?,?,?,?)
      `);
      for (const m of (meta.memory || [])) {
        insertMem.run([
          m.id, m.content, m.source || 'manual',
          m.embedding ? JSON.stringify(m.embedding) : null,
          m.created_at || Date.now(),
          m.updated_at || Date.now(),
          m.last_reinforced || m.created_at || Date.now(),
        ]);
      }
      insertMem.free();

      this._flushNow();

      // Rename legacy files so we don't re-import
      fs.renameSync(this._metaPath, this._metaPath + '.migrated');
      console.log('[PersistentStore] Migration complete. Legacy files renamed to *.migrated');
    } catch (err) {
      console.error('[PersistentStore] Migration error:', err.message);
    }
  }

  // ─── Disk persistence ──────────────────────────────────────────────────────

  _scheduleSave() {
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = setTimeout(() => this._flushNow(), FLUSH_DELAY_MS);
  }

  _flushNow() {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    if (!this._db) return;
    const data = this._db.export();
    fs.writeFileSync(this._dbPath, Buffer.from(data));
  }

  // ─── Query helpers ─────────────────────────────────────────────────────────

  _all(sql, params = []) {
    const stmt = this._db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  _get(sql, params = []) {
    return this._all(sql, params)[0] ?? null;
  }

  _run(sql, params = []) {
    const stmt = this._db.prepare(sql);
    stmt.run(params);
    stmt.free();
    this._scheduleSave();
  }

  // ─── Sessions ──────────────────────────────────────────────────────────────

  createSession(title = null, mode = 'chat') {
    const session = {
      id:         randomUUID(),
      title,
      mode,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    this._run(
      `INSERT INTO sessions (id, title, mode, created_at, updated_at) VALUES (?,?,?,?,?)`,
      [session.id, session.title, session.mode, session.created_at, session.updated_at]
    );
    return { ...session };
  }

  getSession(id) {
    const row = this._get(`SELECT * FROM sessions WHERE id = ?`, [id]);
    return row ? this._deserializeSession(row) : null;
  }

  touchSession(id, title) {
    if (title !== undefined) {
      this._run(
        `UPDATE sessions SET updated_at = ?, title = ? WHERE id = ?`,
        [Date.now(), title, id]
      );
    } else {
      this._run(`UPDATE sessions SET updated_at = ? WHERE id = ?`, [Date.now(), id]);
    }
  }

  deleteSession(id) {
    this._run(`DELETE FROM messages WHERE session_id = ?`, [id]);
    this._run(`DELETE FROM sessions WHERE id = ?`, [id]);
    this._flushNow();
  }

  renameSession(id, newTitle) {
    this._run(
      `UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`,
      [newTitle, Date.now(), id]
    );
  }

  pinSession(id, pinned) {
    this._run(`UPDATE sessions SET pinned = ? WHERE id = ?`, [pinned ? 1 : 0, id]);
  }

  /**
   * Returns sessions: pinned first, then newest-first.
   */
  listSessions(mode = null) {
    const rows = mode
      ? this._all(`SELECT * FROM sessions WHERE mode = ? ORDER BY pinned DESC, updated_at DESC`, [mode])
      : this._all(`SELECT * FROM sessions ORDER BY pinned DESC, updated_at DESC`);
    return rows.map(r => this._deserializeSession(r));
  }

  setSessionWorkspace(sessionId, workspace) {
    this._run(
      `UPDATE sessions SET workspace = ? WHERE id = ?`,
      [workspace || null, sessionId]
    );
  }

  _deserializeSession(row) {
    return {
      id:                row.id,
      title:             row.title,
      mode:              row.mode      || 'chat',
      workspace:         row.workspace || null,
      created_at:        row.created_at,
      updated_at:        row.updated_at,
      pinned:            !!row.pinned,
      summary:           row.summary,
      summaryUpToIndex:  row.summary_up_to_index,
      tags:              row.tags ? JSON.parse(row.tags) : undefined,
      episodeDigest:     row.episode_digest,
      episodeEmbedding:  row.episode_embedding ? JSON.parse(row.episode_embedding) : undefined,
    };
  }

  // ─── Messages ─────────────────────────────────────────────────────────────

  /**
   * @param {string}   sessionId
   * @param {string}   role        — 'user' | 'assistant' | 'tool'
   * @param {string}   content     — plain text (for search / legacy compat)
   * @param {string}   [type]      — 'chat' | 'code'
   * @param {Array}    [images]
   * @param {object}   [opts]
   * @param {Array}    [opts.parts]   — Part[] array (assistant messages)
   * @param {object}   [opts.usage]   — token usage object
   * @param {string}   [opts.display] — what the user actually typed (may differ from content)
   */
  addMessage(sessionId, role, content, type = 'chat', images = [], { parts = null, usage = null, display = null } = {}) {
    const id  = randomUUID();
    const now = Date.now();
    const img = images && images.length > 0
      ? JSON.stringify(images.map(i => ({ data: i.data, mimeType: i.mimeType, name: i.name || '' })))
      : null;
    this._run(
      `INSERT INTO messages (id, session_id, role, content, parts, usage, display, type, images, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        id, sessionId, role, content,
        parts   ? JSON.stringify(parts)  : null,
        usage   ? JSON.stringify(usage)  : null,
        display ?? null,
        type, img, now,
      ]
    );
    this.touchSession(sessionId);
    return id;
  }

  getMessages(sessionId) {
    const rows = this._all(
      `SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC`,
      [sessionId]
    );
    return rows.map(r => ({
      id:         r.id,
      session_id: r.session_id,
      role:       r.role,
      content:    r.content,
      parts:      r.parts   ? JSON.parse(r.parts)  : null,
      usage:      r.usage   ? JSON.parse(r.usage)  : null,
      display:    r.display || null,
      type:       r.type,
      images:     r.images  ? JSON.parse(r.images) : undefined,
      created_at: r.created_at,
    }));
  }

  truncateMessages(sessionId, fromIndex) {
    const all = this.getMessages(sessionId);
    if (fromIndex < 0 || fromIndex >= all.length) return false;
    const toDelete = all.slice(fromIndex).map(m => m.id);
    for (const id of toDelete) {
      this._run(`DELETE FROM messages WHERE id = ?`, [id]);
    }
    this._flushNow();
    return true;
  }

  /**
   * Full-text search across session titles and message content.
   * Returns up to `limit` results sorted by recency.
   */
  searchMessages(query, limit = 25) {
    if (!query || !query.trim()) return [];
    const q    = query.trim().toLowerCase();
    const like = `%${q}%`;

    // Sessions whose title matches
    const titleSessions = this._all(
      `SELECT * FROM sessions WHERE lower(title) LIKE ? ORDER BY updated_at DESC LIMIT ?`,
      [like, limit]
    ).map(r => this._deserializeSession(r));

    // Sessions with matching message content
    const msgRows = this._all(
      `SELECT DISTINCT m.session_id, s.*
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
       WHERE lower(m.content) LIKE ?
       ORDER BY s.updated_at DESC
       LIMIT ?`,
      [like, limit]
    );

    const seen    = new Set(titleSessions.map(s => s.id));
    const results = [];

    for (const session of titleSessions) {
      const titleMatch  = true;
      const msgMatches  = this._getMessageMatches(session.id, q);
      results.push({ session, titleMatch, messageMatches: msgMatches });
    }

    for (const row of msgRows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const session    = this._deserializeSession(row);
      const msgMatches = this._getMessageMatches(session.id, q);
      results.push({ session, titleMatch: false, messageMatches: msgMatches });
      if (results.length >= limit) break;
    }

    return results;
  }

  _getMessageMatches(sessionId, q) {
    const rows = this._all(
      `SELECT role, content FROM messages
       WHERE session_id = ? AND lower(content) LIKE ?
       LIMIT 2`,
      [sessionId, `%${q}%`]
    );
    return rows.map(r => {
      const lower = r.content.toLowerCase();
      const idx   = lower.indexOf(q);
      const start = Math.max(0, idx - 55);
      const end   = Math.min(r.content.length, idx + q.length + 80);
      let excerpt = r.content.slice(start, end).replace(/\n+/g, ' ');
      if (start > 0) excerpt = '…' + excerpt;
      if (end < r.content.length) excerpt += '…';
      return { role: r.role, excerpt };
    });
  }

  getRecentPairs(sessionId, limit = 10) {
    const rows  = this.getMessages(sessionId);
    const pairs = [];
    for (let i = 0; i < rows.length - 1; i++) {
      if (rows[i].role === 'user' && rows[i + 1].role === 'assistant') {
        // Use display (original user text) when available; fall back to content
        const userText      = rows[i].display || rows[i].content;
        const assistantText = rows[i + 1].content;
        pairs.push({ user: userText, assistant: assistantText });
        i++;
      }
    }
    return pairs.slice(-limit);
  }

  // ─── Context summarization ─────────────────────────────────────────────────

  getAllPairs(sessionId) {
    const rows  = this.getMessages(sessionId);
    const pairs = [];
    for (let i = 0; i < rows.length - 1; i++) {
      if (rows[i].role === 'user' && rows[i + 1].role === 'assistant') {
        pairs.push({ user: rows[i].content, assistant: rows[i + 1].content });
        i++;
      }
    }
    return pairs;
  }

  getSessionSummary(sessionId) {
    const row = this._get(`SELECT summary, summary_up_to_index FROM sessions WHERE id = ?`, [sessionId]);
    if (!row || !row.summary) return null;
    return { text: row.summary, upToIndex: row.summary_up_to_index || 0 };
  }

  setSessionSummary(sessionId, text, upToIndex) {
    this._run(
      `UPDATE sessions SET summary = ?, summary_up_to_index = ? WHERE id = ?`,
      [text, upToIndex, sessionId]
    );
  }

  // ─── Long-term memory ──────────────────────────────────────────────────────

  addMemory(content, source = 'manual', category = 'fact', mode = 'any') {
    const now = Date.now();
    const id  = randomUUID();
    this._run(
      `INSERT INTO memory (id, content, source, category, mode, created_at, updated_at, last_reinforced)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, content, source, category, mode, now, now, now]
    );

    // Background embedding
    memoryEmbedder.embed(content).then(emb => {
      if (emb) {
        this._run(`UPDATE memory SET embedding = ? WHERE id = ?`, [JSON.stringify(emb), id]);
      }
    }).catch(() => {});

    return id;
  }

  getMemory() {
    return this._all(`SELECT id, content, source, category, mode, created_at, updated_at, last_reinforced FROM memory ORDER BY created_at DESC`);
  }

  async getRelevantMemory(query, topK = 8, mode = null) {
    const all = mode
      ? this._all(`SELECT * FROM memory WHERE mode IN (?, 'any')`, [mode])
      : this._all(`SELECT * FROM memory`);
    if (all.length === 0) return [];

    const strip = row => {
      const { embedding, ...rest } = row; // eslint-disable-line no-unused-vars
      return rest;
    };

    if (all.length <= topK) return all.map(strip);

    try {
      const queryEmb = await memoryEmbedder.embed(query);
      if (!queryEmb) return all.slice(0, topK).map(strip);

      // Backfill missing embeddings — fire-and-forget so retrieval isn't blocked
      for (const m of all) {
        if (!m.embedding) {
          memoryEmbedder.embed(m.content).then(emb => {
            if (emb) this._run(`UPDATE memory SET embedding = ? WHERE id = ?`, [JSON.stringify(emb), m.id]);
          }).catch(() => {});
        }
      }

      const MS_PER_DAY = 86400000;
      const LAMBDA     = 0.04;
      const now        = Date.now();

      // Category boost: preferences and procedural memories are always relevant
      const CATEGORY_BOOST = { preference: 0.25, procedural: 0.30, project: 0.10, entity: 0.05, fact: 0 };

      const scored = all.map(m => {
        const emb      = m.embedding ? JSON.parse(m.embedding) : null;
        const cosScore = emb ? memoryEmbedder.cosine(queryEmb, emb) : 0;
        const ageDays  = (now - (m.last_reinforced || m.created_at || now)) / MS_PER_DAY;
        const decay    = Math.exp(-LAMBDA * ageDays);
        const boost    = CATEGORY_BOOST[m.category] || 0;
        return { m, score: Math.min(1, cosScore * decay + boost) };
      });

      const topMatches = scored.sort((a, b) => b.score - a.score).slice(0, topK);

      // Reinforce recalled memories
      for (const { m, score } of topMatches) {
        if (score > 0.25) {
          this._run(`UPDATE memory SET last_reinforced = ? WHERE id = ?`, [now, m.id]);
        }
      }

      return topMatches.map(({ m }) => ({
        id:              m.id,
        content:         m.content,
        source:          m.source,
        category:        m.category || 'fact',
        created_at:      m.created_at,
        updated_at:      m.updated_at,
        last_reinforced: m.last_reinforced,
      }));
    } catch {
      return all.slice(0, topK).map(strip);
    }
  }

  updateMemory(id, content) {
    const now = Date.now();
    this._run(`UPDATE memory SET content = ?, updated_at = ?, embedding = NULL WHERE id = ?`, [content, now, id]);
    memoryEmbedder.embed(content).then(emb => {
      if (emb) this._run(`UPDATE memory SET embedding = ? WHERE id = ?`, [JSON.stringify(emb), id]);
    }).catch(() => {});
  }

  deleteMemory(id) {
    this._run(`DELETE FROM memory WHERE id = ?`, [id]);
    this._flushNow();
  }

  clearAllMemory() {
    this._run(`DELETE FROM memory`);
    this._flushNow();
  }

  // ─── Session auto-tagging ─────────────────────────────────────────────────

  indexSessionTags(sessionId) {
    const rows = this._all(
      `SELECT content FROM messages WHERE session_id = ?`,
      [sessionId]
    );
    const text = rows.map(r => r.content || '').join(' ');
    if (text.length < 80) return;
    const tags = this._extractKeywords(text, 4);
    if (tags.length > 0) {
      this._run(`UPDATE sessions SET tags = ? WHERE id = ?`, [JSON.stringify(tags), sessionId]);
    }
  }

  _extractKeywords(text, topN = 4) {
    const STOP = new Set([
      'the','a','an','is','are','was','were','be','been','being','have','has','had',
      'do','does','did','will','would','could','should','can','this','that','these',
      'those','they','them','their','what','how','when','where','why','all','some',
      'any','more','most','other','about','into','from','with','your','just','like',
      'also','then','than','very','much','here','there','well','even','back','such',
      'good','used','make','know','want','need','think','look','find','help','give',
      'said','each','every','who','own','too','out','and','not','but','for','you',
      'yes','okay','sure','right','great','want','need','using','based','want',
      'really','actually','basically','generally','typically','usually','often',
      'please','thanks','hello','sure','going','come','work','time','way','thing',
      'things','something','anything','nothing','everything','someone','anyone',
    ]);
    const words = text.toLowerCase().match(/[a-z]{4,}/g) || [];
    const freq  = {};
    for (const w of words) if (!STOP.has(w)) freq[w] = (freq[w] || 0) + 1;
    return Object.entries(freq)
      .filter(([, c]) => c >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([w]) => w);
  }

  // ─── Episodic memory ───────────────────────────────────────────────────────

  async indexSessionEpisode(sessionId) {
    const session = this.getSession(sessionId);
    if (!session || !session.title) return;

    const rows     = this._all(
      `SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at LIMIT 3`,
      [sessionId]
    );
    if (rows.length === 0) return;

    const titlePart   = `Topic: ${session.title}. `;
    const contentPart = rows.map(r => r.content.replace(/\s+/g, ' ').slice(0, 180)).join(' | ');
    const embedText   = (titlePart + contentPart).slice(0, 600);

    const embedding = await memoryEmbedder.embed(embedText);
    if (!embedding) return;

    this._run(
      `UPDATE sessions SET episode_digest = ?, episode_embedding = ? WHERE id = ?`,
      [contentPart.slice(0, 200), JSON.stringify(embedding), sessionId]
    );
  }

  async getRelevantEpisodes(query, currentSessionId, topK = 3) {
    const MIN_SCORE = 0.35;

    // Check rows first — avoids a ~3s embedder round-trip when there are no
    // episodes to compare against (common for fresh installs).
    const rows = this._all(
      `SELECT id, title, updated_at, episode_digest, episode_embedding
       FROM sessions
       WHERE id != ? AND title IS NOT NULL AND episode_embedding IS NOT NULL`,
      [currentSessionId]
    );
    if (rows.length === 0) return [];

    const queryEmb = await memoryEmbedder.embed(query);
    if (!queryEmb) return [];

    return rows
      .map(s => ({
        title:      s.title,
        updated_at: s.updated_at,
        digest:     s.episode_digest || s.title,
        score:      memoryEmbedder.cosine(queryEmb, JSON.parse(s.episode_embedding)),
      }))
      .filter(e => e.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  // ─── Documents ─────────────────────────────────────────────────────────────

  saveDocument(sessionId, { name, type, text, pages }) {
    const id  = randomUUID();
    const now = Date.now();
    this._run(
      `INSERT OR REPLACE INTO documents (id, session_id, name, type, text, pages, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [id, sessionId, name, type || 'text', text, pages || null, now]
    );
    return id;
  }

  getDocuments(sessionId) {
    return this._all(
      `SELECT id, name, type, text, pages, created_at FROM documents WHERE session_id = ? ORDER BY created_at ASC`,
      [sessionId]
    );
  }

  deleteDocument(id) {
    this._run(`DELETE FROM documents WHERE id = ?`, [id]);
  }

  // ─── Feedback / few-shot library ──────────────────────────────────────────

  /**
   * Save a feedback rating on an exchange.
   * rating: 1 = thumbs up, -1 = thumbs down
   */
  addFeedback({ sessionId = null, userMessage, assistantResponse, rating, correction = null, model = null, agentId = 'friday', appMode = 'chat' } = {}) {
    const id = randomUUID();
    const now = Date.now();
    this._run(
      `INSERT INTO feedback (id, session_id, user_message, assistant_response, rating, correction, model, agent_id, app_mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, sessionId, String(userMessage || ''), String(assistantResponse || ''), rating, correction || null, model || null, agentId, appMode, now]
    );
    // Backfill embedding for thumbs-up exchanges so they can be retrieved semantically
    if (rating === 1) {
      memoryEmbedder.embed(userMessage).then(emb => {
        if (emb) this._run(`UPDATE feedback SET embedding = ? WHERE id = ?`, [JSON.stringify(emb), id]);
      }).catch(() => {});
    }
    this._scheduleSave();
    return id;
  }

  /** Remove or flip a feedback rating (e.g. user un-thumbs). */
  deleteFeedback(id) {
    this._run(`DELETE FROM feedback WHERE id = ?`, [id]);
    this._scheduleSave();
  }

  /** All positive-rated exchanges, newest first. */
  getPositiveFeedback(limit = 100) {
    return this._all(
      `SELECT id, session_id, user_message, assistant_response, model, agent_id, app_mode, created_at
         FROM feedback WHERE rating = 1 ORDER BY created_at DESC LIMIT ?`,
      [limit]
    );
  }

  /**
   * Retrieve the top-K most semantically relevant thumbs-up exchanges.
   * Falls back to recency if embeddings aren't ready.
   */
  async getRelevantFewShots(query, topK = 2, appMode = null) {
    const candidates = appMode
      ? this._all(`SELECT * FROM feedback WHERE rating = 1 AND app_mode = ? ORDER BY created_at DESC LIMIT 50`, [appMode])
      : this._all(`SELECT * FROM feedback WHERE rating = 1 ORDER BY created_at DESC LIMIT 50`);

    if (candidates.length === 0) return [];
    if (candidates.length <= topK) return candidates.map(({ embedding, ...rest }) => rest); // eslint-disable-line no-unused-vars

    try {
      const queryEmb = await memoryEmbedder.embed(query);
      if (!queryEmb) return candidates.slice(0, topK).map(({ embedding, ...rest }) => rest); // eslint-disable-line no-unused-vars

      // Backfill missing embeddings
      for (const row of candidates) {
        if (!row.embedding) {
          memoryEmbedder.embed(row.user_message).then(emb => {
            if (emb) this._run(`UPDATE feedback SET embedding = ? WHERE id = ?`, [JSON.stringify(emb), row.id]);
          }).catch(() => {});
        }
      }

      const scored = candidates.map(row => {
        const emb   = row.embedding ? JSON.parse(row.embedding) : null;
        const score = emb ? memoryEmbedder.cosine(queryEmb, emb) : 0;
        return { row, score };
      });

      return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .map(({ row }) => { const { embedding, ...rest } = row; return rest; }); // eslint-disable-line no-unused-vars
    } catch {
      return candidates.slice(0, topK).map(({ embedding, ...rest }) => rest); // eslint-disable-line no-unused-vars
    }
  }

  // ─── Graceful shutdown ─────────────────────────────────────────────────────

  /** Call on app quit to ensure the last write is flushed. */
  close() {
    this._flushNow();
    if (this._db) { this._db.close(); this._db = null; }
  }
}

module.exports = PersistentStore;
