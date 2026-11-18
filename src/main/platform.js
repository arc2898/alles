'use strict';

/**
 * Which window system ALLES is RUNNING on - an honest report, not a request.
 *
 * Electron (Chromium) can run as a native Wayland app, or as an X11 app - on a Wayland desktop that means XWayland,
 * which GNOME and KDE both run by default.
 *
 * WHY ALLES WANTS X11 (measured on real GNOME Shell 46 / Mutter 46.2, with a real pointer):
 *   - ALLES puts a hidden strip, 2 px thick, at an exact spot on a screen edge. Wayland gives an ordinary app
 *     window no way to choose where it sits - the desktop decides. Asked for the strip at 679,766 (8x2), native
 *     Wayland put it at 3,32, and Electron's getBounds() handed the request straight back, so even the app could
 *     not tell it was not obeyed. Through XWayland the window lands exactly where it was asked and reports truthfully.
 *   - Chromium's own window frame on native Wayland adds a title bar and shadow, which would show up around a
 *     see-through pill.
 * The price is small: XWayland windows are drawn by the desktop's X11 layer, and apps cannot claim a global
 * keyboard shortcut there. A shortcut set up in the desktop's own keyboard settings that launches ALLES a second
 * time (which toggles the island) is the reliable way to open it from the keyboard.
 *
 * WHY THIS FILE DOES NOT CHOOSE - IT ONLY REPORTS:
 * Chromium picks its window system once, before the first line of JavaScript runs. Asking later, from the main
 * script (app.commandLine.appendSwitch('ozone-platform', 'wayland')), changes nothing: this was measured on Electron 33.4.11;
 * the window stayed an X11 window while the log claimed Wayland. An earlier version of this file did exactly that.
 * The only ways to choose are on the command line, before Electron starts: --ozone-platform=x11|wayland (or
 * --ozone-platform-hint=auto, or the ELECTRON_OZONE_PLATFORM_HINT variable, both of which pick Wayland on a Wayland
 * desktop). That is the launcher's job - the `alles` command and its desktop entry pass --ozone-platform=x11 on a
 * Wayland desktop that has XWayland - and it is also what a person does to override it.
 *
 * The previous tested build used Electron 33 on a Wayland desktop with XWayland and was an X11 client. The current
 * Electron 45 runtime has not yet been measured on this desktop, so this file reports "don't know" rather than
 * assuming the same default. Validate on the target GNOME/Mutter release before changing the launcher policy.
 *
 * This file touches no Electron API, so every case is tested without a display.
 */

/** Window systems a person can name on the command line that matter here. */
const PLATFORMS = ['x11', 'wayland'];

/** Electron major versions whose default window system was measured on a real desktop (see above). */
const MEASURED_DEFAULT_MAJORS = [33]; // Electron 45 must be verified on the target Debian/GNOME system first.

const clean = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/**
 * @param {{env?:object, explicit?:(string|boolean), electronVersion?:string}} o
 *   env              process.env (or a copy)
 *   explicit         what was passed as --ozone-platform=... (the value, or just true). Chromium also fills this in
 *                    itself when the hint switch or ELECTRON_OZONE_PLATFORM_HINT picked a window system.
 *   electronVersion  process.versions.electron
 * @returns {{platform:('x11'|'wayland'|null), reason:('command-line'|'electron-default'|'unmeasured-electron'|'no-x-display'), session:string, xAvailable:boolean}}
 *   platform null = not known. `reason` is a short code for logs and tests; `xAvailable` = an X11 display is on offer.
 */
function runningBackend({ env = {}, explicit = false, electronVersion = '' } = {}) {
  const e = env && typeof env === 'object' ? env : {};
  const session = clean(e.XDG_SESSION_TYPE) || (e.WAYLAND_DISPLAY ? 'wayland' : (e.DISPLAY ? 'x11' : ''));
  const xAvailable = Boolean(e.DISPLAY);

  // 1. Somebody chose on the command line (or Chromium resolved a hint into it): that is what is running.
  if (explicit) {
    const given = clean(explicit);
    return { platform: PLATFORMS.includes(given) ? given : null, reason: 'command-line', session, xAvailable };
  }

  // 2. Nobody chose: Electron's own default - which is only known for the versions that were measured.
  const major = parseInt(String(electronVersion || '').split('.')[0], 10);
  if (!MEASURED_DEFAULT_MAJORS.includes(major)) return { platform: null, reason: 'unmeasured-electron', session, xAvailable };
  if (xAvailable) return { platform: 'x11', reason: 'electron-default', session, xAvailable };
  return { platform: null, reason: 'no-x-display', session, xAvailable };
}

/**
 * Will a window be put where ALLES asks? true on X11; false on native Wayland; null when we cannot tell.
 * Takes the report from runningBackend().
 */
function placementHonoured(backend) {
  const b = backend && typeof backend === 'object' ? backend : {};
  if (b.platform === 'x11') return true;
  if (b.platform === 'wayland') return false;
  return null;
}

module.exports = { runningBackend, placementHonoured, PLATFORMS, MEASURED_DEFAULT_MAJORS };
