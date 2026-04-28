const GoogleCalendarService = require('../../services/GoogleCalendarService');
const { toUTC } = require('./calendarTimeUtils');
require('dotenv').config();

const TIMEZONE = process.env.CALENDAR_TIMEZONE || 'America/Los_Angeles';

const declaration = {
  name: 'get_calendar_summary',
  description: 'Get a summary of calendar events for a given period. Use when the user asks "what\'s on my calendar", "what do I have today", "show my week", "calendar this month", "any events tomorrow", etc.',
  parameters: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        description: 'One of: "daily", "weekly", "monthly"'
      },
      relativeDay: {
        type: 'string',
        description: 'Use this when the user asks about a specific day: "today", "tomorrow", or "yesterday". Prefer this over date for natural phrases like "events tomorrow".'
      },
      date: {
        type: 'string',
        description: 'Reference date in ISO 8601 format (e.g. 2025-02-05). Ignored if relativeDay is set.'
      }
    },
    required: ['mode']
  }
};

/**
 * Get the current date as YYYY-MM-DD in the user's calendar timezone.
 */
function todayInTZ(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const get = (t) => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Shift a YYYY-MM-DD string by +/- days.
 */
function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/**
 * Get the Sunday that starts the week containing dateStr (Sun–Sat convention).
 */
function weekStartOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0=Sun, 1=Mon … 6=Sat
  return shiftDate(dateStr, -dow); // back to Sunday
}

/**
 * Resolve the reference date (as YYYY-MM-DD in TIMEZONE) from relativeDay or dateStr.
 */
function resolveReferenceDate(relativeDay, dateStr) {
  const today = todayInTZ(TIMEZONE);
  if (relativeDay) {
    const r = String(relativeDay).toLowerCase();
    if (r === 'tomorrow') return shiftDate(today, 1);
    if (r === 'yesterday') return shiftDate(today, -1);
    return today; // "today" or anything else
  }
  // If an explicit date was passed, use it; fall back to today
  return dateStr ? dateStr.slice(0, 10) : today;
}

/**
 * Compute UTC start and end for the query window.
 * All midnight/end-of-day boundaries are computed in CALENDAR_TIMEZONE.
 */
function getRangeStartEnd(mode, refDateStr) {
  const startOfDay = (d) => toUTC(`${d}T00:00:00`, TIMEZONE);
  const endOfDay   = (d) => toUTC(`${d}T23:59:59`, TIMEZONE);

  if (mode === 'daily') {
    return [startOfDay(refDateStr), endOfDay(refDateStr)];
  }

  if (mode === 'weekly') {
    const sunday = weekStartOf(refDateStr);
    const saturday = shiftDate(sunday, 6);
    return [startOfDay(sunday), endOfDay(saturday)];
  }

  if (mode === 'monthly') {
    const [y, m] = refDateStr.split('-').map(Number);
    const firstDay = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
    // Last day: first day of next month minus 1
    const nextMonth = new Date(Date.UTC(y, m, 1)); // m is already 0-indexed +1
    const lastDay = new Date(nextMonth - 1).toISOString().slice(0, 10);
    return [startOfDay(firstDay), endOfDay(lastDay)];
  }

  // Fallback: daily
  return [startOfDay(refDateStr), endOfDay(refDateStr)];
}

function formatEvent(e, mode) {
  const start = new Date(e.start);
  const end = new Date(e.end);

  const dateOpts     = { month: 'short', day: 'numeric', timeZone: TIMEZONE };
  const timeOpts     = { hour: 'numeric', minute: '2-digit', timeZone: TIMEZONE, hour12: true };
  const dateTimeOpts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TIMEZONE, hour12: true };

  let dateTimeStr;
  if (e.allDay) {
    dateTimeStr = start.toLocaleDateString('en-US', {
      ...dateOpts,
      weekday: mode === 'daily' ? undefined : 'short'
    }) + ' (all day)';
  } else if (mode === 'daily') {
    dateTimeStr = `${start.toLocaleTimeString('en-US', timeOpts)} – ${end.toLocaleTimeString('en-US', timeOpts)}`;
  } else {
    const startStr = start.toLocaleString('en-US', { ...dateTimeOpts, weekday: 'short' });
    const endStr   = end.toLocaleTimeString('en-US', timeOpts);
    dateTimeStr = `${startStr} – ${endStr}`;
  }

  let out = `- ${e.title} (${dateTimeStr}) [id: ${e.id}]`;
  if (e.description) out += ` — ${e.description}`;
  return out;
}

function getPeriodLabel(mode, refDateStr, relativeDay) {
  if (mode === 'weekly')  return 'this week';
  if (mode === 'monthly') return 'this month';
  if (relativeDay) {
    const r = String(relativeDay).toLowerCase();
    if (r === 'tomorrow')  return 'tomorrow';
    if (r === 'yesterday') return 'yesterday';
    return 'today';
  }
  const today = todayInTZ(TIMEZONE);
  if (refDateStr === today)                 return 'today';
  if (refDateStr === shiftDate(today, 1))   return 'tomorrow';
  if (refDateStr === shiftDate(today, -1))  return 'yesterday';
  return refDateStr;
}

async function handler(args) {
  const { mode, date, relativeDay } = args || {};
  const m = (mode || 'daily').toLowerCase();
  if (!['daily', 'weekly', 'monthly'].includes(m)) {
    throw new Error('mode must be daily, weekly, or monthly');
  }

  const refDateStr = resolveReferenceDate(relativeDay, date);
  const [start, end] = getRangeStartEnd(m, refDateStr);
  const events = await GoogleCalendarService.getEventsInRange(start, end);

  const period = getPeriodLabel(m, refDateStr, relativeDay);

  if (events.length === 0) {
    return `No events scheduled for ${period}.`;
  }

  const formatted = events.map(e => formatEvent(e, m)).join('\n');
  return `Events for ${period}:\n${formatted}`;
}

module.exports = { declaration, handler };
