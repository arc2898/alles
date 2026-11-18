'use strict';
// END-TO-END DRAG: real Electron + real preload + real page + real DockWindow, driven with
// real pointer events (press, move far OUTSIDE the tiny window, release). Verifies the drop
// is committed, persisted through the settings store, and the dock re-homes to the new spot.
const electron = require('electron');
const { app, ipcMain } = electron;
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { DockWindow, attachPageEvents } = require('../src/main/overlay/window');
const { SettingsStore } = require('../src/main/settings');
const { installLifecycle } = require('../src/main/lifecycle');

app.disableHardwareAcceleration();
installLifecycle(app);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`); };

// A pointer we move ourselves. Main reads the pointer's position from the desktop (screen.getCursorScreenPoint); Xvfb has no
// real pointer to move, so the desktop's answer is this one. The page is still driven by REAL input events through the real
// preload, and each event's window coordinates are worked out from the window's position at that moment - as a real pointer does.
const cursor = { x: 0, y: 0 };
const screenShim = {
  getCursorScreenPoint: () => ({ ...cursor }),
  getAllDisplays: () => electron.screen.getAllDisplays(),
  getDisplayNearestPoint: (p) => electron.screen.getDisplayNearestPoint(p),
  getPrimaryDisplay: () => electron.screen.getPrimaryDisplay(),
};

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alles-e2e-'));
  const file = path.join(dir, 'settings.json');
  const store = new SettingsStore(file);
  const dw = new DockWindow({
    electron: { BrowserWindow: electron.BrowserWindow, screen: screenShim },
    getPrefs: () => store.get().dock,
    isBusy: () => false,
    onPlacementChange: (p) => store.update({ dock: p }),         // main persists the drop
  });
  store.on('change', () => dw.refreshPlacement());               // ...and the dock re-homes itself
  attachPageEvents(ipcMain, dw);
  const win = dw.create();
  win.webContents.on('console-message', (_e, l, m) => { if (l >= 2) console.log('  [page error]', m); });
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await sleep(300);

  const S = (o) => win.webContents.sendInputEvent(o);
  const wc = win.webContents;
  // Move the pointer to a SCREEN position; the page hears about it in window coordinates (relative to where the window is NOW).
  const at = (sx, sy, extra = {}) => { cursor.x = sx; cursor.y = sy; const b = win.getBounds(); return { x: sx - b.x, y: sy - b.y, ...extra }; };
  const move = (sx, sy, down = false) => S({ type: 'mouseMove', ...at(sx, sy), ...(down ? { modifiers: ['leftButtonDown'] } : {}) });
  const press = (sx, sy) => S({ type: 'mouseDown', ...at(sx, sy), button: 'left', clickCount: 1 });
  const release = (sx, sy) => S({ type: 'mouseUp', ...at(sx, sy), button: 'left', clickCount: 1 });

  const inside = (b, x, y) => x >= b.x - 2 && x <= b.x + b.width + 2 && y >= b.y - 2 && y <= b.y + b.height + 2;
  // A straight path of `n` steps from (x0,y0) to (x1,y1), each step with the button held.
  const sweep = async (x0, y0, x1, y1, n = 8) => { for (let i = 1; i <= n; i++) { move(Math.round(x0 + (x1 - x0) * i / n), Math.round(y0 + (y1 - y0) * i / n), true); await sleep(45); } };

  // reveal the pill first (real dwell on the strip), then open the island so there is a big target
  const strip = win.getBounds();
  move(strip.x + 4, strip.y + 1); await sleep(400);
  check('starts hidden and is revealed by a real hover', dw.dock.phase === 'peek', dw.dock.phase);
  const peek = win.getBounds();
  console.log('  peek window at', JSON.stringify(peek));

  // ---- 1. a plain click (no movement) must still open the island --------------------
  move(peek.x + 60, peek.y + 30); press(peek.x + 60, peek.y + 30); release(peek.x + 60, peek.y + 30);
  await sleep(350);
  check('a click WITHOUT movement still opens the island (not swallowed by the drag logic)', dw.dock.phase === 'island', dw.dock.phase);

  // ---- 2. drag: press on the pill, move far outside the window, release --------------
  const before = win.getBounds();
  const p0 = { x: before.x + 100, y: before.y + 40 };
  move(p0.x, p0.y); press(p0.x, p0.y);
  await sleep(60);
  // SCREEN positions; the window is ~500x158, so the pointer ends far outside it (the page must keep hearing about it)
  await sweep(p0.x, p0.y, 1910, 440, 8);
  const mid = win.getBounds();
  const draggingClass = await wc.executeJavaScript('document.body.classList.contains("dragging")');
  check('the window FOLLOWS the pointer during a drag', mid.x !== before.x || mid.y !== before.y, `before=${before.x},${before.y} mid=${mid.x},${mid.y}`);
  check('and stays UNDER it, however far it has travelled (no lag, no drift)', inside(mid, 1910, 440), `pointer 1910,440; window ${mid.x},${mid.y} ${mid.width}x${mid.height}`);
  check('the page shows the dragging state', draggingClass === true);
  check('the auto-hide timer does not fire mid-drag', dw.dock.phase === 'island' && dw.dragging === true, `phase=${dw.dock.phase} dragging=${dw.dragging}`);

  release(1910, 440);
  await sleep(450);

  // ---- 3. the drop was committed and persisted --------------------------------------
  const saved = store.get().dock;
  check('the drop snapped to the RIGHT edge (pointer ended near it)', saved.edge === 'right', JSON.stringify(saved));
  check('a numeric position along the edge was saved', typeof saved.along === 'number' && saved.along >= 0 && saved.along <= 1, `along=${saved.along}`);
  const after = win.getBounds();
  check('the dock RE-HOMED to the right edge', after.x + after.width === 1920, `window right edge at ${after.x + after.width}`);
  check('no drag state is left behind', dw.dragging === false && (await wc.executeJavaScript('document.body.classList.contains("dragging")')) === false);

  // ---- 4. remembered across a restart ------------------------------------------------
  store.flush();
  const reloaded = new SettingsStore(file);
  check('the placement SURVIVES a restart (settings file on disk)', reloaded.get().dock.edge === 'right' && Math.abs(reloaded.get().dock.along - saved.along) < 1e-9, JSON.stringify(reloaded.get().dock));

  // ---- 5. Escape cancels a drag ---------------------------------------------------------
  // The dock is on the RIGHT now. Drag it toward the LEFT edge, then press Escape. If Escape did
  // nothing, releasing there would have committed 'left' - so the assertion below can really fail.
  const pre = { ...store.get().dock };
  const bw = win.getBounds();
  const q0 = { x: bw.x + 20, y: bw.y + 20 };
  move(q0.x, q0.y); press(q0.x, q0.y); await sleep(50);
  await sweep(q0.x, q0.y, 40, 300, 6);
  const wandering = win.getBounds();
  check('(setup) the window really moved toward the left before Escape', wandering.x < bw.x - 500, `${bw.x} -> ${wandering.x}`);
  S({ type: 'keyDown', keyCode: 'Escape' }); S({ type: 'keyUp', keyCode: 'Escape' }); await sleep(400);
  const post = store.get().dock;
  check('Escape mid-drag commits NOTHING (still on the right edge)', post.edge === 'right' && post.along === pre.along, `${JSON.stringify(pre)} vs ${JSON.stringify(post)}`);
  // A later mouseup must not commit the abandoned drag either.
  release(40, 300); await sleep(300);
  check('a mouseup AFTER Escape does not commit the abandoned drag', store.get().dock.edge === 'right', JSON.stringify(store.get().dock));

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} drag end-to-end checks passed`);
  dw.destroy(); store.flush();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort; app.exit() skips process 'exit' handlers */ }
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('E2E crashed:', e); app.exit(2); });
