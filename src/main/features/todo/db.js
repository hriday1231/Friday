/**
 * Thin wrapper over the host-supplied database adapter.
 *
 * The host owns the database; this module owns its own tables. The adapter is
 * five functions (see README.md - "Host contract"):
 *
 *   exec(sql)          raw MULTI-statement execute. DDL only.
 *   all(sql, params)   → array of row objects
 *   get(sql, params)   → first row, or null
 *   run(sql, params)   one statement, then schedule a durable save
 *   flush()            force an immediate durable write
 *
 * Schema is applied lazily on first use rather than at init, so the IPC handlers
 * can be registered at module top level like every other handler in the app
 * without an ordering constraint.
 */

'use strict';

const { TABLES_SQL, INDEXES_SQL, MIGRATIONS, DATA_MIGRATIONS, DEFAULT_STATUSES } = require('./schema');

const REQUIRED = ['exec', 'all', 'get', 'run', 'flush'];

function createDbHandle(adapter) {
  for (const fn of REQUIRED) {
    if (typeof adapter?.[fn] !== 'function') {
      throw new Error(`[todo] db adapter is missing ${fn}()`);
    }
  }

  let ready = false;
  const ensure = () => {
    if (ready) return;
    // Order matters: tables, then the per-column ALTERs, and only then the
    // indexes - an index over a column an older database doesn't have yet throws,
    // and it would throw outside the per-statement try/catch below.
    adapter.exec(TABLES_SQL);
    for (const sql of MIGRATIONS)      { try { adapter.exec(sql); } catch {} }
    try { adapter.exec(INDEXES_SQL); } catch (err) { console.warn('[todo] index build skipped:', err.message); }
    for (const sql of DATA_MIGRATIONS) { try { adapter.exec(sql); } catch {} }

    // Seed the default board columns. INSERT OR IGNORE so a user who renamed or
    // recoloured "To do" keeps their version across restarts.
    for (const s of DEFAULT_STATUSES) {
      try {
        adapter.run(
          `INSERT OR IGNORE INTO todo_statuses (id, name, color, position, is_done) VALUES (?,?,?,?,?)`,
          [s.id, s.name, s.color, s.position, s.is_done]
        );
      } catch {}
    }
    ready = true;
    // The schema must survive a crash before the first row is written - exec()
    // maps to the raw sql.js run(), which does not schedule a save of its own.
    try { adapter.flush(); } catch (err) { console.error('[todo] schema flush failed:', err.message); }
    console.log('[todo] schema ready');
  };

  // sql.js bindValue() throws "Wrong API use" on undefined and on booleans.
  const norm = (params) => params.map((v) =>
    v === undefined || v === null ? null
      : typeof v === 'boolean' ? (v ? 1 : 0)
        : v
  );

  return {
    all(sql, params = []) { ensure(); return adapter.all(sql, norm(params)); },
    get(sql, params = []) { ensure(); return adapter.get(sql, norm(params)); },
    run(sql, params = []) { ensure(); adapter.run(sql, norm(params)); },
    flush() {
      try { adapter.flush(); }
      catch (err) { console.error('[todo] flush failed:', err.message); }
    },
  };
}

module.exports = { createDbHandle };
