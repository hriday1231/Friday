const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  clearChat: () => ipcRenderer.invoke('clear-chat'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  openSettings:     () => ipcRenderer.invoke('open-settings'),
  openExternal:     (url) => ipcRenderer.invoke('open-external', url),
  getCustomPrompt:  () => ipcRenderer.invoke('get-custom-prompt'),
  saveCustomPrompt: (text) => ipcRenderer.invoke('save-custom-prompt', text),
  getWhisperConfig: () => ipcRenderer.invoke('get-whisper-config'),
  saveWhisperConfig:(config) => ipcRenderer.invoke('save-whisper-config', config),
  transcribeAudio:  (audioData, mimeType) => ipcRenderer.invoke('transcribe-audio', audioData, mimeType),
  getIntegrationsStatus: () => ipcRenderer.invoke('get-integrations-status'),
  testIntegration: (name) => ipcRenderer.invoke('test-integration', { name }),
  googleCalendarConnect: () => ipcRenderer.invoke('google-calendar-connect'),
  googleCalendarLogout: () => ipcRenderer.invoke('google-calendar-logout'),
  fetchOllamaModels: () => ipcRenderer.invoke('fetch-ollama-models'),
  getModels: () => ipcRenderer.invoke('get-models'),
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  onOllamaModelsUpdated: (callback) => {
    const handler = (event, models) => callback(models);
    ipcRenderer.on('ollama-models-updated', handler);
    return () => ipcRenderer.removeListener('ollama-models-updated', handler);
  },

  // ── File text extraction (fallback) ──────────────────────────────────────
  extractFileText:  (buffer, fileName) => ipcRenderer.invoke('extract-file-text', buffer, fileName),

  exportSession:    (sessionId)             => ipcRenderer.invoke('export-session', { sessionId }),

  // ── Session / History ────────────────────────────────────────────────────
  getActiveSession: ()                      => ipcRenderer.invoke('get-active-session'),
  newChat:          ()                      => ipcRenderer.invoke('new-chat'),
  getSessions:      ()                      => ipcRenderer.invoke('get-sessions'),
  loadSession:      (sessionId)             => ipcRenderer.invoke('load-session',    { sessionId }),
  deleteSession:    (sessionId)             => ipcRenderer.invoke('delete-session',  { sessionId }),
  renameSession:    (sessionId, title)      => ipcRenderer.invoke('rename-session',  { sessionId, title }),
  pinSession:       (sessionId, pinned)     => ipcRenderer.invoke('pin-session',     { sessionId, pinned }),
  searchSessions:   (query)                 => ipcRenderer.invoke('search-sessions',  { query }),
  truncateSession:  (sessionId, fromIndex)  => ipcRenderer.invoke('truncate-session', { sessionId, fromIndex }),

  // ── Long-term Memory ─────────────────────────────────────────────────────
  getMemory:    ()                => ipcRenderer.invoke('get-memory'),
  addMemory:    (content, category) => ipcRenderer.invoke('add-memory', { content, category }),
  deleteMemory: (id)              => ipcRenderer.invoke('delete-memory', { id }),
  updateMemory:    (id, content)   => ipcRenderer.invoke('update-memory',    { id, content }),
  clearAllMemory:  ()              => ipcRenderer.invoke('clear-all-memory'),

  onMemoryProposal: (callback) => {
    const handler = (event, facts) => callback(facts);
    ipcRenderer.on('memory-proposal', handler);
    return () => ipcRenderer.removeListener('memory-proposal', handler);
  },

  approveMemories: (facts) => ipcRenderer.invoke('approve-memories', facts),

  saveDocument:  ({ sessionId, doc })  => ipcRenderer.invoke('save-document',  { sessionId, doc }),
  getDocuments:  ({ sessionId })        => ipcRenderer.invoke('get-documents',  { sessionId }),
  deleteDocument:({ id })               => ipcRenderer.invoke('delete-document', { id }),

  onSessionTitleSet: (callback) => {
    ipcRenderer.on('session-title-set', callback);
    return () => ipcRenderer.removeListener('session-title-set', callback);
  },

  // ── Feedback / few-shot library ───────────────────────────────────────────
  saveFeedback:         (data) => ipcRenderer.invoke('save-feedback', data),
  deleteFeedback:       (id)   => ipcRenderer.invoke('delete-feedback', id),
  getFeedbackExamples:  ()     => ipcRenderer.invoke('get-feedback-examples'),
  exportTrainingData:   (opts) => ipcRenderer.invoke('export-training-data', opts),
  getSuggestions:       (opts) => ipcRenderer.invoke('get-suggestions', opts),

  // ── Model slots (chat / vision / cloud presets) ──────────────────────────
  getModelSlots:  ()      => ipcRenderer.invoke('get-model-slots'),
  saveModelSlots: (slots) => ipcRenderer.invoke('save-model-slots', slots),

  // ── API keys ──────────────────────────────────────────────────────────────
  getGroqKey:   ()    => ipcRenderer.invoke('get-groq-key'),
  saveGroqKey:  (key) => ipcRenderer.invoke('save-groq-key',   { key }),
  getGeminiKey: ()    => ipcRenderer.invoke('get-gemini-key'),
  saveGeminiKey:(key) => ipcRenderer.invoke('save-gemini-key', { key }),
  getBraveKey:  ()    => ipcRenderer.invoke('get-brave-key'),
  saveBraveKey: (key) => ipcRenderer.invoke('save-brave-key',  { key }),

  getOpenRouterKey:  ()    => ipcRenderer.invoke('get-openrouter-key'),
  saveOpenRouterKey: (key) => ipcRenderer.invoke('save-openrouter-key', { key }),

  // ── Ollama URL ────────────────────────────────────────────────────────────
  getOllamaUrl:  ()    => ipcRenderer.invoke('get-ollama-url'),
  saveOllamaUrl: (url) => ipcRenderer.invoke('save-ollama-url', { url }),

  // ── Global hotkey ─────────────────────────────────────────────────────────
  getHotkey:  ()       => ipcRenderer.invoke('get-hotkey'),
  saveHotkey: (hotkey) => ipcRenderer.invoke('save-hotkey', { hotkey }),

  // ── Screen context ────────────────────────────────────────────────────────
  getScreenContextConfig:  ()    => ipcRenderer.invoke('get-screen-context-config'),
  saveScreenContextConfig: (cfg) => ipcRenderer.invoke('save-screen-context-config', cfg),

  // ── TTS ───────────────────────────────────────────────────────────────────
  getTtsConfig:  ()    => ipcRenderer.invoke('get-tts-config'),
  saveTtsConfig: (cfg) => ipcRenderer.invoke('save-tts-config', cfg),

  // ── Wake word ─────────────────────────────────────────────────────────────
  getWakeWordConfig:  ()    => ipcRenderer.invoke('get-wake-word-config'),
  saveWakeWordConfig: (cfg) => ipcRenderer.invoke('save-wake-word-config', cfg),
  showWindow:         ()    => ipcRenderer.invoke('show-window'),

  // ── AgentRuntime event-driven chat ────────────────────────────────────────
  sendAgentMessage:   (data)       => ipcRenderer.invoke('send-agent-message', data),
  cancelAgentMessage: (sessionId)  => ipcRenderer.invoke('cancel-agent-message', { sessionId }),
  clearIncognito:     ()           => ipcRenderer.invoke('clear-incognito'),

  onAgentEvent: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('agent-event', handler);
    return () => ipcRenderer.removeListener('agent-event', handler);
  },

  respondAgentPermission: (requestId, approved, alwaysAllow = false) => {
    ipcRenderer.send('agent-permission-response', { requestId, approved, alwaysAllow });
  },
});
