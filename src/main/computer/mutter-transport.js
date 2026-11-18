'use strict';

/**
 * The wire to GNOME's own remote-input service (Mutter's org.gnome.Mutter.RemoteDesktop on the session bus).
 *
 * WHY THIS EXISTS: on Wayland an app may not inject mouse and keyboard input into other apps. ydotool gets around that with a
 * kernel device and needs setup (a daemon, access to /dev/uinput). GNOME ships a supported service for exactly this - the one
 * its own "share my screen" and remote-desktop features use - and any program of the logged-in user may use it with NO setup.
 * While a session is open GNOME shows its orange "screen is being shared" indicator, so the person can always see (and stop) it.
 *
 * This file is only the wire: open a session, send events, tell when it ends. It decides nothing about WHAT to send; that is
 * mutter-backend.js, which is tested against a fake of this class. Everything here was measured on a real GNOME Shell 46:
 *
 *   CreateSession -> read SessionId -> ScreenCast.CreateSession(remote-desktop-session-id) -> RecordArea(x, y, w, h) -> Start
 *
 *   - The pointer can only be placed ABSOLUTELY through a screen-cast stream, so a session records the whole desktop as one
 *     area (nobody consumes the pictures; the stream exists to give coordinates a meaning). That needs PipeWire running,
 *     which every GNOME desktop has.
 *   - Absolute coordinates are in PHYSICAL pixels of the area: at 200% scaling, asking for 100 puts the pointer at logical 50.
 *     That is the same pixel space gnome-screenshot's pictures use, so a spot in a screenshot is a spot in the stream.
 *   - When the person stops the sharing from the top bar, the session sends Closed and every later call fails with
 *     "Object does not exist at path".
 */

const RD_NAME = 'org.gnome.Mutter.RemoteDesktop';
const RD_PATH = '/org/gnome/Mutter/RemoteDesktop';
const RD_IFACE = 'org.gnome.Mutter.RemoteDesktop';
const RD_SESSION = 'org.gnome.Mutter.RemoteDesktop.Session';
const SC_NAME = 'org.gnome.Mutter.ScreenCast';
const SC_PATH = '/org/gnome/Mutter/ScreenCast';
const SC_IFACE = 'org.gnome.Mutter.ScreenCast';
const SC_SESSION = 'org.gnome.Mutter.ScreenCast.Session';
const DC_NAME = 'org.gnome.Mutter.DisplayConfig';
const DC_PATH = '/org/gnome/Mutter/DisplayConfig';
const PROPS = 'org.freedesktop.DBus.Properties';

/** The service is missing or cannot start here. Callers use this to fall back to another way of sending input. */
class InputUnavailable extends Error {
  constructor(message) { super(message); this.name = 'InputUnavailable'; this.unavailable = true; }
}

const unwrap = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);

/**
 * Work out the desktop's shape from DisplayConfig.GetCurrentState():
 *   [serial, monitors[ [spec, modes[ [id, w, h, rate, preferredScale, supportedScales, props] ], props] ],
 *            logicalMonitors[ [x, y, scale, transform, primary, specs, props] ], props]
 * Returns the bounding box of all screens in LOGICAL pixels plus the largest scale, or null if nothing usable.
 */
function parseDisplayState(state) {
  if (!Array.isArray(state)) return null;
  const monitors = Array.isArray(state[1]) ? state[1] : [];
  const logical = Array.isArray(state[2]) ? state[2] : [];
  const modeOf = new Map();
  for (const m of monitors) {
    const spec = m && m[0]; const modes = (m && m[1]) || [];
    if (!spec) continue;
    const flag = (md, k) => !!unwrap((md[6] || {})[k]);
    const cur = modes.find((md) => flag(md, 'is-current')) || modes.find((md) => flag(md, 'is-preferred')) || modes[0];
    if (cur) modeOf.set(spec[0], cur);
  }
  const rects = [];
  for (const l of logical) {
    if (!Array.isArray(l)) continue;
    const [x, y, scaleRaw, transform] = l;
    const specs = Array.isArray(l[5]) ? l[5] : [];
    const mode = specs.map((s) => modeOf.get(s && s[0])).find(Boolean);
    if (!mode) continue;
    let w = Number(mode[1]); let h = Number(mode[2]);
    if (!(w > 0 && h > 0)) continue;
    if (Number(transform) % 2 === 1) [w, h] = [h, w];            // turned 90 or 270 degrees (4..7 are the mirrored forms: same rule)
    const scale = Number(scaleRaw) > 0 ? Number(scaleRaw) : 1;
    rects.push({ x: Number(x) || 0, y: Number(y) || 0, w: Math.round(w / scale), h: Math.round(h / scale), scale });
  }
  if (!rects.length) return null;
  const x0 = Math.min(...rects.map((r) => r.x)); const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w)); const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0, scale: Math.max(...rects.map((r) => r.scale)), monitors: rects };
}

/** True when an error means "this session no longer exists" (the person stopped it, or the Shell restarted) rather than "this call was wrong". */
function isSessionGone(e) {
  const type = String((e && e.type) || '');
  const msg = String((e && (e.text || e.message)) || '');
  return /UnknownMethod|UnknownObject|UnknownInterface|ServiceUnknown|NameHasNoOwner|NoReply|Disconnected|NoServer/i.test(type)
    || /does not exist|disconnected|connection (is )?closed|not connected|closed bus|no longer/i.test(msg);
}

/** One open session: thin methods over the D-Bus calls. */
class MutterSession {
  constructor({ si, stream, area }) {
    this.si = si; this.stream = stream; this.area = area;
    this.closedByUs = false;
    this._onClosed = [];
    this.closed = false;
  }
  _emitClosed() { if (this.closed) return; this.closed = true; for (const cb of this._onClosed.splice(0)) { try { cb(this); } catch { /* a listener must not break the others */ } } }
  onClosed(cb) { if (this.closed) cb(this); else this._onClosed.push(cb); }

  pointerAbsolute(x, y) { return this.si.NotifyPointerMotionAbsolute(this.stream, x, y); }
  pointerRelative(dx, dy) { return this.si.NotifyPointerMotionRelative(dx, dy); }
  button(code, down) { return this.si.NotifyPointerButton(code | 0, !!down); }
  axis(dx, dy, flags = 0) { return this.si.NotifyPointerAxis(dx, dy, flags >>> 0); }
  axisDiscrete(axis, steps) { return this.si.NotifyPointerAxisDiscrete(axis >>> 0, steps | 0); }
  keycode(code, down) { return this.si.NotifyKeyboardKeycode(code >>> 0, !!down); }
  keysym(sym, down) { return this.si.NotifyKeyboardKeysym(sym >>> 0, !!down); }

  /** Close the session ourselves (idle, quitting, switching backend). The Closed signal that follows is NOT the person stopping it. */
  async stop() {
    this.closedByUs = true;
    try { await this.si.Stop(); } catch { /* already gone */ }
    this._emitClosed();
  }
}

class MutterTransport {
  /** @param {object} [opts]  dbus: the dbus-next module (tests give a fake); env: where to find the session bus */
  constructor({ dbus = null } = {}) {
    this._dbusLib = dbus;
    this._busPromise = null;
    this._cache = new Map();
    this._displayHooked = false;
    this._displayCbs = [];
  }

  get dbus() { if (!this._dbusLib) this._dbusLib = require('dbus-next'); return this._dbusLib; }

  _bus() {
    if (!this._busPromise) {
      this._busPromise = Promise.resolve().then(() => {
        const bus = this.dbus.sessionBus();
        bus.on('error', () => { this._busPromise = null; this._cache.clear(); });   // a dead connection is replaced on the next use
        return bus;
      });
    }
    return this._busPromise;
  }

  async _iface(name, path, iface) {
    const key = `${name}|${path}|${iface}`;
    if (this._cache.has(key)) return this._cache.get(key);
    const bus = await this._bus();
    const obj = await bus.getProxyObject(name, path);
    const i = obj.getInterface(iface);
    this._cache.set(key, i);
    return i;
  }

  /** Is GNOME's remote-input service on the bus? Resolves {ok:true} or {ok:false, reason}. Never throws. */
  async available() {
    try {
      const bus = await this._bus();
      const obj = await bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus');
      const has = await obj.getInterface('org.freedesktop.DBus').NameHasOwner(RD_NAME);
      return has ? { ok: true } : { ok: false, reason: 'the GNOME remote-input service is not running (this is not a GNOME Wayland session)' };
    } catch (e) {
      this._busPromise = null;
      return { ok: false, reason: `the desktop message bus cannot be reached (${e && e.message ? e.message : e})` };
    }
  }

  /** The shape of the desktop right now (see parseDisplayState), or null if DisplayConfig cannot say. */
  async desktop() {
    try {
      const dc = await this._iface(DC_NAME, DC_PATH, DC_NAME);
      return parseDisplayState(await dc.GetCurrentState());
    } catch { return null; }
  }

  /** Call cb when the screens change (plugged, unplugged, resolution or scale changed). Safe to call before any session exists. */
  async onDisplayChange(cb) {
    this._displayCbs.push(cb);
    if (this._displayHooked) return;
    this._displayHooked = true;
    try {
      const dc = await this._iface(DC_NAME, DC_PATH, DC_NAME);
      dc.on('MonitorsChanged', () => { for (const f of this._displayCbs) { try { f(); } catch { /* ignore */ } } });
    } catch { this._displayHooked = false; }
  }

  /** Open a session whose stream covers `area` ({x, y, width, height} in logical pixels). Resolves a MutterSession. */
  async open(area) {
    const { Variant } = this.dbus;
    let si = null;
    try {
      const rd = await this._iface(RD_NAME, RD_PATH, RD_IFACE);
      const sessPath = await rd.CreateSession();
      const bus = await this._bus();
      const sessObj = await bus.getProxyObject(RD_NAME, sessPath);
      si = sessObj.getInterface(RD_SESSION);
      const sessionId = unwrap(await sessObj.getInterface(PROPS).Get(RD_SESSION, 'SessionId'));
      const sc = await this._iface(SC_NAME, SC_PATH, SC_IFACE);
      const scPath = await sc.CreateSession({ 'remote-desktop-session-id': new Variant('s', sessionId) });
      const scObj = await bus.getProxyObject(SC_NAME, scPath);
      const stream = await scObj.getInterface(SC_SESSION).RecordArea(area.x, area.y, area.width, area.height, { 'cursor-mode': new Variant('u', 0) });
      const session = new MutterSession({ si, stream, area });
      si.on('Closed', () => session._emitClosed());                  // listen BEFORE Start so nothing can be missed
      await si.Start();
      return session;
    } catch (e) {
      if (si) { try { await si.Stop(); } catch { /* never started */ } }
      throw new InputUnavailable(describeOpenError(e));
    }
  }

  /** Let go of the bus connection (app quit). */
  close() {
    const p = this._busPromise; this._busPromise = null; this._cache.clear();
    if (p) p.then((bus) => { try { bus.disconnect(); } catch { /* already closed */ } }, () => {});
  }
}

/** Turn what the service said into a sentence a person can act on. */
function describeOpenError(e) {
  const text = String((e && (e.text || e.message)) || e);
  const type = String((e && e.type) || '');
  if (/pipewire/i.test(text)) return 'PipeWire is not running, which GNOME needs for its remote-input service';
  if (/AccessDenied|NotAuthorized|not allowed/i.test(`${type} ${text}`)) return 'the desktop refused remote input (a policy may be blocking it)';
  if (/ServiceUnknown|NameHasNoOwner/i.test(type)) return 'the GNOME remote-input service is not running (this is not a GNOME Wayland session)';
  return `GNOME's remote-input service could not start a session (${text})`;
}

module.exports = { MutterTransport, MutterSession, InputUnavailable, parseDisplayState, isSessionGone, describeOpenError, unwrap };
