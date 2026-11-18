'use strict';
/**
 * The little windows that report what reaches them (target-window.js): started as real windows on the throw-away desktop and read back
 * through the Shell, which shows each window's title. Tests only; runs under Electron (the windows are Electron apps too).
 *
 *   const targets = makeTargets({ shell, note, root });
 *   const t = await targets.openTarget({ id: '1', x: 100, y: 120 });     // t.state() -> what the window has seen + its frame on the desktop
 *   await targets.closeAll();
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { sleep, waitFor } = require('./lib');

// GNOME puts invisible left-to-right / right-to-left marks around a title that has Hebrew or Arabic letters in it: not part of what the window said.
const BIDI_ENDS = /^[‎‏‪-‮⁦-⁩]+|[‎‏‪-‮⁦-⁩]+$/g;

function makeTargets({ shell, note = () => {}, root, flags = ['--no-sandbox', '--disable-gpu'] }) {
  const targets = [];
  const tmp = [];

  function launch(script, env = {}, args = []) {
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'alles-target-cfg-')); tmp.push(cfg);
    const child = spawn(process.execPath, [script, ...flags, ...args], { cwd: root, env: { ...process.env, XDG_CONFIG_HOME: cfg, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = [];
    const eat = (b) => { for (const l of String(b).split('\n')) if (l.trim()) lines.push(l); };
    child.stdout.on('data', eat); child.stderr.on('data', eat);
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    return { child, lines, exited, async stop() { try { child.kill('SIGTERM'); } catch { /* gone */ } await Promise.race([exited, sleep(3000)]); try { child.kill('SIGKILL'); } catch { /* gone */ } } };
  }

  /** What window `id` says it has seen (its title is JSON), plus its frame in logical pixels; null when it is not there or cannot be read. */
  async function wanted(id) {
    const all = (await shell.windows()).map((x) => (typeof x.title === 'string' ? { ...x, title: x.title.replace(BIDI_ENDS, '') } : x));
    const w = all.find((x) => typeof x.title === 'string' && x.title.startsWith(`T${id} `));
    const tgt = targets.find((x) => x.id === id);
    if (!w) {
      if (tgt && tgt.seen && !tgt.missingSaid) {
        tgt.missingSaid = true;
        note(`window ${id} is gone from the desktop. Its process: ${tgt.proc.child.exitCode === null && tgt.proc.child.signalCode === null ? 'still running' : `ended (code ${tgt.proc.child.exitCode}, signal ${tgt.proc.child.signalCode})`}; its log: ${tgt.proc.lines.slice(-6).join(' | ') || '(nothing)'}`);
      }
      return null;
    }
    if (tgt) { tgt.seen = true; tgt.missingSaid = false; }
    let st;
    try { st = JSON.parse(w.title.slice(`T${id} `.length)); } catch (e) {
      if (!wanted.complained) { wanted.complained = true; note(`the title of window ${id} could not be read (${e.message}); ${w.title.length} characters`); }
      return null;
    }
    return { ...st, frame: { x: w.x, y: w.y, w: w.w, h: w.h }, client: w.client };
  }

  /** Open a window that reports what it receives. `native` = a native Wayland window instead of X11 (through XWayland). `view`: see target-window.js. */
  async function openTarget({ id = '1', x = 100, y = 120, native = false, view = '' } = {}) {
    const proc = launch(path.join(__dirname, 'target-window.js'), { TARGET_ID: id, TARGET_X: String(x), TARGET_Y: String(y), TARGET_VIEW: view }, native ? ['--ozone-platform=wayland'] : ['--ozone-platform=x11']);
    const t = { id, proc, native, origin: null, state: () => wanted(id) };
    targets.push(t);
    const first = await waitFor(async () => { const s = await wanted(id); return s && s.box ? s : null; }, { timeout: 60000, interval: 200 });
    if (!first) throw new Error(`the target window ${id} never appeared. Its log: ${proc.lines.slice(-6).join(' | ')}`);
    await sleep(600);
    return t;
  }

  async function closeTarget(t) {
    await t.proc.stop();
    const i = targets.indexOf(t); if (i >= 0) targets.splice(i, 1);
    await sleep(400);
  }

  async function closeAll() {
    for (const t of [...targets]) await closeTarget(t);
    for (const d of tmp.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  }

  return { targets, wanted, openTarget, closeTarget, closeAll };
}

module.exports = { makeTargets };
