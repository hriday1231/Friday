/**
 * ProviderManager — wraps all LLM providers with per-mode configuration.
 *
 * Responsibilities:
 *   1. Route calls to the correct provider instance based on model name prefix
 *   2. Apply per-mode config: temperature, max_tokens, num_predict
 *   3. Provide a single `chat()` entry point that any part of the app can call
 *      (AgentRuntime, SubAgent, summarizeFn in CompactionManager, etc.)
 *   4. Resolve fallback models when the primary model is unavailable
 *
 * Per-mode defaults:
 *   code mode → temperature=0.1, maxTokens=16384
 *   chat mode → temperature=0.7, maxTokens=4096
 *
 * Provider routing:
 *   'claude-*'        → AnthropicProvider (future)
 *   'gemini-*'        → GeminiProvider
 *   'gpt-*' or 'o*'   → (future OpenAI)
 *   model in Groq list → GroqProvider
 *   model in OR list   → OpenRouterProvider
 *   default / local    → OllamaProvider
 */

'use strict';

// ─── Mode config ─────────────────────────────────────────────────────────────

const MODE_CONFIG = {
  code: { temperature: 0.1, maxTokens: 16384, numPredict: 8192 },
  chat: { temperature: 0.7, maxTokens:  4096, numPredict: 4096 },
};

function configForMode(appMode) {
  return MODE_CONFIG[appMode] ?? MODE_CONFIG.chat;
}

// ─── ProviderManager class ────────────────────────────────────────────────────

class ProviderManager {
  /**
   * @param {object} providers — map of provider instances
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
   * Main entry point: call the LLM with tools.
   *
   * @param {Array}    messages   — provider-formatted message array
   * @param {string}   modelName
   * @param {Function} onChunk    — streaming callback (text chunk | tool delta)
   * @param {object}   signal     — AbortSignal
   * @param {string}   appMode    — 'chat' | 'code'
   * @returns {Promise<{ text, toolCalls, _rawToolCalls, usage }>}
   */
  async chat(messages, modelName, onChunk, signal, appMode = 'chat') {
    const provider = this._route(modelName);
    const cfg      = configForMode(appMode);

    return provider.chatWithTools(messages, modelName, onChunk, signal, cfg);
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

module.exports = { ProviderManager, configForMode, MODE_CONFIG };
