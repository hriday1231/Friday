const { shell } = require('electron');
const { spawn } = require('child_process');
const SettingsStore = require('../../settings/SettingsStore');

const declaration = {
  name: 'open_bookmark',
  description:
    'Open a known bookmark (or alias) in the browser. Use this when the user refers to a site by a friendly name like \"YT\" or \"Insta\". ' +
    'Optional browser can be \"default\", \"edge\" or \"brave\", and incognito can request private mode.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Friendly bookmark or alias name (e.g. \"YT\", \"Insta\", \"Calendar\").'
      },
      browser: {
        type: 'string',
        description: 'Browser to use: \"default\", \"edge\", or \"brave\".'
      },
      incognito: {
        type: 'boolean',
        description: 'Whether to open in an incognito / private window (Edge/Brave only).'
      }
    },
    required: ['name']
  }
};

function normalizeBrowser(browser) {
  const b = (browser || 'default').trim().toLowerCase();
  if (b === 'edge' || b === 'microsoft edge') return 'edge';
  if (b === 'brave') return 'brave';
  return 'default';
}

async function handler(args) {
  const { name, browser, incognito } = args || {};
  if (!name) {
    throw new Error('Bookmark name is required');
  }

  const resolvedUrl = SettingsStore.resolveUrlFromName(name);
  if (!resolvedUrl) {
    throw new Error(
      `Bookmark or alias \"${name}\" was not found. Please add it in Settings (Web Bookmarks or Aliases).`
    );
  }

  const targetUrl = SettingsStore.normalizeUrl(resolvedUrl);
  const browserType = normalizeBrowser(browser);

  if (browserType === 'default') {
    await shell.openExternal(targetUrl);
    return `Opened bookmark "${name}" at ${targetUrl} in the default browser.`;
  }

  const shortcut = SettingsStore.findAppShortcutByName(browserType);
  if (!shortcut || !shortcut.path) {
    await shell.openExternal(targetUrl);
    return `Browser shortcut "${browserType}" is not configured. Opened ${targetUrl} in the default browser instead.`;
  }

  const exePath = shortcut.path;
  const baseArgs = [];

  if (browserType === 'edge' && incognito) {
    baseArgs.push('--inprivate');
  } else if (browserType === 'brave' && incognito) {
    baseArgs.push('--incognito');
  } else {
    // Force a new window so it visibly opens.
    baseArgs.push('--new-window');
  }

  const finalArgs = [...baseArgs, targetUrl];

  try {
    const child = spawn(exePath, finalArgs, {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
  } catch (error) {
    console.error('Failed to launch browser for bookmark:', error);
    await shell.openExternal(targetUrl);
    return `Failed to launch ${browserType} directly. Opened ${targetUrl} in the default browser instead.`;
  }

  return `Opened bookmark "${name}" at ${targetUrl} in ${browserType}${incognito ? ' (incognito)' : ''}.`;
}

module.exports = { declaration, handler };

