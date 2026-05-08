const axios = require('axios');
require('dotenv').config();

class OllamaService {
  static get baseURL() {
    if (process.env.OLLAMA_BASE_URL) return process.env.OLLAMA_BASE_URL;
    try { return require('../settings/SettingsStore').getOllamaBaseUrl() || 'http://localhost:11434'; } catch { return 'http://localhost:11434'; }
  }

  /** Preferred model name for fallback when Gemini fails */
  static PREFERRED_FALLBACK = 'gpt-oss:20b';

  /**
   * Pick the best fallback model from a list: prefer PREFERRED_FALLBACK (or same base + tag) if available.
   * @param {string[]} modelNames - From fetchModels()
   * @returns {string}
   */
  static getPreferredFallbackModel(modelNames) {
    if (!Array.isArray(modelNames) || modelNames.length === 0) {
      return this.PREFERRED_FALLBACK;
    }
    const preferred = modelNames.find(
      (m) => m === this.PREFERRED_FALLBACK || m.startsWith(this.PREFERRED_FALLBACK + ':')
    );
    return preferred || modelNames[0];
  }

  /**
   * Fetch available Ollama models
   */
  static async fetchModels() {
    try {
      const response = await axios.get(`${this.baseURL}/api/tags`, {
        timeout: 5000
      });

      if (response.data && response.data.models) {
        return response.data.models.map(model => model.name);
      }

      return [];
    } catch (error) {
      console.error('Error fetching Ollama models:', error.message);
      return [];
    }
  }

  /**
   * Check if Ollama is running
   */
  static async isRunning() {
    try {
      await axios.get(`${this.baseURL}/api/tags`, { timeout: 3000 });
      return true;
    } catch (error) {
      return false;
    }
  }
}

module.exports = OllamaService;