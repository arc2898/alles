'use strict';
/**
 * Helpers for the real-desktop tests: ask the throw-away GNOME Shell where windows really are, move a real (virtual)
 * mouse pointer through the compositor, wait for things to happen, and record pass/fail lines.
 * Nothing here knows about ALLES; the scenario files do.
 */
const dbus = require('dbus-next');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- results

function makeChecks() {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
    return !!ok;
  };
  const note = (text) => console.log(`NOTE  ${text}`);
  const summary = () => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    for (const f of failed) console.log(`  FAILED: ${f.name}`);
    return failed.length === 0;
  };
  return { check, note, summary, results };
}

async function waitFor(fn, { timeout = 10000, interval = 100, what = 'something' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(interval);
  }
  return null;
}

// ---------------------------------------------------------------- the Shell, as the Shell sees things

const WINDOWS_JS = `JSON.stringify(global.get_window_actors().map((a) => { const w = a.meta_window; const r = w.get_frame_rect();
  return { title: w.get_title(), cls: w.get_wm_class(), x: r.x, y: r.y, w: r.width, h: r.height, kind: w.get_window_type(), above: w.is_above(), shown: a.visible,
    client: w.get_client_type() === Meta.WindowClientType.X11 ? 'x11' : 'wayland' }; }))`;

async function connectShell() {
  const bus = dbus.sessionBus();
  bus.on('error', () => { /* a closed bus at the very end is fine */ });
  const obj = await bus.getProxyObject('org.alles.Probe', '/org/alles/Probe');
  const iface = obj.getInterface('org.alles.Probe');
  const shell = {
    eval: (code) => iface.Eval(code),
    async json(code) { const s = await iface.Eval(code); try { return JSON.parse(s); } catch { throw new Error(`the Shell answered: ${s}`); } },
    windows: async () => shell.json(WINDOWS_JS),
    /** Windows whose title matches exactly (the Shell's own view of where they are). */
    async windowsTitled(title) { return (await shell.windows()).filter((w) => w.title === title); },
    /** A picture of the whole screen as the compositor composes it, saved as a PNG. */
    async screenshot(file) {
      const code = `(() => { const f = Gio.File.new_for_path(${JSON.stringify(file)}); const s = f.replace(null, false, Gio.FileCreateFlags.NONE, null);
        const shot = new Shell.Screenshot(); shot.screenshot(false, s, (o, res) => { try { shot.screenshot_finish(res); } catch (e) { log('probe screenshot failed: ' + e); } s.close(null); }); return 'started'; })()`;
      const r = await iface.Eval(code);
      if (r !== 'started') throw new Error(`screenshot: ${r}`);
      const fs = require('node:fs');
      await waitFor(() => fs.existsSync(file) && fs.statSync(file).size > 1000, { timeout: 8000, interval: 150 });
      await sleep(250);
      return file;
    },
    close() { try { bus.disconnect(); } catch { /* already closed */ } },
  };
  return shell;
}

// ---------------------------------------------------------------- a real pointer

const BTN_LEFT = 0x110;       // Linux evdev code for the left mouse button

/**
 * A virtual mouse made through GNOME's remote-desktop service: the compositor treats it like a real one, so what a
 * window sees is what it would see from a person's hand. Only RELATIVE motion exists, so the pointer is first
 * parked in the bottom-right corner (where we know where it is) and tracked from there.
 */
async function connectPointer(width, height) {
  const bus = dbus.sessionBus();
  bus.on('error', () => {});
  const root = await bus.getProxyObject('org.gnome.Mutter.RemoteDesktop', '/org/gnome/Mutter/RemoteDesktop');
  const sessionPath = await root.getInterface('org.gnome.Mutter.RemoteDesktop').CreateSession();
  const sess = await bus.getProxyObject('org.gnome.Mutter.RemoteDesktop', sessionPath);
  const si = sess.getInterface('org.gnome.Mutter.RemoteDesktop.Session');
  await si.Start();
  let at = { x: 0, y: 0 };
  let primed = false;
  const tap = async (code) => { await si.NotifyKeyboardKeycode(code, true); await sleep(40); await si.NotifyKeyboardKeycode(code, false); };
  const p = {
    get at() { return { ...at }; },
    /** Corner of the screen where nothing lives: GNOME's hot corner is the TOP-left, which opens the Overview. */
    async park() { await si.NotifyPointerMotionRelative(width * 3, height * 3); at = { x: width - 1, y: height - 1 }; await sleep(60); },
    /** Straight to a point in one jump (a flick). */
    async jump(x, y) {
      const tx = Math.min(Math.max(Math.round(x), 0), width - 1); const ty = Math.min(Math.max(Math.round(y), 0), height - 1);
      if (tx !== at.x || ty !== at.y) await si.NotifyPointerMotionRelative(tx - at.x, ty - at.y);
      at = { x: tx, y: ty };
    },
    /** Along a straight line in `steps` small moves, `ms` apart (a hand moving at a steady pace). */
    async glide(x, y, { steps = 12, ms = 12 } = {}) {
      const from = { ...at };
      for (let i = 1; i <= steps; i++) { await p.jump(from.x + (x - from.x) * i / steps, from.y + (y - from.y) * i / steps); await sleep(ms); }
    },
    /** Push past the edge of the screen: the pointer stops AT the edge (the wall a real hand pushes against). */
    async slam(dx, dy) { await si.NotifyPointerMotionRelative(dx, dy); at = { x: Math.min(Math.max(at.x + dx, 0), width - 1), y: Math.min(Math.max(at.y + dy, 0), height - 1) }; },
    async down() { await si.NotifyPointerButton(BTN_LEFT, true); },
    async up() { await si.NotifyPointerButton(BTN_LEFT, false); },
    async click() { await p.down(); await sleep(40); await p.up(); },
    /**
     * Press and release one key, by its Linux evdev code (Esc is 1).
     * The very first key pressed through a new virtual keyboard is swallowed by the desktop (measured: the app never hears
     * it, however long the window has had the focus; every later key arrives). So the first call taps Shift - which does
     * nothing in any text box - and waits, so that the key the test really means is the one that gets through.
     */
    async key(code) {
      if (!primed) { primed = true; await tap(42); await sleep(250); }
      await tap(code);
    },
    async stop() { try { await si.Stop(); } catch { /* already gone */ } try { bus.disconnect(); } catch { /* ignore */ } },
  };
  await p.park();
  return p;
}

module.exports = { sleep, waitFor, makeChecks, connectShell, connectPointer };
