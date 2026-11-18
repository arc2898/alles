'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runningBackend, placementHonoured, PLATFORMS, MEASURED_DEFAULT_MAJORS } = require('../src/main/platform');

/**
 * Which window system ALLES is RUNNING on. This file used to CHOOSE one and ask Electron for it - and measured on a real
 * GNOME Shell that did nothing: Chromium picks once, before any JavaScript runs, so the window stayed X11 while the log
 * claimed Wayland. So now it only REPORTS, and the tests pin that it reports what the measurements showed.
 */

const GNOME_WAYLAND = { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0', XDG_SESSION_TYPE: 'wayland' };
const E33 = '33.4.11';

test('MEASURED: Electron 33 on a Wayland desktop with XWayland, started plainly, is an X11 client', () => {
  assert.deepStrictEqual(runningBackend({ env: GNOME_WAYLAND, electronVersion: E33 }), { platform: 'x11', reason: 'electron-default', session: 'wayland', xAvailable: true });
});

test('a plain X11 desktop is X11', () => {
  assert.deepStrictEqual(runningBackend({ env: { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' }, electronVersion: E33 }), { platform: 'x11', reason: 'electron-default', session: 'x11', xAvailable: true });
});

test('a version nobody measured is NOT guessed at - Electron has been moving towards native Wayland by default', () => {
  for (const v of ['34.0.0', '38.1.2', '40.0.0', '1.2.3', '', undefined, null, 'banana']) {
    const r = runningBackend({ env: GNOME_WAYLAND, electronVersion: v });
    assert.strictEqual(r.platform, null, String(v));
    assert.strictEqual(r.reason, 'unmeasured-electron', String(v));
  }
  assert.deepStrictEqual(MEASURED_DEFAULT_MAJORS, [33], 'extend this only after measuring the new version on a real desktop');
});

test('no X11 display on offer: the default cannot be said (it would not even start on 33), the report says why', () => {
  assert.deepStrictEqual(runningBackend({ env: { WAYLAND_DISPLAY: 'wayland-0' }, electronVersion: E33 }), { platform: null, reason: 'no-x-display', session: 'wayland', xAvailable: false });
  assert.deepStrictEqual(runningBackend({ env: {}, electronVersion: E33 }), { platform: null, reason: 'no-x-display', session: '', xAvailable: false });
});

test('a choice made on the command line is what is running - whatever the desktop or the version', () => {
  for (const v of [E33, '40.0.0', '']) {
    assert.deepStrictEqual(runningBackend({ env: GNOME_WAYLAND, explicit: 'wayland', electronVersion: v }), { platform: 'wayland', reason: 'command-line', session: 'wayland', xAvailable: true }, v);
    assert.deepStrictEqual(runningBackend({ env: GNOME_WAYLAND, explicit: 'x11', electronVersion: v }), { platform: 'x11', reason: 'command-line', session: 'wayland', xAvailable: true }, v);
  }
  assert.strictEqual(runningBackend({ env: GNOME_WAYLAND, explicit: ' Wayland ' }).platform, 'wayland', 'case and spaces do not matter');
});

test('a command-line choice of something else (headless, drm) or a bare switch is reported as "not known", not as X11 or Wayland', () => {
  for (const given of ['headless', 'drm', true, 'banana']) {
    const r = runningBackend({ env: GNOME_WAYLAND, explicit: given, electronVersion: E33 });
    assert.strictEqual(r.platform, null, String(given)); assert.strictEqual(r.reason, 'command-line', String(given));
  }
});

test('an empty --ozone-platform is not a choice', () => {
  assert.strictEqual(runningBackend({ env: GNOME_WAYLAND, explicit: '', electronVersion: E33 }).reason, 'electron-default');
  assert.strictEqual(runningBackend({ env: GNOME_WAYLAND, explicit: false, electronVersion: E33 }).reason, 'electron-default');
});

test('the old escape hatch is gone: ALLES_OZONE_PLATFORM changes nothing, because asking from inside the app never worked', () => {
  const r = runningBackend({ env: { ...GNOME_WAYLAND, ALLES_OZONE_PLATFORM: 'wayland' }, electronVersion: E33 });
  assert.strictEqual(r.platform, 'x11');
});

test('the session is worked out from what the desktop announces, case and spaces aside', () => {
  assert.strictEqual(runningBackend({ env: { XDG_SESSION_TYPE: ' WAYLAND ', DISPLAY: ':0' }, electronVersion: E33 }).session, 'wayland');
  assert.strictEqual(runningBackend({ env: { WAYLAND_DISPLAY: 'w', DISPLAY: ':0' }, electronVersion: E33 }).session, 'wayland');
  assert.strictEqual(runningBackend({ env: { DISPLAY: ':1' }, electronVersion: E33 }).session, 'x11');
  assert.strictEqual(runningBackend({ env: {} }).session, '');
});

test('odd input never throws', () => {
  for (const junk of [null, undefined, 5, 'x', []]) assert.doesNotThrow(() => runningBackend({ env: junk, electronVersion: E33 }), String(junk));
  assert.doesNotThrow(() => runningBackend());
  assert.strictEqual(runningBackend().platform, null);
});

test('only words that matter can ever be reported', () => {
  assert.deepStrictEqual(PLATFORMS, ['x11', 'wayland']);
  for (const env of [{}, GNOME_WAYLAND, { DISPLAY: ':0' }, { WAYLAND_DISPLAY: 'w' }]) for (const explicit of [false, 'x11', 'wayland', 'headless']) {
    const r = runningBackend({ env, explicit, electronVersion: E33 });
    assert.ok(r.platform === null || PLATFORMS.includes(r.platform), JSON.stringify(r));
  }
});

// ---------------------------------------------------------------- will the pill be put where it is asked?

test('placementHonoured: yes on X11, no on native Wayland, unknown when nobody can say', () => {
  assert.strictEqual(placementHonoured({ platform: 'x11' }), true);
  assert.strictEqual(placementHonoured({ platform: 'wayland' }), false);
  assert.strictEqual(placementHonoured({ platform: null }), null);
  for (const junk of [null, undefined, {}, 5, 'x11', { platform: 'auto' }]) assert.strictEqual(placementHonoured(junk), null, JSON.stringify(junk));
});

// ---------------------------------------------------------------- the pins that keep the measured lesson

test('NOTHING in the app asks Electron for a window system from JavaScript again (it is too late and does nothing)', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(path.join(__dirname, '../src')).filter((p) => /\.(c?js|html)$/.test(p))) {
    const text = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(text.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ''), /appendSwitch\(\s*['"]ozone-platform/, `${path.relative(path.join(__dirname, '..'), f)} must not try to choose the window system`);
  }
});
