'use strict';
// Real DockWindow + real renderer; screenshot each phase (light bg so edges are visible).
const electron = require('electron'); const { app, ipcMain } = electron;
const fs = require('node:fs'); const path = require('node:path');
const { DockWindow, attachPageEvents } = require('../src/main/overlay/window');
app.disableHardwareAcceleration();
const OUT = process.env.SHOT_DIR || '/tmp/shots'; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const edge = process.env.EDGE || 'top';
  const dw = new DockWindow({ electron, getPrefs: () => ({ edge, along: 0.5 }), isBusy: () => false });
  attachPageEvents(ipcMain, dw);
  const win = dw.create();
  await new Promise((r) => win.webContents.once('did-finish-load', r)); await sleep(400);
  const snap = async (name) => { await sleep(700); fs.writeFileSync(path.join(OUT, `${edge}-${name}.png`), (await win.webContents.capturePage()).toPNG()); const b = win.getBounds(); console.log(`${edge}-${name}: ${b.width}x${b.height} @ ${b.x},${b.y}`); };
  await snap('1-hidden');
  dw.pointerEnter(); await sleep(250); dw.dock.tick(); await snap('2-peek');
  dw.click(); await snap('3-island');
  // feed a realistic run so the activity log has history, like a real task would
  for (const tool of ['screenshot', 'mouse_click', 'type_text', 'press_keys', 'screenshot', 'mouse_click']) {
    dw.setStatus({ state: 'acting', detail: tool }); await sleep(120);
  }
  await snap('4-island-acting');
  dw.setStatus({ state: 'done', detail: 'Opened Firefox and saved the KDE 6.2 release notes to ~/Documents/plasma-notes.md.' }); await snap('5-island-done');
  dw.destroy(); app.exit(0);
});
