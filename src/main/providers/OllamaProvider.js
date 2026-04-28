const axios = require('axios');
const OllamaService = require('../services/OllamaService');
const { buildSystemPrompt } = require('../config/systemPrompt');
const BaseProvider = require('./BaseProvider');

/**
 * Ollama LLM provider.
 */
class OllamaProvider extends BaseProvider {
  constructor(toolRegistry) {
    super();
    this.toolRegistry = toolRegistry;
    this.name = 'ollama';
  }

  /** Start a fresh messages array with the system instruction (memory + episodes + summary injected). */
  initMessages(memoryEntries = [], contextSummary = null, episodes = [], agent = null, projectInstructions = null, appMode = 'chat', fewShots = [], screenContext = null) {
    return [{ role: 'system', content: buildSystemPrompt(memoryEntries, contextSummary, episodes, agent, projectInstructions, appMode, fewShots, screenContext) }];
  }

  appendUser(messages, text, images = []) {
    const msg = { role: 'user', content: text };
    if (images && images.length > 0) {
      msg.images = images.map(img => img.data); // base64 strings only
    }
    messages.push(msg);
  }

  /** For replaying conversation history where we only have the final text */
  appendHistoryAssistant(messages, text) {
    messages.push({ role: 'assistant', content: text });
  }

  /** For appending the raw model response (may include tool_calls) */
  appendResponse(messages, chatResult) {
    messages.push({
      role: 'assistant',
      content: chatResult.text || '',
      tool_calls: chatResult._rawToolCalls
    });
  }

  appendToolResults(messages, results) {
    for (const r of results) {
      messages.push({ role: 'tool', tool_name: r.name, content: String(r.result) });
    }
  }

  /**
   * Send messages to Ollama and stream back any text.
   * Text chunks are passed to onChunk as they arrive.
   * Returns { text, toolCalls: [{name, args}], _rawToolCalls }.
   * When the model calls tools, text will be empty and onChunk is never called.
   */
  _numPredict(appMode) { return appMode === 'code' ? 8192 : 4096; }
  // _temperature inherited from BaseProvider

  async chatWithTools(messages, modelName, onChunk, signal, appMode = 'chat', opts = {}) {
    const allTools = this.toolRegistry.getOllamaTools();
    const tools = (opts && opts.excludeTools && opts.excludeTools.size)
      ? allTools.filter(t => !opts.excludeTools.has(t.function?.name))
      : allTools;
    const baseURL = OllamaService.baseURL;

    let response;
    try {
      response = await axios.post(
        `${baseURL}/api/chat`,
        {
          model: modelName,
          messages,
          tools,
          stream: true,
          options: { temperature: this._temperature(appMode), num_predict: this._numPredict(appMode) }
        },
        { responseType: 'stream', timeout: 120000, signal }
      );
    } catch (err) {
      // Ollama returns 400 when the model doesn't support tools.
      // Retry without tools so the model can still answer conversationally.
      // Strip any tool_calls from prior assistant messages to avoid another 400.
      if (err?.response?.status === 400) {
        console.warn(`[OllamaProvider] Model "${modelName}" rejected tools (400). Retrying without tool definitions.`);
        const cleanMessages = messages.map(m =>
          m.role === 'assistant' ? { role: m.role, content: m.content } : m
        );
        response = await axios.post(
          `${baseURL}/api/chat`,
          {
            model: modelName,
            messages: cleanMessages,
            stream: true,
            options: { temperature: this._temperature(appMode), num_predict: this._numPredict(appMode) }
          },
          { responseType: 'stream', timeout: 120000, signal }
        );
      } else {
        throw err;
      }
    }

    let fullText = '';
    let rawToolCalls = [];
    let buffer = '';
    let tokenUsage = null;

    for await (const chunk of response.data) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep any incomplete trailing line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          const content = data.message?.content;
          if (content) {
            fullText += content;
            if (onChunk) onChunk(content);
          }
          if (data.done) {
            if (data.message?.tool_calls) rawToolCalls = data.message.tool_calls;
            tokenUsage = {
              inputTokens:  data.prompt_eval_count || 0,
              outputTokens: data.eval_count        || 0,
            };
          }
        } catch {
          // ignore malformed lines
        }
      }
    }

    // Flush any remaining buffer
    if (buffer.trim()) {
      try {
        const data = JSON.parse(buffer);
        if (data.message?.tool_calls) rawToolCalls = data.message.tool_calls;
      } catch {}
    }

    const toolCalls = rawToolCalls.map(tc => {
      const fn = tc.function || {};
      let args = fn.arguments;
      if (typeof args === 'string') {
        try { args = args.trim() ? JSON.parse(args) : {}; } catch { args = {}; }
      }
      return { name: fn.name, args: args || {} };
    });

    return { text: fullText, toolCalls, _rawToolCalls: rawToolCalls, usage: tokenUsage };
  }

  async fetchModels() {
    return OllamaService.fetchModels();
  }

  getPreferredFallback(models) {
    if (!Array.isArray(models) || models.length === 0) return OllamaService.PREFERRED_FALLBACK;
    const preferred = models.find(m =>
      m === OllamaService.PREFERRED_FALLBACK || m.startsWith(OllamaService.PREFERRED_FALLBACK + ':')
    );
    return preferred || models[0];
  }

  isRateLimited() {
    return false;
  }
}

module.exports = OllamaProvider;
