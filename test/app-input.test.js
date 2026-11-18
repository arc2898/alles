'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { fakeElectron } = require('./helpers/fake-electron');
const { App } = require('../src/main/app');
const { tmpDir } = require('./helpers/tmp');
const { fakeScreen } = require('./helpers/fake-computer');
const { buildToolSchemas } = require('../src/main/tools');
const { FallbackBackend } = require('../src/main/computer/select-backend');
const { YdotoolBackend } = require('../src/main/computer/ydotool-backend');
const { MutterBackend } = require('../src/main/computer/mutter-backend');

/**
 * How the app chooses, builds, hands over and lets go of the mouse/keyboard backend. Real App, real settings, runner and input
 * controller; only Electron and the backend itself are fakes, so nothing here touches a desktop.
 */

const GNOME = { XDG_CURRENT_DESKTOP: 'GNOME', XDG_SESSION_TYPE: 'wayland' };
const live = [];
test.afterEach(() => { while (live.length) { try { live.pop()._teardown(); } catch { /* already torn down */ } } });

/** A backend that records what the app does with it. */
function fakeBackend(name, info = {}) {
  return {
    name, resumed: 0, closed: 0, disposed: 0, cancelled: null, moves: [],
    infoValue: { name, label: `${name} backend`, unicode: false, scroll: true, drag: true, ...info },
    info() { return this.infoValue; },
    async capabilities() { return this.info(); },
    resume() { this.resumed++; }, close() { this.closed++; }, async dispose() { this.disposed++; },
    async moveBy(dx, dy) { this.moves.push([dx, dy]); },
  };
}

function rig({ env = GNOME, settings = null, info = {}, electronOpts } = {}) {
  const dir = tmpDir('alles-appin-');
  if (settings) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
  const { electron, internals } = fakeElectron(electronOpts);
  const made = [];
  const makeInputBackend = (o) => { const b = fakeBackend(`b${made.length + 1}`, info); made.push({ o, b }); return b; };
  const app = new App({ electron, userDataDir: dir, env, makeInputBackend });
  live.push(app);
  app.create();
  return { app, electron, internals, made, dir };
}

/** A task that runs until released; `stops` counts how often the agent was told to stop. */
function longTask(app) {
  let release; const held = new Promise((r) => { release = r; });
  const t = { stops: 0, release: () => release({ ok: true, summary: 'done', steps: 1, stoppedBy: 'finish' }) };
  app._createAgent = () => ({ on() {}, stop: () => { t.stops++; }, run: () => held });
  t.finished = new Promise((r) => app.runner.once('finished', r));
  t.started = app.runner.submit('a task');
  return t;
}
const tick = () => new Promise((r) => setImmediate(r));

// ------------------------------------------------------------------ choosing the backend

test('the backend is built from the saved choice and what the desktop is, with the clipboard and a stop callback', () => {
  const { app, electron, made } = rig();
  assert.strictEqual(made.length, 1);
  const o = made[0].o;
  assert.strictEqual(o.mode, 'auto');
  assert.strictEqual(o.desktop, 'gnome');
  assert.strictEqual(o.session, 'wayland');
  assert.strictEqual(o.clipboard, electron.clipboard, 'the real clipboard is what lets GNOME direct input enter any character');
  assert.strictEqual(typeof o.onUserStop, 'function');
  assert.strictEqual(typeof o.log, 'function');
  assert.strictEqual(app.input.backend, made[0].b);
});

test('a saved choice is passed on, and the desktop and session come from the environment given', () => {
  assert.strictEqual(rig({ settings: { input: { backend: 'ydotool' } } }).made[0].o.mode, 'ydotool');
  assert.strictEqual(rig({ settings: { input: { backend: 'gnome' } } }).made[0].o.mode, 'gnome');
  const kde = rig({ env: { XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' } }).made[0].o;
  assert.deepStrictEqual([kde.desktop, kde.session], ['kde', 'wayland']);
  const none = rig({ env: {} }).made[0].o;
  assert.deepStrictEqual([none.desktop, none.session], ['unknown', '']);
  assert.strictEqual(rig({ settings: { input: { backend: 'rubbish' } } }).made[0].o.mode, 'auto', 'a value nobody knows is the default');
});

test('without any injection, GNOME on Wayland gets GNOME direct input with ydotool behind it; KDE and X11 get ydotool', () => {
  const build = (env) => {
    const { electron } = fakeElectron();
    const app = new App({ electron, userDataDir: tmpDir('alles-appin-'), env });
    live.push(app); app.create();
    return app;
  };
  const g = build(GNOME);
  assert.ok(g.input.backend instanceof FallbackBackend);
  assert.ok(g.input.backend.primary instanceof MutterBackend && g.input.backend.secondary instanceof YdotoolBackend);
  assert.strictEqual(g.input.info().name, 'gnome');
  assert.strictEqual(g.input.info().unicode, true, 'the fake Electron has a clipboard');
  assert.ok(build({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' }).input.backend instanceof YdotoolBackend);
  assert.ok(build({ XDG_CURRENT_DESKTOP: 'GNOME', XDG_SESSION_TYPE: 'x11' }).input.backend instanceof YdotoolBackend);
});

test('the backend is told how to stop: its emergency-stop check follows the app\'s gate', () => {
  const { app, made } = rig();
  assert.strictEqual(made[0].b.cancelled(), false);
  app.gate.stop();
  assert.strictEqual(made[0].b.cancelled(), true);
});

// ------------------------------------------------------------------ a task's life

test('starting a task releases the emergency stop, including the backend\'s own', async () => {
  const { app, made } = rig();
  app.gate.stop();
  const t = longTask(app);
  await tick();
  assert.strictEqual(app.gate.stopped, false);
  assert.strictEqual(made[0].b.resumed, 1);
  t.release(); await t.finished;
});

test('when a task ends the backend is closed (GNOME\'s sharing indicator goes away) - not while it runs', async () => {
  const { app, made } = rig();
  const t = longTask(app);
  await tick();
  assert.strictEqual(made[0].b.closed, 0, 'still working: the session stays open');
  t.release(); await t.finished;
  assert.strictEqual(made[0].b.closed, 1);
});

test('a task that fails, or is stopped, closes it too', async () => {
  const { app, made } = rig();
  app._createAgent = () => ({ on() {}, stop() {}, run: async () => { throw new Error('boom'); } });
  await app.runner.submit('x');
  assert.strictEqual(made[0].b.closed, 1);
  let stop; app._createAgent = () => ({ on() {}, stop() { stop(); }, run: () => new Promise((r) => { stop = () => r({ ok: false, summary: 'Stopped by user', steps: 1, stoppedBy: 'user' }); }) });
  const p = app.runner.submit('y');
  await tick();
  app.runner.stop();
  await p;
  assert.strictEqual(made[0].b.closed, 2);
});

test('the person pressing Stop on GNOME\'s sharing indicator stops the running task, like the Stop button', async () => {
  const { app, made } = rig();
  const t = longTask(app);
  await tick();
  made[0].o.onUserStop();
  assert.strictEqual(t.stops, 1, 'the agent was told to stop');
  assert.strictEqual(app.gate.stopped, true, 'and the emergency stop is on');
  t.release(); await t.finished;
});

test('Stop on the indicator with no task running does nothing, and cannot throw into the backend', () => {
  const { app, made } = rig();
  assert.doesNotThrow(() => made[0].o.onUserStop());
  assert.strictEqual(app.gate.stopped, false, 'nothing was running: there is nothing to stop');
  app.runner.stop = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => made[0].o.onUserStop());
});

// ------------------------------------------------------------------ changing the choice in Settings

test('a new choice replaces the backend at once when idle, and the old one is let go of', () => {
  const { app, made } = rig();
  app.settings.update({ input: { backend: 'ydotool' } });
  assert.strictEqual(made.length, 2);
  assert.strictEqual(made[1].o.mode, 'ydotool');
  assert.strictEqual(app.input.backend, made[1].b);
  assert.strictEqual(made[0].b.disposed, 1);
  assert.strictEqual(made[1].b.disposed, 0);
  made[1].b.cancelled = made[1].b.cancelled;            // (set by the controller, not by the test)
  app.gate.stop();
  assert.strictEqual(made[1].b.cancelled(), true, 'the new one follows the emergency stop too');
  assert.strictEqual(app._inputPending, false);
});

test('a choice made DURING a task waits for it to end, so a held button is let go by the method that pressed it', async () => {
  const { app, made } = rig();
  const t = longTask(app);
  await tick();
  app.settings.update({ input: { backend: 'ydotool' } });
  assert.strictEqual(made.length, 1, 'nothing new built mid-task');
  assert.strictEqual(app.input.backend, made[0].b);
  assert.strictEqual(app.info().input.pending, true, 'Settings can say that it is waiting');
  assert.strictEqual(app.info().input.mode, 'ydotool', 'and what was chosen');
  t.release(); await t.finished;
  assert.strictEqual(made.length, 2);
  assert.strictEqual(made[1].o.mode, 'ydotool');
  assert.strictEqual(app.input.backend, made[1].b);
  assert.strictEqual(made[0].b.closed, 1, 'closed when the task ended');
  assert.strictEqual(made[0].b.disposed, 1, 'then replaced');
  assert.strictEqual(app.info().input.pending, false);
});

test('a choice changed twice during a task (and back to the first) ends up with the LAST one, built once', async () => {
  const { app, made } = rig();
  const t = longTask(app);
  await tick();
  app.settings.update({ input: { backend: 'ydotool' } });
  app.settings.update({ input: { backend: 'gnome' } });
  t.release(); await t.finished;
  assert.strictEqual(made.length, 2);
  assert.strictEqual(made[1].o.mode, 'gnome');
});

test('changing some OTHER setting does not rebuild the backend: a session in use is not thrown away for nothing', () => {
  const { app, made } = rig();
  app.settings.update({ tray: { enabled: true } });
  app.settings.update({ dock: { edge: 'left' } });
  app.settings.update({ safety: { maxActionsPerMinute: 10 } });
  app.settings.update({ agent: { maxSteps: 7 } });
  assert.strictEqual(made.length, 1);
  assert.strictEqual(made[0].b.disposed, 0);
  assert.strictEqual(app.input.backend, made[0].b);
});

test('a task that ends after the choice was applied does not rebuild it again', async () => {
  const { app, made } = rig();
  app.settings.update({ input: { backend: 'ydotool' } });
  const t = longTask(app);
  await tick(); t.release(); await t.finished;
  assert.strictEqual(made.length, 2);
});

test('the open Settings page is told when a waiting choice has been applied', async () => {
  const { app, internals, made } = rig();
  const win = app.settingsWindow.open();
  const told = () => internals.sentToRenderer.filter((m) => m.win === win && m.channel === 'settings:changed').length;
  const t = longTask(app);
  await tick();
  app.settings.update({ input: { backend: 'ydotool' } });
  const before = told();
  t.release(); await t.finished;
  assert.ok(told() > before, 'it refreshes to show what is now in use');
  assert.strictEqual(made.length, 2);
});

// ------------------------------------------------------------------ what Settings is told

test('info().input says what was chosen and what is in use, as plain data', () => {
  const { app } = rig({ info: { unicode: true, auto: true, fellBackBecause: null } });
  assert.deepStrictEqual(app.info().input, {
    mode: 'auto', name: 'b1', label: 'b1 backend', unicode: true, scroll: true, drag: true, auto: true, fellBackBecause: null, pending: false,
  });
});

test('info().input carries the reason when automatic mode gave up on GNOME direct input', () => {
  const { app, made } = rig();
  made[0].b.infoValue = { name: 'ydotool', label: 'ydotool (virtual keyboard and mouse)', unicode: false, scroll: true, drag: true, auto: true, fellBackBecause: 'PipeWire is not running' };
  const i = app.info().input;
  assert.strictEqual(i.name, 'ydotool');
  assert.strictEqual(i.fellBackBecause, 'PipeWire is not running');
  assert.strictEqual(i.unicode, false);
});

test('info().session is the session the app was started with - not whatever the surrounding process has', () => {
  const was = process.env.XDG_SESSION_TYPE;
  process.env.XDG_SESSION_TYPE = 'tty';
  try {
    assert.strictEqual(rig({ env: { XDG_CURRENT_DESKTOP: 'GNOME', XDG_SESSION_TYPE: 'wayland' } }).app.info().session, 'wayland');
    assert.strictEqual(rig({ env: { XDG_CURRENT_DESKTOP: 'GNOME', XDG_SESSION_TYPE: 'x11' } }).app.info().session, 'x11');
    assert.strictEqual(rig({ env: {} }).app.info().session, '');
  } finally { if (was === undefined) delete process.env.XDG_SESSION_TYPE; else process.env.XDG_SESSION_TYPE = was; }
});

test('info().input never throws and never passes on anything but strings and booleans', () => {
  const { app, made } = rig();
  made[0].b.info = () => { throw new Error('cannot say'); };
  assert.deepStrictEqual(app.info().input, { mode: 'auto', name: '', label: '', unicode: false, scroll: false, drag: false, auto: false, fellBackBecause: null, pending: false });
  made[0].b.info = () => ({ name: 5, label: {}, unicode: 'yes', scroll: 1, drag: null, auto: 'true', fellBackBecause: 7 });
  assert.deepStrictEqual(app.info().input, { mode: 'auto', name: '', label: '', unicode: false, scroll: false, drag: false, auto: false, fellBackBecause: null, pending: false });
});

// ------------------------------------------------------------------ what the model is told

test('the tool list follows what the input can enter, asked again before every request', () => {
  const { app, made } = rig();
  const agent = app._createAgent();
  assert.strictEqual(typeof agent.tools, 'function');
  assert.deepStrictEqual(agent.tools(), buildToolSchemas({ unicode: false }));
  made[0].b.infoValue = { ...made[0].b.infoValue, unicode: true };          // e.g. GNOME direct input proved itself
  assert.deepStrictEqual(agent.tools(), buildToolSchemas({ unicode: true }));
  made[0].b.info = () => { throw new Error('cannot say'); };
  assert.deepStrictEqual(agent.tools(), buildToolSchemas({ unicode: false }), 'when it cannot be told, the cautious list');
});

test('the model is only told it can paste any text when the backend says exactly true', () => {
  const { app, made } = rig();
  const agent = app._createAgent();
  for (const odd of ['yes', 1, {}, [], 'true', null, undefined]) {
    made[0].b.infoValue = { ...made[0].b.infoValue, unicode: odd };
    assert.deepStrictEqual(agent.tools(), buildToolSchemas({ unicode: false }), JSON.stringify(odd));
  }
});

test('the tool list comes from the backend in use NOW, also after the method was changed', () => {
  const { app, made } = rig({ info: { unicode: true } });
  const agent = app._createAgent();
  assert.deepStrictEqual(agent.tools(), buildToolSchemas({ unicode: true }));
  app.settings.update({ input: { backend: 'ydotool' } });
  made[1].b.infoValue = { ...made[1].b.infoValue, unicode: false };
  assert.deepStrictEqual(agent.tools(), buildToolSchemas({ unicode: false }));
});

// ------------------------------------------------------------------ quitting

test('quitting disposes the backend (the connection to GNOME is closed), and doing it twice is harmless', async () => {
  const { app, made } = rig();
  app._teardown();
  assert.strictEqual(made[0].b.disposed, 1);
  assert.doesNotThrow(() => app._teardown());
  await tick();
});

test('quitting while a task runs stops it first, then lets go of the input', async () => {
  const { app, made } = rig();
  let stoppedWhenDisposed = null;
  made[0].b.dispose = async function dispose() { this.disposed++; stoppedWhenDisposed = app.gate.stopped; };
  const t = longTask(app);
  await tick();
  app._teardown();
  assert.strictEqual(t.stops, 1);
  assert.strictEqual(made[0].b.disposed, 1);
  assert.strictEqual(stoppedWhenDisposed, true, 'nothing may be sent any more by the time the input is let go of');
  t.release(); await t.finished;
});

// ------------------------------------------------------------------ "Check this computer"

/** The same app, but with a screenshot tool that is a stand-in (the real one would photograph the developer's own desktop). */
function checkRig(o = {}) {
  const r = rig({ info: { unicode: true }, ...o });
  r.screen = fakeScreen(o.screen);
  r.app.screen = r.screen;
  return r;
}
const byId = (res) => Object.fromEntries(res.checks.map((c) => [c.id, c]));

test('checking the computer opens the app\'s own mouse and keyboard connection with a harmless move, then lets go of it', async () => {
  const { app, made, screen } = checkRig();
  const res = await app.checkComputer();
  const b = made[0].b;
  assert.deepStrictEqual(b.moves, [[0, 0]], 'a move of zero: it opens the connection and moves nothing');
  assert.strictEqual(b.resumed, 1);
  assert.strictEqual(b.closed, 1, 'GNOME\'s sharing indicator must not stay on after a look');
  assert.strictEqual(screen.calls, 1);
  assert.strictEqual(byId(res).input.state, 'ok');
  assert.match(byId(res).input.detail, /b1 backend is ready/);
});

test('the check reports the desktop the app was started on, as the app understands it', async () => {
  assert.match(byId(await checkRig({ env: GNOME }).app.checkComputer()).desktop.detail, /GNOME on Wayland/);
  const kde = byId(await checkRig({ env: { XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' } }).app.checkComputer()).desktop;
  assert.strictEqual(kde.state, 'warn');
  assert.match(kde.detail, /KDE Plasma on Wayland/);
  assert.strictEqual(byId(await checkRig({ env: {} }).app.checkComputer()).desktop.state, 'warn', 'an unknown desktop is said plainly, not guessed');
});

test('during a task the check asks nothing of the screen or the connection - a Stop pressed meanwhile stays pressed', async () => {
  const { app, made, screen } = checkRig();
  const t = longTask(app);
  await tick();
  const b = made[0].b;
  const before = { resumed: b.resumed, closed: b.closed, moves: b.moves.length };
  const res = await app.checkComputer();
  assert.deepStrictEqual(b.resumed, before.resumed, 'resume() would have cancelled a Stop');
  assert.strictEqual(b.closed, before.closed, 'the task is still using the connection');
  assert.strictEqual(b.moves.length, before.moves);
  assert.strictEqual(screen.calls, 0);
  assert.deepStrictEqual([byId(res).screenshot.state, byId(res).input.state], ['skipped', 'skipped']);
  t.release(); await t.finished;
});

test('a task that STARTS while the check is running keeps its connection: the check does not close it', async () => {
  const { app, made } = checkRig({ screen: { delayMs: 60 } });
  const checking = app.checkComputer();
  await tick();
  // The check is waiting for the screenshot; its input step has not started. Start a task now.
  let release; const held = new Promise((r) => { release = r; });
  app._createAgent = () => ({ on() {}, stop() {}, run: () => held });
  const finished = new Promise((r) => app.runner.once('finished', r));
  const started = app.runner.submit('a task');
  const res = await checking;
  assert.strictEqual(byId(res).input.state, 'skipped', 'a task is running by now, so the input is not tried');
  assert.strictEqual(made[0].b.moves.length, 0);
  release({ ok: true, summary: 'done', steps: 1, stoppedBy: 'finish' });
  await finished; await started;
});

test('a Stop left over from earlier (GNOME\'s indicator, the Stop button) does not make the check fail: it is released first', async () => {
  const { app } = checkRig();
  app.gate.stop();
  assert.strictEqual(app.gate.stopped, true, 'precondition');
  assert.strictEqual(byId(await app.checkComputer()).input.state, 'ok');
  assert.strictEqual(app.gate.stopped, false);
});

test('two asks at once are one check; a later ask looks again', async () => {
  const { app, made, screen } = checkRig({ screen: { delayMs: 30 } });
  const first = app.checkComputer();
  const second = app.checkComputer();
  assert.strictEqual(first, second, 'the same check, not a second one');
  await first;
  assert.deepStrictEqual([screen.calls, made[0].b.moves.length], [1, 1]);
  await app.checkComputer();
  assert.deepStrictEqual([screen.calls, made[0].b.moves.length], [2, 2]);
});

test('a broken screenshot tool or connection is a problem in the answer; the app keeps working and can check again', async () => {
  const { app, made, screen } = checkRig();
  screen.fail = 'No screenshot tool found for GNOME. Install gnome-screenshot.';
  made[0].b.moveBy = async () => { throw new Error('no session bus'); };
  const bad = await app.checkComputer();
  assert.deepStrictEqual([byId(bad).screenshot.state, byId(bad).input.state], ['problem', 'problem']);
  screen.fail = null;
  made[0].b.moveBy = async function moveBy(dx, dy) { this.moves.push([dx, dy]); };
  const good = await app.checkComputer();
  assert.deepStrictEqual([byId(good).screenshot.state, byId(good).input.state], ['ok', 'ok']);
});
