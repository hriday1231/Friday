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

  // Defensive helpers — calling .show()/.hide() on a destroyed BrowserWindow
  // throws. Always check before touching it.
  const _alive = () => mainWindow && !mainWindow.isDestroyed();
  const _show  = () => { if (_alive()) { mainWindow.show(); mainWindow.focus(); } };
  const _hide  = () => { if (_alive()) mainWindow.hide(); };
  const _isVis = () => _alive() && mainWindow.isVisible();
  const _isFoc = () => _alive() && mainWindow.isFocused();

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Friday', click: _show },
    { label: 'Hide Friday', click: _hide },
    { type: 'separator' },
    { label: 'Quit',        click: () => app.quit() },
  ]);

  tray.setToolTip('Friday Assistant');

  if (process.platform === 'darwin') {
    // On macOS, setContextMenu() hijacks left-click to show the menu automatically.
    // Instead: left-click toggles the window, right-click pops up the menu.
    tray.on('right-click', () => tray.popUpContextMenu(contextMenu));
    tray.on('click', () => { if (_isVis() && _isFoc()) _hide(); else _show(); });
  } else {
    // Windows / Linux: left-click toggles, right-click shows context menu.
    tray.setContextMenu(contextMenu);
    tray.on('click', () => { if (_isVis()) _hide(); else _show(); });
  }
}

module.exports = { setupTray };