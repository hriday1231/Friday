/**
 * SessionContext — per-session state for the agent runtime.
 * One SessionContext is created per chat session and carries the abort
 * controller + permission policy + cost tracker for that session.
 */

'use strict';

class SessionContext {
  /**
   * @param {object} opts
   * @param {string}      opts.sessionId
   * @param {object|null} opts.agent           — optional agent persona
   * @param {object}      opts.permissionPolicy — PermissionPolicy instance
   * @param {object}      opts.costTracker      — CostTracker instance
   */
  constructor({ sessionId, agent = null, permissionPolicy, costTracker }) {
    if (!sessionId)        throw new Error('SessionContext: sessionId is required');
    if (!permissionPolicy) throw new Error('SessionContext: permissionPolicy is required');
    if (!costTracker)      throw new Error('SessionContext: costTracker is required');

    this.sessionId        = sessionId;
    this.agent            = agent;
    this.permissionPolicy = permissionPolicy;
    this.costTracker      = costTracker;
    /** Tools approved for the rest of this session. */
    this.autoApprovedTools = new Set();
    this.abortController = new AbortController();
  }

  resetAbort() {
    this.abortController = new AbortController();
    return this.abortController;
  }

  abort() { this.abortController.abort(); }

  get signal() { return this.abortController.signal; }

  approveTool(toolName)   { this.autoApprovedTools.add(toolName); }
  isToolApproved(toolName) { return this.autoApprovedTools.has(toolName); }
}

module.exports = SessionContext;
