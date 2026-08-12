/**
 * Module configuration, stored in the module's own `todo_meta` table rather than
 * the host's settings store - so porting this folder needs no host settings edit.
 *
 * Two groups: Pomodoro durations, and view preferences (which table columns show,
 * in what order, and under what header text).
 *
 * Memoised, because getConfig() is read on every window load and every timer tick.
 */

'use strict';

/**
 * The table's column set. `key` maps to a field on the row objects TodoStore
 * returns; `label` is user-editable, which is what "customizable headers" means.
 * `fixed: true` columns can be reordered and renamed but not hidden - without a
 * title there is no row to click.
 */
const DEFAULT_COLUMNS = [
  { key: 'title',    label: 'Task',     width: 320, visible: true, fixed: true },
  { key: 'status',   label: 'Status',   width: 130, visible: true },
  { key: 'dueAt',    label: 'Due',      width: 110, visible: true },
  { key: 'priority', label: 'Priority', width: 90,  visible: true },
  { key: 'category', label: 'Category', width: 120, visible: true },
  { key: 'tags',     label: 'Tags',     width: 140, visible: true },
  { key: 'pomo',     label: 'Pomos',    width: 80,  visible: true },
  { key: 'notes',    label: 'Notes',    width: 220, visible: false },
  { key: 'createdAt',label: 'Created',  width: 110, visible: false },
  { key: 'updatedAt',label: 'Updated',  width: 110, visible: false },
];

const DEFAULTS = {
  // Pomodoro, all in minutes except roundsUntilLongBreak.
  workMin:              25,
  breakMin:             5,
  longBreakMin:         15,
  roundsUntilLongBreak: 4,
  autoStartBreaks:      false,
  autoStartWork:        false,
  tickSound:            false,

  // View
  view:      'table',   // 'table' | 'board'
  hideDone:  false,
  columns:   DEFAULT_COLUMNS,
};

let _cache = null;

function _mergeColumns(stored) {
  if (!Array.isArray(stored)) return DEFAULT_COLUMNS.map(c => ({ ...c }));
  // Keep the user's order and labels, but re-add any column added by a later
  // version of this module and drop any whose key no longer exists.
  const known = new Map(DEFAULT_COLUMNS.map(c => [c.key, c]));
  const out = [];
  for (const c of stored) {
    const base = known.get(c?.key);
    if (!base) continue;
    out.push({
      ...base,
      label:   typeof c.label === 'string' && c.label.trim() ? c.label.trim().slice(0, 24) : base.label,
      width:   Number.isFinite(c.width) ? Math.min(Math.max(c.width, 60), 600) : base.width,
      visible: base.fixed ? true : c.visible !== false,
    });
    known.delete(c.key);
  }
  for (const leftover of known.values()) out.push({ ...leftover });
  return out;
}

function getConfig(db) {
  if (_cache) return _cache;
  let stored = {};
  try {
    const row = db.get(`SELECT value FROM todo_meta WHERE key = 'config'`);
    if (row?.value) stored = JSON.parse(row.value);
  } catch { /* corrupt or missing - fall back to defaults */ }
  if (!stored || typeof stored !== 'object') stored = {};

  _cache = { ...DEFAULTS, ...stored, columns: _mergeColumns(stored.columns) };
  return _cache;
}

function _clampInt(v, lo, hi, fallback) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function saveConfig(db, patch = {}) {
  const cur = getConfig(db);
  const next = {
    ...cur,
    workMin:              patch.workMin              === undefined ? cur.workMin              : _clampInt(patch.workMin, 1, 180, cur.workMin),
    breakMin:             patch.breakMin             === undefined ? cur.breakMin             : _clampInt(patch.breakMin, 1, 60, cur.breakMin),
    longBreakMin:         patch.longBreakMin         === undefined ? cur.longBreakMin         : _clampInt(patch.longBreakMin, 1, 120, cur.longBreakMin),
    roundsUntilLongBreak: patch.roundsUntilLongBreak === undefined ? cur.roundsUntilLongBreak : _clampInt(patch.roundsUntilLongBreak, 1, 12, cur.roundsUntilLongBreak),
    autoStartBreaks:      patch.autoStartBreaks      === undefined ? cur.autoStartBreaks      : !!patch.autoStartBreaks,
    autoStartWork:        patch.autoStartWork        === undefined ? cur.autoStartWork        : !!patch.autoStartWork,
    tickSound:            patch.tickSound            === undefined ? cur.tickSound            : !!patch.tickSound,
    view:                 patch.view === 'board' || patch.view === 'table' ? patch.view : cur.view,
    hideDone:             patch.hideDone             === undefined ? cur.hideDone             : !!patch.hideDone,
    columns:              patch.columns              === undefined ? cur.columns              : _mergeColumns(patch.columns),
  };

  // INSERT OR REPLACE rather than an ON CONFLICT upsert - the latter needs
  // SQLite >= 3.24 and we don't control which build sql.js ships.
  db.run(`INSERT OR REPLACE INTO todo_meta (key, value) VALUES ('config', ?)`, [JSON.stringify(next)]);
  db.flush();
  _cache = next;
  return next;
}

// DEFAULTS and DEFAULT_COLUMNS stay internal: saveConfig() is the only writer and
// it keeps the memo in step, so nothing outside needs to reach past getConfig().
module.exports = { getConfig, saveConfig };
