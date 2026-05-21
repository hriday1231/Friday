/**
 * fetch_page — fetches a URL and returns clean readable text.
 * No headless browser needed: uses Node's built-in https/http.
 *
 * Hardening:
 *  - Only http(s) is allowed (no file://, javascript:, etc.).
 *  - The destination host must be a public IP — loopback (127.0.0.0/8, ::1),
 *    link-local (169.254.0.0/16, fe80::/10), private RFC1918 ranges, and
 *    cloud metadata hostnames are refused. This blocks LLM-driven SSRF
 *    against the user's local Ollama, internal admin panels, etc.
 *  - Re-validates after every redirect so a server can't 30x us into a
 *    private address.
 *  - Caps content at 500KB raw / 10K chars; 15s overall timeout; respects
 *    abort signals from the agent runtime.
 *  - Decodes gzip/deflate/br responses; skips non-text content types.
 *  - Wraps the page body in <untrusted_data> delimiters so the LLM treats
 *    its content as data, not instructions.
 */

const https = require('https');
const http  = require('http');
const dns   = require('dns').promises;
const zlib  = require('zlib');
const net   = require('net');
const { URL } = require('url');

const declaration = {
  name: 'fetch_page',
  description: 'Fetch the content of any public URL and return its readable text. Use this to read articles, documentation, Wikipedia pages, news stories, or any web page the user asks about.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Full URL to fetch (must start with http:// or https://).'
      }
    },
    required: ['url']
  }
};

const MAX_CHARS         = 10_000;
const MAX_RAW_BYTES     = 500_000;
const TOTAL_DEADLINE_MS = 12_000;   // absolute cap on wall-clock time for the entire fetch
const SOCKET_IDLE_MS    = 8_000;    // disconnect if no bytes arrive for this long
const MAX_REDIRECTS     = 5;

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
]);

function _isBlockedIp(ip) {
  if (!ip) return true;
  const fam = net.isIP(ip);
  if (fam === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0)   return true;                  // 0.0.0.0/8
    if (a === 10)  return true;                  // 10/8
    if (a === 127) return true;                  // 127/8 loopback
    if (a === 169 && b === 254) return true;     // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true;     // 192.168/16
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true;                   // multicast / reserved
    return false;
  }
  if (fam === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80')) return true;   // link-local
    if (lower.startsWith('fc')   || lower.startsWith('fd'))   return true; // ULA
    if (lower.startsWith('::ffff:')) {
      // IPv4-mapped — re-check the embedded v4 address
      const v4 = lower.slice(7);
      return _isBlockedIp(v4);
    }
    return false;
  }
  return true; // unknown address family
}

async function _assertSafeUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); }
  catch { throw new Error(`Invalid URL: ${rawUrl}`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Refusing protocol "${parsed.protocol}" — only http(s) is allowed.`);
  }
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error(`Refusing internal hostname: ${host}`);
  }
  // If it's already a literal IP, check directly.
  if (net.isIP(host)) {
    if (_isBlockedIp(host)) throw new Error(`Refusing private/loopback IP: ${host}`);
    return parsed;
  }
  // Else resolve and reject if any answer is in a private range.
  try {
    const addrs = await dns.lookup(host, { all: true });
    for (const a of addrs) {
      if (_isBlockedIp(a.address)) throw new Error(`Hostname ${host} resolves to private/loopback ${a.address}`);
    }
  } catch (err) {
    // DNS errors propagate as-is so the caller sees a clear message.
    if (err && err.message && err.message.startsWith('Refusing')) throw err;
    if (err && err.message && err.message.startsWith('Hostname'))  throw err;
    throw new Error(`DNS lookup failed for ${host}: ${err?.message || err}`);
  }
  return parsed;
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&nbsp;/g,  ' ')
    .replace(/&amp;/g,   '&')
    .replace(/&lt;/g,    '<')
    .replace(/&gt;/g,    '>')
    .replace(/&quot;/g,  '"')
    .replace(/&#39;/g,   "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

function extractTitle(html) {
  return (html.match(/<title[^>]*>([^<]{1,200})<\/title>/i) || [])[1]?.trim() || '';
}

function toReadableText(html) {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi,   '')
      .replace(/<nav[\s\S]*?<\/nav>/gi,        '')
      .replace(/<header[\s\S]*?<\/header>/gi,  '')
      .replace(/<footer[\s\S]*?<\/footer>/gi,  '')
      .replace(/<aside[\s\S]*?<\/aside>/gi,    '')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g,    '\n\n')
    .trim();
}

function _isTextContentType(ct) {
  if (!ct) return true; // be permissive when servers omit it
  const lower = String(ct).toLowerCase();
  return lower.startsWith('text/')
    || lower.includes('xhtml')
    || lower.includes('html')
    || lower.includes('json')
    || lower.includes('xml');
}

function fetchRaw(url, redirectsLeft = MAX_REDIRECTS, signal = null) {
  return new Promise((resolve, reject) => {
    // ── Lifecycle plumbing ──────────────────────────────────────────────────
    // Everything below routes through done() so we resolve / reject exactly
    // once and always tear down the timer + abort listener. The previous
    // version attached the abort listener inside the response callback, which
    // meant a server that hung BEFORE sending any headers couldn't be cancelled
    // — the Stop button effectively did nothing for the first ~15 s.
    let settled = false;
    let req = null;
    const overallTimer = setTimeout(() => {
      done(new Error(`Request timed out after ${TOTAL_DEADLINE_MS}ms: ${url}`));
    }, TOTAL_DEADLINE_MS);
    const onAbort = () => {
      done(Object.assign(new Error('Aborted by user'), { name: 'AbortError' }));
    };
    if (signal) signal.addEventListener?.('abort', onAbort, { once: true });

    function done(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(overallTimer);
      if (signal) signal.removeEventListener?.('abort', onAbort);
      try { req?.destroy(); } catch {}
      if (err) reject(err); else resolve(value);
    }

    // Honor abort + redirect-budget BEFORE we even open a socket.
    if (redirectsLeft <= 0) return done(new Error('Too many redirects'));
    if (signal?.aborted) return done(Object.assign(new Error('Aborted'), { name: 'AbortError' }));

    // ── DNS + SSRF check, then request ──────────────────────────────────────
    (async () => {
      let targetUrl;
      try { targetUrl = await _assertSafeUrl(url); }
      catch (e) { return done(e); }
      if (settled) return; // aborted while DNS was in flight

      const client = targetUrl.protocol === 'https:' ? https : http;
      req = client.get(url, {
        headers: {
          'User-Agent':       'Mozilla/5.0 (compatible; Friday/1.0; +https://friday.local)',
          'Accept':           'text/html,application/xhtml+xml,text/plain',
          'Accept-Encoding':  'gzip, deflate, br',
        }
      }, (res) => {
        if (settled) { res.resume(); return; }

        // Follow redirects (each new hop revalidates the host via _assertSafeUrl).
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          // Hand off to a fresh promise — but mark this one settled first so
          // our timer + abort listener get cleaned up. The fresh fetchRaw call
          // re-attaches its own abort listener under the same signal.
          settled = true;
          clearTimeout(overallTimer);
          if (signal) signal.removeEventListener?.('abort', onAbort);
          const next = new URL(res.headers.location, url).href;
          return fetchRaw(next, redirectsLeft - 1, signal).then(resolve).catch(reject);
        }
        if (res.statusCode >= 400) {
          res.resume();
          return done(new Error(`HTTP ${res.statusCode}: ${url}`));
        }

        const ct = res.headers['content-type'];
        if (!_isTextContentType(ct)) {
          res.resume();
          return done(null, { html: `(non-text content: ${ct || 'unknown'})`, status: res.statusCode });
        }

        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        let stream = res;
        if      (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br')      stream = res.pipe(zlib.createBrotliDecompress());

        const chunks = [];
        let total = 0;
        stream.on('data', (chunk) => {
          total += chunk.length;
          chunks.push(chunk);
          if (total >= MAX_RAW_BYTES) req.destroy(); // got enough → tear down
        });
        stream.on('end',   () => done(null, { html: Buffer.concat(chunks).toString('utf8'), status: res.statusCode }));
        stream.on('error', (err) => done(err));
      });

      req.on('error', (err) => done(err));
      // Socket-level idle timeout (server went quiet mid-response).
      // Belt-and-suspenders alongside the absolute deadline above.
      req.setTimeout(SOCKET_IDLE_MS, () => {
        done(new Error(`No data for ${SOCKET_IDLE_MS}ms: ${url}`));
      });
    })().catch(done);
  });
}

async function handler(args, _onStream, signal) {
  let { url } = args || {};
  if (!url) return 'No URL provided.';
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  let html, status;
  try {
    ({ html, status } = await fetchRaw(url, MAX_REDIRECTS, signal));
  } catch (err) {
    // Distinguish user-cancel from real failures so the LLM doesn't apologize
    // for a fetch we intentionally killed.
    if (err?.name === 'AbortError' || signal?.aborted) {
      return `[fetch_page cancelled by user: ${url}]`;
    }
    return `Failed to fetch ${url}: ${err.message}`;
  }

  const title = extractTitle(html);
  const text  = toReadableText(html);
  const trunc = text.length > MAX_CHARS
    ? text.slice(0, MAX_CHARS) + `\n\n… [${text.length - MAX_CHARS} more chars not shown]`
    : text;

  // Wrap the page text in untrusted_data so a poisoned page can't masquerade
  // as instructions to the assistant.
  const safeTitle = title ? title.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '').slice(0, 200) : '';
  return [
    `URL: ${url}`,
    safeTitle ? `Title: ${safeTitle}` : null,
    `Status: ${status}`,
    '',
    `<untrusted_data source="fetch_page" url="${url}">`,
    trunc || '(no readable content extracted)',
    '</untrusted_data>',
  ].filter(l => l !== null).join('\n');
}

module.exports = { declaration, handler };
