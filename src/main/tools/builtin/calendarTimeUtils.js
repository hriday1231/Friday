/**
 * Convert an ISO date-time string that has no timezone to UTC, interpreting it as local time in the given IANA timezone.
 * If the string already has a trailing Z or a timezone offset (e.g. +00:00, -08:00), return it as-is.
 * Used so that when the LLM sends "2:00 PM" as 14:00 without converting to UTC, we fix it.
 */

function hasTimezone(isoString) {
  const s = String(isoString).trim();
  return s.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(s);
}

/**
 * Get the offset in ms for the given timezone at the given UTC date.
 * Offset is such that: local = utc + offset (e.g. LA = -8h). So utc = localFakeUtc - offset.
 */
function getTimezoneOffsetMs(timeZone, utcDate) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(utcDate);
  const get = (type) => {
    const p = parts.find((x) => x.type === type);
    return p ? parseInt(p.value, 10) : 0;
  };
  const localYear = get('year');
  const localMonth = get('month') - 1;
  const localDay = get('day');
  const localHour = get('hour');
  const localMinute = get('minute');
  const localSecond = get('second');
  const localAsUtc = Date.UTC(localYear, localMonth, localDay, localHour, localMinute, localSecond);
  return localAsUtc - utcDate.getTime();
}

/**
 * Parse ISO-like string to UTC Date, interpreting as local time in timeZone if no TZ in string.
 * @param {string} isoString - e.g. "2026-02-14T14:00:00" or "2026-02-14T22:00:00.000Z"
 * @param {string} timeZone - IANA timezone (e.g. America/Los_Angeles)
 * @returns {string} ISO 8601 UTC string (e.g. "2026-02-14T22:00:00.000Z")
 */
function toUTC(isoString, timeZone) {
  const s = String(isoString).trim();
  if (hasTimezone(s)) return s;

  const dateTimeMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})?(?:\.(\d+))?/);
  if (!dateTimeMatch) return s;

  const [, y, m, d, h, min, sec, ms] = dateTimeMatch;
  const year = parseInt(y, 10);
  const month = parseInt(m, 10) - 1;
  const day = parseInt(d, 10);
  const hour = parseInt(h, 10);
  const minute = parseInt(min, 10);
  const second = parseInt(sec || '0', 10);
  const millis = ms ? parseInt(ms.slice(0, 3).padEnd(3, '0'), 10) : 0;

  const localFakeUtc = Date.UTC(year, month, day, hour, minute, second, millis);
  const refDate = new Date(localFakeUtc);
  const offsetMs = getTimezoneOffsetMs(timeZone, refDate);
  const utcTime = localFakeUtc - offsetMs;
  return new Date(utcTime).toISOString();
}

module.exports = { toUTC, hasTimezone };
