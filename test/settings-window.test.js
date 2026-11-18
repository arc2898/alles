'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { fakeElectron } = require('./helpers/fake-electron');
const { SettingsWindow, BACKGROUND_DARK, BACKGROUND_LIGHT } = require('../src/main/settings-window');

/**
 * The window that hosts the Settings page. It can reach API keys, so these tests are mostly about what it REFUSES:
 * extra windows, navigation away, webviews, permission prompts, and any caller that is not its own page.
 */

const rig = (o = {}) => {
  const { electron, internals } = fakeElectron();
  const sw = new SettingsWindow({ electron, onError: () => {}, ...o });
  return { sw, electron, internals };
};
const settingsWindows = (internals) => internals.windows.filter((w) => !w.isDestroyed());

test('open() makes one window with a sandboxed, isolated, node-free page and ONLY the settings preload', () => {
  const { sw, internals } = rig();
  const win = sw.open();
  assert.strictEqual(settingsWindows(internals).length, 1);
  const wp = win.opts.webPreferences;
  assert.strictEqual(wp.contextIsolation, true);
  assert.strictEqual(wp.sandbox, true);
  assert.strictEqual(wp.nodeIntegration, false);
  assert.strictEqual(wp.webSecurity, true);
  assert.ok(wp.preload && path.isAbsolute(wp.preload) && wp.preload.endsWith(path.join('settings', 'preload.cjs')), wp.preload);
  assert.strictEqual(win.opts.title, 'ALLES Settings');
  for (const forbidden of ['nodeIntegrationInWorker', 'nodeIntegrationInSubFrames', 'allowRunningInsecureContent', 'webviewTag', 'enableRemoteModule']) {
    assert.ok(!wp[forbidden], `${forbidden} must not be switched on`);
  }
});

test('the page and the preload it names are real files that exist', () => {
  const { sw } = rig();
  assert.ok(fs.existsSync(sw.preload), sw.preload);
  assert.ok(fs.existsSync(sw.html), sw.html);
  assert.ok(sw.html.endsWith('settings.html'));
  const win = sw.open();
  assert.strictEqual(win.loadedFile, sw.html, 'the window loads the page from disk, never a URL');
});

test('the window has no menu: no Reload, no DevTools shortcut in a window that holds secrets', () => {
  const { sw } = rig();
  assert.strictEqual(sw.open()._menuRemoved, true);
});

test('opening again reuses the same window; a minimised one is restored and brought forward', () => {
  const { sw, internals } = rig();
  const a = sw.open();
  a._focused = false; a.minimize();
  const b = sw.open();
  assert.strictEqual(a, b);
  assert.strictEqual(settingsWindows(internals).length, 1, 'no duplicate window');
  assert.strictEqual(a.isMinimized(), false, 'restored');
  assert.strictEqual(a._focused, true, 'focused');
});

test('after the window is closed, open() makes a fresh one', () => {
  const { sw, internals } = rig();
  const a = sw.open();
  a.close();
  assert.strictEqual(sw.isOpen, false);
  const b = sw.open();
  assert.notStrictEqual(a, b);
  assert.strictEqual(settingsWindows(internals).length, 1);
});

test('the page cannot open other windows: every window.open / target=_blank is denied', () => {
  const { sw } = rig();
  const wc = sw.open().webContents;
  assert.strictEqual(typeof wc.windowOpenHandler, 'function');
  for (const url of ['https://evil.test', 'file:///etc/passwd', 'about:blank', '']) assert.deepStrictEqual(wc.windowOpenHandler({ url }), { action: 'deny' }, url);
});

test('the page cannot navigate anywhere, and cannot attach a webview', () => {
  const { sw } = rig();
  const wc = sw.open().webContents;
  for (const ev of ['will-navigate', 'will-attach-webview']) {
    let prevented = 0;
    wc.emit(ev, { preventDefault: () => { prevented++; } }, 'https://evil.test');
    assert.strictEqual(prevented, 1, `${ev} was not prevented`);
  }
});

test('every permission request (camera, microphone, location, notifications...) is refused', () => {
  const { sw } = rig();
  const handler = sw.open().webContents.session.permissionHandler;
  assert.strictEqual(typeof handler, 'function');
  for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'midi', 'openExternal']) {
    let answer = 'unset';
    handler({}, permission, (granted) => { answer = granted; });
    assert.strictEqual(answer, false, permission);
  }
});

// ---------------------------------------------------------------- who may ask

test('isTrusted: only the open Settings page itself', () => {
  const { sw, internals } = rig();
  const win = sw.open();
  assert.strictEqual(sw.isTrusted({ sender: win.webContents }), true);
  const other = { send() {} };                                   // another renderer (e.g. the pill)
  assert.strictEqual(sw.isTrusted({ sender: other }), false);
  for (const bad of [null, undefined, {}, { sender: null }, { sender: undefined }, { sender: {} }, 'x', 5]) assert.strictEqual(sw.isTrusted(bad), false, JSON.stringify(bad));
  assert.strictEqual(internals.windows.length, 1);
});

test('isTrusted is false for everyone while no Settings window is open - including an old, closed one', () => {
  const { sw } = rig();
  assert.strictEqual(sw.isTrusted({ sender: {} }), false, 'never opened');
  const win = sw.open();
  const oldSender = win.webContents;
  win.close();
  assert.strictEqual(sw.isTrusted({ sender: oldSender }), false, 'the closed window is no longer trusted');
  const fresh = sw.open();
  assert.strictEqual(sw.isTrusted({ sender: fresh.webContents }), true);
  assert.strictEqual(sw.isTrusted({ sender: oldSender }), false, 'a new window does not re-trust the old page');
});

test('isTrusted never returns a truthy non-boolean', () => {
  const { sw } = rig();
  sw.open();
  assert.strictEqual(sw.isTrusted(undefined), false);
  assert.strictEqual(typeof sw.isTrusted({ sender: {} }), 'boolean');
});

// ---------------------------------------------------------------- notify, errors, teardown

test('notifyChanged sends "settings:changed" with no data, and is harmless with no window', () => {
  const { sw, internals } = rig();
  assert.doesNotThrow(() => sw.notifyChanged());
  assert.strictEqual(internals.sentToRenderer.length, 0);
  const win = sw.open();
  sw.notifyChanged();
  const sent = internals.sentToRenderer.filter((m) => m.win === win);
  assert.deepStrictEqual(sent.map((m) => [m.channel, m.payload]), [['settings:changed', undefined]]);
  win.close();
  assert.doesNotThrow(() => sw.notifyChanged());
});

test('a page that fails to load is reported, not an unhandled rejection', async () => {
  const errors = [];
  const { electron, internals } = fakeElectron();
  const sw = new SettingsWindow({ electron, onError: (e) => errors.push(e.message) });
  const orig = electron.BrowserWindow.prototype.loadFile;
  electron.BrowserWindow.prototype.loadFile = () => Promise.reject(new Error('ERR_FILE_NOT_FOUND'));
  try {
    sw.open();
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(errors, ['ERR_FILE_NOT_FOUND']);
    assert.strictEqual(internals.windows.length, 1, 'the window stays open so the person is not left with nothing');
  } finally { electron.BrowserWindow.prototype.loadFile = orig; }
});

test('destroy() closes the window and forgets it; calling it twice or before open() is fine', () => {
  const { sw, internals } = rig();
  assert.doesNotThrow(() => sw.destroy());
  const win = sw.open();
  sw.destroy();
  assert.strictEqual(win.isDestroyed(), true);
  assert.strictEqual(sw.isOpen, false);
  assert.strictEqual(sw.isTrusted({ sender: win.webContents }), false);
  assert.doesNotThrow(() => sw.destroy());
  assert.strictEqual(settingsWindows(internals).length, 0);
});

test('closing the window by hand forgets it (the "closed" event), so a stale reference is never reused', () => {
  const { sw } = rig();
  const win = sw.open();
  win.destroy();                                // fake emits 'closed'
  assert.strictEqual(sw.win, null);
});

// ---------------------------------------------------------------- size

const sizeOn = (workArea, tweak) => {
  const { electron, internals } = fakeElectron({ workArea });
  if (tweak) tweak(electron);
  const win = new SettingsWindow({ electron, onError: () => {} }).open();
  return { width: win.opts.width, height: win.opts.height, minWidth: win.opts.minWidth, minHeight: win.opts.minHeight, internals };
};

test('on an ordinary screen the window has its usual size', () => {
  for (const area of [{ x: 0, y: 0, width: 1920, height: 1080 }, { x: 0, y: 0, width: 2560, height: 1440 }, { x: 0, y: 0, width: 1600, height: 900 }]) {
    const s = sizeOn(area);
    assert.deepStrictEqual([s.width, s.height, s.minWidth, s.minHeight], [940, 700, 640, 480], JSON.stringify(area));
  }
});

test('on a small screen the window shrinks to leave room for the title bar and shadow - but never below its minimum', () => {
  const laptop = sizeOn({ x: 0, y: 0, width: 1366, height: 768 });
  assert.deepStrictEqual([laptop.width, laptop.height], [940, 672], 'a 1366x768 laptop');
  assert.ok(laptop.height + 96 <= 768, 'with the frame, it fits the screen');
  const netbook = sizeOn({ x: 0, y: 0, width: 1024, height: 600 });
  assert.deepStrictEqual([netbook.width, netbook.height], [940, 504], '1024x600');
  const tiny = sizeOn({ x: 0, y: 0, width: 800, height: 480 });
  assert.deepStrictEqual([tiny.width, tiny.height], [752, 480], 'width still shrinks, height stops at the minimum');
  const tinier = sizeOn({ x: 0, y: 0, width: 600, height: 400 });
  assert.deepStrictEqual([tinier.width, tinier.height], [640, 480], 'never below the minimum, even if that is bigger than the screen');
});

test('the window is sized for the screen it will open on (where the pointer is), not always the first one', () => {
  const big = { workArea: { x: 0, y: 0, width: 2560, height: 1440 } };
  const small = { workArea: { x: 2560, y: 0, width: 1366, height: 768 } };
  const s = sizeOn(big.workArea, (electron) => {
    electron.screen.getPrimaryDisplay = () => big;
    electron.screen.getDisplayNearestPoint = () => small;
  });
  assert.strictEqual(s.height, 672);
});

test('if the screen cannot be asked, or answers nonsense, the usual size is used and nothing throws', () => {
  const usual = [940, 700];
  const broken = [
    (e) => { e.screen.getCursorScreenPoint = () => { throw new Error('no pointer'); }; },
    (e) => { delete e.screen; },
    (e) => { e.screen = null; },
    (e) => { e.screen.getDisplayNearestPoint = () => null; e.screen.getPrimaryDisplay = () => null; },
    (e) => { e.screen.getDisplayNearestPoint = () => ({}); },
    (e) => { e.screen.getDisplayNearestPoint = () => ({ workArea: { width: 0, height: 0 } }); },
    (e) => { e.screen.getDisplayNearestPoint = () => ({ workArea: { width: NaN, height: undefined } }); },
    (e) => { e.screen.getDisplayNearestPoint = () => ({ workArea: { width: -5, height: -5 } }); },
    (e) => { e.screen.getDisplayNearestPoint = () => ({ workArea: { width: 'wide', height: '768' } }); },
  ];
  for (const [i, tweak] of broken.entries()) {
    const s = sizeOn({ x: 0, y: 0, width: 1920, height: 1080 }, tweak);
    assert.deepStrictEqual([s.width, s.height], usual, `case ${i}`);
  }
});

test('the window starts in the colour of the theme it will show, so there is no flash while the page loads', () => {
  const dark = rig(); dark.electron.nativeTheme.shouldUseDarkColors = true;
  assert.strictEqual(dark.sw.open().opts.backgroundColor, BACKGROUND_DARK);
  const light = rig(); light.electron.nativeTheme.shouldUseDarkColors = false;
  assert.strictEqual(light.sw.open().opts.backgroundColor, BACKGROUND_LIGHT);
  const unknown = rig(); delete unknown.electron.nativeTheme;
  assert.strictEqual(unknown.sw.open().opts.backgroundColor, BACKGROUND_DARK);
});

test('those two colours are exactly the page\'s own background colours', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/settings/settings.css'), 'utf8');
  const bgs = [...css.matchAll(/--bg:\s*(#[0-9a-f]{6});/gi)].map((m) => m[1].toLowerCase());
  assert.deepStrictEqual(bgs, [BACKGROUND_DARK, BACKGROUND_LIGHT], 'dark first, then the light override');
});

// ---------------------------------------------------------------- the new window must take the keyboard

// Measured on a real GNOME Shell: a window opened by a click in ANOTHER of the app's windows (the island's gear) was not given
// the keyboard - the desktop marked it "wants attention" and left the island focused. Asking again once the window is mapped
// (ready-to-show) and loaded works; asking only at creation does not.
test('open() asks the desktop for the keyboard at once, and again when the window is ready and when the page has loaded', () => {
  const { sw } = rig();
  const win = sw.open();
  assert.strictEqual(win._focused, true, 'at creation');
  win._focused = false; for (const f of win._listeners['ready-to-show'] || []) f();
  assert.strictEqual(win._focused, true, 'when ready-to-show fires');
  win._focused = false; win.webContents.emit('did-finish-load');
  assert.strictEqual(win._focused, true, 'when the page has loaded');
});

test('a window that has been closed is never asked for the keyboard (the late events are harmless)', () => {
  const { sw } = rig();
  const win = sw.open();
  win._focused = false; win.destroy();
  assert.doesNotThrow(() => { for (const f of win._listeners['ready-to-show'] || []) f(); win.webContents.emit('did-finish-load'); });
  assert.strictEqual(win._focused, false);
});
