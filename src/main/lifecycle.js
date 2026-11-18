'use strict';

/**
 * App lifecycle policy for a background/tray-style app.
 *
 * ELECTRON DEFAULT: with no `window-all-closed` listener, Electron QUITS when the
 * last window closes (verified). ALLES must outlive its windows: the dock
 * window is recreated when placement changes, and the Settings window is opened
 * and closed all day. Without this, closing Settings would kill the assistant.
 *
 * The app only exits through an explicit quit (tray menu / Ctrl+Q), which sets
 * `quitting` so the `before-quit` path is allowed through.
 */
function installLifecycle(app) {
  const state = { quitting: false };

  // Registering ANY listener disables Electron's default quit-on-last-window-closed.
  app.on('window-all-closed', () => { /* stay alive: dock + tray keep running */ });
  app.on('before-quit', () => { state.quitting = true; });

  return {
    state,
    /** The ONLY way the app should exit. */
    quit() { state.quitting = true; app.quit(); },
  };
}

module.exports = { installLifecycle };
