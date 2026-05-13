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

// ─── Single-instance lock ──────────────────────────────────────────────────────
// Only one Friday process at a time. If a second copy is launched (taskbar,
// Start Menu, shortcut, etc.), we exit it immediately and the already-running
// process surfaces its window so the user sees Friday come to the front.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

function _iconPath() {
  const base = path.join(__dirname, '../../public');
  if (process.platform === 'darwin') return path.join(base, 'icon.icns');
  if (process.platform === 'win32')  return path.join(base, 'icon.ico');
  return path.join(base, 'icons', '256x256.png');
}

// Defensive Electron window settings: deny window.open / will-navigate to
// external URLs (route them through the OS handler instead), and lock down
// webPreferences so a renderer XSS bug can't escalate.
function _hardenWebContents(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        shell.openExternal(url);
      }
    } catch {}
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    // Allow navigation only within our own loaded file:// pages.
    if (!url.startsWith('file://')) {
      event.preventDefault();
      try {
        const u = new URL(url);
        if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(url);
      } catch {}
    }
  });
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
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      preload: path.join(__dirname, '../preload.js'),
    },
  });

  _hardenWebContents(mainWindow.webContents);
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
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      preload: path.join(__dirname, '../preload.js'),
    },
  });
  _hardenWebContents(settingsWindow.webContents);
  settingsWindow.loadFile(path.join(__dirname, '../renderer/settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

function toggleWindow() {
  // Defensive: window may have been destroyed (rare but possible if a future
  // change ever drops `event.preventDefault()` from window-all-closed).
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    return;
  }
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
  createWindow();
  setupTray(mainWindow);

  // ── Store init ──────────────────────────────────────────────────────────────
  store = new PersistentStore(app.getPath('userData'));
  await store.init();

  const _chatSessions = store.listSessions('chat');
  activeSessionId = _chatSessions[0]?.id ?? store.createSession(null, 'chat').id;

  // ── Tools + MCP ─────────────────────────────────────────────────────────────
  toolRegistry = new ToolRegistry();
  registerBuiltinTools(toolRegistry);

  mcpClientManager = new MCPClientManager(toolRegistry);
  await mcpClientManager.connectAll();

  // ── Providers + AgentRuntime ────────────────────────────────────────────────
  geminiProvider     = new GeminiProvider(toolRegistry);
  ollamaProvider     = new OllamaProvider(toolRegistry);
  groqProvider       = new GroqProvider(toolRegistry);
  openRouterProvider = new OpenRouterProvider(toolRegistry);

  providerManager = new ProviderManager({
    gemini:     geminiProvider,
    ollama:     ollamaProvider,
    groq:       groqProvider,
    openrouter: openRouterProvider,
  });
  providerManager.cacheModelLists().catch(() => {});

  const _emit = (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('agent-event', event);
  };

  agentRuntime = new AgentRuntime({
    toolRegistry,
    providerManager,
    store,
    emit: _emit,
  });

  // ── Hotkey ──────────────────────────────────────────────────────────────────
  const hotkey = SettingsStore.getHotkey() || process.env.HOTKEY || 'CommandOrControl+Shift+Space';
  if (!globalShortcut.register(hotkey, () => toggleWindow())) {
    console.error('Hotkey registration failed');
  }

  // ── Warm up Ollama models list ──────────────────────────────────────────────
  try {
    const models = await OllamaService.fetchModels();
    if (mainWindow) mainWindow.webContents.send('ollama-models-updated', models);
  } catch (error) {
    console.error('Failed to fetch Ollama models:', error);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', (event) => event.preventDefault());

// Flush early on before-quit so the latest writes survive even if a later
// hook in will-quit throws.
app.on('before-quit', () => {
  try { store?._flushNow?.(); } catch (err) { console.error('[main] before-quit flush failed:', err.message); }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // Best-effort MCP shutdown so stdio child processes don't linger.
  try { mcpClientManager?.disconnectAll?.().catch(() => {}); } catch {}
  store?.close();
});

// ─── Session / History IPC ────────────────────────────────────────────────────

ipcMain.handle('get-active-session', () => {
  if (!store || !activeSessionId) return null;
  return { session: store.getSession(activeSessionId), messages: store.getMessages(activeSessionId) };
});

ipcMain.handle('new-chat', () => {
  if (!store) return null;
  const session = store.createSession(null, 'chat');
  activeSessionId = session.id;
  _sessionContexts.delete(session.id);
  return { session, messages: [] };
});

ipcMain.handle('get-sessions', () => store?.listSessions() ?? []);

ipcMain.handle('load-session', (event, { sessionId } = {}) => {
  if (!store || !sessionId) return null;
  const session = store.getSession(sessionId);
  if (!session) return null;
  activeSessionId = sessionId;
  return { session, messages: store.getMessages(sessionId) };
});

ipcMain.handle('rename-session', (event, { sessionId, title } = {}) => {
  if (!store || !sessionId) return { success: false };
  store.renameSession(sessionId, title ?? '');
  return { success: true };
});

ipcMain.handle('pin-session', (event, { sessionId, pinned } = {}) => {
  if (!store || !sessionId) return { success: false };
  store.pinSession(sessionId, !!pinned);
  return { success: true };
});

ipcMain.handle('extract-file-text', async (event, buffer) => {
  try {
    // Cap the buffer to prevent an out-of-memory DoS from a misbehaving
    // renderer. 20MB is comfortably above any reasonable plain-text file.
    const MAX_BYTES = 20 * 1024 * 1024;
    const byteLen = buffer?.byteLength ?? buffer?.length ?? 0;
    if (byteLen > MAX_BYTES) return { success: false, error: 'file-too-large' };
    return { success: true, text: Buffer.from(buffer).toString('utf8') };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('search-sessions', (event, { query } = {}) => {
  if (!store || !query) return [];
  return store.searchMessages(query);
});

ipcMain.handle('save-document',   (event, { sessionId, doc } = {}) => (store && sessionId && doc) ? store.saveDocument(sessionId, doc) : null);
ipcMain.handle('get-documents',   (event, { sessionId } = {})      => (store && sessionId) ? store.getDocuments(sessionId) : []);
ipcMain.handle('delete-document', (event, { id } = {})             => { if (store && id) store.deleteDocument(id); });

ipcMain.handle('truncate-session', (event, { sessionId, fromIndex } = {}) => {
  if (!store || !sessionId || fromIndex == null) return { success: false };
  return { success: store.truncateMessages(sessionId, fromIndex) };
});

ipcMain.handle('delete-session', (event, { sessionId } = {}) => {
  if (!store || !sessionId) return { success: false };
  store.deleteSession(sessionId);
  if (sessionId === activeSessionId) {
    const remaining = store.listSessions();
    activeSessionId = remaining.length ? remaining[0].id : store.createSession(null, 'chat').id;
  }
  return { success: true, activeSessionId };
});

ipcMain.handle('export-session', async (event, { sessionId } = {}) => {
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

ipcMain.handle('get-memory', () => store?.getMemory() ?? []);

ipcMain.handle('approve-memories', (event, facts) => {
  if (!store || !Array.isArray(facts)) return { success: false };
  const VALID = new Set(['fact', 'preference', 'project', 'entity', 'procedural']);
  // Strip control chars + cap length so an LLM-extracted fact can't smuggle
  // delimiter sequences or megabyte-long payloads into the system prompt.
  const sanitize = (s) => String(s || '')
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
  for (const fact of facts) {
    if (typeof fact === 'string') {
      const safe = sanitize(fact);
      if (safe.length >= 4) store.addMemory(safe, 'auto', 'fact', 'chat');
    } else if (fact && typeof fact === 'object' && fact.content) {
      const safe = sanitize(fact.content);
      if (safe.length >= 4) {
        const cat = VALID.has(fact.category) ? fact.category : 'fact';
        store.addMemory(safe, 'auto', cat, 'chat');
      }
    }
  }
  return { success: true };
});

ipcMain.handle('add-memory', (event, { content, category } = {}) => {
  if (!store || !content?.trim()) return { success: false };
  // Cap memory content — too long is suspicious (likely prompt-injection
  // payload) and slows retrieval.
  const safe = String(content).trim().slice(0, 800);
  const VALID_CATS = new Set(['fact', 'preference', 'project', 'entity', 'procedural']);
  const cat = VALID_CATS.has(category) ? category : 'fact';
  const id = store.addMemory(safe, 'manual', cat, 'chat');
  return { success: true, id };
});

ipcMain.handle('delete-memory', (event, { id } = {}) => {
  if (!store || !id) return { success: false };
  store.deleteMemory(id);
  return { success: true };
});

ipcMain.handle('update-memory', (event, { id, content } = {}) => {
  if (!store || !id || !content?.trim()) return { success: false };
  store.updateMemory(id, content.trim());
  return { success: true };
});

ipcMain.handle('clear-all-memory', () => {
  if (!store) return { success: false };
  store.clearAllMemory();
  return { success: true };
});

ipcMain.handle('open-external', (event, url) => {
  if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
    shell.openExternal(url);
  }
});

// ─── TTS ────────────────────────────────────────────────────────────────────────

ipcMain.handle('get-tts-config',  ()        => SettingsStore.getTtsConfig());
ipcMain.handle('save-tts-config', (e, cfg)  => { SettingsStore.setTtsConfig(cfg || {}); return { success: true }; });

// ─── Feedback ──────────────────────────────────────────────────────────────────

ipcMain.handle('save-feedback', (e, data = {}) => {
  if (!store) return { success: false };
  // Cap each text field so a misbehaving renderer can't fill the DB.
  const cap = (s, n) => String(s || '').slice(0, n);
  const id = store.addFeedback({
    sessionId:         activeSessionId,
    userMessage:       cap(data.userMessage, 8000),
    assistantResponse: cap(data.assistantResponse, 32000),
    rating:            data.rating === 1 ? 1 : (data.rating === -1 ? -1 : 0),
    correction:        data.correction ? cap(data.correction, 8000) : null,
    model:             currentModel,
    agentId:           'friday',
    appMode:           'chat',
  });
  return { success: true, id };
});
ipcMain.handle('delete-feedback',       (e, id) => { store?.deleteFeedback(id); return { success: true }; });
ipcMain.handle('get-feedback-examples', ()      => store?.getPositiveFeedback(100) ?? []);

ipcMain.handle('get-suggestions', async (e, { query = '' } = {}) => {
  if (!store || !query) return { memories: [], episodes: [] };
  const [memories, episodes] = await Promise.all([
    store.getRelevantMemory(query, 6, 'chat'),
    store.getRelevantEpisodes(query, activeSessionId, 3),
  ]);
  return { memories, episodes };
});

ipcMain.handle('export-training-data', async (e, { format = 'openai' } = {}) => {
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

ipcMain.handle('get-custom-prompt',  () => SettingsStore.getCustomSystemPrompt());
ipcMain.handle('save-custom-prompt', (event, text) => {
  SettingsStore.setCustomSystemPrompt(text || '');
  return { success: true };
});

// ─── Whisper STT ───────────────────────────────────────────────────────────────

ipcMain.handle('get-whisper-config', () => SettingsStore.getWhisperConfig());
ipcMain.handle('save-whisper-config', (event, config) => { SettingsStore.setWhisperConfig(config || {}); return { success: true }; });

ipcMain.handle('transcribe-audio', (event, audioData, mimeType) => {
  return new Promise((resolve) => {
    // Cap renderer-supplied audio so a buggy/malicious renderer can't write
    // gigabytes to the temp directory before whisper-cli even starts.
    const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25MB ≈ ~25min mono WAV @16kHz
    const byteLen = audioData?.byteLength ?? audioData?.length ?? 0;
    if (byteLen > MAX_AUDIO_BYTES) return resolve({ success: false, error: 'audio-too-large' });

    const { exePath, modelPath, useCpu, extraArgs } = SettingsStore.getWhisperConfig();
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
      // -ng disables GPU offload — needed when whisper.cpp's CUDA build
      // doesn't support the user's GPU (e.g. Blackwell / sm_120 on older builds).
      if (useCpu) args.push('-ng');
      // Allow advanced users to append flags. spawn-style: split on whitespace,
      // no shell, so quotes / pipes can't escape. Cap to 16 tokens.
      if (typeof extraArgs === 'string' && extraArgs.trim()) {
        const extras = extraArgs.trim().split(/\s+/).slice(0, 16);
        args.push(...extras);
      }
      execFile(cleanExe, args, { timeout: 60000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
        try { fs.unlinkSync(audioIn); } catch {}
        try { if (inputFile !== audioIn) fs.unlinkSync(inputFile); } catch {}
        if (err) {
          // Surface stderr too — whisper-cli writes "failed to initialize whisper context"
          // and CUDA errors there, not in err.message. The renderer pattern-matches
          // these strings to suggest the CPU-mode toggle.
          const detail = (stderr || '').trim();
          const msg = detail ? `${err.message}\n${detail}` : err.message;
          console.error('[Whisper]', msg);
          return resolve({ success: false, error: msg });
        }
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

ipcMain.handle('clear-chat', () => {
  if (!store) return null;
  const session = store.createSession(null, 'chat');
  activeSessionId = session.id;
  _sessionContexts.delete(session.id);
  return { session };
});

// ─── Settings window ───────────────────────────────────────────────────────────

ipcMain.handle('open-settings', () => { createSettingsWindow(); return { success: true }; });

ipcMain.handle('get-settings', () => ({
  appShortcuts: SettingsStore.getAppShortcuts(),
  webBookmarks: SettingsStore.getWebBookmarks(),
}));

ipcMain.handle('save-settings', (event, settings) => {
  try {
    const appShortcutsRaw = Array.isArray(settings?.appShortcuts) ? settings.appShortcuts : [];
    const webBookmarksRaw = Array.isArray(settings?.webBookmarks) ? settings.webBookmarks : [];

    // Validate shortcuts: name + path must be non-empty strings; args must be
    // an array (or a string we'll defer-split). The path itself is a user
    // choice — we don't whitelist binaries — but reject obviously dangerous
    // patterns so a typo'd settings save can't permanently arm the launcher.
    const appShortcuts = [];
    for (const s of appShortcutsRaw) {
      if (!s || typeof s.name !== 'string' || typeof s.path !== 'string') continue;
      const name = s.name.trim().slice(0, 60);
      const exePath = s.path.trim();
      if (!name || !exePath) continue;
      // Reject inline shell pipelines. The launcher uses spawn (no shell), so
      // these would not actually be interpreted, but it's a clear sign of a
      // typo or paste-attack rather than a legitimate shortcut.
      if (/[;&|`$]/.test(exePath)) continue;
      let args = [];
      if (Array.isArray(s.args)) args = s.args.map(a => String(a)).slice(0, 32);
      else if (typeof s.args === 'string') args = s.args.split(/\s+/).filter(Boolean).slice(0, 32);
      appShortcuts.push({ name, path: exePath, args });
    }

    // Validate bookmarks: every URL must be http(s).
    const webBookmarks = [];
    for (const b of webBookmarksRaw) {
      if (!b || typeof b.name !== 'string' || typeof b.url !== 'string') continue;
      const name = b.name.trim().slice(0, 60);
      let url = b.url.trim();
      if (!name || !url) continue;
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      try {
        const u = new URL(url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
        webBookmarks.push({ name, url: u.toString() });
      } catch { /* skip invalid */ }
    }

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

function getGoogleCredentialsPath() {
  return process.env.GOOGLE_CREDENTIALS_PATH || path.join(process.cwd(), 'credentials.json');
}

ipcMain.handle('get-integrations-status', async () => {
  const credentialsPath = getGoogleCredentialsPath();
  const googleCredentialsPresent = fs.existsSync(credentialsPath);
  const googleTokenPresent = GoogleCalendarService.hasToken();
  const googleEmail = googleTokenPresent ? GoogleCalendarService.getAccountEmail() : null;

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

ipcMain.handle('test-integration', async (event, { name } = {}) => {
  const n = String(name || '').toLowerCase();
  try {
    if (n === 'gemini') {
      const models = await GeminiService.fetchModels();
      return { success: true, details: { modelCount: models.length } };
    }
    if (n === 'groq') {
      const models = await GroqService.fetchModels();
      return { success: true, details: { modelCount: models.length } };
    }
    if (n === 'openrouter') {
      const models = await OpenRouterService.fetchModels();
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

ipcMain.handle('google-calendar-connect', async () => {
  try {
    const now = new Date();
    const start = new Date(now.getTime() - 60 * 1000).toISOString();
    const end = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const events = await GoogleCalendarService.getEventsInRange(start, end);
    return { success: true, details: { upcomingCount: Array.isArray(events) ? events.length : 0 } };
  } catch (error) { return { success: false, error: error.message || String(error) }; }
});

ipcMain.handle('google-calendar-logout', async () => {
  try {
    GoogleCalendarService.logout();
    return { success: true };
  } catch (error) { return { success: false, error: error.message || String(error) }; }
});

// ─── Models / Ollama ───────────────────────────────────────────────────────────

ipcMain.handle('fetch-ollama-models', async () => {
  try { return { success: true, models: await OllamaService.fetchModels() }; }
  catch (error) { console.error('Error fetching Ollama models:', error); return { success: false, models: [] }; }
});

// Per-model capability lookup (e.g. ['completion','tools','thinking']) — used by
// the UI to decide whether to show the reasoning-effort toggle. Cached forever
// per model name since capabilities are baked into the model on `ollama create`.
const _ollamaModelCapsCache = new Map();
ipcMain.handle('get-ollama-model-capabilities', async (_event, { model } = {}) => {
  if (!model || typeof model !== 'string') return { success: false, capabilities: [] };
  if (!_ollamaModelCapsCache.has(model)) {
    const axios = require('axios');
    _ollamaModelCapsCache.set(model, (async () => {
      try {
        const res = await axios.post(
          `${OllamaService.baseURL}/api/show`,
          { model },
          { timeout: 5000 }
        );
        return Array.isArray(res.data?.capabilities) ? res.data.capabilities : [];
      } catch (err) {
        console.warn(`[ollama-caps] failed for ${model}:`, err.message);
        return [];
      }
    })());
  }
  const capabilities = await _ollamaModelCapsCache.get(model);
  return { success: true, capabilities };
});

ipcMain.handle('get-models', async () => {
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

ipcMain.handle('get-model-slots',  () => SettingsStore.getModelSlots());
ipcMain.handle('save-model-slots', (event, slots) => { SettingsStore.setModelSlots(slots); return { success: true }; });

// ─── API keys ──────────────────────────────────────────────────────────────────

ipcMain.handle('get-groq-key',   () => ({ key: SettingsStore.getGroqApiKey() }));
ipcMain.handle('save-groq-key',  (_, { key } = {}) => { SettingsStore.setGroqApiKey(key || ''); return { success: true }; });

ipcMain.handle('get-gemini-key', () => ({ key: SettingsStore.getGeminiApiKey() }));
ipcMain.handle('save-gemini-key', (_, { key } = {}) => {
  SettingsStore.setGeminiApiKey(key || '');
  GeminiService.genAI = null;
  return { success: true };
});

ipcMain.handle('get-brave-key',  () => ({ key: SettingsStore.getBraveApiKey() }));
ipcMain.handle('save-brave-key', (_, { key } = {}) => { SettingsStore.setBraveApiKey(key || ''); return { success: true }; });

ipcMain.handle('get-openrouter-key',  () => ({ key: SettingsStore.getOpenRouterApiKey() }));
ipcMain.handle('save-openrouter-key', (_, { key } = {}) => { SettingsStore.setOpenRouterApiKey(key || ''); return { success: true }; });

ipcMain.handle('get-ollama-url',  () => ({ url: SettingsStore.getOllamaBaseUrl() }));
ipcMain.handle('save-ollama-url', (_, { url } = {}) => {
  // Refuse anything that doesn't parse as http(s) on a private/loopback host.
  // Otherwise a poisoned settings file could silently redirect every Ollama
  // request to an external server, exfiltrating prompts and memory facts.
  const candidate = (url || '').trim() || 'http://localhost:11434';
  let parsed;
  try { parsed = new URL(candidate); }
  catch { return { success: false, error: 'Invalid URL.' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { success: false, error: 'Ollama URL must be http(s).' };
  }
  const host = parsed.hostname.toLowerCase();
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1'
    || host.endsWith('.local')
    || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (!isLocal) {
    return { success: false, error: 'Ollama URL must point at a local/private network address.' };
  }
  SettingsStore.setOllamaBaseUrl(candidate);
  return { success: true };
});

// ─── Hotkey ────────────────────────────────────────────────────────────────────

ipcMain.handle('get-hotkey',  () => ({ hotkey: SettingsStore.getHotkey() }));
ipcMain.handle('save-hotkey', (_, { hotkey: newHotkey } = {}) => {
  const key = (newHotkey || 'CommandOrControl+Shift+Space').trim();
  try {
    const oldHotkey = SettingsStore.getHotkey();
    globalShortcut.unipcMain.handle(oldHotkey);
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

ipcMain.handle('get-wake-word-config',  () => SettingsStore.getWakeWordConfig());
ipcMain.handle('save-wake-word-config', (e, cfg = {}) => { SettingsStore.setWakeWordConfig(cfg); return { success: true, config: SettingsStore.getWakeWordConfig() }; });

ipcMain.handle('show-window', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  return { success: true };
});

ipcMain.handle('minimize-window', () => { if (mainWindow) mainWindow.hide(); });
ipcMain.handle('close-window',    () => app.quit());

// ─── AgentRuntime IPC ──────────────────────────────────────────────────────────

ipcMain.on('agent-permission-response', (_, { requestId, approved, alwaysAllow } = {}) => {
  if (agentRuntime && requestId) agentRuntime.resolvePermission(requestId, !!approved, !!alwaysAllow);
});

const INCOGNITO_SESSION_ID = '__incognito__';

ipcMain.handle('send-agent-message', async (event, data = {}) => {
  const { message, displayMessage, model, modelType, sessionId: reqSessionId, images = [], forceSearch = false, incognito = false, reasoningEffort = null } = data;
  if (!agentRuntime || !model) return { success: false, error: 'AgentRuntime not ready' };

  const sessionId = incognito ? INCOGNITO_SESSION_ID : (reqSessionId || activeSessionId);
  if (!sessionId) return { success: false, error: 'No active session' };

  let ctx = _sessionContexts.get(sessionId);
  if (!ctx) {
    ctx = new SessionContext({
      sessionId,
      permissionPolicy: PermissionPolicy.forChat(),
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
      reasoningEffort,
    });
    return { success: true, sessionId: incognito ? null : sessionId, result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('cancel-agent-message', (_, { sessionId: reqSessionId } = {}) => {
  const sessionId = reqSessionId || activeSessionId;
  const ctx = sessionId && _sessionContexts.get(sessionId);
  if (ctx && agentRuntime) agentRuntime.abort(ctx);
  return { success: true };
});

ipcMain.handle('clear-incognito', () => {
  if (agentRuntime) agentRuntime.clearIncognitoHistory();
  _sessionContexts.delete(INCOGNITO_SESSION_ID);
  return { success: true };
});

