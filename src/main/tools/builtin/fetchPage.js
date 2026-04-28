/**
 * fetch_page — fetches a URL and returns clean readable text.
 * No headless browser needed: uses Node's built-in https/http.
 * Handles redirects, strips scripts/styles/nav, truncates at 10k chars.
 */

const https  = require('https');
const http   = require('http');
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

const MAX_CHARS    = 10_000;
const MAX_RAW_BYTES= 500_000;
const TIMEOUT_MS   = 15_000;
const MAX_REDIRECTS= 5;

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

function fetchRaw(url, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));

    let targetUrl;
    try { targetUrl = new URL(url); }
    catch { return reject(new Error(`Invalid URL: ${url}`)); }

    const client = targetUrl.protocol === 'https:' ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Friday/1.0; +https://friday.local)',
        'Accept':     'text/html,application/xhtml+xml,text/plain'
      }
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return fetchRaw(next, redirectsLeft - 1).then(resolve).catch(reject);
      }

      if (res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
      }

      const chunks = [];
      let total = 0;

      res.on('data', (chunk) => {
        total += chunk.length;
        chunks.push(chunk);
        if (total >= MAX_RAW_BYTES) req.destroy(); // got enough
      });

      res.on('end', () => resolve({ html: Buffer.concat(chunks).toString('utf8'), status: res.statusCode }));
      res.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

async function handler({ url }) {
  if (!url) return 'No URL provided.';
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  let html, status;
  try {
    ({ html, status } = await fetchRaw(url));
  } catch (err) {
    return `Failed to fetch ${url}: ${err.message}`;
  }

  const title = extractTitle(html);
  const text  = toReadableText(html);
  const trunc = text.length > MAX_CHARS
    ? text.slice(0, MAX_CHARS) + `\n\n… [${text.length - MAX_CHARS} more chars not shown]`
    : text;

  return [
    `URL: ${url}`,
    title ? `Title: ${title}` : null,
    `Status: ${status}`,
    '',
    trunc || '(no readable content extracted)'
  ].filter(l => l !== null).join('\n');
}

module.exports = { declaration, handler };
