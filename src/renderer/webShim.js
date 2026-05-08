/**
 * webShim.js — browser-side replacement for window.electronAPI.
 *
 * Loaded in place of preload.js when the renderer is opened in a real browser
 * (i.e., served by src/main/webBridge.js). Mirrors every method in src/preload.js
 * so the rest of the renderer code (renderer.js, ChatInterface.js, settings.js,
 * etc.) runs unmodified.
 *
 * Wire format matches webBridge.js:
 *   - invoke-style → POST /ipc/<channel> (JSON body, JSON response)
 *   - binary args  → POST /ipc/<channel> (multipart/form-data)
 *   - on*Event     → WebSocket /events
 *   - respondAgentPermission → WS message { type: 'permission-response', ... }
 */
(function () {
  'use strict';

  if (window.electronAPI) {
    console.warn('[webShim] window.electronAPI already defined — skipping shim');
    return;
  }

  const BASE = '';

  // ── HTTP IPC ───────────────────────────────────────────────────────────────
  async function _post(channel, body, opts = {}) {
    const init = { method: 'POST' };
    if (opts.multipart) {
      init.body = body; // FormData; browser sets Content-Type with boundary
    } else if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${BASE}/ipc/${channel}`, init);
    let json;
    try { json = await res.json(); }
    catch { throw new Error(`Bad response from /ipc/${channel} (${res.status})`); }
    if (!res.ok) throw new Error(json?.error || `${channel} failed (${res.status})`);
    return json.__wrapped ? json.value : json;
  }

  // Binary upload helper. First arg is binary (Blob/Uint8Array/ArrayBuffer);
  // remaining args are stringified and sent as form fields.
  async function _postBinary(channel, binary, ...extras) {
    const fd = new FormData();
    let blob;
    if (binary instanceof Blob) blob = binary;
    else if (binary instanceof ArrayBuffer) blob = new Blob([binary]);
    else if (binary && binary.buffer instanceof ArrayBuffer) blob = new Blob([binary]);
    else blob = new Blob([binary || '']);
    fd.append('file', blob, 'upload.bin');
    extras.forEach((v, i) => fd.append(`arg${i}`, v == null ? '' : String(v)));
    return _post(channel, fd, { multipart: true });
  }

  // ── WebSocket events ───────────────────────────────────────────────────────
  const subscribers = new Map(); // channel -> Set<callback>
  let ws = null;
  let wsReadyPromise = null;
  function _ensureWs() {
    if (ws && ws.readyState <= 1) return wsReadyPromise;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/events`);
    wsReadyPromise = new Promise((resolve) => {
      ws.addEventListener('open', () => resolve());
    });
    ws.addEventListener('message', (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      const subs = subscribers.get(msg.channel);
      if (!subs) return;
      for (const cb of subs) {
        try { cb(msg.data); } catch (err) { console.error(`[webShim] handler for ${msg.channel} threw:`, err); }
      }
    });
    ws.addEventListener('close', () => {
      ws = null;
      // Auto-reconnect after a short delay so push events keep flowing
      setTimeout(_ensureWs, 1000);
    });
    ws.addEventListener('error', () => {
      try { ws.close(); } catch {}
    });
    return wsReadyPromise;
  }
  function _subscribe(channel, callback) {
    let subs = subscribers.get(channel);
    if (!subs) { subs = new Set(); subscribers.set(channel, subs); }
    subs.add(callback);
    _ensureWs();
    return () => subs.delete(callback);
  }
  async function _wsSend(obj) {
    await _ensureWs();
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  // ── electronAPI mirror ─────────────────────────────────────────────────────
  window.electronAPI = {
    // Chat / sessions
    clearChat:        () => _post('clear-chat'),
    getActiveSession: () => _post('get-active-session'),
    newChat:          () => _post('new-chat'),
    getSessions:      () => _post('get-sessions'),
    loadSession:      (sessionId) => _post('load-session',   { sessionId }),
    deleteSession:    (sessionId) => _post('delete-session', { sessionId }),
    renameSession:    (sessionId, title)      => _post('rename-session',   { sessionId, title }),
    pinSession:       (sessionId, pinned)     => _post('pin-session',      { sessionId, pinned }),
    searchSessions:   (query)                 => _post('search-sessions',  { query }),
    truncateSession:  (sessionId, fromIndex)  => _post('truncate-session', { sessionId, fromIndex }),
    exportSession:    (sessionId)             => _post('export-session',   { sessionId }),

    // Memory
    getMemory:        () => _post('get-memory'),
    addMemory:        (content, category) => _post('add-memory', { content, category }),
    deleteMemory:     (id) => _post('delete-memory', { id }),
    updateMemory:     (id, content) => _post('update-memory', { id, content }),
    clearAllMemory:   () => _post('clear-all-memory'),
    approveMemories:  (facts) => _post('approve-memories', facts),
    onMemoryProposal: (callback) => _subscribe('memory-proposal', callback),

    // Documents
    saveDocument:   ({ sessionId, doc })  => _post('save-document',   { sessionId, doc }),
    getDocuments:   ({ sessionId })        => _post('get-documents',   { sessionId }),
    deleteDocument: ({ id })               => _post('delete-document', { id }),

    // Settings (general)
    getSettings:        () => _post('get-settings'),
    saveSettings:       (settings) => _post('save-settings', settings),
    // In web mode we open settings as a new browser tab; the IPC handler would
    // otherwise spawn an Electron BrowserWindow you can't see from the browser.
    openSettings: async () => {
      window.open('/settings.html', '_blank', 'noopener,noreferrer');
      return { success: true };
    },
    openExternal:       (url) => _post('open-external', url),
    getCustomPrompt:    () => _post('get-custom-prompt'),
    saveCustomPrompt:   (text) => _post('save-custom-prompt', text),

    // Whisper / voice
    getWhisperConfig:  () => _post('get-whisper-config'),
    saveWhisperConfig: (config) => _post('save-whisper-config', config),
    transcribeAudio:   (audioData, mimeType) => _postBinary('transcribe-audio', audioData, mimeType),

    // Wake word
    getWakeWordConfig:  () => _post('get-wake-word-config'),
    saveWakeWordConfig: (cfg) => _post('save-wake-word-config', cfg),

    // Integrations
    getIntegrationsStatus: () => _post('get-integrations-status'),
    testIntegration:       (name) => _post('test-integration', { name }),
    googleCalendarConnect: () => _post('google-calendar-connect'),
    googleCalendarLogout:  () => _post('google-calendar-logout'),

    // Models / Ollama / API keys
    getModels:           () => _post('get-models'),
    fetchOllamaModels:   () => _post('fetch-ollama-models'),
    getModelSlots:       () => _post('get-model-slots'),
    saveModelSlots:      (slots) => _post('save-model-slots', slots),
    getGroqKey:          () => _post('get-groq-key'),
    saveGroqKey:         (key) => _post('save-groq-key',  { key }),
    getGeminiKey:        () => _post('get-gemini-key'),
    saveGeminiKey:       (key) => _post('save-gemini-key', { key }),
    getBraveKey:         () => _post('get-brave-key'),
    saveBraveKey:        (key) => _post('save-brave-key', { key }),
    getOpenRouterKey:    () => _post('get-openrouter-key'),
    saveOpenRouterKey:   (key) => _post('save-openrouter-key', { key }),
    getOllamaUrl:        () => _post('get-ollama-url'),
    saveOllamaUrl:       (url) => _post('save-ollama-url', { url }),
    onOllamaModelsUpdated: (callback) => _subscribe('ollama-models-updated', callback),

    // Hotkey (no-op effect in browser, but settings UI still needs the round-trip)
    getHotkey:  () => _post('get-hotkey'),
    saveHotkey: (hotkey) => _post('save-hotkey', { hotkey }),

    // TTS
    getTtsConfig:  () => _post('get-tts-config'),
    saveTtsConfig: (cfg) => _post('save-tts-config', cfg),

    // Window controls — no-ops in browser (close the tab manually if needed)
    minimizeWindow: async () => ({ success: true }),
    closeWindow:    async () => ({ success: true }),
    showWindow:     async () => ({ success: true }),

    // File text extraction
    extractFileText: (buffer, fileName) => _postBinary('extract-file-text', buffer, fileName),

    // Feedback / training
    saveFeedback:        (data) => _post('save-feedback', data),
    deleteFeedback:      (id)   => _post('delete-feedback', id),
    getFeedbackExamples: ()     => _post('get-feedback-examples'),
    exportTrainingData:  (opts) => _post('export-training-data', opts),
    getSuggestions:      (opts) => _post('get-suggestions', opts),

    // Session title push (kept for parity even if main never sends on this channel)
    onSessionTitleSet: (callback) => _subscribe('session-title-set', callback),

    // Agent runtime
    sendAgentMessage:   (data) => _post('send-agent-message', data),
    cancelAgentMessage: (sessionId) => _post('cancel-agent-message', { sessionId }),
    clearIncognito:     () => _post('clear-incognito'),
    onAgentEvent:       (callback) => _subscribe('agent-event', callback),
    respondAgentPermission: (requestId, approved, alwaysAllow = false) => {
      _wsSend({ type: 'permission-response', requestId, approved, alwaysAllow });
    },
  };

  console.log('[webShim] window.electronAPI installed (web bridge mode)');
})();
