/**
 * AgentRuntime — event-driven agentic execution engine.
 *
 * Replaces OrchestratorAgent's callback-heavy design with a single typed
 * event stream. All progress, tool calls, errors, and cost data flows out
 * through one `emit(event)` function passed at construction time.
 *
 * Event schema — every event has `{ type, sessionId, ...payload }`.
 * All agent events are sent on a single 'agent-event' IPC channel:
 *
 *   { type: 'part.new',    sessionId, part }        — a new part was added
 *   { type: 'part.delta',  sessionId, partId, text } — streaming text delta
 *   { type: 'part.update', sessionId, part }         — part state changed (tool, step-finish)
 *   { type: 'session.status', sessionId, status }    — 'running' | 'idle' | 'error'
 *   { type: 'permission.request', sessionId, toolName, args, requestId } — needs user approval
 *   { type: 'memory.proposal', sessionId, facts }    — memory extraction proposals
 *   { type: 'session.title', sessionId, title }      — first-message title was set
 *
 * Permission responses come back via the 'agent-permission-response' IPC
 * channel: { requestId, approved, alwaysAllow }.
 *
 * Design principles:
 *   - SessionContext carries all per-session state (workspaceRoot, permissions,
 *     cost tracker, abort signal)
 *   - Parts are emitted incrementally so the renderer can render without polling
 *   - Compaction is automatic via CompactionManager
 *   - Memory extraction and summarization are fire-and-forget background tasks
 *   - All tool handlers receive (args, context, onStream) — the context arg is
 *     the SessionContext, so tools can check permissions and workspace root
 */

'use strict';

const { randomUUID } = require('crypto');

const {
  makeTextPart, makeReasoningPart, makeToolPart, makeStepStartPart,
  makeStepFinishPart, makePatchPart, makeErrorPart, makeCompactionPart,
  toolStateRunning, toolStateCompleted, toolStateError,
  partsToText,
} = require('../types/parts');

// ─── Constants ────────────────────────────────────────────────────────────────

const SUMMARY_THRESHOLD = 20;  // start summarising after N pairs
const SUMMARY_INTERVAL  = 5;   // re-summarise every N new pairs
const RECENT_PAIRS      = 10;  // always keep this many raw pairs in context
const MAX_ITER_CHAT     = 10;

// Tools blocked in incognito mode — anything that leaves the machine or hits
// an authenticated external account. Local actions like launching a browser
// are allowed because the tool itself never transmits from Friday's process.
const INCOGNITO_EXCLUDED_TOOLS = new Set([
  'brave_web_search',
  'fetch_page',
  'add_event',
  'edit_event',
  'delete_event',
  'get_calendar_summary',
]);

// ─── AgentRuntime class ───────────────────────────────────────────────────────

class AgentRuntime {
  /**
   * @param {object} opts
   * @param {object}   opts.toolRegistry   — ToolRegistry instance
   * @param {object}   opts.providerManager — ProviderManager instance
   * @param {object}   opts.store           — PersistentStore instance
   * @param {Function} opts.emit            — async (event: object) => void
   *   Called for every typed event. In production this wraps win.webContents.send.
   */
  constructor({ toolRegistry, providerManager, store, emit }) {
    this._toolRegistry     = toolRegistry;
    this._providerManager  = providerManager;
    this._store            = store;
    this._emit             = emit;

    /** @type {Map<string, (approved: boolean, alwaysAllow: boolean) => void>} */
    this._pendingPermissions = new Map();

    this._summarizing   = false;
    this._extracting    = false;
    this._extractCtr    = 0;
    this._proceduralCtr = 0;

    /** Ephemeral history for incognito sessions — never touches disk. */
    this._incognitoHistory = [];
  }

  /** Reset the in-memory incognito conversation (e.g. on toggle off). */
  clearIncognitoHistory() {
    this._incognitoHistory = [];
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Process one user message within the given session context.
   *
   * @param {string}         message  — full text sent to the LLM (may include doc context)
   * @param {string}         modelName
   * @param {SessionContext} context
   * @param {object}         [opts]
   * @param {Array}          [opts.images]
   * @param {string}         [opts.display]  — what the user typed (for storage)
   * @param {boolean}        [opts.forceSearch]
   */
  async processMessage(message, modelName, context, opts = {}) {
    const { images = [], display = null, forceSearch = false, incognito = false } = opts;
    const { sessionId } = context;

    // Fresh abort controller for this turn
    context.resetAbort();

    this._emit({ type: 'session.status', sessionId, status: 'running' });

    try {
      const result = (forceSearch && !incognito)
        ? await this._runForceSearch(message, modelName, context, images, display)
        : await this._runToolLoop(message, modelName, context, images, display, incognito);

      this._emit({ type: 'session.status', sessionId, status: 'idle' });
      return result;
    } catch (err) {
      if (err.name === 'AbortError' || context.signal?.aborted) {
        this._emit({ type: 'session.status', sessionId, status: 'idle' });
        return { aborted: true };
      }

      const errPart = makeErrorPart(randomUUID(), err.name || 'Error', err.message, false);
      this._emit({ type: 'part.new', sessionId, part: errPart });
      this._emit({ type: 'session.status', sessionId, status: 'error' });
      throw err;
    }
  }

  /**
   * Resolve a pending permission request.
   * Called from the IPC handler for 'agent-permission-response'.
   *
   * @param {string}  requestId
   * @param {boolean} approved
   * @param {boolean} alwaysAllow
   */
  resolvePermission(requestId, approved, alwaysAllow = false) {
    const resolve = this._pendingPermissions.get(requestId);
    if (resolve) {
      this._pendingPermissions.delete(requestId);
      resolve(approved, alwaysAllow);
    }
  }

  /**
   * Abort the running turn for a session.
   * @param {SessionContext} context
   */
  abort(context) {
    context.abort();
  }

  // ─── Core tool loop ──────────────────────────────────────────────────────────

  async _runToolLoop(message, modelName, context, images, display, incognito = false) {
    const { sessionId } = context;
    const appMode = 'chat';
    const excludeTools = incognito ? INCOGNITO_EXCLUDED_TOOLS : null;

    if (!incognito) this._maybeSetTitle(display ?? message, sessionId);

    // Load context: memory + episodes + few-shots (skipped in incognito)
    const [memoryEntries, episodes, fewShots] = incognito
      ? [[], [], []]
      : await Promise.all([
          this._store ? this._store.getRelevantMemory(message, 8, appMode)                           : [],
          this._store ? this._store.getRelevantEpisodes(message, sessionId, 3)                       : [],
          this._store ? this._store.getRelevantFewShots(message, 2, appMode)                         : [],
        ]);

    // Build initial message array via provider
    const provider = this._providerManager._route(modelName);
    const history  = incognito
      ? this._incognitoHistory
      : (this._store ? this._store.getRecentPairs(sessionId, RECENT_PAIRS) : []);
    const summary  = incognito ? null : (this._store?.getSessionSummary(sessionId)?.text ?? null);

    const messages = provider.initMessages(
      memoryEntries, summary, episodes,
      context.agent ?? null, null,
      appMode, fewShots, null
    );
    for (const turn of history) {
      provider.appendUser(messages, turn.user);
      provider.appendHistoryAssistant(messages, turn.assistant);
    }
    provider.appendUser(messages, message, images);

    const maxIter  = MAX_ITER_CHAT;
    let   usedSearch = false;
    let   stepIndex  = 0;

    for (let i = 0; i < maxIter; i++) {
      if (context.signal?.aborted) break;

      // ── Step start ──────────────────────────────────────────────────────────
      const stepStartPart = makeStepStartPart(randomUUID(), stepIndex);
      this._emit({ type: 'part.new', sessionId, part: stepStartPart });

      const before = context.costTracker.snapshot();

      // Collect parts for this step
      const stepParts = [];
      let   currentTextPart     = null;
      let   currentReasonPart   = null;

      // Streaming callbacks
      const onChunk = (chunk) => {
        if (typeof chunk === 'string') {
          // Text delta
          if (!currentTextPart) {
            currentTextPart = makeTextPart(randomUUID());
            stepParts.push(currentTextPart);
            this._emit({ type: 'part.new', sessionId, part: currentTextPart });
          }
          currentTextPart.content += chunk;
          this._emit({ type: 'part.delta', sessionId, partId: currentTextPart.id, text: chunk });
        } else if (chunk?.type === 'thinking') {
          // Reasoning block
          if (!currentReasonPart) {
            currentReasonPart = makeReasoningPart(randomUUID());
            stepParts.push(currentReasonPart);
            this._emit({ type: 'part.new', sessionId, part: currentReasonPart });
          }
          currentReasonPart.content += chunk.text ?? '';
          this._emit({ type: 'part.delta', sessionId, partId: currentReasonPart.id, text: chunk.text ?? '' });
        }
      };

      // ── LLM call ──────────────────────────────────────────────��─────────────
      const chatResult = await provider.chatWithTools(messages, modelName, onChunk, context.signal, appMode, { excludeTools });
      const { text, toolCalls } = chatResult;

      // Close streaming text part and emit update so renderer converts raw text → markdown
      if (currentTextPart) {
        currentTextPart.time.end = Date.now();
        this._emit({ type: 'part.update', sessionId, part: currentTextPart });
      }
      if (currentReasonPart) {
        currentReasonPart.time.end = Date.now();
        this._emit({ type: 'part.update', sessionId, part: currentReasonPart });
      }

      // Track usage
      if (chatResult.usage) context.costTracker.add(chatResult.usage);

      // ── No tool calls → final response ──────────────────────────────────────
      if (!toolCalls || toolCalls.length === 0) {
        const finalText = text || "I couldn't generate a response.";
        const type      = usedSearch ? 'search' : 'chat';

        // Emit step-finish
        const stepFinish = makeStepFinishPart(
          randomUUID(), stepIndex,
          context.costTracker.stepTokens(before),
          context.costTracker.stepCostUSD(before)
        );
        this._emit({ type: 'part.update', sessionId, part: stepFinish });

        // Collect all parts emitted in this agent turn (not just this step)
        // For now collect just the final text part + step markers for storage
        const allParts = stepParts.filter(p => p.type !== 'step-start');
        allParts.push(stepFinish);

        // Persist — skipped entirely in incognito mode; we hold the pair in memory instead.
        if (incognito) {
          this._incognitoHistory.push({ user: display ?? message, assistant: finalText });
          // Cap transient history so a long incognito session doesn't bloat the prompt.
          if (this._incognitoHistory.length > 20) {
            this._incognitoHistory.splice(0, this._incognitoHistory.length - 20);
          }
        } else {
          this._saveExchange(message, finalText, type, images, display, appMode, allParts, chatResult.usage);
          this._maybeSummarize(provider, modelName, sessionId).catch(() => {});
          this._maybeExtractMemory(message, finalText, provider, modelName, appMode, sessionId).catch(() => {});
        }

        return {
          type,
          response: finalText,
          usage:    context.costTracker.toUsageObject(),
          parts:    allParts,
        };
      }

      // ── Tool calls ──────────────────────────────────────────────────────────
      provider.appendResponse(messages, chatResult);

      const toolParts = [];
      for (const { id: callId, name, args } of toolCalls) {
        if (name === 'brave_web_search') usedSearch = true;

        const toolPart = makeToolPart(randomUUID(), callId, name, args);
        stepParts.push(toolPart);
        toolParts.push(toolPart);
        this._emit({ type: 'part.new', sessionId, part: toolPart });
      }

      // Permission checks (serial — one banner at a time)
      const approvals = new Map(); // callId → boolean
      for (const { id: callId, name, args } of toolCalls) {
        const decision = context.permissionPolicy.check(name, context, args);
        if (decision === 'allow') {
          approvals.set(callId, { ok: true, alwaysAllow: false });
          continue;
        }

        // Needs user approval
        const requestId = randomUUID();
        const approved  = await this._requestPermission(requestId, name, args, sessionId, context);
        approvals.set(callId, approved);
      }

      // Execute approved tools (in parallel)
      const toolResults = await Promise.all(
        toolCalls.map(async ({ id: callId, name, args }) => {
          const { ok, alwaysAllow } = approvals.get(callId) ?? { ok: false, alwaysAllow: false };
          const toolPart = toolParts.find(p => p.callId === callId);

          if (!ok) {
            const result = `Action denied by user. The tool "${name}" was not executed.`;
            if (toolPart) {
              toolPart.state = toolStateError(result);
              toolPart.time.end = Date.now();
              this._emit({ type: 'part.update', sessionId, part: toolPart });
            }
            return { name, result };
          }

          // Mark as running
          if (toolPart) {
            toolPart.state = toolStateRunning(name);
            this._emit({ type: 'part.update', sessionId, part: toolPart });
          }

          try {
            const onStream = (chunk) => {
              if (toolPart) {
                this._emit({ type: 'tool.stream', sessionId, partId: toolPart.id, chunk });
              }
            };
            const result = await this._toolRegistry.executeTool(name, args, onStream);

            if (toolPart) {
              toolPart.state = toolStateCompleted(result, name, null, false);
              toolPart.time.end = Date.now();
              this._emit({ type: 'part.update', sessionId, part: toolPart });
            }
            return { name, result };
          } catch (err) {
            const errMsg = `Error: ${err.message}`;
            if (toolPart) {
              toolPart.state = toolStateError(errMsg);
              toolPart.time.end = Date.now();
              this._emit({ type: 'part.update', sessionId, part: toolPart });
            }
            return { name, result: errMsg };
          }
        })
      );

      provider.appendToolResults(messages, toolResults);

      // ── Emit step-finish ────────────────────────────────────────────────────
      const stepFinishPart = makeStepFinishPart(
        randomUUID(), stepIndex,
        context.costTracker.stepTokens(before),
        context.costTracker.stepCostUSD(before)
      );
      this._emit({ type: 'part.update', sessionId, part: stepFinishPart });
      stepIndex++;
    }

    // Iteration cap hit
    const fallback = 'I encountered an issue processing your request.';
    if (!incognito) {
      this._saveExchange(message, fallback, 'chat', [], display, appMode);
    }
    return { type: 'chat', response: fallback };
  }

  // ─── Force-search path ────────────────────────────────────────────────────

  async _runForceSearch(message, modelName, context, images, display) {
    const { sessionId } = context;
    const appMode = 'chat';
    this._maybeSetTitle(display ?? message, sessionId);

    const searchResult  = await this._toolRegistry.executeTool('brave_web_search', { query: message });
    const summaryPrompt = `Based on these search results, answer: "${message}"\n\nSearch Results:\n${searchResult}`;

    const [memoryEntries, episodes] = await Promise.all([
      this._store ? this._store.getRelevantMemory(message, 8, appMode) : [],
      this._store ? this._store.getRelevantEpisodes(message, sessionId, 3) : [],
    ]);

    const provider  = this._providerManager._route(modelName);
    const summary   = this._store?.getSessionSummary(sessionId)?.text ?? null;
    const messages  = provider.initMessages(memoryEntries, summary, episodes, context.agent, null, appMode, [], null);
    provider.appendUser(messages, summaryPrompt, images);

    let textContent = '';
    const textPart  = makeTextPart(randomUUID());
    this._emit({ type: 'part.new', sessionId, part: textPart });

    const chatResult = await provider.chatWithTools(messages, modelName, (chunk) => {
      if (typeof chunk === 'string') {
        textContent += chunk;
        textPart.content += chunk;
        this._emit({ type: 'part.delta', sessionId, partId: textPart.id, text: chunk });
      }
    }, context.signal);

    textPart.time.end = Date.now();
    const finalText = chatResult.text || textContent || 'No summary available.';
    if (chatResult.usage) context.costTracker.add(chatResult.usage);

    this._saveExchange(message, finalText, 'search', [], display, appMode);
    return { type: 'search', response: finalText };
  }

  // ─── Permission gate ──────────────────────────────────────────────────────

  /**
   * Ask the renderer for permission via IPC and wait for a response.
   * @returns {{ ok: boolean, alwaysAllow: boolean }}
   */
  _requestPermission(requestId, toolName, args, sessionId, context) {
    return new Promise((resolve) => {
      this._pendingPermissions.set(requestId, (approved, alwaysAllow) => {
        if (alwaysAllow) {
          context.approveTool(toolName);
        }
        resolve({ ok: approved, alwaysAllow });
      });
      this._emit({
        type:      'permission.request',
        sessionId,
        toolName,
        args,
        requestId,
      });
    });
  }

  // ─── Persistence helpers ──────────────────────────────────────────────────

  _saveExchange(user, assistant, type, images, display, appMode, parts = null, usage = null) {
    if (!this._store) return;
    // currentSessionId is passed via the context but we need it here
    // We store it on `this` temporarily each turn — set by processMessage via context
    const sessionId = this._activeSessionId;
    if (!sessionId) return;

    const storedUser = display ?? user;
    this._store.addMessage(sessionId, 'user',      storedUser, 'chat', images, { display: storedUser });
    this._store.addMessage(sessionId, 'assistant', assistant,  type,   [],     { parts, usage });
    this._store.indexSessionTags(sessionId);
    this._store.indexSessionEpisode(sessionId).catch(() => {});
  }

  // ─── Background summarization ─────────────────────────────────────────────

  async _maybeSummarize(provider, modelName, sessionId) {
    if (!this._store || this._summarizing) return;
    const allPairs  = this._store.getAllPairs(sessionId);
    const total     = allPairs.length;
    if (total <= SUMMARY_THRESHOLD) return;

    const toSummarize = total - RECENT_PAIRS;
    const existing    = this._store.getSessionSummary(sessionId);
    const lastIdx     = existing?.upToIndex || 0;
    if (toSummarize - lastIdx < SUMMARY_INTERVAL) return;

    this._summarizing = true;
    try {
      const pairs  = allPairs.slice(0, toSummarize);
      const prompt = this._buildSummaryPrompt(pairs, existing?.text ?? null);
      const cheap  = provider.getCheapModel?.() ?? modelName;
      const msgs   = provider.initMessages([]);
      provider.appendUser(msgs, prompt);
      const result = await provider.chatWithTools(msgs, cheap, null, null, 'chat');
      if (result.text) {
        this._store.setSessionSummary(sessionId, result.text, toSummarize);
      }
    } catch (err) {
      console.error('[AgentRuntime] Summarize failed:', err.message);
    } finally {
      this._summarizing = false;
    }
  }

  // ─── Background memory extraction ────────────────────────────────────────

  async _maybeExtractMemory(userMessage, assistantText, provider, modelName, appMode, sessionId) {
    if (!this._store || this._extracting) return;
    this._extractCtr++;
    if (this._extractCtr % 5 !== 0) return;
    if ((userMessage + assistantText).length < 300) return;

    this._extracting = true;
    try {
      const existing    = this._store.getMemory();
      const existingStr = existing.length > 0
        ? '\n\nAlready in memory — do NOT repeat:\n' + existing.map(m => `- ${m.content}`).join('\n')
        : '';

      const prompt =
        `Extract at most 2 genuinely long-term-worth facts from this exchange.\n` +
        `Categories: preference | project | entity | fact.\n` +
        `Skip: one-off questions, temp tasks, pleasantries.` +
        existingStr +
        `\n\nUser: ${userMessage.slice(0, 800)}\nAssistant: ${assistantText.slice(0, 400)}\n\n` +
        `Reply ONLY with JSON: [{\"content\": \"...\", \"category\": \"...\"}] or [].`;

      const cheap  = provider.getCheapModel?.() ?? modelName;
      const msgs   = provider.initMessages([]);
      provider.appendUser(msgs, prompt);
      const result = await provider.chatWithTools(msgs, cheap, null, null, 'chat');
      if (!result.text) return;

      const match = result.text.match(/\[[\s\S]*?\]/);
      if (!match) return;
      const facts = JSON.parse(match[0]);
      if (!Array.isArray(facts) || facts.length === 0) return;

      const VALID = new Set(['fact', 'preference', 'project', 'entity', 'procedural']);
      const existingWords = existing.map(m =>
        new Set(m.content.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(w => w.length > 3))
      );

      const novel = [];
      for (const f of facts) {
        const content  = typeof f === 'string' ? f.trim() : String(f?.content ?? '').trim();
        const category = VALID.has(f?.category) ? f.category : 'fact';
        if (!content || content.length < 10 || content.length > 120) continue;

        const fw = new Set(content.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(w => w.length > 3));
        const isDupe = existingWords.some(ew => {
          const overlap = [...fw].filter(w => ew.has(w)).length;
          return overlap >= 3 || (fw.size > 0 && overlap / fw.size > 0.6);
        });
        if (isDupe) continue;
        novel.push({ content, category });
        existingWords.push(fw);
      }

      if (novel.length > 0) {
        this._emit({
          type:      'memory.proposal',
          sessionId,
          facts:     novel.map(f => ({ ...f, mode: appMode })),
        });
      }
    } catch (err) {
      console.warn('[AgentRuntime] Memory extraction failed:', err.message);
    } finally {
      this._extracting = false;
    }
  }

  // ─── Utility helpers ──────────────────────────────────────────────────────

  _maybeSetTitle(message, sessionId) {
    if (!this._store || !sessionId) return;
    const session = this._store.getSession(sessionId);
    if (!session || session.title) return;
    const MAX   = 38;
    const words = message.trim().split(/\s+/);
    let title   = '';
    for (const word of words) {
      const candidate = title ? `${title} ${word}` : word;
      if (candidate.length > MAX) break;
      title = candidate;
    }
    if (!title) title = message.slice(0, MAX);
    this._store.touchSession(sessionId, title);
    this._emit({ type: 'session.title', sessionId, title });
  }

  _buildSummaryPrompt(pairs, existingSummary) {
    const dialogue = pairs.map((p, i) =>
      `[${i + 1}] User: ${p.user.slice(0, 400)}\nAssistant: ${p.assistant.slice(0, 400)}`
    ).join('\n\n');

    if (existingSummary) {
      return `Update this summary with the new exchanges below.\nKeep to 3-6 bullet points.\nExisting: ${existingSummary}\n\nNew:\n${dialogue}`;
    }
    return `Summarise this conversation in 3-6 concise bullet points.\n\n${dialogue}`;
  }

  /**
   * Set the active session ID before running processMessage.
   * (The session ID is also on the context but we need it in _saveExchange
   *  which doesn't have context in scope.)
   */
  set activeSessionId(id) {
    this._activeSessionId = id;
  }
}

module.exports = AgentRuntime;
