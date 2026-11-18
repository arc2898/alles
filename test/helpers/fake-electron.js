'use strict';
const { EventEmitter } = require('node:events');
const { solidPng } = require('../../src/main/util/png');

/**
 * A fake `electron` module detailed enough to run App.create() for real and observe what it does -
 * NOT a mock that returns canned answers. BrowserWindow tracks its own bounds and sent IPC; Tray records
 * every menu/tooltip call; ipcMain actually dispatches to whatever attachPageEvents registered.
 */
function fakeElectron({ workArea = { x: 0, y: 0, width: 1920, height: 1080 }, bounds = null } = {}) {
  // `bounds` is the whole display; `workArea` is what is left after panels. By default they cover the same area (no panel).
  const fullBounds = bounds || { x: 0, y: 0, width: workArea.width, height: workArea.height };
  const windows = []; const trays = []; const sentToRenderer = []; const shortcuts = {};

  class FakeWebContents extends EventEmitter {
    constructor(win) {
      super(); this.win = win;
      this.windowOpenHandler = null;                 // what setWindowOpenHandler() was given
      // The window's session, as far as the app touches it. permissionHandler is what setPermissionRequestHandler() was given.
      this.session = { permissionHandler: null, setPermissionRequestHandler: (fn) => { this.session.permissionHandler = fn; } };
    }
    send(channel, payload) { sentToRenderer.push({ win: this.win, channel, payload }); }
    once(event, cb) { if (event === 'did-finish-load') queueMicrotask(cb); return this; }
    setWindowOpenHandler(fn) { this.windowOpenHandler = fn; }
    executeJavaScript() { return Promise.resolve(); }
  }

  class BrowserWindow {
    constructor(opts = {}) {
      this.opts = opts;
      this.bounds = { x: opts.x || 0, y: opts.y || 0, width: opts.width || 0, height: opts.height || 0 };
      this._destroyed = false; this._alwaysOnTop = false; this._focused = false;
      this.webContents = new FakeWebContents(this);
      this._listeners = {};
      windows.push(this);
    }
    setBounds(b) { Object.assign(this.bounds, b); }
    getBounds() { return { ...this.bounds }; }
    setPosition(x, y) { this.bounds.x = x; this.bounds.y = y; }
    setAlwaysOnTop(v) { this._alwaysOnTop = v; }
    setVisibleOnAllWorkspaces() {}
    setContentSize(w, h) { this.bounds.width = w; this.bounds.height = h; }
    loadFile(file) { this.loadedFile = file; return Promise.resolve(); }
    loadURL() { return Promise.resolve(); }
    focus() { this._focused = true; }
    show() { this._shown = true; }
    removeMenu() { this._menuRemoved = true; }
    isMinimized() { return !!this._minimized; }
    minimize() { this._minimized = true; }
    restore() { this._minimized = false; }
    close() { this.destroy(); }
    isDestroyed() { return this._destroyed; }
    isVisible() { return !this._destroyed; }
    destroy() { this._destroyed = true; this.emit && this.emit('closed'); (this._listeners.closed || []).forEach((f) => f()); }
    on(ev, cb) { (this._listeners[ev] = this._listeners[ev] || []).push(cb); return this; }
    static getAllWindows() { return windows.filter((w) => !w._destroyed); }
  }

  class Tray extends EventEmitter {
    constructor(icon) { super(); this.icon = icon; this.tooltip = null; this.menu = null; this._destroyed = false; trays.push(this); }
    setToolTip(t) { this.tooltip = t; }
    setContextMenu(m) { this.menu = m; }
    isDestroyed() { return this._destroyed; }
    destroy() { this._destroyed = true; }
    getBounds() { return { x: 0, y: 0, width: 22, height: 22 }; }
  }

  const Menu = { buildFromTemplate: (t) => t };

  const screen = {
    getCursorScreenPoint: () => ({ x: Math.round(workArea.width / 2), y: Math.round(workArea.height / 2) }),
    getPrimaryDisplay: () => ({ id: 1, workArea, bounds: fullBounds }),
    getDisplayNearestPoint: () => screen.getPrimaryDisplay(),
    getAllDisplays: () => [screen.getPrimaryDisplay()],
  };

  // A REAL dispatcher: main sends `ipcMain.on('pill:event', ...)`, and the test fires it exactly as the
  // preload would, so this exercises the actual PAGE_EVENTS / cleanPayload path in window.js.
  const ipcHandlers = {};
  const ipcInvokeHandlers = {};
  const ipcMain = {
    on(channel, fn) { (ipcHandlers[channel] = ipcHandlers[channel] || []).push(fn); },
    removeListener(channel, fn) { const l = ipcHandlers[channel]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } },
    _fire(channel, sender, ...args) { (ipcHandlers[channel] || []).forEach((fn) => fn({ sender }, ...args)); },
    // ipcRenderer.invoke(channel, payload) <-> ipcMain.handle(channel, fn) - the request/response pattern
    // used by the Settings window (attachSettingsIpc), distinct from the pill's fire-and-forget .on/.send.
    handle(channel, fn) {
      if (channel in ipcInvokeHandlers) throw new Error(`Attempted to register a second handler for '${channel}'`); // matches real Electron's own guard
      ipcInvokeHandlers[channel] = fn;
    },
    removeHandler(channel) { delete ipcInvokeHandlers[channel]; },
    /** Every channel somebody has registered with handle() right now. */
    _handledChannels() { return Object.keys(ipcInvokeHandlers); },
    /** Simulates ipcRenderer.invoke(channel, payload) -> returns whatever the handler resolves/rejects. */
    _invoke(channel, sender, payload) {
      const fn = ipcInvokeHandlers[channel];
      if (!fn) return Promise.reject(new Error(`No handler registered for '${channel}'`));
      return Promise.resolve(fn({ sender }, payload));
    },
  };

  const globalShortcut = {
    register(accel, cb) { shortcuts[accel] = cb; return true; },
    unregister(accel) { delete shortcuts[accel]; },
    isRegistered: (accel) => accel in shortcuts,
  };

  const nativeTheme = { shouldUseDarkColors: true };
  // (resize/toPNG make a picture of the asked size, so code that shrinks a screenshot can be tried; the picture is one flat colour)
  const nativeImage = { createFromBuffer: (b) => ({ isEmpty: () => b.length === 0, resize: ({ width, height }) => ({ toPNG: () => solidPng(width, height, [0, 0, 0]) }) }) };

  let encAvailable = true;
  const safeStorage = {
    isEncryptionAvailable: () => encAvailable,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (s) => Buffer.concat([Buffer.from('enc:'), Buffer.from(s)]),
    decryptString: (b) => b.toString('utf8').replace(/^enc:/, ''),
    _setAvailable: (v) => { encAvailable = v; },
  };

  // Electron's clipboard, as far as the app touches it: text in, text out, and a way to tell what else it holds.
  const clip = { text: '', formats: [] };
  const clipboard = {
    readText: () => clip.text,
    writeText: (t) => { clip.text = String(t); clip.formats = ['text/plain']; },
    clear: () => { clip.text = ''; clip.formats = []; },
    availableFormats: () => clip.formats.slice(),
    _state: clip,
  };

  const app = new EventEmitter();
  app.getPath = (name) => (name === 'userData' ? '/fake/userData' : `/fake/${name}`);
  app.quit = () => app.emit('quit');
  app.getVersion = () => '0.0.0-test';

  return {
    electron: { app, BrowserWindow, Tray, Menu, screen, ipcMain, globalShortcut, nativeImage, nativeTheme, safeStorage, clipboard },
    internals: { windows, trays, sentToRenderer, shortcuts, ipcMain, handledChannels: () => ipcMain._handledChannels(), fireIpc: (name, payload, sender) => ipcMain._fire('pill:event', sender, name, payload), invoke: (channel, payload, sender) => ipcMain._invoke(channel, sender, payload) },
  };
}

module.exports = { fakeElectron };
