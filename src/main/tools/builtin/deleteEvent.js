const GoogleCalendarService = require('../../services/GoogleCalendarService');

const declaration = {
  name: 'delete_calendar_event',
  description: 'Delete a calendar event. Use when the user wants to remove or cancel an event. You need the event id—use get_calendar_summary first to find it.',
  parameters: {
    type: 'object',
    properties: {
      eventId: {
        type: 'string',
        description: 'The event id to delete'
      }
    },
    required: ['eventId']
  }
};

async function handler(args) {
  const { eventId } = args || {};
  if (!eventId) {
    throw new Error('eventId is required');
  }

  const event = await GoogleCalendarService.getEventById(eventId);
  const deleted = await GoogleCalendarService.deleteEvent(eventId);
  if (!deleted) {
    throw new Error(`Event with id "${eventId}" not found.`);
  }

  return `Deleted event "${event?.title || 'event'}".`;
}

module.exports = { declaration, handler };
