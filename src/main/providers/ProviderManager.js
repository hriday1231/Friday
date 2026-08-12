/**
 * ProviderManager - routes a model name to the right LLM provider.
 *
 * Per-mode tuning (temperature, max tokens) lives on each provider via
 * BaseProvider helpers; this class is just a router with a model-list cache.
 *
 * Provider routing:
 *   'gemini-*'         → GeminiProvider
 *   model in Groq list → GroqProvider
 *   model in OR list   → OpenRouterProvider
 *   default / local    → OllamaProvider
 */

'use strict';

// ─── ProviderManager class ────────────────────────────────────────────────────

class ProviderManager {
  /**
   * @param {object} providers - map of provider instances
   * @param {object} [providers.ollama]
   * @param {object} [providers.groq]
   * @param {object} [providers.gemini]
   * @param {object} [providers.openrouter]
   */
  constructor(providers = {}) {
    this._providers = providers;
    /** @type {Set<string>} cached Groq model IDs */
    this._groqModels = new Set();
    /** @type {Set<string>} cached OpenRouter model IDs */
    this._orModels   = new Set();
  }

  /**
   * Populate model caches so routing works correctly.
   * Call once at startup (after providers are initialised).
   */
  async cacheModelLists() {
    try {
      if (this._providers.groq) {
        const models = await this._providers.groq.fetchModels();
        this._groqModels = new Set(models);
      }
    } catch { /* groq unavailable */ }

    try {
      if (this._providers.openrouter) {
        const models = await this._providers.openrouter.fetchModels();
        this._orModels = new Set(models);
      }
    } catch { /* openrouter unavailable */ }
  }

  /**
   * Resolve which provider handles a given model ID.
   */
  _route(modelName = '') {
    const m = modelName.toLowerCase();

    if (m.startsWith('gemini') && this._providers.gemini) {
      return this._providers.gemini;
    }
    if (this._groqModels.has(modelName) && this._providers.groq) {
      return this._providers.groq;
    }
    if (this._orModels.has(modelName) && this._providers.openrouter) {
      return this._providers.openrouter;
    }
    // Default to Ollama for local models
    if (this._providers.ollama) {
      return this._providers.ollama;
    }
    // Fallback: try any available provider
    const first = Object.values(this._providers)[0];
    if (first) return first;
    throw new Error(`ProviderManager: no provider available for model "${modelName}"`);
  }

  /**
   * Get a provider by explicit name (used by SubAgent and summarize calls).
   * @param {'ollama'|'groq'|'gemini'|'openrouter'} name
   */
  getProvider(name) {
    const p = this._providers[name];
    if (!p) throw new Error(`ProviderManager: unknown provider "${name}"`);
    return p;
  }

  /**
   * Fetch all available models from all providers.
   * Returns { providerName: string[] }
   */
  async fetchAllModels() {
    const results = {};
    for (const [name, provider] of Object.entries(this._providers)) {
      try {
        results[name] = await provider.fetchModels();
      } catch {
        results[name] = [];
      }
    }
    return results;
  }

  /**
   * Preferred fallback model for a given mode.
   * Tries each provider in priority order.
   */
  async preferredFallback(appMode = 'chat') {
    // Try each provider in turn and return the first available model
    for (const [, provider] of Object.entries(this._providers)) {
      try {
        const models = await provider.fetchModels();
        if (models.length > 0 && provider.getPreferredFallback) {
          const fallback = provider.getPreferredFallback(models);
          if (fallback) return fallback;
        }
      } catch { /* skip */ }
    }
    return null;
  }
}

module.exports = { ProviderManager };
