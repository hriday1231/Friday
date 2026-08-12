# To-Do feature module

A standalone To-Do app that happens to live inside Friday. Self-contained: copy
`src/main/features/todo/` plus `src/renderer/todo.html`, `todo.js` and
`styles/todo.css` into another Electron app and wire the four seams below.

**It has no connection to the chat agent, on purpose.** No LLM tools, no
system-prompt injection, no message parts - the To-Do app costs chat exactly zero
tokens. An earlier revision integrated all three; the tool declarations alone
added ~885 tokens to every request, and a `show_plan` meta-tool whose description
triggered on "three or more tool calls" derailed the local model on precisely the
multi-step requests it was meant to help with. Don't reintroduce that.

## What it does

- **Tasks** with title, description, status, priority, due date, category and tags
- **Sub-tasks**, one level deep (a sub-task's parent is always a top-level task)
- **User-defined statuses** - these are the board columns, so the columns *are*
  the workflow. Add, rename, recolour, reorder, delete (tasks get reassigned, not
  deleted). One flag, `is_done`, is the app's only built-in semantics.
- **Categories** with colours, renameable (the rename cascades to tasks)
- **Two views** over one dataset: a table with configurable columns (show/hide,
  drag to reorder, rename headers, click to sort) and a drag-and-drop board
- **Pomodoro timer** linked to the selected task; finishing a work interval
  increments that task's count. Work/short break/long break/rounds are settable.

## Host contract - 4 seams

### 1. Initialise

Call once, after your database is ready:

```js
require('./features/todo').init({
  ipcMain,
  db: { exec, all, get, run, flush },
  emit: (channel, payload) => /* send to ALL renderer windows */,
});
```

| fn | must do | Friday's mapping |
|---|---|---|
| `exec(sql)` | execute a **multi-statement** SQL string | `store._db.run(sql)` |
| `all(sql, params)` | → array of row objects | `store._all` |
| `get(sql, params)` | → first row or `null` | `store._get` |
| `run(sql, params)` | one statement, then schedule a durable save | `store._run` |
| `flush()` | force an immediate durable write | `store._flushNow` |

`exec` must **not** be a `prepare()`-based helper: sql.js `prepare()` compiles
only the first statement and silently discards the rest, so the schema would come
out half-built with no error anywhere.

### 2. A window

Create a normal framed window loading `renderer/todo.html` with your preload
attached. In Friday that's `createTodoWindow()` in `main.js`, opened by the
`open-todo` IPC channel.

### 3. Preload

Expose the `todo-*` invoke channels (see `ipc.js` → `CHANNELS`) plus
`onTodoChanged`, which must return its own `removeListener` closure.

### 4. Stylesheet

`todo.html` links `styles/main.css` for the `:root` design tokens and
`styles/todo.css` for everything else. If you port this without `main.css`,
copy the `:root` block.

## Design notes

- **Status is a row, not an enum.** Nothing outside `schema.js` may hardcode
  `'pending'`/`'completed'`; use the `is_done` flag. The seeded default ids match
  the legacy fixed vocabulary so old rows migrate with no rewrite.
- **`completed_at` tracks `is_done`, not a status name** - including when a column
  is deleted and its tasks are reassigned.
- **Ordering is `sort_order ASC, seq ASC`.** `sort_order` is user-controlled by
  drag; `seq` is the monotonic tiebreak so equal values stay stable.
- **Deleting a category leaves its tasks uncategorised**; deleting a task takes
  its sub-tasks with it.
- **No `FOREIGN KEY` on anything.** `PRAGMA foreign_keys = ON` is live in the host
  and deleting a chat session must never cascade into the to-do list.
- **No innerHTML in `todo.js`.** Every task field is user-authored; a grep for
  `innerHTML` should return only the comment saying so.

## What this module deliberately does not do

No LLM tools. No system-prompt injection. No timers that run when the window is
closed, no notifications, no scheduling - the Pomodoro clock is renderer-local and
stops with the window.
