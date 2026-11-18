'use strict';
/**
 * ALLES - real entry point. This is what `electron .` actually runs.
 *
 * Everything of substance lives in App (./app.js) and its dependencies, all built and tested against
 * test/helpers/fake-electron.js and proven once against the real Electron module in
 * scripts/e2e-app.cjs. This file is deliberately thin: its only job is to boot the REAL electron module
 * for a REAL desktop session, which differs from every test/smoke harness in this codebase in two ways
 * that matter:
 *
 *   1. No app.disableHardwareAcceleration(). Every e2e-*.cjs script in scripts/ calls this because Xvfb
 *      (the headless display used to run them) has no GPU. A real desktop does, and forcing software
 *      rendering there would be a real performance regression for every user, not a safe default.
 *   2. userDataDir is left undefined, so App falls back to the REAL
 *      electron.app.getPath('userData')/alles (see App's constructor) instead of a disposable temp
 *      directory. This is what makes settings and keys actually persist between runs.
 *
 * Startup order matters: single-instance lock -> whenReady() -> App.create(). App.create() itself wires
 * electron.app.on('before-quit', ...) to its own teardown (see app.js), so this file never calls
 * app._teardown() or app.quit() directly - that would double up with App's own lifecycle handling.
 */
const electron = require('electron');
const { app } = electron;
const { App } = require('./app');
const { NAME } = require('./identity');
const { runningBackend, placementHonoured } = require('./platform');

// Which window system Electron is running on. This only REPORTS it: Chromium decides once, before any of this runs, and asking
// from here changes nothing (measured; see platform.js). The pill needs X11 (through XWayland on a Wayland desktop) to be
// placed on a screen edge, so the launcher passes --ozone-platform=x11 there. If it is running native Wayland, say so.
const backend = runningBackend({ env: process.env, explicit: app.commandLine.getSwitchValue('ozone-platform') || false, electronVersion: process.versions.electron });
const backendInfo = { platform: backend.platform, reason: backend.reason, placementHonoured: placementHonoured(backend), xAvailable: backend.xAvailable };
console.log(`[${NAME}] window system: ${backend.platform || 'not known'} (${backend.reason})`);
if (backendInfo.placementHonoured === false) {
  console.log(`[${NAME}] placement not honoured: native Wayland desktops decide where windows go, so the pill may not stay on its screen edge${backend.xAvailable ? ' - start ALLES with --ozone-platform=x11 for X11 mode' : ''}`);
}

// Only one instance of ALLES should ever run at once: a second launch would register a second global
// shortcut (which Electron allows silently overriding, hiding the first instance's binding), open a
// second dock window, and hold a second lock on the settings/keys files. requestSingleInstanceLock()
// is the standard Electron mechanism for refusing a second launch outright.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.error(`[${NAME}] another instance is already running; exiting.`);
  app.quit();
} else {
  let built = null;

  // A second launch attempt (e.g. the user double-clicking the app icon again) fires this in the
  // FIRST instance instead of starting a second one. Surface the existing window rather than doing
  // nothing, so the user gets feedback that something happened.
  app.on('second-instance', (_event, argv) => {
    if (built) built.handleLaunch(argv);              // --window opens the workspace window; anything else opens or closes the island
  });

  app.whenReady().then(() => {
    built = new App({ electron, backend: backendInfo });
    try {
      built.create();
      // `alles --window` (the menu entry): open the workspace window. `alles --show` (what the keyboard shortcut runs): open the
      // island at once. Otherwise, on a first run only, let the person see where the pill lives.
      if (process.argv.includes('--window')) built.openWorkspace();
      else if (process.argv.includes('--show')) built.showIsland();
      else built.welcome();
    } catch (e) {
      // A failure here means the app cannot function at all (e.g. it could not create its own window).
      // There is nothing partially-working to fall back to, so log clearly and exit rather than leaving
      // a broken, invisible process running.
      console.error(`[${NAME}] failed to start:`, e.stack || e);
      app.exit(1);
    }
  });
}
