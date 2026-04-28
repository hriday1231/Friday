const Store = require('electron-store');

/**
 * Central settings store for Friday.
 * Persists:
 * - appShortcuts: [{ name, path, args }]
 * - webBookmarks: [{ name, url }]
 */
class SettingsStore {
  constructor() {
    this.store = new Store({
      name: 'friday-settings',
      defaults: {
        appShortcuts: [],
        whisperExePath:   '',
        whisperModelPath: '',
        customSystemPrompt: '',
        groqApiKey: '',
        geminiApiKey: '',
        braveApiKey: '',
        openRouterApiKey: '',
        ollamaBaseUrl: 'http://localhost:11434',
        hotkey: 'CommandOrControl+Shift+Space',
        screenContextEnabled:  false,
        screenContextInterval: 60,  // seconds between captures
        ttsAutoRead: false,
        ttsVoice:    '',    // SpeechSynthesis voice name; empty = browser default
        ttsRate:     1.0,
        ttsPitch:    1.0,
        wakeWordEnabled: false,
        wakeWordPhrase:  'hey friday', // phrase to listen for
        modelSlots: {
          chat:   { model: 'gpt-oss:20b',           type: 'ollama' },
          vision: { model: 'llama3.2-vision:11b',   type: 'ollama' },
          cloud:  { model: 'llama-3.3-70b-versatile', type: 'groq' },
        },
        // Handy defaults so commands like "Open YT" work immediately.
        webBookmarks: [
          { name: 'YT', url: 'https://youtube.com' },
          { name: 'YouTube', url: 'https://youtube.com' },
          { name: 'Insta', url: 'https://instagram.com' },
          { name: 'Instagram', url: 'https://instagram.com' }
        ]
      }
    });
  }

  _normalizeName(name) {
    return (name || '').trim().toLowerCase();
  }

  // ----- App shortcuts -----

  getAppShortcuts() {
    return this.store.get('appShortcuts', []);
  }

  setAppShortcuts(shortcuts) {
    this.store.set('appShortcuts', Array.isArray(shortcuts) ? shortcuts : []);
  }

  listAppShortcutNames() {
    return this.getAppShortcuts().map(s => s.name).filter(Boolean);
  }

  findAppShortcutByName(name) {
    const target = this._normalizeName(name);
    if (!target) return null;
    return this.getAppShortcuts().find(
      s => this._normalizeName(s.name) === target
    ) || null;
  }

  // ----- Bookmarks -----

  getWebBookmarks() {
    return this.store.get('webBookmarks', []);
  }

  setWebBookmarks(bookmarks) {
    this.store.set('webBookmarks', Array.isArray(bookmarks) ? bookmarks : []);
  }

  listBookmarkNames() {
    return this.getWebBookmarks().map(b => b.name).filter(Boolean);
  }

  findBookmarkByName(name) {
    const target = this._normalizeName(name);
    if (!target) return null;
    return this.getWebBookmarks().find(
      b => this._normalizeName(b.name) === target
    ) || null;
  }

  // ----- Whisper (local speech recognition) -----

  getWhisperConfig() {
    return {
      exePath:   this.store.get('whisperExePath',   ''),
      modelPath: this.store.get('whisperModelPath', ''),
    };
  }

  setWhisperConfig({ exePath = '', modelPath = '' } = {}) {
    this.store.set('whisperExePath',   exePath.trim());
    this.store.set('whisperModelPath', modelPath.trim());
  }

  // ----- Custom system prompt (persona) -----

  getCustomSystemPrompt() {
    return this.store.get('customSystemPrompt', '');
  }

  setCustomSystemPrompt(text) {
    this.store.set('customSystemPrompt', (text || '').trim());
  }

  // ----- Groq API key -----

  getGroqApiKey() {
    return this.store.get('groqApiKey', '');
  }

  setGroqApiKey(key) {
    this.store.set('groqApiKey', (key || '').trim());
  }

  // ----- Gemini API key -----

  getGeminiApiKey() {
    return this.store.get('geminiApiKey', '');
  }

  setGeminiApiKey(key) {
    this.store.set('geminiApiKey', (key || '').trim());
  }

  // ----- Brave Search API key -----

  getBraveApiKey() {
    return this.store.get('braveApiKey', '');
  }

  setBraveApiKey(key) {
    this.store.set('braveApiKey', (key || '').trim());
  }

  // ----- OpenRouter API key -----

  getOpenRouterApiKey() {
    return this.store.get('openRouterApiKey', '');
  }

  setOpenRouterApiKey(key) {
    this.store.set('openRouterApiKey', (key || '').trim());
  }

  // ----- Ollama base URL -----

  getOllamaBaseUrl() {
    return this.store.get('ollamaBaseUrl', 'http://localhost:11434');
  }

  setOllamaBaseUrl(url) {
    this.store.set('ollamaBaseUrl', (url || 'http://localhost:11434').trim());
  }

  // ----- Global hotkey -----

  getHotkey() {
    return this.store.get('hotkey', 'CommandOrControl+Shift+Space');
  }

  setHotkey(key) {
    this.store.set('hotkey', (key || 'CommandOrControl+Shift+Space').trim());
  }

  // ----- Model slots -----

  getModelSlots() {
    return this.store.get('modelSlots', {
      chat:   { model: 'gpt-oss:20b',             type: 'ollama' },
      vision: { model: 'llama3.2-vision:11b',     type: 'ollama' },
      cloud:  { model: 'llama-3.3-70b-versatile', type: 'groq'   },
    });
  }

  setModelSlots(slots) {
    if (slots && typeof slots === 'object') {
      this.store.set('modelSlots', slots);
    }
  }

  // ----- URL resolution -----

  /**
   * Given a name like "YT", resolve to a URL from bookmarks.
   */
  resolveUrlFromName(name) {
    if (!name) return null;
    const bookmark = this.findBookmarkByName(name);
    return bookmark?.url ? this.normalizeUrl(bookmark.url) : null;
  }

  _looksLikeUrl(input) {
    if (!input) return false;
    const url = input.trim();
    // Has an explicit protocol (http://, https://, ftp://, etc.)
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) return true;
    // Looks like a domain/path (e.g. "google.com" or "google.com/search?q=foo")
    if (/^[^\s]+\.[^\s]+$/.test(url)) return true;
    return false;
  }

  normalizeUrl(input) {
    if (!input) return null;
    const url = input.trim();
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) return url;
    if (/^[^\s]+\.[^\s]+$/.test(url)) return `https://${url}`;
    return url;
  }

  // ----- Screen context -----

  getScreenContextConfig() {
    return {
      enabled:  this.store.get('screenContextEnabled',  false),
      interval: this.store.get('screenContextInterval', 60),
    };
  }

  setScreenContextConfig({ enabled, interval } = {}) {
    if (typeof enabled  === 'boolean') this.store.set('screenContextEnabled',  enabled);
    if (interval !== undefined)        this.store.set('screenContextInterval', Number(interval) || 60);
  }

  // ----- TTS -----

  getTtsConfig() {
    return {
      autoRead: this.store.get('ttsAutoRead', false),
      voice:    this.store.get('ttsVoice',    ''),
      rate:     this.store.get('ttsRate',     1.0),
      pitch:    this.store.get('ttsPitch',    1.0),
    };
  }

  setTtsConfig({ autoRead, voice, rate, pitch } = {}) {
    if (typeof autoRead === 'boolean') this.store.set('ttsAutoRead', autoRead);
    if (voice    !== undefined) this.store.set('ttsVoice',    String(voice || ''));
    if (rate     !== undefined) this.store.set('ttsRate',     Number(rate)  || 1.0);
    if (pitch    !== undefined) this.store.set('ttsPitch',    Number(pitch) || 1.0);
  }

  // ----- Wake word -----

  getWakeWordConfig() {
    return {
      enabled: this.store.get('wakeWordEnabled', false),
      phrase:  this.store.get('wakeWordPhrase',  'hey friday'),
    };
  }

  setWakeWordConfig({ enabled, phrase } = {}) {
    if (typeof enabled === 'boolean') this.store.set('wakeWordEnabled', enabled);
    if (phrase !== undefined) this.store.set('wakeWordPhrase', String(phrase || 'hey friday').toLowerCase().trim());
  }
}

module.exports = new SettingsStore();
