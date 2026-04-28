const { app, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

let tray = null;

function _trayIconPath() {
  const base = path.join(__dirname, '../../public');
  if (process.platform === 'darwin') return path.join(base, 'icon.icns');
  if (process.platform === 'win32')  return path.join(base, 'icon.ico');
  return path.join(base, 'icons', '256x256.png');
}

function setupTray(mainWindow) {
  const iconPath = _trayIconPath();
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();

  tray = new Tray(icon);
  
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Friday',
      click: () => {
        mainWindow.show();
        mainWindow.focus();
      }
    },
    {
      label: 'Hide Friday',
      click: () => {
        mainWindow.hide();
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      }
    }
  ]);

  tray.setToolTip('Friday Assistant');

  if (process.platform === 'darwin') {
    // On macOS, setContextMenu() hijacks left-click to show the menu automatically.
    // Instead: left-click toggles the window, right-click pops up the menu.
    tray.on('right-click', () => tray.popUpContextMenu(contextMenu));
    tray.on('click', () => {
      if (mainWindow.isVisible() && mainWindow.isFocused()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } else {
    // Windows / Linux: left-click toggles, right-click shows context menu.
    tray.setContextMenu(contextMenu);
    tray.on('click', () => {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  }
}

module.exports = { setupTray };