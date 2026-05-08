const Store = require('electron-store');

// Lazily resolved Electron safeStorage. Returned getter returns null if
// safeStorage isn't ready (renderer-only module loads, pre-app-ready, or
// older Electron versions). When null, we fall back to plaintext to keep
// the app functional — but log so the user knows the keys aren't encrypted.
let _safeStorageWarned = false;
function _safe() {
  try {
    const { safeStorage, app } = require('electron');
    if (!safeStorage || !app?.isReady?.()) return null;
    if (!safeStorage.isEncryptionAvailable()) {
      if (!_safeStorageWarned) {
        _safeStorageWarned = true;
        console.warn('[SettingsStore] safeStorage encryption not available on this system; API keys will be stored in plaintext.');
      }
      return null;
    }
    return safeStorage;
  } catch { return null; }
}

const ENC_PREFIX = 'enc:'; // marks a value as base64-encoded ciphertext
function _encrypt(plaintext) {
  if (!plaintext) return '';
  const ss = _safe();
  if (!ss) return String(plaintext);
  try {
    const buf = ss.encryptString(String(plaintext));
    return ENC_PREFIX + buf.toString('base64');
  } catch { return String(plaintext); }
}
function _decrypt(stored) {
  if (!stored || typeof stored !== 'string') return '';
  if (!stored.startsWith(ENC_PREFIX)) return stored; // legacy plaintext value
  const ss = _safe();
  if (!ss) return ''; // ciphertext present but no key available — fail closed
  try {
    const buf = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64');
    return ss.decryptString(buf);
  } catch { return ''; }
}

/**
 * Central settings store for Friday.
 * Persists:
 * - appShortcuts: [{ name, path, args }]
 * - webBookmarks: [{ name, url }]
 *
 * Cloud API keys are encrypted at rest via Electron safeStorage (DPAPI on
 * Windows, Keychain on macOS, Secret Service / kwallet on Linux). Reads
 * transparently decrypt; writes transparently encrypt. Legacy plaintext
 * values are still readable so existing installs upgrade in place — they're
 * re-encrypted the next time the user saves.
 */
class SettingsStore {
  constructor() {
    this.store = new Store({
      name: 'friday-settings',
      defaults: {
        appShortcuts: [],
        whisperExePath:   '',
        whisperModelPath: '',
        whisperUseCpu:    false,
        whisperExtraArgs: '',
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

  // Windows users often paste paths from Explorer's "Copy as path" which wraps
  // them in quotes. Those quotes become part of the filename string when passed
  // to execFile, and whisper-cli then reports `failed to initialize whisper
  // context` because the file at the literal `"C:\..."` path doesn't exist.
  // Strip on both save AND read so already-corrupted installs heal themselves.
  _stripQuotes(s) {
    return String(s || '').trim().replace(/^["']+|["']+$/g, '').trim();
  }

  getWhisperConfig() {
    return {
      exePath:   this._stripQuotes(this.store.get('whisperExePath',   '')),
      modelPath: this._stripQuotes(this.store.get('whisperModelPath', '')),
      useCpu:    this.store.get('whisperUseCpu',    false),
      extraArgs: this.store.get('whisperExtraArgs', ''),
    };
  }

  setWhisperConfig({ exePath = '', modelPath = '', useCpu, extraArgs } = {}) {
    this.store.set('whisperExePath',   this._stripQuotes(exePath));
    this.store.set('whisperModelPath', this._stripQuotes(modelPath));
    if (typeof useCpu === 'boolean') this.store.set('whisperUseCpu', useCpu);
    if (typeof extraArgs === 'string') this.store.set('whisperExtraArgs', extraArgs.trim());
  }

  // ----- Custom system prompt (persona) -----

  getCustomSystemPrompt() {
    return this.store.get('customSystemPrompt', '');
  }

  setCustomSystemPrompt(text) {
    this.store.set('customSystemPrompt', (text || '').trim());
  }

  // ----- Cloud API keys (encrypted at rest via safeStorage) -----

  getGroqApiKey()       { return _decrypt(this.store.get('groqApiKey', ''));       }
  setGroqApiKey(key)    { this.store.set('groqApiKey',       _encrypt((key || '').trim())); }

  getGeminiApiKey()     { return _decrypt(this.store.get('geminiApiKey', ''));     }
  setGeminiApiKey(key)  { this.store.set('geminiApiKey',     _encrypt((key || '').trim())); }

  getBraveApiKey()      { return _decrypt(this.store.get('braveApiKey', ''));      }
  setBraveApiKey(key)   { this.store.set('braveApiKey',      _encrypt((key || '').trim())); }

  getOpenRouterApiKey() { return _decrypt(this.store.get('openRouterApiKey', '')); }
  setOpenRouterApiKey(key) { this.store.set('openRouterApiKey', _encrypt((key || '').trim())); }

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

  /**
   * Resolve a tool-supplied URL into a safe http(s) URL string, or throw.
   * Rejects file://, javascript:, ms-msdt:, vbscript:, anything starting with
   * "--" (browser flag injection), or anything that fails to parse.
   * Use this at every boundary where the LLM-controlled URL flows into
   * shell.openExternal or spawn(browser, [..., url]).
   */
  safeHttpUrl(input) {
    if (typeof input !== 'string') throw new Error('URL must be a string');
    const candidate = this.normalizeUrl(input);
    if (!candidate) throw new Error('Empty URL');
    const trimmed = candidate.trim();
    if (trimmed.startsWith('-')) throw new Error(`Refusing URL that starts with a dash: ${trimmed}`);
    let parsed;
    try { parsed = new URL(trimmed); }
    catch { throw new Error(`Invalid URL: ${trimmed}`); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Refusing URL with protocol "${parsed.protocol}" — only http(s) is allowed`);
    }
    return parsed.toString();
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
