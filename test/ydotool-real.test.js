'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { InputController, SafetyGate } = require('../src/main/computer/input');
const { codes } = require('../src/main/computer/keymap');
const { tmpDir } = require('./helpers/tmp');

/**
 * Tests against the REAL ydotool 1.x client binary (not a mock), talking to a stand-in daemon
 * that decodes the events the client sends. No /dev/uinput or root is needed.
 *
 *   YDOTOOL_BIN=$(command -v ydotool) npm test
 *
 * SKIPPED unless YDOTOOL_BIN is set. Run it against YOUR installed ydotool: distro builds can
 * differ from the upstream source these were written against (commit 708e96f), and these are
 * exactly the behaviours (escape handling, environment leak, non-ASCII) that mattered.
 */
const BIN = process.env.YDOTOOL_BIN;
const skip = !BIN ? 'set YDOTOOL_BIN=/path/to/ydotool (a 1.x client) to run these against the real binary'
  : spawnSync('python3', ['--version']).status !== 0 ? 'python3 is needed for the stand-in daemon' : false;

const NAME = Object.fromEntries(Object.entries(codes).map(([k, v]) => [v, k]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('REAL ydotool client', { skip }, () => {
  let dir, log, daemon, ctl;

  before(async () => {
    dir = tmpDir('alles-ydo-');
    const sock = path.join(dir, 'sock'); log = path.join(dir, 'events.log');
    fs.writeFileSync(log, '');
    daemon = spawn('python3', [path.join(__dirname, 'fixtures/fake-ydotoold.py'), sock, log], { stdio: 'ignore' });
    for (let i = 0; i < 120 && !/READY/.test(fs.readFileSync(log, 'utf8')); i++) await sleep(25);   // wait for the daemon ITSELF, not just a socket file
    assert.match(fs.readFileSync(log, 'utf8'), /READY/, 'stand-in daemon did not start');
    ctl = new InputController({ bin: BIN, socket: sock, gate: new SafetyGate({ maxActionsPerMinute: 100000 }) });
  });
  after(() => { if (daemon) daemon.kill('SIGTERM'); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  const events = () => fs.readFileSync(log, 'utf8').replace(/\0/g, '').split('\n')
    .filter((l) => /^\d+ \d+ -?\d+$/.test(l)).map((l) => l.split(' ').map(Number)).filter(([t]) => t !== 0);   // drop SYN
  async function settle() { let last = -1; for (let i = 0; i < 60; i++) { const n = fs.statSync(log).size; if (n === last) return; last = n; await sleep(70); } }
  async function capture(fn) { fs.writeFileSync(log, ''); await sleep(20); let err = null; try { await fn(); } catch (e) { err = e; } await settle(); return { ev: events(), err }; }
  const downs = (ev) => ev.filter(([t, , v]) => t === 1 && v === 1).map(([, c]) => NAME[c] || c);
  const noShift = (ev) => downs(ev).filter((k) => k !== 'leftshift');

  it('plain text is typed key for key, with shift for capitals and symbols', async () => {
    const { ev } = await capture(() => ctl.type('Hello, World!'));
    assert.deepStrictEqual(noShift(ev), ['h', 'e', 'l', 'l', 'o', 'comma', 'space', 'w', 'o', 'r', 'l', 'd', '1']);
    assert.strictEqual(downs(ev).filter((k) => k === 'leftshift').length, 3, 'H, W and ! need shift');
  });

  it('a backslash is typed as a backslash: "\\n" is NOT turned into Enter', async () => {
    const { ev } = await capture(() => ctl.type('a\\nb'));
    assert.deepStrictEqual(noShift(ev), ['a', 'backslash', 'n', 'b']);
  });

  it('a Windows path types literally, with no stray Enter or dropped characters', async () => {
    const { ev } = await capture(() => ctl.type('C:\\Users\\new'));
    assert.deepStrictEqual(noShift(ev), ['c', 'semicolon', 'backslash', 'u', 's', 'e', 'r', 's', 'backslash', 'n', 'e', 'w']);
    assert.ok(!downs(ev).includes('enter'));
  });

  it('SECURITY: text ending in a backslash types NOTHING extra, even with a canary secret in our environment', async () => {
    process.env.ALLES_CANARY = 'hunter2secret';        // would appear first-ish in an inherited environment
    try {
      const { ev } = await capture(() => ctl.type('abc\\'));
      assert.deepStrictEqual(noShift(ev), ['a', 'b', 'c', 'backslash'], 'the client typed characters we never sent (environment leak)');
    } finally { delete process.env.ALLES_CANARY; }
  });

  it('a real newline presses Enter and a real tab presses Tab', async () => {
    const { ev } = await capture(() => ctl.type('a\nb\tc'));
    assert.deepStrictEqual(noShift(ev), ['a', 'enter', 'b', 'tab', 'c']);
  });

  it('non-ASCII is rejected BEFORE reaching the client: zero events (no out-of-bounds key presses)', async () => {
    const { ev, err } = await capture(() => ctl.type('h\u00e9llo \u65e5\u672c'));
    assert.match(err.message, /Cannot type/);
    assert.deepStrictEqual(ev, []);
  });

  it('typographic characters arrive as their ASCII equivalents', async () => {
    const { ev } = await capture(() => ctl.type('It\u2019s \u2014 ok'));
    assert.deepStrictEqual(noShift(ev), ['i', 't', 'apostrophe', 's', 'space', 'minus', 'space', 'o', 'k']);
  });

  it('click: press and release of the right button', async () => {
    for (const [btn, code] of [['left', 272], ['right', 273], ['middle', 274]]) {
      const { ev } = await capture(() => ctl.click(btn));
      assert.deepStrictEqual(ev, [[1, code, 1], [1, code, 0]], btn);
    }
  });

  it('a double click is two presses and two releases from one command; the backend can also send down and up on their own', async () => {
    let r = await capture(() => ctl.click('left', { double: true }));
    assert.deepStrictEqual(r.ev, [[1, 272, 1], [1, 272, 0], [1, 272, 1], [1, 272, 0]]);
    r = await capture(() => ctl.backend.mouseDown('right'));
    assert.deepStrictEqual(r.ev, [[1, 273, 1]]);
    r = await capture(() => ctl.backend.mouseUp('right'));
    assert.deepStrictEqual(r.ev, [[1, 273, 0]]);
  });

  it('scroll: the client writes REL_HWHEEL then REL_WHEEL, and "down" is a NEGATIVE wheel value (positive is away from the user)', async () => {
    const H = 6; const V = 8;                                   // REL_HWHEEL, REL_WHEEL
    let r = await capture(() => ctl.scroll(0, 3));              // three notches down
    assert.deepStrictEqual(r.ev, [[2, H, 0], [2, V, -3]]);
    r = await capture(() => ctl.scroll(2, 0));                  // two notches right
    assert.deepStrictEqual(r.ev, [[2, H, 2], [2, V, 0]]);
    r = await capture(() => ctl.scroll(-1, -4));                // four up, one left: vertical first
    assert.deepStrictEqual(r.ev, [[2, H, 0], [2, V, 4], [2, H, -1], [2, V, 0]]);
  });

  it('a drag presses at the start, glides in five whole-pixel moves and releases the button', async () => {
    const I32MIN = -2147483648;
    const at = (x, y) => [[2, 0, I32MIN], [2, 1, I32MIN], [2, 0, x], [2, 1, y]];
    const { ev } = await capture(() => ctl.drag({ x: 10, y: 10 }, { x: 110, y: 60 }));
    assert.deepStrictEqual(ev, [...at(10, 10), [1, 272, 1], ...at(30, 20), ...at(50, 30), ...at(70, 40), ...at(90, 50), ...at(110, 60), [1, 272, 0]]);
  });

  it('a key combo presses in order and releases in reverse (alt+f4)', async () => {
    const { ev } = await capture(() => ctl.pressCombo('alt+f4'));
    assert.deepStrictEqual(ev, [[1, codes.leftalt, 1], [1, codes.f4, 1], [1, codes.f4, 0], [1, codes.leftalt, 0]]);
  });

  it('moveTo is "slam to the corner, then move RELATIVE" - so it depends on pointer acceleration being off', async () => {
    // Documented, not just observed: the client's --absolute is REL_X/REL_Y = INT32_MIN (pin to 0,0)
    // followed by a relative move of (x,y). If pointer acceleration is on, that final relative move
    // is scaled and the pointer lands in the wrong place. If a future client switches to true
    // absolute events, this test fails and we get to re-think the coordinate mapping.
    const { ev } = await capture(() => ctl.moveTo(100, 200));
    const I32MIN = -2147483648;
    assert.deepStrictEqual(ev, [[2, 0, I32MIN], [2, 1, I32MIN], [2, 0, 100], [2, 1, 200]]);
  });
});
