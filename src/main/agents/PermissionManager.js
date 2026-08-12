/**
 * PermissionManager - hierarchical tool permission policy.
 *
 * Five permission levels:
 *
 *   READ_ONLY       (0) - no side effects: web/page reads, calendar summary
 *   WORKSPACE_WRITE (1) - reversible, bounded side effects: calendar add/edit,
 *                         opening a configured bookmark or app
 *   DANGER_FULL_ACCESS (2) - irreversible, or acting on a target the model chose
 *                         freely: calendar deletion, opening an arbitrary URL
 *   PROMPT          (3) - ask the user every time. Note this is numerically ABOVE
 *                         DANGER_FULL_ACCESS, so it is not "level 2 plus a bit" -
 *                         it is unreachable by any global level. See _tierFor().
 *   ALLOW           (4) - always allow this tool (explicit per-tool override)
 *
 * The policy can be set globally (all tools) or per-tool. Per-tool entries
 * take precedence over the global level.
 *
 * Session-level approvals ("Always allow this session") are stored in
 * SessionContext.autoApprovedTools - not here.
 */

'use strict';

// ─── Level constants ──────────────────────────────────────────────────────────

const PermissionLevel = {
  READ_ONLY:          0,
  WORKSPACE_WRITE:    1,
  DANGER_FULL_ACCESS: 2,
  PROMPT:             3,
  ALLOW:              4,
};

// ─── Default tier assignments ─────────────────────────────────────────────────

/**
 * Tools are classified by name. A tool in NONE of these three Sets resolves to
 * PermissionLevel.PROMPT (3), which is numerically ABOVE DANGER_FULL_ACCESS (2) -
 * so the `_globalLevel >= effective` comparison in check() can never satisfy it.
 * An untiered tool therefore shows a banner on EVERY call, even under fullyOpen(),
 * which is exactly what the title-bar "all permissions on" toggle selects.
 *
 * Tier membership is the only thing that makes a tool silent. Keep these Sets in
 * step with registerBuiltinTools() in main.js - every registered tool should appear
 * in exactly one of them.
 *
 * History: these Sets used to carry names from the removed code-execution mode
 * (read_file, write_file, execute_code, browser_*, install_package, and friends).
 * None of those tools are registered any more, and their bulk disguised the fact
 * that eight of the ten real builtins were untiered and prompting on every call.
 * They have been removed.
 */

/** Tier 0 - no side effects. Safe to run silently under even the strictest policy. */
const TIER_READ_ONLY = new Set([
  'brave_web_search',     // network read, returns text
  'fetch_page',           // network read, returns text
  'get_calendar_summary', // reads the user's calendar, changes nothing
]);

/**
 * Tier 1 - a real side effect on the user's machine or account, but bounded and
 * reversible. Prompts under forChat(); silent under forCode() and fullyOpen().
 */
const TIER_WORKSPACE_WRITE = new Set([
  'add_calendar_event',  // creates an event - deletable afterwards
  'edit_calendar_event', // modifies an existing event
  'search_site',         // opens a site-specific search in a browser window
  'open_bookmark',       // opens a bookmark the user configured in Settings
  'launch_app',          // launches a local app - but only one of the shortcuts the user
                         // configured in Settings, never an arbitrary binary
]);

/**
 * Tier 2 - irreversible, or acting on a target the model picked freely rather than
 * one the user pre-approved. Prompts under forChat() and forCode(); silent only
 * under fullyOpen(), which is a deliberate "I trust it" choice by the user.
 */
const TIER_DANGER = new Set([
  'delete_calendar_event', // irreversible destruction of the user's data
  'open_url',              // opens an arbitrary model-supplied URL, so a poisoned page
                           // or tool result could steer where the browser lands
]);

// ─── PermissionPolicy class ──────────────────────────────────────────────────

class PermissionPolicy {
  /**
   * @param {number} globalLevel - one of PermissionLevel.*
   *   Default: PROMPT - every tool must be explicitly categorised or asked.
   */
  constructor(globalLevel = PermissionLevel.PROMPT) {
    this._globalLevel = globalLevel;
    /** @type {Map<string, number>} per-tool overrides */
    this._overrides   = new Map();
  }

  /**
   * Set a per-tool override.
   * @param {string} toolName
   * @param {number} level
   */
  setTool(toolName, level) {
    this._overrides.set(toolName, level);
  }

  /**
   * Remove a per-tool override, reverting to global level.
   */
  clearTool(toolName) {
    this._overrides.delete(toolName);
  }

  /**
   * Determine whether a tool call should be auto-allowed, auto-denied, or
   * sent to the user for confirmation.
   *
   * Returns one of: 'allow' | 'prompt' | 'deny'
   *
   * For execute_code, also inspects args.code to classify read-only commands
   * (tier 0) vs destructive commands (tier 2). Tier 0 commands are auto-allowed
   * even if execute_code itself would normally prompt.
   *
   * @param {string} toolName
   * @param {object} [context]  - SessionContext, used for autoApprovedTools
   * @param {object} [args]     - tool arguments (used for execute_code classification)
   */
  check(toolName, context = null, args = null) {
    // Session-level approval overrides everything
    if (context && context.isToolApproved && context.isToolApproved(toolName)) {
      return 'allow';
    }

    // DORMANT: no tool named execute_code is registered any more (code execution was
    // removed in the scale-back - see AGENTS.md), so this branch and
    // classifyExecuteCode() below never fire. Kept, not deleted, so the shell
    // classification survives if code mode ever returns.
    if (toolName === 'execute_code' && args) {
      const tier = classifyExecuteCode(args);
      if (tier === 0) return 'allow';  // read-only command, always safe
      // tier 2 is always prompt (even if session-approved), handled below
    }

    const effective = this._overrides.has(toolName)
      ? this._overrides.get(toolName)
      : this._tierFor(toolName);

    if (effective === PermissionLevel.ALLOW) return 'allow';
    if (effective === PermissionLevel.PROMPT) return 'prompt';

    // Numeric tier: allow if the global level covers it
    if (this._globalLevel >= effective) return 'allow';

    // Global level is too low - prompt the user
    return 'prompt';
  }

  /**
   * Resolve the built-in tier for a tool name.
   * Returns a PermissionLevel numeric value.
   */
  _tierFor(toolName) {
    if (TIER_READ_ONLY.has(toolName))       return PermissionLevel.READ_ONLY;
    if (TIER_WORKSPACE_WRITE.has(toolName)) return PermissionLevel.WORKSPACE_WRITE;
    if (TIER_DANGER.has(toolName))          return PermissionLevel.DANGER_FULL_ACCESS;

    // Unknown tool → PROMPT, which as noted above no global level can satisfy: it
    // asks under every policy, fullyOpen() included. That is deliberate, and it is
    // what MCP-server tools get, since their names and payloads come from a
    // third-party process and cannot be audited from here. The banner still offers
    // "Always allow this session", so in practice it is one prompt per tool per
    // session rather than one per call.
    //
    // It also fails closed: a builtin that someone forgets to add to a Set above
    // asks the user instead of silently running. If you want MCP tools to go quiet
    // under the title-bar toggle, give them a tier rather than lowering this default.
    return PermissionLevel.PROMPT;
  }

  /**
   * Factory: sensible defaults for chat mode (read-only by default).
   */
  static forChat() {
    return new PermissionPolicy(PermissionLevel.READ_ONLY);
  }

  /**
   * Factory: sensible defaults for code mode (workspace writes auto-allowed,
   * dangerous ops still prompt).
   */
  static forCode() {
    return new PermissionPolicy(PermissionLevel.WORKSPACE_WRITE);
  }

  /**
   * Factory: fully open policy for testing / power users.
   */
  static fullyOpen() {
    return new PermissionPolicy(PermissionLevel.DANGER_FULL_ACCESS);
  }
}

// ─── execute_code command classification (DORMANT) ──────────────────────────
//
// Everything below is unreachable in the current build: no execute_code tool is
// registered, so check()'s classification branch never runs. Retained as-is in
// case code mode is ever restored; nothing outside this file imports it.

/**
 * Regexes for read-only shell commands that are safe to auto-approve.
 * These only inspect the filesystem or print information - no side effects.
 */
const EXEC_TIER0_RE = /^(?:grep|rg|find|ls|dir|cat|head|tail|wc|pwd|which|type|sort|uniq|diff|file|stat|du|df|env|printenv|whoami|hostname|uname|date|tree|less|more|strings|hexdump|xxd|md5sum|sha256sum|readlink|realpath|git\s+(?:status|log|diff|show|branch|remote|tag|rev-parse|blame)|npm\s+(?:ls|list|outdated|info|view|pack)|pip\s+(?:list|show|freeze|check)|node\s+-[ep]|python3?\s+-c\s+['"](?:import\s+(?:sys|os|platform|json)|print\())\b/;

/**
 * Regexes for highly destructive commands that should ALWAYS ask and not
 * offer "always allow this session".
 */
const EXEC_TIER2_RE = /\brm\s+-[rf]|\brd\s+\/s\b|\bdel\s+\/[sfq]\b|git\s+push\b.*--force|git\s+reset\s+--hard\b|DROP\s+TABLE\b|mkfs\b|\bformat\s+[a-z]:/i;

/**
 * Classify an execute_code call into a confirmation tier:
 *   0 - auto-approve (read-only shell: grep, ls, cat, find, git status, etc.)
 *   1 - ask once per session (installs, writes, default)
 *   2 - always ask, never "always allow" (rm -rf, git push --force, DROP TABLE)
 *
 * @param {{ language?: string, code?: string }} args
 * @returns {0 | 1 | 2}
 */
function classifyExecuteCode(args) {
  const lang = String(args?.language || 'shell').toLowerCase();
  const code = String(args?.code || '').trim();
  if (lang === 'shell' || lang === 'bash' || lang === 'powershell' || lang === 'sh') {
    // Strip leading comments and whitespace for classification
    const stripped = code.replace(/^\s*#[^\n]*\n/g, '').trim();
    if (EXEC_TIER0_RE.test(stripped)) return 0;
    if (EXEC_TIER2_RE.test(code))     return 2;
  }
  return 1;
}

module.exports = {
  PermissionPolicy, PermissionLevel,
  TIER_READ_ONLY, TIER_WORKSPACE_WRITE, TIER_DANGER,
  classifyExecuteCode,
};
