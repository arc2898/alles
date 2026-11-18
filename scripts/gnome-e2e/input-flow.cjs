'use strict';
/**
 * Black-box test of ALLES's GNOME-native mouse and keyboard (GNOME's own remote-input service, no ydotool) inside a REAL GNOME Shell.
 *
 *   scripts/gnome-e2e/run.sh 1366x768 node_modules/.bin/electron scripts/gnome-e2e/input-flow.cjs --no-sandbox --disable-gpu --ozone-platform=x11
 *
 * It runs under Electron (not plain Node) because pasting needs a REAL clipboard, and ALLES hands the backend Electron's.
 * The input goes through the real InputController (the safe front the agent uses) and the real MutterBackend/MutterTransport. What
 * arrives is read back from small windows (target-window.js) whose titles list every mouse and keyboard event they received; the
 * test never looks inside the code it is testing.
 *
 * ALLES_E2E_ONLY=A,B   runs only those scenarios:
 *   A a cold click       B double, right, middle clicks      C dragging       D scrolling (X11 window, then native Wayland window)
 *   E typing text        F every printable character         G shortcuts      H what is pasted, and the clipboard afterwards
 *   I the session closes by itself when idle, and the person pressing Stop on the sharing indicator stops everything
 *   J the picture the model gets and the pointer agree, on any scale and with several screens (see ALLES_E2E_SCALES)
 *
 * ALLES_E2E_SCALES=2   give the screens these scales (left to right: "2,1") before anything starts, the way the Settings app does. Start the Shell
 *                      with screens big enough for it (run.sh 2732x1536 for scale 2; a fractional scale needs a size that gives whole logical
 *                      pixels, 2560x1440 for 1.25) and, for several screens, one size each: run.sh 2732x1536,1366x768 with ALLES_E2E_SCALES=2,1
 *
 * ALLES_E2E_LAYOUTS=de,fr+oss   which keyboard layouts F tries (default: a spread of 35; "all" = every layout the generated table knows, ~90 minutes: set ALLES_E2E_MINUTES too)
 * ALLES_E2E_MINUTES=20          how long the whole run may take before it is abandoned
 * ALLES_E2E_SHOTS=dir           save pictures of the screen here
 */
const { app, clipboard, nativeImage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { sleep, waitFor, makeChecks, connectShell } = require('./lib');
const { applyScales, scalesFromEnv } = require('./display');
const { MutterBackend } = require('../../src/main/computer/mutter-backend');
const { InputController, SafetyGate } = require('../../src/main/computer/input');
const { readLayout, canType, ALL_ASCII } = require('../../src/main/computer/keyboard-layout');
const { ScreenCapture } = require('../../src/main/computer/screen');
const LAYOUT_DATA = require('../../src/main/computer/keyboard-layout-data');

app.disableHardwareAcceleration();
const ROOT = path.resolve(__dirname, '../..');
const ONLY = (process.env.ALLES_E2E_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const on = (letter) => !ONLY.length || ONLY.includes(letter);
const SHOTS = process.env.ALLES_E2E_SHOTS || '';
const { check, note, summary } = makeChecks();
const FLAGS = ['--no-sandbox', '--disable-gpu'];

// The scales the screens are given (left to right), and the one ALLES's pixels are in: the largest, because the picture of the whole desktop (and the
// pointer's stream) is made at the largest scale. A window reports positions in logical pixels, the input takes pixels of that picture.
const { scales: SCALES, scale: SCALE } = scalesFromEnv();

const tmpDirs = [];
const mk = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };

// ---------------------------------------------------------------- the little windows that report what reaches them

function launch(script, env = {}, args = []) {
  const child = spawn(process.execPath, [script, ...FLAGS, ...args], { cwd: ROOT, env: { ...process.env, XDG_CONFIG_HOME: mk('alles-input-cfg-'), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  const eat = (b) => { for (const l of String(b).split('\n')) if (l.trim()) lines.push(l); };
  child.stdout.on('data', eat); child.stderr.on('data', eat);
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, lines, exited, async stop() { try { child.kill('SIGTERM'); } catch { /* gone */ } await Promise.race([exited, sleep(3000)]); try { child.kill('SIGKILL'); } catch { /* gone */ } } };
}

async function main() {
  const shell = await connectShell();
  const ok = (v) => !!v;

  const wanted = async (id) => {
    // (GNOME puts invisible left-to-right / right-to-left marks around a title that has Hebrew or Arabic letters in it: they are not part of what the window said)
    const all = (await shell.windows()).map((x) => (typeof x.title === 'string' ? { ...x, title: x.title.replace(/^[\u200e\u200f\u202a-\u202e\u2066-\u2069]+|[\u200e\u200f\u202a-\u202e\u2066-\u2069]+$/g, '') } : x));
    const w = all.find((x) => typeof x.title === 'string' && x.title.startsWith(`T${id} `));
    const tgt = targets.find((x) => x.id === id);
    if (!w) {
      if (tgt && tgt.seen && !tgt.missingSaid) {                                    // it WAS there: say what became of it (once)
        tgt.missingSaid = true;
        note(`window ${id} is gone from the desktop. Its process: ${tgt.proc.child.exitCode === null && tgt.proc.child.signalCode === null ? 'still running' : `ended (code ${tgt.proc.child.exitCode}, signal ${tgt.proc.child.signalCode})`}; its log: ${tgt.proc.lines.slice(-6).join(' | ') || '(nothing)'}; windows there: ${all.map((x) => JSON.stringify(String(x.title).slice(0, 40))).join(', ') || '(none)'}`);
      }
      return null;
    }
    if (tgt) { tgt.seen = true; tgt.missingSaid = false; }
    let st; try { st = JSON.parse(w.title.slice(`T${id} `.length)); } catch (e) {
      if (!wanted.complained) { wanted.complained = true; note(`the title of window ${id} could not be read (${e.message}); ${w.title.length} characters: ${JSON.stringify(w.title.slice(0, 120))} ... ${JSON.stringify(w.title.slice(-120))}`); }
      return null;
    }
    return { ...st, frame: { x: w.x, y: w.y, w: w.w, h: w.h }, client: w.client };
  };

  const targets = [];
  /** Open a window that reports what it receives. `native` = a native Wayland window instead of X11 (through XWayland). `view` = what it reports (see target-window.js). */
  async function openTarget({ id = '1', x = 100, y = 120, native = false, view = '' } = {}) {
    const proc = launch(path.join(__dirname, 'target-window.js'), { TARGET_ID: id, TARGET_X: String(x), TARGET_Y: String(y), TARGET_VIEW: view }, native ? ['--ozone-platform=wayland'] : ['--ozone-platform=x11']);
    const t = { id, proc, native, origin: null, state: () => wanted(id) };
    targets.push(t);
    const first = await waitFor(async () => { const s = await wanted(id); return s && s.box ? s : null; }, { timeout: 60000, interval: 200 });
    if (!first) throw new Error(`the target window ${id} never appeared. Its log: ${proc.lines.slice(-6).join(' | ')}`);
    await sleep(600);
    return t;
  }
  const closeTarget = async (t) => { await t.proc.stop(); targets.splice(targets.indexOf(t), 1); await sleep(400); };

  // ---------------------------------------------------------------- the input under test: the safe front over the real GNOME backend

  const log = [];
  const clip = { writes: 0, cleared: 0 };
  const spyClipboard = {
    readText: () => clipboard.readText(),
    writeText: (t) => { clip.writes++; clipboard.writeText(t); },
    clear: () => { clip.cleared++; clipboard.clear(); },
    availableFormats: () => clipboard.availableFormats(),
  };
  const gate = new SafetyGate({ maxActionsPerMinute: 100000 });
  let stopsByPerson = 0;
  const makeBackend = (extra = {}) => new MutterBackend({ clipboard: spyClipboard, onUserStop: () => { stopsByPerson++; }, log: (m) => log.push(m), layoutTtlMs: 0, ...extra });
  let backend = makeBackend();
  const input = new InputController({ gate, backend });
  const fresh = async (extra = {}) => { await backend.dispose(); backend = makeBackend(extra); input.setBackend(backend, { closeOld: false }); };

  // ---------------------------------------------------------------- helpers

  /** Where is the page's top-left corner on the screen? Learned by clicking: page = screen - origin. Also the cold-click test. */
  async function calibrate(t) {
    const s = await t.state();
    const sx = s.frame.x + Math.round(s.frame.w / 2); const sy = s.frame.y + Math.round(s.frame.h / 2);
    await input.moveTo(Math.round(sx * SCALE), Math.round(sy * SCALE));                   // (the window's place is in logical pixels; the input is in the picture's)
    await input.click('left');
    const after = await waitFor(async () => { const n = await t.state(); return n && n.c === s.c + 1 && n.u === s.u + 1 ? n : null; }, { timeout: 6000, interval: 100 });
    if (!after) return { landed: false, sx, sy };
    t.origin = { x: sx - after.last[0], y: sy - after.last[1] };
    return { landed: true, sx, sy, after };
  }
  const at = (t, px, py) => ({ x: Math.round(SCALE * (t.origin.x + px)), y: Math.round(SCALE * (t.origin.y + py)) });         // a spot in a window's page -> a pixel of the picture
  const settle = (ms = 400) => sleep(ms);
  const stateAfter = async (t, pred, timeout = 5000) => waitFor(async () => { const n = await t.state(); return n && pred(n) ? n : null; }, { timeout, interval: 100 });
  const focusBox = async (t) => {
    const s = await t.state();
    const p = at(t, s.box[0] + s.box[2] / 2, s.box[1] + s.box[3] / 2);
    await input.moveTo(p.x, p.y); await input.click('left');
    await stateAfter(t, (n) => n.boxFocus === true);
  };
  const clearBox = async (t) => { await focusBox(t); await input.pressCombo('ctrl+a'); await input.pressCombo('backspace'); await stateAfter(t, (n) => n.tl === 0); };
  const shot = async (name) => { if (!SHOTS) return; try { fs.mkdirSync(SHOTS, { recursive: true }); await shell.screenshot(path.join(SHOTS, `${name}.png`)); } catch (e) { note(`screenshot ${name} failed: ${e.message}`); } };

  // GNOME can bring the Overview up by itself shortly after it starts; it would swallow everything. Close it if it is there.
  const ensureDesktop = async () => { for (let k = 0; k < 20 && (await shell.eval('Main.overview.visible')) === 'true'; k++) { await shell.eval('Main.overview.hide()'); await sleep(300); } };
  await ensureDesktop();
  if (SCALES.length) {
    const got = await applyScales(SCALES);
    note(`the screens were given scales ${got.map((g) => `${g.scale}${g.scale !== g.wanted ? ` (${g.wanted} asked; ${g.mode} allows ${g.supported.join('/')})` : ''}`).join(', ')}`);
    check('the screens have the scale that was asked for (a small screen allows only scale 1: use a bigger one, e.g. 2732x1536 for scale 2, 1600x1000 for 1.25)', got.every((g) => Math.abs(g.scale - g.wanted) < 1e-6), got.map((g) => `${g.scale} of ${g.wanted}`).join(', '));
    await ensureDesktop();
  }

  let x11 = null;

  // ================================================================ A. a cold click
  if (on('A') || ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'].some(on)) {
    x11 = await openTarget({ id: '1', x: 100, y: 120 });
    const cal = await calibrate(x11);
    check('A. a click on a brand-new session lands: pressed once, released once, with ONE move before it', cal.landed);
    if (cal.landed) {
      const a = cal.after;
      check('A. ...exactly where it was aimed (the screen position the window saw is the position sent)', Math.abs(a.last[2] - cal.sx) <= 1 && Math.abs(a.last[3] - cal.sy) <= 1, `sent ${cal.sx},${cal.sy}; the window saw ${a.last[2]},${a.last[3]}`);
      check('A. ...with the left button', a.last[4] === 0);
    }
    note(`log of the backend so far: ${log.join(' | ') || '(nothing)'}`);
  }

  const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
  const textHash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };      // the same one target-window.js reports
  const padCentre = async (t) => { const s = await t.state(); return at(t, s.pad[0] + s.pad[2] / 2, s.pad[1] + s.pad[3] / 2); };

  // ================================================================ B. double, right and middle clicks
  if (on('B')) {
    const t = x11;
    const c0 = await padCentre(t);
    await input.moveTo(c0.x, c0.y);
    const s0 = await t.state();
    await input.click('left', { double: true });
    const s1 = await stateAfter(t, (n) => n.u === s0.u + 2);
    check('B. a double click is two presses, two releases and ONE double-click', ok(s1) && s1.c === s0.c + 2 && s1.dbl === s0.dbl + 1, s1 ? `presses ${s1.c - s0.c}, double-clicks ${s1.dbl - s0.dbl}` : 'nothing arrived');
    await settle(800);
    const a2 = await t.state();
    await input.click('left');
    const s2 = await stateAfter(t, (n) => n.u === a2.u + 1);
    check('B. a plain click right afterwards is a single click (no double-click)', ok(s2) && s2.c === a2.c + 1 && s2.dbl === a2.dbl && s2.last[4] === 0);
    await settle(800);
    const a3 = await t.state();
    await input.click('right');
    const s3 = await stateAfter(t, (n) => n.u === a3.u + 1);
    check('B. a right click uses the right button and asks the window for its menu once', ok(s3) && s3.last[4] === 2 && s3.ctx === a3.ctx + 1 && s3.c === a3.c + 1, s3 ? `button ${s3.last[4]}, menus ${s3.ctx - a3.ctx}` : 'nothing arrived');
    await settle(500);
    const a4 = await t.state();
    await input.click('middle');
    const s4 = await stateAfter(t, (n) => n.u === a4.u + 1);
    check('B. a middle click uses the middle button (and is no menu)', ok(s4) && s4.last[4] === 1 && s4.c === a4.c + 1 && s4.ctx === a4.ctx, s4 ? `button ${s4.last[4]}` : 'nothing arrived');
  }

  // ================================================================ C. dragging
  if (on('C')) {
    const t = x11;
    const s0 = await t.state();
    const [px, py] = s0.pad;
    const from = at(t, px + 40, py + 30); const to = at(t, px + 380, py + 110);
    await input.drag(from, to);
    const s1 = await stateAfter(t, (n) => n.u === s0.u + 1);
    check('C. a drag is one press, movement while it is held, then one release', ok(s1) && s1.c === s0.c + 1 && s1.moves >= 3, s1 ? `presses ${s1.c - s0.c}, moves while held ${s1.moves}` : 'nothing arrived');
    check('C. ...it pressed where it started', ok(s1) && near(s1.last[0], px + 40) && near(s1.last[1], py + 30), s1 ? `window saw ${s1.last[0]},${s1.last[1]} for ${px + 40},${py + 30}` : '');
    check('C. ...and let go where it ended', ok(s1) && near(s1.lastUp[0], px + 380) && near(s1.lastUp[1], py + 110), s1 ? `window saw ${s1.lastUp[0]},${s1.lastUp[1]} for ${px + 380},${py + 110}` : '');
    check('C. ...with the left button both times', ok(s1) && s1.last[4] === 0 && s1.lastUp[2] === 0);
    await settle(400);
    // the way back with the right button (a drag must also work upwards and to the left)
    const a2 = await t.state();
    await input.drag(to, from, { button: 'right' });
    const s2 = await stateAfter(t, (n) => n.u === a2.u + 1);
    check('C. a right-button drag back up and to the left: pressed at its start, released at its end, right button', ok(s2) && s2.last[4] === 2 && s2.lastUp[2] === 2 && near(s2.last[0], px + 380) && near(s2.lastUp[0], px + 40) && near(s2.lastUp[1], py + 30),
      s2 ? `press ${s2.last[0]},${s2.last[1]} (button ${s2.last[4]}), release ${s2.lastUp[0]},${s2.lastUp[1]} (button ${s2.lastUp[2]})` : 'nothing arrived');
  }

  // ================================================================ D. scrolling
  const wheelOf = (a, b) => ({ n: b.wn - a.wn, x: b.ws[0] - a.ws[0], y: b.ws[1] - a.ws[1] });
  async function scrollSuite(t, label) {
    const c = await padCentre(t);
    await input.moveTo(c.x, c.y);
    await settle(500);
    const results = {};
    for (const [name, dx, dy] of [['down 3', 0, 3], ['up 2', 0, -2], ['right 2', 2, 0], ['left 4', -4, 0], ['down 1', 0, 1], ['down 10', 0, 10], ['down 25', 0, 25]]) {
      const a = await t.state();
      await input.scroll(dx, dy);
      await settle(700);
      const d = wheelOf(a, await t.state());
      results[name] = d;
      note(`${label}: scroll ${name}: ${d.n} wheel events, pixels moved x ${d.x}, y ${d.y}`);
    }
    return results;
  }
  if (on('D')) {
    const r = await scrollSuite(x11, 'X11 window');
    // One notch is worth the same everywhere, so every other amount must be that many times it (and none lost: the first step of an X11 window is the one that used to vanish).
    const one = r['down 1'].y;
    check('D. a single notch down moves the page down (positive)', one > 0, `y ${one}`);
    check('D. ...3 notches down move exactly 3 times as far', r['down 3'].y === 3 * one && r['down 3'].x === 0, `${r['down 3'].y} vs 3 x ${one}`);
    check('D. ...2 notches up move 2 times as far the other way', r['up 2'].y === -2 * one && r['up 2'].x === 0, `${r['up 2'].y} vs -2 x ${one}`);
    check('D. ...10 notches and 25 notches also lose nothing', r['down 10'].y === 10 * one && r['down 25'].y === 25 * one, `${r['down 10'].y}, ${r['down 25'].y} for ${10 * one}, ${25 * one}`);
    const oneX = r['right 2'].x / 2;
    check('D. right is positive, left negative, and none is lost', oneX > 0 && r['left 4'].x === -4 * oneX && r['right 2'].y === 0 && r['left 4'].y === 0, `right 2: ${r['right 2'].x}, left 4: ${r['left 4'].x}`);
    await closeTarget(x11); x11 = null;

    // the same in a native Wayland window (it behaves differently: it never lost the first step)
    const w = await openTarget({ id: '2', native: true });
    const cal = await calibrate(w);
    check('D. (native Wayland window) a first click lands', cal.landed);
    if (cal.landed) {
      const rw = await scrollSuite(w, 'native Wayland window');
      const oneW = rw['down 1'].y;
      check('D. (native Wayland) one notch down is positive; 3 down, 2 up, 10 and 25 down are exact multiples',
        oneW > 0 && rw['down 3'].y === 3 * oneW && rw['up 2'].y === -2 * oneW && rw['down 10'].y === 10 * oneW && rw['down 25'].y === 25 * oneW, `one ${oneW}: ${rw['down 3'].y}, ${rw['up 2'].y}, ${rw['down 10'].y}, ${rw['down 25'].y}`);
      const oneWX = rw['right 2'].x / 2;
      check('D. (native Wayland) right is positive, left negative, exact multiples', oneWX > 0 && rw['left 4'].x === -4 * oneWX, `right 2: ${rw['right 2'].x}, left 4: ${rw['left 4'].x}`);
    }
    await closeTarget(w);
    if (['E', 'F', 'G', 'H', 'I'].some(on)) { x11 = await openTarget({ id: '1', x: 100, y: 120 }); await calibrate(x11); }
  }

  // ================================================================ E. typing
  if (on('E')) {
    const t = x11;
    await clearBox(t);
    const phrases = [
      'hello world',
      'Hello, World! 123',
      'THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG',
      '!@#$%^&*()_+-={}[]|:;"\'<>,.?/~`\\',
      'user@example.com https://example.org/a?b=c&d=e#f',
    ];
    for (const p of phrases) {
      await clearBox(t);
      await input.type(p);
      const s = await stateAfter(t, (n) => n.text === p, 3000);
      const got = (await t.state()).text;
      check(`E. typed text arrives exactly: ${JSON.stringify(p.slice(0, 30))}`, ok(s), s ? '' : `the box holds ${JSON.stringify(got)}`);
    }
    // the first thing a brand-new session does is type (the person clicked, then the session closed after sitting idle): not one letter may be lost
    await clearBox(t);
    await backend.close();
    await settle(500);
    await input.type('first letters count');
    const cold = await stateAfter(t, (n) => n.text === 'first letters count', 3000);
    check('E. typing as the very first action of a new session loses nothing (the first key is the one GNOME swallows)', ok(cold), cold ? '' : `the box holds ${JSON.stringify((await t.state()).text)}`);
    // Enter and Tab
    await clearBox(t);
    await input.type('p\nq');
    const en = await stateAfter(t, (n) => n.text === 'pq' && n.keys.includes('Enter'), 3000);
    check('E. a new line in the text is the Enter key', ok(en), en ? '' : JSON.stringify(await t.state()));
    await clearBox(t);
    await input.type('x\ty');
    await settle(500);
    const tb = await t.state();
    // (a window with one box only: Tab goes round and lands on the same box with its text selected, so the next letter REPLACES it)
    check('E. a tab in the text is the Tab key (the window heard it between the two letters)', tb.keys.slice(-3).join(',') === 'x,Tab,y' && tb.text === 'y', `keys ${tb.keys.slice(-3).join(',')}, box ${JSON.stringify(tb.text)}`);
    // a long text, at the default speed (the window reports a checksum of what it holds, since a long text does not fit in its title)
    await clearBox(t);
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const t0 = Date.now();
    await input.type(long);
    const lg = await stateAfter(t, (n) => n.tl === long.length && n.th === textHash(long), 5000);
    const gotLong = await t.state();
    check('E. a 400-character text arrives whole', ok(lg), `took ${Date.now() - t0} ms; the box holds ${gotLong.tl} of ${long.length} characters`);
    note(`typing speed: ${Math.round((long.length * 1000) / (Date.now() - t0))} characters per second`);
  }

  // ---------------------------------------------------------------- keyboard layouts (the Shell's own setting, changed the way the person would)
  const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 10000 }, (err, stdout, stderr) => resolve({ err, out: String(stdout), errOut: String(stderr) })));
  const currentLayoutId = () => shell.eval('Main.panel.statusArea.keyboard._inputSourceManager.currentSource.xkbId');
  const setLayout = async (id) => {
    const r = await run('gsettings', ['set', 'org.gnome.desktop.input-sources', 'sources', `[('xkb', '${id}')]`]);
    if (r.err) return false;
    const seen = await waitFor(async () => (await currentLayoutId()) === id, { timeout: 6000, interval: 100 });
    await sleep(450);                               // the Shell has the layout now; the window learns of it a moment later
    return !!seen;
  };

  // ================================================================ F. every printable character, on many keyboard layouts
  if (on('F')) {
    await closeTarget(x11);
    x11 = await openTarget({ id: '1', x: 100, y: 120, view: 'keys' });             // a window that reports what every key press produced (its title is short enough for that)
    await calibrate(x11);
    const t = x11;
    const FALLBACK = ['us', 'us+intl', 'us+dvorak', 'us+colemak', 'us+altgr-intl', 'gb', 'de', 'de+nodeadkeys', 'fr', 'es', 'it', 'pt', 'se', 'no', 'dk', 'fi', 'pl', 'cz', 'hu', 'tr', 'ch', 'be', 'br', 'latam', 'ca', 'jp', 'in+eng', 'ru', 'ua', 'gr', 'il', 'in', 'ara', 'th', 'kr'];
    const asked = (process.env.ALLES_E2E_LAYOUTS || '').trim();
    const layouts = asked === 'all' ? [...new Set([...Object.keys(LAYOUT_DATA.MISSING), ...LAYOUT_DATA.COMPLETE])].sort()
      : asked ? asked.split(',').map((x) => x.trim()).filter(Boolean) : FALLBACK;
    note(`F. trying ${layouts.length} keyboard layouts`);
    const dump = process.env.ALLES_E2E_DUMP || '';
    const fast = process.env.ALLES_E2E_FAST === '1';
    /**
     * Press every printable character by keysym, ONE AT A TIME, and read what each press produced (KeyboardEvent.key): the window
     * counts the keys it hears, so a character that types nothing shows up as "no new key". An Escape follows each press so that a
     * dead accent key cannot combine with the next character (the window does not count Escapes: after a dead key the desktop
     * swallows the Escape that cancels it, so Escapes could not be used to tell the presses apart - measured on us+intl and br).
     */
    const pressAll = async (tt) => {
      const parts = []; let heard = 0; let complete = true;
      let prev = await tt.state();
      for (const ch of ALL_ASCII) {
        if (!prev) return { made: heard, parts, complete: false };
        await backend._exclusive(async () => { await backend._typeKeys(ch, 6); });
        let now = null;
        for (let k = 0; k < 8; k++) { await sleep(k ? 30 : 15); now = await tt.state(); if (now && now.kn > prev.kn) break; }
        if (!now) return { made: heard, parts, complete: false };
        const n = now.kn - prev.kn;                                                 // keys the window heard for this character: 1, or 0 when it typed nothing
        heard += n;
        if (n > 1 || n > now.kl.length) complete = false;
        parts.push(n ? now.kl.slice(-n) : '');
        await backend._exclusive(async () => { await backend._tapCode(1, 6); });
        prev = now;
      }
      return { made: heard, parts, complete };
    };
    for (const id of layouts) {
      if (!(await setLayout(id))) { check(`F. ${id}: GNOME switched to the layout`, false, `the Shell says ${await currentLayoutId()}`); continue; }
      const layout = await readLayout();
      if (layout.id !== id) { check(`F. ${id}: ALLES reads the layout the Shell is using`, false, `ALLES read ${layout.id}`); continue; }
      const pasted = [...ALL_ASCII].filter((c) => !canType(layout, c)).join('');
      let res = null; let tries = 0;
      for (; tries < 2; tries++) {
        await clearBox(t);
        res = await pressAll(t);                                                    // the keyboard alone, no clipboard help: what the table claims
        const bad = [...ALL_ASCII].filter((c, i) => canType(layout, c) && res.parts[i] !== c);
        if (res.complete && !bad.length) break;
        await sleep(1200);                                                          // the window may only just have learned the new layout: look once more
      }
      const fine = [...ALL_ASCII].filter((c, i) => res.parts[i] === c);
      const wrong = [...ALL_ASCII].map((c, i) => [c, res.parts[i]]).filter(([c, got]) => canType(layout, c) && got !== c);
      const cautious = [...ALL_ASCII].filter((c, i) => !canType(layout, c) && res.parts[i] === c).join('');
      const shown = (v) => (v === undefined ? '?' : v === '' ? 'nothing' : v === '\t' ? 'a named key (a dead accent key, most likely)' : JSON.stringify(v));
      if (dump) { try { fs.appendFileSync(dump, JSON.stringify({ id, typed: res.parts.map((p, i) => (p === ALL_ASCII[i] ? '=' : p)), complete: res.complete }) + '\n'); } catch { /* best effort */ } }
      check(`F. ${id}: the window could be read after every one of the ${ALL_ASCII.length} key presses, and no press made more than one key`, res.complete, `${res.made} keys heard for ${res.parts.length} characters`);
      check(`F. ${id}: every character the table says the keyboard types really comes out as itself (${ALL_ASCII.length - pasted.length} of ${ALL_ASCII.length})`, !wrong.length,
        wrong.length ? `WRONG: ${wrong.map(([c, got]) => `${JSON.stringify(c)} gave ${shown(got)}`).join(', ')}` : (tries ? 'after a second look' : ''));
      if (cautious) note(`F. ${id}: the table is cautious about ${JSON.stringify(cautious)}: the keyboard did type them (they get pasted instead, which is slower but right)`);
      if (fast) continue;
      // the real thing: ALLES typing all 95 characters, pasting the ones the keyboard cannot make
      await clearBox(t);
      await input.type(ALL_ASCII);
      const full = await stateAfter(t, (n) => n.tl === ALL_ASCII.length && n.th === textHash(ALL_ASCII), 5000);
      check(`F. ${id}: ALLES enters all 95 printable characters exactly (${pasted.length} of them pasted)`, ok(full), full ? '' : `the box holds ${(await t.state()).tl} characters, not the ${ALL_ASCII.length} that were sent`);
    }
    await closeTarget(x11);
    x11 = null;
    if (['G', 'H', 'I'].some(on)) { x11 = await openTarget({ id: '1', x: 100, y: 120 }); await calibrate(x11); }
    await setLayout('us');
  }

  // ================================================================ G. shortcuts
  if (on('G')) {
    const t = x11;
    await setLayout('us');
    await clearBox(t);
    const wanted1 = [
      ['ctrl+a', 'C-a'], ['ctrl+shift+a', 'C-A'], ['ctrl+shift+left', 'C-S-ArrowLeft'], ['shift+tab', 'S-Tab'], ['alt+left', 'A-ArrowLeft'],
      ['escape', 'Escape'], ['f2', 'F2'], ['home', 'Home'], ['end', 'End'], ['pageup', 'PageUp'], ['pagedown', 'PageDown'], ['delete', 'Delete'], ['backspace', 'Backspace'],
      ['ctrl+alt+x', 'C-A-x'], ['shift+f10', 'S-F10'], ['enter', 'Enter'], ['ctrl+1', 'C-1'], ['ctrl+slash', 'C-/'], ['ctrl+shift+equal', 'C-+'],
    ];
    for (const [combo, key] of wanted1) {
      const a = await t.state();
      await input.pressCombo(combo);
      const b = await stateAfter(t, (n) => n.keys.join('|') !== a.keys.join('|') && n.keys[n.keys.length - 1] === key, 3000);
      check(`G. ${combo} reaches the window as ${key}`, ok(b), b ? '' : `the window heard ${JSON.stringify((await t.state()).keys.slice(-3))}`);
      await clearBox(t);
    }
    // what a shortcut DOES, on layouts where the letters are not where a US keyboard has them
    for (const id of ['us', 'de', 'fr', 'us+dvorak', 'us+colemak', 'ru']) {
      if (!(await setLayout(id))) { check(`G. ${id}: GNOME switched to the layout`, false); continue; }
      await clearBox(t);
      await input.type('abc');
      await stateAfter(t, (n) => n.text === 'abc');
      await input.pressCombo('ctrl+a'); await input.pressCombo('ctrl+c'); await input.pressCombo('end'); await input.pressCombo('ctrl+v');
      const done = await stateAfter(t, (n) => n.text === 'abcabc', 3000);
      check(`G. ${id}: Ctrl+A, Ctrl+C, End, Ctrl+V select all, copy, go to the end and paste ("abc" becomes "abcabc")`, ok(done), done ? '' : `the box holds ${JSON.stringify((await t.state()).text)}, keys ${JSON.stringify((await t.state()).keys.slice(-5))}`);
    }
    await setLayout('us');
  }

  // ================================================================ H. pasting what the keyboard cannot type, and the clipboard afterwards
  if (on('H')) {
    const t = x11;
    await setLayout('us');
    const E = { rupee: '₹', eacute: 'é', iuml: 'ï', ntilde: 'ñ', grin: '\u{1F600}', cjk: '日本語' };
    // 1. the clipboard is given back
    await clearBox(t);
    clipboard.writeText('KEEP ME');
    const w0 = clip.writes;
    const text1 = `price ${E.rupee}500, caf${E.eacute}, na${E.iuml}ve ${E.ntilde}`;
    const r1 = await input.type(text1);
    const s1 = await stateAfter(t, (n) => n.text === text1, 3000);
    check('H. text with a rupee sign and accents arrives exactly', ok(s1), s1 ? '' : `the box holds ${JSON.stringify((await t.state()).text)}`);
    check('H. ...the clipboard was used, and the person gets their clipboard back afterwards', clip.writes > w0 && clipboard.readText() === 'KEEP ME', `clipboard now ${JSON.stringify(clipboard.readText())}`);
    check('H. ...and the answer to the agent says how many characters were pasted', r1.notes.some((x) => /pasted with Ctrl\+V/.test(x)), JSON.stringify(r1.notes));
    // 2. an emoji and Chinese/Japanese text, and the order of several pasted pieces among typed letters
    await clearBox(t);
    const text2 = `go ${E.grin} now ${E.cjk} ok ${E.rupee}a${E.eacute}b${E.iuml}c`;
    await input.type(text2);
    const s2 = await stateAfter(t, (n) => n.text === text2, 3000);
    check('H. an emoji, Japanese text and several pasted pieces between typed letters keep their order', ok(s2), s2 ? '' : `the box holds ${JSON.stringify((await t.state()).text)}`);
    // 3. a new line between pasted pieces
    await clearBox(t);
    await input.type(`${E.eacute}\n${E.ntilde}`);
    const s3 = await stateAfter(t, (n) => n.text === `${E.eacute}${E.ntilde}` && n.keys.includes('Enter'), 3000);
    check('H. a new line between two pasted characters is an Enter key press', ok(s3), s3 ? '' : JSON.stringify((await t.state()).keys));
    // 4. an empty clipboard stays empty
    await clearBox(t);
    clipboard.clear();
    await input.type(E.rupee);
    await stateAfter(t, (n) => n.text === E.rupee, 3000);
    await settle(700);
    check('H. a clipboard that was empty is empty again afterwards (nothing of ours is left in it)', clipboard.readText() === '', `clipboard now ${JSON.stringify(clipboard.readText())}`);
    // 5. a picture on the clipboard cannot be given back: the agent must be told
    await clearBox(t);
    clipboard.writeImage(nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='));
    const r5 = await input.type(E.eacute);
    await stateAfter(t, (n) => n.text === E.eacute, 3000);
    check('H. when the clipboard held a picture, the answer to the agent says it is gone now', r5.notes.some((x) => /something other than text/.test(x)), JSON.stringify(r5.notes));
    // 6. a terminal pastes with Ctrl+Shift+V
    await clearBox(t);
    const r6 = await input.type(E.rupee, { terminal: true });
    const s6 = await stateAfter(t, (n) => n.text === E.rupee && n.keys[n.keys.length - 1] === 'C-V', 3000);
    check('H. for a terminal the paste is Ctrl+Shift+V', ok(s6), s6 ? '' : `the box holds ${JSON.stringify((await t.state()).text)}, keys ${JSON.stringify((await t.state()).keys.slice(-3))}; notes ${JSON.stringify(r6.notes)}`);
    // 7. a long text full of such characters
    await clearBox(t);
    const long = Array.from({ length: 40 }, (_, i) => `n${i}${E.rupee}${i * 3}${E.eacute}`).join(' ');
    const t0 = Date.now();
    await input.type(long);
    const s7 = await stateAfter(t, (n) => n.tl === [...long].length && n.th === textHash(long), 8000);
    check('H. a long text with many rupee signs and accents arrives whole', ok(s7), `took ${Date.now() - t0} ms for ${[...long].length} characters`);
    // 8. a layout without Latin letters: everything is pasted, and still arrives
    if (await setLayout('ru')) {
      await clearBox(t);
      const r8 = await input.type('Hello, World 42');
      const s8 = await stateAfter(t, (n) => n.text === 'Hello, World 42', 3000);
      check('H. on a Russian keyboard (no Latin letters) all of it is pasted and still arrives', ok(s8), s8 ? '' : `the box holds ${JSON.stringify((await t.state()).text)}`);
      check('H. ...and the agent is told why', r8.notes.some((x) => /cannot type Latin letters/.test(x)), JSON.stringify(r8.notes));
    } else check('H. GNOME switched to the Russian layout', false);
    await setLayout('us');
  }

  // ================================================================ I. closing by itself, and the person's Stop button
  if (on('I')) {
    const t = x11;
    await setLayout('us');
    const sessions = async () => { const r = await run('busctl', ['--user', 'tree', 'org.gnome.Mutter.RemoteDesktop', '--list']); return r.out.split('\n').filter((l) => /RemoteDesktop\/Session\/u\d+/.test(l)).length; };
    const shared = async () => Number(await shell.eval('Main.panel.statusArea.screenSharing._handles.size'));
    await fresh({ idleMs: 1500 });
    await settle(500);
    check('I. before anything is sent there is no session and nothing is being shared', (await sessions()) === 0 && (await shared()) === 0, `sessions ${await sessions()}, shared ${await shared()}`);
    const c = await padCentre(t);
    await input.moveTo(c.x, c.y);
    check('I. the first action opens ONE session, and GNOME shows its sharing indicator', (await sessions()) === 1 && (await shared()) > 0, `sessions ${await sessions()}, shared ${await shared()}`);
    await settle(3200);
    check('I. after sitting idle the session closes by itself, so the person is not left "sharing their screen"', (await sessions()) === 0 && (await shared()) === 0, `sessions ${await sessions()}, shared ${await shared()}`);
    const s0 = await t.state();
    await input.click('left');
    const s1 = await stateAfter(t, (n) => n.u === s0.u + 1);
    check('I. the next action just opens a new session and works', ok(s1) && (await sessions()) === 1, `sessions ${await sessions()}`);
    await input.close();
    await settle(900);
    check('I. closing it from ALLES (the task is over) closes the session at once', (await sessions()) === 0 && (await shared()) === 0, `sessions ${await sessions()}, shared ${await shared()}`);
    await fresh({ idleMs: 60000 });

    // the person presses the Stop button of the sharing indicator
    const stops0 = stopsByPerson;
    await input.moveTo(c.x + 4, c.y + 4);
    await shell.eval('Main.panel.statusArea.screenSharing._stopSharing()');
    await waitFor(() => stopsByPerson > stops0, { timeout: 4000, interval: 50 });
    check('I. when the person presses Stop on the sharing indicator, ALLES is told (exactly once)', stopsByPerson === stops0 + 1, `told ${stopsByPerson - stops0} times`);
    await settle(400);
    let refused = null; const a2 = await t.state();
    try { await input.click('left'); } catch (e) { refused = e; }
    await settle(400);
    const b2 = await t.state();
    check('I. ...after that nothing more is sent: the next action is refused with a clear reason, and no new session opens', !!refused && refused.userStopped === true && b2.c === a2.c && (await sessions()) === 0, refused ? refused.message.slice(0, 80) : 'it was NOT refused');
    input.resume();
    const s2a = await t.state();
    await input.click('left');
    const s2 = await stateAfter(t, (n) => n.u === s2a.u + 1);
    check('I. a new task (resume) allows input again', ok(s2));

    // pressing Stop in the middle of a drag must not leave the mouse button held down
    const s3a = await t.state();
    const [px, py] = s3a.pad;
    const dragging = input.drag(at(t, px + 20, py + 20), { x: 1300, y: 700 }).catch((e) => e);        // a long one (about a second), so that it is still going when Stop is pressed
    await sleep(500);
    await shell.eval('Main.panel.statusArea.screenSharing._stopSharing()');
    const dragResult = await dragging;
    await settle(600);
    const s3 = await t.state();
    check('I. Stop pressed in the middle of a drag ends the drag with a clear error', dragResult instanceof Error, dragResult instanceof Error ? dragResult.message.slice(0, 80) : 'the drag reported success');
    check('I. ...and the mouse button is not left held down (every press has its release)', s3.u === s3.c, `presses ${s3.c}, releases ${s3.u}`);
    input.resume();

    // ...nor a key: Ctrl held when the session ends must not stay down
    await focusBox(t); await clearBox(t);
    await backend._exclusive(() => backend._call('keycode', 29, true));              // Ctrl goes down and nothing lets go of it
    await shell.eval('Main.panel.statusArea.screenSharing._stopSharing()');
    await settle(800);
    input.resume();
    await input.type('k');
    const s4 = await stateAfter(t, (n) => n.text === 'k', 3000);
    check('I. a key held down when the session ends is let go (the next letter is a plain letter, not Ctrl+letter)', ok(s4) && s4.keys[s4.keys.length - 1] === 'k', s4 ? `keys ${JSON.stringify(s4.keys.slice(-3))}` : `the box holds ${JSON.stringify((await t.state()).text)}, keys ${JSON.stringify((await t.state()).keys.slice(-3))}`);
  }

  // ================================================================ J. the picture the model gets and the pointer agree: any scale, any number of screens
  if (on('J')) {
    if (x11) { await closeTarget(x11); x11 = null; }
    const desk = await backend.transport.desktop();
    const mons = desk ? desk.monitors : [];
    note(`J. ALLES reads the desktop as ${mons.map((m) => `${m.w}x${m.h} at ${m.x},${m.y} (scale ${Math.round(m.scale * 1000) / 1000})`).join(' + ') || 'nothing'}; pixels of its picture are ${Math.round(desk ? desk.scale * 1000 : 0) / 1000} per logical pixel`);
    check('J. ALLES reads every screen', mons.length >= 1 && (!SCALES.length || mons.length === SCALES.length), `${mons.length} screens read`);
    const wins = [];
    for (let i = 0; i < mons.length; i++) wins.push(await openTarget({ id: String(i + 1), x: mons[i].x + 100, y: mons[i].y + 120 }));
    await sleep(800);
    for (const w of wins) { const st = await w.state(); w.at = st ? st.frame : null; }
    check('J. every window opened on its own screen', wins.every((w, i) => w.at && w.at.x >= mons[i].x && w.at.x < mons[i].x + mons[i].w), wins.map((w) => (w.at ? `${w.at.x},${w.at.y}` : '?')).join(' | '));
    // the real screenshot tool, and the picture ALLES hands to the model
    const cap = new ScreenCapture({ resizer: (png, w, h) => nativeImage.createFromBuffer(png).resize({ width: w, height: h, quality: 'best' }).toPNG() });
    let shot = null;
    try { shot = await cap.capture(); } catch (e) { check('J. the screenshot tool works here', false, e.message); }
    if (shot && desk) {
      const want = [Math.round(desk.width * desk.scale), Math.round(desk.height * desk.scale)];
      check('J. the picture covers the whole desktop at the largest scale', Math.abs(shot.width - want[0]) <= 1 && Math.abs(shot.height - want[1]) <= 1, `the picture is ${shot.width}x${shot.height}, the desktop ${want[0]}x${want[1]} in its pixels`);
      const img = nativeImage.createFromBuffer(shot.original);
      const bmp = img.toBitmap();                                                    // blue, green, red, alpha for every pixel
      const W = img.getSize().width;
      // the window's grey-blue pad (#335566) is the only thing of that colour: where is it in the picture?
      const find = (r) => {
        let x0 = 1e9; let y0 = 1e9; let x1 = -1; let y1 = -1; let n = 0;
        for (let y = Math.max(0, r.y); y < r.y + r.h; y++) for (let x = Math.max(0, r.x); x < r.x + r.w; x++) {
          const o = (y * W + x) * 4;
          if (Math.abs(bmp[o] - 0x66) <= 3 && Math.abs(bmp[o + 1] - 0x55) <= 3 && Math.abs(bmp[o + 2] - 0x33) <= 3) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        }
        return n ? { x0, y0, x1, y1, n, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null;
      };
      const centres = [];
      for (let i = 0; i < wins.length; i++) {
        const t = wins[i]; const m = mons[i];
        const box = find({ x: Math.round((m.x - desk.x) * desk.scale), y: Math.round((m.y - desk.y) * desk.scale), w: Math.round(m.w * desk.scale), h: Math.round(m.h * desk.scale) });
        check(`J. screen ${i + 1}: the window's pad can be found in the picture`, !!box);
        if (!box) { centres.push(null); continue; }
        const s0 = await t.state();
        const expectX = s0.pad[0] + s0.pad[2] / 2; const expectY = s0.pad[1] + s0.pad[3] / 2;
        note(`J. screen ${i + 1}: the pad is ${box.w}x${box.h} pixels in the picture (${s0.pad[2]}x${s0.pad[3]} in its page), its middle at ${box.cx},${box.cy}`);
        await input.moveTo(Math.round(box.cx), Math.round(box.cy));
        await input.click('left');
        const hit = await stateAfter(t, (n) => n.c === s0.c + 1 && n.u === s0.u + 1, 5000);
        check(`J. screen ${i + 1}: a click on the middle of the pad, aimed in the picture, lands on the middle of the pad`, ok(hit) && Math.abs(hit.last[0] - expectX) <= 2 && Math.abs(hit.last[1] - expectY) <= 2,
          hit ? `aimed at page ${expectX},${expectY}; the window saw ${hit.last[0]},${hit.last[1]}` : 'nothing arrived');
        centres.push({ box, hit });
        await settle(300);
      }
      // dragging from one screen to the next: the window that took the press keeps the pointer, so it hears where the pointer really went
      if (wins.length >= 2 && centres[0] && centres[1] && centres[0].hit) {
        const a = centres[0].box; const b = centres[1].box;
        const first = await wins[0].state();
        await input.drag({ x: Math.round(a.cx), y: Math.round(a.cy) }, { x: Math.round(b.cx), y: Math.round(b.cy) });
        const up = await stateAfter(wins[0], (n) => n.u === first.u + 1, 5000);
        const exX = centres[0].hit.last[0] + (b.cx - a.cx) / desk.scale; const exY = centres[0].hit.last[1] + (b.cy - a.cy) / desk.scale;
        check('J. a drag from the first screen to the second ends where it was sent (the window that took the press says where the button came up)', ok(up) && up.lastUp && Math.abs(up.lastUp[0] - exX) <= 2 && Math.abs(up.lastUp[1] - exY) <= 2,
          up && up.lastUp ? `expected page ${Math.round(exX)},${Math.round(exY)}; it came up at ${up.lastUp[0]},${up.lastUp[1]}` : 'nothing arrived');
      }
    }
    for (const w of wins) await closeTarget(w);
  }

  // ================================================================ end
  for (const t of [...targets]) await closeTarget(t);
  await backend.dispose();
  shell.close();
  return summary();
}

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.error('E2E watchdog: took too long'); app.exit(3); }, Number(process.env.ALLES_E2E_MINUTES || 20) * 60_000);
  let good = false;
  try { good = await main(); } catch (e) { console.error('E2E crashed:', e && e.stack ? e.stack : e); }
  clearTimeout(watchdog);
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  app.exit(good ? 0 : 1);
});
