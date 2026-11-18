'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MutterTransport, MutterSession, InputUnavailable, parseDisplayState, isSessionGone, describeOpenError } = require('../src/main/computer/mutter-transport');

// ---------------------------------------------------------------- a fake of the D-Bus library, shaped like the real GNOME service

const RD = ['org.gnome.Mutter.RemoteDesktop', '/org/gnome/Mutter/RemoteDesktop'];
const SC = ['org.gnome.Mutter.ScreenCast', '/org/gnome/Mutter/ScreenCast'];
const DC = ['org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig'];
const RD_SESSION_PATH = '/org/gnome/Mutter/RemoteDesktop/Session/u1';
const SC_SESSION_PATH = '/org/gnome/Mutter/ScreenCast/Session/u1';
const STREAM_PATH = '/org/gnome/Mutter/ScreenCast/Stream/u1';

class Variant { constructor(signature, value) { this.signature = signature; this.value = value; } }

function fakeDbus({ nameHasOwner = true, state = null, fail = {}, onStart = null } = {}) {
  const calls = [];                     // [path, method, ...args], in order
  const listeners = {};                 // `${path}|${signal}` -> [fn]
  const emit = (path, sig) => (listeners[`${path}|${sig}`] || []).forEach((f) => f());
  const iface = (path, impl) => {
    const o = { on(sig, cb) { (listeners[`${path}|${sig}`] = listeners[`${path}|${sig}`] || []).push(cb); } };
    return new Proxy(o, {
      get(t, p) {
        if (p in t) return t[p];
        if (p === 'then' || typeof p === 'symbol') return undefined;     // the real interface objects are not thenable
        return async (...args) => {
          calls.push([path, p, ...args]);
          if (fail[p]) throw fail[p];
          if (!impl[p]) throw Object.assign(new Error(`unexpected call ${String(p)}`), { type: 'org.freedesktop.DBus.Error.UnknownMethod' });
          return impl[p](...args);
        };
      },
    });
  };
  const objects = {
    '/org/freedesktop/DBus': { 'org.freedesktop.DBus': iface('/org/freedesktop/DBus', { NameHasOwner: async () => nameHasOwner }) },
    [RD[1]]: { [RD[0]]: iface(RD[1], { CreateSession: async () => RD_SESSION_PATH }) },
    [RD_SESSION_PATH]: {
      'org.gnome.Mutter.RemoteDesktop.Session': iface(RD_SESSION_PATH, {
        ...Object.fromEntries(['Stop', 'NotifyPointerMotionAbsolute', 'NotifyPointerMotionRelative', 'NotifyPointerButton', 'NotifyPointerAxis',
          'NotifyPointerAxisDiscrete', 'NotifyKeyboardKeycode', 'NotifyKeyboardKeysym'].map((m) => [m, async () => {}])),
        Start: async () => { if (onStart) onStart(emit); },
      }),
      'org.freedesktop.DBus.Properties': iface(RD_SESSION_PATH, { Get: async (i, n) => new Variant('s', n === 'SessionId' ? 'session-id-42' : '') }),
    },
    [SC[1]]: { [SC[0]]: iface(SC[1], { CreateSession: async () => SC_SESSION_PATH }) },
    [SC_SESSION_PATH]: { 'org.gnome.Mutter.ScreenCast.Session': iface(SC_SESSION_PATH, { RecordArea: async () => STREAM_PATH }) },
    [DC[1]]: { [DC[0]]: iface(DC[1], { GetCurrentState: async () => state }) },
  };
  const bus = {
    on() {}, disconnect() { calls.push(['bus', 'disconnect']); },
    async getProxyObject(name, path) {
      const o = objects[path];
      if (!o) throw new Error(`no such object ${path}`);
      return { getInterface: (i) => o[i] };
    },
  };
  return { sessionBus: () => bus, Variant, calls, emit, listeners };
}

// ---------------------------------------------------------------- DisplayConfig fixtures: shapes measured on a real GNOME Shell 46

const yes = { signature: 'b', value: true };
const mode = (id, w, h, { current = true, scales = [1] } = {}) => [id, w, h, 60, 1, scales, current ? { 'is-current': yes, 'is-preferred': yes } : {}];
const monitor = (conn, ...modes) => [[conn, 'MetaVendor', 'MetaVirtualMonitor', '0x00'], modes, {}];
const logical = (x, y, scale, transform, ...conns) => [x, y, scale, transform, x === 0, conns.map((c) => [c, 'MetaVendor', 'MetaVirtualMonitor', '0x00']), {}];
const stateOf = (monitors, logicals) => [2, monitors, logicals, {}];

test('parseDisplayState: one screen at 100% is its own size', () => {
  const d = parseDisplayState(stateOf([monitor('Meta-0', mode('1366x768@60', 1366, 768))], [logical(0, 0, 1, 0, 'Meta-0')]));
  assert.deepStrictEqual({ x: d.x, y: d.y, width: d.width, height: d.height, scale: d.scale }, { x: 0, y: 0, width: 1366, height: 768, scale: 1 });
});

test('parseDisplayState: at 200% the LOGICAL size is half the mode (what the Shell itself reported: 1280x720 for 2560x1440)', () => {
  const d = parseDisplayState(stateOf([monitor('Meta-0', mode('2560x1440@60', 2560, 1440))], [logical(0, 0, 2, 0, 'Meta-0')]));
  assert.deepStrictEqual({ width: d.width, height: d.height, scale: d.scale }, { width: 1280, height: 720, scale: 2 });
});

test('parseDisplayState: fractional scales (measured: 1.25 -> 2048x1152, 1.495 -> 1712x963)', () => {
  const m = [monitor('Meta-0', mode('2560x1440@60', 2560, 1440, { scales: [1, 1.25, 1.495327115058899] }))];
  const a = parseDisplayState(stateOf(m, [logical(0, 0, 1.25, 0, 'Meta-0')]));
  assert.deepStrictEqual([a.width, a.height], [2048, 1152]);
  const b = parseDisplayState(stateOf(m, [logical(0, 0, 1.495327115058899, 0, 'Meta-0')]));
  assert.deepStrictEqual([b.width, b.height], [1712, 963]);
});

test('parseDisplayState: two screens side by side make one wide desktop (measured 2390x768)', () => {
  const d = parseDisplayState(stateOf(
    [monitor('Meta-0', mode('a', 1366, 768)), monitor('Meta-1', mode('b', 1024, 768))],
    [logical(0, 0, 1, 0, 'Meta-0'), logical(1366, 0, 1, 0, 'Meta-1')]));
  assert.deepStrictEqual([d.x, d.y, d.width, d.height], [0, 0, 2390, 768]);
  assert.strictEqual(d.monitors.length, 2);
});

test('parseDisplayState: the biggest scale wins when screens differ (the screenshot is taken at that scale)', () => {
  const d = parseDisplayState(stateOf(
    [monitor('A', mode('a', 1920, 1080)), monitor('B', mode('b', 3840, 2160))],
    [logical(0, 0, 1, 0, 'A'), logical(1920, 0, 2, 0, 'B')]));
  assert.strictEqual(d.scale, 2);
  assert.deepStrictEqual([d.width, d.height], [1920 + 1920, 1080]);
});

test('parseDisplayState: a screen turned 90 degrees swaps width and height', () => {
  const d = parseDisplayState(stateOf([monitor('Meta-0', mode('a', 1920, 1080))], [logical(0, 0, 1, 1, 'Meta-0')]));
  assert.deepStrictEqual([d.width, d.height], [1080, 1920]);
  const e = parseDisplayState(stateOf([monitor('Meta-0', mode('a', 1920, 1080))], [logical(0, 0, 1, 2, 'Meta-0')]));
  assert.deepStrictEqual([e.width, e.height], [1920, 1080], '180 degrees does not swap');
  const f = parseDisplayState(stateOf([monitor('Meta-0', mode('a', 1920, 1080))], [logical(0, 0, 1, 7, 'Meta-0')]));
  assert.deepStrictEqual([f.width, f.height], [1080, 1920], 'flipped-270 does');
});

test('parseDisplayState: mirrored screens (two monitors on one logical monitor) count once', () => {
  const d = parseDisplayState(stateOf([monitor('A', mode('a', 1920, 1080)), monitor('B', mode('b', 1920, 1080))], [logical(0, 0, 1, 0, 'A', 'B')]));
  assert.deepStrictEqual([d.width, d.height], [1920, 1080]);
  assert.strictEqual(d.monitors.length, 1);
});

test('parseDisplayState: the CURRENT mode is used, not the first one listed', () => {
  const d = parseDisplayState(stateOf([monitor('A', mode('big', 3840, 2160, { current: false }), mode('small', 1920, 1080))], [logical(0, 0, 1, 0, 'A')]));
  assert.deepStrictEqual([d.width, d.height], [1920, 1080]);
});

test('parseDisplayState: screens stacked or offset vertically make a desktop as tall as they all reach', () => {
  const stacked = parseDisplayState(stateOf(
    [monitor('A', mode('a', 1920, 1080)), monitor('B', mode('b', 1920, 1080))],
    [logical(0, 0, 1, 0, 'A'), logical(0, 1080, 1, 0, 'B')]));
  assert.deepStrictEqual([stacked.x, stacked.y, stacked.width, stacked.height], [0, 0, 1920, 2160]);
  const offset = parseDisplayState(stateOf(
    [monitor('A', mode('a', 1920, 1080)), monitor('B', mode('b', 1280, 720))],
    [logical(0, 0, 1, 0, 'A'), logical(1920, -200, 1, 0, 'B')]));
  assert.deepStrictEqual([offset.x, offset.y, offset.width, offset.height], [0, -200, 3200, 1280]);
  const lower = parseDisplayState(stateOf(
    [monitor('A', mode('a', 1280, 720)), monitor('B', mode('b', 1920, 1080))],
    [logical(0, 0, 1, 0, 'A'), logical(1280, 300, 1, 0, 'B')]));
  assert.deepStrictEqual([lower.width, lower.height], [3200, 1380], 'the lower edge is where the lowest screen ends, not how tall it is');
});

test('parseDisplayState: negative positions are kept (the area starts where the desktop starts)', () => {
  const d = parseDisplayState(stateOf([monitor('A', mode('a', 1000, 800)), monitor('B', mode('b', 1000, 800))], [logical(-1000, 0, 1, 0, 'A'), logical(0, 0, 1, 0, 'B')]));
  assert.deepStrictEqual([d.x, d.y, d.width, d.height], [-1000, 0, 2000, 800]);
});

test('parseDisplayState: nonsense gives null, never an exception', () => {
  for (const bad of [null, undefined, 5, 'x', [], [1, 2], [1, [], []], [1, [monitor('A', mode('a', 0, 0))], [logical(0, 0, 1, 0, 'A')]], [1, [monitor('A', mode('a', 10, 10))], [logical(0, 0, 1, 0, 'Z')]]]) {
    assert.strictEqual(parseDisplayState(bad), null);
  }
  // a scale of 0 or less must not divide by zero
  const d = parseDisplayState(stateOf([monitor('A', mode('a', 1920, 1080))], [logical(0, 0, 0, 0, 'A')]));
  assert.deepStrictEqual([d.width, d.height, d.scale], [1920, 1080, 1]);
});

// ---------------------------------------------------------------- the transport

const area = { x: 0, y: 0, width: 1366, height: 768 };

test('open(): the calls go in the order measured on the real service, and Closed is listened for BEFORE Start', async () => {
  const dbus = fakeDbus();
  const t = new MutterTransport({ dbus });
  const s = await t.open(area);
  assert.ok(s instanceof MutterSession);
  const names = dbus.calls.map((c) => `${c[0].split('/').pop()}:${c[1]}`);
  const order = (a) => names.findIndex((n) => n.endsWith(`:${a}`));
  assert.ok(order('CreateSession') < order('Get'), 'the session id is read after the session exists');
  const sc = dbus.calls.find((c) => c[0] === SC[1] && c[1] === 'CreateSession');
  assert.ok(sc, 'ScreenCast.CreateSession called');
  assert.strictEqual(sc[2]['remote-desktop-session-id'].value, 'session-id-42', 'the screen-cast is LINKED to the remote-desktop session');
  assert.strictEqual(sc[2]['remote-desktop-session-id'].signature, 's');
  const rec = dbus.calls.find((c) => c[1] === 'RecordArea');
  assert.deepStrictEqual(rec.slice(2, 6), [0, 0, 1366, 768]);
  assert.strictEqual(rec[6]['cursor-mode'].value, 0);
  assert.strictEqual(rec[6]['cursor-mode'].signature, 'u');
  const start = dbus.calls.findIndex((c) => c[1] === 'Start');
  assert.ok(start > dbus.calls.findIndex((c) => c[1] === 'RecordArea'), 'Start comes last');
  assert.ok((dbus.listeners[`${RD_SESSION_PATH}|Closed`] || []).length === 1, 'the Closed listener was attached');
});

test('open(): events go to the right calls with the stream path, and numbers are the right kind', async () => {
  const dbus = fakeDbus();
  const s = await new MutterTransport({ dbus }).open(area);
  await s.pointerAbsolute(10.5, 20); await s.pointerRelative(-3, 4); await s.button(0x110, true); await s.button(0x110, 0);
  await s.axis(0, 0.05, 1); await s.axisDiscrete(0, -3); await s.keycode(42, true); await s.keysym(0x61, false);
  const sent = dbus.calls.filter((c) => c[0] === RD_SESSION_PATH && /^Notify/.test(c[1])).map((c) => [c[1], ...c.slice(2)]);
  assert.deepStrictEqual(sent, [
    ['NotifyPointerMotionAbsolute', STREAM_PATH, 10.5, 20],
    ['NotifyPointerMotionRelative', -3, 4],
    ['NotifyPointerButton', 0x110, true],
    ['NotifyPointerButton', 0x110, false],
    ['NotifyPointerAxis', 0, 0.05, 1],
    ['NotifyPointerAxisDiscrete', 0, -3],
    ['NotifyKeyboardKeycode', 42, true],
    ['NotifyKeyboardKeysym', 0x61, false],
  ]);
});

test('open(): the Closed signal reaches onClosed listeners once, and our own stop() is marked as ours', async () => {
  const dbus = fakeDbus();
  const s = await new MutterTransport({ dbus }).open(area);
  let n = 0; let ours = null;
  s.onClosed((x) => { n++; ours = x.closedByUs; });
  dbus.emit(RD_SESSION_PATH, 'Closed'); dbus.emit(RD_SESSION_PATH, 'Closed');
  assert.strictEqual(n, 1, 'a second signal does not call listeners again');
  assert.strictEqual(ours, false, 'the person (or the Shell) closed it: not us');
  const dbus2 = fakeDbus();
  const s2 = await new MutterTransport({ dbus: dbus2 }).open(area);
  let ours2 = null; s2.onClosed((x) => { ours2 = x.closedByUs; });
  await s2.stop();
  assert.strictEqual(ours2, true);
  assert.ok(dbus2.calls.some((c) => c[1] === 'Stop'));
});

test('a session that is closed the very moment it starts is still noticed (the listener was there before Start)', async () => {
  const dbus = fakeDbus({ onStart: (emit) => emit(RD_SESSION_PATH, 'Closed') });
  const s = await new MutterTransport({ dbus }).open(area);
  assert.strictEqual(s.closed, true);
  let heard = null; s.onClosed((x) => { heard = x.closedByUs; });
  assert.strictEqual(heard, false);
});

test('numbers are coerced to what D-Bus wants (unsigned codes, real booleans) whatever the caller hands over', async () => {
  const dbus = fakeDbus();
  const s = await new MutterTransport({ dbus }).open(area);
  await s.keycode('29', 1); await s.keysym('97', 0); await s.button('272', 1); await s.axisDiscrete('1', '-2.9');
  const sent = dbus.calls.filter((c) => c[0] === RD_SESSION_PATH && /^Notify/.test(c[1])).map((c) => [c[1], ...c.slice(2)]);
  assert.deepStrictEqual(sent, [
    ['NotifyKeyboardKeycode', 29, true], ['NotifyKeyboardKeysym', 97, false], ['NotifyPointerButton', 272, true], ['NotifyPointerAxisDiscrete', 1, -2],
  ]);
});

test('onClosed on a session that is already closed calls the listener at once', async () => {
  const s = await new MutterTransport({ dbus: fakeDbus() }).open(area);
  await s.stop();
  let called = false; s.onClosed(() => { called = true; });
  assert.ok(called);
});

test('open(): a failure half-way stops the half-made session and says it cannot be used (unavailable)', async () => {
  const dbus = fakeDbus({ fail: { RecordArea: Object.assign(new Error('boom'), { type: 'org.freedesktop.DBus.Error.Failed', text: 'boom' }) } });
  await assert.rejects(() => new MutterTransport({ dbus }).open(area), (e) => e instanceof InputUnavailable && e.unavailable === true && /boom/.test(e.message));
  assert.ok(dbus.calls.some((c) => c[0] === RD_SESSION_PATH && c[1] === 'Stop'), 'the session that was made is stopped');
});

test('open(): a missing PipeWire is named, because that is the one thing a person can fix', async () => {
  const dbus = fakeDbus({ fail: { Start: Object.assign(new Error('x'), { text: "Couldn't connect pipewire context" }) } });
  await assert.rejects(() => new MutterTransport({ dbus }).open(area), /PipeWire is not running/);
});

test('describeOpenError: policy refusals and a missing service read as sentences', () => {
  assert.match(describeOpenError({ type: 'org.freedesktop.DBus.Error.AccessDenied', text: 'no' }), /refused/);
  assert.match(describeOpenError({ type: 'org.freedesktop.DBus.Error.ServiceUnknown', text: '' }), /not a GNOME Wayland session/);
  assert.match(describeOpenError(new Error('odd')), /could not start a session \(odd\)/);
});

test('available(): true when the service has an owner, with a reason when it does not', async () => {
  assert.deepStrictEqual(await new MutterTransport({ dbus: fakeDbus({ nameHasOwner: true }) }).available(), { ok: true });
  const r = await new MutterTransport({ dbus: fakeDbus({ nameHasOwner: false }) }).available();
  assert.strictEqual(r.ok, false); assert.match(r.reason, /not a GNOME Wayland session/);
});

test('available(): an unreachable bus is an answer, not an exception', async () => {
  const dbus = { sessionBus() { throw new Error('no session bus'); }, Variant };
  const r = await new MutterTransport({ dbus }).available();
  assert.strictEqual(r.ok, false); assert.match(r.reason, /no session bus/);
});

test('desktop(): asks DisplayConfig and parses; null when it cannot say', async () => {
  const st = stateOf([monitor('A', mode('a', 2560, 1440))], [logical(0, 0, 2, 0, 'A')]);
  const d = await new MutterTransport({ dbus: fakeDbus({ state: st }) }).desktop();
  assert.deepStrictEqual([d.width, d.height, d.scale], [1280, 720, 2]);
  assert.strictEqual(await new MutterTransport({ dbus: fakeDbus({ fail: { GetCurrentState: new Error('gone') } }) }).desktop(), null);
});

test('onDisplayChange(): listeners hear MonitorsChanged; a second registration does not hook twice', async () => {
  const dbus = fakeDbus({ state: stateOf([monitor('A', mode('a', 100, 100))], [logical(0, 0, 1, 0, 'A')]) });
  const t = new MutterTransport({ dbus });
  let a = 0; let b = 0;
  await t.onDisplayChange(() => a++); await t.onDisplayChange(() => b++);
  assert.strictEqual((dbus.listeners[`${DC[1]}|MonitorsChanged`] || []).length, 1);
  dbus.emit(DC[1], 'MonitorsChanged');
  assert.deepStrictEqual([a, b], [1, 1]);
});

test('close() lets go of the bus connection', async () => {
  const dbus = fakeDbus();
  const t = new MutterTransport({ dbus });
  await t.available();
  t.close();
  await new Promise((r) => setImmediate(r));
  assert.ok(dbus.calls.some((c) => c[0] === 'bus' && c[1] === 'disconnect'));
});

test('isSessionGone: told apart from a call that was simply wrong', () => {
  assert.ok(isSessionGone({ type: 'org.freedesktop.DBus.Error.UnknownMethod', text: 'Object does not exist at path "/x"' }));
  // each kind of answer on its own: the type alone, and the words alone
  for (const type of ['UnknownMethod', 'UnknownObject', 'UnknownInterface', 'ServiceUnknown', 'NameHasNoOwner', 'NoReply', 'Disconnected', 'NoServer']) {
    assert.ok(isSessionGone({ type: `org.freedesktop.DBus.Error.${type}` }), type);
  }
  for (const text of ['Object does not exist at path "/x"', 'bus disconnected', 'Connection is closed', 'not connected', 'Closed bus', 'session no longer there']) {
    assert.ok(isSessionGone({ text }), text);
  }
  assert.ok(isSessionGone({ type: 'org.freedesktop.DBus.Error.ServiceUnknown' }));
  assert.ok(isSessionGone(new Error('Connection closed')));
  assert.ok(!isSessionGone({ type: 'org.freedesktop.DBus.Error.InvalidArgs', text: 'Invalid axis steps value' }));
  assert.ok(!isSessionGone(null));
});
