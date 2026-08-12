const axios = require('axios');
const OpenRouterService = require('../services/OpenRouterService');
const { buildSystemPrompt } = require('../config/systemPrompt');
const BaseProvider = require('./BaseProvider');

/**
 * OpenRouter LLM provider - OpenAI-compatible streaming API.
 */
class OpenRouterProvider extends BaseProvider {
  constructor(toolRegistry) {
    super();
    this.toolRegistry = toolRegistry;
    this.name = 'openrouter';
  }

  // ── Message builders ───────────────────────────────────────────────────────

  initMessages(memoryEntries = [], contextSummary = null, episodes = [], agent = null, projectInstructions = null, appMode = 'chat', fewShots = []) {
    return [{ role: 'system', content: buildSystemPrompt(memoryEntries, contextSummary, episodes, agent, projectInstructions, appMode, fewShots) }];
  }

  appendUser(messages, text, images = []) {
    messages.push({ role: 'user', content: text });
  }

  appendHistoryAssistant(messages, text) {
    messages.push({ role: 'assistant', content: text });
  }

  appendResponse(messages, chatResult) {
    const raw = (chatResult._rawToolCalls || []).filter(Boolean);

    const msg = { role: 'assistant', content: chatResult.text || '' };
    if (raw.length) {
      msg.tool_calls = raw.map(tc => ({
        id:       tc.id   || `call_${tc.function?.name}`,
        type:     'function',
        function: {
          name:      tc.function?.name      || '',
          arguments: tc.function?.arguments || '{}',
        },
      }));
    }
    messages.push(msg);
  }

  appendToolResults(messages, results) {
    const lastAssistant = messages.slice().reverse().find(m => m.role === 'assistant');
    const lastToolCalls = lastAssistant?.tool_calls || [];
    results.forEach((r, i) => {
      // Prefer the explicit callId (threaded from AgentRuntime).
      const id = r.callId || lastToolCalls[i]?.id || `call_${r.name}`;
      messages.push({ role: 'tool', tool_call_id: id, content: String(r.result) });
    });
  }

  // ── Core chat call ─────────────────────────────────────────────────────────

  getCheapModel() { return 'meta-llama/llama-3.1-8b-instruct:free'; }

  async chatWithTools(messages, modelName, onChunk, signal, appMode = 'chat', opts = {}) {
    const apiKey = OpenRouterService.getApiKey();
    if (!apiKey) {
      throw new Error('OpenRouter API key not configured. Add it in Settings → Models & API Keys.');
    }

    const excludeTools = opts && opts.excludeTools;
    const ollamaTools = this.toolRegistry.getOllamaTools(excludeTools);
    const tools = ollamaTools.map(t => ({
      type:     'function',
      function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters },
    }));

    let response;
    try {
      response = await axios.post(
        `${OpenRouterService.BASE_URL}/chat/completions`,
        {
          model:       modelName,
          messages,
          tools:       tools.length ? tools : undefined,
          tool_choice: tools.length ? 'auto' : undefined,
          stream:      true,
          stream_options: { include_usage: true },
          temperature: this._temperature(appMode),
          max_tokens:  this._maxTokens(appMode),
        },
        {
          headers: {
            Authorization:  `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer':  'https://github.com/friday-assistant',
            'X-Title':       'Friday',
          },
          responseType: 'stream',
          timeout:      120000,
          signal,
        }
      );
    } catch (err) {
      if (err?.response?.status === 429) throw Object.assign(err, { _orRateLimit: true });
      throw err;
    }

    let fullText = '';
    const toolCallChunks = [];
    let buffer = '';
    let usage  = null;

    for await (const rawChunk of response.data) {
      buffer += rawChunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          if (parsed.usage) {
            usage = {
              inputTokens:  parsed.usage.prompt_tokens     || 0,
              outputTokens: parsed.usage.completion_tokens || 0,
            };
          }
          const delta  = parsed.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            fullText += delta.content;
            if (onChunk) onChunk(delta.content);
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallChunks[idx]) {
                toolCallChunks[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
              }
              if (tc.id)                  toolCallChunks[idx].id = tc.id;
              if (tc.function?.name)       toolCallChunks[idx].function.name      += tc.function.name;
              if (tc.function?.arguments)  toolCallChunks[idx].function.arguments += tc.function.arguments;
            }
          }
        } catch {}
      }
    }

    const rawToolCalls = toolCallChunks.filter(Boolean);
    const toolCalls = rawToolCalls.map((tc, i) => {
      let args = {};
      try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch {}
      const id = tc.id || `or_${Date.now()}_${i}_${tc.function.name}`;
      tc.id = id;
      return { id, name: tc.function.name, args };
    });

    return { text: fullText, toolCalls, _rawToolCalls: rawToolCalls, usage };
  }

  // ── Utility ────────────────────────────────────────────────────────────────

  async fetchModels() {
    return OpenRouterService.fetchModels();
  }

  getPreferredFallback(models) {
    if (!Array.isArray(models) || !models.length) return 'meta-llama/llama-3.3-70b-instruct';
    return models.find(m => m.includes('llama-3.3-70b')) || models[0];
  }

  isRateLimited(err) {
    return err?._orRateLimit === true || err?.response?.status === 429;
  }
}

module.exports = OpenRouterProvider;
