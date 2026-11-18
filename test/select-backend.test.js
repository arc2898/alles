'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { FallbackBackend, createBackend, MODES } = require('../src/main/computer/select-backend');
const { YdotoolBackend } = require('../src/main/computer/ydotool-backend');
const { MutterBackend } = require('../src/main/computer/mutter-backend');

const unavailable = (msg) => Object.assign(new Error(msg), { unavailable: true });

/** A fake way of sending input that records what it was asked and can be told to fail. */
function fake(name, { ready = null, fail = null } = {}) {
  const f = {
    name, calls: [], closed: 0, disposed: 0, resumed: 0, cancelled: () => false,
    info() { return { name, label: name, unicode: name === 'primary', scroll: true, drag: true }; },
    close() { this.closed++; }, async dispose() { this.disposed++; }, resume() { this.resumed++; },
  };
  if (ready) f.ready = ready;
  for (const m of ['moveTo', 'moveBy', 'click', 'mouseDown', 'mouseUp', 'drag', 'scroll', 'typeText', 'pressKeys']) {
    f[m] = async (...a) => { f.calls.push([m, ...a]); if (fail) { const e = fail(m); if (e) throw e; } return `${name}:${m}`; };
  }
  return f;
}
const make = (po = {}, so = {}) => {
  const logs = [];
  const primary = fake('primary', po); const secondary = fake('secondary', so);
  return { fb: new FallbackBackend({ primary, secondary, log: (m) => logs.push(m) }), primary, secondary, logs };
};

// ------------------------------------------------------------------ FallbackBackend

test('the first choice is used, and every kind of action is forwarded with its arguments', async () => {
  const { fb, primary, secondary } = make();
  const sent = [
    ['moveTo', 1, 2, { width: 3, height: 4 }], ['moveBy', 5, 6], ['click', 'left', { double: true }], ['mouseDown', 'right'], ['mouseUp', 'right'],
    ['drag', { x: 1, y: 1 }, { x: 2, y: 2 }, { button: 'left' }], ['scroll', 0, 3], ['typeText', 'hi', { delayMs: 5 }], ['pressKeys', [{ canon: 'a', code: 30 }]],
  ];
  for (const [m, ...a] of sent) assert.strictEqual(await fb[m](...a), `primary:${m}`);
  assert.deepStrictEqual(primary.calls, sent);
  assert.deepStrictEqual(secondary.calls, []);
});

test('an ordinary failure is passed on as it is: no switch, the second choice is not tried', async () => {
  const { fb, primary, secondary, logs } = make({ fail: () => new Error('one click went wrong') });
  await assert.rejects(() => fb.click('left'), /one click went wrong/);
  await assert.rejects(() => fb.moveTo(1, 1), /one click went wrong/);
  assert.deepStrictEqual(secondary.calls, []);
  assert.strictEqual(primary.calls.length, 2);
  assert.strictEqual(fb.active, primary);
  assert.deepStrictEqual(logs, []);
  assert.strictEqual(fb.info().fellBackBecause, null);
});

test('an "unavailable" failure switches to the second choice, repeats the action there, and does not switch back', async () => {
  let broken = true;
  const { fb, primary, secondary, logs } = make({ fail: () => (broken ? unavailable('no PipeWire') : null) });
  assert.strictEqual(await fb.click('left'), 'secondary:click');
  assert.strictEqual(fb.active, secondary);
  assert.strictEqual(primary.closed, 1, 'the first choice is let go of');
  assert.match(logs[0], /GNOME direct input is not available \(no PipeWire\); using ydotool instead/);
  broken = false;                                           // it would work now, but a task must not bounce between two devices
  assert.strictEqual(await fb.moveTo(1, 1), 'secondary:moveTo');
  assert.strictEqual(primary.calls.length, 1, 'the first choice is not asked again');
  assert.deepStrictEqual(fb.info(), { name: 'secondary', label: 'secondary', unicode: false, scroll: true, drag: true, auto: true, fellBackBecause: 'no PipeWire' });
});

test('switching happens once, even if the first choice worked for a while', async () => {
  let n = 0;
  const { fb, secondary } = make({ fail: () => (++n === 3 ? unavailable('the Shell restarted twice') : null) });
  await fb.moveTo(1, 1); await fb.click('left');
  assert.strictEqual(await fb.scroll(0, 1), 'secondary:scroll');
  assert.strictEqual(secondary.calls.length, 1);
});

test('when the second choice fails as well, the error says what the first one said', async () => {
  const { fb } = make({ fail: () => unavailable('no PipeWire') }, { fail: () => new Error('ydotoold is not running') });
  await assert.rejects(() => fb.click('left'), (e) => /ydotoold is not running \(GNOME direct input was tried first: no PipeWire\)/.test(e.message));
});

test('a failure that is not an Error object does not break the reporting', async () => {
  const { fb } = make({ fail: () => unavailable('x') }, { fail: () => 'just a string' });
  await assert.rejects(() => fb.click('left'), (e) => e === 'just a string');
  const { fb: fb2 } = make({ fail: () => null });
  const p = make({ fail: () => 'odd' });
  await assert.rejects(() => p.fb.click('left'), (e) => e === 'odd', 'a non-Error without `unavailable` is simply passed on');
  assert.ok(fb2);
});

test('capabilities(): asks the first choice to get ready, and reports what that one can do', async () => {
  let readied = 0;
  const { fb } = make({ ready: async () => { readied++; } });
  assert.strictEqual((await fb.capabilities()).unicode, true);
  await fb.capabilities();
  assert.strictEqual(readied, 1, 'asked once, not before every action');
  assert.strictEqual(fb.active.name, 'primary');
});

test('capabilities(): once an ACTION has worked, the first choice has proved itself and is not asked to get ready again', async () => {
  let readied = 0;
  const { fb } = make({ ready: async () => { readied++; } });
  await fb.click('left');
  assert.strictEqual((await fb.capabilities()).name, 'primary');
  assert.strictEqual(readied, 0);
});

test('capabilities(): if the first choice cannot get ready, switch NOW so the model is told the truth about what can be typed', async () => {
  const { fb, primary, secondary, logs } = make({ ready: async () => { throw unavailable('not a GNOME Wayland session'); } });
  const caps = await fb.capabilities();
  assert.strictEqual(caps.name, 'secondary');
  assert.strictEqual(caps.unicode, false, 'no more pretending text of any script can be entered');
  assert.strictEqual(fb.active, secondary);
  assert.strictEqual(primary.closed, 1);
  assert.match(logs[0], /not a GNOME Wayland session/);
  assert.strictEqual(fb.info().fellBackBecause, 'not a GNOME Wayland session');
});

test('capabilities(): a failure that is not "unavailable" is raised, not hidden; and a first choice with no ready() is simply used', async () => {
  const { fb } = make({ ready: async () => { throw new Error('the person stopped it'); } });
  await assert.rejects(() => fb.capabilities(), /the person stopped it/);
  assert.strictEqual(fb.active.name, 'primary');
  const { fb: fb2 } = make();
  assert.strictEqual((await fb2.capabilities()).name, 'primary');
  const { fb: fb3, primary } = make({ ready: async () => { throw new Error('x'); } });
  await assert.rejects(() => fb3.capabilities(), /x/);
  await assert.rejects(() => fb3.capabilities(), /x/, 'and it is tried again, not remembered as ready');
  assert.ok(primary.ready);
});

test('after a switch, capabilities() answers for the second choice without asking the first again', async () => {
  let readied = 0;
  const { fb } = make({ ready: async () => { readied++; throw unavailable('gone'); } });
  await fb.capabilities(); await fb.capabilities();
  assert.strictEqual(readied, 1);
});

test('the emergency-stop check is handed to BOTH, and can be read back', () => {
  const { fb, primary, secondary } = make();
  assert.strictEqual(fb.cancelled(), false);
  const stop = () => true;
  fb.cancelled = stop;
  assert.strictEqual(primary.cancelled, stop);
  assert.strictEqual(secondary.cancelled, stop);
  assert.strictEqual(fb.cancelled, stop);
});

test('resume, close and dispose reach both', async () => {
  const { fb, primary, secondary } = make();
  fb.resume();
  await fb.close();
  await fb.dispose();
  assert.deepStrictEqual([primary.resumed, secondary.resumed, primary.closed, secondary.closed, primary.disposed, secondary.disposed], [1, 1, 1, 1, 1, 1]);
});

test('a first choice that fails while being closed does not stop the switch', async () => {
  const { fb, primary, secondary } = make({ fail: () => unavailable('gone') });
  primary.close = () => { throw new Error('close failed'); };
  assert.strictEqual(await fb.click('left'), 'secondary:click');
  const { fb: fb2, primary: p2 } = make({ fail: () => unavailable('gone') });
  p2.close = () => Promise.reject(new Error('close failed later'));
  assert.strictEqual(await fb2.click('left'), 'secondary:click');
  await new Promise((r) => setImmediate(r));
  assert.ok(secondary.calls.length === 1);
});

// ------------------------------------------------------------------ createBackend

const kinds = (b) => (b instanceof FallbackBackend ? `fallback(${b.primary.constructor.name}, ${b.secondary.constructor.name})` : b.constructor.name);

test('auto on GNOME (Wayland, or a session type we could not tell): GNOME direct input first, ydotool behind it', () => {
  assert.strictEqual(kinds(createBackend({ desktop: 'gnome', session: 'wayland' })), 'fallback(MutterBackend, YdotoolBackend)');
  assert.strictEqual(kinds(createBackend({ desktop: 'gnome', session: '' })), 'fallback(MutterBackend, YdotoolBackend)');
  assert.strictEqual(kinds(createBackend({ mode: 'auto', desktop: 'gnome', session: 'wayland' })), 'fallback(MutterBackend, YdotoolBackend)');
});

test('auto anywhere else (KDE, another desktop, an X11 session, nothing known): ydotool', () => {
  for (const o of [{ desktop: 'kde', session: 'wayland' }, { desktop: 'unknown', session: 'wayland' }, { desktop: 'gnome', session: 'x11' }, {}, { desktop: 'xfce', session: 'x11' }]) {
    assert.strictEqual(kinds(createBackend(o)), 'YdotoolBackend', JSON.stringify(o));
  }
});

test('"gnome" and "ydotool" are exactly what they say, whatever the desktop', () => {
  assert.strictEqual(kinds(createBackend({ mode: 'gnome', desktop: 'kde' })), 'MutterBackend');
  assert.strictEqual(kinds(createBackend({ mode: 'ydotool', desktop: 'gnome', session: 'wayland' })), 'YdotoolBackend');
});

test('a mode nobody knows is treated as auto', () => {
  assert.deepStrictEqual(MODES, ['auto', 'gnome', 'ydotool']);
  for (const mode of ['AUTO', 'x11', '', null, undefined, 5, 'toString']) assert.strictEqual(kinds(createBackend({ mode, desktop: 'gnome', session: 'wayland' })), 'fallback(MutterBackend, YdotoolBackend)', String(mode));
  for (const mode of ['AUTO', 'x11', '']) assert.strictEqual(kinds(createBackend({ mode, desktop: 'kde' })), 'YdotoolBackend');
});

test('the clipboard, the stop callback and the options reach the backends that need them', () => {
  const clipboard = { readText() { return ''; }, writeText() {} };
  const onUserStop = () => {};
  const g = createBackend({ mode: 'gnome', clipboard, onUserStop });
  assert.strictEqual(g.clipboard, clipboard);
  assert.strictEqual(g.onUserStop, onUserStop);
  assert.strictEqual(g.info().unicode, true);
  const exec = () => {};
  const y = createBackend({ mode: 'ydotool', deps: { ydotool: { bin: '/x/ydotool', socket: '/s', exec } } });
  assert.deepStrictEqual([y.bin, y.socket, y.exec], ['/x/ydotool', '/s', exec]);
  const auto = createBackend({ desktop: 'gnome', session: 'wayland', clipboard, onUserStop, deps: { ydotool: { bin: '/y' }, mutter: { idleMs: 123 } } });
  assert.strictEqual(auto.primary.clipboard, clipboard);
  assert.strictEqual(auto.primary.idleMs, 123);
  assert.strictEqual(auto.secondary.bin, '/y');
  assert.ok(auto.primary instanceof MutterBackend && auto.secondary instanceof YdotoolBackend);
});

test('without a clipboard GNOME direct input says it can only type plain text', () => {
  assert.strictEqual(createBackend({ mode: 'gnome' }).info().unicode, false);
});
