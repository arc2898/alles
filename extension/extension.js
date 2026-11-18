// ALLES for GNOME Shell: the pill in the top bar. Entry point.
//
// enable() builds everything, disable() takes everything down again (GNOME requires that: no timer, signal, bus name, file monitor or
// widget may outlive disable()). The settings are read straight from the app's settings file and watched, so changing them in the ALLES
// window changes the bar at once, and the bar keeps its look when the app is not running.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { AllesIndicator } from './ui/indicator.js';
import { AppLink, launchApp } from './ui/appLink.js';
import { Sampler } from './ui/sampler.js';
import { CommandRunner } from './ui/commandRunner.js';
import { ShelfStore } from './ui/shelfStore.js';
import { topbarFromSettingsText } from './lib/config.js';
import { neededSamples } from './lib/widgets.js';

const SETTINGS_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'alles', 'alles']);
const SETTINGS_FILE = 'settings.json';

export default class AllesExtension extends Extension {
  enable() {
    this._on = true;
    this._config = topbarFromSettingsText(null);
    this._state = null;
    this._samples = {};
    this._indicator = null; this._shelf = null; this._shelfWatch = null;
    this._timers = new Set();
    this._sampler = new Sampler();
    this._commandResults = {};
    this._commands = new CommandRunner((id, r) => { this._commandResults = { ...this._commandResults, [id]: r }; if (this._indicator) this._indicator.setCommandResults(this._commandResults); });
    this._link = new AppLink({
      onState: (s) => { this._state = s; if (this._indicator) this._indicator.setState(s); },
      onToggle: () => { if (this._indicator) this._indicator.menu.toggle(); },     // the keyboard shortcut: open or close the pill's menu
    });
    this._link.start();

    this._config = this._readConfig();
    this._build();
    this._watchSettings();
  }

  disable() {
    this._on = false;
    this._unwatchSettings();
    this._teardownBar();
    if (this._commands) { this._commands.destroy(); this._commands = null; }
    if (this._link) { this._link.destroy(); this._link = null; }
    this._sampler = null; this._state = null;
  }

  // ------------------------------------------------------------------ settings

  _readConfig() {
    let text = null;
    try {
      const [ok, bytes] = GLib.file_get_contents(GLib.build_filenamev([SETTINGS_DIR, SETTINGS_FILE]));
      if (ok && bytes.length < 1024 * 1024) text = new TextDecoder().decode(bytes);
    } catch (_e) { text = null; }
    return topbarFromSettingsText(text);
  }

  _watchSettings() {
    try {
      const dir = Gio.File.new_for_path(SETTINGS_DIR);
      this._dirMonitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
      this._dirSignal = this._dirMonitor.connect('changed', (_m, file) => {
        if (!file || file.get_basename() !== SETTINGS_FILE) return;
        if (this._reload) GLib.Source.remove(this._reload);
        this._reload = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => { this._reload = 0; this._onSettingsChanged(); return GLib.SOURCE_REMOVE; });
      });
    } catch (e) { console.error(`ALLES: cannot watch the settings: ${e.message}`); }
  }

  _unwatchSettings() {
    if (this._reload) { GLib.Source.remove(this._reload); this._reload = 0; }
    if (this._dirMonitor) { if (this._dirSignal) this._dirMonitor.disconnect(this._dirSignal); this._dirMonitor.cancel(); }
    this._dirMonitor = null; this._dirSignal = 0;
  }

  _onSettingsChanged() {
    if (!this._on) return;
    const next = this._readConfig();
    if (JSON.stringify(next) === JSON.stringify(this._config)) return;
    const prev = this._config;
    this._config = next;
    const needsNewButton = !this._indicator || prev.enabled !== next.enabled || prev.position !== next.position || prev.index !== next.index;
    if (needsNewButton) this._build();
    else this._applyConfig();
  }

  // ------------------------------------------------------------------ the bar

  _addTimer(seconds, fn) {
    const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => { try { fn(); } catch (e) { console.error(`ALLES: ${e.message}`); } return GLib.SOURCE_CONTINUE; });
    this._timers.add(id);
  }

  _clearTimers() { for (const id of this._timers) GLib.Source.remove(id); this._timers.clear(); }

  _build() {
    this._teardownBar();
    if (!this._config.enabled) { this._link.announce(false); return; }
    const host = {
      config: this._config,
      link: this._link,
      get shelf() { return host._shelf; },
      _shelf: null,
      launchApp: (page) => launchApp(page),
      refreshShelf: () => this._refreshShelf(),
    };
    this._host = host;
    this._indicator = new AllesIndicator(host);
    const c = this._config;
    Main.panel.addToStatusArea(this.uuid, this._indicator, c.index, c.position);
    this._link.announce(true);
    this._indicator.setState(this._state);
    this._applyConfig();
    if (this._link.running) this._link.refresh();
  }

  _teardownBar() {
    this._clearTimers();
    if (this._shelfWatch) { this._shelfWatch.destroy(); this._shelfWatch = null; }
    if (this._commands) this._commands.setWidgets([]);
    if (this._indicator) { this._indicator.destroy(); this._indicator = null; }
    this._host = null; this._shelf = null;
    if (this._link) this._link.announce(false);
  }

  /** Everything that follows the settings and does not need a new button. */
  _applyConfig() {
    const c = this._config;
    if (!this._indicator) return;
    this._indicator.setConfig(c);
    this._clearTimers();

    // readings: only what the switched-on widgets need
    const need = neededSamples(c.widgets);
    const hasClock = c.widgets.some((w) => w.enabled && w.type === 'clock');
    if (need.size || hasClock) {
      const tick = () => { this._samples = this._sampler.sample(need); this._indicator.setSamples(this._samples); };
      tick();
      this._addTimer(c.resources.intervalSec, tick);
    } else this._indicator.setSamples({});
    this._commands.setWidgets(c.widgets);

    // the shelf
    if (this._shelfWatch) { this._shelfWatch.destroy(); this._shelfWatch = null; }
    if (c.shelf.enabled) {
      this._shelf = new ShelfStore(c.shelf);
      this._host._shelf = this._shelf;
      this._shelf.tidy();
      this._shelfWatch = this._shelf.watch(() => this._refreshShelf());
      this._refreshShelf();
      this._addTimer(3600, () => { if (this._shelf) this._shelf.tidy(); });
    } else { this._shelf = null; if (this._host) this._host._shelf = null; }
  }

  _refreshShelf() {
    if (!this._indicator || !this._shelf) return;
    const note = this._shelf.tidyBlocked() ? 'Not tidying: this folder is not marked as an ALLES shelf, so nothing in it is moved to the Trash.' : '';
    this._indicator.setShelf(this._shelf.list(this._config.shelf.maxShown), note);
  }
}
