'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { YdotoolBackend, childEnv, comboToArgs, MOUSE_BUTTONS, isMouseButton } = require('../src/main/computer/ydotool-backend');
const { parseCombo } = require('../src/main/computer/input');

/** A fake ydotool client: records every command line it is asked to run, and can be made to fail. */
function rig({ fail = null, sleeps = true } = {}) {
  const runs = []; const log = [];
  const exec = (bin, args, opts, cb) => {
    runs.push({ bin, args, opts });
    log.push(args);
    const f = fail ? fail(args, runs.length) : null;
    if (f) return cb(f.err, f.stdout || '', f.stderr || '');
    cb(null, '  ok\n', '');
  };
  const backend = new YdotoolBackend({ bin: '/usr/bin/ydotool', socket: '/run/user/1000/.ydotool_socket', exec, sleep: async (ms) => { if (sleeps) log.push(['sleep', ms]); } });
  return { backend, runs, log };
}
const err = (message, extra = {}) => Object.assign(new Error(message), extra);

// ------------------------------------------------------------------ pointer

test('moveTo and moveBy', async () => {
  const { backend, log } = rig();
  await backend.moveTo(100, 50, { width: 1, height: 1 });                 // the picture size is of no use to ydotool: plain pixels
  await backend.moveBy(-3, 4);
  assert.deepStrictEqual(log, [['mousemove', '--absolute', '-x', '100', '-y', '50'], ['mousemove', '-x', '-3', '-y', '4']]);
});

test('clicks: left, right, middle, double; down and up on their own', async () => {
  const { backend, log } = rig();
  await backend.click('left'); await backend.click('right'); await backend.click('middle');
  await backend.click('left', { double: true });
  await backend.mouseDown('left'); await backend.mouseUp('left'); await backend.mouseDown('right'); await backend.mouseUp('middle');
  assert.deepStrictEqual(log, [
    ['click', '0xC0'], ['click', '0xC1'], ['click', '0xC2'],
    ['click', '--repeat', '2', '--next-delay', '60', '0xC0'],
    ['click', '0x40'], ['click', '0x80'], ['click', '0x41'], ['click', '0x82'],
  ]);
});

test('a button that is not one (including names an object inherits) is refused before anything runs', async () => {
  const { backend, runs } = rig();
  for (const b of ['back', 'toString', 'constructor', '__proto__', '', null, 5]) {
    await assert.rejects(async () => backend.click(b), /Unknown mouse button/, String(b));
    await assert.rejects(async () => backend.mouseDown(b), /Unknown mouse button/, String(b));
    await assert.rejects(async () => backend.mouseUp(b), /Unknown mouse button/, String(b));
  }
  assert.strictEqual(runs.length, 0);
  assert.ok(isMouseButton('left') && isMouseButton('middle') && !isMouseButton('toString') && !isMouseButton(undefined));
  assert.deepStrictEqual(Object.keys(MOUSE_BUTTONS), ['left', 'right', 'middle']);
});

// ------------------------------------------------------------------ wheel

test('scroll: ydotool\'s vertical wheel is positive = UP, so scrolling down by n sends -n', async () => {
  const { backend, log } = rig();
  await backend.scroll(0, 3);
  await backend.scroll(0, -2);
  assert.deepStrictEqual(log, [['mousemove', '--wheel', '-x', '0', '-y', '-3'], ['mousemove', '--wheel', '-x', '0', '-y', '2']]);
});

test('scroll sideways: positive = right; both directions are two commands, vertical first', async () => {
  const { backend, log } = rig();
  await backend.scroll(4, 0);
  await backend.scroll(-1, 0);
  await backend.scroll(2, 5);
  assert.deepStrictEqual(log, [
    ['mousemove', '--wheel', '-x', '4', '-y', '0'],
    ['mousemove', '--wheel', '-x', '-1', '-y', '0'],
    ['mousemove', '--wheel', '-x', '0', '-y', '-5'], ['mousemove', '--wheel', '-x', '2', '-y', '0'],
  ]);
});

test('scroll of nothing runs nothing; fractions are rounded', async () => {
  const { backend, log } = rig();
  await backend.scroll(0, 0); await backend.scroll(undefined, undefined); await backend.scroll(0.2, 0.2);
  assert.deepStrictEqual(log, []);
  await backend.scroll(0, 2.6);
  assert.deepStrictEqual(log, [['mousemove', '--wheel', '-x', '0', '-y', '-3']]);
});

// ------------------------------------------------------------------ drag

test('drag: move, press, wait, five glides (rounded), wait, release', async () => {
  const { backend, log } = rig();
  await backend.drag({ x: 10, y: 10 }, { x: 110, y: 60 });
  assert.deepStrictEqual(log, [
    ['mousemove', '--absolute', '-x', '10', '-y', '10'],
    ['click', '0x40'], ['sleep', 120],
    ['mousemove', '--absolute', '-x', '30', '-y', '20'], ['mousemove', '--absolute', '-x', '50', '-y', '30'],
    ['mousemove', '--absolute', '-x', '70', '-y', '40'], ['mousemove', '--absolute', '-x', '90', '-y', '50'],
    ['mousemove', '--absolute', '-x', '110', '-y', '60'],
    ['sleep', 100], ['click', '0x80'],
  ]);
});

test('drag: every glide point is a whole pixel (ydotool is given integers) even when the distance does not divide by five', async () => {
  const { backend, log } = rig();
  await backend.drag({ x: 3, y: 9 }, { x: 10, y: 4 });
  const points = log.filter((a) => a[0] === 'mousemove').map((a) => [a[3], a[5]]);
  assert.deepStrictEqual(points, [['3', '9'], ['4', '8'], ['6', '7'], ['7', '6'], ['9', '5'], ['10', '4']]);
  for (const [x, y] of points) assert.match(`${x}${y}`, /^\d+$/);
});

test('drag with the right button presses and releases that button', async () => {
  const { backend, log } = rig();
  await backend.drag({ x: 0, y: 0 }, { x: 5, y: 5 }, { button: 'right' });
  assert.deepStrictEqual(log.filter((a) => a[0] === 'click'), [['click', '0x41'], ['click', '0x81']]);
});

test('a drag that fails half-way still lets go of the button', async () => {
  const { backend, log } = rig({ fail: (args, n) => (n === 4 ? { err: err('boom'), stderr: 'bad thing' } : null) });
  await assert.rejects(() => backend.drag({ x: 0, y: 0 }, { x: 100, y: 0 }), /ydotool failed: bad thing/);
  assert.deepStrictEqual(log[log.length - 1], ['click', '0x80']);
});

test('a drag stopped by the emergency stop lets go of the button too', async () => {
  const { backend, log } = rig();
  let steps = 0;
  backend.cancelled = () => steps++ >= 2;
  await assert.rejects(() => backend.drag({ x: 0, y: 0 }, { x: 100, y: 0 }), /Emergency stop is engaged/);
  assert.deepStrictEqual(log[log.length - 1], ['click', '0x80']);
  assert.strictEqual(log.filter((a) => a[0] === 'mousemove').length, 3, 'start + two glides, then stopped');
});

test('a drag whose release also fails does not hide the first error, and does not throw a second one', async () => {
  const { backend } = rig({ fail: (args) => (args[0] === 'click' && args[1] === '0x80' ? { err: err('release failed') } : (args[0] === 'mousemove' && args[3] === '40' ? { err: err('step failed'), stderr: 'step failed' } : null)) });
  await assert.rejects(() => backend.drag({ x: 0, y: 0 }, { x: 100, y: 0 }), /ydotool failed: step failed/);
});

// ------------------------------------------------------------------ text and keys

test('typeText: escape processing is OFF, the delay is passed, and the text follows "--"', async () => {
  const { backend, log } = rig();
  const r = await backend.typeText('ls -la\n', { delayMs: 7 });
  assert.deepStrictEqual(log, [['type', '--key-delay', '7', '--escape', '0', '--', 'ls -la\n']]);
  assert.deepStrictEqual(r, { notes: [] });
  await backend.typeText('x');
  assert.deepStrictEqual(log[1].slice(0, 3), ['type', '--key-delay', '12']);
});

test('typeText refuses anything but plain US-keyboard characters, even if the front end let it through', async () => {
  const { backend, runs } = rig();
  for (const t of ['caf\u00e9', '\u{1F600}', 'a\u201cb', 'x\u200by', '\r\n', 'a\u0000b', '\u007f']) await assert.rejects(() => backend.typeText(t), /plain US-keyboard characters; nothing was typed/, JSON.stringify(t));
  assert.strictEqual(runs.length, 0, 'a byte of 0x80 or more must never reach the ydotool client (it reads out of bounds)');
});

test('typeText keeps backslashes: they are not interpreted', async () => {
  const { backend, log } = rig();
  await backend.typeText('C:\\Users\\a\\');
  assert.strictEqual(log[0][log[0].length - 1], 'C:\\Users\\a\\');
  assert.ok(log[0].includes('--escape') && log[0][log[0].indexOf('--escape') + 1] === '0');
});

test('pressKeys: press in order, release in reverse', async () => {
  const { backend, log } = rig();
  await backend.pressKeys(parseCombo('ctrl+shift+t'));
  const [a, b, c] = parseCombo('ctrl+shift+t').map((k) => k.code);
  assert.deepStrictEqual(log, [['key', `${a}:1`, `${b}:1`, `${c}:1`, `${c}:0`, `${b}:0`, `${a}:0`]]);
  assert.deepStrictEqual(comboToArgs(parseCombo('a')), [`${parseCombo('a')[0].code}:1`, `${parseCombo('a')[0].code}:0`]);
});

// ------------------------------------------------------------------ the process, its environment, and how it fails

test('the client runs with a minimal environment: PATH, the runtime dir and the socket, never our secrets', async () => {
  const saved = { ...process.env };
  process.env.NVIDIA_API_KEY = 'nvapi-secret'; process.env.XAI_API_KEY = 'xai-secret'; process.env.XDG_RUNTIME_DIR = '/run/user/1000'; process.env.HOME = '/home/me';
  try {
    const { backend, runs } = rig();
    await backend.moveBy(1, 1);
    const env = runs[0].opts.env;
    assert.deepStrictEqual(Object.keys(env).sort(), ['PATH', 'XDG_RUNTIME_DIR', 'YDOTOOL_SOCKET']);
    assert.strictEqual(env.YDOTOOL_SOCKET, '/run/user/1000/.ydotool_socket');
    assert.ok(!JSON.stringify(env).includes('secret'));
    assert.strictEqual(runs[0].bin, '/usr/bin/ydotool');
    assert.strictEqual(runs[0].opts.timeout, 10000);
  } finally { process.env = saved; }
  assert.deepStrictEqual(childEnv({}, null), { PATH: '/usr/local/bin:/usr/bin:/bin' });
  assert.deepStrictEqual(childEnv({ PATH: '/x', YDOTOOL_SOCKET: '/s', HOME: '/h' }, null), { PATH: '/x', YDOTOOL_SOCKET: '/s' });
});

test('output is trimmed and returned', async () => {
  const { backend } = rig();
  assert.strictEqual(await backend.moveBy(1, 1), 'ok');
});

test('"ydotool is not installed" and "the daemon is not running" are unavailable (so auto mode can look elsewhere); other failures are not', async () => {
  const missing = rig({ fail: () => ({ err: err('spawn /usr/bin/ydotool ENOENT') }) });
  await assert.rejects(() => missing.backend.moveBy(1, 1), (e) => e.unavailable === true && /ydotool failed: ydotool is not installed/.test(e.message));
  const noDaemon = rig({ fail: () => ({ err: err('Command failed'), stderr: 'failed to connect socket `/tmp/.ydotool_socket\': No such file or directory' }) });
  await assert.rejects(() => noDaemon.backend.moveBy(1, 1), (e) => e.unavailable === true && /ydotoold daemon is not running \(start it: systemctl --user enable --now ydotool\)/.test(e.message));
  const other = rig({ fail: () => ({ err: err('Command failed'), stderr: 'Invalid argument' }) });
  await assert.rejects(() => other.backend.moveBy(1, 1), (e) => !e.unavailable && /ydotool failed: Invalid argument/.test(e.message));
  const noStderr = rig({ fail: () => ({ err: err('exited with 3') }) });
  await assert.rejects(() => noStderr.backend.moveBy(1, 1), /ydotool failed: exited with 3/);
});

test('info() and capabilities(): plain keyboard characters only, but scrolling and dragging work', async () => {
  const { backend } = rig();
  assert.deepStrictEqual(backend.info(), { name: 'ydotool', label: 'ydotool (virtual keyboard and mouse)', unicode: false, scroll: true, drag: true });
  assert.deepStrictEqual(await backend.capabilities(), backend.info());
  backend.resume(); backend.close(); await backend.dispose();                   // nothing to hold: these are harmless
});
