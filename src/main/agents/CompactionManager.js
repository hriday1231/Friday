/**
 * CompactionManager — automatic context window management.
 *
 * Triggers a summarization-based compaction at 90% of the model's context
 * window (leaving headroom for the next response), retains the last 10
 * messages verbatim, and warns the UI when fewer than 20K tokens remain.
 * After three consecutive compaction failures the manager disables itself
 * for the session as a circuit-breaker.
 *
 * Compaction calls the provider's summarize() capability (or falls back to a
 * summarization prompt against the same model). The summary is injected as a
 * system message at the top of the kept messages so the model retains
 * context across the boundary.
 *
 * Usage:
 *   const cm = new CompactionManager(maxContextTokens, summarizeFn);
 *   const result = await cm.maybeCompact(messages, currentTokens);
 *   // result: null | { compacted: Message[], summary: string, messagesRemoved: number }
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const COMPACT_THRESHOLD   = 0.90;  // trigger at 90% fill
const MESSAGES_TO_KEEP    = 10;    // keep last N messages after compaction
const WARNING_TOKENS_LEFT = 20_000; // warn when remaining capacity drops below this
const MAX_FAILURES        = 3;     // circuit-breaker: give up after N consecutive fails

// ─── CompactionManager class ──────────────────────────────────────────────────

class CompactionManager {
  /**
   * @param {number}   maxContextTokens  — provider's context window size
   * @param {Function} summarizeFn       — async (messages: Message[]) => string
   *   Called with the messages being dropped; must return a text summary.
   */
  constructor(maxContextTokens, summarizeFn) {
    if (!maxContextTokens) throw new Error('CompactionManager: maxContextTokens is required');
    if (typeof summarizeFn !== 'function') throw new Error('CompactionManager: summarizeFn must be a function');

    this._maxTokens    = maxContextTokens;
    this._summarizeFn  = summarizeFn;
    this._failures     = 0;
    this._lastSummary  = null;
  }

  /**
   * Check if compaction should fire and run it if so.
   *
   * @param {Array}  messages      — current message array
   * @param {number} currentTokens — estimated token count for the current context
   * @returns {null | CompactionResult}
   */
  async maybeCompact(messages, currentTokens) {
    const fillRatio = currentTokens / this._maxTokens;

    if (fillRatio < COMPACT_THRESHOLD) {
      return null; // nothing to do
    }

    if (this._failures >= MAX_FAILURES) {
      console.warn('[CompactionManager] Circuit breaker open — skipping compaction');
      return null;
    }

    return this._compact(messages);
  }

  /**
   * Returns true when context is within the warning zone but not yet at
   * compaction threshold. Use to surface a UI indicator.
   */
  isNearCapacity(currentTokens) {
    return (this._maxTokens - currentTokens) <= WARNING_TOKENS_LEFT;
  }

  /**
   * Force a compaction regardless of fill ratio.
   * Useful when manually triggered or after a context-overflow error.
   */
  async forceCompact(messages) {
    if (this._failures >= MAX_FAILURES) {
      throw new Error('CompactionManager: circuit breaker open, cannot compact');
    }
    return this._compact(messages);
  }

  /** Reset the circuit breaker (e.g. after a successful call on a new session). */
  resetCircuitBreaker() {
    this._failures = 0;
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  async _compact(messages) {
    if (messages.length <= MESSAGES_TO_KEEP) {
      return null; // nothing to drop
    }

    const keepFrom       = messages.length - MESSAGES_TO_KEEP;
    const toDrop         = messages.slice(0, keepFrom);
    const toKeep         = messages.slice(keepFrom);
    const messagesRemoved = toDrop.length;

    let summary;
    try {
      summary = await this._summarizeFn(toDrop);
      this._failures = 0; // success — reset breaker
    } catch (err) {
      this._failures++;
      console.error(`[CompactionManager] Summarize failed (${this._failures}/${MAX_FAILURES}):`, err.message);
      throw err;
    }

    this._lastSummary = summary;

    // Prepend a synthetic system message so the model sees the summary
    const summaryMessage = {
      role:    'system',
      content: `[Context compacted — ${messagesRemoved} earlier messages summarised]\n\n${summary}`,
    };

    const compacted = [summaryMessage, ...toKeep];

    return { compacted, summary, messagesRemoved };
  }

  get lastSummary() {
    return this._lastSummary;
  }

  get circuitOpen() {
    return this._failures >= MAX_FAILURES;
  }
}

module.exports = {
  CompactionManager,
  COMPACT_THRESHOLD,
  MESSAGES_TO_KEEP,
  WARNING_TOKENS_LEFT,
  MAX_FAILURES,
};
