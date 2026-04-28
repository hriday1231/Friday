/**
 * OpenRouterService — aggregates 200+ open-source and commercial models
 * via a single OpenAI-compatible API at openrouter.ai.
 *
 * Free tier available; many open-source models are $0.
 */

const DEFAULT_MODELS = [
  'meta-llama/llama-3.3-70b-instruct',
  'meta-llama/llama-3.1-8b-instruct',
  'deepseek/deepseek-r1',
  'deepseek/deepseek-chat',
  'mistralai/mistral-large',
  'qwen/qwen-2.5-72b-instruct',
  'google/gemma-3-27b-it',
  'microsoft/phi-4',
  'openai/gpt-4o-mini',
];

class OpenRouterService {
  static BASE_URL = 'https://openrouter.ai/api/v1';

  static DEFAULT_MODELS = DEFAULT_MODELS;

  static getApiKey() {
    if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
    try { return require('../settings/SettingsStore').getOpenRouterApiKey() || ''; } catch { return ''; }
  }

  static isConfigured() {
    return !!this.getApiKey();
  }

  static async fetchModels() {
    const key = this.getApiKey();
    if (!key) return DEFAULT_MODELS;
    try {
      const res = await fetch(`${this.BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) return DEFAULT_MODELS;
      const data = await res.json();
      // Filter to free or cheap models; sort by context length desc
      const models = (data.data || [])
        .map(m => m.id)
        .filter(Boolean)
        .sort();
      return models.length ? models : DEFAULT_MODELS;
    } catch {
      return DEFAULT_MODELS;
    }
  }
}

module.exports = OpenRouterService;
