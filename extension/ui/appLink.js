// The connection to the ALLES app over the session bus (protocol: lib/protocol.js).
//  - announce(true) names the extension org.alles.TopBar on the bus, so the app knows the top-bar pill is showing (and can hide its
//    floating one); announce(false) takes the name away again
//  - watches for org.alles.App to appear and disappear, never starting it by accident (clicking the pill does that, on purpose)
//  - asks for the state whenever the app says "Changed", and passes it on; "Toggle" opens or closes the pill's menu (the shortcut)
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { APP_NAME, APP_PATH, APP_IFACE, BAR_NAME } from '../lib/protocol.js';

export class AppLink {
  /** @param {{onState:(state:object|null)=>void, onToggle?:()=>void}} o  state = null when the app is not running */
  constructor({ onState, onToggle = () => {} }) {
    this._onState = onState; this._onToggle = onToggle;
    this._owner = 0; this._watch = 0; this._proxy = null; this._signalId = 0; this._cancel = null; this._destroyed = false;
  }

  start() {
    this._cancel = new Gio.Cancellable();
    this._watch = Gio.bus_watch_name(Gio.BusType.SESSION, APP_NAME, Gio.BusNameWatcherFlags.NONE, (conn) => this._appeared(conn), () => this._vanished());
  }

  get running() { return !!this._proxy; }

  announce(on) {
    if (on && !this._owner) this._owner = Gio.bus_own_name(Gio.BusType.SESSION, BAR_NAME, Gio.BusNameOwnerFlags.NONE, null, null, null);
    else if (!on && this._owner) { Gio.bus_unown_name(this._owner); this._owner = 0; }
  }

  _appeared(connection) {
    Gio.DBusProxy.new(connection, Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES | Gio.DBusProxyFlags.DO_NOT_AUTO_START, null, APP_NAME, APP_PATH, APP_IFACE, this._cancel, (_src, res) => {
      if (this._destroyed) return;
      try {
        this._proxy = Gio.DBusProxy.new_finish(res);
      } catch (e) { console.error(`ALLES: could not talk to the app: ${e.message}`); return; }
      this._signalId = this._proxy.connect('g-signal', (_p, _sender, signal) => { if (signal === 'Changed') this.refresh(); else if (signal === 'Toggle') this._onToggle(); });
      this.refresh();
    });
  }

  _vanished() {
    if (this._proxy && this._signalId) this._proxy.disconnect(this._signalId);
    this._signalId = 0; this._proxy = null;
    if (!this._destroyed) this._onState(null);
  }

  /** Ask for the state now. */
  refresh() {
    this._call('GetState', null, 5000, (v) => {
      let state = null;
      try { state = JSON.parse(v.deep_unpack()[0]); } catch (_e) { state = null; }
      if (!this._destroyed && state && typeof state === 'object') this._onState(state);
    });
  }

  /** Call a method; `done(result|null, error|null)` is called with the reply variant. */
  _call(method, params, timeoutMs, done = () => {}) {
    if (!this._proxy) { done(null, new Error('ALLES is not running')); return; }
    this._proxy.call(method, params, Gio.DBusCallFlags.NO_AUTO_START, timeoutMs, this._cancel, (p, res) => {
      if (this._destroyed) return;
      try { done(p.call_finish(res), null); } catch (e) { if (!e.matches || !e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) done(null, e); }
    });
  }

  submit(text, done) { this._call('Submit', new GLib.Variant('(s)', [String(text)]), 10000, (_r, e) => done && done(e)); }
  stop() { this._call('Stop', null, 5000); }
  /** Listen with the microphone. submit=true sends what was heard as a task; the reply is the text heard ('' if nothing). */
  listen(submit, done) { this._call('Listen', new GLib.Variant('(b)', [!!submit]), 60000, (r, e) => done && done(r ? r.deep_unpack()[0] : '', e)); }
  stopListening() { this._call('StopListening', null, 5000); }
  setWake(enabled) { this._call('SetWake', new GLib.Variant('(b)', [!!enabled]), 5000); }
  answerApproval(id, allow) { this._call('AnswerApproval', new GLib.Variant('(sb)', [String(id), !!allow]), 5000); }
  openWorkspace(page = '') { this._call('OpenWorkspace', new GLib.Variant('(s)', [page]), 5000); }
  openSettings() { this._call('OpenSettings', null, 5000); }

  destroy() {
    this._destroyed = true;
    if (this._cancel) this._cancel.cancel();
    if (this._proxy && this._signalId) this._proxy.disconnect(this._signalId);
    this._proxy = null;
    if (this._watch) Gio.bus_unwatch_name(this._watch);
    if (this._owner) Gio.bus_unown_name(this._owner);
    this._watch = 0; this._owner = 0;
  }
}

/**
 * Start the app because the pill was used while it was not running.
 *  launchApp()          the app, with its island open (what the keyboard shortcut does)
 *  launchApp('')        the app's window        launchApp('topbar')   the window, on that page
 */
export function launchApp(page) {
  const args = page === undefined ? ['alles', '--show'] : page === '' ? ['alles', '--window'] : ['alles', '--window', page];
  try {
    Gio.Subprocess.new(args, Gio.SubprocessFlags.NONE);
  } catch (e) {
    console.error(`ALLES: could not start the app: ${e.message}`);
    return false;
  }
  return true;
}
