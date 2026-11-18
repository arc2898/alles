'use strict';
// END-TO-END: real Electron + real preload + real pill.html + real DockWindow.
// Drives the pill with REAL pointer input dispatched into the page, and reports
// what happened. Exits non-zero on any failure.
//   xvfb-run -a electron scripts/e2e-dock.cjs --no-sandbox --disable-gpu
const electron = require('electron');
const { app, ipcMain } = electron;
const path = require('node:path');
const { DockWindow, attachPageEvents } = require('../src/main/overlay/window');
const { CONFIG } = require('../src/main/overlay/dock');

app.disableHardwareAcceleration();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`); };

app.whenReady().then(async () => {
  const phases = [];
  const prefs = { edge: 'top', along: 0.5, hour12: false };
  const dw = new DockWindow({
    electron, getPrefs: () => prefs, isBusy: () => false,
    onPlacementMismatch: (m) => console.log('  [placement mismatch]', JSON.stringify(m)),
  });
  const origSet = dw._onPhase.bind(dw);
  dw.dock.onPhase = (p, prev) => { phases.push(p); origSet(p, prev); };
  attachPageEvents(ipcMain, dw);
  const win = dw.create();
  win.webContents.on('console-message', (_e, l, m) => { if (l >= 2) console.log('  [page error]', m); });
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await sleep(300);

  const q = (js) => win.webContents.executeJavaScript(js);
  // visible pill = window bounds minus the transparent inset the page was told about
  const insetPx = () => q('(()=>{const c=getComputedStyle(document.documentElement);return {t:parseFloat(c.getPropertyValue("--in-t")),r:parseFloat(c.getPropertyValue("--in-r")),b:parseFloat(c.getPropertyValue("--in-b")),l:parseFloat(c.getPropertyValue("--in-l"))}})()');
  const visibleRect = async () => { const b = win.getBounds(), i = await insetPx(); return { width: b.width - i.l - i.r, height: b.height - i.t - i.b, top: b.y + i.t }; };
  const bodyAttrs = () => q('({phase:document.body.dataset.phase, edge:document.body.dataset.edge, bulge:document.body.dataset.bulge, island:document.body.classList.contains("island")})');

  // 0. initial: renderer must already know it is hidden
  let a = await bodyAttrs();
  check('renderer receives the initial phase from main', a.phase === 'hidden' && a.edge === 'top' && a.bulge === 'down', JSON.stringify(a));
  const strip = win.getBounds();
  check('starts as the thin hidden strip (from CONFIG, not a hardcoded number)', strip.width === CONFIG.stripLength && strip.height === CONFIG.strip, JSON.stringify(strip));

  // 1. REAL pointer move into the window -> page pointerenter -> preload -> ipc -> DockWindow
  win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.floor(CONFIG.stripLength / 2), y: 0 });
  await sleep(400); // > dwellMs (120) + tick granularity
  a = await bodyAttrs();
  check('real pointer dwell on the strip reveals the pill (hidden -> peek)', phases.includes('peek') && a.phase === 'peek', `phases=${phases.join('>')} page=${a.phase}`);
  const peek = await visibleRect();
  check('VISIBLE pill is the peek size, 6px below the top', peek.width === 168 && peek.height === 34 && peek.top === 6, JSON.stringify(peek));

  // 2. REAL click -> island
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 30, y: 15 });
  win.webContents.sendInputEvent({ type: 'mouseDown', x: 30, y: 15, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: 30, y: 15, button: 'left', clickCount: 1 });
  await sleep(350);
  a = await bodyAttrs();
  check('real click expands to the island', phases.includes('island') && a.island === true, `phases=${phases.join('>')} island=${a.island}`);
  const isl = await visibleRect();
  check('VISIBLE island is the configured size (it fits its idle content without growing)', isl.width === CONFIG.island.width && isl.height === CONFIG.island.height, `${JSON.stringify(isl)} vs ${CONFIG.island.width}x${CONFIG.island.height}`);

  // 3. Esc dismisses
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await sleep(350);
  a = await bodyAttrs();
  check('Escape hides it again', a.phase === 'hidden', JSON.stringify(a));

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} end-to-end checks passed`);
  dw.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('E2E crashed:', e); app.exit(2); });
