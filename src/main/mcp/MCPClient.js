/**
 * MCP (Model Context Protocol) Client
 * Connects to MCP servers via stdio, discovers tools, and executes them.
 *
 * Security notes:
 * - Spawned servers DO NOT inherit the full Friday process env. Only the keys
 *   explicitly declared in mcp-servers.json's "env" block (after ${VAR}
 *   resolution), plus a small whitelist of harmless system vars (PATH, HOME,
 *   etc.), are forwarded. This prevents a compromised MCP package from reading
 *   GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, etc. from process.env.
 * - Servers are auto-reconnected with exponential backoff if their stdio
 *   transport closes unexpectedly.
 */

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// System env vars an MCP server may legitimately need (e.g. to find npm, npx,
// node, system DNS resolver). API keys live in `env` overrides only.
const SAFE_SYSTEM_ENV = [
  'PATH', 'HOME', 'USERPROFILE', 'USERNAME', 'USER', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TZ', 'TEMP', 'TMP', 'TMPDIR', 'SystemRoot', 'SYSTEMROOT', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'WINDIR', 'COMSPEC', 'PATHEXT', 'NODE_PATH',
];

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS  = 60_000;

class MCPClientManager {
  constructor(toolRegistry) {
    this.toolRegistry = toolRegistry;
    this.clients = new Map();  // serverName -> { client, transport, config }
    this._reconnectTimers = new Map(); // serverName -> Timeout
    this._reconnectAttempts = new Map(); // serverName -> int
    this._shuttingDown = false;
    this.configPath = path.join(__dirname, '../config/mcp-servers.json');
  }

  /**
   * Load MCP server config, resolving env vars in declared values.
   * The returned env block is JUST the explicitly-listed keys plus the
   * SAFE_SYSTEM_ENV whitelist - no other process.env entries are passed
   * through to the spawned subprocess.
   */
  loadConfig() {
    try {
      const raw = fs.readFileSync(this.configPath, 'utf8');
      const config = JSON.parse(raw);
      const resolved = { mcpServers: {} };

      for (const [name, serverConfig] of Object.entries(config.mcpServers || {})) {
        if (serverConfig.enabled === false) continue;

        const declaredEnv = {};
        for (const [k, v] of Object.entries(serverConfig.env || {})) {
          if (typeof v === 'string' && v.startsWith('${') && v.endsWith('}')) {
            const envKey = v.slice(2, -1);
            declaredEnv[k] = process.env[envKey] || '';
          } else {
            declaredEnv[k] = v;
          }
        }

        // Build the minimal env: explicit declarations + a small system whitelist.
        const safeSystem = {};
        for (const k of SAFE_SYSTEM_ENV) {
          if (process.env[k] != null) safeSystem[k] = process.env[k];
        }

        resolved.mcpServers[name] = {
          ...serverConfig,
          env: { ...safeSystem, ...declaredEnv },
        };
      }
      return resolved;
    } catch (error) {
      console.error('Failed to load MCP config:', error.message);
      return { mcpServers: {} };
    }
  }

  /**
   * Connect to all configured MCP servers and register their tools
   */
  async connectAll() {
    const config = this.loadConfig();

    for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
      try {
        await this.connectServer(serverName, serverConfig);
      } catch (error) {
        console.error(`Failed to connect to MCP server ${serverName}:`, error.message);
        this._scheduleReconnect(serverName, serverConfig);
      }
    }
  }

  /**
   * Connect to a single MCP server
   */
  async connectServer(serverName, serverConfig) {
    const command = serverConfig.command;
    const args = serverConfig.args || [];
    // Pass only the curated env (see loadConfig); never forward process.env directly.
    const env = serverConfig.env || {};

    const transport = new StdioClientTransport({
      command,
      args,
      env,
    });

    const client = new Client(
      { name: 'friday-assistant', version: '1.0.0' }
    );

    await client.connect(transport);

    const { tools } = await client.listTools();

    const callToolFn = async (toolName, args) => {
      return client.callTool({ name: toolName, arguments: args || {} });
    };

    this.toolRegistry.registerMcpTools(serverName, tools, callToolFn);
    this.clients.set(serverName, { client, transport, config: serverConfig });
    this._reconnectAttempts.set(serverName, 0);

    // Auto-reconnect if the transport drops unexpectedly. The Node SDK
    // surfaces an `onclose` callback on the transport.
    const onClose = () => {
      // Drop registered tools so we don't try to call them while disconnected.
      this.toolRegistry.unregisterMcpServer(serverName);
      this.clients.delete(serverName);
      if (!this._shuttingDown) this._scheduleReconnect(serverName, serverConfig);
    };
    if (typeof transport.onclose === 'function' || transport.onclose === undefined) {
      transport.onclose = onClose;
    }
    if (typeof transport.on === 'function') {
      transport.on('close', onClose);
      transport.on('error', (e) => console.warn(`MCP ${serverName} transport error:`, e?.message || e));
    }

    console.log(`MCP server ${serverName} connected with tools:`, tools.map(t => t.name).join(', '));
  }

  _scheduleReconnect(serverName, serverConfig) {
    if (this._shuttingDown) return;
    const prior = this._reconnectTimers.get(serverName);
    if (prior) clearTimeout(prior);
    const attempt = (this._reconnectAttempts.get(serverName) || 0) + 1;
    this._reconnectAttempts.set(serverName, attempt);
    const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, attempt - 1));
    const timer = setTimeout(() => {
      this._reconnectTimers.delete(serverName);
      this.connectServer(serverName, serverConfig).catch(() => {
        this._scheduleReconnect(serverName, serverConfig);
      });
    }, backoff);
    this._reconnectTimers.set(serverName, timer);
    console.log(`MCP ${serverName}: reconnect scheduled in ${backoff}ms (attempt ${attempt})`);
  }

  /**
   * Disconnect from a server
   */
  async disconnectServer(serverName) {
    const t = this._reconnectTimers.get(serverName);
    if (t) { clearTimeout(t); this._reconnectTimers.delete(serverName); }
    const entry = this.clients.get(serverName);
    if (entry) {
      try { await entry.client.close(); } catch {}
      try { await entry.transport?.close?.(); } catch {}
      this.toolRegistry.unregisterMcpServer(serverName);
      this.clients.delete(serverName);
    }
  }

  /**
   * Disconnect from all servers
   */
  async disconnectAll() {
    this._shuttingDown = true;
    for (const t of this._reconnectTimers.values()) clearTimeout(t);
    this._reconnectTimers.clear();
    for (const serverName of [...this.clients.keys()]) {
      await this.disconnectServer(serverName);
    }
  }
}

module.exports = MCPClientManager;
