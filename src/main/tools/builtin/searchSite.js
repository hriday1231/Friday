const { shell } = require('electron');
const { spawn } = require('child_process');
const SettingsStore = require('../../settings/SettingsStore');

const SITES = {
  youtube:   (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
  yt:        (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
  amazon:    (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
  github:    (q) => `https://github.com/search?q=${encodeURIComponent(q)}&type=repositories`,
  google:    (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  bing:      (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
  duckduckgo:(q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
  ddg:       (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
  reddit:    (q) => `https://www.reddit.com/search/?q=${encodeURIComponent(q)}`,
  twitter:   (q) => `https://x.com/search?q=${encodeURIComponent(q)}`,
  x:         (q) => `https://x.com/search?q=${encodeURIComponent(q)}`,
  stackoverflow: (q) => `https://stackoverflow.com/search?q=${encodeURIComponent(q)}`,
  wikipedia: (q) => `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(q)}`,
  wiki:      (q) => `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(q)}`,
  ebay:      (q) => `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}`,
  maps:      (q) => `https://www.google.com/maps/search/${encodeURIComponent(q)}`,
  npm:       (q) => `https://www.npmjs.com/search?q=${encodeURIComponent(q)}`,
  pypi:      (q) => `https://pypi.org/search/?q=${encodeURIComponent(q)}`,
};

const declaration = {
  name: 'search_site',
  description:
    'Open a site-specific search in the user\'s browser. Use when the user asks to "search/open YouTube for ASMR", "find standing desks on Amazon", "top React repos on GitHub", etc. ' +
    'Supported sites: youtube, amazon, github, google, bing, duckduckgo, reddit, twitter/x, stackoverflow, wikipedia, ebay, maps, npm, pypi. ' +
    'Default browser is Brave (normal window). Only set incognito=true if the user explicitly says "incognito" or "private".',
  parameters: {
    type: 'object',
    properties: {
      site: {
        type: 'string',
        description: 'Site to search: youtube, amazon, github, google, bing, reddit, twitter, stackoverflow, wikipedia, etc.',
      },
      query: {
        type: 'string',
        description: 'The search query.',
      },
      browser: {
        type: 'string',
        description: 'Browser to use: "brave" (default), "edge", or "default". Use brave for privacy.',
      },
      incognito: {
        type: 'boolean',
        description: 'Open in private / incognito window. Defaults to false — only set to true when the user explicitly asks for incognito/private.',
      },
    },
    required: ['site', 'query'],
  },
};

function normalizeBrowser(b) {
  const s = (b || 'brave').trim().toLowerCase();
  if (s === 'edge' || s === 'microsoft edge') return 'edge';
  if (s === 'brave') return 'brave';
  return 'default';
}

async function launchInBrowser(url, browserType, incognito) {
  if (browserType === 'default') {
    await shell.openExternal(url);
    return `Opened ${url} in the default browser.`;
  }
  const shortcut = SettingsStore.findAppShortcutByName(browserType);
  if (!shortcut?.path) {
    await shell.openExternal(url);
    return `Browser shortcut "${browserType}" not configured. Opened ${url} in default browser.`;
  }
  const exePath = shortcut.path.trim().replace(/^["']|["']$/g, '');
  const args = [];
  if (browserType === 'edge' && incognito)   args.push('--inprivate');
  else if (browserType === 'brave' && incognito) args.push('--incognito');
  else args.push('--new-window');
  args.push(url);

  await new Promise((resolve) => {
    let launched = false;
    try {
      const child = spawn(exePath, args, { detached: true, stdio: 'ignore' });
      child.on('error', async () => {
        if (launched) return;
        launched = true;
        try { await shell.openExternal(url); } catch {}
        resolve();
      });
      setImmediate(() => { if (!launched) { launched = true; child.unref(); resolve(); } });
    } catch {
      shell.openExternal(url).catch(() => {}).then(resolve);
    }
  });

  return `Opened ${url} in ${browserType}${incognito ? ' (incognito)' : ''}.`;
}

async function handler(args) {
  const { site, query, browser, incognito = false } = args || {};
  if (!site || !query) throw new Error('site and query are required');

  const key = String(site).trim().toLowerCase();
  const build = SITES[key];
  if (!build) {
    const supported = Object.keys(SITES).join(', ');
    throw new Error(`Unsupported site "${site}". Supported: ${supported}`);
  }

  const url = build(query);
  const browserType = normalizeBrowser(browser);
  return launchInBrowser(url, browserType, incognito);
}

module.exports = { declaration, handler };
