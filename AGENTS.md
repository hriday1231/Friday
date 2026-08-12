# Friday - Project Instructions

## What This Is
An Electron desktop chat assistant (Windows-first). Fast conversational UI with memory, RAG, web search, Google Calendar, whisper STT, and lightweight browser automation for opening/searching websites.

Stack: Electron + Node.js main process, vanilla JS renderer (no framework), sql.js SQLite.

---

## File Layout

```
src/main/          - Node.js / Electron main process
  main.js          - App entry, all IPC handlers, provider/tool wiring
  agents/
    AgentRuntime.js     - Event-driven tool-use loop (single chat entry point)
    SessionContext.js   - Per-session abort + permission + cost tracker
    PermissionManager.js - Policy object; main.js uses forChat() (READ_ONLY) so destructive tools prompt
    CostTracker.js       - Token usage tracker
  providers/
    OllamaProvider.js, GroqProvider.js, GeminiProvider.js, OpenRouterProvider.js
    ProviderManager.js - routes model → provider
    All must implement: initMessages, appendUser, appendHistoryAssistant,
      appendResponse, appendToolResults, chatWithTools, fetchModels
  config/systemPrompt.js  - Builds system prompt (memory + episodes + fewShots)
  store/PersistentStore.js - SQLite via sql.js (sync queries, debounced disk flush)
  memory/MemoryEmbedder.js - Embedding service for semantic memory retrieval
  tools/builtin/          - One file per tool: { declaration, handler } exports
    braveSearch.js, fetchPage.js, openUrl.js, openBookmark.js,
    searchSite.js, launchApp.js,
    addEvent.js, editEvent.js, deleteEvent.js, getCalendarSummary.js
  settings/SettingsStore.js - electron-store wrapper for API keys, hotkeys, etc.
  types/parts.js   - Typed parts (text, reasoning, tool, todo, step markers) for event stream
  features/todo/   - Self-contained To-Do feature (schema, store, tools, IPC, prompt
                     block, live checklist). Host wires 8 seams - see its README.md.

src/renderer/      - Browser-context renderer process
  components/
    ChatInterface.js - Main chat UI (messages, streaming parts, permission banner)
    ModelSelector.js - Model picker with slots (chat/vision/cloud)
  renderer.js      - Session list, suggestions, memory proposals, wake word
  index.html / styles/main.css / settings.html / settings.js
  rag/             - BM25 + embedding-based document indexing for chat

src/preload.js     - contextBridge IPC bridge (renderer ↔ main)
```

---

## Architecture

### IPC pattern
- Request-response: `ipcRenderer.invoke(channel)` ↔ `ipcMain.handle(channel)`
- Push events (main→renderer): `win.webContents.send(channel, data)` ↔ `electronAPI.onX(cb)`
- All renderer API goes through `contextBridge.exposeInMainWorld('electronAPI', {...})` in preload.js

### Chat flow (one path only)
Renderer → `sendAgentMessage` → `ipcMain.handle('send-agent-message')` → `agentRuntime.processMessage(...)` → emits typed events on `agent-event` channel → renderer's `onAgentEvent` handler dispatches to `ChatInterface.handlePartNew/Delta/Update`.

Event types: `session.status`, `part.new`, `part.delta`, `part.update`, `tool.stream`, `permission.request`, `memory.proposal`, `session.title`.

### Tool pattern
```js
module.exports = {
  declaration: { name, description, parameters: { type:'object', properties, required } },
  handler: async (args, onStream) => string
}
```
Registered via `toolRegistry.registerBuiltin(name, declaration, handler)` in `registerBuiltinTools()` in main.js.

### Providers
All four providers implement the same interface. The `ProviderManager` routes model names to providers. Ollama is kept for local inference; Groq/Gemini/OpenRouter for cloud.

---

## Code Conventions

### DO
- Keep each tool in its own file with `{ declaration, handler }` export
- Always pass `signal` from abort controller through to provider calls
- IPC handlers return `{ success: true, ...data }` or `{ success: false, error: string }`
- Debounce SQLite writes via `_scheduleSave()`, use `_flushNow()` for destructive ops
- CSS uses the variables defined in `:root` at the top of `styles/main.css`: surfaces
  `--base`/`--s0`-`--s3`/`--press`, orange `--o-dark`/`--o-mid`/`--o-main`, text
  `--t-hi`/`--t-mid`/`--t-lo`, shadows `--raise-*`/`--inset-*`, aliases `--bg-panel`/`--accent`.
  Note: older rules reference `--color-surface`, `--color-border`, `--color-accent`,
  `--text-primary` and `--border`, none of which are defined anywhere - that's why the
  suggestions panel has no background. Don't copy those names into new CSS.
- Electron IPC: use `invoke` for request-response, `send` only for push events

### Known failure: narration history suppresses tool calls
Replayed history (`getRecentPairs` -> `appendHistoryAssistant`) carries assistant
TEXT only; tool calls are stripped. A turn that opened three tabs replays as prose
("Netflix is open, next Instagram..."), so the model sees a precedent for
answering action requests without calling anything - and imitates it. Each silent
turn becomes another narration example, so it compounds.

Measured on a 3-step request, tool calls fired per 4-6 runs:

| history | qwen2.5:7b | qwen3.5:9b |
|---|---|---|
| none | 4/4 | 4/4 |
| unrelated chat | 4/4 | 4/4 |
| 1 narration turn | 2/4 | 4/4 |
| 3 narration turns | **0/4** | 3/4 |

Tried and did NOT fix it: appending a `[Tools used this turn: ...]` marker (made
qwen3.5 worse - reads as "already done"), replaying real `tool_calls` + `tool`
result messages, temperature 0.2 and 0.0, and an explicit "saying you opened it is
not doing it" prompt rule. With narration in context, qwen2.5:7b was 0/6 in every
condition. A new chat clears it. Don't re-test these without reading this first.

### DON'T
- **Never use em dashes (—) or en dashes (–)** anywhere - code, comments, docs, UI
  strings. Always a plain ASCII hyphen `-`. The box-drawing character `─` used in
  `// ─── Section ───` banners is a different character and is fine to keep.
- Don't use `window.prompt()` - Electron does not implement it and returns null
  without rendering anything. `confirm()` and `alert()` do work.
- Don't call LLM providers directly from tools - tools return strings, AgentRuntime calls LLMs
- Don't add `require('dotenv').config()` anywhere except main.js
- Don't hardcode API endpoints - use the Service class (`GroqService.baseURL`, etc.)
- Don't reintroduce cowork mode, code execution, file system tools, scheduler, task queue, or HTTP API server - those were intentionally removed in the scale-back
  (The To-Do feature in `src/main/features/todo/` is NOT a task queue: no timers, no
   background execution, no notifications, no cron. It's a data store with a list UI, and
   nothing in it ever runs on its own. Don't delete it as a regression.)

### Adding a provider
1. Create `src/main/services/XxxService.js` (API key, base URL, fetchModels, DEFAULT_MODELS)
2. Create `src/main/providers/XxxProvider.js` (copy GroqProvider, update service references)
3. Register in `main.js`: instantiate, add to ProviderManager, add to `get-models` handler
4. Add IPC handlers for key: `get-xxx-key`, `save-xxx-key` in main.js + preload.js
5. Add to ModelSelector `_modelsForType()`
6. Add card to settings.html + wire in settings.js

---

## Dev Commands
```bash
npm start          # Launch Electron app
npm run build      # Build distributable
```
No test suite. Manual testing only. Windows-first; Mac paths may differ.
