const { spawn } = require('child_process');
const SettingsStore = require('../../settings/SettingsStore');

const declaration = {
  name: 'launch_app',
  description:
    'Launch a known application shortcut on the local machine. Only apps defined in Friday settings can be launched.',
  parameters: {
    type: 'object',
    properties: {
      shortcutName: {
        type: 'string',
        description: 'Friendly name of the app shortcut (e.g. "Code", "Steam", "Edge", "Brave").'
      }
    },
    required: ['shortcutName']
  }
};

async function handler(args) {
  const { shortcutName } = args || {};
  if (!shortcutName) {
    throw new Error('shortcutName is required');
  }

  const shortcut = SettingsStore.findAppShortcutByName(shortcutName);
  if (!shortcut || !shortcut.path) {
    throw new Error(
      `App shortcut "${shortcutName}" was not found. Please add it in Settings (App Shortcuts).`
    );
  }

  const exePath = shortcut.path;
  let extraArgs = [];

  if (shortcut.args) {
    if (Array.isArray(shortcut.args)) {
      extraArgs = shortcut.args;
    } else if (typeof shortcut.args === 'string') {
      extraArgs = shortcut.args.split(' ').filter(Boolean);
    }
  }

  try {
    const child = spawn(exePath, extraArgs, {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
  } catch (error) {
    console.error('Failed to launch app:', error);
    throw new Error(`Failed to launch "${shortcutName}": ${error.message}`);
  }

  return `Launched "${shortcutName}".`;
}

module.exports = { declaration, handler };

