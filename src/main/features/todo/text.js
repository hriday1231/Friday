/**
 * Pure text helpers for the to-do feature. No I/O, no state.
 *
 * clean() strips control characters and collapses whitespace; cleanMulti() does
 * the same but keeps newlines, for notes. Everything stored goes through one of
 * them - task titles are user-authored and end up in the DOM.
 */

'use strict';

// C0/C1 control characters except \t (\x09) and \n (\x0A), which we keep in notes.
const CTRL = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;

/** Single-line: strip control chars, collapse all whitespace, trim, cap. */
function clean(s, max = 200) {
  if (s == null) return '';
  return String(s).replace(CTRL, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Multi-line: same, but newlines survive (used for notes). */
function cleanMulti(s, max = 2000) {
  if (s == null) return '';
  return String(s)
    .replace(/\r\n?/g, '\n')
    .replace(CTRL, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

function normTag(s) {
  const t = clean(s, 40).toLowerCase().replace(/[^a-z0-9 _-]/g, '').trim().replace(/\s+/g, '-');
  return t.slice(0, 24);
}

/** Accepts a comma/semicolon separated string or an array. Deduped, max 8. */
function normTags(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[,;]/);
  const out = [];
  for (const r of raw) {
    const t = normTag(r);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 8) break;
  }
  return out;
}

const PRIORITIES = ['low', 'med', 'high'];
function normPriority(s) {
  const p = clean(s, 20).toLowerCase();
  if (!p) return 'med';
  if (p === 'medium' || p === 'normal' || p === 'mid') return 'med';
  if (p === 'urgent' || p === 'important' || p === 'critical' || p === 'asap') return 'high';
  if (p === 'minor' || p === 'someday' || p === 'whenever') return 'low';
  return PRIORITIES.includes(p) ? p : 'med';
}

// ─── Dates ───────────────────────────────────────────────────────────────────

/** All-day items are not overdue until the whole day has passed. */
function isOverdue(dueAt, allDay, status, now = Date.now()) {
  if (!dueAt || status === 'completed') return false;
  return allDay ? (dueAt + 86399999) < now : dueAt < now;
}

// normTag and PRIORITIES are implementation details of normTags/normPriority.
module.exports = { clean, cleanMulti, normTags, normPriority, isOverdue };
