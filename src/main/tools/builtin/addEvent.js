const GoogleCalendarService = require('../../services/GoogleCalendarService');
const { toUTC } = require('./calendarTimeUtils');
require('dotenv').config();

const TIMEZONE = process.env.CALENDAR_TIMEZONE || 'America/Los_Angeles';

const declaration = {
  name: 'add_calendar_event',
  description: 'Add a new event to the user\'s calendar. Use when the user wants to schedule something (e.g. "add meeting tomorrow at 2pm", "schedule dentist appt next Monday").',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Event title'
      },
      start: {
        type: 'string',
        description: 'Start time in ISO 8601 (e.g. 2026-02-14T14:00:00 for 2:00 PM local, or with Z for UTC). User is in America/Los_Angeles; times without Z are interpreted as local.'
      },
      end: {
        type: 'string',
        description: 'End time in ISO 8601 (e.g. 2026-02-14T17:00:00 for 5:00 PM local). Same timezone as start.'
      },
      description: {
        type: 'string',
        description: 'Optional event description'
      },
      allDay: {
        type: 'boolean',
        description: 'Whether the event is all-day (default false)'
      }
    },
    required: ['title', 'start', 'end']
  }
};

async function handler(args) {
  const { title, start, end, description, allDay } = args || {};
  if (!title || !start || !end) {
    throw new Error('title, start, and end are required');
  }

  const startUTC = toUTC(String(start), TIMEZONE);
  const endUTC = toUTC(String(end), TIMEZONE);

  const event = await GoogleCalendarService.addEvent({
    title: String(title).trim(),
    start: startUTC,
    end: endUTC,
    description: description ? String(description) : '',
    allDay: Boolean(allDay)
  });

  const opts = { timeZone: TIMEZONE, dateStyle: 'short', timeStyle: 'short' };
  const startStr = new Date(event.start).toLocaleString(undefined, opts);
  const endStr = new Date(event.end).toLocaleString(undefined, opts);
  return `Added event "${event.title}" from ${startStr} to ${endStr}.`;
}

module.exports = { declaration, handler };
