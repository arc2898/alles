'use strict';
/**
 * Black-box test of the REAL app (`electron .`, the real entry point) inside a REAL GNOME Shell, with a real pointer.
 *
 *   scripts/gnome-e2e/run.sh 1366x768 node scripts/gnome-e2e/dock-flow.js
 *
 * Nothing here looks inside ALLES. It watches what the compositor says about ALLES's windows (where they really are
 * and how big), moves a virtual mouse and presses keys like a hand would, and reads the settings file the app writes.
 * Screenshots of the composed screen go to $ALLES_E2E_SHOTS (default: a temp folder) so the look can be checked by eye.
 *
 * ALLES_E2E_ONLY=A,B   runs only those scenarios:
 *   A first run on a desktop with a top bar     B pointer flow on a free edge     C launching ALLES again (shortcut path)
 *   D dragging the pill to another edge          E the top edge under the bar      F native Wayland (the fallback)
 *   G the Settings window, opened with a real click on the island's gear
 *   H the mouse resting on the island (only the mouse holds it open)
 *   I the desktop maximizes the pill (a global-menu top bar's button): it is undone and the pill is back in its place
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { dockRect, CONFIG } = require('../../src/main/overlay/dock');
const { sleep, waitFor, makeChecks, connectShell, connectPointer } = require('./lib');

const ROOT = path.resolve(__dirname, '../..');
const ELECTRON = require('electron');                       // in plain Node this is the path of the electron binary
const [W, H] = (process.env.ALLES_E2E_SCREEN || '1366x768').split('x').map(Number);
const ONLY = (process.env.ALLES_E2E_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const SHOTS = process.env.ALLES_E2E_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'alles-shots-'));
const KEY_ESC = 1;
const KEY_TAB = 15;
const { check, note, summary } = makeChecks();

const tmpDirs = [];
const mk = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };

// ---------------------------------------------------------------- running the real app

const FLAGS = ['--no-sandbox', '--disable-gpu'];             // this test machine has no GPU and runs as root; a real desktop needs neither

function launch(cfg, { env = {}, script = ROOT, args = [] } = {}) {
  const child = spawn(ELECTRON, [script, ...FLAGS, ...args], { cwd: ROOT, env: { ...process.env, XDG_CONFIG_HOME: cfg, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  const eat = (b) => { for (const l of String(b).split('\n')) if (l.trim()) lines.push(l); };
  child.stdout.on('data', eat); child.stderr.on('data', eat);
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return {
    child, lines, exited, cfg, started: Date.now(),
    async stop() { try { child.kill('SIGTERM'); } catch { /* gone */ } await Promise.race([exited, sleep(4000)]); try { child.kill('SIGKILL'); } catch { /* gone */ } },
  };
}

function seed(cfg, settings) {
  const dir = path.join(cfg, 'alles', 'alles');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
}
function readSettings(cfg) {
  const found = [];
  const walk = (d, depth) => { if (depth > 3) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, depth + 1); else if (e.name === 'settings.json') found.push(p); } };
  try { walk(cfg, 0); } catch { return null; }
  if (!found[0]) return null;
  try { return JSON.parse(fs.readFileSync(found[0], 'utf8')); } catch { return null; }
}

// ---------------------------------------------------------------- geometry

let WORKAREA = null;                                          // what the Shell says is free (screen minus the top bar)
const rectFor = (phase, edge, along = 0.5, extraHeight = 0) => dockRect({ phase, edge, along, workArea: WORKAREA, cfg: { ...CONFIG, extraHeight } });
const near = (a, b, tol = 0) => !!a && !!b && ['x', 'y', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) <= tol);
const show = (r) => (r ? `${r.x},${r.y} ${r.width}x${r.height}` : 'none');
const centreOf = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

async function main() {
  const shell = await connectShell();
  const pointer = await connectPointer(W, H);
  WORKAREA = await shell.json('(() => { const r = Main.layoutManager.getWorkAreaForMonitor(0); return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height }); })()');
  note(`screen ${W}x${H}; the Shell's free area is ${show(WORKAREA)} (the top bar takes ${WORKAREA.y}px)`);

  // ---- what the compositor says about the pill
  const pill = async () => { const w = (await shell.windowsTitled('ALLES'))[0]; return w ? { x: w.x, y: w.y, width: w.w, height: w.h } : null; };
  const waitPill = (rect, timeout = 8000, tol = 0) => waitFor(async () => near(await pill(), rect, tol), { timeout, interval: 80 });
  const waitIsland = (edge, timeout = 5000) => waitFor(async () => {
    const base = rectFor('island', edge); const p = await pill();
    if (!p || p.width !== base.width || p.height < base.height || p.height > base.height + 320) return null;
    return near(p, rectFor('island', edge, 0.5, p.height - base.height)) ? p : null;
  }, { timeout, interval: 80 });
  const focused = () => shell.eval('(global.display.focus_window ? global.display.focus_window.get_title() : "(none)")');
  const shot = async (name) => { try { return await shell.screenshot(path.join(SHOTS, `${name}.png`)); } catch (e) { note(`screenshot ${name} failed: ${e.message}`); return null; } };
  const on = (letter) => !ONLY.length || ONLY.includes(letter);

  let app = null;
  // Lines in the app's own output that look like trouble (desktop/graphics chatter is not the app's).
  const NOISE = /dbus|DRI3|libEGL|gpu|GPU|viz_|xkb|Fontconfig|vaapi|ozone_platform|sandbox|window system|placement not honoured|Gtk|GLib|gnome|GNOME|MESA|libva|egl|EGL|libdecor|Wayland|DevTools/i;
  const trouble = (a) => a.lines.filter((l) => /error|exception|uncaught|unhandled|ENOENT|TypeError/i.test(l) && !NOISE.test(l));
  const troubleSeen = [];
  const stopApp = async () => { if (app) { troubleSeen.push(...trouble(app)); await app.stop(); app = null; } await sleep(700); };
  const startApp = async (settings, { env = {}, args = [], wait = null } = {}) => {
    await stopApp();
    const cfg = mk('alles-cfg-e2e-');
    if (settings) seed(cfg, settings);
    app = launch(cfg, { env, args });
    const up = await waitFor(async () => !!(await pill()), { timeout: 60000, interval: 200 });
    if (!up) throw new Error(`ALLES never showed a window. Its log: ${app.lines.slice(-8).join(' | ')}`);
    if (wait) await waitPill(wait, 15000);
    return app;
  };
  const other = { proc: null };
  const openOther = async () => {
    other.proc = launch(mk('alles-other-'), { script: path.join(__dirname, 'other-window.js') });
    await waitFor(async () => (await shell.windowsTitled('OTHER')).length > 0, { timeout: 40000, interval: 200 });
    await sleep(500);
  };
  const closeOther = async () => { if (other.proc) { await other.proc.stop(); other.proc = null; } };

  // GNOME can bring the Overview (Activities) up by itself shortly after it starts. It covers the screen edges, so no pointer test
  // means anything while it is open (the pointer lands on its dock, not on our strip). Close it whenever it is found open.
  let overviewClosed = 0;
  const ensureDesktop = async () => {
    if ((await shell.eval('Main.overview.visible')) !== 'true') return;
    for (let k = 0; k < 20 && (await shell.eval('Main.overview.visible')) === 'true'; k++) { await shell.eval('Main.overview.hide()'); await sleep(300); }
    if (++overviewClosed === 1) note('the Shell was showing its Overview (Activities) over the desktop - closed it (a test machine quirk, not ALLES)');
  };

  // ---- common pointer moves
  const hoverStrip = async (edge, along = 0.5) => {
    await ensureDesktop();
    const strip = rectFor('hidden', edge, along);
    await pointer.park();
    const c = centreOf(strip);
    // approach from the open side so the pointer arrives like a hand would, then rest on the strip
    const startX = edge === 'left' || edge === 'right' ? (edge === 'left' ? 400 : W - 400) : c.x;
    const startY = edge === 'top' || edge === 'bottom' ? (edge === 'top' ? 400 : H - 400) : c.y;
    await pointer.jump(startX, startY); await sleep(100);
    await pointer.glide(c.x, c.y, { steps: 30, ms: 10 });
    return Date.now();
  };
  const awayFromEdge = async () => { await pointer.glide(W / 2, H / 2, { steps: 25, ms: 12 }); };
  // A freshly started app needs a moment before its page listens (a pointer resting on the strip while the page is still loading
  // is not heard - same as for a person, who just moves the mouse again). Try again, like a hand would, until the peek shows.
  // Patient on purpose: the first start after a cold boot of a slow machine can take half a minute.
  const revealStrip = async (edge, along = 0.5, timeout = 60000) => {
    const end = Date.now() + timeout;
    for (let i = 1; Date.now() < end; i++) {
      await hoverStrip(edge, along);
      if (await waitPill(rectFor('peek', edge, along), 1500)) return i;
      await awayFromEdge();
    }
    return 0;
  };

  try {
    // =========================================================== A. first run
    if (on('A')) {
      console.log('\n--- A. First run on a desktop with a top bar');
      await startApp(null);
      check('ALLES reports that it runs in X11 mode (through XWayland) on this Wayland desktop', app.lines.some((l) => /window system: x11 \(electron-default\)/.test(l)), app.lines.find((l) => /window system/.test(l)) || 'no log line');
      const seen = (await shell.windowsTitled('ALLES'))[0];
      check('and the desktop agrees: it sees ALLES as an X11 window (the log is not just a claim)', !!seen && seen.client === 'x11', seen ? `client: ${seen.client}` : 'no window');
      const peekRect = rectFor('peek', 'bottom');
      const sawPeek = await waitPill(peekRect, 8000);
      check('first run: the welcome peek shows, on the BOTTOM edge (the top has the GNOME bar)', sawPeek, `want ${show(peekRect)}, got ${show(await pill())}`);
      if (sawPeek) await shot('A1-welcome');
      const hid = await waitPill(rectFor('hidden', 'bottom'), 12000);
      check('the welcome peek goes away by itself', hid, hid ? 'back to the 8x2 strip' : `still ${show(await pill())}`);
      const st = readSettings(app.cfg);
      check('the bottom edge was remembered in the settings file', st && st.dock && st.dock.edge === 'bottom', st ? `edge=${st.dock && st.dock.edge}` : 'no settings file');
      const strip = rectFor('hidden', 'bottom');
      check('the hidden strip is exactly 8x2 px, flush with the bottom of the screen', hid && strip.width === 8 && strip.height === 2 && strip.y + strip.height === H, `${show(await pill())}`);
    }

    // =========================================================== B. pointer flow on a free edge
    if (on('B')) {
      console.log('\n--- B. Pointer on the bottom edge: hover, peek, click, island, close');
      if (!app) await startApp({ dock: { edge: 'bottom', along: 0.5 } }, { wait: rectFor('hidden', 'bottom') });
      await waitPill(rectFor('hidden', 'bottom'), 15000);
      await openOther();                                           // another app on screen, to click on later

      // The first hover of an app that has only just started can come before its page has finished loading (a cold or slow machine -
      // seen once on the first run after the test machine was restored). A pointer resting on the strip while the page is still
      // loading is not heard, for a person too, who simply moves the mouse again. So the first reveal is a patient setup step;
      // the plain one-hover check follows on the next round, when the page is certainly up.
      const tries = await revealStrip('bottom');
      check('(setup) the pill reveals', tries > 0, tries ? `after ${tries} hover${tries > 1 ? 's' : ''}` : 'never revealed');
      if (tries > 1) note(`the first hover needed ${tries} tries - the app's page was probably still loading`);
      await awayFromEdge(); await waitPill(rectFor('hidden', 'bottom'), 4000);

      const t0 = await hoverStrip('bottom');
      const peeked = await waitPill(rectFor('peek', 'bottom'), 3000);
      check('resting the pointer on the hidden strip reveals the peek pill', peeked, peeked ? `${Date.now() - t0} ms after setting off` : `still ${show(await pill())}`);
      await awayFromEdge();
      check('moving the pointer away hides the peek pill again', await waitPill(rectFor('hidden', 'bottom'), 4000));

      await hoverStrip('bottom');
      await waitPill(rectFor('peek', 'bottom'), 3000);
      await sleep(300); await shot('B1-peek');
      const c = centreOf(rectFor('peek', 'bottom'));
      await pointer.glide(c.x, c.y, { steps: 6, ms: 15 });
      await pointer.click();
      const isl = await waitIsland('bottom');
      check('clicking the peek pill opens the island', !!isl, isl ? `${show(isl)} (grew ${isl.height - rectFor('island', 'bottom').height}px)` : `still ${show(await pill())}`);
      if (isl) {
        await sleep(600); await shot('B2-island');
        check('the island is flush against the bottom edge', isl.y + isl.height === WORKAREA.y + WORKAREA.height, `bottom at ${isl.y + isl.height}`);
        const f = await focused();
        check('the island has the keyboard right after the click (typing works at once)', f === 'ALLES', `focus: ${f}`);
        await awayFromEdge();
        await sleep(1500);
        check('moving away does NOT close the island while its box has the keyboard (it waits for Esc or a click elsewhere)', !!(await waitIsland('bottom', 300)), show(await pill()));
        await pointer.key(KEY_ESC);
        check('Esc closes the island', await waitPill(rectFor('hidden', 'bottom'), 4000), show(await pill()));
      }

      // opened again, then "click outside" = click on another application
      await hoverStrip('bottom'); await waitPill(rectFor('peek', 'bottom'), 3000);
      await pointer.glide(c.x, c.y, { steps: 6, ms: 15 }); await pointer.click();
      if (await waitIsland('bottom')) {
        await pointer.glide(200, 200, { steps: 20, ms: 12 });            // onto the other window
        await pointer.click();
        check('clicking another application closes the island (click outside)', await waitPill(rectFor('hidden', 'bottom'), 4000), `${show(await pill())}; focus now: ${await focused()}`);
      } else check('(setup) the island opened for the click-outside check', false);
      await closeOther();

      // a quick flick straight into the bottom screen edge
      await pointer.park(); await pointer.jump(rectFor('hidden', 'bottom').x + 4, 300); await sleep(200);
      await pointer.slam(0, 2000);
      check('a quick push down against the bottom edge reveals the pill (the screen edge stops the pointer on the strip)', await waitPill(rectFor('peek', 'bottom'), 3000), show(await pill()));
      await awayFromEdge(); await waitPill(rectFor('hidden', 'bottom'), 4000);
    }

    // =========================================================== C. launching ALLES again
    if (on('C')) {
      console.log('\n--- C. Launching ALLES a second time (what a desktop keyboard shortcut would do)');
      if (!app) await startApp({ dock: { edge: 'bottom', along: 0.5 } }, { wait: rectFor('hidden', 'bottom') });
      // The pointer visits the pill and leaves BEFORE the keyboard side opens the island. That is the situation in which the island used
      // to be shut again within one tick (the hide timer still held the time of that old visit) - about half of all openings did
      // nothing, depending on timing alone. A fresh app that never saw the pointer would not show it.
      const visits = await revealStrip('bottom');
      check('(setup) the pointer visits the pill and leaves again', visits > 0 && (await (async () => { await awayFromEdge(); return waitPill(rectFor('hidden', 'bottom'), 5000); })()), visits ? `after ${visits} hover${visits > 1 ? 's' : ''}` : 'never revealed');
      await pointer.park();
      await waitPill(rectFor('hidden', 'bottom'), 15000);
      const again = async () => { const p = launch(app.cfg); const code = await Promise.race([p.exited, sleep(30000)]); return { code, lines: p.lines }; };
      const t0 = Date.now();
      const r1 = await again();
      const isl = await waitIsland('bottom', 8000);
      check('the second copy hands over and exits on its own', r1.code === 0, `exit code ${r1.code}; ${r1.lines.filter((l) => /another instance/.test(l)).join('')}`);
      check('and the island opens', !!isl, isl ? `${show(isl)}, ${Date.now() - t0} ms after launching` : `still ${show(await pill())}`);
      if (isl) {
        await sleep(2500);
        check('and it STAYS open with nobody pointing at it (the pointer rules must not shut an island that the keyboard asked for)', !!(await waitIsland('bottom', 300)), show(await pill()));
        const f = await focused();
        check('the island gets the keyboard (so the person can type straight away)', f === 'ALLES', `focus: ${f} (GNOME may refuse to give the keyboard to a window the person did not click)`);
        await shot('C1-island-by-launch');
      }
      await again();
      check('launching it again closes the island, leaving no pill behind', await waitPill(rectFor('hidden', 'bottom'), 8000), show(await pill()));

      // The old failure was a coin toss (it depended on whether the desktop happened to report a pointer crossing within one tick),
      // so one good opening proves little. Do it twice more, each time after another visit by the pointer.
      for (let round = 2; round <= 3; round++) {
        const v = await revealStrip('bottom');
        await awayFromEdge(); await waitPill(rectFor('hidden', 'bottom'), 5000); await pointer.park();
        await again();
        const open = await waitIsland('bottom', 8000);
        if (open) await sleep(1500);
        const stays = !!open && !!(await waitIsland('bottom', 300));
        check(`round ${round}: after another visit by the pointer, launching again opens the island and it stays`, v > 0 && stays, open ? (stays ? 'open and still open 1.5 s later' : 'opened, then closed by itself') : `never opened: ${show(await pill())}`);
        if (await waitIsland('bottom', 200)) { await again(); check(`round ${round}: and launching once more closes it`, await waitPill(rectFor('hidden', 'bottom'), 8000), show(await pill())); }
      }
    }

    // =========================================================== D. dragging
    if (on('D')) {
      console.log('\n--- D. Dragging the pill to another edge');
      await startApp({ dock: { edge: 'bottom', along: 0.5 } }, { wait: rectFor('hidden', 'bottom') });
      const tries = await revealStrip('bottom');
      check('(setup) the pill reveals so there is something to grab', tries > 0, tries ? `after ${tries} hover${tries > 1 ? 's' : ''}` : 'never revealed');
      const c = centreOf(rectFor('peek', 'bottom'));
      await pointer.glide(c.x, c.y, { steps: 6, ms: 15 });
      await pointer.down(); await sleep(80);
      await pointer.glide(W - 40, H / 2, { steps: 40, ms: 14 });
      await sleep(250); await shot('D1-dragging');
      const mid = await pill();
      // The desktop keeps a window on the screen, so near the edge the pill may sit a little behind the pointer; it must still be UNDER it.
      const under = !!mid && pointer.at.x >= mid.x - 2 && pointer.at.x <= mid.x + mid.width + 2 && pointer.at.y >= mid.y - 2 && pointer.at.y <= mid.y + mid.height + 2;
      check('while dragging, the pill stays under the pointer (no lag, no drift)', under, `pointer at ${pointer.at.x},${pointer.at.y}; the pill is at ${show(mid)}`);
      await pointer.glide(W - 2, H / 2, { steps: 6, ms: 14 });
      await pointer.up();
      await sleep(900);
      const st = readSettings(app.cfg);
      check('letting go against the right edge remembers the RIGHT edge', st && st.dock && st.dock.edge === 'right', st ? `edge=${st.dock.edge} along=${st.dock.along}` : 'no settings file');
      if (st && st.dock && st.dock.edge === 'right') {
        const along = st.dock.along;
        check('the position along the edge is where the hand let go (about the middle of the screen height)', Math.abs(along - 0.5) < 0.15, `along=${along}`);
        await awayFromEdge();
        check('and the pill rests there as a hidden strip', await waitPill(rectFor('hidden', 'right', along), 6000), `want ${show(rectFor('hidden', 'right', along))}, got ${show(await pill())}`);
        const again = await revealStrip('right', along);
        check('hovering the strip on its new edge reveals the pill', again > 0, show(await pill()));
        await awayFromEdge();
      }
    }

    // =========================================================== E. the top edge under the GNOME bar
    if (on('E')) {
      console.log('\n--- E. A pill placed on the TOP edge, under the GNOME bar (the case the free-edge start avoids)');
      await startApp({ dock: { edge: 'top', along: 0.5 } }, { wait: rectFor('hidden', 'top') });
      const strip = rectFor('hidden', 'top');
      check('the strip sits right under the bar, not behind it', near(await pill(), strip), `want ${show(strip)}, got ${show(await pill())}`);
      // First prove the pill CAN be revealed here (so "does not reveal" below means something), by creeping up onto the strip.
      let crept = false;
      for (let i = 0; i < 8 && !crept; i++) {
        await pointer.park(); await pointer.jump(strip.x + 4, 200); await sleep(200);
        await pointer.glide(strip.x + 4, strip.y + 1, { steps: 60, ms: 20 });
        crept = !!(await waitPill(rectFor('peek', 'top'), 2000));
        if (!crept) await awayFromEdge();
      }
      check('creeping up slowly onto the strip does reveal it', crept, show(await pill()));
      await awayFromEdge();
      check('(setup) it hides again', await waitPill(strip, 4000), show(await pill()));
      await pointer.park(); await pointer.jump(strip.x + 4, 300); await sleep(200);
      await pointer.slam(0, -2000);                                // push up as hard as possible: ends INSIDE the bar
      await sleep(900);
      check('pushing the pointer up against the screen top does NOT reveal it - the bar is in the way (this is why ALLES starts on a free edge)', near(await pill(), strip), show(await pill()));
      await awayFromEdge();
    }

    // =========================================================== F. native Wayland, the fallback
    if (on('F')) {
      console.log('\n--- F. Native Wayland (started with --ozone-platform=wayland): what happens when the desktop decides where windows go');
      await startApp({ dock: { edge: 'bottom', along: 0.5 } }, { args: ['--ozone-platform=wayland'] });
      await sleep(3000);
      const p = await pill(); const want = rectFor('hidden', 'bottom');
      const w = (await shell.windowsTitled('ALLES'))[0];
      check('it runs as a native Wayland app when asked to - and the desktop agrees', !!w && w.client === 'wayland' && app.lines.some((l) => /window system: wayland \(command-line\)/.test(l)), `${app.lines.find((l) => /window system/.test(l)) || 'no log line'}; desktop sees: ${w && w.client}`);
      note(`asked for the strip at ${show(want)}; the Shell put the window at ${show(p)}`);
      check('on native Wayland the desktop does NOT honour the placement (this is why ALLES runs in X11 mode)', !near(p, want), show(p));
      check('and ALLES says so in its log', app.lines.some((l) => /placement not honoured/.test(l)), app.lines.find((l) => /placement/.test(l)) || 'nothing logged');
    }

    // =========================================================== G. the Settings window
    if (on('G')) {
      console.log('\n--- G. The Settings window, opened from the island with a real click on its gear button');
      await startApp({ dock: { edge: 'bottom', along: 0.5 } }, { wait: rectFor('hidden', 'bottom') });
      const tries = await revealStrip('bottom');
      check('(setup) the pill reveals', tries > 0);
      const pc = centreOf(rectFor('peek', 'bottom'));
      await pointer.glide(pc.x, pc.y, { steps: 6, ms: 15 }); await pointer.click();
      const isl = await waitIsland('bottom');
      check('(setup) the island opens', !!isl, show(await pill()));
      if (isl) {
        // The gear sits in the island's top-right corner: 426 px right of and 45 px below the island's top-left (read off a screenshot).
        const gear = { x: isl.x + 426, y: isl.y + 45 };
        await pointer.glide(gear.x, gear.y, { steps: 10, ms: 15 }); await sleep(200);
        await pointer.click();
        const sw = await waitFor(async () => (await shell.windowsTitled('ALLES Settings'))[0], { timeout: 20000, interval: 200 });
        check('a click on the gear opens the Settings window', !!sw);
        if (sw) {
          await sleep(1500);
          const w = (await shell.windowsTitled('ALLES Settings'))[0] || sw;
          const onScreen = w.x >= 0 && w.y >= 0 && w.x + w.w <= W && w.y + w.h <= H;
          check('it is a sensible size and entirely on the screen', w.w >= 640 && w.h >= 480 && onScreen, `${w.x},${w.y} ${w.w}x${w.h} on a ${W}x${H} screen`);
          check('it is an X11 window like the pill (same mode)', w.client === 'x11', w.client);
          const f = await focused();
          check('it has the keyboard', f === 'ALLES Settings', `focus: ${f}`);
          check('the pill itself did not move: the island closed back to its strip', near(await pill(), rectFor('hidden', 'bottom')), show(await pill()));
          await shot('G1-settings');
        }
      }
    }

    // =========================================================== H. the mouse resting on the island
    if (on('H')) {
      console.log('\n--- H. The mouse resting on the island (the box does not have the keyboard, so only the mouse holds it open)');
      await startApp({ dock: { edge: 'bottom', along: 0.5 } }, { wait: rectFor('hidden', 'bottom') });
      const tries = await revealStrip('bottom');
      check('(setup) the pill reveals', tries > 0);
      const pc = centreOf(rectFor('peek', 'bottom'));
      await pointer.glide(pc.x, pc.y, { steps: 6, ms: 15 }); await pointer.click();
      const isl = await waitIsland('bottom');
      check('(setup) the island opens', !!isl, show(await pill()));
      if (isl) {
        await sleep(600);
        await pointer.key(KEY_TAB);                    // the box lets go of the keyboard; nothing was typed, so there is nothing to protect
        await sleep(2500);
        check('the island stays open while the mouse rests on it, although its box no longer has the keyboard', !!(await waitIsland('bottom', 300)), show(await pill()));
        await awayFromEdge();
        check('and once the mouse leaves it closes by itself after the short grace', await waitPill(rectFor('hidden', 'bottom'), 5000), show(await pill()));
      }
    }

    // =========================================================== I. the desktop maximizes the pill
    if (on('I')) {
      console.log('\n--- I. A top bar with window controls maximizes the pill (as the Global Menu extension does)');
      await startApp({ dock: { edge: 'bottom', along: 0.5 } }, { wait: rectFor('hidden', 'bottom') });
      const before = await pill();
      check('(setup) the pill window exists', !!before, show(before));
      const can = await shell.eval(`(() => { const w = global.get_window_actors().map((a) => a.meta_window).find((w) => w.get_title() === 'ALLES'); return w ? String(w.can_maximize()) : 'none'; })()`);
      check('the desktop itself says the pill cannot be maximized', can === 'false', can);
      for (const how of ['minimize()', 'maximize(Meta.MaximizeFlags.BOTH)', 'make_fullscreen()']) {
        await shell.eval(`(() => { const w = global.get_window_actors().map((a) => a.meta_window).find((w) => w.get_title() === 'ALLES'); if (w) w.${how}; return 'ok'; })()`);
        const back = await waitPill(rectFor('hidden', 'bottom'), 6000);
        const st = await shell.eval(`(() => { const w = global.get_window_actors().map((a) => a.meta_window).find((w) => w.get_title() === 'ALLES'); return w ? [w.get_maximized(), w.is_fullscreen(), w.minimized].join() : 'none'; })()`);
        // (a full-screen flag the Shell sets by itself changes nothing the person sees: the size and place are what count)
        const flags = how.startsWith('make_fullscreen') ? st.split(',').filter((_, i) => i !== 1).join() === '0,false' : st === '0,false,false';
        check(`after the desktop does ${how.split('(')[0]} the pill is back at its own place and not maximized or minimized`, back && flags, `${show(await pill())}; ${st}`);
      }
    }

    // =========================================================== the app's own log
    await stopApp();
    check('the app printed no errors of its own, in any scenario', troubleSeen.length === 0, troubleSeen.slice(0, 3).join(' | '));
  } finally {
    await closeOther();
    await stopApp();
    await pointer.stop();
    shell.close();
    note(`screenshots are in ${SHOTS}`);
  }
}

main().then(() => { const ok = summary(); for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } process.exit(ok ? 0 : 1); })
  .catch((e) => { console.error('TEST SCRIPT ERROR', e && e.stack || e); process.exit(2); });
