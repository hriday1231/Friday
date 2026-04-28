const axios = require('axios');
require('dotenv').config();

class OllamaService {
  static get baseURL() {
    if (process.env.OLLAMA_BASE_URL) return process.env.OLLAMA_BASE_URL;
    try { return require('../settings/SettingsStore').getOllamaBaseUrl() || 'http://localhost:11434'; } catch { return 'http://localhost:11434'; }
  }

  /** Preferred model name for fallback when Gemini fails */
  static PREFERRED_FALLBACK = 'gpt-oss:20b';

  /**
   * Pick the best fallback model from a list: prefer PREFERRED_FALLBACK (or same base + tag) if available.
   * @param {string[]} modelNames - From fetchModels()
   * @returns {string}
   */
  static getPreferredFallbackModel(modelNames) {
    if (!Array.isArray(modelNames) || modelNames.length === 0) {
      return this.PREFERRED_FALLBACK;
    }
    const preferred = modelNames.find(
      (m) => m === this.PREFERRED_FALLBACK || m.startsWith(this.PREFERRED_FALLBACK + ':')
    );
    return preferred || modelNames[0];
  }

  /**
   * Fetch available Ollama models
   */
  static async fetchModels() {
    try {
      const response = await axios.get(`${this.baseURL}/api/tags`, {
        timeout: 5000
      });

      if (response.data && response.data.models) {
        return response.data.models.map(model => model.name);
      }

      return [];
    } catch (error) {
      console.error('Error fetching Ollama models:', error.message);
      return [];
    }
  }

  /**
   * Generate text using Ollama model
   * @param {string} model - Model name
   * @param {string} prompt - User prompt
   * @param {array} history - Conversation history (optional)
   */
  static async generate(model, prompt, history = []) {
    try {
      const messages = this.formatHistory(history, prompt);

      const response = await axios.post(
        `${this.baseURL}/api/chat`,
        {
          model: model,
          messages: messages,
          stream: false
        },
        {
          timeout: 60000 // 60 seconds timeout
        }
      );

      if (response.data && response.data.message) {
        return response.data.message.content;
      }

      throw new Error('Invalid response from Ollama');
    } catch (error) {
      console.error('Ollama generation error:', error.message);
      
      if (error.code === 'ECONNREFUSED') {
        throw new Error('Ollama is not running. Please start Ollama and try again.');
      }
      
      throw new Error(`Ollama error: ${error.message}`);
    }
  }

  /**
   * Format conversation history for Ollama
   */
  static formatHistory(history, currentPrompt) {
    const messages = [];

    // Add conversation history
    if (history && history.length > 0) {
      history.forEach(msg => {
        messages.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content
        });
      });
    }

    // Add current prompt if not already in history
    if (!history || history.length === 0 || history[history.length - 1].content !== currentPrompt) {
      messages.push({
        role: 'user',
        content: currentPrompt
      });
    }

    return messages;
  }

  /**
   * Chat with tools - supports tool calling for agent loop
   * Uses options aligned with Gemini (temperature, max tokens) for consistent behavior.
   * @param {string} model - Model name
   * @param {array} messages - Full message history (user, assistant, tool)
   * @param {array} tools - Ollama-format tools
   * @param {object} options - Optional: { temperature, num_predict }
   * @returns {{ content?: string, tool_calls?: array }}
   */
  static async chatWithTools(model, messages, tools, options = {}) {
    const { temperature = 0.7, num_predict = 2048 } = options;
    try {
      const response = await axios.post(
        `${this.baseURL}/api/chat`,
        {
          model,
          messages: this.formatOllamaMessages(messages),
          tools,
          stream: false,
          options: {
            temperature,
            num_predict
          }
        },
        { timeout: 120000 }
      );

      const msg = response.data?.message;
      if (!msg) throw new Error('Invalid response from Ollama');

      return {
        content: msg.content || '',
        tool_calls: msg.tool_calls || []
      };
    } catch (error) {
      console.error('Ollama chatWithTools error:', error.message);
      if (error.code === 'ECONNREFUSED') {
        throw new Error('Ollama is not running. Please start Ollama and try again.');
      }
      throw new Error(`Ollama error: ${error.message}`);
    }
  }

  /**
   * Convert our history format to Ollama API format (user/assistant/tool)
   */
  static formatOllamaMessages(messages) {
    return messages.map(m => {
      if (m.role === 'model') {
        return { role: 'assistant', content: m.content || '', tool_calls: m.tool_calls };
      }
      if (m.role === 'tool') {
        return { role: 'tool', tool_name: m.name, content: String(m.content) };
      }
      if (m.role === 'system') {
        return { role: 'system', content: m.content };
      }
      return { role: m.role, content: m.content };
    });
  }

  /**
   * Check if Ollama is running
   */
  static async isRunning() {
    try {
      await axios.get(`${this.baseURL}/api/tags`, { timeout: 3000 });
      return true;
    } catch (error) {
      return false;
    }
  }
}

module.exports = OllamaService;