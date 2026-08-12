/**
 * TodoStore - every SQL statement in the feature lives here.
 *
 * Rows go out as camelCase objects with a computed `overdue` flag; SQL columns
 * stay snake_case. `_row()` is the single mapping seam.
 *
 * Three things worth knowing before editing:
 *   - Status is a FOREIGN KEY-ish reference to todo_statuses.id, not an enum. The
 *     board view lets the user define their own columns, so nothing here may
 *     hardcode 'pending'/'completed' except the seeded defaults in schema.js.
 *   - Sub-tasks are one level deep by design (parent_id points at a top-level
 *     task). Arbitrary nesting is a rabbit hole for a personal to-do app and
 *     makes both the table and the board ambiguous.
 *   - Ordering is `sort_order ASC, seq ASC`. sort_order is user-controlled via
 *     drag; seq is the monotonic tiebreak so equal sort_orders stay stable.
 */

'use strict';

const { randomUUID } = require('crypto');
const { clean, cleanMulti, normTags, normPriority, isOverdue } = require('./text');

class ValidationError extends Error {
  constructor(message) { super(message); this.name = 'ValidationError'; }
}

const MAX_OPEN_TASKS = 2000;  // the whole DB is re-serialised on every flush
const MAX_TITLE      = 200;
const MAX_NOTES      = 5000;
const MAX_NAME       = 40;

const COLS = `id, seq, parent_id, title, notes, status, priority, due_at, due_all_day,
              tags, category, sort_order, pomo_done, pomo_target,
              created_at, updated_at, completed_at`;

class TodoStore {
  constructor(db) {
    this._db = db;
  }

  // ─── Mapping ───────────────────────────────────────────────────────────────

  _row(r, doneSet) {
    if (!r) return null;
    let tags = [];
    try { if (r.tags) tags = JSON.parse(r.tags); } catch {}
    if (!Array.isArray(tags)) tags = [];

    const allDay = r.due_all_day !== 0;
    const done   = doneSet ? doneSet.has(r.status) : false;
    return {
      id:          r.id,
      seq:         r.seq,
      parentId:    r.parent_id ?? null,
      title:       r.title,
      notes:       r.notes || '',
      status:      r.status,
      done,
      priority:    r.priority,
      dueAt:       r.due_at ?? null,
      dueAllDay:   allDay,
      tags,
      category:    r.category ?? null,
      sortOrder:   r.sort_order ?? 0,
      pomoDone:    r.pomo_done ?? 0,
      pomoTarget:  r.pomo_target ?? null,
      createdAt:   r.created_at,
      updatedAt:   r.updated_at,
      completedAt: r.completed_at ?? null,
      overdue:     !done && isOverdue(r.due_at ?? null, allDay, done ? 'completed' : 'pending'),
    };
  }

  /** Ids of every status flagged is_done - the app's only notion of "finished". */
  _doneSet() {
    return new Set(this._db.all(`SELECT id FROM todo_statuses WHERE is_done = 1`).map(r => r.id));
  }

  _defaultStatus() {
    const r = this._db.get(`SELECT id FROM todo_statuses ORDER BY position ASC, id ASC LIMIT 1`);
    return r?.id ?? 'pending';
  }

  // ─── Statuses (board columns) ──────────────────────────────────────────────

  listStatuses() {
    return this._db.all(
      `SELECT id, name, color, position, is_done FROM todo_statuses ORDER BY position ASC, id ASC`
    ).map(r => ({ id: r.id, name: r.name, color: r.color || null, position: r.position, isDone: r.is_done === 1 }));
  }

  createStatus({ name, color = null, isDone = false } = {}) {
    const n = clean(name, MAX_NAME);
    if (!n) throw new ValidationError('A column needs a name.');
    const { p } = this._db.get(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM todo_statuses`) ?? { p: 0 };
    const id = randomUUID();
    this._db.run(
      `INSERT INTO todo_statuses (id, name, color, position, is_done) VALUES (?,?,?,?,?)`,
      [id, n, color, p, isDone ? 1 : 0]
    );
    return this.listStatuses().find(s => s.id === id);
  }

  updateStatus(id, patch = {}) {
    const cur = this.listStatuses().find(s => s.id === id);
    if (!cur) return null;
    const sets = [], vals = [];
    if (patch.name   !== undefined) {
      const n = clean(patch.name, MAX_NAME);
      if (!n) throw new ValidationError('A column needs a name.');
      sets.push('name = ?');  vals.push(n);
    }
    if (patch.color  !== undefined) { sets.push('color = ?');   vals.push(patch.color || null); }
    if (patch.isDone !== undefined) { sets.push('is_done = ?'); vals.push(patch.isDone ? 1 : 0); }
    if (!sets.length) return cur;
    vals.push(id);
    this._db.run(`UPDATE todo_statuses SET ${sets.join(', ')} WHERE id = ?`, vals);
    return this.listStatuses().find(s => s.id === id);
  }

  /**
   * Delete a column, moving its tasks to `reassignTo` (or the first remaining
   * column). Refuses to delete the last one - a board with no columns has
   * nowhere to put anything.
   */
  deleteStatus(id, reassignTo = null) {
    const all = this.listStatuses();
    if (all.length <= 1) throw new ValidationError('You need at least one column.');
    if (!all.some(s => s.id === id)) return false;

    const target = all.find(s => s.id === reassignTo && s.id !== id) || all.find(s => s.id !== id);
    const now = Date.now();
    this._db.run(`UPDATE todos SET status = ?, updated_at = ? WHERE status = ?`, [target.id, now, id]);
    // Keep completed_at consistent with the column the tasks landed in - otherwise
    // deleting a column can leave a task flagged done with no completion time (or
    // the reverse), and every count that reads completed_at quietly drifts.
    if (target.isDone) {
      this._db.run(`UPDATE todos SET completed_at = ? WHERE status = ? AND completed_at IS NULL`, [now, target.id]);
    } else {
      this._db.run(`UPDATE todos SET completed_at = NULL WHERE status = ?`, [target.id]);
    }
    this._db.run(`DELETE FROM todo_statuses WHERE id = ?`, [id]);
    this._db.flush();
    return true;
  }

  reorderStatuses(orderedIds = []) {
    orderedIds.forEach((id, i) => this._db.run(`UPDATE todo_statuses SET position = ? WHERE id = ?`, [i, id]));
    return this.listStatuses();
  }

  // ─── Categories ────────────────────────────────────────────────────────────

  listCategories() {
    return this._db.all(
      `SELECT id, name, color, position FROM todo_categories ORDER BY position ASC, name ASC`
    ).map(r => ({ id: r.id, name: r.name, color: r.color || null, position: r.position }));
  }

  createCategory({ name, color = null } = {}) {
    const n = clean(name, MAX_NAME);
    if (!n) throw new ValidationError('A category needs a name.');
    if (this.listCategories().some(c => c.name.toLowerCase() === n.toLowerCase())) {
      throw new ValidationError(`"${n}" already exists.`);
    }
    const { p } = this._db.get(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM todo_categories`) ?? { p: 0 };
    const id = randomUUID();
    this._db.run(`INSERT INTO todo_categories (id, name, color, position) VALUES (?,?,?,?)`, [id, n, color, p]);
    return this.listCategories().find(c => c.id === id);
  }

  updateCategory(id, patch = {}) {
    const cur = this.listCategories().find(c => c.id === id);
    if (!cur) return null;
    const sets = [], vals = [];
    if (patch.name !== undefined) {
      const n = clean(patch.name, MAX_NAME);
      if (!n) throw new ValidationError('A category needs a name.');
      sets.push('name = ?'); vals.push(n);
      // Tasks store the category NAME, so a rename has to follow through.
      this._db.run(`UPDATE todos SET category = ? WHERE category = ?`, [n, cur.name]);
    }
    if (patch.color !== undefined) { sets.push('color = ?'); vals.push(patch.color || null); }
    if (!sets.length) return cur;
    vals.push(id);
    this._db.run(`UPDATE todo_categories SET ${sets.join(', ')} WHERE id = ?`, vals);
    return this.listCategories().find(c => c.id === id);
  }

  /** Deleting a category leaves its tasks uncategorised rather than deleting them. */
  deleteCategory(id) {
    const cur = this.listCategories().find(c => c.id === id);
    if (!cur) return false;
    this._db.run(`UPDATE todos SET category = NULL WHERE category = ?`, [cur.name]);
    this._db.run(`DELETE FROM todo_categories WHERE id = ?`, [id]);
    this._db.flush();
    return true;
  }

  // ─── Tasks ─────────────────────────────────────────────────────────────────

  create(input = {}) {
    const title = clean(input.title, MAX_TITLE);
    if (!title) throw new ValidationError('A to-do needs a title.');

    const { c } = this._db.get(`SELECT COUNT(*) AS c FROM todos`) ?? { c: 0 };
    if (c >= MAX_OPEN_TASKS) {
      throw new ValidationError(`This list is at its ${MAX_OPEN_TASKS}-item limit - delete some first.`);
    }

    // Sub-tasks are one level deep: if the parent is itself a sub-task, attach to
    // its parent instead of building a chain the views can't render.
    let parentId = input.parentId || null;
    if (parentId) {
      const p = this.get(parentId);
      parentId = p ? (p.parentId || p.id) : null;
    }

    const statuses = this.listStatuses();
    const status   = statuses.some(s => s.id === input.status) ? input.status : this._defaultStatus();
    const isDone   = statuses.find(s => s.id === status)?.isDone ?? false;

    const now = Date.now();
    const seq = (this._db.get(`SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM todos`)?.n) ?? 1;
    const id  = randomUUID();
    let dueAt = Number.isFinite(input.dueAt) ? input.dueAt : null;

    this._db.run(
      `INSERT INTO todos (${COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, seq, parentId, title, cleanMulti(input.notes, MAX_NOTES), status,
        normPriority(input.priority), dueAt, input.dueAllDay === false ? 0 : 1,
        JSON.stringify(normTags(input.tags)),
        input.category ? clean(input.category, MAX_NAME) : null,
        Number.isFinite(input.sortOrder) ? input.sortOrder : seq,
        0, Number.isFinite(input.pomoTarget) ? input.pomoTarget : null,
        now, now, isDone ? now : null,
      ]
    );
    return this.get(id);
  }

  update(id, patch = {}) {
    const cur = this.get(id);
    if (!cur) return null;

    const sets = [], vals = [];
    const set  = (col, v) => { sets.push(`${col} = ?`); vals.push(v); };

    if (patch.title !== undefined) {
      const t = clean(patch.title, MAX_TITLE);
      if (!t) throw new ValidationError('A to-do needs a title.');
      set('title', t);
    }
    if (patch.notes      !== undefined) set('notes',      cleanMulti(patch.notes, MAX_NOTES));
    if (patch.priority   !== undefined) set('priority',   normPriority(patch.priority));
    if (patch.tags       !== undefined) set('tags',       JSON.stringify(normTags(patch.tags)));
    if (patch.category   !== undefined) set('category',   patch.category ? clean(patch.category, MAX_NAME) : null);
    if (patch.sortOrder  !== undefined) set('sort_order', Number.isFinite(patch.sortOrder) ? patch.sortOrder : cur.sortOrder);
    if (patch.pomoTarget !== undefined) set('pomo_target', Number.isFinite(patch.pomoTarget) ? patch.pomoTarget : null);

    if (patch.dueAt !== undefined) {
      set('due_at', Number.isFinite(patch.dueAt) ? patch.dueAt : null);
      set('due_all_day', patch.dueAllDay === false ? 0 : 1);
    } else if (patch.dueAllDay !== undefined) {
      set('due_all_day', patch.dueAllDay === false ? 0 : 1);
    }

    if (patch.status !== undefined) {
      const statuses = this.listStatuses();
      const next = statuses.find(s => s.id === patch.status);
      if (!next) throw new ValidationError('That column no longer exists.');
      set('status', next.id);
      // completed_at tracks the is_done flag, not a particular status name.
      if (next.isDone && !cur.done)      set('completed_at', Date.now());
      else if (!next.isDone && cur.done) set('completed_at', null);
    }

    if (!sets.length) return cur;
    set('updated_at', Date.now());
    vals.push(id);
    this._db.run(`UPDATE todos SET ${sets.join(', ')} WHERE id = ?`, vals);
    return this.get(id);
  }

  /** Drag-and-drop: move a task to a column at a given index, renumbering peers. */
  move(id, statusId, index = 0) {
    const cur = this.get(id);
    if (!cur) return null;
    if (statusId && statusId !== cur.status) this.update(id, { status: statusId });

    const target = statusId || cur.status;
    const peers  = this._db.all(
      `SELECT id FROM todos WHERE status = ? AND parent_id IS NULL AND id != ?
        ORDER BY sort_order ASC, seq ASC`, [target, id]
    ).map(r => r.id);

    const at = Math.min(Math.max(parseInt(index, 10) || 0, 0), peers.length);
    peers.splice(at, 0, id);
    peers.forEach((pid, i) => this._db.run(`UPDATE todos SET sort_order = ? WHERE id = ?`, [i, pid]));
    return this.get(id);
  }

  /** Deleting a parent takes its sub-tasks with it - an orphan subtask is noise. */
  remove(id) {
    const cur = this.get(id);
    if (!cur) return false;
    this._db.run(`DELETE FROM todos WHERE id = ? OR parent_id = ?`, [id, id]);
    this._db.flush();
    return true;
  }

  clearCompleted() {
    const done = [...this._doneSet()];
    if (!done.length) return 0;
    const marks = done.map(() => '?').join(',');
    const { c } = this._db.get(`SELECT COUNT(*) AS c FROM todos WHERE status IN (${marks})`, done) ?? { c: 0 };
    if (!c) return 0;
    // Take sub-tasks of deleted parents with them, even if the child isn't done.
    this._db.run(
      `DELETE FROM todos WHERE status IN (${marks})
         OR parent_id IN (SELECT id FROM todos WHERE status IN (${marks}))`, [...done, ...done]
    );
    this._db.flush();
    return c;
  }

  incrementPomo(id) {
    const cur = this.get(id);
    if (!cur) return null;
    this._db.run(`UPDATE todos SET pomo_done = pomo_done + 1, updated_at = ? WHERE id = ?`, [Date.now(), id]);
    return this.get(id);
  }

  // ─── Reads ─────────────────────────────────────────────────────────────────

  get(id) {
    if (!id) return null;
    return this._row(this._db.get(`SELECT ${COLS} FROM todos WHERE id = ?`, [id]), this._doneSet());
  }

  /**
   * Everything the window needs in one round trip: tasks (with sub-tasks nested),
   * the status columns, the categories, and headline counts.
   *
   * @param {object} f
   * @param {string} [f.search]  @param {string} [f.category]
   * @param {string} [f.status]  @param {boolean} [f.hideDone]
   */
  board(f = {}) {
    const doneSet = this._doneSet();
    const where = [], params = [];

    if (f.search) {
      where.push(`(LOWER(title) LIKE '%' || LOWER(?) || '%' OR LOWER(COALESCE(notes,'')) LIKE '%' || LOWER(?) || '%')`);
      params.push(clean(f.search, 120), clean(f.search, 120));
    }
    if (f.category) { where.push('category = ?'); params.push(clean(f.category, MAX_NAME)); }
    if (f.status)   { where.push('status = ?');   params.push(f.status); }
    if (f.hideDone && doneSet.size) {
      where.push(`status NOT IN (${[...doneSet].map(() => '?').join(',')})`);
      params.push(...doneSet);
    }

    const sql = `SELECT ${COLS} FROM todos${where.length ? ' WHERE ' + where.join(' AND ') : ''}
                 ORDER BY sort_order ASC, seq ASC`;
    const rows = this._db.all(sql, params).map(r => this._row(r, doneSet));

    // Nest sub-tasks under their parent. A sub-task whose parent was filtered out
    // is promoted to the top level rather than vanishing silently.
    const byId = new Map(rows.map(t => [t.id, { ...t, subtasks: [] }]));
    const tree = [];
    for (const t of byId.values()) {
      const parent = t.parentId ? byId.get(t.parentId) : null;
      if (parent) parent.subtasks.push(t);
      else        tree.push(t);
    }

    return {
      tasks:      tree,
      statuses:   this.listStatuses(),
      categories: this.listCategories(),
      stats:      this.stats(),
    };
  }

  stats() {
    const doneSet = this._doneSet();
    const total   = this._db.get(`SELECT COUNT(*) AS c FROM todos`)?.c ?? 0;
    let done = 0;
    if (doneSet.size) {
      const marks = [...doneSet].map(() => '?').join(',');
      done = this._db.get(`SELECT COUNT(*) AS c FROM todos WHERE status IN (${marks})`, [...doneSet])?.c ?? 0;
    }
    const now = Date.now();
    let overdue = 0;
    const openMarks = doneSet.size ? `AND status NOT IN (${[...doneSet].map(() => '?').join(',')})` : '';
    overdue = this._db.get(
      `SELECT COUNT(*) AS c FROM todos
        WHERE due_at IS NOT NULL ${openMarks}
          AND ((due_all_day = 1 AND due_at + 86399999 < ?) OR (due_all_day = 0 AND due_at < ?))`,
      [...doneSet, now, now]
    )?.c ?? 0;

    return { total, done, open: total - done, overdue };
  }
}

module.exports = TodoStore;
module.exports.ValidationError = ValidationError;
