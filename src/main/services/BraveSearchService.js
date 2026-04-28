const axios = require('axios');
require('dotenv').config();

const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search';

class BraveSearchService {
  /**
   * Perform a web search using the Brave Search API
   * @param {string} query - Search query
   * @returns {Promise<object>} - Search results with web.results array
   */
  static getApiKey() {
    if (process.env.BRAVE_API_KEY) return process.env.BRAVE_API_KEY;
    try {
      const SettingsStore = require('../settings/SettingsStore');
      return SettingsStore.getBraveApiKey() || '';
    } catch {
      return '';
    }
  }

  static isConfigured() {
    return Boolean(this.getApiKey());
  }

  static async search(query) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('Brave Search API key not configured. Add it in Settings → Models.');
    }

    try {
      const response = await axios.get(BRAVE_API_URL, {
        params: { q: query },
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey
        },
        timeout: 10000
      });

      return response.data;
    } catch (error) {
      if (error.response?.status === 401) {
        throw new Error('Invalid Brave Search API key. Check your BRAVE_API_KEY in .env');
      }
      if (error.response?.status === 429) {
        throw new Error('Brave Search API rate limit exceeded. Please try again later.');
      }
      console.error('Brave Search API error:', error.message);
      throw new Error(`Brave Search failed: ${error.message}`);
    }
  }
}

module.exports = BraveSearchService;
