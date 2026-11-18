// Runs the custom "command" widgets. A command is split into arguments by lib/command.js and started DIRECTLY, never through a
// shell: ; | $() and > are ordinary characters there. At most one run per widget at a time, each with a time limit, none while the
// top bar is not showing. Only the first line of what it prints is kept.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { splitCommand, firstLine } from '../lib/command.js';

export class CommandRunner {
  /** @param {(id:string, result:{text:string, failed:boolean})=>void} onResult */
  constructor(onResult) {
    this._onResult = onResult;
    this._timers = new Map();
    this._running = new Map();
    this._stopped = false;
  }

  /** Start (or restart) the timers for exactly these widgets. */
  setWidgets(widgets) {
    this._clearTimers();
    this._stopped = false;
    for (const w of widgets) {
      if (w.type !== 'command' || !w.enabled || !w.command) continue;
      const argv = splitCommand(w.command);
      if (!argv) { this._onResult(w.id, { text: 'bad command', failed: true }); continue; }
      this._runOnce(w, argv);
      const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, w.intervalSec, () => { this._runOnce(w, argv); return GLib.SOURCE_CONTINUE; });
      this._timers.set(w.id, id);
    }
  }

  _runOnce(w, argv) {
    if (this._stopped || this._running.has(w.id)) return;
    let proc;
    try {
      proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    } catch (_e) { this._onResult(w.id, { text: 'cannot start', failed: true }); return; }
    const cancellable = new Gio.Cancellable();
    const entry = { proc, cancellable, killer: 0, killerDone: false };
    entry.killer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, w.timeoutSec, () => { entry.killerDone = true; try { proc.force_exit(); } catch (_e) { /* done already */ } return GLib.SOURCE_REMOVE; });
    this._running.set(w.id, entry);
    proc.communicate_utf8_async(null, cancellable, (p, res) => {
      if (!entry.killerDone) { entry.killerDone = true; GLib.Source.remove(entry.killer); }
      this._running.delete(w.id);
      if (this._stopped) return;
      try {
        const [, stdout] = p.communicate_utf8_finish(res);
        this._onResult(w.id, { text: firstLine(stdout, 40), failed: !p.get_successful() });
      } catch (_e) { this._onResult(w.id, { text: '', failed: true }); }
    });
  }

  _clearTimers() {
    for (const id of this._timers.values()) GLib.Source.remove(id);
    this._timers.clear();
  }

  /** Stop everything: timers, running commands. Safe to call twice. */
  destroy() {
    this._stopped = true;
    this._clearTimers();
    for (const entry of this._running.values()) {
      if (!entry.killerDone) { entry.killerDone = true; GLib.Source.remove(entry.killer); }
      entry.cancellable.cancel();
      try { entry.proc.force_exit(); } catch (_e) { /* done already */ }
    }
    this._running.clear();
  }
}
