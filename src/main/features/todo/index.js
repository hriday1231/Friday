/**
 * To-Do feature module - the only surface the host application imports.
 *
 * Data layer plus IPC for a standalone To-Do window. Deliberately has NO agent
 * integration: no LLM tools, no system-prompt injection, no message parts. An
 * earlier revision had all three, and the tool declarations alone added ~885
 * tokens to every chat request while a "show_plan" meta-tool derailed the local
 * model on exactly the multi-step requests it was meant to help with. The to-do
 * list is a manual app; chat pays nothing for its existence.
 *
 * See README.md for the host contract.
 */

'use strict';

const { createDbHandle }  = require('./db');
const TodoStore           = require('./TodoStore');
const { registerTodoIpc } = require('./ipc');

let _db    = null;
let _store = null;
let _emit  = () => {};
let _rev   = 0;

/** Tell any open window the data changed. Never throws. */
function notify(reason) {
  _rev += 1;
  try { _emit('todo-changed', { reason, revision: _rev }); }
  catch (err) { console.error('[todo] notify failed:', err.message); }
}

const api = {
  /**
   * Wire the feature into a host app. Call once, after the host's store is ready.
   *
   * @param {object}   opts
   * @param {object}   opts.db       five-function adapter: exec, all, get, run, flush
   * @param {object}   opts.ipcMain  Electron ipcMain
   * @param {Function} opts.emit     (channel, payload) => void - must reach ALL windows
   */
  init({ db, ipcMain, emit } = {}) {
    if (_store) return api;

    _db    = createDbHandle(db);
    _store = new TodoStore(_db);
    _emit  = typeof emit === 'function' ? emit : () => {};

    // createDbHandle applies the schema lazily, on first query. Force it now so
    // the migration runs at boot rather than the first time a window opens -
    // a schema upgrade that fails should fail where the log is being read, not
    // three clicks into the UI.
    try { _db.get('SELECT 1'); }
    catch (err) { console.error('[todo] schema init failed:', err.message); }

    registerTodoIpc({
      ipcMain,
      getStore: () => _store,
      getDb:    () => _db,
      notify,
    });

    return api;
  },

  /** Exposed for the host's own use (e.g. a badge count in the tray). */
  stats() {
    try { return _store ? _store.stats() : null; }
    catch { return null; }
  },
};

module.exports = api;
