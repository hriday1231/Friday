const axios = require('axios');

/**
 * Groq cloud inference service.
 * OpenAI-compatible API — ultra-fast inference for Llama, DeepSeek, Mixtral, etc.
 * API key read from GROQ_API_KEY env var or SettingsStore (so it can be set in UI).
 */
class GroqService {
  static get baseURL() {
    return 'https://api.groq.com/openai/v1';
  }

  /** Curated model list shown when API key is missing or fetch fails. */
  static get DEFAULT_MODELS() {
    return [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'deepseek-r1-distill-llama-70b',
      'mixtral-8x7b-32768',
      'gemma2-9b-it',
      'qwen-qwq-32b',
    ];
  }

  static get PREFERRED_FALLBACK() {
    return 'llama-3.3-70b-versatile';
  }

  /** Read API key from env or persistent settings. */
  static getApiKey() {
    if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;
    try {
      const SettingsStore = require('../settings/SettingsStore');
      return SettingsStore.getGroqApiKey() || '';
    } catch {
      return '';
    }
  }

  static isConfigured() {
    return Boolean(this.getApiKey());
  }

  /**
   * Fetch available models from Groq API.
   * Falls back to DEFAULT_MODELS when unconfigured or request fails.
   */
  static async fetchModels() {
    const key = this.getApiKey();
    if (!key) return this.DEFAULT_MODELS;
    try {
      const response = await axios.get(`${this.baseURL}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        timeout: 6000,
      });
      const models = (response.data?.data || [])
        .filter(m => m.id && !m.id.includes('whisper') && !m.id.includes('tts'))
        .map(m => m.id)
        .sort();
      return models.length ? models : this.DEFAULT_MODELS;
    } catch {
      return this.DEFAULT_MODELS;
    }
  }

  static async isRunning() {
    return this.isConfigured();
  }
}

module.exports = GroqService;
