# Friday — Project Instructions

## What This Is
An Electron desktop chat assistant (Windows-first). Fast conversational UI with memory, RAG, web search, Google Calendar, whisper STT, and lightweight browser automation for opening/searching websites.

Stack: Electron + Node.js main process, vanilla JS renderer (no framework), sql.js SQLite.

---

## File Layout

```
src/main/          — Node.js / Electron main process
  main.js          — App entry, all IPC handlers, provider/tool wiring
  agents/
    AgentRuntime.js     — Event-driven tool-use loop (single chat entry point)
    SessionContext.js   — Per-session abort + permission + cost tracker
    PermissionManager.js — Policy object (used with fullyOpen() — all tools allowed)
    CompactionManager.js — Long-context message compaction
    CostTracker.js       — Token usage tracker
  providers/
    OllamaProvider.js, GroqProvider.js, GeminiProvider.js, OpenRouterProvider.js
    ProviderManager.js — routes model → provider
    All must implement: initMessages, appendUser, appendHistoryAssistant,
      appendResponse, appendToolResults, chatWithTools, fetchModels
  config/systemPrompt.js  — Builds system prompt (memory + episodes + fewShots + screenContext)
  store/PersistentStore.js — SQLite via sql.js (sync queries, debounced disk flush)
  memory/MemoryEmbedder.js — Embedding service for semantic memory retrieval
  tools/builtin/          — One file per tool: { declaration, handler } exports
    braveSearch.js, fetchPage.js, openUrl.js, openBookmark.js,
    searchSite.js, launchApp.js,
    addEvent.js, editEvent.js, deleteEvent.js, getCalendarSummary.js
  settings/SettingsStore.js — electron-store wrapper for API keys, hotkeys, etc.
  types/parts.js   — Typed parts (text, reasoning, tool, step markers) for event stream

src/renderer/      — Browser-context renderer process
  components/
    ChatInterface.js — Main chat UI (messages, streaming parts, permission banner)
    ModelSelector.js — Model picker with slots (chat/vision/cloud)
  renderer.js      — Session list, suggestions, memory proposals, wake word
  index.html / styles/main.css / settings.html / settings.js
  rag/             — BM25 + embedding-based document indexing for chat

src/preload.js     — contextBridge IPC bridge (renderer ↔ main)
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
- CSS uses CSS variables: `var(--color-accent)`, `var(--color-surface)`, etc.
- Electron IPC: use `invoke` for request-response, `send` only for push events

### DON'T
- Don't call LLM providers directly from tools — tools return strings, AgentRuntime calls LLMs
- Don't add `require('dotenv').config()` anywhere except main.js
- Don't hardcode API endpoints — use the Service class (`GroqService.baseURL`, etc.)
- Don't reintroduce cowork mode, code execution, file system tools, scheduler, task queue, or HTTP API server — those were intentionally removed in the scale-back

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
