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
  initMessages(memoryEntries = [], contextSummary = null, episodes = [], agent = null, projectInstructions = null, appMode = 'chat', fewShots = []) {
    return [{ role: 'system', content: buildSystemPrompt(memoryEntries, contextSummary, episodes, agent, projectInstructions, appMode, fewShots) }];
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
    // Recent Ollama versions expect `name` on tool messages (some accept either
    // `name` or `tool_name`); send both for compatibility.
    for (const r of results) {
      messages.push({
        role:      'tool',
        name:      r.name,
        tool_name: r.name,
        content:   String(r.result),
      });
    }
  }

  /** Cheap local model for background summarisation/memory extraction. */
  getCheapModel() { return 'llama3.2:3b'; }

  /**
   * Send messages to Ollama and stream back any text.
   * Text chunks are passed to onChunk as they arrive.
   * Returns { text, toolCalls: [{name, args}], _rawToolCalls }.
   * When the model calls tools, text will be empty and onChunk is never called.
   */
  _numPredict(appMode) { return appMode === 'code' ? 8192 : 4096; }
  // _temperature inherited from BaseProvider

  async chatWithTools(messages, modelName, onChunk, signal, appMode = 'chat', opts = {}) {
    const excludeTools = opts && opts.excludeTools;
    const tools = this.toolRegistry.getOllamaTools(excludeTools);
    const baseURL = OllamaService.baseURL;

    // Reasoning-effort plumbing. Any Ollama model whose `capabilities` include
    // "thinking" honors `think: "low"|"medium"|"high"`. The renderer queries
    // capabilities via get-ollama-model-capabilities and only sends
    // reasoningEffort when it's applicable, so we just pass it through here
    // and leave the gating to the renderer. Non-thinking models silently
    // ignore `think`, so a stray value is harmless.
    const requestedEffort = opts && opts.reasoningEffort;
    const validEfforts = ['low', 'medium', 'high'];
    const thinkLevel = validEfforts.includes(requestedEffort) ? requestedEffort : undefined;

    const post = (body) => axios.post(
      `${baseURL}/api/chat`,
      {
        model: modelName,
        stream: true,
        options: { temperature: this._temperature(appMode), num_predict: this._numPredict(appMode) },
        ...body,
      },
      { responseType: 'stream', timeout: 120000, signal }
    );

    // Ollama answers 400 for two unrelated reasons: the model has no tool support,
    // or it is not a thinking model and `think` was sent anyway. The old handler
    // assumed the former, stripped the tools, and RESENT `think` - so a reasoning
    // effort set on a non-thinking model 400'd twice and the user got a blank
    // bubble with no error. Back off one capability at a time, cheapest first, so
    // a `think` rejection does not cost the tools.
    let response;
    try {
      response = await post({ messages, tools, think: thinkLevel });
    } catch (err) {
      if (err?.response?.status !== 400) throw err;

      if (thinkLevel) {
        try {
          console.warn(`[OllamaProvider] "${modelName}" rejected the request (400). Retrying without think.`);
          response = await post({ messages, tools });
        } catch (err2) {
          if (err2?.response?.status !== 400) throw err2;
          response = null;
        }
      }

      if (!response) {
        // Still refused: assume tools. Strip tool_calls from prior assistant
        // messages too, or the next request 400s on those instead.
        console.warn(`[OllamaProvider] "${modelName}" rejected tools (400). Retrying without tool definitions.`);
        const cleanMessages = messages
          .filter(m => m.role !== 'tool')
          .map(m => (m.role === 'assistant' ? { role: m.role, content: m.content } : m));
        response = await post({ messages: cleanMessages });
      }
    }

    let fullText = '';
    let fullThinking = '';
    const rawToolCalls = [];
    let buffer = '';
    let tokenUsage = null;

    // A model may repeat its tool calls in a later chunk (some emit them mid-stream
    // AND again in the done chunk), so dedupe on name+arguments. Two genuinely
    // distinct calls to the same tool always differ in their arguments.
    const seenCalls = new Set();
    const _collectToolCalls = (calls) => {
      if (!Array.isArray(calls)) return;
      for (const tc of calls) {
        const fn = tc?.function || {};
        const key = `${fn.name}::${typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {})}`;
        if (seenCalls.has(key)) continue;
        seenCalls.add(key);
        rawToolCalls.push(tc);
      }
    };

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
          // Thinking models stream their reasoning in `message.thinking`, NOT in
          // `message.content`. qwen3.5 puts its ENTIRE response there for a
          // tool-calling turn - content comes back 0 chars - so ignoring this
          // field left the user staring at a blank assistant bubble. Forward it
          // as a reasoning chunk; AgentRuntime already turns that into a
          // PartType.REASONING block and ChatInterface renders it collapsed.
          const thinking = data.message?.thinking;
          if (thinking) {
            fullThinking += thinking;
            if (onChunk) onChunk({ type: 'thinking', text: thinking });
          }
          // Collect tool calls from EVERY chunk, not just the final one. Ollama
          // places them wherever the model emits them: qwen2.5 sends them in the
          // first chunk with done:false and a completely empty done chunk, while
          // gpt-oss sends them in the done chunk. Reading only the done chunk
          // silently dropped every call from the former group, which surfaced as
          // an empty assistant bubble - no text, no tool, no error.
          _collectToolCalls(data.message?.tool_calls);
          if (data.done) {
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
        if (data.message?.content)  fullText += data.message.content;
        if (data.message?.thinking) fullThinking += data.message.thinking;
        _collectToolCalls(data.message?.tool_calls);
      } catch {}
    }

    const toolCalls = rawToolCalls.map((tc, i) => {
      const fn = tc.function || {};
      let args = fn.arguments;
      if (typeof args === 'string') {
        try { args = args.trim() ? JSON.parse(args) : {}; } catch { args = {}; }
      }
      // Ollama doesn't surface a stable id - synthesise one per call.
      const id = tc.id || `ollama_${Date.now()}_${i}_${fn.name}`;
      return { id, name: fn.name, args: args || {} };
    });

    // A thinking model can finish a turn with reasoning but no content and no
    // tool call. Rather than let the caller render an empty bubble, fall back to
    // the reasoning text - a visible "here is what it was working through" beats
    // silence, and the alternative is the generic "I couldn't generate a response".
    if (!fullText.trim() && !toolCalls.length && fullThinking.trim()) {
      fullText = fullThinking.trim();
    }

    return { text: fullText, thinking: fullThinking, toolCalls, _rawToolCalls: rawToolCalls, usage: tokenUsage };
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
