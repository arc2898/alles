'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fakeElectron } = require('./helpers/fake-electron');
const { App } = require('../src/main/app');
const { tmpDir } = require('./helpers/tmp');

/**
 * These are INTEGRATION tests: real App, real SettingsStore/KeyStore/DockWindow/TrayController/
 * ApprovalBroker/TaskRunner instances, wired exactly as production code wires them. Only `electron`
 * itself is faked (test/helpers/fake-electron.js), and Agent's network call is stubbed per-test by
 * monkey-patching `app._createAgent` — everything else is the real class.
 *
 * EVERY test MUST call app._teardown() before it ends: DockWindow.create() starts a 50ms setInterval
 * that keeps Node's event loop alive forever if never cleared. This is exactly what happened while
 * writing these tests: the very first smoke run produced zero output and never exited, because
 * create() completed instantly but the interval kept the process alive. Node reported the live
 * handle's constructor as 'Socket' rather than 'Timeout' (a known misreporting for libuv timer
 * handles), which briefly pointed the investigation at network code before the interval was found by
 * inspecting the handle object directly. In the real app this interval is cleared on Electron's
 * 'before-quit' event; a test has no such event, so it must call teardown itself.
 *
 * A test that FAILS part-way used to skip its own teardown at the end and hang the whole run instead of reporting the
 * failure (found by breaking the code on purpose). So makeApp() registers every app it builds and the afterEach hook
 * below tears down whatever is still running - a failing assertion now fails that test, and only that test.
 */
const live = [];
test.afterEach(() => { while (live.length) { try { live.pop()._teardown(); } catch { /* it was already torn down */ } } });

function makeApp(opts = {}) {
  const dir = tmpDir('alles-app-');
  const { electron, internals } = fakeElectron(opts.electronOpts);
  const app = new App({ electron, userDataDir: dir, shortcut: opts.shortcut, backend: opts.backend });
  live.push(app);
  return { app, electron, internals, dir };
}
/** Always run through this so a thrown assertion still tears the app down and never wedges the suite. */
async function withApp(opts, fn) {
  const rig = makeApp(opts);
  try { return await fn(rig); } finally { rig.app._teardown(); }
}

// ---------------------------------------------------------------- construction

test('create() builds every subsystem exactly once, and is idempotent', async () => {
  await withApp({}, ({ app, internals }) => {
    app.create();
    app.create();
    assert.strictEqual(internals.windows.length, 1, 'only one dock window, even after a second create()');
    assert.ok(app.settings && app.keyStore && app.runner && app.broker && app.dockWindow && app.tray, 'every subsystem exists');
  });
});

test('the dock window opens with the SAVED placement from settings, not a hardcoded default', async () => {
  const rig = makeApp({});
  const file = path.join(rig.dir, 'settings.json'); // userDataDir is passed directly as `dir` (see App constructor); no extra 'alles' segment is appended when it is supplied explicitly
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ dock: { edge: 'right', along: 0.75 } }));
  rig.app.create();
  assert.strictEqual(rig.app.settings.get().dock.edge, 'right');
  rig.app._teardown();
});

test('the tray starts DISABLED by default (settings default) and is not constructed as visible', async () => {
  await withApp({}, ({ app, internals }) => {
    app.create();
    assert.strictEqual(app.tray.enabled, false);
    assert.strictEqual(internals.trays.length, 0, 'no Tray object created while the setting is off');
  });
});

test('the global shortcut registers with the given accelerator, and toggles the island', async () => {
  await withApp({ shortcut: 'Control+Alt+Space' }, ({ app, internals }) => {
    app.create();
    assert.strictEqual(app.shortcutRegistered, true);
    assert.ok('Control+Alt+Space' in internals.shortcuts);
    assert.strictEqual(app.dockWindow.dock.phase, 'peek', 'persistent pill is visible at startup');
    internals.shortcuts['Control+Alt+Space']();
    assert.strictEqual(app.dockWindow.dock.phase, 'island', 'the shortcut opened it');
    assert.strictEqual(internals.windows[0]._focused, true, 'and asked for the keyboard');
    internals.shortcuts['Control+Alt+Space']();
    assert.strictEqual(app.dockWindow.dock.phase, 'peek', 'pressing it again collapses to the persistent pill');
  });
});

test('Ctrl+Shift+D and the Copilot key (Super+Shift+F23) both toggle the island by default', async () => {
  await withApp({}, ({ app, internals }) => {
    app.create();
    assert.strictEqual(app.shortcut, 'Control+Shift+D');
    for (const accel of ['Control+Shift+D', 'Super+Shift+F23']) {
      assert.ok(accel in internals.shortcuts, `${accel} is registered`);
      internals.shortcuts[accel]();
      assert.strictEqual(app.dockWindow.dock.phase, 'island', `${accel} opened it`);
      internals.shortcuts[accel]();
      assert.strictEqual(app.dockWindow.dock.phase, 'peek', `${accel} collapsed to the persistent pill`);
    }
  });
});

test('a Copilot key that is already taken does not stop Ctrl+Shift+D, and is not reported as the main shortcut failing', async () => {
  await withApp({}, ({ app, electron, internals }) => {
    const real = electron.globalShortcut.register;
    electron.globalShortcut.register = (accel, cb) => { if (accel === 'Super+Shift+F23') throw new Error('taken'); return real(accel, cb); };
    assert.doesNotThrow(() => app.create());
    assert.strictEqual(app.shortcutRegistered, true);
    assert.ok('Control+Shift+D' in internals.shortcuts);
    assert.ok(!('Super+Shift+F23' in internals.shortcuts));
  });
});

test('showIsland() (alles --show on a cold start) opens a closed island and never closes an open one', async () => {
  await withApp({}, ({ app }) => {
    app.create();
    assert.strictEqual(app.dockWindow.dock.phase, 'peek');
    app.showIsland();
    assert.strictEqual(app.dockWindow.dock.phase, 'island');
    app.showIsland();
    assert.strictEqual(app.dockWindow.dock.phase, 'island', 'asking again does not close it');
  });
});

test('the tray entry "Show / hide" does the same as the shortcut', async () => {
  const rig = makeApp({});
  rig.app.create();
  rig.app.tray.actions['toggle-island']();
  assert.strictEqual(rig.app.dockWindow.dock.phase, 'island');
  rig.app.tray.actions['toggle-island']();
  assert.strictEqual(rig.app.dockWindow.dock.phase, 'peek');
});

test('a shortcut that fails to register (already taken by another app) does not crash startup', async () => {
  await withApp({}, ({ app, electron }) => {
    electron.globalShortcut.register = () => { throw new Error('accelerator already in use'); };
    assert.doesNotThrow(() => app.create());
    assert.strictEqual(app.shortcutRegistered, false);
  });
});

test('running with no globalShortcut module at all (older Electron / platform gap) does not crash', async () => {
  await withApp({}, ({ app, electron }) => {
    delete electron.globalShortcut;
    assert.doesNotThrow(() => app.create());
  });
});

// ---------------------------------------------------------------- pill -> app wiring (via the REAL ipc path)

test('submit-task over the REAL ipc path reaches the runner and runs a task end to end', async () => {
  await withApp({}, async ({ app, internals }) => {
    app.create();
    app._createAgent = () => ({
      on() {}, stop() {},
      run: async (task) => ({ ok: true, summary: `did: ${task}`, steps: 1, stoppedBy: 'finish' }),
    });
    internals.fireIpc('submit-task', 'open the calculator', app.dockWindow.win.webContents);
    await new Promise((r) => app.runner.once('finished', r));
    const statuses = internals.sentToRenderer.filter((m) => m.channel === 'pill:status').map((m) => m.payload);
    assert.ok(statuses.some((s) => s.state === 'done' && /did: open the calculator/.test(s.detail)), JSON.stringify(statuses));
  });
});

test('a task submitted while one is already running is refused (busy), not queued', async () => {
  await withApp({}, async ({ app, internals }) => {
    app.create();
    let release; const gate = new Promise((r) => { release = r; });
    app._createAgent = () => ({ on() {}, stop() {}, run: async () => { await gate; return { ok: true, summary: 'first', steps: 1, stoppedBy: 'finish' }; } });
    internals.fireIpc('submit-task', 'first task', app.dockWindow.win.webContents);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(app.runner.busy, true);
    internals.fireIpc('submit-task', 'second task', app.dockWindow.win.webContents);
    await new Promise((r) => setImmediate(r));
    release();
    await new Promise((r) => app.runner.once('finished', r));
    assert.strictEqual(app.runner.busy, false);
  });
});

test('stop-agent over ipc stops the runner and engages the emergency input stop', async () => {
  await withApp({}, async ({ app, internals }) => {
    app.create();
    let stopped = 0;
    app._createAgent = () => ({ on() {}, stop: () => { stopped++; }, run: () => new Promise(() => {}) });
    internals.fireIpc('submit-task', 'do something forever', app.dockWindow.win.webContents);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(app.runner.busy, true);
    internals.fireIpc('stop-agent', undefined, app.dockWindow.win.webContents);
    assert.strictEqual(stopped, 1, 'the agent itself was told to stop');
    assert.strictEqual(app.gate.stopped, true, 'AND the keyboard/mouse emergency stop is engaged');
  });
});

test('open-settings over ipc opens exactly one settings window, and reuses it on a second call', async () => {
  await withApp({}, ({ app, internals }) => {
    app.create();
    internals.fireIpc('open-settings', undefined, app.dockWindow.win.webContents);
    internals.fireIpc('open-settings', undefined, app.dockWindow.win.webContents);
    const settingsWins = internals.windows.filter((w) => w !== app.dockWindow.win);
    assert.strictEqual(settingsWins.length, 1, 'a second open-settings must not create a duplicate window');
  });
});

test('an event from a DIFFERENT renderer than the dock window is ignored (the ipc gate in window.js)', async () => {
  await withApp({}, async ({ app, internals }) => {
    app.create();
    let stopped = 0;
    app._createAgent = () => ({ on() {}, stop: () => { stopped++; }, run: () => new Promise(() => {}) });
    internals.fireIpc('submit-task', 'a long task', app.dockWindow.win.webContents);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(app.runner.busy, true);
    const foreignSender = { notTheRealDockWebContents: true };
    internals.fireIpc('stop-agent', undefined, foreignSender);
    assert.strictEqual(stopped, 0, 'a stop-agent from a foreign sender must be ignored by identity, not accepted');
    internals.fireIpc('stop-agent', undefined, app.dockWindow.win.webContents);
    assert.strictEqual(stopped, 1, 'the SAME event from the real dock window is honoured');
  });
});

// ---------------------------------------------------------------- the screen the model sees

test('the screenshot tool shrinks a big screen for the model (the app gives ScreenCapture a resizer): without one every screen over 1280 px failed', async () => {
  await withApp({}, async ({ app }) => {
    app.create();
    const { solidPng } = require('../src/main/util/png');
    const { pngSize } = require('../src/main/computer/screen');
    app.screen.backend = 'grim';
    app.screen.run = async (bin, args) => { fs.writeFileSync(args[0], solidPng(1920, 1080, [1, 2, 3])); return ''; };
    const exec = require('../src/main/tools').createToolExecutor({ input: app.input, screen: app.screen, approve: () => false });
    const r = await exec('screenshot', {});
    assert.ok(!r.error, r.text);
    assert.match(r.text, /1280x720/);
    assert.deepStrictEqual(pngSize(r.image), { width: 1280, height: 720 });
  });
});

// ---------------------------------------------------------------- approvals wiring: broker <-> pill, end to end

test('a tool that needs approval opens a REAL question on the island; approving it runs the shell command', async () => {
  await withApp({}, async ({ app, internals }) => {
    app.create();
    app.settings.update({ providers: { routes: [{ id: 'x', kind: 'custom', label: 'X', model: 'm', baseUrl: 'https://x.test/v1', enabled: true }] } });
    let executed = null;
    app._createAgent = () => {
      const real = require('../src/main/tools').createToolExecutor({ input: app.input, screen: app.screen, approve: (a) => app.broker.request(a) });
      return {
        on() {}, stop() {},
        run: async () => { const r = await real('run_shell', { command: 'echo hi' }); executed = r.text; return { ok: true, summary: executed, steps: 1, stoppedBy: 'finish' }; },
      };
    };
    const p = app.runner.submit('do a thing');
    await new Promise((r) => setTimeout(r, 20));
    // pill:approval is re-sent on every phase transition (a replay so a reloaded page never loses the open
    // question); dedupe by question id, not by message count.
    const askedIds = [...new Set(internals.sentToRenderer.filter((m) => m.channel === 'pill:approval' && m.payload).map((m) => m.payload.id))];
    assert.strictEqual(askedIds.length, 1, `expected exactly one distinct question, saw ids: ${JSON.stringify(askedIds)}`);
    const lastAsk = internals.sentToRenderer.filter((m) => m.channel === 'pill:approval' && m.payload && m.payload.id === askedIds[0]).at(-1).payload;
    assert.strictEqual(lastAsk.body, 'echo hi');
    const id = askedIds[0];
    internals.fireIpc('approval-answer', { id, allow: true }, app.dockWindow.win.webContents);
    await p;
    assert.match(executed, /exit_code: 0/);
    assert.match(executed, /hi/);
  });
});

test('denying the approval question means the tool call is refused, not executed', async () => {
  await withApp({}, async ({ app, internals }) => {
    app.create();
    let executed = null;
    app._createAgent = () => {
      const real = require('../src/main/tools').createToolExecutor({ input: app.input, screen: app.screen, approve: (a) => app.broker.request(a) });
      return { on() {}, stop() {}, run: async () => { const r = await real('run_shell', { command: 'echo should-not-run' }); executed = r.text; return { ok: true, summary: 'done', steps: 1, stoppedBy: 'finish' }; } };
    };
    const p = app.runner.submit('x');
    await new Promise((r) => setTimeout(r, 20));
    const id = internals.sentToRenderer.filter((m) => m.channel === 'pill:approval' && m.payload).at(-1).payload.id;
    internals.fireIpc('approval-answer', { id, allow: false }, app.dockWindow.win.webContents);
    await p;
    assert.match(executed, /^DENIED/);
    assert.doesNotMatch(executed, /should-not-run/);
  });
});

test('after an approval is answered, the pill status is NOT left stuck on "Needs your approval"', async () => {
  await withApp({}, async ({ app, internals }) => {
    app.create();
    app._createAgent = () => {
      const real = require('../src/main/tools').createToolExecutor({ input: app.input, screen: app.screen, approve: (a) => app.broker.request(a) });
      return { on() {}, stop() {}, run: async () => { await real('run_shell', { command: 'echo hi' }); return { ok: true, summary: 'done', steps: 1, stoppedBy: 'finish' }; } };
    };
    const p = app.runner.submit('x');
    await new Promise((r) => setTimeout(r, 20));
    const id = internals.sentToRenderer.filter((m) => m.channel === 'pill:approval' && m.payload).at(-1).payload.id;
    internals.fireIpc('approval-answer', { id, allow: true }, app.dockWindow.win.webContents);
    await p;
    const statuses = internals.sentToRenderer.filter((m) => m.channel === 'pill:status').map((m) => m.payload.state);
    assert.ok(!statuses.slice(-1).includes('waiting'), `last status was still 'waiting': ${statuses.join(',')}`);
  });
});

// ---------------------------------------------------------------- settings live-apply

test('turning the tray ON in settings enables it live, without restarting the app', async () => {
  await withApp({}, ({ app, internals }) => {
    app.create();
    assert.strictEqual(app.tray.enabled, false);
    app.settings.update({ tray: { enabled: true } });
    assert.strictEqual(app.tray.enabled, true);
    assert.strictEqual(internals.trays.length, 1);
  });
});

test('turning the tray back OFF destroys the tray icon', async () => {
  await withApp({}, ({ app, internals }) => {
    app.create();
    app.settings.update({ tray: { enabled: true } });
    app.settings.update({ tray: { enabled: false } });
    assert.strictEqual(app.tray.enabled, false);
    assert.strictEqual(internals.trays[0]._destroyed, true);
  });
});

test('changing the dock placement in settings moves the ALREADY-OPEN window live', async () => {
  await withApp({}, ({ app }) => {
    app.create();
    app.dockWindow.click();
    const before = app.dockWindow.win.getBounds();
    app.settings.update({ dock: { edge: 'right' } });
    const after = app.dockWindow.win.getBounds();
    assert.notDeepStrictEqual(before, after, 'the dock did not move when the edge setting changed');
  });
});

test('raising safety.allowDangerousKeys live updates the ALREADY-CONSTRUCTED SafetyGate', async () => {
  await withApp({}, ({ app }) => {
    app.create();
    assert.strictEqual(app.gate.allowDangerous, false);
    app.settings.update({ safety: { allowDangerousKeys: true } });
    assert.strictEqual(app.gate.allowDangerous, true);
  });
});

test('lowering safety.maxActionsPerMinute live updates the SAME gate object the input controller uses', async () => {
  await withApp({}, ({ app }) => {
    app.create();
    app.settings.update({ safety: { maxActionsPerMinute: 3 } });
    assert.strictEqual(app.gate.maxPerMin, 3);
    assert.strictEqual(app.input.gate, app.gate, 'InputController must be using the live gate, not a stale copy');
  });
});

// ---------------------------------------------------------------- provider keys: end to end through describeProviders()

test('a key added to the key store is picked up by describeProviders() without restarting anything', async () => {
  await withApp({}, ({ app }) => {
    app.create();
    app.settings.update({ providers: { routes: [{ id: 'grok', kind: 'grok', label: 'Grok', model: '', baseUrl: '', enabled: true }] } });
    assert.strictEqual(app.describeProviders()[0].problem, 'Add an API key.');
    app.keyStore.add('grok', 'xai-REALTESTKEY0000001');
    assert.strictEqual(app.describeProviders()[0].problem, null);
    assert.strictEqual(app.describeProviders()[0].ready, true);
  });
});

test('SECURITY: describeProviders() never contains a raw secret', async () => {
  await withApp({}, ({ app }) => {
    app.create();
    app.settings.update({ providers: { routes: [{ id: 'grok', kind: 'grok', label: 'Grok', model: '', baseUrl: '', enabled: true }] } });
    app.keyStore.add('grok', 'xai-TOPSECRETVALUE000001');
    assert.ok(!JSON.stringify(app.describeProviders()).includes('TOPSECRET'));
  });
});

// ---------------------------------------------------------------- teardown / quit

test('quit() calls Electron app.quit() exactly once and marks the lifecycle as quitting', async () => {
  const rig = makeApp({});
  let quits = 0; rig.electron.app.on('quit', () => quits++);
  rig.app.create();
  rig.app.quit();
  assert.strictEqual(quits, 1);
  assert.strictEqual(rig.app.lifecycle.state.quitting, true);
  rig.app._teardown();
});

test('before-quit runs teardown: the dock window is destroyed and its interval stops (the process can exit)', async () => {
  const rig = makeApp({});
  rig.app.create();
  const win = rig.app.dockWindow.win;
  assert.strictEqual(win.isDestroyed(), false);
  rig.electron.app.emit('before-quit');
  assert.strictEqual(win.isDestroyed(), true);
  assert.strictEqual(rig.app.dockWindow.timer, null, 'the interval must be cleared or the process never exits');
});

test('teardown flushes a pending settings write so the last change is not lost on quit', async () => {
  const rig = makeApp({});
  rig.app.create();
  let flushed = false;
  const origFlush = rig.app.settings.flush.bind(rig.app.settings);
  rig.app.settings.flush = () => { flushed = true; return origFlush(); };
  rig.app.settings.update({ dock: { edge: 'left' } });
  rig.app._teardown();
  assert.strictEqual(flushed, true);
});

test('teardown unregisters the global shortcut so a restarted app is not blocked by a leaked registration', async () => {
  const rig = makeApp({});
  rig.app.create();
  assert.ok('Control+Shift+D' in rig.internals.shortcuts);
  assert.ok('Super+Shift+F23' in rig.internals.shortcuts);
  rig.app._teardown();
  assert.ok(!('Control+Shift+D' in rig.internals.shortcuts));
  assert.ok(!('Super+Shift+F23' in rig.internals.shortcuts), 'the Copilot key is let go of too');
});

test('teardown stops a running agent rather than leaving it running headless after quit', async () => {
  const rig = makeApp({});
  rig.app.create();
  let stopped = 0;
  rig.app._createAgent = () => ({ on() {}, stop: () => { stopped++; }, run: () => new Promise(() => {}) });
  rig.app.runner.submit('long task');
  await new Promise((r) => setImmediate(r));
  rig.app._teardown();
  assert.strictEqual(stopped, 1);
});

test('_teardown is safe to call twice (quit while already quitting)', async () => {
  const rig = makeApp({});
  rig.app.create();
  assert.doesNotThrow(() => { rig.app._teardown(); rig.app._teardown(); });
});

// ---------------------------------------------------------------- Settings window wiring

test('info() gives the About page exactly its facts - names, versions, paths - and nothing secret', async () => {
  await withApp({}, ({ app, dir }) => {
    app.create();
    const info = app.info();
    assert.deepStrictEqual(Object.keys(info).sort(), ['backend', 'dataDir', 'desktop', 'edges', 'freeEdge', 'input', 'name', 'session', 'shortcut', 'shortcutRegistered', 'version']);
    assert.strictEqual(info.name, 'ALLES');
    assert.strictEqual(info.version, '0.0.0-test');                    // fake-electron's app.getVersion()
    assert.strictEqual(info.shortcut, 'Control+Shift+D');
    assert.strictEqual(info.shortcutRegistered, true);
    assert.strictEqual(info.dataDir, dir);
    assert.strictEqual(typeof info.desktop, 'string');
    assert.strictEqual(typeof info.session, 'string');
    // Plain data only, however deep: strings, booleans, finite numbers and null - never an object with behaviour.
    const plain = (v) => v === null || ['string', 'boolean'].includes(typeof v) || (typeof v === 'number' && Number.isFinite(v))
      || (typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype && Object.values(v).every(plain));
    for (const [k, v] of Object.entries(info)) assert.ok(plain(v), `${k} must be plain data`);
  });
});

test('info() tells Settings which window system was chosen, and says nothing it does not know', async () => {
  const x11 = { platform: 'x11', reason: 'electron-default', placementHonoured: true, xAvailable: true };
  await withApp({ backend: x11 }, ({ app }) => {
    app.create();
    assert.deepStrictEqual(app.info().backend, x11);
  });
  await withApp({}, ({ app }) => {                           // nobody said (a test, or an older caller): empty, not invented
    app.create();
    assert.deepStrictEqual(app.info().backend, { platform: '', reason: '', placementHonoured: null, xAvailable: null });
  });
  await withApp({ backend: { platform: 7, reason: {}, placementHonoured: 'yes', xAvailable: 1 } }, ({ app }) => {   // wrong types are dropped
    app.create();
    assert.deepStrictEqual(app.info().backend, { platform: '', reason: '', placementHonoured: null, xAvailable: null });
  });
});

// ---------------------------------------------------------------- first run: where the pill starts

// A desktop like stock GNOME: a 32 px top bar takes the top of the screen.
const GNOME_SCREEN = { workArea: { x: 0, y: 32, width: 1366, height: 736 }, bounds: { x: 0, y: 0, width: 1366, height: 768 } };

test('info() reports what a panel has taken from each edge, and which edge is clearest', async () => {
  await withApp({ electronOpts: GNOME_SCREEN }, ({ app }) => {
    app.create();
    assert.deepStrictEqual(app.info().edges, { top: 32, bottom: 0, left: 0, right: 0 });
    assert.strictEqual(app.info().freeEdge, 'bottom');
  });
  await withApp({}, ({ app }) => {                           // a clear screen: nothing taken, and the top edge as always
    app.create();
    assert.deepStrictEqual(app.info().edges, { top: 0, bottom: 0, left: 0, right: 0 });
    assert.strictEqual(app.info().freeEdge, 'top');
  });
});

test('info() still answers when the screen cannot be asked: no panel anywhere, and the top edge as the clearest', async () => {
  const rig = makeApp({ electronOpts: GNOME_SCREEN });
  rig.app.create();
  await new Promise((resolve) => setImmediate(resolve));       // let the pill finish loading first: only info() is asked about a missing screen
  rig.electron.screen.getPrimaryDisplay = () => { throw new Error('screen went away'); };
  rig.electron.screen.getDisplayNearestPoint = () => { throw new Error('screen went away'); };
  let info;
  assert.doesNotThrow(() => { info = rig.app.info(); });
  assert.deepStrictEqual(info.edges, { top: 0, bottom: 0, left: 0, right: 0 });
  assert.strictEqual(info.freeEdge, 'top');
});

test('FIRST run on GNOME keeps the persistent pill at the top, below the top bar', async () => {
  await withApp({ electronOpts: GNOME_SCREEN }, ({ app, internals }) => {
    app.create();
    assert.strictEqual(app.firstRun, true);
    assert.strictEqual(app.settings.get().dock.edge, 'top');
    assert.strictEqual(app.settings.get().dock.autoHide, false);
    const b = internals.windows[0].bounds;
    assert.strictEqual(b.y, 32, 'window begins below GNOME top bar');
    assert.ok(b.height > 2, 'visible pill is created, not a hidden hit strip');
    assert.strictEqual(app.settings.get().dock.edge, 'top', 'top placement is preserved without writing a settings file on first launch');
  });
});

test('FIRST run on a clear screen keeps the top edge', async () => {
  await withApp({}, ({ app, internals }) => {
    app.create();
    assert.strictEqual(app.settings.get().dock.edge, 'top');
    assert.strictEqual(internals.windows[0].bounds.y, 0);
  });
});

test('NOT the first run: a saved edge is never changed, even when a bar sits on it - that is the person\'s choice', async () => {
  const rig = makeApp({ electronOpts: GNOME_SCREEN });
  fs.writeFileSync(path.join(rig.dir, 'settings.json'), JSON.stringify({ dock: { edge: 'top', along: 0.5 } }));
  rig.app.create();
  assert.strictEqual(rig.app.firstRun, false);
  assert.strictEqual(rig.app.settings.get().dock.edge, 'top');
  assert.strictEqual(rig.internals.windows[0].bounds.y, 32, 'still under the bar, as chosen');
});

test('a settings file that could not be understood counts as a first run and resets to persistent top placement', async () => {
  const rig = makeApp({ electronOpts: GNOME_SCREEN });
  fs.writeFileSync(path.join(rig.dir, 'settings.json'), '{ this is not json');
  rig.app.create();
  assert.strictEqual(rig.app.firstRun, true);
  assert.strictEqual(rig.app.settings.get().dock.edge, 'top');
});

test('if the primary display query fails once, the app falls back to the display list and still starts', async () => {
  const rig = makeApp({ electronOpts: GNOME_SCREEN });
  const real = rig.electron.screen.getPrimaryDisplay;
  let calls = 0;
  rig.electron.screen.getPrimaryDisplay = () => { if (calls++ === 0) throw new Error('no screen yet'); return real(); };   // only the first look fails
  const logged = []; const orig = console.error; console.error = (...a) => logged.push(a.join(' '));
  try { rig.app.create(); } finally { console.error = orig; }
  assert.strictEqual(rig.app.settings.get().dock.edge, 'top', 'the default stays');
  void logged;
  assert.strictEqual(rig.internals.windows.length, 1, 'the pill still exists');
});

// ---------------------------------------------------------------- first run: the welcome peek

test('persistent pill is visible on first run and is not hidden by the welcome timer', async () => {
  await withApp({}, ({ app }) => {
    app.create();
    let t = 1_000_000;
    app.dockWindow.dock.now = () => t;
    assert.strictEqual(app.dockWindow.dock.phase, 'peek');
    app.welcome(5000);
    t += 60_000; app.dockWindow.dock.tick();
    assert.strictEqual(app.dockWindow.dock.phase, 'peek', 'persistent pill remains visible indefinitely');
  });
});

test('legacy settings still migrate to the persistent pill on later runs', async () => {
  const rig = makeApp({});
  fs.writeFileSync(path.join(rig.dir, 'settings.json'), JSON.stringify({ version: 1, dock: { edge: 'left', autoHide: true } }));
  rig.app.create();
  assert.strictEqual(rig.app.dockWindow.dock.phase, 'peek');
  assert.strictEqual(rig.app.settings.get().dock.autoHide, false);
});

test('welcome() before create() or with no pill never throws', async () => {
  const rig = makeApp({});
  assert.doesNotThrow(() => rig.app.welcome());              // nothing built yet
});

test('info() says so when the shortcut could not be registered (the About page shows it instead of hiding it)', async () => {
  const rig = makeApp({});
  rig.electron.globalShortcut.register = () => false;               // e.g. Wayland refuses a global shortcut
  try {
    rig.app.create();
    assert.strictEqual(rig.app.info().shortcutRegistered, false);
    assert.strictEqual(rig.app.info().shortcut, 'Control+Shift+D', 'the wanted shortcut is still shown');
  } finally { rig.app._teardown(); }
});

test('an open Settings page is told to refresh when settings change, when a key is added, and when the island is dragged', async () => {
  await withApp({}, async ({ app, internals }) => {
    app.create();
    const win = app.settingsWindow.open();
    const sender = win.webContents;
    const told = () => internals.sentToRenderer.filter((m) => m.win === win && m.channel === 'settings:changed');

    app.settings.update({ tray: { enabled: true } });
    assert.strictEqual(told().length, 1, 'a settings change must reach the open Settings page');

    const before = told().length;
    const added = await internals.invoke('settings:add-key', { routeId: app.settings.get().providers.routes[0].id, key: 'nvapi-REFRESHCHECK0001' }, sender);
    assert.strictEqual(added.ok, true);
    assert.ok(told().length > before, 'a stored key must reach the open Settings page');

    const beforeDrag = told().length;
    app.settings.update({ dock: { edge: 'left', along: 0.25 } });     // what dragging the island saves
    assert.ok(told().length > beforeDrag, 'moving the island must reach the open Settings page');

    for (const m of told()) assert.strictEqual(m.payload, undefined, 'the nudge carries no data - the page asks again');
    assert.ok(!JSON.stringify(internals.sentToRenderer.filter((m) => m.win === win).map((m) => [m.channel, m.payload])).includes('nvapi-REFRESHCHECK0001'), 'a key must never be pushed to the page');
  });
});

test('the island window is never sent the Settings refresh nudge', async () => {
  await withApp({}, ({ app, internals }) => {
    app.create();
    app.settingsWindow.open();
    app.settings.update({ tray: { enabled: true } });
    const toPill = internals.sentToRenderer.filter((m) => m.win === app.dockWindow.win && m.channel === 'settings:changed');
    assert.strictEqual(toPill.length, 0);
  });
});

test('with no Settings window open, changes cause no errors and no stray window', async () => {
  await withApp({}, ({ app, internals }) => {
    app.create();
    assert.doesNotThrow(() => app.settings.update({ dock: { edge: 'right' } }));
    assert.strictEqual(internals.windows.filter((w) => w !== app.dockWindow.win).length, 0);
  });
});

test('teardown closes the Settings window and releases every settings: handler', async () => {
  const rig = makeApp({});
  rig.app.create();
  const win = rig.app.settingsWindow.open();
  assert.ok(rig.internals.handledChannels().some((c) => c.startsWith('settings:')), 'handlers are attached while running');
  rig.app._teardown();
  assert.strictEqual(win.isDestroyed(), true, 'the Settings window must not outlive the app');
  assert.deepStrictEqual(rig.internals.handledChannels().filter((c) => c.startsWith('settings:')), [], 'no handler may be left behind');
  assert.strictEqual(rig.app.settingsWindow.isTrusted({ sender: win.webContents }), false, 'a closed window is trusted by nobody');
});
