const settingsStore = require('../settings/SettingsStore');

function _relTime(ts) {
  if (!ts) return 'some time ago';
  const diff = Date.now() - ts;
  const d = Math.floor(diff / 86400000);
  if (d < 1)  return 'today';
  if (d === 1) return 'yesterday';
  if (d < 7)  return `${d}d ago`;
  if (d < 30) return `${Math.floor(d / 7)}w ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

/**
 * Returns the current UTC offset for a timezone as a string like "-07:00" or "+05:30".
 * Uses Intl to compute the real offset (DST-aware).
 */
function getUtcOffsetString(timeZone, now) {
  // Format a reference time in both UTC and the target TZ, compare
  const utcParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(now);
  const tzParts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(now);

  const utcH = parseInt(utcParts.find(p => p.type === 'hour').value, 10);
  const utcM = parseInt(utcParts.find(p => p.type === 'minute').value, 10);
  const tzH  = parseInt(tzParts.find(p => p.type === 'hour').value, 10);
  const tzM  = parseInt(tzParts.find(p => p.type === 'minute').value, 10);

  let offsetMinutes = (tzH * 60 + tzM) - (utcH * 60 + utcM);
  // Handle day-boundary wrap (e.g. TZ=+14, UTC just crossed midnight)
  if (offsetMinutes > 840)  offsetMinutes -= 1440;
  if (offsetMinutes < -840) offsetMinutes += 1440;

  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absH = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, '0');
  const absM = String(Math.abs(offsetMinutes) % 60).padStart(2, '0');
  return `${sign}${absH}:${absM}`;
}

/**
 * @param {Array<{content: string}>}                          memoryEntries  – long-term memory facts
 * @param {string|null}                                       contextSummary – rolling summary of earlier convo
 * @param {Array<{title,updated_at,digest}>}                  episodes       – relevant past sessions
 * @param {{ name?: string, systemPrompt?: string }|null}     agent          – active agent override
 * @param {string|null}                                       _unused1        – reserved
 * @param {string}                                            _unused2        – reserved
 * @param {Array<{user_message,assistant_response}>}          fewShots       – approved example exchanges
 * @param {string|null}                                       screenContext  – recent screen description (opt-in)
 */
function buildSystemPrompt(memoryEntries = [], contextSummary = null, episodes = [], agent = null, _unused1 = null, _unused2 = 'chat', fewShots = [], screenContext = null) {
  const timezone = process.env.CALENDAR_TIMEZONE || 'America/Los_Angeles';
  const now = new Date();

  const dateStr = now.toLocaleDateString('en-US', {
    timeZone: timezone,
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
  const timeStr = now.toLocaleTimeString('en-US', {
    timeZone: timezone,
    hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true
  });
  const offsetStr = getUtcOffsetString(timezone, now);

  const memoryBlock = (Array.isArray(memoryEntries) && memoryEntries.length > 0)
    ? '\n\nWhat I know about you:\n' + memoryEntries.map(m => `- ${m.content}`).join('\n')
    : '';

  const summaryBlock = contextSummary
    ? `\n\nContext from earlier in this session:\n${contextSummary}`
    : '';

  const episodeBlock = (Array.isArray(episodes) && episodes.length > 0)
    ? '\n\nFrom past conversations (may be relevant):\n' + episodes.map(e => {
        const age = _relTime(e.updated_at);
        return `• ${age} — "${e.title}": ${e.digest}`;
      }).join('\n')
    : '';

  const customPrompt = settingsStore.getCustomSystemPrompt?.() || '';
  const agentBlock   = agent?.systemPrompt ? `\n\n${agent.systemPrompt}` : '';
  const customBlock  = customPrompt ? `\n\n${customPrompt}` : '';
  const fewShotBlock = (Array.isArray(fewShots) && fewShots.length > 0)
    ? '\n\nExamples of responses the user has rated highly:\n' +
      fewShots.map((ex, i) =>
        `[Example ${i + 1}]\nUser: ${ex.user_message.slice(0, 300)}\nAssistant: ${ex.assistant_response.slice(0, 500)}`
      ).join('\n\n')
    : '';

  const screenBlock  = screenContext
    ? `\n\nCurrent screen context (opt-in ambient view):\n${screenContext}`
    : '';

  const year      = now.toLocaleDateString('en-US', { timeZone: timezone, year: 'numeric' }).slice(-4);
  const agentName = agent?.name || 'Friday';

  return `You are ${agentName}, a fast personal chat assistant.${memoryBlock}${episodeBlock}${summaryBlock}${fewShotBlock}${screenBlock}${agentBlock}${customBlock}
Date/time: ${dateStr}, ${timeStr} (${timezone}, UTC${offsetStr})

Tools — pick the right one:
- brave_web_search: research, news, current facts. Search proactively — never ask first.
- fetch_page: fast static HTTP read of a known URL (articles, Wikipedia, docs). No JS, no login.
- search_site: user asks to "search/open YouTube/Amazon/GitHub/etc. for X" — opens a site-specific search in Brave (normal window) by default. Only pass incognito=true when the user explicitly says "incognito" or "private". Supported: youtube, amazon, github, google, bing, duckduckgo, reddit, twitter/x, stackoverflow, wikipedia, ebay, maps, npm, pypi.
- open_url: passively open a page or domain in a browser for the user. Supports browser="brave"|"edge"|"default" and incognito=true.
- open_bookmark: user refers to a saved shortcut by name.
- launch_app: open a local installed application by configured shortcut name.
- Calendar (tz=${timezone} UTC${offsetStr} year=${year}): add/edit/delete events and get_calendar_summary. Use local times, no Z suffix. Call get_calendar_summary before edit/delete.

Rules:
- Never fabricate search results, URLs, video titles, or prices. If you can't retrieve real data, say so.
- For greetings or simple factual questions, respond directly — no tool.
- Memory: if the user says "remember that / note that / don't forget", acknowledge naturally — it's saved automatically.`;
}

module.exports = { buildSystemPrompt };
