'use strict';
// REAL GNOME COMPOSITOR TEST for the Settings window: the real App, real Electron as a NATIVE Wayland client, under
// headless Mutter (the window manager of GNOME). It checks what only a real compositor can answer: does the window
// get mapped, focused and sized sensibly, does it stay on screen, does the island stay put, and does the page react to
// REAL pointer and keyboard input (not script clicks). The page logic itself is covered by e2e-settings.cjs.
//
//   export XDG_RUNTIME_DIR=$(mktemp -d); chmod 700 $XDG_RUNTIME_DIR; unset DISPLAY
//   dbus-run-session -- mutter --headless --wayland --no-x11 --virtual-monitor 1366x768 -- \
//     node_modules/electron/dist/electron scripts/e2e-settings-gnome.cjs --no-sandbox --disable-gpu --ozone-platform=wayland
// Optional: SHOT_DIR=/some/dir saves a picture of the page. Exits non-zero on any failure.
const electron = require('electron');
const { app, BrowserWindow, screen } = electron;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { App } = require('../src/main/app');

app.disableHardwareAcceleration();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`); };
const SHOTS = process.env.SHOT_DIR || '';

const watchdog = setTimeout(() => { console.error('E2E watchdog: took too long'); app.exit(3); }, 100_000);

async function waitFor(what, fn, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}`);
    await sleep(40);
  }
}

app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay();
  console.log(`display: bounds=${JSON.stringify(display.bounds)} workArea=${JSON.stringify(display.workArea)} scale=${display.scaleFactor}`);
  check('running as a NATIVE Wayland client (no X display)', !process.env.DISPLAY && !!process.env.WAYLAND_DISPLAY);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alles-e2e-settings-gnome-'));
  const built = new App({ electron, userDataDir: dir });
  built.create();
  await sleep(500);
  const pillBefore = JSON.stringify(built.dockWindow.win.getBounds());

  // ---- A. opening, the way a person does it: the gear button on the island -----------------------------------------------
  const t0 = Date.now();
  await built.dockWindow.win.webContents.executeJavaScript("window.pill.send('open-settings')");
  await waitFor('the Settings window', () => built.settingsWindow.isOpen && built.settingsWindow.win);
  const win = built.settingsWindow.win;
  const wc = win.webContents;
  const page = (js) => wc.executeJavaScript(js);
  const errors = [];
  wc.on('console-message', (_e, level, message) => { if (level >= 2) errors.push(message); });
  await waitFor('the page to load', () => !wc.isLoading());
  await waitFor('the provider list', () => page("document.querySelectorAll('.route').length"));
  const openMs = Date.now() - t0;
  check('the page is ready within 3 seconds of the click', openMs < 3000, `${openMs} ms`);
  check('the window is visible', win.isVisible());
  check('the compositor gave it keyboard focus', await waitFor('focus', () => win.isFocused(), 4000).catch(() => false), `focused=${win.isFocused()}`);
  check('the page itself has focus, so typing works at once', await waitFor('page focus', () => page('document.hasFocus()'), 3000).catch(() => false));

  const b = win.getBounds(); const cb = win.getContentBounds(); const d = screen.getDisplayMatching(b);
  console.log(`  window bounds ${JSON.stringify(b)}  content ${JSON.stringify(cb)}  screen ${d.bounds.width}x${d.bounds.height}`);
  // GNOME draws its own title bar and a shadow around the window, so the whole window is bigger than the page inside it.
  // What matters is the page area (all of it must be on the screen), and that only invisible shadow ever overhangs.
  check('the whole page area is on the screen', cb.x >= 0 && cb.y >= 0 && cb.x + cb.width <= d.bounds.width && cb.y + cb.height <= d.bounds.height, JSON.stringify(cb));
  check('the page area is between its smallest and its usual size', cb.width >= 640 && cb.width <= 940 && cb.height >= 480 && cb.height <= 700, `${cb.width}x${cb.height} on a ${d.bounds.width}x${d.bounds.height} screen`);
  const overhang = Math.max(0, -b.x, -b.y, b.x + b.width - d.bounds.width, b.y + b.height - d.bounds.height);
  check('the window overhangs the screen by at most a sliver of its own shadow', overhang <= 8, `${overhang}px`);
  check('on an ordinary screen it has its usual size', d.bounds.height < 800 || (cb.width === 940 && cb.height >= 660), `${cb.width}x${cb.height}`);
  check('the page fills the window (no blank strip)', await page('document.documentElement.scrollWidth <= window.innerWidth + 1'), await page('`${window.innerWidth}x${window.innerHeight}`'));
  check('there is no menu bar', !win.isMenuBarVisible());
  check('the island did not move or change while Settings opened', JSON.stringify(built.dockWindow.win.getBounds()) === pillBefore, `${pillBefore} -> ${JSON.stringify(built.dockWindow.win.getBounds())}`);
  check('exactly two windows exist: the island and Settings', BrowserWindow.getAllWindows().length === 2);
  if (SHOTS) { await sleep(700); fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, 'gnome-settings-open.png'), (await wc.capturePage()).toPNG()); }

  // ---- B. REAL pointer and keyboard input -------------------------------------------------------------------------------
  const centerOf = (selector, text) => page(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = els.find((e) => ${text === undefined ? 'true' : `e.textContent.trim() === ${JSON.stringify(text)}`});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  const click = async (selector, text) => {
    const pt = await centerOf(selector, text);
    if (!pt) throw new Error(`nothing to click: ${selector} ${text || ''}`);
    wc.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y }); await sleep(40);
    wc.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 1 }); await sleep(40);
    wc.sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: 1 }); await sleep(120);
  };
  const press = async (keyCode, modifiers = []) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); await sleep(20);
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await sleep(40);
  };
  const typeText = async (text) => {
    for (const ch of text) {
      wc.sendInputEvent({ type: 'keyDown', keyCode: ch });
      wc.sendInputEvent({ type: 'char', keyCode: ch });
      wc.sendInputEvent({ type: 'keyUp', keyCode: ch });
      await sleep(12);
    }
  };

  await click('.nav-item', 'Island');
  await waitFor('the Island section', () => page("document.querySelector('#h-island') !== null"), 3000);
  check('a real mouse click on a section name opens that section', true);
  await click('.seg-item', 'Left');
  await waitFor('the edge to change', () => built.settings.get().dock.edge === 'left', 3000);
  check('a real click on "Left" saved the new edge', true);
  await sleep(600);
  const moved = built.dockWindow.win.getBounds();
  check('...and the compositor moved the real island to the left edge', moved.x <= 4, JSON.stringify(moved));
  await click('.seg-item', 'Top');
  await waitFor('back to the top edge', () => built.settings.get().dock.edge === 'top', 3000);
  await sleep(500);
  check('...and back to the top edge', built.dockWindow.win.getBounds().y <= 4, JSON.stringify(built.dockWindow.win.getBounds()));

  await click('.nav-item', 'Providers');
  await waitFor('the provider list', () => page("document.querySelector('[data-fk=\"route:nvidia-primary:newkey\"]') !== null"), 3000);
  await click('[data-fk="route:nvidia-primary:newkey"]');
  check('clicking into the key box focuses it', await page("document.activeElement && document.activeElement.dataset.fk === 'route:nvidia-primary:newkey'"));
  const KEY = 'nvapiE2EREALKEYBOARD0123456789';
  await typeText(KEY);
  check('real keystrokes land in the box', (await page("document.activeElement.value")) === KEY, await page("document.activeElement.value.length + ' characters'"));
  check('the box hides what is typed', (await page("document.activeElement.type")) === 'password');
  await click('[data-fk="route:nvidia-primary:addkey"]');
  await waitFor('the key to be stored', () => built.keyStore.list('nvidia-primary').length === 1, 4000);
  check('a real click on "Add key" stored the key that was typed', built.keyStore.secrets('nvidia-primary')[0] === KEY);
  await waitFor('the key row', () => page("document.querySelector('.key-row') !== null"), 3000);
  check('the page shows only a short hint, never the key', (await page("document.querySelector('.key-hint').textContent")).length < 12 && !(await page('document.documentElement.outerHTML + document.body.innerText')).includes(KEY));

  // keyboard-only: Tab moves through controls and Space/Enter act on them
  await page('document.activeElement.blur()');
  await press('Tab');
  const firstFocus = await page("document.activeElement ? document.activeElement.tagName + ':' + (document.activeElement.dataset.fk || document.activeElement.textContent.trim().slice(0, 20)) : ''");
  check('Tab puts keyboard focus on a control of the page', /^(BUTTON|INPUT|A|MAIN)/.test(firstFocus), firstFocus);
  await press('Tab'); await press('Tab');
  const later = await page("document.activeElement ? document.activeElement.tagName + ':' + (document.activeElement.dataset.fk || document.activeElement.textContent.trim().slice(0, 20)) : ''");
  check('more Tabs move on to other controls', later !== firstFocus, later);

  // ---- C. resizing and reopening ---------------------------------------------------------------------------------------------
  win.setSize(300, 300);
  await sleep(700);
  const [w2, h2] = win.getSize();
  check('the window cannot be made smaller than its minimum', w2 >= 640 && h2 >= 480, `${w2}x${h2}`);
  check('at that smallest size the page still fits without sideways scrolling', await page('document.documentElement.scrollWidth <= window.innerWidth + 1'));
  win.setSize(1100, 740);
  await sleep(500);
  check('it can be made bigger', win.getSize()[0] >= 1000);

  const closed = new Promise((r) => win.once('closed', r));
  win.close();
  await closed;
  await sleep(200);
  check('closing the window leaves only the island', BrowserWindow.getAllWindows().length === 1 && !built.settingsWindow.isOpen);
  built.settingsWindow.open();
  await waitFor('the window again', () => built.settingsWindow.isOpen && built.settingsWindow.win);
  const again = built.settingsWindow.win;
  await waitFor('the page again', () => !again.webContents.isLoading() && again.webContents.executeJavaScript("document.querySelectorAll('.route').length"));
  check('Settings opens again, in a fresh window, and knows the key was saved (that provider no longer asks for one)', (await again.webContents.executeJavaScript("document.querySelector('.route .chip').textContent")) !== 'Add an API key.');
  built.settingsWindow.open();
  await sleep(300);
  check('asking again while it is open brings the same window forward (no second one)', BrowserWindow.getAllWindows().length === 2);
  check('no errors in the page console during the whole session', errors.length === 0, errors.join(' | '));

  built._teardown();
  fs.rmSync(dir, { recursive: true, force: true });
  clearTimeout(watchdog);
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} Settings-under-GNOME checks passed`);
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('E2E crashed:', e); app.exit(2); });
