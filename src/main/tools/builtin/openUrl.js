const { shell } = require('electron');
const { spawn } = require('child_process');
const SettingsStore = require('../../settings/SettingsStore');

const declaration = {
  name: 'open_url',
  description:
    'Open a URL or domain in the user\'s browser for them to browse manually. ' +
    'Supports browser="default"|"edge"|"brave" and incognito=true. For site-specific searches ("search X on YouTube/Amazon/GitHub"), use search_site instead.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL or domain to open (e.g. "https://github.com" or "instagram.com").'
      },
      browser: {
        type: 'string',
        description: 'Browser to use: "default", "edge", or "brave".',
      },
      incognito: {
        type: 'boolean',
        description: 'Whether to open in an incognito / private window (Edge/Brave only).'
      }
    },
    required: ['url']
  }
};

function normalizeBrowser(browser) {
  const b = (browser || 'default').trim().toLowerCase();
  if (b === 'edge' || b === 'microsoft edge') return 'edge';
  if (b === 'brave') return 'brave';
  return 'default';
}

async function handler(args) {
  const { url, browser, incognito } = args || {};
  if (!url) {
    throw new Error('URL is required');
  }

  // If input is a URL/domain, normalize it.
  // Otherwise (e.g. "YT"), only allow it if it resolves via bookmarks/aliases.
  let targetUrl;
  if (SettingsStore._looksLikeUrl(url)) {
    targetUrl = SettingsStore.normalizeUrl(url);
  } else {
    const resolved = SettingsStore.resolveUrlFromName(url);
    if (!resolved) {
      throw new Error(
        `\"${url}\" does not look like a URL. Please add it as a bookmark or alias in Settings.`
      );
    }
    targetUrl = SettingsStore.normalizeUrl(resolved);
  }

  if (!targetUrl) {
    throw new Error(`Could not resolve a URL from "${url}". Please add it as a bookmark or alias in Settings.`);
  }

  const browserType = normalizeBrowser(browser);

  if (browserType === 'default') {
    await shell.openExternal(targetUrl);
    return `Opened ${targetUrl} in the default browser.`;
  }

  // For edge/brave, use app shortcuts to find the executable
  const shortcut = SettingsStore.findAppShortcutByName(browserType);
  if (!shortcut || !shortcut.path) {
    // Fallback: default browser if specific browser shortcut is not configured
    await shell.openExternal(targetUrl);
    return `Browser shortcut "${browserType}" is not configured. Opened ${targetUrl} in the default browser instead.`;
  }

  const exePath = shortcut.path.trim().replace(/^["']|["']$/g, '');
  const baseArgs = [];

  if (browserType === 'edge' && incognito) {
    baseArgs.push('--inprivate');
  } else if (browserType === 'brave' && incognito) {
    baseArgs.push('--incognito');
  } else {
    // Make it visible: force a new window when explicitly choosing a browser
    // (otherwise it may open a background tab in an existing window and look like it “did nothing”).
    baseArgs.push('--new-window');
  }

  const finalArgs = [...baseArgs, targetUrl];

  await new Promise((resolve) => {
    let launched = false;
    try {
      const child = spawn(exePath, finalArgs, { detached: true, stdio: 'ignore' });
      child.on('error', async (err) => {
        if (launched) return;
        launched = true;
        console.error(`Failed to launch ${browserType} (${exePath}):`, err.message);
        // Graceful fallback — open in default browser instead of crashing
        try { await shell.openExternal(targetUrl); } catch (_) {}
        resolve();
      });
      // Give the process a tick to emit a synchronous error before assuming success
      setImmediate(() => {
        if (!launched) { launched = true; child.unref(); resolve(); }
      });
    } catch (err) {
      console.error(`Failed to spawn ${browserType}:`, err.message);
      shell.openExternal(targetUrl).catch(() => {}).then(resolve);
    }
  });

  return `Opened ${targetUrl} in ${browserType}${incognito ? ' (incognito)' : ''}.`;
}

module.exports = { declaration, handler };

