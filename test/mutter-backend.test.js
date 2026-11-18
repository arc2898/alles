'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MutterBackend, planTyping, BUTTONS, KEY, T, STOPPED_MESSAGE } = require('../src/main/computer/mutter-backend');
const { InputUnavailable } = require('../src/main/computer/mutter-transport');
const { parseCombo } = require('../src/main/computer/input');

/**
 * MutterBackend decides WHAT to send; these tests give it a fake of the service that writes every event (and every pause)
 * into one list, so a test can say exactly what a real GNOME session would have received, and in which order.
 * The numbers in that order are the ones measured on a real GNOME Shell 46 (see the header of mutter-backend.js).
 */

const GONE = () => Object.assign(new Error('Object does not exist at path "/org/gnome/Mutter/RemoteDesktop/Session/u1"'), {
  type: 'org.freedesktop.DBus.Error.UnknownMethod', text: 'Object does not exist at path "/org/gnome/Mutter/RemoteDesktop/Session/u1"',
});
const S = (ms) => ['sleep', ms];
// What a click, a button press or a scroll is preceded by when it is the first thing a session does (the pointer needs two motions to wake up)
const NUDGE = [['rel', -1, 0], ['sleep', 70], ['rel', 1, 0], ['sleep', 40]];

function world({
  desktop = { x: 0, y: 0, width: 1366, height: 768, scale: 1 }, layout = { latin: true, ime: false, id: 'us' },
  clipboard = true, clip = {}, idleMs = 45000, layoutTtlMs = 3000, onUserStop = null,
} = {}) {
  const w = { log: [], notes: [], sessions: [], opens: 0, fail: null, onSleep: null, layoutReads: 0, clock: 0, timers: [], displayCbs: [], transportClosed: false, desktop, layout, available: { ok: true }, openFail: null, cancel: false };

  class Session {
    constructor(area) { this.id = ++w.opens; this.area = area; this.closed = false; this.closedByUs = false; this._cbs = []; }
    onClosed(cb) { if (this.closed) cb(this); else this._cbs.push(cb); }
    emitClosed() { if (this.closed) return; this.closed = true; for (const cb of this._cbs.splice(0)) cb(this); }
    async stop() { this.closedByUs = true; w.log.push(['stop', this.id]); this.emitClosed(); }
    _ev(name, ...a) {
      if (this.closed) throw GONE();
      if (w.fail) { const f = w.fail(name, a, this); if (f) throw f; }
      w.log.push([name, ...a]);
    }
    pointerAbsolute(x, y) { return this._ev('abs', x, y); }
    pointerRelative(x, y) { return this._ev('rel', x, y); }
    button(c, d) { return this._ev('btn', c, d); }
    axis(dx, dy, f) { return this._ev('axis', dx, dy, f); }
    axisDiscrete(a, n) { return this._ev('disc', a, n); }
    keycode(c, d) { return this._ev('key', c, d); }
    keysym(s, d) { return this._ev('sym', s, d); }
  }

  const transport = {
    available: async () => w.available,
    desktop: async () => w.desktop,
    onDisplayChange: async (cb) => { w.displayCbs.push(cb); },
    open: async (area) => {
      if (w.openFail) throw w.openFail;
      w.log.push(['open', area.x, area.y, area.width, area.height]);
      const s = new Session(area); w.sessions.push(s); return s;
    },
    close: () => { w.transportClosed = true; },
  };
  w.clipboard = clipboard ? {
    text: 'before', formats: ['text/plain'], ...clip,
    readText() { return this.text; },
    writeText(t) { this.text = t; w.log.push(['clip', t]); },
    clear() { this.text = ''; w.log.push(['clip-clear']); },
    availableFormats() { return this.formats; },
  } : null;
  w.stops = 0;
  w.backend = new MutterBackend({
    transport, clipboard: w.clipboard,
    readLayout: async () => { w.layoutReads++; if (w.layout instanceof Error) throw w.layout; return w.layout; },
    sleep: async (ms) => { w.clock += ms; w.log.push(S(ms)); if (w.onSleep) w.onSleep(ms); },
    setTimer: (fn, ms) => { const h = { fn, ms, cleared: false, unref() {} }; w.timers.push(h); return h; },
    clearTimer: (h) => { if (h) h.cleared = true; },
    now: () => w.clock, idleMs, layoutTtlMs,
    onUserStop: onUserStop || (() => { w.stops++; }),
    log: (m) => w.notes.push(m),
  });
  w.backend.cancelled = () => w.cancel;
  w.live = () => w.timers.filter((t) => !t.cleared);
  return w;
}

const NAMES = { 28: '<Enter>', 15: '<Tab>', 29: '<Ctrl>', 42: '<Shift>', 47: '<V>', 46: '<C>', 56: '<Alt>' };
/** What was pressed (not released), in order, as readable text: letters for keysyms, <Name> for key positions. */
const downs = (log) => log.filter((e) => (e[0] === 'sym' || e[0] === 'key') && e[2] === true).map((e) => (e[0] === 'sym' ? String.fromCharCode(e[1]) : NAMES[e[1]] || `<${e[1]}>`));
const events = (log) => log.filter((e) => e[0] !== 'sleep');
const mustBeBalanced = (log, what = '') => {
  const held = new Set();
  for (const e of log) {
    if (e[0] !== 'btn' && e[0] !== 'key' && e[0] !== 'sym') continue;
    const k = `${e[0]}:${e[1]}`;
    if (e[2]) held.add(k); else held.delete(k);
  }
  assert.deepStrictEqual([...held], [], `${what} left something held down`);
};

// ------------------------------------------------------------------ the measured numbers are pinned

test('the numbers that were measured on the real Shell are the ones in the code', () => {
  assert.strictEqual(T.moveGap, 70, 'two motion events, 70 ms apart: on native Wayland they must be spaced');
  assert.strictEqual(T.scrollPrime, 0.05, 'the wheel-priming speck of smooth scrolling');
  assert.strictEqual(T.primeWait, 30);
  assert.strictEqual(KEY.SHIFT, 42, 'the first-key loss is spent on Shift (evdev 42)');
  assert.deepStrictEqual(BUTTONS, { left: 0x110, right: 0x111, middle: 0x112 });
});

// ------------------------------------------------------------------ planTyping

test('planTyping: plain text is one run of keys; Enter and Tab are their own steps', () => {
  assert.deepStrictEqual(planTyping('hello', { canKey: true, canPaste: true }).segments, [{ kind: 'keys', text: 'hello' }]);
  assert.deepStrictEqual(planTyping('a\nb\tc', { canKey: true, canPaste: true }).segments, [
    { kind: 'keys', text: 'a' }, { kind: 'enter', text: '' }, { kind: 'keys', text: 'b' }, { kind: 'tab', text: '' }, { kind: 'keys', text: 'c' },
  ]);
  assert.deepStrictEqual(planTyping('\n\n', { canKey: true, canPaste: true }).segments.map((s) => s.kind), ['enter', 'enter']);
});

test('planTyping: what the layout cannot make is pasted, and an emoji stays in one piece', () => {
  assert.deepStrictEqual(planTyping('café', { canKey: true, canPaste: true }).segments, [{ kind: 'keys', text: 'caf' }, { kind: 'paste', text: 'é' }]);
  assert.deepStrictEqual(planTyping('x\u{1F600}y', { canKey: true, canPaste: true }).segments, [{ kind: 'keys', text: 'x' }, { kind: 'paste', text: '\u{1F600}' }, { kind: 'keys', text: 'y' }]);
});

test('planTyping: a few letters between two pasted pieces are pasted with them (fewer clipboard round trips)', () => {
  assert.deepStrictEqual(planTyping('éabñ', { canKey: true, canPaste: true }).segments, [{ kind: 'paste', text: 'éabñ' }]);
  assert.deepStrictEqual(planTyping('éabñcü', { canKey: true, canPaste: true }).segments, [{ kind: 'paste', text: 'éabñcü' }], 'merging chains');
  const four = planTyping('éabcdñ', { canKey: true, canPaste: true }).segments;
  assert.deepStrictEqual(four.map((s) => s.kind), ['paste', 'keys', 'paste'], 'four letters are cheaper to type');
  const edge = planTyping('abñ', { canKey: true, canPaste: true }).segments;
  assert.deepStrictEqual(edge.map((s) => s.kind), ['keys', 'paste'], 'letters at the edge are never merged');
});

test('planTyping: without a Latin layout everything but Enter/Tab is pasted', () => {
  const p = planTyping('ab\ncd', { canKey: false, canPaste: true }).segments;
  assert.deepStrictEqual(p, [{ kind: 'paste', text: 'ab' }, { kind: 'enter', text: '' }, { kind: 'paste', text: 'cd' }]);
});

test('planTyping: needing the clipboard when there is none is an error that says why', () => {
  assert.match(planTyping('é', { canKey: true, canPaste: false }).error, /cannot be typed with the keyboard.*clipboard/);
  assert.match(planTyping('a', { canKey: false, canPaste: false }).error, /cannot type Latin letters.*Switch to a Latin layout/);
  assert.strictEqual(planTyping('abc\n', { canKey: true, canPaste: false }).error, undefined);
});

// ------------------------------------------------------------------ the pointer

test('moveTo sends the position TWICE, 70 ms apart, then waits a moment (a click after one cold motion is lost)', async () => {
  const w = world();
  await w.backend.moveTo(100, 50);
  assert.deepStrictEqual(w.log, [['open', 0, 0, 1366, 768], ['abs', 100, 50], S(T.moveGap), ['abs', 100, 50], S(T.moveSettle)]);
});

test('coordinates are the pixels of the picture; at 200% scaling the stream is twice the logical size', async () => {
  const w = world({ desktop: { x: 0, y: 0, width: 1280, height: 720, scale: 2 } });
  await w.backend.moveTo(100, 50);                                       // no picture size: already stream pixels
  await w.backend.moveTo(100, 50, { width: 2560, height: 1440 });         // a screenshot of the whole stream
  await w.backend.moveTo(100, 50, { width: 1280, height: 720 });          // a picture half that size
  const abs = events(w.log).filter((e) => e[0] === 'abs').map((e) => [e[1], e[2]]);
  assert.deepStrictEqual(abs, [[100, 50], [100, 50], [100, 50], [100, 50], [200, 100], [200, 100]]);
  assert.deepStrictEqual(w.log[0], ['open', 0, 0, 1280, 720], 'the area asked for is the LOGICAL desktop');
});

test('fractional scale: 1.25 on a 2048x1152 logical desktop is a 2560x1440 stream', async () => {
  const w = world({ desktop: { x: 0, y: 0, width: 2048, height: 1152, scale: 1.25 } });
  await w.backend.moveTo(2559, 1439);
  await w.backend.moveTo(1280, 720, { width: 2560, height: 1440 });
  const abs = events(w.log).filter((e) => e[0] === 'abs').map((e) => [e[1], e[2]]);
  assert.deepStrictEqual(abs, [[2559, 1439], [2559, 1439], [1280, 720], [1280, 720]]);
});

test('a point outside the screen is pulled to its edge (the last pixel), never sent beyond it', async () => {
  const w = world();
  await w.backend.moveTo(99999, -5);
  assert.deepStrictEqual(events(w.log).filter((e) => e[0] === 'abs')[0], ['abs', 1365, 0]);
  await w.backend.moveTo(-3, 5000);
  assert.deepStrictEqual(events(w.log).filter((e) => e[0] === 'abs')[2], ['abs', 0, 767]);
});

test('when the desktop shape cannot be read, the size of the picture the model saw is used for the area', async () => {
  const w = world({ desktop: null });
  await w.backend.moveTo(10, 10, { width: 1366, height: 768 });
  assert.deepStrictEqual(w.log[0], ['open', 0, 0, 1366, 768]);
  const w2 = world({ desktop: null });
  await w2.backend.moveTo(10, 10);
  assert.deepStrictEqual(w2.log[0], ['open', 0, 0, 1920, 1080], 'with no information at all: a common size');
});

test('moveBy is one relative motion', async () => {
  const w = world();
  await w.backend.moveBy(5, -7);
  assert.deepStrictEqual(events(w.log), [['open', 0, 0, 1366, 768], ['rel', 5, -7]]);
});

// ------------------------------------------------------------------ clicks

test('a click is press, 45 ms, release; a double click is two of them 70 ms apart', async () => {
  const w = world();
  await w.backend.moveTo(5, 5);                           // (two motions: the pointer is awake, see "the pointer wakes up" below)
  w.log.length = 0;
  await w.backend.click('left');
  assert.deepStrictEqual(w.log, [['btn', 0x110, true], S(T.clickHold), ['btn', 0x110, false]]);
  w.log.length = 0;
  await w.backend.click('left', { double: true });
  assert.deepStrictEqual(w.log, [['btn', 0x110, true], S(45), ['btn', 0x110, false], S(70), ['btn', 0x110, true], S(45), ['btn', 0x110, false]]);
});

test('right and middle buttons use their own codes; an unknown button sends nothing and opens nothing', async () => {
  const w = world();
  await w.backend.click('right'); await w.backend.click('middle');
  assert.deepStrictEqual(events(w.log).filter((e) => e[2] === true).map((e) => e[1]), [0x111, 0x112]);
  const w2 = world();
  await assert.rejects(() => w2.backend.click('back'), /Unknown mouse button "back"/);
  for (const bad of ['toString', 'constructor', '__proto__', 'hasOwnProperty', '', null, 5, {}]) {       // (undefined is the default: left)
    await assert.rejects(() => w2.backend.click(bad), /Unknown mouse button/, String(bad));
    await assert.rejects(() => w2.backend.mouseDown(bad), /Unknown mouse button/, String(bad));
    await assert.rejects(() => w2.backend.mouseUp(bad), /Unknown mouse button/, String(bad));
    await assert.rejects(() => w2.backend.drag({ x: 1, y: 1 }, { x: 5, y: 5 }, { button: bad }), /Unknown mouse button/, String(bad));
  }
  assert.deepStrictEqual(w2.log, []);
  assert.strictEqual(w2.opens, 0);
});

test('mouseDown and mouseUp are single events; mouseUp works even after an emergency stop and never opens a session', async () => {
  const w = world();
  await w.backend.mouseDown('left');
  w.cancel = true;
  await assert.rejects(() => w.backend.mouseDown('left'), new RegExp(STOPPED_MESSAGE));
  await w.backend.mouseUp('left');
  assert.deepStrictEqual(events(w.log), [['open', 0, 0, 1366, 768], ['rel', -1, 0], ['rel', 1, 0], ['btn', 0x110, true], ['btn', 0x110, false]]);
  const w2 = world();
  await w2.backend.mouseUp('left');
  assert.strictEqual(w2.opens, 0, 'nothing is held in a session that does not exist');
  await assert.rejects(() => w2.backend.mouseUp('back'), /Unknown mouse button/);
  await assert.rejects(() => w2.backend.mouseDown('back'), /Unknown mouse button/);
});

// ------------------------------------------------------------------ the pointer wakes up at its second motion

test('the pointer wakes up at its second motion: a click that is the first thing a session does is preceded by a step 1 px left and straight back', async () => {
  const w = world();
  await w.backend.click('left');
  assert.deepStrictEqual(w.log, [['open', 0, 0, 1366, 768], ...NUDGE, ['btn', 0x110, true], S(T.clickHold), ['btn', 0x110, false]]);
  assert.deepStrictEqual(NUDGE[0].slice(1).concat(NUDGE[2].slice(1)), [-1, 0, 1, 0], 'left first, so a pointer in the top-left corner never re-enters the hot corner');
  w.log.length = 0;
  await w.backend.click('right');
  assert.deepStrictEqual(events(w.log).map((e) => e[0]), ['btn', 'btn'], 'the same session is awake now: no second step');
  await w.backend.click('left', { double: true });
  assert.deepStrictEqual(events(w.log).filter((e) => e[0] === 'rel'), [], 'nor for a double click');
});

test('...a session that has had two moves (moveTo sends two) needs no step; neither does a drag, which moves first', async () => {
  const w = world();
  await w.backend.moveTo(50, 50);
  w.log.length = 0;
  await w.backend.click('left');
  assert.deepStrictEqual(events(w.log).map((e) => e[0]), ['btn', 'btn']);
  const w2 = world();
  await w2.backend.drag({ x: 10, y: 10 }, { x: 100, y: 10 });
  assert.deepStrictEqual(events(w2.log).filter((e) => e[0] === 'rel'), []);
  const w3 = world();
  await w3.backend.moveTo(1, 1); await w3.backend.scroll(0, 2); await w3.backend.mouseDown('left');
  assert.deepStrictEqual(events(w3.log).filter((e) => e[0] === 'rel'), [], 'scrolling and pressing after a move need none either');
});

test('...ONE move is not enough (measured): after a single moveBy the step is still sent, before the click, and the click is not moved', async () => {
  const w = world();
  await w.backend.moveBy(5, 5);
  await w.backend.click('left');
  assert.deepStrictEqual(events(w.log).slice(1).map((e) => e.join(':')), ['rel:5:5', 'rel:-1:0', 'rel:1:0', 'btn:272:true', 'btn:272:false']);
  const w2 = world();
  await w2.backend._exclusive(() => w2.backend._abs(10, 10));                  // one absolute move on its own is not enough either
  await w2.backend.click('left');
  assert.deepStrictEqual(events(w2.log).slice(1).map((e) => e[0]), ['abs', 'rel', 'rel', 'btn', 'btn']);
  const w3 = world();
  await w3.backend.moveBy(5, 5); await w3.backend.moveBy(-5, -5);              // two moves of any kind wake it
  await w3.backend.click('left');
  assert.deepStrictEqual(events(w3.log).slice(1).map((e) => e.join(':')), ['rel:5:5', 'rel:-5:-5', 'btn:272:true', 'btn:272:false']);
});

test('...a scroll as the first thing a session does gets the step too (that is "scroll where the pointer is" at the start of a task), before the wheel priming', async () => {
  const w = world();
  await w.backend.scroll(0, 2);
  assert.deepStrictEqual(events(w.log).slice(1).map((e) => e[0]), ['rel', 'rel', 'axis', 'disc']);
  const w2 = world();
  await w2.backend.scroll(2, 3);                                                // both axes: one step for the whole scroll
  assert.strictEqual(events(w2.log).filter((e) => e[0] === 'rel').length, 2);
});

test('...typing, shortcuts and letting go never get the step; a NEW session starts cold again and gets it again', async () => {
  const w = world();
  await w.backend.typeText('ab');
  await w.backend.pressKeys(parseCombo('ctrl+a'));
  await w.backend.mouseUp('left');
  assert.deepStrictEqual(events(w.log).filter((e) => e[0] === 'rel'), []);
  await w.backend.click('left');
  assert.strictEqual(events(w.log).filter((e) => e[0] === 'rel').length, 2, 'the first pointer event of the session gets it, whatever came before from the keyboard');
  await w.backend.close();
  w.log.length = 0;
  await w.backend.click('left');
  assert.deepStrictEqual(events(w.log).map((e) => e[0]), ['open', 'rel', 'rel', 'btn', 'btn']);
});

test('...the step is part of the event: a vanished session is replaced once; the person pressing Stop right then is reported as the person; the emergency stop sends nothing at all', async () => {
  const w = world();
  let n = 0;
  w.fail = (name) => { if (name === 'rel' && ++n === 1) return GONE(); return null; };
  await w.backend.click('left');
  assert.deepStrictEqual(events(w.log).map((e) => e[0]), ['open', 'open', 'rel', 'rel', 'btn', 'btn']);
  assert.strictEqual(w.stops, 0);
  const w2 = world();
  w2.fail = (name, a, s) => { if (name === 'rel') { s.emitClosed(); return GONE(); } return null; };
  await assert.rejects(() => w2.backend.click('left'), (e) => e.userStopped === true && !e.unavailable);
  assert.strictEqual(w2.stops, 1);
  assert.strictEqual(w2.opens, 1, 'no new session after the person stopped it');
  const w5 = world();
  let k = 0;
  w5.fail = (name, a, s) => { if (name !== 'rel') return null; k++; if (k === 1) return GONE(); if (k === 2) { s.emitClosed(); return GONE(); } return null; };
  await assert.rejects(() => w5.backend.click('left'), (e) => e.userStopped === true && !e.unavailable);
  assert.strictEqual(w5.stops, 1, 'the person stopping it during the step of the RETRY is the person, not a failed service');
  const w3 = world();
  w3.cancel = true;
  await assert.rejects(() => w3.backend.click('left'), new RegExp(STOPPED_MESSAGE));
  assert.deepStrictEqual(w3.log, []);
  const w4 = world();
  w4.fail = (name) => (name === 'rel' ? new Error('boom') : null);
  await assert.rejects(() => w4.backend.click('left'), /GNOME remote input failed: boom/);
  assert.deepStrictEqual(events(w4.log).filter((e) => e[0] === 'btn'), [], 'a failed step stops the click');
});

// ------------------------------------------------------------------ drag

test('a drag: place, press, glide in steps (distance / 30, 6 to 40), arrive, release', async () => {
  const w = world();
  await w.backend.drag({ x: 10, y: 10 }, { x: 310, y: 10 });
  const expected = [['open', 0, 0, 1366, 768], ['abs', 10, 10], S(70), ['abs', 10, 10], S(40), ['btn', 0x110, true], S(T.dragGrab)];
  for (let i = 1; i <= 10; i++) expected.push(['abs', 10 + 30 * i, 10], S(T.dragStep));
  expected.push(['abs', 310, 10], S(T.dragEnd), ['btn', 0x110, false]);
  assert.deepStrictEqual(w.log, expected);
  const steps = async (dx) => { const x = world(); await x.backend.drag({ x: 0, y: 0 }, { x: dx, y: 0 }); return events(x.log).filter((e) => e[0] === 'abs').length - 2 - 1; };
  assert.strictEqual(await steps(10), 6, 'a short drag still glides');
  assert.strictEqual(await steps(3000), 40, 'a long one is capped');
});

test('a drag with the right button, and with a picture size, maps both ends', async () => {
  const w = world({ desktop: { x: 0, y: 0, width: 1280, height: 720, scale: 2 } });
  await w.backend.drag({ x: 100, y: 100 }, { x: 200, y: 100 }, { button: 'right', space: { width: 1280, height: 720 } });
  const e = events(w.log);
  assert.deepStrictEqual(e.filter((x) => x[0] === 'btn'), [['btn', 0x111, true], ['btn', 0x111, false]]);
  assert.deepStrictEqual(e.filter((x) => x[0] === 'abs')[0], ['abs', 200, 200]);
  assert.deepStrictEqual(e.filter((x) => x[0] === 'abs').pop(), ['abs', 400, 200]);
});

test('a drag that fails half-way still lets go of the button', async () => {
  const w = world();
  w.fail = (n, a) => (n === 'abs' && a[0] === 130 ? new Error('boom') : null);
  await assert.rejects(() => w.backend.drag({ x: 10, y: 10 }, { x: 310, y: 10 }), /GNOME remote input failed: boom/);
  mustBeBalanced(w.log, 'a failed drag');
  assert.deepStrictEqual(events(w.log).pop(), ['btn', 0x110, false]);
});

test('an emergency stop in the middle of a drag lets go of the button too (the stop must not strand it)', async () => {
  const w = world();
  w.fail = (n, a) => { if (n === 'abs' && a[0] >= 100) w.cancel = true; return null; };
  await assert.rejects(() => w.backend.drag({ x: 10, y: 10 }, { x: 310, y: 10 }), new RegExp(STOPPED_MESSAGE));
  mustBeBalanced(w.log, 'a drag stopped half-way');
  assert.strictEqual(w.opens, 1, 'releasing did not open another session');
});

// ------------------------------------------------------------------ scrolling

test('scroll: a speck of smooth scrolling first (so an X11 window counts the first notch), then whole notches; down is positive', async () => {
  const w = world();
  await w.backend.scroll(0, 3);
  assert.deepStrictEqual(w.log, [['open', 0, 0, 1366, 768], ...NUDGE, ['axis', 0, 0.05, 1], S(30), ['disc', 0, 3]]);
  w.log.length = 0;
  await w.backend.scroll(0, -2);
  assert.deepStrictEqual(w.log, [['axis', 0, -0.05, 1], S(30), ['disc', 0, -2]]);
});

test('scroll sideways uses the other axis; both directions go vertical first, each with its own priming', async () => {
  const w = world();
  await w.backend.scroll(2, 0);
  assert.deepStrictEqual(events(w.log).slice(3), [['axis', 0.05, 0, 1], ['disc', 1, 2]], 'after the open and the two-motion step');
  w.log.length = 0;
  await w.backend.scroll(-1, 4);
  assert.deepStrictEqual(events(w.log), [['axis', 0, 0.05, 1], ['disc', 0, 4], ['axis', -0.05, 0, 1], ['disc', 1, -1]]);
});

test('scroll: long runs go in chunks of 10 with a short gap, and are capped at 100 notches', async () => {
  const w = world();
  await w.backend.scroll(0, 25);
  assert.deepStrictEqual(w.log.slice(1 + NUDGE.length), [['axis', 0, 0.05, 1], S(30), ['disc', 0, 10], S(25), ['disc', 0, 10], S(25), ['disc', 0, 5]]);
  const w2 = world();
  await w2.backend.scroll(0, -150);
  const discs = events(w2.log).filter((e) => e[0] === 'disc');
  assert.strictEqual(discs.length, 10);
  assert.strictEqual(discs.reduce((a, e) => a + e[2], 0), -100);
});

test('scroll of less than half a notch sends nothing', async () => {
  const w = world();
  await w.backend.scroll(0.4, 0.4);
  assert.deepStrictEqual(events(w.log), []);
});

// ------------------------------------------------------------------ typing

test('the first key of a session is spent on a Shift tap; later keys are not primed; a new session primes again', async () => {
  const w = world();
  await w.backend.typeText('ab', { delayMs: 12 });
  assert.deepStrictEqual(w.log, [
    ['open', 0, 0, 1366, 768],
    ['key', 42, true], ['key', 42, false], S(30),
    ['sym', 97, true], S(6), ['sym', 97, false], S(12),
    ['sym', 98, true], S(6), ['sym', 98, false], S(12),
  ]);
  w.log.length = 0;
  await w.backend.typeText('c');
  assert.deepStrictEqual(downs(w.log), ['c'], 'the second action is not primed');
  await w.backend.close();
  w.log.length = 0;
  await w.backend.typeText('d');
  assert.deepStrictEqual(downs(w.log), ['<Shift>', 'd'], 'a NEW session loses its first key again');
});

test('pointer events never prime the keyboard, and the prime happens inside the session that is already open', async () => {
  const w = world();
  await w.backend.moveTo(5, 5); await w.backend.click('left');
  assert.deepStrictEqual(downs(w.log), []);
  await w.backend.typeText('x');
  assert.deepStrictEqual(downs(w.log), ['<Shift>', 'x']);
  assert.strictEqual(w.opens, 1);
});

test('typing: Enter and Tab are key positions, letters are keysyms (the character itself), one pause per key', async () => {
  const w = world();
  await w.backend.typeText('a\nb\tc', { delayMs: 0 });
  assert.deepStrictEqual(downs(w.log), ['<Shift>', 'a', '<Enter>', 'b', '<Tab>', 'c']);
  assert.deepStrictEqual(events(w.log).filter((e) => e[0] === 'sym' && e[2]).map((e) => e[1]), [0x61, 0x62, 0x63]);
  mustBeBalanced(w.log, 'typing');
});

test('typing keeps ASCII punctuation as keysyms (the characters, whatever the layout puts them on)', async () => {
  const w = world();
  await w.backend.typeText('@\\[{|~');
  assert.deepStrictEqual(events(w.log).filter((e) => e[0] === 'sym' && e[2]).map((e) => e[1]), [0x40, 0x5c, 0x5b, 0x7b, 0x7c, 0x7e]);
});

test('an odd delay is treated as none', async () => {
  const w = world();
  await w.backend.typeText('ab', { delayMs: -5 });
  await w.backend.typeText('c', { delayMs: 'soon' });
  assert.ok(!w.log.some((e) => e[0] === 'sleep' && (e[1] < 0 || Number.isNaN(e[1]))));
});

test('a character the layout cannot make is pasted: the whole choreography, and the clipboard comes back', async () => {
  const w = world();
  const r = await w.backend.typeText('é');
  assert.deepStrictEqual(w.log, [
    ['clip', 'é'], S(T.pasteSettle),
    ['open', 0, 0, 1366, 768], ['key', 42, true], ['key', 42, false], S(30),
    ['key', 29, true], S(15), ['key', 47, true], S(15), S(40),
    ['key', 47, false], S(15), ['key', 29, false], S(15),
    S(T.pasteWait), S(T.pasteRestore), ['clip', 'before'],
  ]);
  assert.deepStrictEqual(r.notes, ['1 character(s) the keyboard cannot type were pasted with Ctrl+V']);
  assert.strictEqual(w.clipboard.text, 'before');
});

test('letters before and after a pasted character are typed, the pasted piece in between', async () => {
  const w = world();
  await w.backend.typeText('café ok');
  assert.deepStrictEqual(events(w.log).filter((e) => e[0] === 'clip' || (e[0] === 'sym' && e[2])).map((e) => (e[0] === 'clip' ? `[${e[1]}]` : String.fromCharCode(e[1]))), ['c', 'a', 'f', '[é]', ' ', 'o', 'k', '[before]']);
});

test('in a terminal the paste shortcut is Ctrl+Shift+V', async () => {
  const w = world();
  const r = await w.backend.typeText('₹', { pasteKeys: 'ctrl+shift+v' });
  assert.deepStrictEqual(downs(w.log), ['<Shift>', '<Ctrl>', '<Shift>', '<V>']);
  assert.match(r.notes[0], /Ctrl\+Shift\+V/);
  mustBeBalanced(w.log, 'a terminal paste');
});

test('the clipboard that was there is put back; an empty one is cleared; a non-text one is reported lost', async () => {
  const w = world({ clip: { text: '' } });
  await w.backend.typeText('é');
  assert.deepStrictEqual(events(w.log).filter((e) => e[0] === 'clip-clear').length, 1);
  assert.strictEqual(w.clipboard.text, '');
  const w2 = world({ clip: { text: 'keep', formats: ['text/plain', 'image/png'] } });
  const r = await w2.backend.typeText('é');
  assert.strictEqual(w2.clipboard.text, 'keep');
  assert.match(r.notes[0], /clipboard held something other than text, which is now gone/);
  const w3 = world({ clip: { text: 'keep', formats: ['text/plain', 'text/html'] } });
  assert.doesNotMatch((await w3.backend.typeText('é')).notes[0], /something other than text/);
});

test('a failure in the middle of a paste still releases Ctrl and still restores the clipboard', async () => {
  const w = world();
  w.fail = (n, a) => (n === 'key' && a[0] === 47 && a[1] === true ? new Error('boom') : null);
  await assert.rejects(() => w.backend.typeText('é'), /boom/);
  mustBeBalanced(w.log, 'a failed paste');
  assert.strictEqual(w.clipboard.text, 'before');
});

test('a layout that cannot type Latin letters pastes everything (and says so); the same for an input method', async () => {
  for (const layout of [{ latin: false, ime: false, id: 'ru' }, { latin: true, ime: true, id: 'ibus:anthy' }]) {
    const w = world({ layout });
    const r = await w.backend.typeText('ab\ncd');
    assert.deepStrictEqual(events(w.log).filter((e) => e[0] === 'clip').map((e) => e[1]), ['ab', 'cd', 'before'], layout.id);
    assert.ok(!events(w.log).some((e) => e[0] === 'sym'), 'no letters by keysym');
    assert.ok(r.notes.some((n) => /cannot type Latin letters, so all text was pasted/.test(n)), layout.id);
    assert.ok(downs(w.log).includes('<Enter>'));
  }
});

test('a layout with gaps (German: no plain ^ or `) types what it can and pastes only the gaps', async () => {
  const de = { latin: true, ime: false, id: 'de', missing: '^`' };
  const w = world({ layout: de });
  const r = await w.backend.typeText('a^b`c');
  assert.deepStrictEqual(events(w.log).filter((e) => e[0] === 'clip' || (e[0] === 'sym' && e[2])).map((e) => (e[0] === 'clip' ? `[${e[1]}]` : String.fromCharCode(e[1]))), ['a', '[^b`]', 'c', '[before]'],
    'the letter between two gaps is pasted along with them');
  assert.deepStrictEqual(r.notes, ['3 character(s) the keyboard cannot type were pasted with Ctrl+V'], 'no "cannot type Latin letters" note: this layout has them');
  const w2 = world({ layout: de });
  await w2.backend.typeText('plain text, no gaps');
  assert.ok(!events(w2.log).some((e) => e[0] === 'clip'), 'a text without a gap character is typed entirely');
});

test('a layout missing a single letter pastes just that letter', async () => {
  const w = world({ layout: { latin: false, ime: false, id: 'odd', missing: 'q' } });
  await w.backend.typeText('quit');
  assert.deepStrictEqual(events(w.log).filter((e) => e[0] === 'clip').map((e) => e[1]), ['q', 'before']);
  assert.strictEqual(downs(w.log).slice(1).filter((d) => d.length === 1).join(''), 'uit');
});

test('planTyping with a per-character answer: only what the layout cannot make is pasted', () => {
  const p = planTyping('ab^cdef', { canKey: (ch) => ch !== '^', canPaste: true }).segments;
  assert.deepStrictEqual(p, [{ kind: 'keys', text: 'ab' }, { kind: 'paste', text: '^' }, { kind: 'keys', text: 'cdef' }]);
  assert.match(planTyping('^', { canKey: (ch) => ch !== '^', canPaste: false }).error, /cannot be typed with the keyboard.*clipboard/, 'a layout that CAN make letters gets the short message');
  assert.match(planTyping('a', { canKey: () => false, canPaste: false }).error, /cannot type Latin letters/);
});

test('shortcut keys: one the layout can make goes by character, one it cannot goes by position (Ctrl+` on German)', async () => {
  const de = { latin: true, ime: false, id: 'de', missing: '^`' };
  const w = world({ layout: de });
  await w.backend.pressKeys(parseCombo('ctrl+grave'));
  const grave = parseCombo('grave')[0].code;
  assert.deepStrictEqual(events(w.log).filter((e) => e[2] === true).map((e) => `${e[0]}:${e[1]}`).slice(1), ['key:29', `key:${grave}`]);
  const w2 = world({ layout: de });
  await w2.backend.pressKeys(parseCombo('ctrl+slash'));
  assert.deepStrictEqual(events(w2.log).filter((e) => e[2] === true).map((e) => `${e[0]}:${e[1]}`).slice(1), ['key:29', 'sym:47'], 'a slash is makeable: by character');
});

test('without a clipboard only plain text can be entered, and a refusal sends nothing at all', async () => {
  const w = world({ clipboard: false });
  assert.strictEqual(w.backend.info().unicode, false);
  await assert.rejects(() => w.backend.typeText('naïve'), /clipboard/);
  assert.deepStrictEqual(w.log, []);
  assert.strictEqual(w.opens, 0);
  await w.backend.typeText('plain');
  assert.strictEqual(downs(w.log).slice(1).join(''), 'plain');
  assert.strictEqual(world().backend.info().unicode, true);
});

test('the keyboard layout is read once per few seconds, not for every action, and a failed read means a plain US layout', async () => {
  const w = world();
  await w.backend.typeText('a'); await w.backend.typeText('b');
  assert.strictEqual(w.layoutReads, 1);
  w.clock += 5000;
  w.layout = { latin: false, ime: false, id: 'ru' };
  await w.backend.typeText('c');
  assert.strictEqual(w.layoutReads, 2);
  assert.ok(events(w.log).some((e) => e[0] === 'clip' && e[1] === 'c'), 'the changed layout is noticed after the cache expires');
  const w2 = world({ layout: new Error('gsettings missing') });
  await w2.backend.typeText('ok');
  assert.strictEqual(downs(w2.log).slice(1).join(''), 'ok');
});

// ------------------------------------------------------------------ key combinations

test('Ctrl+C on a Latin layout: Ctrl by position, the letter by keysym; released in reverse', async () => {
  const w = world();
  await w.backend.pressKeys(parseCombo('ctrl+c'));
  assert.deepStrictEqual(w.log, [
    ['open', 0, 0, 1366, 768], ['key', 42, true], ['key', 42, false], S(30),
    ['key', 29, true], S(15), ['sym', 0x63, true], S(15), S(40),
    ['sym', 0x63, false], S(15), ['key', 29, false], S(15),
  ]);
});

test('on a layout without Latin letters shortcuts go by key position, so Ctrl+C is still the key where C is on a US keyboard', async () => {
  const w = world({ layout: { latin: false, ime: false, id: 'ru' } });
  await w.backend.pressKeys(parseCombo('ctrl+c'));
  assert.deepStrictEqual(downs(w.log), ['<Shift>', '<Ctrl>', '<C>']);
  assert.ok(!events(w.log).some((e) => e[0] === 'sym'));
});

test('keys with no character (Enter, F-keys, arrows) always go by position; modifiers too', async () => {
  const w = world();
  await w.backend.pressKeys(parseCombo('alt+f4'));
  const [alt, f4] = parseCombo('alt+f4');
  assert.deepStrictEqual(events(w.log).filter((e) => e[0] === 'key' && e[2]).map((e) => e[1]), [42, alt.code, f4.code]);
  const w2 = world();
  await w2.backend.pressKeys(parseCombo('enter'));
  assert.deepStrictEqual(downs(w2.log), ['<Shift>', '<Enter>']);
  const w3 = world();
  await w3.backend.pressKeys(parseCombo('ctrl+shift+t'));
  assert.deepStrictEqual(events(w3.log).filter((e) => e[2] === true).map((e) => `${e[0]}:${e[1]}`).slice(1), ['key:29', 'key:42', 'sym:116']);
});

test('a combination that fails part-way lets go of what it pressed', async () => {
  const w = world();
  w.fail = (n, a) => (n === 'sym' && a[1] === true ? new Error('boom') : null);
  await assert.rejects(() => w.backend.pressKeys(parseCombo('ctrl+shift+t')), /boom/);
  mustBeBalanced(w.log, 'a failed combination');
});

// ------------------------------------------------------------------ the emergency stop

test('with the emergency stop engaged nothing is sent and no session is opened (no sharing indicator for a stopped agent)', async () => {
  const w = world();
  w.cancel = true;
  const acts = [
    () => w.backend.moveTo(1, 1), () => w.backend.moveBy(1, 1), () => w.backend.click('left'), () => w.backend.scroll(0, 3),
    () => w.backend.typeText('abc'), () => w.backend.pressKeys(parseCombo('ctrl+c')), () => w.backend.drag({ x: 1, y: 1 }, { x: 9, y: 9 }),
  ];
  for (const a of acts) await assert.rejects(a, new RegExp(STOPPED_MESSAGE));
  assert.deepStrictEqual(w.log, []);
  assert.strictEqual(w.opens, 0);
});

test('an emergency stop in the middle of typing stops at the next key and nothing is left pressed', async () => {
  const w = world();
  w.fail = (n, a) => { if (n === 'sym' && a[1] === true && a[0] === 0x63) w.cancel = true; return null; };
  await assert.rejects(() => w.backend.typeText('abcdef'), new RegExp(STOPPED_MESSAGE));
  assert.strictEqual(downs(w.log).slice(1).join(''), 'abc');
  mustBeBalanced(w.log, 'a stopped typing run');
});

test('an emergency stop between the press and the release of a click still releases', async () => {
  const w = world();
  w.onSleep = (ms) => { if (ms === T.clickHold) w.cancel = true; };
  await w.backend.click('left');
  mustBeBalanced(w.log, 'a click');
});

test('even if waiting itself fails between press and release, the release still goes out', async () => {
  const w = world();
  w.onSleep = (ms) => { if (ms === T.clickHold) throw new Error('timer broke'); };
  await assert.rejects(() => w.backend.click('left'), /timer broke/);
  mustBeBalanced(w.log, 'a click whose pause failed');
  const w2 = world();
  w2.onSleep = (ms) => { if (ms === T.keyHold) throw new Error('timer broke'); };
  await assert.rejects(() => w2.backend.typeText('a'), /timer broke/);
  mustBeBalanced(w2.log, 'a key whose pause failed');
});

test('a stopped agent does not even touch the clipboard', async () => {
  const w = world();
  w.cancel = true;
  await assert.rejects(() => w.backend.typeText('é'), new RegExp(STOPPED_MESSAGE));
  assert.deepStrictEqual(w.log, []);
  assert.strictEqual(w.clipboard.text, 'before');
});

test('an input method (IME) layout presses shortcuts by position too, not by letter', async () => {
  const w = world({ layout: { latin: true, ime: true, id: 'ibus:anthy' } });
  await w.backend.pressKeys(parseCombo('ctrl+c'));
  assert.deepStrictEqual(downs(w.log), ['<Shift>', '<Ctrl>', '<C>']);
  assert.ok(!events(w.log).some((e) => e[0] === 'sym'));
});

// ------------------------------------------------------------------ the session: reconnect, stop, idle, screens

test('a session that vanished is replaced and the event is sent again once (the Shell restarted)', async () => {
  const w = world();
  await w.backend.click('left');
  w.sessions[0].closed = true;                            // gone, with no signal
  w.log.length = 0;
  await w.backend.click('left');
  assert.strictEqual(w.opens, 2);
  assert.deepStrictEqual(events(w.log), [['open', 0, 0, 1366, 768], ['rel', -1, 0], ['rel', 1, 0], ['btn', 0x110, true], ['btn', 0x110, false]], 'the new session is cold again');
  assert.strictEqual(w.stops, 0, 'that was not the person stopping it');
});

test('the person stopping it during the RETRY is also reported as "stopped" (not as a failed service)', async () => {
  const w = world();
  await w.backend.moveTo(1, 1);
  let n = 0;
  w.fail = (name, a, s) => { if (name !== 'btn') return null; n++; if (n === 1) return GONE(); if (n === 2) { s.emitClosed(); return GONE(); } return null; };
  await assert.rejects(() => w.backend.click('left'), (e) => e.userStopped === true && !e.unavailable);
  assert.strictEqual(w.stops, 1);
});

test('two callers asking for the session at the same moment get ONE session', async () => {
  const w = world();
  const [a, b] = await Promise.all([w.backend._ensure(), w.backend._ensure()]);
  assert.strictEqual(a, b);
  assert.strictEqual(w.opens, 1);
});

test('a late Closed signal from a session we already replaced is not the person stopping anything', async () => {
  const w = world();
  await w.backend.click('left');
  w.sessions[0].closed = true;
  await w.backend.click('left');                           // replaced
  assert.strictEqual(w.opens, 2);
  w.sessions[0].closed = false; w.sessions[0].emitClosed(); // the old one finally says Closed
  assert.strictEqual(w.stops, 0);
  await w.backend.click('left');                           // input still works
  assert.strictEqual(w.opens, 2);
});

test('the person stopping it just as an event goes out: the answer is "stopped", not a generic failure, and nothing is retried', async () => {
  const w = world();
  await w.backend.moveTo(1, 1);
  w.fail = (n) => { if (n === 'btn') { w.sessions[0].emitClosed(); return GONE(); } return null; };
  await assert.rejects(() => w.backend.click('left'), (e) => e.userStopped === true);
  assert.strictEqual(w.opens, 1);
  assert.strictEqual(w.stops, 1);
});

test('a service that keeps failing is reported after one retry, flagged so that auto mode can switch to ydotool', async () => {
  const w = world();
  w.fail = () => GONE();
  await assert.rejects(() => w.backend.click('left'), (e) => e.unavailable === true && /GNOME remote input failed/.test(e.message));
  assert.strictEqual(w.opens, 2, 'one retry, not a loop');
});

test('an ordinary error is reported as it is: no retry, not flagged as unavailable', async () => {
  const w = world();
  w.fail = (n) => (n === 'disc' ? Object.assign(new Error('Invalid axis steps value'), { type: 'org.freedesktop.DBus.Error.InvalidArgs', text: 'Invalid axis steps value' }) : null);
  await assert.rejects(() => w.backend.scroll(0, 2), (e) => /Invalid axis steps value/.test(e.message) && !e.unavailable);
  assert.strictEqual(w.opens, 1);
});

test('when the person stops sharing from the top bar: onUserStop runs once, later actions say so, and a new task resumes', async () => {
  const w = world();
  await w.backend.moveTo(1, 1);
  w.sessions[0].emitClosed();                             // the Closed signal, not caused by us
  assert.strictEqual(w.stops, 1);
  await assert.rejects(() => w.backend.click('left'), (e) => e.userStopped === true && /stopped remote input from the screen-sharing indicator/.test(e.message));
  await assert.rejects(() => w.backend.typeText('a'), (e) => e.userStopped === true);
  assert.strictEqual(w.opens, 1, 'no new session while the person has said stop');
  w.backend.resume();
  await w.backend.click('left');
  assert.strictEqual(w.opens, 2);
});

test('the person stopping it in the middle of a click is reported, not retried behind their back', async () => {
  const w = world();
  w.onSleep = (ms) => { if (ms === T.clickHold) w.sessions[0].emitClosed(); };
  await w.backend.click('left');
  assert.strictEqual(w.stops, 1);
  assert.strictEqual(w.opens, 1, 'nothing was reopened to send a release into');
  await assert.rejects(() => w.backend.click('left'), (e) => e.userStopped === true);
});

test('closing it ourselves is not the person stopping it', async () => {
  const w = world();
  await w.backend.moveTo(1, 1);
  await w.backend.close();
  assert.strictEqual(w.stops, 0);
  assert.ok(w.log.some((e) => e[0] === 'stop'));
  await w.backend.click('left');                           // reopens
  assert.strictEqual(w.opens, 2);
});

test('an idle session is closed after 45 seconds (so the sharing indicator goes away); every event re-arms the timer', async () => {
  const w = world();
  await w.backend.click('left');
  assert.strictEqual(w.live().length, 1, 'one timer pending, the earlier ones cleared');
  assert.strictEqual(w.live()[0].ms, 45000);
  await w.backend.moveTo(3, 3);
  assert.strictEqual(w.live().length, 1);
  w.live()[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.ok(w.log.some((e) => e[0] === 'stop'));
  assert.strictEqual(w.stops, 0, 'the idle close is ours');
  w.log.length = 0;
  await w.backend.moveTo(3, 3);
  assert.strictEqual(w.log[0][0], 'open');
});

test('when the screens change the session is dropped and the next one is opened with the new shape', async () => {
  const w = world();
  await w.backend.moveTo(1, 1);
  assert.strictEqual(w.displayCbs.length, 1, 'the backend listens for screen changes');
  w.desktop = { x: 0, y: 0, width: 1920, height: 1080, scale: 1 };
  w.displayCbs[0]();
  await new Promise((r) => setImmediate(r));
  assert.ok(w.log.some((e) => e[0] === 'stop'));
  assert.strictEqual(w.stops, 0);
  w.log.length = 0;
  await w.backend.moveTo(1900, 1000);
  assert.deepStrictEqual(w.log[0], ['open', 0, 0, 1920, 1080]);
  assert.deepStrictEqual(events(w.log).filter((e) => e[0] === 'abs')[0], ['abs', 1900, 1000]);
});

test('actions never interleave: a click, typing and a move started together happen one after the other', async () => {
  const w = world();
  await Promise.all([w.backend.click('left'), w.backend.typeText('ab'), w.backend.moveTo(5, 5)]);
  assert.deepStrictEqual(events(w.log).slice(1).map((e) => e[0]), ['rel', 'rel', 'btn', 'btn', 'key', 'key', 'sym', 'sym', 'sym', 'sym', 'abs', 'abs']);
  mustBeBalanced(w.log, 'concurrent actions');
});

test('a failed action does not block the ones queued behind it', async () => {
  const w = world();
  w.fail = (n, a) => (n === 'btn' && a[1] === true ? new Error('boom') : null);
  const p1 = w.backend.click('left');
  const p2 = w.backend.moveTo(7, 7);
  await assert.rejects(p1, /boom/);
  await p2;
  assert.deepStrictEqual(events(w.log).filter((e) => e[0] === 'abs')[0], ['abs', 7, 7]);
});

// ------------------------------------------------------------------ availability

test('ready() says so, flagged unavailable, when GNOME has no remote-input service; and asks again next time', async () => {
  const w = world();
  w.available = { ok: false, reason: 'the GNOME remote-input service is not running (this is not a GNOME Wayland session)' };
  await assert.rejects(() => w.backend.ready(), (e) => e.unavailable === true && /not a GNOME Wayland session/.test(e.message));
  w.available = { ok: true };
  await w.backend.ready();
  assert.strictEqual(w.opens, 1);
});

test('ready() twice at once opens one session', async () => {
  const w = world();
  await Promise.all([w.backend.ready(), w.backend.ready()]);
  assert.strictEqual(w.opens, 1);
});

test('a session that cannot be opened (PipeWire missing) is an unavailable error that reaches the caller as it is', async () => {
  const w = world();
  w.openFail = new InputUnavailable('PipeWire is not running, which GNOME needs for its remote-input service');
  await assert.rejects(() => w.backend.click('left'), (e) => e.unavailable === true && /PipeWire/.test(e.message));
  await assert.rejects(() => w.backend.moveTo(1, 1), (e) => e.unavailable === true);
  w.openFail = null;
  await w.backend.moveTo(1, 1);
  assert.strictEqual(w.opens, 1);
});

test('info() and capabilities() describe this way of sending', async () => {
  const w = world();
  assert.deepStrictEqual(w.backend.info(), { name: 'gnome', label: 'GNOME direct input (no setup needed)', unicode: true, scroll: true, drag: true });
  assert.deepStrictEqual(await w.backend.capabilities(), w.backend.info());
});

test('dispose() closes the session and the connection', async () => {
  const w = world();
  await w.backend.moveTo(1, 1);
  await w.backend.dispose();
  assert.ok(w.log.some((e) => e[0] === 'stop'));
  assert.strictEqual(w.transportClosed, true);
  assert.strictEqual(w.live().length, 0, 'no idle timer left running');
});
