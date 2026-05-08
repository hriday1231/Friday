const { app, BrowserWindow, ipcMain, globalShortcut, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
require('dotenv').config();

const { setupTray } = require('./tray');
const ToolRegistry = require('./tools/ToolRegistry');
const { declaration: braveSearchDecl,       handler: braveSearchHandler }       = require('./tools/builtin/braveSearch');
const { declaration: openUrlDecl,           handler: openUrlHandler }           = require('./tools/builtin/openUrl');
const { declaration: openBookmarkDecl,      handler: openBookmarkHandler }      = require('./tools/builtin/openBookmark');
const { declaration: launchAppDecl,         handler: launchAppHandler }         = require('./tools/builtin/launchApp');
const { declaration: searchSiteDecl,        handler: searchSiteHandler }        = require('./tools/builtin/searchSite');
const { declaration: fetchPageDecl,         handler: fetchPageHandler }         = require('./tools/builtin/fetchPage');
const { declaration: addEventDecl,          handler: addEventHandler }          = require('./tools/builtin/addEvent');
const { declaration: editEventDecl,         handler: editEventHandler }         = require('./tools/builtin/editEvent');
const { declaration: deleteEventDecl,       handler: deleteEventHandler }       = require('./tools/builtin/deleteEvent');
const { declaration: getCalendarSummaryDecl,handler: getCalendarSummaryHandler }= require('./tools/builtin/getCalendarSummary');

const MCPClientManager   = require('./mcp/MCPClient');
const AgentRuntime       = require('./agents/AgentRuntime');
const { ProviderManager }= require('./providers/ProviderManager');
const { PermissionPolicy } = require('./agents/PermissionManager');
const { CostTracker }    = require('./agents/CostTracker');
const SessionContext     = require('./agents/SessionContext');
const GeminiProvider     = require('./providers/GeminiProvider');
const OllamaProvider     = require('./providers/OllamaProvider');
const GroqProvider       = require('./providers/GroqProvider');
const OpenRouterProvider = require('./providers/OpenRouterProvider');
const OllamaService      = require('./services/OllamaService');
const GeminiService      = require('./services/GeminiService');
const GroqService        = require('./services/GroqService');
const OpenRouterService  = require('./services/OpenRouterService');
const SettingsStore      = require('./settings/SettingsStore');
const BraveSearchService = require('./services/BraveSearchService');
const GoogleCalendarService = require('./services/GoogleCalendarService');
const PersistentStore    = require('./store/PersistentStore');

let mainWindow = null;
let settingsWindow = null;
let agentRuntime      = null;
let providerManager   = null;
let mcpClientManager  = null;
let store             = null;
let toolRegistry      = null;
let activeSessionId   = null;
let currentModel      = null;
let currentModelType  = null;
let geminiProvider, ollamaProvider, groqProvider, openRouterProvider;
/** @type {Map<string, SessionContext>} */
const _sessionContexts = new Map();

// ─── CLI flag parsing ─────────────────────────────────────────────────────────
// Opt-in dev/test web bridge. None of these flags are set by `npm start`.
const argv = process.argv.slice(1);
function _argFlag(name) { return argv.includes(`--${name}`); }
function _argValue(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}
const CLI = {
  web:        _argFlag('web') || _argFlag('web-only'),
  webOnly:    _argFlag('web-only'),
  localOnly:  _argFlag('local-only'),
  resetState: _argFlag('reset-state'),
  seedPath:   _argValue('seed', null),
  testModel:  _argValue('test-model', process.env.FRIDAY_TEST_MODEL || null),
  webPort:    parseInt(process.env.WEB_PORT || _argValue('web-port', '4173'), 10) || 4173,
  webHost:    process.env.WEB_HOST || _argValue('web-host', '127.0.0.1'),
};
if (CLI.web && CLI.webHost !== '127.0.0.1' && CLI.webHost !== 'localhost') {
  console.error(`[webBridge] Refusing to bind to non-loopback address: ${CLI.webHost}`);
  console.error('[webBridge] The bridge has full host privileges and must never be exposed beyond loopback.');
  process.exit(1);
}

// ─── IPC handler registry ─────────────────────────────────────────────────────
// Every handler is registered via register(channel, fn) so it's reachable from
// both Electron IPC and the optional HTTP bridge.
/** @type {Object<string, (...args: any[]) => any>} */
const ipcHandlers = {};
function register(channel, fn) {
  // Bridge invokes handlers with raw arg list; we synthesize an empty event object.
  // Multi-arg handlers like transcribe-audio(audioData, mimeType) work transparently.
  ipcHandlers[channel] = (...args) => fn({}, ...args);
  ipcMain.handle(channel, fn);
}

// ─── Push-event fan-out ───────────────────────────────────────────────────────
// One-way main→renderer events are mirrored to any registered broadcaster
// (used by the web bridge to forward via WebSocket).
const _broadcasters = new Set();
function registerBroadcaster(fn) { _broadcasters.add(fn); return () => _broadcasters.delete(fn); }
function pushEvent(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
  for (const fn of _broadcasters) {
    try { fn(channel, data); } catch (e) { console.error('[pushEvent] broadcaster threw:', e.message); }
  }
}

function _iconPath() {
  const base = path.join(__dirname, '../../public');
  if (process.platform === 'darwin') return path.join(base, 'icon.icns');
  if (process.platform === 'win32')  return path.join(base, 'icon.ico');
  return path.join(base, 'icons', '256x256.png');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900, height: 900, minWidth: 520, minHeight: 400,
    x: 100, y: 100,
    frame: false, transparent: false, resizable: true,
    skipTaskbar: true, alwaysOnTop: true,
    icon: fs.existsSync(_iconPath()) ? _iconPath() : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload.js'),
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.hide();
}

function createSettingsWindow() {
  if (settingsWindow) { settingsWindow.show(); settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    width: 980, height: 720, minWidth: 740, minHeight: 520,
    show: true, frame: true, resizable: true, skipTaskbar: false, alwaysOnTop: false,
    icon: fs.existsSync(_iconPath()) ? _iconPath() : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload.js'),
    },
  });
  settingsWindow.loadFile(path.join(__dirname, '../renderer/settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

function toggleWindow() {
  if (mainWindow.isVisible()) mainWindow.hide();
  else { mainWindow.show(); mainWindow.focus(); }
}

function registerBuiltinTools(registry) {
  registry.registerBuiltin(braveSearchDecl.name, braveSearchDecl, braveSearchHandler);

  const appNames = SettingsStore.listAppShortcutNames();
  const launchSuffix = appNames.length
    ? ` Known app shortcuts: ${appNames.join(', ')}.`
    : ' Configure app shortcuts in Settings so Friday can launch them by name.';
  registry.registerBuiltin(launchAppDecl.name, {
    ...launchAppDecl,
    description: (launchAppDecl.description || '') + launchSuffix,
  }, launchAppHandler);

  registry.registerBuiltin(openUrlDecl.name, openUrlDecl, openUrlHandler);

  const bookmarkNames = SettingsStore.listBookmarkNames();
  const bookmarkSuffix = bookmarkNames.length
    ? ` Known bookmarks/aliases: ${bookmarkNames.join(', ')}.`
    : ' Configure web bookmarks/aliases in Settings so Friday can open them by name.';
  registry.registerBuiltin(openBookmarkDecl.name, {
    ...openBookmarkDecl,
    description: (openBookmarkDecl.description || '') + bookmarkSuffix,
  }, openBookmarkHandler);

  registry.registerBuiltin(searchSiteDecl.name, searchSiteDecl, searchSiteHandler);
  registry.registerBuiltin(fetchPageDecl.name, fetchPageDecl, fetchPageHandler);

  registry.registerBuiltin(addEventDecl.name, addEventDecl, addEventHandler);
  registry.registerBuiltin(editEventDecl.name, editEventDecl, editEventHandler);
  registry.registerBuiltin(deleteEventDecl.name, deleteEventDecl, deleteEventHandler);
  registry.registerBuiltin(getCalendarSummaryDecl.name, getCalendarSummaryDecl, getCalendarSummaryHandler);
}

app.whenReady().then(async () => {
  // ── Electron desktop window (skipped in --web-only) ─────────────────────────
  if (!CLI.webOnly) {
    createWindow();
    setupTray(mainWindow);
  } else {
    console.log('[main] --web-only: skipping Electron window and tray.');
  }

  // ── Store init (with optional --reset-state / --seed) ───────────────────────
  store = new PersistentStore(app.getPath('userData'));
  if (CLI.resetState) {
    await store.reset();
    try { SettingsStore.store.clear(); } catch (e) { console.warn('[main] could not clear SettingsStore:', e.message); }
    console.log('[main] --reset-state: wiped sessions, messages, memory, settings');
  } else {
    await store.init();
  }
  if (CLI.seedPath) {
    try {
      const result = await store.seedFromFile(path.resolve(CLI.seedPath));
      console.log(`[main] --seed: loaded ${result.sessions} sessions, ${result.messages} messages, ${result.memory} memory rows from ${CLI.seedPath}`);
      if (result.settings && typeof result.settings === 'object') {
        for (const [k, v] of Object.entries(result.settings)) {
          try { SettingsStore.store.set(k, v); } catch (e) { console.warn(`[main] --seed: could not set ${k}:`, e.message); }
        }
        console.log(`[main] --seed: applied ${Object.keys(result.settings).length} settings`);
      }
    } catch (err) {
      console.error(`[main] --seed failed: ${err.message}`);
      process.exit(1);
    }
  }

  const _chatSessions = store.listSessions('chat');
  activeSessionId = _chatSessions[0]?.id ?? store.createSession(null, 'chat').id;

  // ── Tools + MCP ─────────────────────────────────────────────────────────────
  toolRegistry = new ToolRegistry();
  registerBuiltinTools(toolRegistry);

  mcpClientManager = new MCPClientManager(toolRegistry);
  await mcpClientManager.connectAll();

  // ── Providers (filtered to local-only when --local-only) ────────────────────
  geminiProvider     = new GeminiProvider(toolRegistry);
  ollamaProvider     = new OllamaProvider(toolRegistry);
  groqProvider       = new GroqProvider(toolRegistry);
  openRouterProvider = new OpenRouterProvider(toolRegistry);

  let providerSet;
  if (CLI.localOnly) {
    const { ensureLocalReadiness } = require('./testMode');
    await ensureLocalReadiness({ testModel: CLI.testModel });
    providerSet = { ollama: ollamaProvider };
    console.log('[main] --local-only: only Ollama provider active');
  } else {
    providerSet = {
      gemini:     geminiProvider,
      ollama:     ollamaProvider,
      groq:       groqProvider,
      openrouter: openRouterProvider,
    };
  }
  providerManager = new ProviderManager(providerSet);
  providerManager.cacheModelLists().catch(() => {});

  const _emit = (event) => pushEvent('agent-event', event);

  agentRuntime = new AgentRuntime({
    toolRegistry,
    providerManager,
    store,
    emit: _emit,
  });

  // ── Hotkey (desktop-only) ───────────────────────────────────────────────────
  if (!CLI.webOnly) {
    const hotkey = SettingsStore.getHotkey() || process.env.HOTKEY || 'CommandOrControl+Shift+Space';
    if (!globalShortcut.register(hotkey, () => toggleWindow())) {
      console.error('Hotkey registration failed');
    }
  }

  // ── Warm up Ollama models list ──────────────────────────────────────────────
  try {
    const models = await OllamaService.fetchModels();
    pushEvent('ollama-models-updated', models);
  } catch (error) {
    console.error('Failed to fetch Ollama models:', error);
  }

  // ── Web bridge (opt-in dev/test mode) ───────────────────────────────────────
  if (CLI.web) {
    try {
      const { startWebBridge } = require('./webBridge');
      await startWebBridge({
        host: CLI.webHost,
        port: CLI.webPort,
        ipcHandlers,
        registerBroadcaster,
        onPermissionResponse: ({ requestId, approved, alwaysAllow } = {}) => {
          if (agentRuntime && requestId) agentRuntime.resolvePermission(requestId, !!approved, !!alwaysAllow);
        },
        getStatus: () => ({
          ready: !!agentRuntime,
          providers: Object.keys(providerSet),
          activeSession: activeSessionId,
          localOnly: CLI.localOnly,
          testModel: CLI.testModel,
        }),
        rendererDir: path.join(__dirname, '../renderer'),
        nodeModulesDir: path.join(__dirname, '../../node_modules'),
      });
      console.log(`[webBridge] Friday web bridge listening on http://${CLI.webHost}:${CLI.webPort}`);
      console.log(`[webBridge] Open http://${CLI.webHost}:${CLI.webPort}/?web=1 in a browser`);
    } catch (err) {
      console.error('[webBridge] Failed to start:', err.message);
      if (CLI.webOnly) process.exit(1);
    }
  }

  app.on('activate', () => {
    if (!CLI.webOnly && BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', (event) => event.preventDefault());

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  store?.close();
});

// ─── Session / History IPC ────────────────────────────────────────────────────

register('get-active-session', () => {
  if (!store || !activeSessionId) return null;
  return { session: store.getSession(activeSessionId), messages: store.getMessages(activeSessionId) };
});

register('new-chat', () => {
  if (!store) return null;
  const session = store.createSession(null, 'chat');
  activeSessionId = session.id;
  _sessionContexts.delete(session.id);
  return { session, messages: [] };
});

register('get-sessions', () => store?.listSessions() ?? []);

register('load-session', (event, { sessionId } = {}) => {
  if (!store || !sessionId) return null;
  const session = store.getSession(sessionId);
  if (!session) return null;
  activeSessionId = sessionId;
  return { session, messages: store.getMessages(sessionId) };
});

register('rename-session', (event, { sessionId, title } = {}) => {
  if (!store || !sessionId) return { success: false };
  store.renameSession(sessionId, title ?? '');
  return { success: true };
});

register('pin-session', (event, { sessionId, pinned } = {}) => {
  if (!store || !sessionId) return { success: false };
  store.pinSession(sessionId, !!pinned);
  return { success: true };
});

register('extract-file-text', async (event, buffer) => {
  try {
    return { success: true, text: Buffer.from(buffer).toString('utf8') };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

register('search-sessions', (event, { query } = {}) => {
  if (!store || !query) return [];
  return store.searchMessages(query);
});

register('save-document',   (event, { sessionId, doc } = {}) => (store && sessionId && doc) ? store.saveDocument(sessionId, doc) : null);
register('get-documents',   (event, { sessionId } = {})      => (store && sessionId) ? store.getDocuments(sessionId) : []);
register('delete-document', (event, { id } = {})             => { if (store && id) store.deleteDocument(id); });

register('truncate-session', (event, { sessionId, fromIndex } = {}) => {
  if (!store || !sessionId || fromIndex == null) return { success: false };
  return { success: store.truncateMessages(sessionId, fromIndex) };
});

register('delete-session', (event, { sessionId } = {}) => {
  if (!store || !sessionId) return { success: false };
  store.deleteSession(sessionId);
  if (sessionId === activeSessionId) {
    const remaining = store.listSessions();
    activeSessionId = remaining.length ? remaining[0].id : store.createSession(null, 'chat').id;
  }
  return { success: true, activeSessionId };
});

register('export-session', async (event, { sessionId } = {}) => {
  if (!store || !sessionId) return { success: false };
  const session  = store.getSession(sessionId);
  const messages = store.getMessages(sessionId);
  const title    = session?.title || 'Chat Export';
  const date     = new Date(session?.created_at || Date.now())
    .toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  let md = `# ${title}\n\n_Exported on ${date}_\n\n---\n\n`;
  for (const msg of messages) {
    if (msg.role === 'user')      md += `**You**\n\n${msg.content}\n\n---\n\n`;
    else if (msg.role === 'assistant') md += `**Friday**\n\n${msg.content}\n\n---\n\n`;
  }

  const safeTitle = title.replace(/[/\\?%*:|"<>]/g, '-');
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Chat',
    defaultPath: `${safeTitle}.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Text', extensions: ['txt'] }],
  });
  if (canceled || !filePath) return { success: false };
  fs.writeFileSync(filePath, md, 'utf8');
  return { success: true };
});

// ─── Memory IPC ────────────────────────────────────────────────────────────────

register('get-memory', () => store?.getMemory() ?? []);

register('approve-memories', (event, facts) => {
  if (!store || !Array.isArray(facts)) return { success: false };
  for (const fact of facts) {
    if (typeof fact === 'string' && fact.trim()) {
      store.addMemory(fact.trim(), 'auto', 'fact', 'chat');
    } else if (fact && typeof fact === 'object' && fact.content) {
      store.addMemory(fact.content.trim(), 'auto', fact.category || 'fact', 'chat');
    }
  }
  return { success: true };
});

register('add-memory', (event, { content, category } = {}) => {
  if (!store || !content?.trim()) return { success: false };
  const id = store.addMemory(content.trim(), 'manual', category || 'fact', 'chat');
  return { success: true, id };
});

register('delete-memory', (event, { id } = {}) => {
  if (!store || !id) return { success: false };
  store.deleteMemory(id);
  return { success: true };
});

register('update-memory', (event, { id, content } = {}) => {
  if (!store || !id || !content?.trim()) return { success: false };
  store.updateMemory(id, content.trim());
  return { success: true };
});

register('clear-all-memory', () => {
  if (!store) return { success: false };
  store.clearAllMemory();
  return { success: true };
});

register('open-external', (event, url) => {
  if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
    shell.openExternal(url);
  }
});

// ─── TTS ────────────────────────────────────────────────────────────────────────

register('get-tts-config',  ()        => SettingsStore.getTtsConfig());
register('save-tts-config', (e, cfg)  => { SettingsStore.setTtsConfig(cfg || {}); return { success: true }; });

// ─── Feedback ──────────────────────────────────────────────────────────────────

register('save-feedback', (e, data) => {
  if (!store) return { success: false };
  const id = store.addFeedback({
    sessionId:         activeSessionId,
    userMessage:       data.userMessage,
    assistantResponse: data.assistantResponse,
    rating:            data.rating,
    correction:        data.correction || null,
    model:             currentModel,
    agentId:           'friday',
    appMode:           'chat',
  });
  return { success: true, id };
});
register('delete-feedback',       (e, id) => { store?.deleteFeedback(id); return { success: true }; });
register('get-feedback-examples', ()      => store?.getPositiveFeedback(100) ?? []);

register('get-suggestions', async (e, { query = '' } = {}) => {
  if (!store || !query) return { memories: [], episodes: [] };
  const [memories, episodes] = await Promise.all([
    store.getRelevantMemory(query, 6, 'chat'),
    store.getRelevantEpisodes(query, activeSessionId, 3),
  ]);
  return { memories, episodes };
});

register('export-training-data', async (e, { format = 'openai' } = {}) => {
  if (!store) return { success: false, error: 'Store not ready' };
  const examples = store.getPositiveFeedback(10000);
  if (examples.length === 0) return { success: false, error: 'No approved examples found. Rate some responses with 👍 first.' };

  const lines = examples.map(ex => {
    if (format === 'openai') {
      return JSON.stringify({ messages: [
        { role: 'user',      content: ex.user_message },
        { role: 'assistant', content: ex.assistant_response },
      ]});
    } else if (format === 'alpaca') {
      return JSON.stringify({ instruction: ex.user_message, input: '', output: ex.assistant_response });
    }
    return JSON.stringify({ user: ex.user_message, assistant: ex.assistant_response });
  });

  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Export training data',
    defaultPath: 'friday-training.jsonl',
    filters: [{ name: 'JSONL', extensions: ['jsonl'] }, { name: 'All Files', extensions: ['*'] }],
  });
  if (canceled || !filePath) return { success: false, error: 'Cancelled' };

  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
  return { success: true, count: examples.length, path: filePath };
});

// ─── Custom system prompt ──────────────────────────────────────────────────────

register('get-custom-prompt',  () => SettingsStore.getCustomSystemPrompt());
register('save-custom-prompt', (event, text) => {
  SettingsStore.setCustomSystemPrompt(text || '');
  return { success: true };
});

// ─── Whisper STT ───────────────────────────────────────────────────────────────

register('get-whisper-config', () => SettingsStore.getWhisperConfig());
register('save-whisper-config', (event, config) => { SettingsStore.setWhisperConfig(config || {}); return { success: true }; });

register('transcribe-audio', (event, audioData, mimeType) => {
  return new Promise((resolve) => {
    const { exePath, modelPath } = SettingsStore.getWhisperConfig();
    if (!exePath || !modelPath) return resolve({ success: false, error: 'not-configured' });

    const cleanExe = exePath.replace(/^["']|["']$/g, '').trim();
    const isWav = (mimeType || '').includes('wav');
    const ext   = isWav ? 'wav' : ((mimeType || '').includes('ogg') ? 'ogg' : 'webm');
    const tmpBase = path.join(os.tmpdir(), `friday-${Date.now()}`);
    const audioIn = `${tmpBase}.${ext}`;

    try { fs.writeFileSync(audioIn, Buffer.from(audioData)); }
    catch (e) { return resolve({ success: false, error: `Failed to write audio: ${e.message}` }); }

    const runWhisper = (inputFile) => {
      // -l en + -bs 2 shaves multiple seconds off a typical dictation clip
      // vs. -l auto with default beam search, at no quality cost for English.
      const args = ['-m', modelPath, '-f', inputFile, '-l', 'en', '-bs', '2', '-t', '8', '-nt', '-np'];
      execFile(cleanExe, args, { timeout: 60000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
        try { fs.unlinkSync(audioIn); } catch {}
        try { if (inputFile !== audioIn) fs.unlinkSync(inputFile); } catch {}
        if (err) { console.error('[Whisper]', err.message); return resolve({ success: false, error: err.message }); }
        const transcript = stdout.trim().split('\n').map(l => l.trim()).filter(Boolean).join(' ');
        resolve({ success: true, transcript });
      });
    };

    if (isWav) {
      runWhisper(audioIn);
    } else {
      const wavOut = `${tmpBase}.wav`;
      const ffmpegArgs = ['-y', '-i', audioIn, '-ar', '16000', '-ac', '1', '-f', 'wav', wavOut];
      execFile('ffmpeg', ffmpegArgs, { timeout: 30000 }, (ffErr) => {
        if (!ffErr && fs.existsSync(wavOut)) runWhisper(wavOut);
        else { console.log('[Voice] ffmpeg not found, passing raw audio to whisper-cli'); runWhisper(audioIn); }
      });
    }
  });
});

// ─── Legacy clear-chat ─────────────────────────────────────────────────────────

register('clear-chat', () => {
  if (!store) return null;
  const session = store.createSession(null, 'chat');
  activeSessionId = session.id;
  _sessionContexts.delete(session.id);
  return { session };
});

// ─── Settings window ───────────────────────────────────────────────────────────

register('open-settings', () => { createSettingsWindow(); return { success: true }; });

register('get-settings', () => ({
  appShortcuts: SettingsStore.getAppShortcuts(),
  webBookmarks: SettingsStore.getWebBookmarks(),
}));

register('save-settings', (event, settings) => {
  try {
    const appShortcuts = Array.isArray(settings?.appShortcuts) ? settings.appShortcuts : [];
    const webBookmarks = Array.isArray(settings?.webBookmarks) ? settings.webBookmarks : [];
    SettingsStore.setAppShortcuts(appShortcuts);
    SettingsStore.setWebBookmarks(webBookmarks);
    if (toolRegistry) registerBuiltinTools(toolRegistry);
    return { success: true };
  } catch (error) {
    console.error('Failed to save settings:', error);
    return { success: false, error: error.message };
  }
});

// ─── Integrations status ───────────────────────────────────────────────────────

function safeDecodeJwtEmail(idToken) {
  try {
    const parts = String(idToken).split('.');
    if (parts.length < 2) return null;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const data = JSON.parse(json);
    return typeof data.email === 'string' ? data.email : null;
  } catch { return null; }
}

function getGoogleTokenPath() {
  try { return path.join(app.getPath('userData'), 'google-calendar-token.json'); }
  catch { return path.join(process.cwd(), 'google-calendar-token.json'); }
}

function getGoogleCredentialsPath() {
  return process.env.GOOGLE_CREDENTIALS_PATH || path.join(process.cwd(), 'credentials.json');
}

register('get-integrations-status', async () => {
  const credentialsPath = getGoogleCredentialsPath();
  const tokenPath = getGoogleTokenPath();
  const googleCredentialsPresent = fs.existsSync(credentialsPath);
  const googleTokenPresent = fs.existsSync(tokenPath);

  let googleEmail = null;
  if (googleTokenPresent) {
    try {
      const tokenJson = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      googleEmail = safeDecodeJwtEmail(tokenJson?.id_token);
    } catch {}
  }

  const ollamaRunning = await OllamaService.isRunning();
  const ollamaModels  = ollamaRunning ? await OllamaService.fetchModels() : [];

  return {
    gemini:     { configured: GeminiService.isConfigured() },
    brave:      { configured: BraveSearchService.isConfigured() },
    openrouter: { configured: OpenRouterService.isConfigured() },
    googleCalendar: {
      credentialsPresent: googleCredentialsPresent,
      tokenPresent: googleTokenPresent,
      account: googleEmail,
    },
    ollama: { running: ollamaRunning, models: ollamaModels },
    groq:   { configured: GroqService.isConfigured() },
  };
});

register('test-integration', async (event, { name } = {}) => {
  const n = String(name || '').toLowerCase();
  try {
    if (n === 'gemini') {
      const models = await GeminiService.fetchModels();
      return { success: true, details: { modelCount: models.length } };
    }
    if (n === 'brave') {
      const res = await BraveSearchService.search('friday assistant');
      return { success: true, details: { resultCount: res?.web?.results?.length ?? 0 } };
    }
    if (n === 'ollama') {
      const running = await OllamaService.isRunning();
      const models = running ? await OllamaService.fetchModels() : [];
      return { success: true, details: { running, models } };
    }
    if (n === 'google') {
      const now = new Date();
      const start = new Date(now.getTime() - 60 * 1000).toISOString();
      const end = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
      const events = await GoogleCalendarService.getEventsInRange(start, end);
      return { success: true, details: { upcomingCount: Array.isArray(events) ? events.length : 0 } };
    }
    return { success: false, error: 'Unknown integration' };
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
});

register('google-calendar-connect', async () => {
  try {
    const now = new Date();
    const start = new Date(now.getTime() - 60 * 1000).toISOString();
    const end = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const events = await GoogleCalendarService.getEventsInRange(start, end);
    return { success: true, details: { upcomingCount: Array.isArray(events) ? events.length : 0 } };
  } catch (error) { return { success: false, error: error.message || String(error) }; }
});

register('google-calendar-logout', async () => {
  try {
    const tokenPath = getGoogleTokenPath();
    if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
    return { success: true };
  } catch (error) { return { success: false, error: error.message || String(error) }; }
});

// ─── Models / Ollama ───────────────────────────────────────────────────────────

register('fetch-ollama-models', async () => {
  try { return { success: true, models: await OllamaService.fetchModels() }; }
  catch (error) { console.error('Error fetching Ollama models:', error); return { success: false, models: [] }; }
});

register('get-models', async () => {
  try {
    const [geminiModels, ollamaModels, groqModels, openRouterModels] = await Promise.all([
      GeminiService.fetchModels(),
      OllamaService.fetchModels(),
      GroqService.fetchModels(),
      OpenRouterService.fetchModels(),
    ]);
    return {
      success: true,
      models: { gemini: geminiModels, ollama: ollamaModels, groq: groqModels, openrouter: openRouterModels },
      configured: {
        groq:       GroqService.isConfigured(),
        gemini:     GeminiService.isConfigured(),
        openrouter: OpenRouterService.isConfigured(),
      },
    };
  } catch (error) {
    console.error('Error fetching models:', error);
    return {
      success: true,
      models: { gemini: [], ollama: [], groq: GroqService.DEFAULT_MODELS, openrouter: OpenRouterService.DEFAULT_MODELS },
      configured: {
        groq:       GroqService.isConfigured(),
        gemini:     GeminiService.isConfigured(),
        openrouter: OpenRouterService.isConfigured(),
      },
    };
  }
});

register('get-model-slots',  () => SettingsStore.getModelSlots());
register('save-model-slots', (event, slots) => { SettingsStore.setModelSlots(slots); return { success: true }; });

// ─── API keys ──────────────────────────────────────────────────────────────────

register('get-groq-key',   () => ({ key: SettingsStore.getGroqApiKey() }));
register('save-groq-key',  (_, { key } = {}) => { SettingsStore.setGroqApiKey(key || ''); return { success: true }; });

register('get-gemini-key', () => ({ key: SettingsStore.getGeminiApiKey() }));
register('save-gemini-key', (_, { key } = {}) => {
  SettingsStore.setGeminiApiKey(key || '');
  GeminiService.genAI = null;
  return { success: true };
});

register('get-brave-key',  () => ({ key: SettingsStore.getBraveApiKey() }));
register('save-brave-key', (_, { key } = {}) => { SettingsStore.setBraveApiKey(key || ''); return { success: true }; });

register('get-openrouter-key',  () => ({ key: SettingsStore.getOpenRouterApiKey() }));
register('save-openrouter-key', (_, { key } = {}) => { SettingsStore.setOpenRouterApiKey(key || ''); return { success: true }; });

register('get-ollama-url',  () => ({ url: SettingsStore.getOllamaBaseUrl() }));
register('save-ollama-url', (_, { url } = {}) => { SettingsStore.setOllamaBaseUrl(url || 'http://localhost:11434'); return { success: true }; });

// ─── Hotkey ────────────────────────────────────────────────────────────────────

register('get-hotkey',  () => ({ hotkey: SettingsStore.getHotkey() }));
register('save-hotkey', (_, { hotkey: newHotkey } = {}) => {
  const key = (newHotkey || 'CommandOrControl+Shift+Space').trim();
  try {
    const oldHotkey = SettingsStore.getHotkey();
    globalShortcut.unregister(oldHotkey);
    const ok = globalShortcut.register(key, () => toggleWindow());
    if (!ok) {
      globalShortcut.register(oldHotkey, () => toggleWindow());
      return { success: false, error: `Could not register hotkey: ${key}` };
    }
    SettingsStore.setHotkey(key);
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

// ─── Wake word ─────────────────────────────────────────────────────────────────

register('get-wake-word-config',  () => SettingsStore.getWakeWordConfig());
register('save-wake-word-config', (e, cfg = {}) => { SettingsStore.setWakeWordConfig(cfg); return { success: true, config: SettingsStore.getWakeWordConfig() }; });

register('show-window', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  return { success: true };
});

register('minimize-window', () => { if (mainWindow) mainWindow.hide(); });
register('close-window',    () => app.quit());

// ─── AgentRuntime IPC ──────────────────────────────────────────────────────────

ipcMain.on('agent-permission-response', (_, { requestId, approved, alwaysAllow } = {}) => {
  if (agentRuntime && requestId) agentRuntime.resolvePermission(requestId, !!approved, !!alwaysAllow);
});

const INCOGNITO_SESSION_ID = '__incognito__';

register('send-agent-message', async (event, data = {}) => {
  const { message, displayMessage, model, modelType, sessionId: reqSessionId, images = [], forceSearch = false, incognito = false } = data;
  if (!agentRuntime || !model) return { success: false, error: 'AgentRuntime not ready' };

  const sessionId = incognito ? INCOGNITO_SESSION_ID : (reqSessionId || activeSessionId);
  if (!sessionId) return { success: false, error: 'No active session' };

  let ctx = _sessionContexts.get(sessionId);
  if (!ctx) {
    ctx = new SessionContext({
      sessionId,
      permissionPolicy: PermissionPolicy.fullyOpen(),
      costTracker:      new CostTracker(model),
    });
    _sessionContexts.set(sessionId, ctx);
  } else {
    ctx.costTracker = new CostTracker(model);
  }

  currentModel     = model;
  currentModelType = modelType || currentModelType;
  if (!incognito) activeSessionId = sessionId;
  agentRuntime.activeSessionId = sessionId;

  try {
    const result = await agentRuntime.processMessage(message, model, ctx, {
      images,
      display: displayMessage ?? message,
      forceSearch,
      incognito,
    });
    return { success: true, sessionId: incognito ? null : sessionId, result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

register('cancel-agent-message', (_, { sessionId: reqSessionId } = {}) => {
  const sessionId = reqSessionId || activeSessionId;
  const ctx = sessionId && _sessionContexts.get(sessionId);
  if (ctx && agentRuntime) agentRuntime.abort(ctx);
  return { success: true };
});

register('clear-incognito', () => {
  if (agentRuntime) agentRuntime.clearIncognitoHistory();
  _sessionContexts.delete(INCOGNITO_SESSION_ID);
  return { success: true };
});

