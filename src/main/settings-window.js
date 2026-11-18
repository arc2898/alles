'use strict';

const path = require('node:path');
const { titles } = require('./identity');

/**
 * SettingsWindow - the one Settings window: opened on demand, reused if already open, locked down.
 *
 * WHY A CLASS OF ITS OWN: the Settings page can read the provider list and add or remove API keys, so the
 * window that hosts it is the most security-sensitive surface in the app. Everything that keeps it safe lives
 * here, in one place with its own tests:
 *   - sandboxed, context-isolated, no Node in the page, and only the narrow preload bridge
 *   - no menu (the default Electron menu would bring Reload and DevTools to a window that holds secrets)
 *   - no new windows, no navigation away from our own page, no <webview>, no permission prompts granted
 *   - isTrusted(event): the ONLY gate settings-ipc.js uses to decide who may ask for settings or keys
 */

// The window's own colour until the page paints. It must equal the page's --bg in each theme (a test compares them),
// or the window flashes the wrong colour while it loads.
const BACKGROUND_DARK = '#0f131b';
const BACKGROUND_LIGHT = '#f3f5f9';

// The usual size, and the smallest the page is laid out for. On a small screen the window shrinks to fit (never below
// the minimum), because GNOME draws its own title bar and shadow around the window, which a 768-pixel-high laptop
// screen has no room for on top of 700 pixels.
const SIZE = { width: 940, height: 700, minWidth: 640, minHeight: 480 };
const FRAME = { width: 48, height: 96 };         // room left for the title bar, the shadow and a desktop panel

class SettingsWindow {
  /**
   * @param {object} o
   * @param {object} o.electron                  { BrowserWindow, screen?, nativeTheme? }
   * @param {string} [o.preload]                 absolute path of the preload script
   * @param {string} [o.html]                    absolute path of the page
   * @param {(err:Error)=>void} [o.onError]      called if the page fails to load
   */
  constructor({ electron, preload = path.join(__dirname, '../settings/preload.cjs'), html = path.join(__dirname, '../settings/settings.html'), onError = (e) => console.error('[ALLES] the Settings page failed to load:', e.message) }) {
    this.electron = electron;
    this.preload = preload;
    this.html = html;
    this.onError = onError;
    this.win = null;
  }

  /** The usual size, shrunk to fit the screen the window will open on. An unknown or silly screen means the usual size. */
  _size() {
    let area = null;
    try {
      const { screen } = this.electron;
      const display = screen && (screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || screen.getPrimaryDisplay());
      area = display && display.workArea;
    } catch { /* the screen could not be asked: use the usual size */ }
    // Only a real number counts (a string like "768" would quietly work in arithmetic, and is not something a screen reports).
    const fit = (want, available, frame, min) => {
      const room = typeof available === 'number' ? available - frame : NaN;
      return Number.isFinite(room) && room > 0 ? Math.max(min, Math.min(want, Math.floor(room))) : want;
    };
    return {
      width: fit(SIZE.width, area && area.width, FRAME.width, SIZE.minWidth),
      height: fit(SIZE.height, area && area.height, FRAME.height, SIZE.minHeight),
    };
  }

  _prefersDark() {
    const t = this.electron.nativeTheme;
    return !t || t.shouldUseDarkColors !== false;      // unknown means dark, the page's own default
  }

  /** Open the window, or bring the existing one to the front. Returns the BrowserWindow. */
  open() {
    if (this.win && !this.win.isDestroyed()) {
      if (this.win.isMinimized()) this.win.restore();
      this.win.show();
      this.win.focus();
      return this.win;
    }
    const { BrowserWindow } = this.electron;
    const win = new BrowserWindow({
      ...this._size(), minWidth: SIZE.minWidth, minHeight: SIZE.minHeight,
      title: titles.settings,
      backgroundColor: this._prefersDark() ? BACKGROUND_DARK : BACKGROUND_LIGHT,
      show: true,
      autoHideMenuBar: true,
      webPreferences: {
        preload: this.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
      },
    });
    this.win = win;
    win.removeMenu();
    // Ask the desktop to give the new window the keyboard. Measured on a real GNOME Shell: a window opened by the click on the
    // island's gear did NOT get it (the island kept it), so the person had to click the new window before typing in it.
    win.focus();
    const focusAgain = () => { if (!win.isDestroyed()) win.focus(); };
    win.on('ready-to-show', focusAgain);
    win.webContents.on('did-finish-load', focusAgain);

    const wc = win.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));          // a link or script must never open another window
    wc.on('will-navigate', (event) => event.preventDefault());    // the page never goes anywhere else
    wc.on('will-attach-webview', (event) => event.preventDefault());
    wc.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));   // camera, microphone, ...: no

    win.on('closed', () => { if (this.win === win) this.win = null; });
    Promise.resolve(win.loadFile(this.html)).catch((e) => this.onError(e));
    return win;
  }

  /** Is this IPC event from OUR Settings page, in the window that is open right now? */
  isTrusted(event) {
    return !!(event && this.win && !this.win.isDestroyed() && event.sender === this.win.webContents);
  }

  /** Tell an open page that something changed so it can ask again. No data travels: the page re-reads what it needs. */
  notifyChanged() {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('settings:changed');
  }

  get isOpen() { return !!(this.win && !this.win.isDestroyed()); }

  close() {
    if (this.win && !this.win.isDestroyed()) this.win.close();
  }

  destroy() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

module.exports = { SettingsWindow, BACKGROUND_DARK, BACKGROUND_LIGHT };
