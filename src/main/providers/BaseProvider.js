/**
 * BaseProvider — shared config helpers and interface stubs for all LLM providers.
 *
 * All providers extend this class. Shared logic lives here once; providers
 * override only what differs.
 */
class BaseProvider {
  // ── Shared config helpers (mode-aware) ────────────────────────────────────

  _maxTokens(appMode) {
    return appMode === 'code' ? 16384 : 4096;
  }

  _temperature(appMode) {
    return appMode === 'code' ? 0.1 : 0.7;
  }

  _numPredict(appMode) {
    return appMode === 'code' ? 8192 : 4096;
  }

  _maxOutputTokens(appMode) {
    return appMode === 'code' ? 16384 : 4096;
  }

  /**
   * Return a cheap/fast model name for background tasks (summarization,
   * memory extraction). Defaults to null — callers fall back to the main model.
   */
  getCheapModel() { return null; }

  // ── Interface stubs (throw if a provider forgets to implement) ────────────

  initMessages()          { throw new Error(`${this.constructor.name}: initMessages not implemented`); }
  appendUser()            { throw new Error(`${this.constructor.name}: appendUser not implemented`); }
  appendHistoryAssistant(){ throw new Error(`${this.constructor.name}: appendHistoryAssistant not implemented`); }
  appendResponse()        { throw new Error(`${this.constructor.name}: appendResponse not implemented`); }
  appendToolResults()     { throw new Error(`${this.constructor.name}: appendToolResults not implemented`); }
  // eslint-disable-next-line no-unused-vars
  async chatWithTools()   { throw new Error(`${this.constructor.name}: chatWithTools not implemented`); }
  async fetchModels()     { throw new Error(`${this.constructor.name}: fetchModels not implemented`); }
  getPreferredFallback()  { throw new Error(`${this.constructor.name}: getPreferredFallback not implemented`); }
  isRateLimited()         { return false; }
}

module.exports = BaseProvider;
