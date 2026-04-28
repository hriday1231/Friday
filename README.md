# Friday

A personal desktop AI assistant for Windows, built with Electron and Node.js.

Friday gives you an always-available chat window - global hotkey plus a "Hey Friday" wake word - backed by an event-driven agent that can search the web, open URLs and apps, manage your Google Calendar, and remember what you've talked about across sessions. Four LLM providers (Groq, Gemini, OpenRouter, Ollama) sit behind a single interface so you can swap models without changing the rest of the stack.

## Features

- **Agentic tool use.** A streaming event-driven loop with per-session abort, permission gating, automatic memory extraction, context compaction, and cost tracking. Currently shipped tools:
  - Web search via Brave
  - Fetch and read any public URL
  - Open URLs / bookmarks / configured local apps
  - Site-scoped search (YouTube, Amazon, GitHub, and more)
  - Google Calendar: add / edit / delete / summarize events
- **Multi-provider LLM routing.** Groq, Gemini, OpenRouter, and Ollama behind a unified `Provider` interface. Routing is by model-name prefix and cached model lists; mode-based config (chat vs. code) tunes temperature and max tokens.
- **Voice input.** Whisper-based STT plus a local wake-word detector running on a 2.5-second rolling audio buffer.
- **RAG + persistent memory.** BM25 plus embedding retrieval (via Ollama's `nomic-embed-text`) for per-session document indexing, plus a SQLite-backed long-term memory store that surfaces relevant facts into the system prompt at inference time.
- **Compaction-aware context.** When a conversation approaches the model's context window, an automatic summarization step preserves the gist of older turns while keeping the most recent messages verbatim.
- **Behavioral eval harness.** `scripts/eval.js` runs an LLM-as-judge suite against the agent - rubric scoring, tool-use assertions, multi-turn cases, and credential-aware skips for offline runs.

## Quick start

```bash
git clone https://github.com/hriday1231/Friday.git
cd Friday
npm install
cp .env.example .env   # fill in whichever provider keys you want to use
npm start
```

Optional Windows extra - register a Start Menu shortcut that launches the app silently:

```bash
npm run install-shortcut
```

## Configuration

All API keys live in `.env`. Every key is optional; Friday will use whichever providers are configured and fall back to local Ollama for everything else.

| Variable | Provider | Where to get one |
|---|---|---|
| `GEMINI_API_KEY` | Google Gemini | aistudio.google.com |
| `GROQ_API_KEY` | Groq | console.groq.com |
| `OPENROUTER_API_KEY` | OpenRouter | openrouter.ai |
| `BRAVE_API_KEY` | Brave Search API | api.search.brave.com |

**Google Calendar.** Drop an OAuth installed-app `credentials.json` from Google Cloud Console at the project root, then trigger the calendar flow inside the app to complete the OAuth handshake. The resulting token is written next to the credentials file and is gitignored.

**Ollama.** For fully local operation, install [Ollama](https://ollama.com), pull a chat model (`ollama pull llama3.1`) and the embedding model (`ollama pull nomic-embed-text`), and leave the cloud keys blank.

## Architecture

```
src/main/                  Electron main process (Node.js)
  agents/
    AgentRuntime.js          Event-driven tool-use loop (single chat entry point)
    SessionContext.js        Per-session abort + permission + cost tracker
    CompactionManager.js     Long-context message compaction
    CostTracker.js           Token usage and USD cost accounting
  providers/                 Groq / Gemini / OpenRouter / Ollama adapters
  tools/builtin/             One file per tool: { declaration, handler }
  memory/MemoryEmbedder.js   Embedding-based fact store + retrieval
  store/PersistentStore.js   SQLite via sql.js, debounced disk flush
  services/                  External API clients (Brave, Google Calendar, Ollama)

src/renderer/              Electron renderer (vanilla JS, no framework)
  components/                Chat UI, model selector, settings
  rag/                       Per-session BM25 + embedding index
  renderer.js                Session list, suggestions, wake word

src/preload.js             contextBridge IPC bridge

scripts/
  eval.js                  LLM-as-judge behavioral eval harness
  install-start-menu-shortcut.ps1
```

The agent emits a typed event stream - `part.new`, `part.delta`, `tool.stream`, `permission.request`, `memory.proposal`, `session.title` - so the UI can render reasoning, tool calls, and streaming text incrementally with the same shape regardless of which provider produced the response.

For deeper architectural notes, IPC patterns, and conventions for adding tools or providers, see [`AGENTS.md`](AGENTS.md).

## Tech stack

Electron 28, Node.js, vanilla-JS renderer, sql.js (pure-JS SQLite, no native deps), Whisper for STT, the official Google Generative AI and Google APIs SDKs, and the Model Context Protocol SDK.

## Status

Hand-built personal project. Windows is the primary target; macOS and Linux paths may need adjustment. There is no automated unit-test suite - `npm run eval` is the closest thing.

## License

[MIT](LICENSE)
