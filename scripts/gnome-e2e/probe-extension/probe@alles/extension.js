// ALLES test probe - for the scripts in scripts/gnome-e2e ONLY. It gives a test a way to ask a throw-away,
// headless GNOME Shell about itself (where windows really are, whether the Overview is open, a screenshot).
// It evaluates whatever JavaScript it is sent, so it must never be installed in a real desktop session.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const IFACE = `<node><interface name="org.alles.Probe">
  <method name="Eval"><arg type="s" direction="in" name="code"/><arg type="s" direction="out" name="result"/></method>
</interface></node>`;

export default class AllesProbe extends Extension {
  enable() {
    this._impl = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
    this._impl.export(Gio.DBus.session, '/org/alles/Probe');
    this._owner = Gio.bus_own_name_on_connection(Gio.DBus.session, 'org.alles.Probe', Gio.BusNameOwnerFlags.NONE, null, null);
  }
  disable() {
    try { this._impl.unexport(); } catch (e) { /* ignore */ }
    if (this._owner) Gio.bus_unown_name(this._owner);
  }
  Eval(code) {
    try {
      const r = eval(code);          // direct eval: sees Main, GLib, Gio, St, Clutter, Shell, Meta
      if (r === undefined) return 'undefined';
      return typeof r === 'string' ? r : JSON.stringify(r);
    } catch (e) { return 'ERR ' + e + (e && e.stack ? '\n' + e.stack : ''); }
  }
}
