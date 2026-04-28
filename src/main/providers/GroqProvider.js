const axios = require('axios');
const GroqService = require('../services/GroqService');
const { buildSystemPrompt } = require('../config/systemPrompt');
const BaseProvider = require('./BaseProvider');

/**
 * Groq LLM provider — OpenAI-compatible streaming API.
 */
class GroqProvider extends BaseProvider {
  constructor(toolRegistry) {
    super();
    this.toolRegistry = toolRegistry;
    this.name = 'groq';
  }

  // ── Message builders ───────────────────────────────────────────────────────

  initMessages(memoryEntries = [], contextSummary = null, episodes = [], agent = null, projectInstructions = null, appMode = 'chat', fewShots = [], screenContext = null) {
    return [{ role: 'system', content: buildSystemPrompt(memoryEntries, contextSummary, episodes, agent, projectInstructions, appMode, fewShots, screenContext) }];
  }

  appendUser(messages, text, images = []) {
    // Groq's LLaMA models don't support vision yet — attach text only.
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
      const id = lastToolCalls[i]?.id || `call_${r.name}`;
      messages.push({
        role:         'tool',
        tool_call_id: id,
        content:      String(r.result),
      });
    });
  }

  // ── Core chat call ─────────────────────────────────────────────────────────

  /**
   * Send messages to Groq and stream back text chunks.
   * Returns { text, toolCalls: [{name, args}], _rawToolCalls }.
   */
  getCheapModel() { return 'llama-3.1-8b-instant'; }

  async chatWithTools(messages, modelName, onChunk, signal, appMode = 'chat') {
    const apiKey = GroqService.getApiKey();
    if (!apiKey) {
      throw new Error(
        'Groq API key not configured. Add GROQ_API_KEY to your .env file or enter it in Settings → Models.'
      );
    }

    // Convert to OpenAI tool format
    const ollamaTools = this.toolRegistry.getOllamaTools();
    const tools = ollamaTools.map(t => ({
      type:     'function',
      function: {
        name:        t.function.name,
        description: t.function.description,
        parameters:  t.function.parameters,
      },
    }));

    let response;
    try {
      response = await axios.post(
        `${GroqService.baseURL}/chat/completions`,
        {
          model:       modelName,
          messages,
          tools:       tools.length ? tools : undefined,
          tool_choice: tools.length ? 'auto' : undefined,
          stream:      true,
          temperature: this._temperature(appMode),
          max_tokens:  this._maxTokens(appMode),
        },
        {
          headers: {
            Authorization:  `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          responseType: 'stream',
          timeout:      120000,
          signal,
        }
      );
    } catch (err) {
      const status = err?.response?.status;
      if (status === 429) throw Object.assign(err, { _groqRateLimit: true });
      throw err;
    }

    let fullText = '';
    const toolCallChunks = []; // indexed by tc.index
    let buffer = '';

    for await (const rawChunk of response.data) {
      buffer += rawChunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete trailing line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          const delta  = parsed.choices?.[0]?.delta;
          if (!delta) continue;

          // Stream text
          if (delta.content) {
            fullText += delta.content;
            if (onChunk) onChunk(delta.content);
          }

          // Accumulate tool call fragments
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallChunks[idx]) {
                toolCallChunks[idx] = {
                  id:       tc.id || '',
                  type:     'function',
                  function: { name: '', arguments: '' },
                };
              }
              if (tc.id)              toolCallChunks[idx].id = tc.id;
              if (tc.function?.name)  toolCallChunks[idx].function.name      += tc.function.name;
              if (tc.function?.arguments) toolCallChunks[idx].function.arguments += tc.function.arguments;
            }
          }
        } catch {
          // ignore malformed SSE lines
        }
      }
    }

    const rawToolCalls = toolCallChunks.filter(Boolean);
    const toolCalls = rawToolCalls.map(tc => {
      let args = {};
      try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch {}
      return { name: tc.function.name, args };
    });

    return { text: fullText, toolCalls, _rawToolCalls: rawToolCalls };
  }

  // ── Utility ────────────────────────────────────────────────────────────────

  async fetchModels() {
    return GroqService.fetchModels();
  }

  getPreferredFallback(models) {
    if (!Array.isArray(models) || !models.length) return GroqService.PREFERRED_FALLBACK;
    return (
      models.find(m => m.includes('llama-3.3-70b')) ||
      models.find(m => m.includes('70b'))            ||
      models[0]
    );
  }

  isRateLimited(err) {
    return err?._groqRateLimit === true || err?.response?.status === 429;
  }
}

module.exports = GroqProvider;
