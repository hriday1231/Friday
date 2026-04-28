/**
 * CostTracker — per-session token and cost accounting.
 *
 * Tracks input / output / cache-create / cache-read tokens per assistant turn
 * and computes a running USD cost from a static pricing table (rates current
 * as of April 2026). Usage is embedded in each assistant message's `usage`
 * field so cumulative cost can be reconstructed from session history on
 * resume — no external state required.
 */

'use strict';

// ─── Pricing table ────────────────────────────────────────────────────────────

const PRICING = {
  // Anthropic
  haiku:       { input: 1.00,  output: 5.00,   cacheCreate: 1.25,  cacheRead: 0.10 },
  sonnet:      { input: 3.00,  output: 15.00,  cacheCreate: 3.75,  cacheRead: 0.30 },
  opus:        { input: 15.00, output: 75.00,  cacheCreate: 18.75, cacheRead: 1.50 },
  // Google
  'flash':     { input: 0.10,  output: 0.40,   cacheCreate: 0,     cacheRead: 0    },
  'pro':       { input: 1.25,  output: 5.00,   cacheCreate: 0,     cacheRead: 0    },
  // Groq / Ollama / OpenRouter (approximate, most are near-free or very cheap)
  default:     { input: 0.10,  output: 0.10,   cacheCreate: 0,     cacheRead: 0    },
};

/**
 * Return the pricing entry for a model ID string.
 * Uses substring matching against known tier keywords.
 */
function pricingForModel(modelId = '') {
  const m = modelId.toLowerCase();
  if (m.includes('haiku'))         return PRICING.haiku;
  if (m.includes('opus'))          return PRICING.opus;
  if (m.includes('sonnet'))        return PRICING.sonnet;
  if (m.includes('gemini-2.0-flash') || m.includes('flash')) return PRICING.flash;
  if (m.includes('gemini') && m.includes('pro'))             return PRICING.pro;
  return PRICING.default;
}

// ─── CostTracker class ────────────────────────────────────────────────────────

class CostTracker {
  /**
   * @param {string} modelId — used to look up pricing tier
   */
  constructor(modelId = '') {
    this.pricing = pricingForModel(modelId);
    this.inputTokens          = 0;
    this.outputTokens         = 0;
    this.cacheCreationTokens  = 0;
    this.cacheReadTokens      = 0;
    this._turns               = 0;
  }

  /**
   * Reconstruct tracker state from previously persisted message usage objects.
   * Called when resuming a session so historical cost is included in totals.
   *
   * @param {Array<{inputTokens,outputTokens,cacheCreationInputTokens,cacheReadInputTokens}>} usageArray
   * @param {string} modelId
   */
  static fromHistory(usageArray, modelId) {
    const tracker = new CostTracker(modelId);
    for (const u of usageArray) {
      if (u) tracker.add(u);
    }
    return tracker;
  }

  /**
   * Add usage from one LLM response.
   * Accepts the raw usage object returned by any provider.
   */
  add({ inputTokens = 0, outputTokens = 0, cacheCreationInputTokens = 0, cacheReadInputTokens = 0 } = {}) {
    this.inputTokens         += inputTokens;
    this.outputTokens        += outputTokens;
    this.cacheCreationTokens += cacheCreationInputTokens;
    this.cacheReadTokens     += cacheReadInputTokens;
    this._turns++;
  }

  /**
   * Total cost in USD for all recorded usage.
   */
  get totalCostUSD() {
    const p = this.pricing;
    return (
      this.inputTokens         * p.input        +
      this.outputTokens        * p.output       +
      this.cacheCreationTokens * p.cacheCreate  +
      this.cacheReadTokens     * p.cacheRead
    ) / 1_000_000;
  }

  get totalTokens() {
    return this.inputTokens + this.outputTokens + this.cacheCreationTokens + this.cacheReadTokens;
  }

  get turns() {
    return this._turns;
  }

  /**
   * One-line summary for UI display (e.g. in StepFinishPart).
   */
  get summary() {
    const cost = this.totalCostUSD;
    const costStr = cost < 0.001 ? '<$0.001' : `$${cost.toFixed(4)}`;
    return `${this.totalTokens.toLocaleString()} tokens · ${costStr}`;
  }

  /**
   * Cost of a single step (delta since last snapshot).
   * Call snapshot() before a step, then stepCost() after.
   */
  snapshot() {
    return {
      input:         this.inputTokens,
      output:        this.outputTokens,
      cacheCreate:   this.cacheCreationTokens,
      cacheRead:     this.cacheReadTokens,
    };
  }

  stepCostUSD(before) {
    const p = this.pricing;
    return (
      (this.inputTokens         - before.input)        * p.input       +
      (this.outputTokens        - before.output)       * p.output      +
      (this.cacheCreationTokens - before.cacheCreate)  * p.cacheCreate +
      (this.cacheReadTokens     - before.cacheRead)    * p.cacheRead
    ) / 1_000_000;
  }

  stepTokens(before) {
    return {
      input:      this.inputTokens         - before.input,
      output:     this.outputTokens        - before.output,
      cacheRead:  this.cacheReadTokens     - before.cacheRead,
      cacheWrite: this.cacheCreationTokens - before.cacheCreate,
    };
  }

  /**
   * Serialisable usage object for embedding in messages.
   */
  toUsageObject() {
    return {
      inputTokens:                 this.inputTokens,
      outputTokens:                this.outputTokens,
      cacheCreationInputTokens:    this.cacheCreationTokens,
      cacheReadInputTokens:        this.cacheReadTokens,
    };
  }
}

module.exports = { CostTracker, pricingForModel };
