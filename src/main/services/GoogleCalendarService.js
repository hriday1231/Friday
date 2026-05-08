/**
 * Google Calendar API service - same logical API as the old CalendarStore.
 * Uses OAuth2 (credentials.json + stored tokens). Tokens persist in Electron userData.
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const REDIRECT_URI = 'http://localhost:3131/callback';
const OAUTH_PORT = 3131;
const CALENDAR_ID = 'primary';

function getTokenDir() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return app.getPath('userData');
    }
  } catch (_) {}
  return process.cwd();
}

function getCredentialsPath() {
  return process.env.GOOGLE_CREDENTIALS_PATH || path.join(process.cwd(), 'credentials.json');
}

function getTokenPath() {
  return path.join(getTokenDir(), 'google-calendar-token.json');
}

function loadCredentials() {
  const p = getCredentialsPath();
  if (!fs.existsSync(p)) {
    throw new Error(
      'Google Calendar: credentials.json not found. Place your OAuth client JSON from GCP in the project root, or set GOOGLE_CREDENTIALS_PATH.'
    );
  }
  const content = fs.readFileSync(p, 'utf8');
  const data = JSON.parse(content);
  const client = data.installed || data.web;
  if (!client) throw new Error('Google Calendar: credentials.json must contain "installed" or "web" client config.');
  return {
    clientId: client.client_id,
    clientSecret: client.client_secret
  };
}

// Optional safeStorage encryption for the token file. Falls through to
// plaintext when safeStorage isn't ready (older Electron, headless mode).
function _safeStorage() {
  try {
    const { safeStorage, app } = require('electron');
    if (!safeStorage || !app?.isReady?.()) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage;
  } catch { return null; }
}

const TOKEN_ENC_PREFIX = 'enc-v1:'; // first line of encrypted token file
const TOKEN_FILE_MODE  = 0o600;

function loadTokens() {
  const p = getTokenPath();
  if (!fs.existsSync(p)) return null;
  try {
    const content = fs.readFileSync(p, 'utf8');
    if (content.startsWith(TOKEN_ENC_PREFIX)) {
      const ss = _safeStorage();
      if (!ss) return null; // ciphertext present but key unavailable — fail closed
      const buf = Buffer.from(content.slice(TOKEN_ENC_PREFIX.length).trim(), 'base64');
      const json = ss.decryptString(buf);
      return JSON.parse(json);
    }
    return JSON.parse(content);
  } catch (_) {
    return null;
  }
}

function saveTokens(tokens) {
  const p = getTokenPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const ss = _safeStorage();
  let payload;
  if (ss) {
    try {
      const buf = ss.encryptString(JSON.stringify(tokens));
      payload = TOKEN_ENC_PREFIX + buf.toString('base64');
    } catch {
      payload = JSON.stringify(tokens, null, 2);
    }
  } else {
    payload = JSON.stringify(tokens, null, 2);
  }
  fs.writeFileSync(p, payload, { encoding: 'utf8', mode: TOKEN_FILE_MODE });
  // Tighten the mode in case the file already existed with looser perms.
  try { fs.chmodSync(p, TOKEN_FILE_MODE); } catch {}
}

function clearTokens() {
  const p = getTokenPath();
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
}

/**
 * Run OAuth2 flow: open browser, start local server to catch redirect, exchange code for tokens.
 * Resolves with an authorized OAuth2 client.
 */
function runOAuthFlow(credentials) {
  return new Promise((resolve, reject) => {
    const oauth2Client = new google.auth.OAuth2(
      credentials.clientId,
      credentials.clientSecret,
      REDIRECT_URI
    );
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent'
    });

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '', `http://localhost:${OAUTH_PORT}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(400);
        res.end('Missing code. Please try signing in again.');
        return;
      }
      try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        saveTokens(tokens);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<html><body><p>Success! You can close this window and return to Friday.</p></body></html>'
        );
        server.close(() => resolve(oauth2Client));
      } catch (err) {
        res.writeHead(500);
        res.end('Auth error: ' + (err.message || 'Unknown'));
        server.close(() => reject(err));
      }
    });

    server.listen(OAUTH_PORT, 'localhost', () => {
      try {
        const { shell } = require('electron');
        if (shell && shell.openExternal) {
          shell.openExternal(authUrl);
        } else {
          const { exec } = require('child_process');
          const cmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
          exec(`${cmd} "${authUrl}"`);
        }
      } catch (_) {
        reject(new Error('Could not open browser. Open this URL to sign in: ' + authUrl));
        server.close();
      }
    });

    server.on('error', (err) => {
      reject(new Error('OAuth server error: ' + err.message + '. Is port ' + OAUTH_PORT + ' in use?'));
    });
  });
}

// Single in-flight OAuth promise so concurrent tool calls don't both bind to
// port 3131 (EADDRINUSE) or each pop their own browser tab.
let _authPromise = null;

/**
 * Returns an authorized OAuth2 client (loads tokens, refreshes if needed, or runs OAuth flow).
 *
 * On refresh failure we clear the cached token and re-run the OAuth flow so
 * users whose refresh token was revoked aren't stuck in a permanent error
 * state until manually deleting the token file.
 */
async function getAuthClient() {
  if (_authPromise) return _authPromise;
  _authPromise = _getAuthClientImpl().finally(() => { _authPromise = null; });
  return _authPromise;
}

async function _getAuthClientImpl() {
  const credentials = loadCredentials();
  let tokens = loadTokens();
  const oauth2Client = new google.auth.OAuth2(
    credentials.clientId,
    credentials.clientSecret,
    REDIRECT_URI
  );

  // Persist auto-refreshed access tokens so we don't re-do the round trip
  // on every process restart.
  oauth2Client.on('tokens', (newTokens) => {
    try {
      const merged = { ...(loadTokens() || {}), ...newTokens };
      if (merged.refresh_token || merged.access_token) saveTokens(merged);
    } catch {}
  });

  if (tokens) {
    oauth2Client.setCredentials(tokens);
    try {
      await oauth2Client.getAccessToken();
      return oauth2Client;
    } catch (_) {
      try {
        oauth2Client.setCredentials({ refresh_token: tokens.refresh_token });
        const { credentials: newCreds } = await oauth2Client.refreshAccessToken();
        const newTokens = { ...tokens, access_token: newCreds.access_token, expiry_date: newCreds.expiry_date };
        saveTokens(newTokens);
        return oauth2Client;
      } catch (refreshErr) {
        // The refresh token is dead (revoked, expired, scope changed). Wipe
        // the stale token and retry the full OAuth flow so the user can
        // recover without manually deleting the token file.
        console.warn('[GoogleCalendar] Refresh failed, restarting OAuth:', refreshErr.message);
        clearTokens();
        return runOAuthFlow(credentials);
      }
    }
  }

  return runOAuthFlow(credentials);
}

function googleEventToOur(item) {
  const allDay = !!item.start.date;
  const start = item.start.dateTime || (item.start.date ? item.start.date + 'T00:00:00.000Z' : null);
  const end = item.end.dateTime || (item.end.date ? item.end.date + 'T23:59:59.999Z' : null);
  return {
    id: item.id,
    title: item.summary || 'Untitled',
    start: start || '',
    end: end || '',
    description: item.description || '',
    allDay
  };
}

function ourEventToGoogle(event) {
  const allDay = event.allDay ?? false;
  const body = {
    summary: event.title || 'Untitled',
    description: event.description || ''
  };
  if (allDay) {
    const startDate = event.start.slice(0, 10);
    let endDate = event.end.slice(0, 10);
    body.start = { date: startDate };
    body.end = { date: endDate };
  } else {
    body.start = { dateTime: event.start, timeZone: 'UTC' };
    body.end = { dateTime: event.end, timeZone: 'UTC' };
  }
  return body;
}

function _decodeJwtEmail(idToken) {
  try {
    const parts = String(idToken).split('.');
    if (parts.length < 2) return null;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const data = JSON.parse(json);
    return typeof data.email === 'string' ? data.email : null;
  } catch { return null; }
}

class GoogleCalendarService {
  async _getCalendar() {
    const auth = await getAuthClient();
    return google.calendar({ version: 'v3', auth });
  }

  /** True if a token file exists (encrypted or plaintext). */
  hasToken() {
    return fs.existsSync(getTokenPath());
  }

  /**
   * Decode the email claim from the stored id_token, if present. Reads through
   * loadTokens() so it transparently handles both encrypted and legacy
   * plaintext token files.
   */
  getAccountEmail() {
    const tokens = loadTokens();
    return tokens?.id_token ? _decodeJwtEmail(tokens.id_token) : null;
  }

  /** Path of the token file (so callers can show users where it lives). */
  getTokenPath() { return getTokenPath(); }

  /** Wipe the cached OAuth tokens — used by the "disconnect" UI action. */
  logout() { clearTokens(); }

  /**
   * Get events in range (inclusive). Same contract as CalendarStore.getEventsInRange.
   * @param {string} start - ISO8601
   * @param {string} end - ISO8601
   * @returns {Promise<Array<{ id, title, start, end, description, allDay }>>}
   */
  async getEventsInRange(start, end) {
    const calendar = await this._getCalendar();
    const res = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: start,
      timeMax: end,
      singleEvents: true,
      orderBy: 'startTime'
    });
    const items = res.data.items || [];
    return items.map(googleEventToOur).sort((a, b) => new Date(a.start) - new Date(b.start));
  }

  /**
   * Add event. Same contract as CalendarStore.addEvent.
   * @returns {Promise<{ id, title, start, end, description, allDay }>}
   */
  async addEvent(event) {
    const calendar = await this._getCalendar();
    const body = ourEventToGoogle(event);
    const res = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: body
    });
    return googleEventToOur(res.data);
  }

  /**
   * Update event by id. Same contract as CalendarStore.updateEvent.
   * @returns {Promise<{ id, title, start, end, description, allDay } | null>}
   */
  async updateEvent(id, updates) {
    const calendar = await this._getCalendar();
    const existing = await calendar.events.get({ calendarId: CALENDAR_ID, eventId: id }).catch(() => null);
    if (!existing || !existing.data) return null;
    const current = existing.data;
    const body = {};
    if (updates.title !== undefined) body.summary = updates.title;
    if (updates.description !== undefined) body.description = updates.description;
    if (updates.start !== undefined) {
      body.start = (updates.allDay ?? !!current.start?.date)
        ? { date: updates.start.slice(0, 10) }
        : { dateTime: updates.start, timeZone: 'UTC' };
    }
    if (updates.end !== undefined) {
      body.end = (updates.allDay ?? !!current.start?.date)
        ? { date: updates.end.slice(0, 10) }
        : { dateTime: updates.end, timeZone: 'UTC' };
    }
    if (Object.keys(body).length === 0) return googleEventToOur(current);
    const res = await calendar.events.patch({
      calendarId: CALENDAR_ID,
      eventId: id,
      requestBody: body
    });
    return googleEventToOur(res.data);
  }

  /**
   * Delete event by id. Same contract as CalendarStore.deleteEvent.
   * @returns {Promise<boolean>}
   */
  async deleteEvent(id) {
    const calendar = await this._getCalendar();
    try {
      await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: id });
      return true;
    } catch (err) {
      if (err.code === 404) return false;
      throw err;
    }
  }

  /**
   * Get single event by id. Same contract as CalendarStore.getEventById.
   * @returns {Promise<{ id, title, start, end, description, allDay } | null>}
   */
  async getEventById(id) {
    const calendar = await this._getCalendar();
    const res = await calendar.events.get({ calendarId: CALENDAR_ID, eventId: id }).catch(() => null);
    if (!res || !res.data) return null;
    return googleEventToOur(res.data);
  }
}

module.exports = new GoogleCalendarService();
