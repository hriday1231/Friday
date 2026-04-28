const GeminiService = require('../services/GeminiService');
const { buildSystemPrompt } = require('../config/systemPrompt');
const BaseProvider = require('./BaseProvider');

/**
 * Gemini LLM provider.
 */
class GeminiProvider extends BaseProvider {
  constructor(toolRegistry) {
    super();
    this.toolRegistry = toolRegistry;
    this.name = 'gemini';
  }

  /** Start a fresh messages array. Memory entries, episodes, summary and agent are stored for chatWithTools. */
  initMessages(memoryEntries = [], contextSummary = null, episodes = [], agent = null, projectInstructions = null, appMode = 'chat', fewShots = [], screenContext = null) {
    this._memoryEntries       = memoryEntries;
    this._contextSummary      = contextSummary;
    this._episodes            = episodes;
    this._agent               = agent || null;
    this._projectInstructions = projectInstructions;
    this._appMode             = appMode;
    this._fewShots            = fewShots;
    this._screenContext       = screenContext;
    return [];
  }

  appendUser(messages, text, images = []) {
    const parts = [];
    for (const img of images) {
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
    }
    parts.push({ text });
    messages.push({ role: 'user', parts });
  }

  /** For replaying conversation history where we only have the final text */
  appendHistoryAssistant(messages, text) {
    messages.push({ role: 'model', parts: [{ text }] });
  }

  /** For appending the raw model response (may include functionCall parts) */
  appendResponse(messages, chatResult) {
    messages.push({ role: 'model', parts: chatResult._rawParts });
  }

  appendToolResults(messages, results) {
    messages.push({
      role: 'user',
      parts: results.map(r => ({
        functionResponse: { name: r.name, response: { result: r.result } }
      }))
    });
  }

  /**
   * Send messages to Gemini and stream back any text.
   * Text chunks are passed to onChunk as they arrive.
   * Returns { text, toolCalls: [{name, args}], _rawParts }.
   * When the model calls tools, text will be empty and onChunk is never called.
   */
  _maxOutputTokens(appMode) { return this._maxTokens(appMode); } // delegate to base
  getCheapModel() { return 'gemini-1.5-flash-8b'; }
  // _temperature inherited from BaseProvider

  async chatWithTools(messages, modelName, onChunk, signal, appMode = 'chat') {
    GeminiService.initialize();

    const modelInstance = GeminiService.genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: buildSystemPrompt(this._memoryEntries || [], this._contextSummary || null, this._episodes || [], this._agent || null, this._projectInstructions || null, this._appMode || 'chat', this._fewShots || [], this._screenContext || null),
      tools: [{ functionDeclarations: this.toolRegistry.getGeminiFunctionDeclarations() }]
    });

    const stream = await modelInstance.generateContentStream(
      { contents: messages, generationConfig: { maxOutputTokens: this._maxOutputTokens(appMode), temperature: this._temperature(appMode) } },
      signal ? { signal } : undefined
    );

    // Stream text chunks as they arrive
    let fullText = '';
    for await (const chunk of stream.stream) {
      const parts = chunk.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.text) {
          fullText += part.text;
          if (onChunk) onChunk(part.text);
        }
      }
    }

    // Get the complete response (includes function calls)
    const fullResponse = await stream.response;
    const rawParts = fullResponse.candidates?.[0]?.content?.parts || [];
    const toolCalls = rawParts
      .filter(p => p.functionCall)
      .map(p => ({ name: p.functionCall.name, args: p.functionCall.args || {} }));

    const usage = fullResponse.usageMetadata;
    return {
      text: fullText, toolCalls, _rawParts: rawParts,
      usage: {
        inputTokens:  usage?.promptTokenCount     || 0,
        outputTokens: usage?.candidatesTokenCount || 0,
      }
    };
  }

  async fetchModels() {
    return GeminiService.fetchModels();
  }

  getPreferredFallback(models) {
    return models[0] || null;
  }

  isRateLimited(error) {
    return Boolean(error.message?.includes('quota') || error.message?.includes('429'));
  }
}

module.exports = GeminiProvider;
