/**
 * PermissionManager — hierarchical tool permission policy.
 *
 * Five permission levels (from claw-code PermissionPolicy):
 *
 *   READ_ONLY       (0) — read_file, list_dir, search_files, grep_files
 *   WORKSPACE_WRITE (1) — above + write_file, patch_file, create_dir, delete_file
 *                         within workspace only
 *   DANGER_FULL_ACCESS (2) — above + execute_code, browser_*, system calls
 *   PROMPT          (3) — ask the user before each use of this tool
 *   ALLOW           (4) — always allow this tool (explicit per-tool override)
 *
 * The policy can be set globally (all tools) or per-tool. Per-tool entries
 * take precedence over the global level.
 *
 * Session-level approvals ("Always allow this session") are stored in
 * SessionContext.autoApprovedTools — not here.
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
 * Tools that are safe to run without any prompt (tier 0 = READ_ONLY).
 * Everything not listed is PROMPT by default.
 */
const TIER_READ_ONLY = new Set([
  'read_file',
  'list_dir',
  'search_files',
  'grep_files',
  'get_file_info',
  'web_search',
  'fetch_page',
]);

/**
 * Tools that modify the workspace but are considered safe within it (tier 1).
 * Note: delete_file is intentionally NOT here — it's irreversible and goes in TIER_DANGER.
 */
const TIER_WORKSPACE_WRITE = new Set([
  'write_file',
  'patch_file',
  'create_dir',
  'move_file',
  'copy_file',
]);

/**
 * High-risk tools that require explicit user confirmation each time unless
 * granted DANGER_FULL_ACCESS globally or ALLOW per-tool (tier 2).
 * Includes delete_file because file deletion is irreversible.
 */
const TIER_DANGER = new Set([
  'execute_code',
  'run_terminal',
  'delete_file',        // irreversible — always ask
  'browser_navigate',
  'browser_click',
  'browser_fill',
  'browser_screenshot',
  'open_url',
  'install_package',
]);

// ─── PermissionPolicy class ──────────────────────────────────────────────────

class PermissionPolicy {
  /**
   * @param {number} globalLevel — one of PermissionLevel.*
   *   Default: PROMPT — every tool must be explicitly categorised or asked.
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
   * @param {object} [context]  — SessionContext, used for autoApprovedTools
   * @param {object} [args]     — tool arguments (used for execute_code classification)
   */
  check(toolName, context = null, args = null) {
    // Session-level approval overrides everything
    if (context && context.isToolApproved && context.isToolApproved(toolName)) {
      return 'allow';
    }

    // Smart execute_code classification — read-only shell is auto-allowed
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

    // Global level is too low — prompt the user
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
    // Unknown tool → prompt by default
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

// ─── execute_code command classification ────────────────────────────────────

/**
 * Regexes for read-only shell commands that are safe to auto-approve.
 * These only inspect the filesystem or print information — no side effects.
 */
const EXEC_TIER0_RE = /^(?:grep|rg|find|ls|dir|cat|head|tail|wc|pwd|which|type|sort|uniq|diff|file|stat|du|df|env|printenv|whoami|hostname|uname|date|tree|less|more|strings|hexdump|xxd|md5sum|sha256sum|readlink|realpath|git\s+(?:status|log|diff|show|branch|remote|tag|rev-parse|blame)|npm\s+(?:ls|list|outdated|info|view|pack)|pip\s+(?:list|show|freeze|check)|node\s+-[ep]|python3?\s+-c\s+['"](?:import\s+(?:sys|os|platform|json)|print\())\b/;

/**
 * Regexes for highly destructive commands that should ALWAYS ask and not
 * offer "always allow this session".
 */
const EXEC_TIER2_RE = /\brm\s+-[rf]|\brd\s+\/s\b|\bdel\s+\/[sfq]\b|git\s+push\b.*--force|git\s+reset\s+--hard\b|DROP\s+TABLE\b|mkfs\b|\bformat\s+[a-z]:/i;

/**
 * Classify an execute_code call into a confirmation tier:
 *   0 — auto-approve (read-only shell: grep, ls, cat, find, git status, etc.)
 *   1 — ask once per session (installs, writes, default)
 *   2 — always ask, never "always allow" (rm -rf, git push --force, DROP TABLE)
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
