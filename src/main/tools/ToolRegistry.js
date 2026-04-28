/**
 * Central tool registry - holds both built-in tools and MCP-discovered tools.
 * Converts to Gemini/Ollama format and routes execution.
 */

const { SchemaType } = require('@google/generative-ai'); // "string" | "object" | etc.

class ToolRegistry {
  constructor() {
    this.builtinTools = new Map();  // name -> { declaration, handler }
    this.mcpTools = new Map();      // name -> { declaration, serverName }
    this.mcpHandlers = new Map();   // serverName -> callTool function
  }

  /**
   * Register a built-in tool (e.g. Brave Search)
   */
  registerBuiltin(name, declaration, handler) {
    this.builtinTools.set(name, { declaration, handler });
  }

  /**
   * Register tools from an MCP server
   */
  registerMcpTools(serverName, tools, callToolFn) {
    this.mcpHandlers.set(serverName, callToolFn);
    for (const tool of tools) {
      this.mcpTools.set(tool.name, { declaration: tool, serverName });
    }
  }

  /**
   * Unregister all tools from an MCP server (e.g. when disconnected)
   */
  unregisterMcpServer(serverName) {
    this.mcpHandlers.delete(serverName);
    for (const [name, data] of this.mcpTools.entries()) {
      if (data.serverName === serverName) {
        this.mcpTools.delete(name);
      }
    }
  }

  /**
   * Get all tools as Gemini FunctionDeclaration format
   * Deduplicates: built-in tools take precedence over MCP tools with the same name
   */
  getGeminiFunctionDeclarations() {
    const declarations = [];
    const seenNames = new Set();

    // Add built-in tools first (they take precedence)
    for (const [, { declaration }] of this.builtinTools) {
      declarations.push(this.toGeminiDeclaration(declaration));
      seenNames.add(declaration.name);
    }

    // Add MCP tools, skipping any that conflict with built-in tools
    for (const [, { declaration }] of this.mcpTools) {
      if (!seenNames.has(declaration.name)) {
        declarations.push(this.mcpToGeminiDeclaration(declaration));
        seenNames.add(declaration.name);
      } else {
        console.log(`Skipping MCP tool "${declaration.name}" - built-in tool with same name already registered`);
      }
    }

    return declarations;
  }

  /**
   * Convert our built-in tool format to Gemini FunctionDeclaration
   */
  toGeminiDeclaration(declaration) {
    if (!declaration.parameters) {
      return { name: declaration.name, description: declaration.description || '' };
    }
    const props = declaration.parameters.properties || {};
    const geminiProps = {};
    for (const [key, prop] of Object.entries(props)) {
      geminiProps[key] = {
        type: this.jsonSchemaTypeToGemini(prop.type || 'string'),
        description: prop.description
      };
    }
    return {
      name: declaration.name,
      description: declaration.description || '',
      parameters: {
        type: SchemaType.OBJECT,
        properties: geminiProps,
        required: declaration.parameters.required || []
      }
    };
  }

  /**
   * Convert MCP tool format to Gemini FunctionDeclaration
   * MCP uses JSON Schema; Gemini uses a similar structure
   */
  mcpToGeminiDeclaration(mcpTool) {
    const schema = mcpTool.inputSchema || {};
    const props = schema.properties || {};
    const required = schema.required || [];

    const geminiProperties = {};
    for (const [key, prop] of Object.entries(props)) {
      geminiProperties[key] = {
        type: this.jsonSchemaTypeToGemini(prop.type),
        description: prop.description
      };
    }

    return {
      name: mcpTool.name,
      description: mcpTool.description || '',
      parameters: {
        type: SchemaType.OBJECT,
        properties: geminiProperties,
        required
      }
    };
  }

  jsonSchemaTypeToGemini(type) {
    const map = {
      string: SchemaType.STRING,
      number: SchemaType.NUMBER,
      integer: SchemaType.INTEGER,
      boolean: SchemaType.BOOLEAN,
      array: SchemaType.ARRAY,
      object: SchemaType.OBJECT
    };
    return map[type] || SchemaType.STRING;
  }

  /**
   * Execute a tool by name.
   * @param {string}          name       - tool name
   * @param {object}          args       - tool arguments
   * @param {Function|null}   [onStream] - optional streaming callback
   */
  async executeTool(name, args = {}, onStream) {
    if (this.builtinTools.has(name)) {
      const { handler } = this.builtinTools.get(name);
      const result = await handler(args, onStream);
      return typeof result === 'string' ? result : JSON.stringify(result);
    }

    if (this.mcpTools.has(name)) {
      const { serverName } = this.mcpTools.get(name);
      const callTool = this.mcpHandlers.get(serverName);
      if (!callTool) {
        throw new Error(`MCP server ${serverName} not connected`);
      }
      const result = await callTool(name, args);
      return this.formatMcpToolResult(result);
    }

    throw new Error(`Unknown tool: ${name}`);
  }

  formatMcpToolResult(result) {
    if (!result || !result.content) {
      return JSON.stringify(result || {});
    }
    const parts = result.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
    return parts || JSON.stringify(result);
  }

  /**
   * Get tools in Ollama API format for tool calling
   */
  getOllamaTools() {
    const tools = [];
    const seenNames = new Set();

    for (const [, { declaration }] of this.builtinTools) {
      tools.push(this.toOllamaDeclaration(declaration));
      seenNames.add(declaration.name);
    }
    for (const [, { declaration }] of this.mcpTools) {
      if (!seenNames.has(declaration.name)) {
        tools.push(this.mcpToOllamaDeclaration(declaration));
        seenNames.add(declaration.name);
      }
    }
    return tools;
  }

  toOllamaDeclaration(declaration) {
    const params = declaration.parameters || { type: 'object', properties: {} };
    return {
      type: 'function',
      function: {
        name: declaration.name,
        description: declaration.description || '',
        parameters: {
          type: params.type || 'object',
          required: params.required || [],
          properties: params.properties || {}
        }
      }
    };
  }

  mcpToOllamaDeclaration(mcpTool) {
    const schema = mcpTool.inputSchema || {};
    return {
      type: 'function',
      function: {
        name: mcpTool.name,
        description: mcpTool.description || '',
        parameters: {
          type: schema.type || 'object',
          required: schema.required || [],
          properties: schema.properties || {}
        }
      }
    };
  }

  /**
   * List all available tool names
   */
  listToolNames() {
    return [
      ...this.builtinTools.keys(),
      ...this.mcpTools.keys()
    ];
  }
}

module.exports = ToolRegistry;
