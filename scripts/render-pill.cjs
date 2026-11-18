'use strict';
// Dev tool: renders the REAL pill.html in Electron and saves PNGs of each state.
// Usage: xvfb-run -a electron scripts/render-pill.cjs --no-sandbox
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = process.env.SHOT_DIR || '/tmp/shots';
const STATES = [
  { name: '1-idle',      w: 168, h: 34,  status: { state: 'idle' } },
  { name: '2-thinking',  w: 168, h: 34,  status: { state: 'thinking', detail: 'Step 2' } },
  { name: '3-acting',    w: 168, h: 34,  status: { state: 'acting', detail: 'mouse_click' } },
  { name: '4-done',      w: 460, h: 132, status: { state: 'done', detail: 'I opened Firefox, searched for the KDE Plasma 6.2 release notes and saved a summary to ~/Documents/plasma-notes.md.' } },
  { name: '5-error',     w: 460, h: 132, status: { state: 'error', detail: 'All providers failed (nv-primary#0:503, nv-fallback#0:429)' } },
  { name: '6-waiting',   w: 460, h: 132, status: { state: 'waiting', detail: 'Run: rm -rf ~/Downloads/old-installers' } },
];

app.disableHardwareAcceleration(); // Xvfb has no GPU; also mirrors a weak iGPU worst case
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 168, height: 34, show: false, frame: false, transparent: true,
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, '../src/overlay/preload.cjs') },
  });
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) console.log(`[page error] ${msg}`); });
  win.webContents.on('did-fail-load', (_e, code, desc) => { console.error(`LOAD FAILED: ${code} ${desc}`); process.exitCode = 1; });

  await win.loadFile(path.join(__dirname, '../src/overlay/pill.html'));

  for (const s of STATES) {
    win.setContentSize(s.w, s.h);
    win.webContents.send('pill:status', s.status);
    await new Promise((r) => setTimeout(r, 1300)); // let transitions + keyframes settle
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${s.name}.png`), img.toPNG());
    const sz = img.getSize();
    console.log(`${s.name}: captured ${sz.width}x${sz.height}`);
  }
  app.quit();
}).catch((e) => { console.error('render failed:', e); process.exit(1); });
