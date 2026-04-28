#!/usr/bin/env node
/**
 * Friday Behavioral Eval — LLM-as-Judge
 *
 * Runs the backend OrchestratorAgent against a suite of prompts and uses
 * Gemini as a judge to score each response against a plain-English rubric.
 *
 * Why LLM-as-judge instead of assertion-based tests:
 *   AI responses are non-deterministic. A judge can reason about whether the
 *   response "fulfilled the intent" even when the exact wording varies.
 *   It also validates WHICH tools were called, not just what text came back.
 *
 * Usage:
 *   node scripts/eval.js                        # all tests, gemini model
 *   node scripts/eval.js --filter search        # only tests tagged 'search'
 *   node scripts/eval.js --model ollama         # use Ollama instead
 *   node scripts/eval.js --no-judge             # skip judging, just show responses
 *   node scripts/eval.js --verbose              # show full responses
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

// ─── Mocks (must be installed before any backend requires) ─────────────────
const Module = require('module');
const _originalLoad = Module._load;

Module._load = function (request, parent, isMain) {
  // Mock electron-store so SettingsStore works outside Electron
  if (request === 'electron-store') {
    return class MockStore {
      constructor({ defaults = {} } = {}) {
        // Deep-clone defaults so the pre-set aliases (YT→youtube.com, etc.) work
        this._data = JSON.parse(JSON.stringify(defaults));
      }
      get(key, fallback) { return key in this._data ? this._data[key] : fallback; }
      set(key, val) { this._data[key] = val; }
    };
  }

  // Mock electron so tools that use shell.openExternal don't actually open browsers
  if (request === 'electron') {
    return {
      shell: {
        openExternal: async (url) => {
          // Record the call but don't actually launch anything
          process._evalOpenedUrls = process._evalOpenedUrls || [];
          process._evalOpenedUrls.push(url);
        }
      }
    };
  }

  return _originalLoad.apply(this, arguments);
};
// ───────────────────────────────────────────────────────────────────────────

const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const ToolRegistry   = require('../src/main/tools/ToolRegistry');
const GeminiProvider = require('../src/main/providers/GeminiProvider');
const OllamaProvider = require('../src/main/providers/OllamaProvider');
const OrchestratorAgent = require('../src/main/agents/OrchestratorAgent');
const OllamaService  = require('../src/main/services/OllamaService');

const { declaration: braveSearchDecl,       handler: braveSearchHandler       } = require('../src/main/tools/builtin/braveSearch');
const { declaration: openUrlDecl,           handler: openUrlHandler           } = require('../src/main/tools/builtin/openUrl');
const { declaration: openBookmarkDecl,      handler: openBookmarkHandler      } = require('../src/main/tools/builtin/openBookmark');
const { declaration: launchAppDecl,         handler: launchAppHandler         } = require('../src/main/tools/builtin/launchApp');
const { declaration: addEventDecl,          handler: addEventHandler          } = require('../src/main/tools/builtin/addEvent');
const { declaration: editEventDecl,         handler: editEventHandler         } = require('../src/main/tools/builtin/editEvent');
const { declaration: deleteEventDecl,       handler: deleteEventHandler       } = require('../src/main/tools/builtin/deleteEvent');
const { declaration: getCalendarSummaryDecl, handler: getCalendarSummaryHandler } = require('../src/main/tools/builtin/getCalendarSummary');

// ─── CLI args ──────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const getArg  = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const hasFlag = (flag) => args.includes(flag);

const filterTag   = getArg('--filter');
const modelArg    = getArg('--model') || 'gemini';
const noJudge     = hasFlag('--no-judge');
const verbose     = hasFlag('--verbose');

// ─── Terminal colours ──────────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m',   bold:  '\x1b[1m',
  green: '\x1b[32m',  yellow: '\x1b[33m',
  red:   '\x1b[31m',  cyan:   '\x1b[36m',
  gray:  '\x1b[90m',  blue:   '\x1b[34m',
  magenta: '\x1b[35m',
};

// ─── Test suite ────────────────────────────────────────────────────────────
/**
 * Each test case:
 *   tag          - category for --filter
 *   name         - human label
 *   prompt       - string, or array of strings for multi-turn
 *   criterion    - plain-English rubric the judge uses to score the response
 *   expectTools  - (optional) tool names that MUST appear in tool_calls
 *   noTools      - (optional) asserts NO tools were called
 *   requires     - (optional) 'BRAVE_API_KEY' | 'GOOGLE_AUTH' — skip if absent
 *   multiTurn    - (optional) true → prompts are sequential, judge sees final reply
 */
const TEST_CASES = [
  // ── General chat ────────────────────────────────────────────────────────
  {
    tag: 'chat', name: 'Capability overview',
    prompt: 'Hey! What can you help me with?',
    criterion: 'Introduces itself as Friday and lists at least two capabilities (e.g. web search, calendar, opening URLs, launching apps). Must NOT call any tools.',
    noTools: true,
  },
  {
    tag: 'chat', name: 'Simple arithmetic',
    prompt: 'What is 18 multiplied by 47?',
    criterion: 'Correctly answers 846. Must NOT call any tools.',
    noTools: true,
  },
  {
    tag: 'chat', name: 'Multi-turn context',
    prompt: ['What is the capital of Japan?', 'And what is the population of that city?'],
    criterion: 'Second response discusses Tokyo\'s population (around 14 million city / 37 million metro) without asking for clarification — proving the city from turn 1 was retained.',
    noTools: true,
    multiTurn: true,
  },
  {
    tag: 'chat', name: 'Timezone awareness',
    prompt: 'What timezone are you operating in?',
    criterion: 'Response mentions the configured timezone (America/Los_Angeles or Pacific). Must NOT call any tools.',
    noTools: true,
  },

  // ── Web search ──────────────────────────────────────────────────────────
  {
    tag: 'search', name: 'Current events',
    prompt: 'What are the latest AI news right now?',
    criterion: 'Calls brave_web_search and returns at least one recent AI news item with a specific detail (company, product, or event name).',
    expectTools: ['brave_web_search'],
    requires: 'BRAVE_API_KEY',
  },
  {
    tag: 'search', name: 'Factual lookup',
    prompt: 'Who is the CEO of OpenAI?',
    criterion: 'Calls brave_web_search and correctly identifies Sam Altman as CEO.',
    expectTools: ['brave_web_search'],
    requires: 'BRAVE_API_KEY',
  },
  {
    tag: 'search', name: 'Search + summarise',
    prompt: 'Search for the top 3 programming languages in 2025 and give me a quick summary',
    criterion: 'Calls brave_web_search and returns a concise list of at least 3 programming languages with brief context.',
    expectTools: ['brave_web_search'],
    requires: 'BRAVE_API_KEY',
  },

  // ── URL & bookmarks ─────────────────────────────────────────────────────
  {
    tag: 'url', name: 'Open a plain URL',
    prompt: 'Open google.com',
    criterion: 'Calls open_url with a URL containing "google" and confirms it was opened.',
    expectTools: ['open_url'],
  },
  {
    tag: 'url', name: 'Open URL in incognito',
    prompt: 'Open github.com in incognito mode',
    criterion: 'Calls open_url with incognito=true and a URL containing "github".',
    expectTools: ['open_url'],
  },
  {
    tag: 'bookmark', name: 'Open alias (YT)',
    prompt: 'Open YT',
    criterion: 'Calls open_bookmark with name "YT" (or similar). Should resolve to YouTube and confirm it was opened.',
    expectTools: ['open_bookmark'],
  },
  {
    tag: 'bookmark', name: 'Open unknown bookmark gracefully',
    prompt: 'Open my homework folder',
    criterion: 'Calls open_bookmark and either opens it (if configured) or returns a friendly error that "homework folder" was not found in settings — does NOT crash or hallucinate.',
    expectTools: ['open_bookmark'],
  },

  // ── Calendar ────────────────────────────────────────────────────────────
  {
    tag: 'calendar', name: 'View today\'s schedule',
    prompt: 'What\'s on my calendar today?',
    criterion: 'Calls get_calendar_summary with mode="daily" and relativeDay="today".',
    expectTools: ['get_calendar_summary'],
    requires: 'GOOGLE_AUTH',
  },
  {
    tag: 'calendar', name: 'View tomorrow\'s schedule',
    prompt: 'Do I have anything tomorrow?',
    criterion: 'Calls get_calendar_summary with mode="daily" and relativeDay="tomorrow".',
    expectTools: ['get_calendar_summary'],
    requires: 'GOOGLE_AUTH',
  },
  {
    tag: 'calendar', name: 'Add an event',
    prompt: 'Add a dentist appointment tomorrow at 3pm',
    criterion: 'Calls add_calendar_event with a start time at 3pm local time tomorrow and a title related to dentist.',
    expectTools: ['add_calendar_event'],
    requires: 'GOOGLE_AUTH',
  },

  // ── Multi-step tool chains ───────────────────────────────────────────────
  {
    tag: 'chain', name: 'Search then open result',
    prompt: 'Search for the Anthropic homepage URL and then open it',
    criterion: 'Calls brave_web_search first, then calls open_url with the Anthropic URL (anthropic.com). Both tool calls must appear.',
    expectTools: ['brave_web_search', 'open_url'],
    requires: 'BRAVE_API_KEY',
  },
];

// ─── Instrumented registry ─────────────────────────────────────────────────
class InstrumentedRegistry extends ToolRegistry {
  constructor() { super(); this.callLog = []; }
  async executeTool(name, args = {}) {
    const entry = { name, args, result: null, error: null };
    try {
      const r = await super.executeTool(name, args);
      entry.result = r;
      this.callLog.push(entry);
      return r;
    } catch (err) {
      entry.error = err.message;
      this.callLog.push(entry);
      throw err;
    }
  }
  reset() { this.callLog = []; }
}

// ─── Setup ─────────────────────────────────────────────────────────────────
function buildRegistry() {
  const reg = new InstrumentedRegistry();
  reg.registerBuiltin(braveSearchDecl.name,       braveSearchDecl,       braveSearchHandler);
  reg.registerBuiltin(openUrlDecl.name,           openUrlDecl,           openUrlHandler);
  reg.registerBuiltin(openBookmarkDecl.name,      openBookmarkDecl,      openBookmarkHandler);
  reg.registerBuiltin(launchAppDecl.name,         launchAppDecl,         launchAppHandler);
  reg.registerBuiltin(addEventDecl.name,          addEventDecl,          addEventHandler);
  reg.registerBuiltin(editEventDecl.name,         editEventDecl,         editEventHandler);
  reg.registerBuiltin(deleteEventDecl.name,       deleteEventDecl,       deleteEventHandler);
  reg.registerBuiltin(getCalendarSummaryDecl.name, getCalendarSummaryDecl, getCalendarSummaryHandler);
  return reg;
}

// ─── Credential checks ─────────────────────────────────────────────────────
function hasGoogleAuth() {
  const candidates = [
    path.join(process.env.APPDATA || '', 'Electron', 'google-calendar-token.json'),
    path.join(process.cwd(), 'google-calendar-token.json'),
  ];
  return candidates.some(p => { try { return fs.existsSync(p); } catch { return false; } });
}

function canRun(tc) {
  if (tc.requires === 'BRAVE_API_KEY' && !process.env.BRAVE_API_KEY) return { ok: false, reason: 'BRAVE_API_KEY not set' };
  if (tc.requires === 'GOOGLE_AUTH'   && !hasGoogleAuth())           return { ok: false, reason: 'Google Calendar not authenticated' };
  return { ok: true };
}

// ─── LLM judge ─────────────────────────────────────────────────────────────
async function judge({ prompt, response, toolCalls, criterion, expectTools, noTools }) {
  if (!process.env.GEMINI_API_KEY) return { rating: 'UNKNOWN', reason: 'No GEMINI_API_KEY for judge' };

  const finalPrompt = Array.isArray(prompt) ? prompt[prompt.length - 1] : prompt;
  const toolSummary = toolCalls.length > 0
    ? toolCalls.map(t => `  ${t.name}(${JSON.stringify(t.args)})`).join('\n')
    : '  (none)';

  const toolConstraints = [];
  if (noTools)      toolConstraints.push('IMPORTANT: No tools should have been called.');
  if (expectTools?.length) toolConstraints.push(`IMPORTANT: The following tools MUST have been called: ${expectTools.join(', ')}.`);

  const judgePrompt = `You are evaluating a personal AI assistant called Friday.

User's last message: "${finalPrompt}"

Tools called:
${toolSummary}

Assistant's response:
"${response}"

Pass criterion: ${criterion}
${toolConstraints.join('\n')}

Rate this response. Consider both the content quality AND whether the right tools were (or weren't) called.
- PASS    → Fully satisfies the criterion and all tool constraints
- PARTIAL → Partially satisfies (e.g. correct tool called but response has gaps, or response good but wrong tool)
- FAIL    → Does not satisfy the criterion

Reply with JSON only, no markdown fences:
{"rating":"PASS","reason":"one-sentence explanation"}`;

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
    const result = await model.generateContent(judgePrompt);
    const text = result.response.text().trim().replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch (err) {
    return { rating: 'ERROR', reason: `Judge error: ${err.message}` };
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const registry = buildRegistry();
  const geminiProvider = new GeminiProvider(registry);
  const ollamaProvider = new OllamaProvider(registry);
  const providers = { gemini: geminiProvider, ollama: ollamaProvider };

  let modelName = process.env.DEFAULT_MODEL || 'gemini-2.0-flash-exp';
  let modelType = 'gemini';

  if (modelArg === 'ollama') {
    modelType = 'ollama';
    const ollamaModels = await OllamaService.fetchModels();
    modelName = ollamaProvider.getPreferredFallback(ollamaModels);
    if (!modelName) {
      console.error(`${c.red}Ollama is not running or has no models.${c.reset}`);
      process.exit(1);
    }
  }

  const suite = filterTag ? TEST_CASES.filter(t => t.tag === filterTag) : TEST_CASES;

  if (suite.length === 0) {
    console.log(`${c.yellow}No tests match tag "${filterTag}". Available tags: ${[...new Set(TEST_CASES.map(t => t.tag))].join(', ')}${c.reset}`);
    process.exit(0);
  }

  console.log(`\n${c.bold}${c.cyan}🧸 Friday Behavioral Eval${c.reset}`);
  console.log(`${c.gray}  Model : ${modelName} (${modelType})`);
  console.log(`  Judge : ${noJudge ? 'disabled' : 'Gemini (LLM-as-judge)'}`);
  console.log(`  Tests : ${suite.length}${filterTag ? ` [tag: ${filterTag}]` : ''}${c.reset}\n`);

  const PAD = 34;
  const sym = { PASS: `${c.green}✓ PASS   ${c.reset}`, PARTIAL: `${c.yellow}~ PARTIAL${c.reset}`, FAIL: `${c.red}✗ FAIL   ${c.reset}`, SKIP: `${c.gray}⊘ SKIP   ${c.reset}`, UNKNOWN: `${c.gray}? UNKNOWN${c.reset}`, ERROR: `${c.red}! ERROR  ${c.reset}` };

  const results = [];
  let lastTag = null;

  for (const tc of suite) {
    if (tc.tag !== lastTag) {
      lastTag = tc.tag;
      console.log(`${c.bold}${c.blue}  ── ${tc.tag.toUpperCase()} ──${c.reset}`);
    }

    const check = canRun(tc);
    if (!check.ok) {
      const label = tc.name.padEnd(PAD);
      console.log(`  ${sym.SKIP} ${c.gray}${label} ${check.reason}${c.reset}`);
      results.push({ ...tc, status: 'SKIP', reason: check.reason });
      continue;
    }

    // Fresh agent per test so history doesn't bleed between tests
    const agent = new OrchestratorAgent(registry, providers);
    registry.reset();

    let response = '';
    let runError = null;
    const prompts = Array.isArray(tc.prompt) ? tc.prompt : [tc.prompt];

    try {
      for (const p of prompts) {
        const res = await agent.processMessage(p, modelName, modelType, {});
        response = res.response;
      }
    } catch (err) {
      runError = err.message;
      response = `[ERROR: ${err.message}]`;
    }

    const toolCalls = registry.callLog.map(e => ({ name: e.name, args: e.args }));

    let rating = 'UNKNOWN';
    let reason = '';

    if (runError) {
      rating = 'FAIL';
      reason = runError;
    } else if (!noJudge) {
      const j = await judge({ prompt: tc.prompt, response, toolCalls, criterion: tc.criterion, expectTools: tc.expectTools, noTools: tc.noTools });
      rating = j.rating;
      reason = j.reason;
    }

    const label = tc.name.padEnd(PAD);
    console.log(`  ${sym[rating] || sym.UNKNOWN} ${label}`);

    if (toolCalls.length > 0) {
      console.log(`  ${c.gray}         tools  : ${toolCalls.map(t => t.name).join(' → ')}${c.reset}`);
    }
    if (reason) {
      console.log(`  ${c.gray}         judge  : ${reason}${c.reset}`);
    }

    const preview = verbose
      ? response
      : response.replace(/\n/g, ' ').slice(0, 110) + (response.length > 110 ? '…' : '');
    console.log(`  ${c.gray}         reply  : "${preview}"${c.reset}\n`);

    results.push({ ...tc, status: rating, reason, response, toolCalls });
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;

  const scored   = results.filter(r => !['SKIP', 'UNKNOWN'].includes(r.status)).length;
  const passed   = (counts.PASS    || 0);
  const partial  = (counts.PARTIAL || 0);
  const failed   = (counts.FAIL    || 0);
  const score    = scored > 0 ? Math.round(((passed + partial * 0.5) / scored) * 100) : 0;
  const scoreBar = '█'.repeat(Math.round(score / 5)) + '░'.repeat(20 - Math.round(score / 5));

  console.log(`${c.bold}── Results ────────────────────────────────────────${c.reset}`);
  console.log(`  ${c.green}PASS   ${c.reset}: ${passed}`);
  console.log(`  ${c.yellow}PARTIAL${c.reset}: ${partial}`);
  console.log(`  ${c.red}FAIL   ${c.reset}: ${failed}`);
  console.log(`  ${c.gray}SKIP   : ${counts.SKIP || 0}${c.reset}`);
  console.log(`\n  ${c.bold}Score  : ${score}%  [${scoreBar}]${c.reset}`);
  console.log(`  ${c.gray}(${passed} pass + ${partial}×0.5 partial out of ${scored} scored tests)${c.reset}\n`);
}

main().catch(err => {
  console.error(`\n${c.red}${c.bold}Fatal: ${err.message}${c.reset}\n`, err.stack);
  process.exit(1);
});
