'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { fakeElectron } = require('./helpers/fake-electron');
const { WorkspaceWindow, BACKGROUND_DARK, BACKGROUND_LIGHT, PARTITION } = require('../src/main/workspace-window');

const rig = (o = {}) => {
  const { electron, internals } = fakeElectron();
  const Base = electron.BrowserWindow;
  electron.BrowserWindow = class extends Base { constructor(opts) { super(opts); this.webContents.session.checkHandler = null; this.webContents.session.setPermissionCheckHandler = (fn) => { this.webContents.session.checkHandler = fn; }; } };
  electron.BrowserWindow.getAllWindows = Base.getAllWindows;
  const ww = new WorkspaceWindow({ electron, onError: () => {}, ...o });
  return { ww, electron, internals };
};

test('open() makes one sandboxed, isolated, node-free window with ONLY the workspace preload, in its own in-memory session', () => {
  const { ww, internals } = rig();
  const win = ww.open();
  const wp = win.opts.webPreferences;
  assert.deepStrictEqual([wp.contextIsolation, wp.sandbox, wp.nodeIntegration, wp.webSecurity], [true, true, false, true]);
  assert.ok(wp.preload.endsWith(path.join('workspace', 'preload.cjs')));
  assert.strictEqual(wp.partition, PARTITION); assert.ok(!PARTITION.startsWith('persist:'), 'nothing of this window\'s session is written to disk');
  assert.strictEqual(win.opts.title, 'ALLES');
  for (const bad of ['nodeIntegrationInWorker', 'nodeIntegrationInSubFrames', 'allowRunningInsecureContent', 'webviewTag']) assert.ok(!wp[bad], bad);
  assert.ok(win._menuRemoved);
  assert.strictEqual(internals.windows.filter((w) => !w.isDestroyed()).length, 1);
  assert.ok(fs.existsSync(ww.preload) && fs.existsSync(ww.html));
});

test('a second open() reuses the window and brings it to the front', () => {
  const { ww, internals } = rig();
  const a = ww.open(); a.minimize();
  const b = ww.open();
  assert.strictEqual(a, b); assert.strictEqual(b.isMinimized(), false);
  assert.strictEqual(internals.windows.length, 1);
});

test('the window refuses new windows, navigation and webviews', () => {
  const { ww } = rig();
  const wc = ww.open().webContents;
  assert.deepStrictEqual(wc.windowOpenHandler({ url: 'https://evil.example' }), { action: 'deny' });
  let prevented = 0; const ev = { preventDefault: () => { prevented++; } };
  wc.emit('will-navigate', ev); wc.emit('will-attach-webview', ev);
  assert.strictEqual(prevented, 2);
});

test('the microphone is the one permission: sound only, for this window only; camera and everything else are refused', () => {
  const { ww } = rig();
  const wc = ww.open().webContents;
  const ask = (requester, permission, details) => { let r; wc.session.permissionHandler(requester, permission, (v) => { r = v; }, details); return r; };
  assert.strictEqual(ask(wc, 'media', { mediaTypes: ['audio'] }), true);
  assert.strictEqual(ask(wc, 'media', { mediaTypes: ['audio', 'video'] }), false, 'a camera request is refused');
  assert.strictEqual(ask(wc, 'media', { mediaTypes: ['video'] }), false);
  assert.strictEqual(ask(wc, 'media', { mediaTypes: [] }), false);
  assert.strictEqual(ask(wc, 'media', undefined), false);
  assert.strictEqual(ask({}, 'media', { mediaTypes: ['audio'] }), false, 'another page cannot use it');
  for (const p of ['geolocation', 'notifications', 'clipboard-read', 'midi', 'display-capture', 'openExternal', 'fullscreen']) assert.strictEqual(ask(wc, p, { mediaTypes: ['audio'] }), false, p);
  const check = wc.session.checkHandler;
  assert.strictEqual(check(wc, 'media', 'file://', { mediaType: 'audio' }), true);
  assert.strictEqual(check(wc, 'media', 'file://', { mediaType: 'video' }), false);
  assert.strictEqual(check(wc, 'geolocation', 'file://', {}), false);
  assert.strictEqual(check({}, 'media', 'file://', { mediaType: 'audio' }), false);
});

test('isTrusted: only the open window\'s own page; send() reaches only it; closing runs onClosed once', () => {
  let closed = 0;
  const { ww } = rig({ onClosed: () => { closed++; } });
  assert.strictEqual(ww.isTrusted({ sender: {} }), false, 'nothing open yet');
  const win = ww.open();
  assert.strictEqual(ww.isTrusted({ sender: win.webContents }), true);
  assert.strictEqual(ww.isTrusted({ sender: {} }), false);
  assert.strictEqual(ww.isTrusted(null), false);
  win.webContents.send = (ch, p) => { win.sentTo = [ch, p]; };
  ww.send({ type: 'x' });
  assert.deepStrictEqual(win.sentTo, ['ws:event', { type: 'x' }]);
  win.destroy();
  assert.strictEqual(closed, 1); assert.strictEqual(ww.isOpen, false);
  assert.strictEqual(ww.isTrusted({ sender: win.webContents }), false, 'a closed window\'s old page is not trusted');
  ww.send({ type: 'late' });                  // nothing open: must not throw
});

test('the window\'s own colour equals the page\'s --bg in each theme', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/workspace/workspace.css'), 'utf8');
  const dark = /:root\s*{[^}]*--bg:\s*(#[0-9a-f]{6})/i.exec(css)[1];
  const light = /prefers-color-scheme: light\)\s*{\s*:root\s*{[^}]*--bg:\s*(#[0-9a-f]{6})/i.exec(css)[1];
  assert.strictEqual(dark.toLowerCase(), BACKGROUND_DARK); assert.strictEqual(light.toLowerCase(), BACKGROUND_LIGHT);
});

test('it shrinks to a small screen but never below its minimum', () => {
  const { electron } = fakeElectron({ workArea: { x: 0, y: 0, width: 1024, height: 700 } });
  const ww = new WorkspaceWindow({ electron, onError: () => {} });
  const s = ww._size();
  assert.ok(s.width <= 1024 - 48 && s.height <= 700 - 96 && s.width >= 760 && s.height >= 520, JSON.stringify(s));
});
