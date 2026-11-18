'use strict';

const { titles } = require('./identity');

/**
 * TrayController - the OPTIONAL system tray icon.
 *
 * WHY OPTIONAL, AND OFF BY DEFAULT
 * Stock GNOME has no system tray. Measured in real Electron with no tray host:
 * `new Tray(icon)` does NOT throw, every method "succeeds", and getBounds() returns
 * {0,0,0,0} - so the app would believe it has a tray while nobody can see it. If the
 * tray were the only way to open Settings or quit, GNOME users would be locked out
 * with no error anywhere. Therefore:
 *
 *   1. Every tray action ALSO exists somewhere that needs no tray host (the pill).
 *      `MENU_ACTIONS` is the single list; a test asserts each has a non-tray twin.
 *   2. The tray is a bonus the user can turn on (Settings > Tray icon), and
 *      only actually looks useful if a StatusNotifier/AppIndicator host is running
 *      (GNOME needs an extension for that; KDE has one built in).
 *   3. `looksVisible()` is a HEURISTIC and says so. It can prove "definitely not
 *      visible" (bounds are all zero) but cannot prove "visible".
 *
 * Electron is injected so this is testable without a display.
 */

/** Every action the tray menu offers. Each MUST have an equivalent that needs no tray. */
const MENU_ACTIONS = ['toggle-island', 'open-workspace', 'open-settings', 'stop-agent', 'quit'];

class TrayController {
  /**
   * @param {object} o
   * @param {{Tray:Function, Menu:{buildFromTemplate:Function}, nativeImage:object}} o.electron
   * @param {()=>object} o.getIcon        returns a NativeImage (built by the caller)
   * @param {Record<string,()=>void>} o.actions   handlers keyed by MENU_ACTIONS
   * @param {()=>boolean} [o.isBusy]      true while the agent is running (enables "Stop")
   */
  constructor({ electron, getIcon, actions, isBusy = () => false }) {
    this.electron = electron;
    this.getIcon = getIcon;
    this.actions = actions;
    this.isBusy = isBusy;
    this.tray = null;
    for (const a of MENU_ACTIONS) {
      if (typeof actions[a] !== 'function') throw new Error(`TrayController: missing handler for "${a}"`);
    }
  }

  get enabled() { return !!this.tray && !this.tray.isDestroyed(); }

  /** Create the icon. Idempotent. Returns whether it exists afterwards. */
  enable() {
    if (this.enabled) return true;
    const { Tray } = this.electron;
    try {
      this.tray = new Tray(this.getIcon());
    } catch (e) {
      // Electron did not throw in the no-host case we measured, but other failures
      // (bad icon, missing libs) can. A tray failure must never take the app down.
      this.tray = null;
      this.lastError = e.message;
      return false;
    }
    this.tray.setToolTip(titles.tray);
    this.tray.on('click', () => this.actions['toggle-island']());
    this.refreshMenu();
    return true;
  }

  /** Remove the icon. Idempotent. */
  disable() {
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    this.tray = null;
  }

  /** Follow the setting: call from the settings 'change' event. */
  setEnabled(on) { return on ? this.enable() : (this.disable(), false); }

  /** Rebuild the menu so "Stop" reflects whether the agent is running. */
  refreshMenu() {
    if (!this.enabled) return;
    const { Menu } = this.electron;
    const a = this.actions;
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: `Show ${titles.tray}`, click: () => a['toggle-island']() },
      { label: 'Open workspace (Chat, Code, Voice)…', click: () => a['open-workspace']() },
      { label: 'Settings…', click: () => a['open-settings']() },
      { type: 'separator' },
      { label: 'Stop current task', enabled: !!this.isBusy(), click: () => a['stop-agent']() },
      { type: 'separator' },
      { label: `Quit ${titles.tray}`, click: () => a['quit']() },
    ]));
  }

  /**
   * HEURISTIC: can a user plausibly SEE the icon?
   *   false -> definitely not (the icon has no on-screen bounds)
   *   true  -> it has bounds, which is encouraging but NOT proof
   *   null  -> there is no tray at all
   * On the no-host case measured in Electron, bounds are {0,0,0,0}.
   */
  looksVisible() {
    if (!this.enabled) return null;
    let b;
    try { b = this.tray.getBounds(); } catch { return false; }
    return !!b && (b.width > 0 || b.height > 0);
  }
}

module.exports = { TrayController, MENU_ACTIONS };
