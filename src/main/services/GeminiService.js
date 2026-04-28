const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
require('dotenv').config();

class GeminiService {
  static genAI = null;

  /** Read API key: env var takes priority, then SettingsStore. */
  static getApiKey() {
    if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
    try {
      const SettingsStore = require('../settings/SettingsStore');
      return SettingsStore.getGeminiApiKey() || '';
    } catch {
      return '';
    }
  }

  static initialize() {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error('Gemini API key not configured. Add it in Settings → Models.');
    // Re-initialize if the key changed (e.g. user set it via UI)
    if (!this.genAI) {
      this.genAI = new GoogleGenerativeAI(apiKey);
    }
    return this.genAI;
  }

  static isConfigured() {
    return Boolean(this.getApiKey());
  }

  /**
   * Fetch available Gemini models from the API.
   */
  static async fetchModels() {
    const apiKey = this.getApiKey();
    if (!apiKey) return [];
    try {
      const response = await axios.get(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
        { timeout: 10000 }
      );
      if (!response.data?.models) return [];
      const supportsGenerate = (m) => {
        const methods = m.supportedGenerationMethods || [];
        return methods.some(method => method?.toLowerCase() === 'generatecontent');
      };
      return response.data.models
        .filter(supportsGenerate)
        .map(m => (m.name || '').replace(/^models\//, ''))
        .filter(name => name && name.startsWith('gemini'))
        .sort();
    } catch (error) {
      console.error('Error fetching Gemini models:', error.message);
      return [];
    }
  }
}

module.exports = GeminiService;
