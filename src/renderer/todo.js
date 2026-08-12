/**
 * Friday - To-Do window.
 *
 * A standalone window (like Settings), deliberately with no connection to the
 * chat agent: it adds nothing to any LLM request. Everything here talks to the
 * main process over the todo-* IPC channels exposed in preload.js.
 *
 * Two views over one dataset:
 *   Table - configurable columns (show/hide, drag to reorder, rename headers,
 *           click to sort). Sub-tasks render indented under their parent.
 *   Board - one column per status; statuses are user-defined, so the columns
 *           ARE the workflow. Drag cards between them.
 *
 * Security: every value here is user-authored and rendered with textContent or
 * as a property - no innerHTML anywhere in this file, so a grep audit is
 * conclusive. Titles can contain anything.
 */

'use strict';

const api = window.electronAPI || {};

// ─── State ────────────────────────────────────────────────────────────────────

let cfg        = null;   // config from main (columns, pomodoro, view)
let tasks      = [];     // top-level tasks, each with .subtasks[]
let statuses   = [];
let categories = [];
let stats      = { total: 0, done: 0, open: 0, overdue: 0 };

let selectedId  = null;  // task shown in the drawer / linked to the timer
let sortKey     = null;
let sortDir     = 1;
const collapsed = new Set();   // parent ids whose sub-tasks are hidden

/**
 * Append the "Edit categories..." entry to a category <select>.
 *
 * Marked with a data attribute rather than a magic value, so it can never
 * collide with a real category name no matter what the user types.
 */
function appendManageOption(select) {
  const o = document.createElement('option');
  o.value = '';
  o.textContent = 'Edit categories...';
  o.dataset.manage = '1';
  select.appendChild(o);
}

/** True when the user picked the "Edit categories..." entry. */
const isManageOption = (select) => select.selectedOptions[0]?.dataset.manage === '1';

const $ = (id) => document.getElementById(id);

function toast(message, kind = '') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast'; }, 2600);
}

async function call(fn, ...args) {
  try {
    const res = await fn?.(...args);
    if (res && res.success === false) { toast(res.error || 'Something went wrong', 'err'); return null; }
    return res;
  } catch (err) {
    toast(err.message || 'Something went wrong', 'err');
    return null;
  }
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function fmtDue(ts, allDay) {
  if (!ts) return '';
  const d = new Date(ts);
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(d) - startOf(new Date())) / 86400000);
  let label;
  if (days === 0)       label = 'today';
  else if (days === 1)  label = 'tomorrow';
  else if (days === -1) label = 'yesterday';
  else {
    label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    if (d.getFullYear() !== new Date().getFullYear()) label += `, ${d.getFullYear()}`;
  }
  if (allDay) return label;
  return `${label} ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

const toDateInput   = (ts) => new Date(ts).toLocaleDateString('sv-SE');   // yyyy-mm-dd
const fromDateInput = (v) => {
  const [y, m, d] = String(v).split('-').map(Number);
  return (y && m && d) ? new Date(y, m - 1, d).getTime() : null;
};
const statusName = (id) => statuses.find(s => s.id === id)?.name ?? '-';
const catColor   = (name) => categories.find(c => c.name === name)?.color || null;

/**
 * Quick-add shorthand, the one piece of "natural language" that consistently
 * earns its keep in every to-do app worth copying:
 *   !high / !low   priority        #tag           @category
 *   today | tomorrow | mon..sun | yyyy-mm-dd      due date
 */
function parseQuickAdd(raw) {
  let text = String(raw || '');
  const out = { title: '', priority: undefined, tags: [], category: undefined, dueAt: undefined };

  text = text.replace(/(^|\s)!(high|med|medium|low)\b/gi, (_, sp, p) => {
    out.priority = p.toLowerCase().startsWith('med') ? 'med' : p.toLowerCase();
    return sp;
  });
  text = text.replace(/(^|\s)#([\w-]{1,24})/g, (_, sp, t) => { out.tags.push(t); return sp; });
  text = text.replace(/(^|\s)@([\w-]{1,40})/g, (_, sp, c) => { out.category = c; return sp; });

  const WEEK = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dateRe = new RegExp(`(^|\\s)(today|tomorrow|${WEEK.join('|')}|\\d{4}-\\d{2}-\\d{2})\\b`, 'i');
  const m = text.match(dateRe);
  if (m) {
    const token = m[2].toLowerCase();
    const now = new Date();
    let d = null;
    if (token === 'today')          d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    else if (token === 'tomorrow')  d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    else if (/^\d{4}-/.test(token)) { const t = fromDateInput(token); if (t) d = new Date(t); }
    else {
      const target = WEEK.indexOf(token);
      if (target >= 0) {
        // Same weekday means next week - a same-day deadline is already half gone.
        let delta = (target - now.getDay() + 7) % 7;
        if (delta === 0) delta = 7;
        d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + delta);
      }
    }
    if (d) { out.dueAt = d.getTime(); text = text.replace(dateRe, '$1'); }
  }

  out.title = text.replace(/\s+/g, ' ').trim();
  return out;
}

// ─── Data ─────────────────────────────────────────────────────────────────────

function filters() {
  return {
    search:   $('searchInput').value.trim() || undefined,
    category: $('categoryFilter').value || undefined,
    hideDone: !!cfg?.hideDone,
  };
}

async function reload() {
  const res = await call(api.todoBoard, filters());
  if (!res) return;
  tasks      = res.tasks || [];
  statuses   = res.statuses || [];
  categories = res.categories || [];
  stats      = res.stats || stats;
  render();
}

async function saveCfg(patch) {
  const res = await call(api.saveTodoConfig, patch);
  if (res?.config) { cfg = res.config; return true; }
  return false;
}

/** Flatten the tree for the table, honouring collapsed parents. */
function flatten() {
  const rows = [];
  const sorted = sortKey ? sortTasks(tasks) : tasks;
  for (const t of sorted) {
    rows.push(t);
    if (!collapsed.has(t.id)) for (const s of (t.subtasks || [])) rows.push(s);
  }
  return rows;
}

function sortTasks(list) {
  const val = (t) => {
    switch (sortKey) {
      case 'title':    return (t.title || '').toLowerCase();
      case 'dueAt':    return t.dueAt ?? Infinity;          // undated sort last
      case 'priority': return { high: 0, med: 1, low: 2 }[t.priority] ?? 1;
      case 'status':   return statuses.findIndex(s => s.id === t.status);
      case 'category': return (t.category || '￿').toLowerCase();
      case 'pomo':     return t.pomoDone ?? 0;
      case 'createdAt':return t.createdAt ?? 0;
      case 'updatedAt':return t.updatedAt ?? 0;
      default:         return 0;
    }
  };
  return [...list].sort((a, b) => {
    const x = val(a), y = val(b);
    if (x < y) return -1 * sortDir;
    if (x > y) return  1 * sortDir;
    return 0;
  });
}

// ─── Render ───────────────────────────────────────────────────────────────────

function render() {
  $('todoStats').textContent =
    `${stats.open} open · ${stats.done} done${stats.overdue ? ` · ${stats.overdue} overdue` : ''}`;

  const catSel = $('categoryFilter');
  const keep = catSel.value;
  catSel.textContent = '';
  const optAll = document.createElement('option');
  optAll.value = ''; optAll.textContent = 'All categories';
  catSel.appendChild(optAll);
  for (const c of categories) {
    const o = document.createElement('option');
    o.value = c.name; o.textContent = c.name;
    catSel.appendChild(o);
  }
  appendManageOption(catSel);
  catSel.value = keep;

  const board = cfg?.view === 'board';
  $('viewTableBtn').classList.toggle('active', !board);
  $('viewBoardBtn').classList.toggle('active', board);
  $('tableView').classList.toggle('hidden', board);
  $('boardView').classList.toggle('hidden', !board);
  $('hideDoneToggle').checked = !!cfg?.hideDone;

  if (board) renderBoard(); else renderTable();
  if (selectedId) renderDrawer();
  renderPomoTask();
}

// ── Table ──
function renderTable() {
  const cols = (cfg?.columns || []).filter(c => c.visible);
  const head = $('tableHead');
  head.textContent = '';

  cols.forEach((col, i) => {
    const th = document.createElement('th');
    th.className = 'sortable';
    th.style.width = `${col.width}px`;
    th.draggable = true;
    th.dataset.key = col.key;
    th.textContent = col.label;
    if (sortKey === col.key) {
      const s = document.createElement('span');
      s.className = 'th-sort';
      s.textContent = sortDir === 1 ? '▲' : '▼';
      th.appendChild(s);
    }
    th.addEventListener('click', () => {
      if (sortKey === col.key) sortDir = -sortDir; else { sortKey = col.key; sortDir = 1; }
      renderTable();
    });
    // Drag a header to reorder columns - the same order the popover shows.
    th.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/col', col.key); });
    th.addEventListener('dragover',  (e) => { e.preventDefault(); th.classList.add('drag-over'); });
    th.addEventListener('dragleave', () => th.classList.remove('drag-over'));
    th.addEventListener('drop', async (e) => {
      e.preventDefault(); th.classList.remove('drag-over');
      const from = e.dataTransfer.getData('text/col');
      if (!from || from === col.key) return;
      await moveColumn(from, col.key);
    });
    head.appendChild(th);
  });

  const actionsTh = document.createElement('th');
  actionsTh.style.width = '58px';
  head.appendChild(actionsTh);

  const body = $('tableBody');
  body.textContent = '';
  const rows = flatten();
  $('tableEmpty').classList.toggle('hidden', rows.length > 0);

  for (const t of rows) {
    const tr = document.createElement('tr');
    tr.className = 'todo-row';
    if (t.done)          tr.classList.add('done');
    if (t.overdue)       tr.classList.add('overdue');
    if (t.parentId)      tr.classList.add('is-sub');
    if (t.id === selectedId) tr.classList.add('selected');
    tr.addEventListener('click', () => selectTask(t.id));

    for (const col of cols) tr.appendChild(cellFor(t, col));

    const td = document.createElement('td');
    const wrap = document.createElement('div');
    wrap.className = 'row-actions';
    if (!t.parentId) {
      const add = document.createElement('button');
      add.className = 'row-btn'; add.title = 'Add sub-task'; add.textContent = '＋';
      add.addEventListener('click', (e) => { e.stopPropagation(); addSubtask(t.id); });
      wrap.appendChild(add);
    }
    const del = document.createElement('button');
    del.className = 'row-btn del'; del.title = 'Delete'; del.textContent = '✕';
    del.addEventListener('click', (e) => { e.stopPropagation(); removeTask(t); });
    wrap.appendChild(del);
    td.appendChild(wrap);
    tr.appendChild(td);

    body.appendChild(tr);
  }
}

function cellFor(t, col) {
  const td = document.createElement('td');
  td.className = `cell-${col.key}`;

  switch (col.key) {
    case 'title': {
      const wrap = document.createElement('div');
      wrap.className = 'cell-title-wrap';

      const box = document.createElement('button');
      box.className = 'todo-check';
      box.title = t.done ? 'Mark as not done' : 'Mark done';
      box.textContent = t.done ? '✓' : '';
      box.addEventListener('click', (e) => { e.stopPropagation(); toggleDone(t); });
      wrap.appendChild(box);

      if (!t.parentId && (t.subtasks?.length)) {
        const tg = document.createElement('button');
        tg.className = 'sub-toggle';
        tg.textContent = collapsed.has(t.id) ? '▶' : '▼';
        tg.title = collapsed.has(t.id) ? 'Show sub-tasks' : 'Hide sub-tasks';
        tg.addEventListener('click', (e) => {
          e.stopPropagation();
          collapsed.has(t.id) ? collapsed.delete(t.id) : collapsed.add(t.id);
          renderTable();
        });
        wrap.appendChild(tg);
      }

      const title = document.createElement('span');
      title.className = 'cell-title';
      title.textContent = t.title;
      title.title = 'Double-click to rename';
      title.addEventListener('dblclick', (e) => { e.stopPropagation(); inlineRename(title, t); });
      wrap.appendChild(title);

      if (!t.parentId && t.subtasks?.length) {
        const c = document.createElement('span');
        c.className = 'sub-count';
        c.textContent = `${t.subtasks.filter(s => s.done).length}/${t.subtasks.length}`;
        wrap.appendChild(c);
      }
      td.appendChild(wrap);
      break;
    }
    case 'status': {
      const sel = document.createElement('select');
      sel.className = 'todo-select';
      sel.style.width = '100%';
      for (const s of statuses) {
        const o = document.createElement('option');
        o.value = s.id; o.textContent = s.name;
        if (s.id === t.status) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('click', (e) => e.stopPropagation());
      sel.addEventListener('change', async () => {
        await call(api.updateTodo, t.id, { status: sel.value });
        reload();
      });
      td.appendChild(sel);
      break;
    }
    case 'dueAt': {
      if (t.dueAt) {
        const chip = document.createElement('span');
        chip.className = `chip${t.overdue ? ' overdue' : ''}`;
        chip.textContent = fmtDue(t.dueAt, t.dueAllDay);
        td.appendChild(chip);
      } else td.textContent = '-';
      break;
    }
    case 'priority': {
      const chip = document.createElement('span');
      chip.className = `chip prio-${t.priority}`;
      chip.textContent = t.priority;
      td.appendChild(chip);
      break;
    }
    case 'category': {
      if (t.category) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = t.category;
        const col2 = catColor(t.category);
        if (col2) { chip.style.background = col2; chip.style.color = 'var(--t-on-orange)'; }
        td.appendChild(chip);
      } else td.textContent = '-';
      break;
    }
    case 'tags': {
      if (t.tags?.length) {
        for (const tag of t.tags) {
          const chip = document.createElement('span');
          chip.className = 'chip';
          chip.textContent = `#${tag}`;
          td.appendChild(chip);
        }
      } else td.textContent = '-';
      break;
    }
    case 'pomo': {
      td.textContent = t.pomoTarget ? `${t.pomoDone}/${t.pomoTarget}` : String(t.pomoDone || 0);
      break;
    }
    case 'notes':     td.textContent = t.notes ? t.notes.slice(0, 140) : '-'; break;
    case 'createdAt': td.textContent = t.createdAt ? fmtDue(t.createdAt, true) : '-'; break;
    case 'updatedAt': td.textContent = t.updatedAt ? fmtDue(t.updatedAt, true) : '-'; break;
    default:          td.textContent = '';
  }
  return td;
}

// ── Board ──
function renderBoard() {
  const wrap = $('boardColumns');
  wrap.textContent = '';

  for (const s of statuses) {
    const col = document.createElement('div');
    col.className = 'board-col';
    col.dataset.status = s.id;

    const header = document.createElement('div');
    header.className = 'board-col-header';
    const dot = document.createElement('span');
    dot.className = 'board-col-dot';
    dot.style.background = s.color || 'var(--t-lo)';
    const name = document.createElement('span');
    name.className = 'board-col-name';
    name.textContent = s.name;
    const count = document.createElement('span');
    count.className = 'board-col-count';
    header.append(dot, name, count);
    col.appendChild(header);

    const body = document.createElement('div');
    body.className = 'board-col-body';

    const inCol = tasks.filter(t => t.status === s.id);
    count.textContent = String(inCol.length);

    for (const t of inCol) body.appendChild(boardCard(t));

    const add = document.createElement('button');
    add.className = 'board-add';
    add.textContent = '+ Add a task';
    add.addEventListener('click', () => quickAddInto(s.id));
    body.appendChild(add);

    // Drop target
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/task');
      if (!id) return;
      // Index from where the pointer landed relative to the existing cards.
      const cards = [...body.querySelectorAll('.board-card')];
      let index = cards.length;
      for (let i = 0; i < cards.length; i++) {
        const r = cards[i].getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) { index = i; break; }
      }
      await call(api.moveTodo, id, s.id, index);
      reload();
    });

    col.appendChild(body);
    wrap.appendChild(col);
  }
}

function boardCard(t) {
  const card = document.createElement('div');
  card.className = 'board-card';
  if (t.done) card.classList.add('done');
  card.draggable = true;
  card.dataset.id = t.id;

  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/task', t.id);
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  card.addEventListener('click', () => selectTask(t.id));

  const title = document.createElement('div');
  title.className = 'board-card-title';
  title.textContent = t.title;
  card.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'board-card-meta';
  if (t.dueAt) {
    const c = document.createElement('span');
    c.className = `chip${t.overdue ? ' overdue' : ''}`;
    c.textContent = fmtDue(t.dueAt, t.dueAllDay);
    meta.appendChild(c);
  }
  if (t.priority !== 'med') {
    const c = document.createElement('span');
    c.className = `chip prio-${t.priority}`;
    c.textContent = t.priority;
    meta.appendChild(c);
  }
  if (t.category) {
    const c = document.createElement('span');
    c.className = 'chip';
    c.textContent = t.category;
    const col = catColor(t.category);
    if (col) { c.style.background = col; c.style.color = 'var(--t-on-orange)'; }
    meta.appendChild(c);
  }
  for (const tag of (t.tags || [])) {
    const c = document.createElement('span');
    c.className = 'chip';
    c.textContent = `#${tag}`;
    meta.appendChild(c);
  }
  if (t.pomoDone) {
    const c = document.createElement('span');
    c.className = 'chip';
    c.textContent = `🍅 ${t.pomoDone}`;
    meta.appendChild(c);
  }
  if (meta.children.length) card.appendChild(meta);

  if (t.subtasks?.length) {
    const sub = document.createElement('div');
    sub.className = 'board-card-sub';
    sub.textContent = `${t.subtasks.filter(s => s.done).length}/${t.subtasks.length} sub-tasks`;
    card.appendChild(sub);
  }
  return card;
}

// ─── Mutations ────────────────────────────────────────────────────────────────

function findTask(id) {
  for (const t of tasks) {
    if (t.id === id) return t;
    for (const s of (t.subtasks || [])) if (s.id === id) return s;
  }
  return null;
}

async function toggleDone(t) {
  const doneCol = statuses.find(s => s.isDone);
  const openCol = statuses.find(s => !s.isDone);
  if (!doneCol || !openCol) { toast('Add a column marked "counts as done" first', 'err'); return; }
  await call(api.updateTodo, t.id, { status: t.done ? openCol.id : doneCol.id });
  reload();
}

async function removeTask(t) {
  const n = t.subtasks?.length || 0;
  if (n && !confirm(`Delete "${t.title}" and its ${n} sub-task${n === 1 ? '' : 's'}?`)) return;
  await call(api.deleteTodo, t.id);
  if (selectedId === t.id) closeDrawer();
  reload();
}

async function addSubtask(parentId) {
  const parent = findTask(parentId);
  const title = await askText({
    title: 'Add sub-task',
    placeholder: 'What needs doing?',
    hint: parent ? `Under "${parent.title}"` : '',
  });
  if (!title) return;
  await call(api.createTodo, { title, parentId });
  collapsed.delete(parentId);
  reload();
}

async function quickAddInto(statusId) {
  const col = statuses.find(s => s.id === statusId);
  const title = await askText({
    title: col ? `Add to "${col.name}"` : 'Add task',
    placeholder: 'Email Sam tomorrow !high #work',
    hint: 'Shortcuts: !high / !low, #tag, @category, "tomorrow"',
  });
  if (!title) return;
  const parsed = parseQuickAdd(title);
  await call(api.createTodo, { ...parsed, status: statusId });
  reload();
}

function inlineRename(span, t) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = t.title;
  input.maxLength = 200;
  input.className = 'todo-input';
  input.style.width = '100%';
  span.replaceWith(input);
  input.focus();
  input.select();

  const commit = async (save) => {
    const v = input.value.trim();
    input.replaceWith(span);
    if (save && v && v !== t.title) {
      await call(api.updateTodo, t.id, { title: v });
      reload();
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); commit(true); }
    if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

// ─── Drawer ───────────────────────────────────────────────────────────────────

function selectTask(id) {
  selectedId = id;
  $('detailDrawer').classList.remove('hidden');
  renderDrawer();
  if (cfg?.view !== 'board') renderTable();
  renderPomoTask();
}

function closeDrawer() {
  selectedId = null;
  $('detailDrawer').classList.add('hidden');
  if (cfg?.view !== 'board') renderTable();
  renderPomoTask();
}

function field(labelText, control) {
  const l = document.createElement('label');
  l.className = 'field';
  const s = document.createElement('span');
  s.textContent = labelText;
  l.append(s, control);
  return l;
}

function renderDrawer() {
  const t = findTask(selectedId);
  const body = $('drawerBody');
  body.textContent = '';
  if (!t) { closeDrawer(); return; }

  $('drawerTitle').textContent = t.parentId ? 'Sub-task' : 'Task';

  const title = document.createElement('input');
  title.type = 'text'; title.maxLength = 200; title.value = t.title;
  title.addEventListener('change', () => save({ title: title.value }));
  body.appendChild(field('Title', title));

  const notes = document.createElement('textarea');
  notes.maxLength = 5000; notes.value = t.notes || '';
  notes.placeholder = 'Description…';
  notes.addEventListener('change', () => save({ notes: notes.value }));
  body.appendChild(field('Description', notes));

  const status = document.createElement('select');
  for (const s of statuses) {
    const o = document.createElement('option');
    o.value = s.id; o.textContent = s.name;
    if (s.id === t.status) o.selected = true;
    status.appendChild(o);
  }
  status.addEventListener('change', () => save({ status: status.value }));
  body.appendChild(field('Status', status));

  const due = document.createElement('input');
  due.type = 'date';
  due.value = t.dueAt ? toDateInput(t.dueAt) : '';
  due.addEventListener('change', () => save({ dueAt: due.value ? fromDateInput(due.value) : null, dueAllDay: true }));
  body.appendChild(field('Due date', due));

  const prio = document.createElement('select');
  for (const p of ['low', 'med', 'high']) {
    const o = document.createElement('option');
    o.value = p; o.textContent = p;
    if (p === t.priority) o.selected = true;
    prio.appendChild(o);
  }
  prio.addEventListener('change', () => save({ priority: prio.value }));
  body.appendChild(field('Priority', prio));

  const cat = document.createElement('select');
  const none = document.createElement('option');
  none.value = ''; none.textContent = '-';
  cat.appendChild(none);
  for (const c of categories) {
    const o = document.createElement('option');
    o.value = c.name; o.textContent = c.name;
    if (c.name === t.category) o.selected = true;
    cat.appendChild(o);
  }
  // The category editor lives in the Manage modal, which is not where anyone looks
  // for it. Put a door to it inside the picker itself.
  appendManageOption(cat);

  cat.addEventListener('change', () => {
    if (isManageOption(cat)) {
      cat.value = t.category || '';          // restore, don't clear the category
      openManage('categories');
      return;
    }
    save({ category: cat.value || null });
  });
  body.appendChild(field('Category', cat));

  const tags = document.createElement('input');
  tags.type = 'text'; tags.maxLength = 160;
  tags.value = (t.tags || []).join(', ');
  tags.placeholder = 'comma, separated';
  tags.addEventListener('change', () => save({ tags: tags.value }));
  body.appendChild(field('Tags', tags));

  const target = document.createElement('input');
  target.type = 'number'; target.min = '0'; target.max = '99';
  target.value = t.pomoTarget ?? '';
  target.placeholder = '-';
  target.addEventListener('change', () => save({ pomoTarget: target.value ? parseInt(target.value, 10) : null }));
  body.appendChild(field(`Pomodoros (${t.pomoDone} done)`, target));

  if (!t.parentId) {
    const list = document.createElement('div');
    list.className = 'subtask-list';
    for (const s of (t.subtasks || [])) {
      const row = document.createElement('div');
      row.className = `subtask-row${s.done ? ' done' : ''}`;
      const box = document.createElement('button');
      box.className = 'todo-check';
      box.textContent = s.done ? '✓' : '';
      box.addEventListener('click', () => toggleDone(s));
      const label = document.createElement('span');
      label.textContent = s.title;
      const del = document.createElement('button');
      del.className = 'row-btn del'; del.textContent = '✕'; del.style.color = 'var(--t-lo)';
      del.addEventListener('click', () => removeTask(s));
      row.append(box, label, del);
      list.appendChild(row);
    }
    const addBtn = document.createElement('button');
    addBtn.className = 'todo-btn';
    addBtn.textContent = '+ Add sub-task';
    addBtn.addEventListener('click', () => addSubtask(t.id));
    list.appendChild(addBtn);
    body.appendChild(field('Sub-tasks', list));
  }

  async function save(patch) {
    await call(api.updateTodo, t.id, patch);
    reload();
  }
}

// ─── Columns popover ──────────────────────────────────────────────────────────

async function moveColumn(fromKey, toKey) {
  const cols = [...(cfg.columns || [])];
  const from = cols.findIndex(c => c.key === fromKey);
  const to   = cols.findIndex(c => c.key === toKey);
  if (from < 0 || to < 0) return;
  const [moved] = cols.splice(from, 1);
  cols.splice(to, 0, moved);
  if (await saveCfg({ columns: cols })) render();
}

function renderColumnsPopover() {
  const list = $('columnsList');
  list.textContent = '';

  (cfg.columns || []).forEach((col) => {
    const row = document.createElement('div');
    row.className = 'col-row';
    row.draggable = true;

    const grip = document.createElement('span');
    grip.className = 'col-grip';
    grip.textContent = '⠿';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = col.visible;
    box.disabled = !!col.fixed;
    box.title = col.fixed ? 'The task column can\'t be hidden' : 'Show this column';
    box.addEventListener('change', async () => {
      const cols = cfg.columns.map(c => c.key === col.key ? { ...c, visible: box.checked } : c);
      if (await saveCfg({ columns: cols })) render();
    });

    const name = document.createElement('input');
    name.type = 'text';
    name.value = col.label;
    name.maxLength = 24;
    name.title = 'Rename this header';
    name.addEventListener('change', async () => {
      const cols = cfg.columns.map(c => c.key === col.key ? { ...c, label: name.value } : c);
      if (await saveCfg({ columns: cols })) render();
    });

    row.append(grip, box, name);

    row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/col', col.key); row.classList.add('dragging'); });
    row.addEventListener('dragend',   () => row.classList.remove('dragging'));
    row.addEventListener('dragover',  (e) => { e.preventDefault(); row.classList.add('drag-over'); });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', async (e) => {
      e.preventDefault(); row.classList.remove('drag-over');
      const from = e.dataTransfer.getData('text/col');
      if (from && from !== col.key) { await moveColumn(from, col.key); renderColumnsPopover(); }
    });

    list.appendChild(row);
  });
}

// ─── Manage modal (statuses + categories) ─────────────────────────────────────

/**
 * Open the Manage modal, optionally scrolled to one section.
 * @param {'columns'|'categories'} [section]
 */
function openManage(section = 'columns') {
  renderManage();
  openModal('manageModal');
  const anchor = section === 'categories' ? $('categoryList') : $('statusList');
  // Let the modal lay out before scrolling, or scrollIntoView measures zero height.
  requestAnimationFrame(() => {
    anchor?.closest('.manage-section')?.scrollIntoView({ block: 'start' });
    if (section === 'categories') $('newCategoryName')?.focus();
  });
}

function renderManage() {
  const sl = $('statusList');
  sl.textContent = '';
  statuses.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'manage-row';

    const color = document.createElement('input');
    color.type = 'color'; color.className = 'color-input';
    color.value = s.color || '#6a6058';
    color.addEventListener('change', async () => { await call(api.updateTodoStatus, s.id, { color: color.value }); reload(); renderManage(); });

    const name = document.createElement('input');
    name.type = 'text'; name.value = s.name; name.maxLength = 40;
    name.addEventListener('change', async () => { await call(api.updateTodoStatus, s.id, { name: name.value }); reload(); renderManage(); });

    const doneLbl = document.createElement('label');
    doneLbl.className = 'todo-check-label';
    doneLbl.title = 'Tasks in this column count as finished';
    const doneBox = document.createElement('input');
    doneBox.type = 'checkbox'; doneBox.checked = s.isDone;
    doneBox.addEventListener('change', async () => { await call(api.updateTodoStatus, s.id, { isDone: doneBox.checked }); reload(); renderManage(); });
    doneLbl.append(doneBox, document.createTextNode('done'));

    const up = document.createElement('button');
    up.className = 'row-btn'; up.style.color = 'var(--t-lo)'; up.textContent = '↑'; up.title = 'Move left';
    up.addEventListener('click', async () => {
      if (i === 0) return;
      const ids = statuses.map(x => x.id);
      [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
      await call(api.reorderTodoStatuses, ids); await reload(); renderManage();
    });
    const down = document.createElement('button');
    down.className = 'row-btn'; down.style.color = 'var(--t-lo)'; down.textContent = '↓'; down.title = 'Move right';
    down.addEventListener('click', async () => {
      if (i >= statuses.length - 1) return;
      const ids = statuses.map(x => x.id);
      [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]];
      await call(api.reorderTodoStatuses, ids); await reload(); renderManage();
    });

    const del = document.createElement('button');
    del.className = 'row-btn del'; del.textContent = '✕'; del.style.color = 'var(--t-lo)';
    del.title = 'Delete column (its tasks move to the first remaining one)';
    del.addEventListener('click', async () => {
      if (!confirm(`Delete the "${s.name}" column? Its tasks move to another column - they are not deleted.`)) return;
      await call(api.deleteTodoStatus, s.id, null);
      await reload(); renderManage();
    });

    row.append(color, name, doneLbl, up, down, del);
    sl.appendChild(row);
  });

  const cl = $('categoryList');
  cl.textContent = '';
  for (const c of categories) {
    const row = document.createElement('div');
    row.className = 'manage-row';

    const color = document.createElement('input');
    color.type = 'color'; color.className = 'color-input';
    color.value = c.color || '#4f9d5c';
    color.addEventListener('change', async () => { await call(api.updateTodoCategory, c.id, { color: color.value }); reload(); renderManage(); });

    const name = document.createElement('input');
    name.type = 'text'; name.value = c.name; name.maxLength = 40;
    name.addEventListener('change', async () => { await call(api.updateTodoCategory, c.id, { name: name.value }); reload(); renderManage(); });

    const del = document.createElement('button');
    del.className = 'row-btn del'; del.textContent = '✕'; del.style.color = 'var(--t-lo)';
    del.title = 'Delete category (its tasks stay, just uncategorised)';
    del.addEventListener('click', async () => {
      if (!confirm(`Delete the "${c.name}" category? Tasks keep existing, just uncategorised.`)) return;
      await call(api.deleteTodoCategory, c.id);
      await reload(); renderManage();
    });

    row.append(color, name, del);
    cl.appendChild(row);
  }
}

// ─── Pomodoro ─────────────────────────────────────────────────────────────────
//
// Deadline-based rather than decrement-based: we store the wall-clock time the
// interval ends and derive the remaining seconds each tick. A setInterval that
// subtracts one per second drifts, and drifts badly if the machine sleeps mid-session.

const pomo = {
  phase:    'idle',   // idle | work | break | long
  endsAt:   0,
  paused:   true,
  leftMs:   0,        // remaining when paused
  round:    0,        // completed work intervals in the current cycle
  ticker:   null,
};

function phaseMinutes(phase) {
  if (phase === 'break') return cfg?.breakMin ?? 5;
  if (phase === 'long')  return cfg?.longBreakMin ?? 15;
  return cfg?.workMin ?? 25;
}

function pomoRemaining() {
  if (pomo.phase === 'idle') return (cfg?.workMin ?? 25) * 60000;
  return pomo.paused ? pomo.leftMs : Math.max(0, pomo.endsAt - Date.now());
}

function renderPomo() {
  const ms   = pomoRemaining();
  const secs = Math.ceil(ms / 1000);
  $('pomoClock').textContent =
    `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;

  const bar = $('pomoBar');
  bar.dataset.phase = pomo.phase;
  $('pomoPhase').textContent =
    pomo.phase === 'idle'  ? 'Ready'
    : pomo.phase === 'work' ? (pomo.paused ? 'Focus · paused' : 'Focus')
    : pomo.phase === 'break' ? (pomo.paused ? 'Break · paused' : 'Break')
    : (pomo.paused ? 'Long break · paused' : 'Long break');

  const total = phaseMinutes(pomo.phase) * 60000;
  $('pomoProgress').style.width = pomo.phase === 'idle' ? '0%' : `${Math.min(100, ((total - ms) / total) * 100)}%`;
  $('pomoStartBtn').textContent = pomo.paused ? 'Start' : 'Pause';

  const rounds = $('pomoRounds');
  rounds.textContent = '';
  const n = cfg?.roundsUntilLongBreak ?? 4;
  for (let i = 0; i < n; i++) {
    const d = document.createElement('span');
    d.className = `pomo-round${i < pomo.round ? ' filled' : ''}`;
    rounds.appendChild(d);
  }
}

function renderPomoTask() {
  const t = findTask(selectedId);
  $('pomoTask').textContent = t
    ? `${t.title}${t.pomoDone ? `  ·  🍅 ${t.pomoDone}${t.pomoTarget ? `/${t.pomoTarget}` : ''}` : ''}`
    : 'No task selected - pick one to count pomodoros against it';
}

function startTicker() {
  if (pomo.ticker) return;
  pomo.ticker = setInterval(() => {
    if (pomo.paused) return;
    if (pomoRemaining() <= 0) advancePhase(true);
    renderPomo();
  }, 500);
}

function pomoToggle() {
  if (pomo.phase === 'idle') { beginPhase('work'); return; }
  if (pomo.paused) {
    pomo.endsAt = Date.now() + pomo.leftMs;
    pomo.paused = false;
  } else {
    pomo.leftMs = pomoRemaining();
    pomo.paused = true;
  }
  renderPomo();
}

function beginPhase(phase, autoStart = true) {
  pomo.phase  = phase;
  pomo.leftMs = phaseMinutes(phase) * 60000;
  pomo.endsAt = Date.now() + pomo.leftMs;
  pomo.paused = !autoStart;
  startTicker();
  renderPomo();
}

/** @param {boolean} completed - true when the interval ran out, false on Skip. */
async function advancePhase(completed) {
  const finishedWork = pomo.phase === 'work';

  if (finishedWork && completed) {
    pomo.round += 1;
    if (selectedId) {
      await call(api.todoPomoDone, selectedId);
      await reload();
    }
    notifyDone('Work interval finished');
  } else if (!finishedWork && completed && pomo.phase !== 'idle') {
    notifyDone('Break over');
  }

  const perCycle = cfg?.roundsUntilLongBreak ?? 4;
  if (finishedWork) {
    const long = pomo.round > 0 && pomo.round % perCycle === 0;
    beginPhase(long ? 'long' : 'break', !!cfg?.autoStartBreaks);
  } else {
    if (pomo.round >= perCycle) pomo.round = 0;
    beginPhase('work', !!cfg?.autoStartWork);
  }
}

function notifyDone(text) {
  toast(text);
  try {
    // The window is often behind something else; a flash is the honest signal.
    if (document.hidden) document.title = `⏰ ${text} - Friday To-Do`;
    setTimeout(() => { document.title = 'Friday - To-Do'; }, 8000);
  } catch {}
}

function pomoReset() {
  if (pomo.phase === 'idle') return;
  pomo.leftMs = phaseMinutes(pomo.phase) * 60000;
  pomo.endsAt = Date.now() + pomo.leftMs;
  pomo.paused = true;
  renderPomo();
}

// ─── Wiring ───────────────────────────────────────────────────────────────────

function positionPopover(pop, anchor) {
  const r = anchor.getBoundingClientRect();
  pop.style.top  = `${r.bottom + 6}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 268))}px`;
}

function openModal(id) {
  $('modalBackdrop').classList.remove('hidden');
  $(id).classList.remove('hidden');
}
function closeModals() {
  $('modalBackdrop').classList.add('hidden');
  $('manageModal').classList.add('hidden');
  $('timerModal').classList.add('hidden');
  $('columnsPopover').classList.add('hidden');
  _closeAsk(null);
}

// ─── Text prompt ──────────────────────────────────────────────────────────────
// Electron does not implement window.prompt(). It returns null without rendering
// anything, so any code calling it fails silently. This is the replacement.

let _askResolve = null;

function _closeAsk(value) {
  const modal = $('askModal');
  if (!modal || modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  $('modalBackdrop').classList.add('hidden');
  const resolve = _askResolve;
  _askResolve = null;
  if (resolve) resolve(value);
}

/**
 * Ask for one line of text.
 * @returns {Promise<string|null>} trimmed text, or null if cancelled
 */
function askText({ title = 'Add', okLabel = 'Add', placeholder = '', hint = '', value = '' } = {}) {
  // A second call while one is open cancels the first, so a resolver is never orphaned.
  if (_askResolve) _closeAsk(null);

  $('askTitle').textContent = title;
  $('askOk').textContent    = okLabel;
  $('askHint').textContent  = hint;
  $('askHint').classList.toggle('hidden', !hint);

  const input = $('askInput');
  input.value = value;
  input.placeholder = placeholder;

  $('modalBackdrop').classList.remove('hidden');
  $('askModal').classList.remove('hidden');
  input.focus();
  input.select();

  return new Promise((resolve) => { _askResolve = resolve; });
}

function wire() {
  $('viewTableBtn').addEventListener('click', async () => { if (await saveCfg({ view: 'table' })) render(); });
  $('viewBoardBtn').addEventListener('click', async () => { if (await saveCfg({ view: 'board' })) render(); });

  let searchTimer = null;
  $('searchInput').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(reload, 180);
  });
  $('categoryFilter').addEventListener('change', (e) => {
    if (isManageOption(e.target)) {
      e.target.value = '';               // it's a door, not a filter
      openManage('categories');
      return;
    }
    reload();
  });
  $('hideDoneToggle').addEventListener('change', async (e) => {
    if (await saveCfg({ hideDone: e.target.checked })) reload();
  });

  const add = async () => {
    const raw = $('quickAddInput').value;
    if (!raw.trim()) return;
    $('quickAddInput').value = '';
    await call(api.createTodo, parseQuickAdd(raw));
    reload();
  };
  $('quickAddBtn').addEventListener('click', add);
  $('quickAddInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });

  $('columnsBtn').addEventListener('click', (e) => {
    const pop = $('columnsPopover');
    const show = pop.classList.contains('hidden');
    closeModals();
    if (show) { renderColumnsPopover(); positionPopover(pop, e.currentTarget); pop.classList.remove('hidden'); }
  });
  document.addEventListener('click', (e) => {
    const pop = $('columnsPopover');
    if (!pop.classList.contains('hidden') && !pop.contains(e.target) && e.target !== $('columnsBtn')) {
      pop.classList.add('hidden');
    }
  });

  $('manageBtn').addEventListener('click', () => openManage('columns'));
  $('manageClose').addEventListener('click', closeModals);
  $('modalBackdrop').addEventListener('click', closeModals);
  $('drawerClose').addEventListener('click', closeDrawer);

  $('addStatusBtn').addEventListener('click', async () => {
    const name = $('newStatusName').value.trim();
    if (!name) return;
    await call(api.createTodoStatus, { name, color: $('newStatusColor').value, isDone: $('newStatusDone').checked });
    $('newStatusName').value = ''; $('newStatusDone').checked = false;
    await reload(); renderManage();
  });
  $('addCategoryBtn').addEventListener('click', async () => {
    const name = $('newCategoryName').value.trim();
    if (!name) return;
    await call(api.createTodoCategory, { name, color: $('newCategoryColor').value });
    $('newCategoryName').value = '';
    await reload(); renderManage();
  });
  $('clearDoneBtn').addEventListener('click', async () => {
    if (!confirm(`Delete every task in a "done" column? This can't be undone.`)) return;
    const res = await call(api.clearCompletedTodos);
    if (res) toast(`Cleared ${res.deleted} task${res.deleted === 1 ? '' : 's'}`);
    await reload(); renderManage();
  });

  $('settingsBtn').addEventListener('click', () => {
    $('cfgWork').value       = cfg.workMin;
    $('cfgBreak').value      = cfg.breakMin;
    $('cfgLongBreak').value  = cfg.longBreakMin;
    $('cfgRounds').value     = cfg.roundsUntilLongBreak;
    $('cfgAutoBreak').checked = !!cfg.autoStartBreaks;
    $('cfgAutoWork').checked  = !!cfg.autoStartWork;
    openModal('timerModal');
  });
  $('timerClose').addEventListener('click', closeModals);
  $('timerSave').addEventListener('click', async () => {
    const okSaved = await saveCfg({
      workMin:              $('cfgWork').value,
      breakMin:             $('cfgBreak').value,
      longBreakMin:         $('cfgLongBreak').value,
      roundsUntilLongBreak: $('cfgRounds').value,
      autoStartBreaks:      $('cfgAutoBreak').checked,
      autoStartWork:        $('cfgAutoWork').checked,
    });
    if (okSaved) {
      // A length change only applies to the interval you start next - silently
      // re-timing a running interval would be worse than doing nothing.
      if (pomo.phase === 'idle') renderPomo();
      toast('Timer settings saved');
      closeModals();
    }
  });

  $('pomoStartBtn').addEventListener('click', pomoToggle);
  $('pomoResetBtn').addEventListener('click', pomoReset);
  $('pomoSkipBtn').addEventListener('click',  () => advancePhase(false));

  // ── Text prompt ──
  const askCommit = () => _closeAsk($('askInput').value.trim() || null);
  $('askOk').addEventListener('click', askCommit);
  $('askCancel').addEventListener('click', () => _closeAsk(null));
  $('askClose').addEventListener('click',  () => _closeAsk(null));
  $('askInput').addEventListener('keydown', (e) => {
    // Stop these reaching the global handler below, which would close the drawer too.
    if (e.key === 'Enter')  { e.preventDefault(); e.stopPropagation(); askCommit(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); _closeAsk(null); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModals(); if (!$('detailDrawer').classList.contains('hidden')) closeDrawer(); }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (typing) return;
    if (e.key === '/')                    { e.preventDefault(); $('searchInput').focus(); }
    if (e.key === 'n' || e.key === 'N')   { e.preventDefault(); $('quickAddInput').focus(); }
    if (e.code === 'Space' && e.ctrlKey)  { e.preventDefault(); pomoToggle(); }
  });

  const unsub = api.onTodoChanged?.(() => reload());
  if (typeof unsub === 'function') window.addEventListener('beforeunload', unsub);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

(async () => {
  const res = await call(api.getTodoConfig);
  cfg = res?.config || {};
  wire();
  await reload();
  renderPomo();
  startTicker();
  $('quickAddInput').focus();
})();
