'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { InputController, SafetyGate } = require('../src/main/computer/input');

/**
 * The front door (safety gate + checking) in front of a fake backend that records what reaches it.
 * Whatever carries the input out, nothing may reach it unless the front allows it.
 */
function backendFake({ unicode = false } = {}) {
  const calls = [];
  const b = {
    calls, unicode, closed: 0, disposed: 0, resumed: 0, cancelled: null,
    info() { return { name: 'fake', label: 'Fake', unicode: this.unicode, scroll: true, drag: true }; },
    async capabilities() { return this.info(); },
    async moveTo(...a) { calls.push(['moveTo', ...a]); },
    async moveBy(...a) { calls.push(['moveBy', ...a]); },
    async click(...a) { calls.push(['click', ...a]); },
    async drag(...a) { calls.push(['drag', ...a]); },
    async scroll(...a) { calls.push(['scroll', ...a]); },
    async typeText(...a) { calls.push(['typeText', ...a]); return { notes: [] }; },
    async pressKeys(keys) { calls.push(['pressKeys', keys.map((k) => k.canon)]); },
    resume() { this.resumed++; },
    close() { this.closed++; },
    async dispose() { this.disposed++; },
  };
  return b;
}
const make = (opts = {}, gateOpts = {}) => {
  const backend = backendFake(opts);
  const gate = new SafetyGate(gateOpts);
  const input = new InputController({ gate, backend });
  return { input, backend, gate, calls: backend.calls };
};

// ------------------------------------------------------------------ the emergency stop shuts every door

test('with the emergency stop engaged NOTHING reaches the backend: not a move, click, drag, scroll, text or key', async () => {
  const { input, gate, calls } = make();
  gate.stop();
  const acts = [
    () => input.moveTo(1, 1), () => input.moveBy(1, 1), () => input.click('left'), () => input.drag({ x: 1, y: 1 }, { x: 2, y: 2 }),
    () => input.scroll(0, 3), () => input.type('abc'), () => input.pressCombo('ctrl+c'),
  ];
  for (const a of acts) await assert.rejects(a, /Emergency stop is engaged/);
  assert.deepStrictEqual(calls, []);
});

test('the backend is handed a way to ask "has the emergency stop been pressed?" so a long action can stop between steps', () => {
  const { backend, gate } = make();
  assert.strictEqual(typeof backend.cancelled, 'function');
  assert.strictEqual(backend.cancelled(), false);
  gate.stop();
  assert.strictEqual(backend.cancelled(), true);
  gate.resume();
  assert.strictEqual(backend.cancelled(), false);
});

test('resume() lifts the stop and tells the backend (a stop made from GNOME\'s sharing indicator is lifted with it)', async () => {
  const { input, backend, gate, calls } = make();
  gate.stop();
  input.resume();
  assert.strictEqual(gate.stopped, false);
  assert.strictEqual(backend.resumed, 1);
  await input.moveTo(1, 2);
  assert.deepStrictEqual(calls, [['moveTo', 1, 2, undefined]]);
});

test('every action uses the rate limit, and the budget is shared across kinds of action', async () => {
  const { input, calls } = make({}, { maxActionsPerMinute: 4 });
  await input.moveTo(1, 1); await input.click('left'); await input.scroll(0, 1); await input.moveBy(1, 1);
  await assert.rejects(() => input.drag({ x: 1, y: 1 }, { x: 2, y: 2 }), /Rate limit/);
  await assert.rejects(() => input.type('a'), /Rate limit/);
  await assert.rejects(() => input.pressCombo('a'), /Rate limit/);
  assert.strictEqual(calls.length, 4);
});

// ------------------------------------------------------------------ pointer

test('moveTo hands the position and the picture size on; bad numbers never reach the backend', async () => {
  const { input, calls } = make();
  await input.moveTo(10, 20, { space: { width: 1920, height: 1080 } });
  await input.moveTo(-5, 0);
  assert.deepStrictEqual(calls, [['moveTo', 10, 20, { width: 1920, height: 1080 }], ['moveTo', -5, 0, undefined]]);
  calls.length = 0;
  for (const [x, y] of [[NaN, 1], [1, Infinity], [20001, 0], [0, -20001], ['5', 5], [null, 0], [undefined, 0]]) {
    await assert.rejects(() => input.moveTo(x, y), /Invalid (x|y)/, `${x},${y}`);
  }
  assert.deepStrictEqual(calls, []);
});

test('moveBy checks both numbers', async () => {
  const { input, calls } = make();
  await input.moveBy(3, -4);
  assert.deepStrictEqual(calls, [['moveBy', 3, -4]]);
  await assert.rejects(() => input.moveBy(NaN, 0), /Invalid dx/);
  await assert.rejects(() => input.moveBy(0, 99999), /Invalid dy/);
  assert.strictEqual(calls.length, 1);
});

test('click: the button is checked, and double is passed as an option', async () => {
  const { input, calls } = make();
  await input.click();
  await input.click('right', { double: true });
  assert.deepStrictEqual(calls, [['click', 'left', { double: false }], ['click', 'right', { double: true }]]);
  await assert.rejects(() => input.click('back'), /Unknown mouse button "back"/);
  await assert.rejects(() => input.click('toString'), /Unknown mouse button/, 'names an object inherits are not buttons');
  assert.strictEqual(calls.length, 2);
});

test('drag: both ends and the button are checked; the backend gets plain copies and the picture size', async () => {
  const { input, calls } = make();
  const from = { x: 1, y: 2, extra: 'ignored' }; const to = { x: 30, y: 40 };
  await input.drag(from, to, { button: 'middle', space: { width: 100, height: 50 } });
  assert.deepStrictEqual(calls, [['drag', { x: 1, y: 2 }, { x: 30, y: 40 }, { button: 'middle', space: { width: 100, height: 50 } }]]);
  calls.length = 0;
  await input.drag({ x: 0, y: 0 }, { x: 5, y: 5 });
  assert.deepStrictEqual(calls[0][3], { button: 'left', space: undefined });
  calls.length = 0;
  for (const [f, t] of [[null, { x: 1, y: 1 }], [{ x: 1, y: 1 }, undefined], [{ x: NaN, y: 1 }, { x: 1, y: 1 }], [{ x: 1, y: 1 }, { x: 1, y: 99999 }], [{ y: 1 }, { x: 1, y: 1 }]]) {
    await assert.rejects(() => input.drag(f, t), /drag\(\) needs|Invalid/, JSON.stringify([f, t]));
  }
  await assert.rejects(() => input.drag({ x: 1, y: 1 }, { x: 2, y: 2 }, { button: 'back' }), /Unknown mouse button/);
  assert.deepStrictEqual(calls, []);
});

// ------------------------------------------------------------------ scroll

test('scroll: rounds to whole notches, down and right are positive, and sends both axes together', async () => {
  const { input, calls } = make();
  await input.scroll(0, 3);
  await input.scroll(-2, 0);
  await input.scroll(1.6, -2.4);
  assert.deepStrictEqual(calls, [['scroll', 0, 3], ['scroll', -2, 0], ['scroll', 2, -2]]);
});

test('scroll: nothing to scroll, or a silly amount, is refused and does not use up the rate limit', async () => {
  const { input, calls, gate } = make();
  for (const [dx, dy] of [[0, 0], [0.4, -0.4], [NaN, 1], [1, NaN], [-Infinity, 0], [1, Infinity], [1001, 0], [0, -1001]]) await assert.rejects(() => input.scroll(dx, dy), /Nothing to scroll|Invalid scroll amount/, `${dx},${dy}`);
  assert.deepStrictEqual(calls, []);
  assert.strictEqual(gate.stamps.length, 0);
  await input.scroll(1000, 0);
  assert.strictEqual(calls.length, 1);
});

// ------------------------------------------------------------------ typing, plain-keyboard backend

test('plain keyboard: typographic characters are converted and REPORTED; the backend gets the converted text', async () => {
  const { input, calls } = make({ unicode: false });
  const r = await input.type('“hi” — ok');
  assert.deepStrictEqual(calls[0].slice(0, 2), ['typeText', '"hi" - ok']);
  assert.strictEqual(r.typed, 9);
  assert.ok(r.notes.some((n) => /converted 3 typographic/.test(n)), r.notes.join('|'));
});

test('plain keyboard: a character that cannot be typed is rejected BEFORE anything is sent, and costs no rate budget', async () => {
  const { input, calls, gate } = make({ unicode: false });
  await assert.rejects(() => input.type('café'), /Cannot type 1 kind\(s\) of character with the keyboard tool: "é" \(U\+00E9\)[\s\S]*Nothing was typed/);
  await assert.rejects(() => input.type('\u{1F600}'), /U\+1F600/);
  assert.deepStrictEqual(calls, []);
  assert.strictEqual(gate.stamps.length, 0);
});

test('plain keyboard: text that is only invisible characters is refused', async () => {
  const { input, calls } = make({ unicode: false });
  await assert.rejects(() => input.type('​⁠'), /Nothing to type after removing invisible characters/);
  assert.deepStrictEqual(calls, []);
});

// ------------------------------------------------------------------ typing, any-text backend

test('any-text backend: accents, scripts and emoji go through unchanged, counted as characters (an emoji is ONE)', async () => {
  const { input, calls } = make({ unicode: true });
  const r = await input.type('café ₹ \u{1F600}');
  assert.strictEqual(calls[0][1], 'café ₹ \u{1F600}');
  assert.strictEqual(r.typed, 8);
});

test('any-text backend: curly quotes are kept as typed (nothing is converted)', async () => {
  const { input, calls } = make({ unicode: true });
  const r = await input.type('“hi”');
  assert.strictEqual(calls[0][1], '“hi”');
  assert.deepStrictEqual(r.notes, []);
});

test('any-text backend: control characters are refused with their own message, and nothing is sent', async () => {
  const { input, calls, gate } = make({ unicode: true });
  await assert.rejects(() => input.type('a\u001bb'), /Cannot enter 1 kind\(s\) of character: control character U\+001B[\s\S]*Nothing was typed/);
  assert.deepStrictEqual(calls, []);
  assert.strictEqual(gate.stamps.length, 0);
});

test('the terminal flag chooses the paste shortcut, and the delay is passed along', async () => {
  const { input, calls } = make({ unicode: true });
  await input.type('x');
  await input.type('y', { terminal: true, delayMs: 3 });
  assert.deepStrictEqual(calls[0], ['typeText', 'x', { delayMs: 12, pasteKeys: 'ctrl+v' }]);
  assert.deepStrictEqual(calls[1], ['typeText', 'y', { delayMs: 3, pasteKeys: 'ctrl+shift+v' }]);
});

test('notes from the backend (what it pasted) are added to the converted-characters notes', async () => {
  const b = backendFake({ unicode: false });
  b.typeText = async () => ({ notes: ['2 character(s) the keyboard cannot type were pasted with Ctrl+V'] });
  const input = new InputController({ gate: new SafetyGate(), backend: b });
  const r = await input.type('“x”');
  assert.strictEqual(r.notes.length, 2);
  assert.match(r.notes[1], /were pasted/);
});

test('a backend that answers nothing at all is fine', async () => {
  const b = backendFake();
  b.typeText = async () => undefined;
  const input = new InputController({ gate: new SafetyGate(), backend: b });
  assert.deepStrictEqual(await input.type('ok'), { typed: 2, notes: [] });
});

test('typing: non-strings, empty text and anything over 2000 characters are refused without touching the backend', async () => {
  const { input, calls } = make();
  for (const t of [undefined, null, 5, '', {}]) await assert.rejects(() => input.type(t), /needs non-empty text/);
  await assert.rejects(() => input.type('x'.repeat(2001)), /more than 2000 chars/);
  assert.deepStrictEqual(calls, []);
  await input.type('x'.repeat(2000));
  assert.strictEqual(calls.length, 1);
});

test('what the backend can do is asked at the moment of typing (it may change: GNOME direct input falls back to ydotool)', async () => {
  const { input, backend, calls } = make({ unicode: true });
  await input.type('é');
  backend.unicode = false;
  await assert.rejects(() => input.type('é'), /Cannot type/);
  assert.strictEqual(calls.length, 1);
});

// ------------------------------------------------------------------ key combinations

test('pressCombo parses the combination and gives the backend the keys', async () => {
  const { input, calls } = make();
  await input.pressCombo('Ctrl+Shift+T');
  assert.deepStrictEqual(calls, [['pressKeys', ['leftctrl', 'leftshift', 't']]]);
  await assert.rejects(() => input.pressCombo('ctrl+nosuchkey'), /Unknown key/);
  await assert.rejects(() => input.pressCombo(''), /Empty key combo/);
  assert.strictEqual(calls.length, 1);
});

test('blocked combinations never reach the backend, whatever the spelling', async () => {
  const { input, calls } = make();
  for (const c of ['ctrl+alt+delete', 'CTRL+ALT+DEL', 'control+alt+backspace', 'super+l', 'win+l', 'meta+l', 'ctrl+alt+f3', 'alt+sysrq']) await assert.rejects(() => input.pressCombo(c), /Blocked dangerous key combo/, c);
  assert.deepStrictEqual(calls, []);
});

test('the person can allow dangerous combinations in Settings', async () => {
  const { input, calls } = make({}, { allowDangerous: true });
  await input.pressCombo('super+l');
  assert.strictEqual(calls.length, 1);
});

// ------------------------------------------------------------------ swapping and closing

test('setBackend swaps the way input is sent, closes the old one, and wires the new one to the emergency stop', async () => {
  const { input, backend: old, gate } = make();
  const next = backendFake();
  input.setBackend(next);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(old.disposed, 1);
  assert.strictEqual(next.cancelled(), false);
  gate.stop();
  assert.strictEqual(next.cancelled(), true);
  gate.resume();
  await input.moveTo(1, 1);
  assert.strictEqual(next.calls.length, 1);
  assert.strictEqual(old.calls.length, 0);
});

test('setBackend with the same backend does not close it', async () => {
  const { input, backend } = make();
  input.setBackend(backend);
  assert.strictEqual(backend.disposed, 0);
});

test('an old backend without dispose() is closed instead; one that throws is ignored', async () => {
  const gate = new SafetyGate();
  const old = backendFake(); delete old.dispose; let closed = 0; old.close = () => { closed++; };
  const input = new InputController({ gate, backend: old });
  input.setBackend(backendFake());
  assert.strictEqual(closed, 1);
  const angry = backendFake(); angry.dispose = () => { throw new Error('boom'); };
  input.setBackend(angry);
  assert.doesNotThrow(() => input.setBackend(backendFake()));
  const rejecting = backendFake(); rejecting.dispose = () => Promise.reject(new Error('later'));
  input.setBackend(rejecting);
  input.setBackend(backendFake());
  await new Promise((r) => setImmediate(r));
});

test('info() is the backend\'s own description', () => {
  const { input } = make({ unicode: true });
  assert.deepStrictEqual(input.info(), { name: 'fake', label: 'Fake', unicode: true, scroll: true, drag: true });
});

test('close() and dispose() pass on, and a backend that fails to close does not take the app down', async () => {
  const { input, backend } = make();
  input.close(); await input.dispose();
  assert.deepStrictEqual([backend.closed, backend.disposed], [1, 1]);
  backend.close = () => { throw new Error('boom'); };
  backend.dispose = async () => { throw new Error('boom'); };
  assert.doesNotThrow(() => input.close());
  await assert.doesNotReject(() => input.dispose());
  backend.close = () => Promise.reject(new Error('later'));
  assert.doesNotThrow(() => input.close());
  await new Promise((r) => setImmediate(r));
});

test('with no backend given the front uses ydotool, with the options it was given', async () => {
  const execs = [];
  const input = new InputController({ gate: new SafetyGate(), bin: '/opt/ydotool', socket: '/run/ydo.sock', exec: (bin, args, opts, cb) => { execs.push([bin, args, opts.env.YDOTOOL_SOCKET]); cb(null, ''); } });
  assert.strictEqual(input.info().name, 'ydotool');
  await input.moveBy(2, 3);
  assert.deepStrictEqual(execs, [['/opt/ydotool', ['mousemove', '-x', '2', '-y', '3'], '/run/ydo.sock']]);
});
