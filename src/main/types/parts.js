/**
 * Part type definitions for the message parts system.
 *
 * Every assistant message stores a `parts` array instead of a flat content
 * string. This enables tool call tracking, diff views, streaming without
 * flicker, cost accounting, and session replay.
 *
 * Part objects are plain JS objects — no classes, no methods.
 * They are stored as JSON in the `parts` column of the messages table.
 */

'use strict';

// ─── Part type constants ────────────────────────────────────────────────────

const PartType = {
  TEXT:        'text',
  REASONING:   'reasoning',
  TOOL:        'tool',
  STEP_START:  'step-start',
  STEP_FINISH: 'step-finish',
  PATCH:       'patch',
  ERROR:       'error',
  COMPACTION:  'compaction',
  TODO:        'todo',
};

// ─── Tool state constants ────────────────────────────────────────────────────

const ToolStateType = {
  PENDING:   'pending',
  RUNNING:   'running',
  COMPLETED: 'completed',
  ERROR:     'error',
};

// ─── Part factories ──────────────────────────────────────────────────────────

/**
 * Streamed assistant text.
 */
function makeTextPart(id) {
  return { id, type: PartType.TEXT, content: '', time: { start: Date.now(), end: null } };
}

/**
 * Extended reasoning / thinking block (Claude extended thinking or pre-response analysis).
 */
function makeReasoningPart(id) {
  return { id, type: PartType.REASONING, summary: 'Thinking…', content: '', time: { start: Date.now(), end: null } };
}

/**
 * A tool invocation with full state machine.
 * @param {string} id        — unique part id
 * @param {string} callId    — tool_use id from the LLM response
 * @param {string} toolName
 * @param {object} input     — arguments passed to the tool
 */
function makeToolPart(id, callId, toolName, input) {
  return {
    id,
    type:     PartType.TOOL,
    callId,
    toolName,
    input,
    state:    { type: ToolStateType.PENDING },
    time:     { start: Date.now(), end: null },
  };
}

/**
 * Mark a step boundary (one iteration of the agent loop).
 */
function makeStepStartPart(id, index) {
  return { id, type: PartType.STEP_START, index, time: { start: Date.now(), end: null } };
}

/**
 * Close a step with token + cost accounting.
 */
function makeStepFinishPart(id, index, tokens, costUSD) {
  return {
    id,
    type:   PartType.STEP_FINISH,
    index,
    tokens, // { input, output, cacheRead, cacheWrite }
    cost:   costUSD ?? null,
    time:   { start: Date.now(), end: Date.now() },
  };
}

/**
 * Filesystem diff — emitted after any step that modifies files.
 * @param {Array<{path:string, diff:string, additions:number, deletions:number}>} files
 */
function makePatchPart(id, files) {
  return { id, type: PartType.PATCH, files, time: { start: Date.now(), end: Date.now() } };
}

/**
 * Inline error — rate limits, context overflow, tool errors.
 */
function makeErrorPart(id, name, message, retry = false) {
  return { id, type: PartType.ERROR, name, message, retry, time: { start: Date.now(), end: Date.now() } };
}

/**
 * Context compaction notice.
 */
function makeCompactionPart(id, summary, messagesRemoved) {
  return { id, type: PartType.COMPACTION, summary, messagesRemoved, time: { start: Date.now(), end: Date.now() } };
}

/**
 * Structured todo list, updated live as the agent works.
 * @param {Array<{id:string, content:string, status:'pending'|'in_progress'|'completed'}>} items
 */
function makeTodoPart(id, items) {
  return { id, type: PartType.TODO, items, time: { start: Date.now(), end: Date.now() } };
}

// ─── State transition helpers ────────────────────────────────────────────────

function toolStateRunning(title = '') {
  return { type: ToolStateType.RUNNING, title };
}

function toolStateCompleted(output, title = '', metadata = null, outputTruncated = false) {
  return { type: ToolStateType.COMPLETED, output, title, metadata, outputTruncated };
}

function toolStateError(message) {
  return { type: ToolStateType.ERROR, message };
}

// ─── Serialization helpers ───────────────────────────────────────────────────

/**
 * Convert a legacy message (role + content string) to a single TextPart array.
 * Used when loading old messages that predate the parts system.
 */
function contentToParts(content, role) {
  const { randomUUID } = require('crypto');
  if (role === 'user') {
    // User messages stay as plain text — parts only matter for assistant messages
    return null;
  }
  if (!content) return [];
  return [{ id: randomUUID(), type: PartType.TEXT, content, time: { start: 0, end: 0 } }];
}

/**
 * Extract the plain text content from a parts array (for display fallbacks,
 * search indexing, and legacy compatibility).
 */
function partsToText(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter(p => p.type === PartType.TEXT || p.type === PartType.REASONING)
    .map(p => p.content || '')
    .join('');
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  PartType,
  ToolStateType,

  // Factories
  makeTextPart,
  makeReasoningPart,
  makeToolPart,
  makeStepStartPart,
  makeStepFinishPart,
  makePatchPart,
  makeErrorPart,
  makeCompactionPart,
  makeTodoPart,

  // State transitions
  toolStateRunning,
  toolStateCompleted,
  toolStateError,

  // Serialization
  contentToParts,
  partsToText,
};
