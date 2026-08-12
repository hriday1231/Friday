/**
 * IPC surface for the To-Do window.
 *
 * House convention: every handler returns { success: true, ...data } or
 * { success: false, error }. Nothing throws across the bridge - a ValidationError
 * carries a message written for the user, so it is passed through verbatim.
 */

'use strict';

const { getConfig, saveConfig } = require('./config');

const CHANNELS = [
  'todo-board', 'todo-create', 'todo-update', 'todo-delete', 'todo-move',
  'todo-clear-completed', 'todo-pomo-done',
  'todo-status-create', 'todo-status-update', 'todo-status-delete', 'todo-status-reorder',
  'todo-category-create', 'todo-category-update', 'todo-category-delete',
  'todo-get-config', 'todo-save-config',
];

function registerTodoIpc({ ipcMain, getStore, getDb, notify }) {
  const withStore = (fn) => (_event, arg = {}) => {
    const store = getStore();
    if (!store) return { success: false, error: 'The to-do store is not ready yet.' };
    try {
      return fn(store, arg || {});
    } catch (err) {
      if (err.name !== 'ValidationError') console.error('[todo] ipc failed:', err.message);
      return { success: false, error: err.message };
    }
  };

  // Everything the window needs to paint itself, in one round trip.
  ipcMain.handle('todo-board', withStore((s, { filters } = {}) => ({
    success: true, ...s.board(filters || {}),
  })));

  // ── Tasks ──
  ipcMain.handle('todo-create', withStore((s, { todo } = {}) => {
    const created = s.create(todo || {});
    notify('created');
    return { success: true, todo: created };
  }));

  ipcMain.handle('todo-update', withStore((s, { id, patch } = {}) => {
    const updated = s.update(id, patch || {});
    if (!updated) return { success: false, error: 'That to-do no longer exists.' };
    notify('updated');
    return { success: true, todo: updated };
  }));

  ipcMain.handle('todo-move', withStore((s, { id, statusId, index } = {}) => {
    const moved = s.move(id, statusId, index);
    if (!moved) return { success: false, error: 'That to-do no longer exists.' };
    notify('moved');
    return { success: true, todo: moved };
  }));

  ipcMain.handle('todo-delete', withStore((s, { id } = {}) => {
    const removed = s.remove(id);
    if (removed) notify('deleted');
    return removed ? { success: true } : { success: false, error: 'That to-do no longer exists.' };
  }));

  ipcMain.handle('todo-clear-completed', withStore((s) => {
    const deleted = s.clearCompleted();
    notify('bulk');
    return { success: true, deleted };
  }));

  ipcMain.handle('todo-pomo-done', withStore((s, { id } = {}) => {
    const t = s.incrementPomo(id);
    if (t) notify('pomo');
    return { success: !!t, todo: t };
  }));

  // ── Board columns (statuses) ──
  ipcMain.handle('todo-status-create',  withStore((s, a) => { const r = s.createStatus(a); notify('status'); return { success: true, status: r }; }));
  ipcMain.handle('todo-status-update',  withStore((s, { id, patch } = {}) => { const r = s.updateStatus(id, patch || {}); notify('status'); return { success: !!r, status: r }; }));
  ipcMain.handle('todo-status-delete',  withStore((s, { id, reassignTo } = {}) => { const r = s.deleteStatus(id, reassignTo); notify('status'); return { success: r }; }));
  ipcMain.handle('todo-status-reorder', withStore((s, { ids } = {}) => { const r = s.reorderStatuses(ids || []); notify('status'); return { success: true, statuses: r }; }));

  // ── Categories ──
  ipcMain.handle('todo-category-create', withStore((s, a) => { const r = s.createCategory(a); notify('category'); return { success: true, category: r }; }));
  ipcMain.handle('todo-category-update', withStore((s, { id, patch } = {}) => { const r = s.updateCategory(id, patch || {}); notify('category'); return { success: !!r, category: r }; }));
  ipcMain.handle('todo-category-delete', withStore((s, { id } = {}) => { const r = s.deleteCategory(id); notify('category'); return { success: r }; }));

  // ── Config (Pomodoro + view) ──
  ipcMain.handle('todo-get-config', () => {
    try { return { success: true, config: getConfig(getDb()) }; }
    catch (err) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('todo-save-config', (_event, cfg = {}) => {
    try { return { success: true, config: saveConfig(getDb(), cfg || {}) }; }
    catch (err) {
      console.error('[todo] save-config failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  /** Teardown, for hosts that hot-reload the feature. */
  return () => { for (const c of CHANNELS) { try { ipcMain.removeHandler(c); } catch {} } };
}

module.exports = { registerTodoIpc, CHANNELS };
