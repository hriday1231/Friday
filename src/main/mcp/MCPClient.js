/**
 * MCP (Model Context Protocol) Client
 * Connects to MCP servers via stdio, discovers tools, and executes them.
 */

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

class MCPClientManager {
  constructor(toolRegistry) {
    this.toolRegistry = toolRegistry;
    this.clients = new Map();  // serverName -> { client, transport }
    this.configPath = path.join(__dirname, '../config/mcp-servers.json');
  }

  /**
   * Load MCP server config, resolving env vars in values
   */
  loadConfig() {
    try {
      const raw = fs.readFileSync(this.configPath, 'utf8');
      const config = JSON.parse(raw);
      const resolved = { mcpServers: {} };

      for (const [name, serverConfig] of Object.entries(config.mcpServers || {})) {
        if (serverConfig.enabled === false) continue;

        const env = {};
        for (const [k, v] of Object.entries(serverConfig.env || {})) {
          if (typeof v === 'string' && v.startsWith('${') && v.endsWith('}')) {
            const envKey = v.slice(2, -1);
            env[k] = process.env[envKey] || '';
          } else {
            env[k] = v;
          }
        }

        resolved.mcpServers[name] = {
          ...serverConfig,
          env: { ...process.env, ...env }
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
      }
    }
  }

  /**
   * Connect to a single MCP server
   */
  async connectServer(serverName, serverConfig) {
    const command = serverConfig.command;
    const args = serverConfig.args || [];
    const env = serverConfig.env || process.env;

    const transport = new StdioClientTransport({
      command,
      args,
      env
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
    this.clients.set(serverName, { client, transport });

    console.log(`MCP server ${serverName} connected with tools:`, tools.map(t => t.name).join(', '));
  }

  /**
   * Disconnect from a server
   */
  async disconnectServer(serverName) {
    const entry = this.clients.get(serverName);
    if (entry) {
      await entry.client.close();
      this.toolRegistry.unregisterMcpServer(serverName);
      this.clients.delete(serverName);
    }
  }

  /**
   * Disconnect from all servers
   */
  async disconnectAll() {
    for (const serverName of [...this.clients.keys()]) {
      await this.disconnectServer(serverName);
    }
  }
}

module.exports = MCPClientManager;
