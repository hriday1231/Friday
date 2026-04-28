const GoogleCalendarService = require('../../services/GoogleCalendarService');
const { toUTC } = require('./calendarTimeUtils');
require('dotenv').config();

const TIMEZONE = process.env.CALENDAR_TIMEZONE || 'America/Los_Angeles';

const declaration = {
  name: 'edit_calendar_event',
  description: 'Edit an existing calendar event. Use when the user wants to change an event (e.g. "move my meeting to 3pm", "change the dentist appointment title"). You need the event id—use get_calendar_summary first to find it if the user refers to an event by name or time.',
  parameters: {
    type: 'object',
    properties: {
      eventId: {
        type: 'string',
        description: 'The event id (from get_calendar_summary or a previous add)'
      },
      title: {
        type: 'string',
        description: 'New title (optional)'
      },
      start: {
        type: 'string',
        description: 'New start time in ISO 8601 (e.g. 2026-02-14T14:00:00 for 2 PM local; times without Z are interpreted as America/Los_Angeles)'
      },
      end: {
        type: 'string',
        description: 'New end time in ISO 8601 (same timezone rule as start)'
      },
      description: {
        type: 'string',
        description: 'New description (optional)'
      }
    },
    required: ['eventId']
  }
};

async function handler(args) {
  const { eventId, title, start, end, description } = args || {};
  if (!eventId) {
    throw new Error('eventId is required');
  }

  const updates = {};
  if (title !== undefined) updates.title = String(title).trim();
  if (start !== undefined) updates.start = toUTC(String(start), TIMEZONE);
  if (end !== undefined) updates.end = toUTC(String(end), TIMEZONE);
  if (description !== undefined) updates.description = String(description);

  const updated = await GoogleCalendarService.updateEvent(eventId, updates);
  if (!updated) {
    throw new Error(`Event with id "${eventId}" not found.`);
  }

  return `Updated event "${updated.title}".`;
}

module.exports = { declaration, handler };
