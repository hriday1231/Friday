/**
 * DDL for the To-Do feature.
 *
 * WHY here and not in PersistentStore._runMigrations: this folder is meant to be
 * copy-pasteable into an app whose store we don't own. The host hands us a db
 * adapter; we apply our own schema idempotently on first use.
 *
 * WHY exec() and not run(): the host's run() is prepare()-based, and sql.js
 * prepare() compiles only the FIRST statement - a multi-statement string is
 * silently truncated with no error at all. exec() maps to the raw Database.run().
 *
 * Status is a row in `todo_statuses`, not an enum, because the board view lets the
 * user add, rename and reorder their own columns. `is_done` is the one piece of
 * semantics the app needs from a status (for counts, filters and strike-through),
 * so it stays a flag rather than a hardcoded name.
 */

'use strict';

/**
 * Tables only. Indexes live in INDEXES_SQL and MUST be applied after MIGRATIONS:
 * on a database created by an older version of this module the `todos` table
 * already exists, so CREATE TABLE IF NOT EXISTS is a no-op and the new columns
 * only appear once the ALTER TABLEs have run. An index over a column that does
 * not exist yet throws, and it throws outside the per-statement try/catch.
 */
const TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS todos (
    id           TEXT    PRIMARY KEY,
    seq          INTEGER NOT NULL,
    parent_id    TEXT,
    title        TEXT    NOT NULL,
    notes        TEXT,
    status       TEXT    NOT NULL DEFAULT 'pending',
    priority     TEXT    NOT NULL DEFAULT 'med',
    due_at       INTEGER,
    due_all_day  INTEGER NOT NULL DEFAULT 1,
    tags         TEXT,
    category     TEXT,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    pomo_done    INTEGER NOT NULL DEFAULT 0,
    pomo_target  INTEGER,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    completed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS todo_statuses (
    id       TEXT    PRIMARY KEY,
    name     TEXT    NOT NULL,
    color    TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    is_done  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS todo_categories (
    id       TEXT    PRIMARY KEY,
    name     TEXT    NOT NULL,
    color    TEXT,
    position INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS todo_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`;

const INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_todos_status   ON todos(status, sort_order);
  CREATE INDEX IF NOT EXISTS idx_todos_parent   ON todos(parent_id);
  CREATE INDEX IF NOT EXISTS idx_todos_due      ON todos(due_at);
  CREATE INDEX IF NOT EXISTS idx_todos_category ON todos(category);
`;

/**
 * Per-column adds for databases written by an earlier version of this module.
 * House idiom: run each on its own and swallow the "duplicate column" error.
 */
const MIGRATIONS = [
  `ALTER TABLE todos ADD COLUMN parent_id   TEXT`,
  `ALTER TABLE todos ADD COLUMN category    TEXT`,
  `ALTER TABLE todos ADD COLUMN sort_order  INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE todos ADD COLUMN pomo_done   INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE todos ADD COLUMN pomo_target INTEGER`,
  `ALTER TABLE todos ADD COLUMN notes       TEXT`,
];

/**
 * One-time data moves that can't be expressed as an ALTER. Each is guarded so it
 * runs at most once, and each is wrapped in its own try/catch by the caller.
 *
 * `list` was the old categorisation column (NOT NULL DEFAULT 'inbox'); it is now
 * `category`, which is nullable so "uncategorised" is a real state rather than a
 * magic string. sqlite can't drop a column on older builds, so `list` is left in
 * place, unread, on databases that already have it.
 */
const DATA_MIGRATIONS = [
  `UPDATE todos SET category = list
     WHERE category IS NULL AND list IS NOT NULL AND list != 'inbox'`,
  // The old fixed status vocabulary maps 1:1 onto the seeded default statuses,
  // so nothing to rewrite there - but rows created before sort_order existed all
  // share 0, which would make manual ordering meaningless. Seed from seq.
  `UPDATE todos SET sort_order = seq WHERE sort_order = 0`,
];

/**
 * Default board columns. Ids match the old hardcoded status values so existing
 * rows land in the right column with no data rewrite.
 */
const DEFAULT_STATUSES = [
  { id: 'pending',     name: 'To do',       color: '#6a6058', position: 0, is_done: 0 },
  { id: 'in_progress', name: 'In progress', color: '#c85514', position: 1, is_done: 0 },
  { id: 'completed',   name: 'Done',        color: '#4f9d5c', position: 2, is_done: 1 },
];

module.exports = { TABLES_SQL, INDEXES_SQL, MIGRATIONS, DATA_MIGRATIONS, DEFAULT_STATUSES };
