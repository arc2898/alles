'use strict';
const path = require('node:path');
const { titles } = require('./identity');

/**
 * WorkspaceWindow - ALLES as a desktop application: the one normal window with Chat, History, Code and Voice.
 *
 * Unlike the Settings window it is allowed ONE permission: the microphone, for the voice button, and only for this window's own page
 * and only for sound (never the camera). It has its own session ("partition") so that choice cannot leak into, or be overridden by,
 * the Settings window, which refuses every permission. The rest is as locked down as Settings: sandboxed, context-isolated, no menu,
 * no navigation, no new windows, no webview. isTrusted(event) is the only gate workspace-ipc.js uses.
 */

const BACKGROUND_DARK = '#0f131b';
const BACKGROUND_LIGHT = '#f3f5f9';
const SIZE = { width: 1120, height: 760, minWidth: 760, minHeight: 520 };
const FRAME = { width: 48, height: 96 };
const PARTITION = 'alles-workspace';           // in memory only: nothing from this session's cookies or storage is kept on disk

class WorkspaceWindow {
  constructor({ electron, preload = path.join(__dirname, '../workspace/preload.cjs'), html = path.join(__dirname, '../workspace/workspace.html'), onError = (e) => console.error('[ALLES] the workspace page failed to load:', e && e.message), onClosed = () => {} }) {
    this.electron = electron; this.preload = preload; this.html = html; this.onError = onError; this.onClosed = onClosed;
    this.win = null;
  }

  _size() {
    let area = null;
    try { const { screen } = this.electron; const d = screen && (screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || screen.getPrimaryDisplay()); area = d && d.workArea; } catch { /* usual size */ }
    const fit = (want, available, frame, min) => { const room = typeof available === 'number' ? available - frame : NaN; return Number.isFinite(room) && room > 0 ? Math.max(min, Math.min(want, Math.floor(room))) : want; };
    return { width: fit(SIZE.width, area && area.width, FRAME.width, SIZE.minWidth), height: fit(SIZE.height, area && area.height, FRAME.height, SIZE.minHeight) };
  }

  _prefersDark() { const t = this.electron.nativeTheme; return !t || t.shouldUseDarkColors !== false; }

  open() {
    if (this.win && !this.win.isDestroyed()) {
      if (this.win.isMinimized()) this.win.restore();
      this.win.show(); this.win.focus();
      return this.win;
    }
    const { BrowserWindow } = this.electron;
    const win = new BrowserWindow({
      ...this._size(), minWidth: SIZE.minWidth, minHeight: SIZE.minHeight,
      title: titles.workspace,
      backgroundColor: this._prefersDark() ? BACKGROUND_DARK : BACKGROUND_LIGHT,
      show: true, autoHideMenuBar: true,
      webPreferences: { preload: this.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false, partition: PARTITION },
    });
    this.win = win;
    win.removeMenu();
    win.focus();
    const focusAgain = () => { if (!win.isDestroyed()) win.focus(); };
    win.on('ready-to-show', focusAgain);
    win.webContents.on('did-finish-load', focusAgain);

    const wc = win.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (event) => event.preventDefault());
    wc.on('will-attach-webview', (event) => event.preventDefault());
    // The microphone, for sound only, for this window's own page only. Every other permission is refused.
    const micOnly = (permission, details) => permission === 'media' && !!details
      && (Array.isArray(details.mediaTypes) ? details.mediaTypes.length > 0 && details.mediaTypes.every((t) => t === 'audio') : details.mediaType === 'audio');
    const session = wc.session;
    session.setPermissionRequestHandler((requester, permission, callback, details) => callback(requester === wc && micOnly(permission, details)));
    if (typeof session.setPermissionCheckHandler === 'function') session.setPermissionCheckHandler((requester, permission, _origin, details) => requester === wc && micOnly(permission, details));

    win.on('closed', () => { if (this.win === win) { this.win = null; try { this.onClosed(); } catch { /* the app's own problem */ } } });
    Promise.resolve(win.loadFile(this.html)).catch((e) => this.onError(e));
    return win;
  }

  isTrusted(event) { return !!(event && this.win && !this.win.isDestroyed() && event.sender === this.win.webContents); }

  /** Report something to the page. The payload is plain data made by main (never a secret). */
  send(payload) { if (this.win && !this.win.isDestroyed()) this.win.webContents.send('ws:event', payload); }

  get isOpen() { return !!(this.win && !this.win.isDestroyed()); }
  close() { if (this.win && !this.win.isDestroyed()) this.win.close(); }
  destroy() { if (this.win && !this.win.isDestroyed()) this.win.destroy(); this.win = null; }
}

module.exports = { WorkspaceWindow, BACKGROUND_DARK, BACKGROUND_LIGHT, PARTITION };
