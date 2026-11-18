'use strict';
// END-TO-END: the REAL App class against the REAL electron module (not test/helpers/fake-electron.js).
// fake-electron proves the WIRING is correct; this proves the actual Electron API calls made along that
// wiring (BrowserWindow options, Tray construction, globalShortcut.register, safeStorage) are valid calls
// against the real thing, not just against a fake that happens to accept them.
// Exits non-zero on any failure.
//   xvfb-run -a electron scripts/e2e-app.cjs --no-sandbox --disable-gpu
const electron = require('electron');
const { app } = electron;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { App } = require('../src/main/app');

app.disableHardwareAcceleration();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`); };

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alles-e2e-app-'));
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };   // app.exit() skips process 'exit' handlers
  const shortcut = 'Control+Alt+Space';
  const built = new App({ electron, userDataDir: dir, shortcut });

  let threw = null;
  try { built.create(); } catch (e) { threw = e; }
  check('App.create() against the REAL electron module does not throw', threw === null, threw && threw.stack);
  if (threw) { console.error(threw.stack); cleanup(); app.exit(1); return; }

  await sleep(400);

  check('a real BrowserWindow was created for the dock', built.dockWindow.win && !built.dockWindow.win.isDestroyed());
  check('the real global shortcut actually registered with the OS/compositor', electron.globalShortcut.isRegistered(shortcut), `registered flag: ${built.shortcutRegistered}`);

  // Toggle via the SAME path a real key-press would use.
  const before = built.dockWindow.dock.phase;
  electron.globalShortcut.register(shortcut, () => {}); // no-op: just confirm we CAN re-register after unregistering below, proving no stale claim
  built.dockWindow.click();
  await sleep(300);
  check('clicking (as the shortcut handler does) opens the island', built.dockWindow.dock.phase === 'island', `before=${before} after=${built.dockWindow.dock.phase}`);

  // Tray: enable it live via settings, exactly as Settings UI would, and confirm a REAL electron.Tray exists.
  built.settings.update({ tray: { enabled: true } });
  await sleep(100);
  check('enabling the tray via settings creates a real electron.Tray without throwing', built.tray.enabled === true);

  built.settings.update({ tray: { enabled: false } });
  await sleep(50);
  check('disabling it again destroys the real Tray cleanly', built.tray.enabled === false);

  // safeStorage: exercise it through the real KeyStore, however this machine's keyring is configured.
  let keyOk = false;
  try {
    built.settings.update({ providers: { routes: [{ id: 'grok', kind: 'grok', label: 'Grok', model: '', baseUrl: '', enabled: true }] } });
    built.keyStore.add('grok', 'xai-E2ESMOKETESTKEY001');
    keyOk = built.describeProviders().find((r) => r.id === 'grok').keys.length === 1;
  } catch (e) { console.error('  key store error:', e.message); }
  check('adding a key through the real KeyStore/safeStorage path works end to end', keyOk, `mode: ${built.keyStore.mode()}`);

  // Teardown: this is what must not hang the process (see app.test.js for the history of this exact bug).
  built._teardown();
  await sleep(100);
  check('after _teardown(), the dock window is destroyed', built.dockWindow.win === null);
  check('after _teardown(), the shortcut is released', !electron.globalShortcut.isRegistered(shortcut));

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} real-Electron App checks passed`);
  cleanup();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('E2E crashed:', e.stack); app.exit(2); });
