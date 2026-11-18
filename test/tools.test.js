'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TOOL_SCHEMAS, createToolExecutor, resolvePath, runShell } = require('../src/main/tools');
const { tmpDir } = require('./helpers/tmp');

// Fakes that record what the executor asks the OS layer to do.
function fakes({ scale = 2 / 3 } = {}) {
  const log = [];
  const input = {
    moveTo: async (x, y) => log.push(['moveTo', x, y]),
    click: async (b, o) => log.push(['click', b, !!(o && o.double)]),
    type: async (t) => log.push(['type', t]),
    pressCombo: async (k) => log.push(['keys', k]),
  };
  const screen = { capture: async () => ({ png: Buffer.from('PNG'), scale, modelWidth: 1280, modelHeight: 720 }) };
  return { log, input, screen };
}
const tmp = () => tmpDir('arc-tools-');

test('every schema is valid OpenAI function-calling shape and names are unique', () => {
  const names = TOOL_SCHEMAS.map((t) => t.function.name);
  assert.strictEqual(new Set(names).size, names.length);
  for (const t of TOOL_SCHEMAS) {
    assert.strictEqual(t.type, 'function');
    assert.strictEqual(t.function.parameters.type, 'object');
    for (const r of t.function.parameters.required) assert.ok(r in t.function.parameters.properties, `${t.function.name}.${r}`);
  }
});

test('every schema has a matching handler (no advertised-but-missing tools)', async () => {
  const { input, screen } = fakes();
  const exec = createToolExecutor({ input, screen, approve: async () => true });
  for (const name of TOOL_SCHEMAS.map((t) => t.function.name)) {
    const r = await exec(name, {});
    assert.ok(!/^Unknown tool/.test(r.text), `${name} has no handler`);
  }
});

test('mouse_click converts model coords to REAL pixels using the last screenshot scale', async () => {
  const { log, input, screen } = fakes({ scale: 2 / 3 }); // 1920 -> 1280
  const exec = createToolExecutor({ input, screen });
  await exec('screenshot', {});
  await exec('mouse_click', { x: 640, y: 360 });
  assert.deepStrictEqual(log[0], ['moveTo', 960, 540]);
  assert.deepStrictEqual(log[1], ['click', 'left', false]);
});

test('mouse tools refuse to run before any screenshot (coordinates would be meaningless)', async () => {
  const { log, input, screen } = fakes();
  const exec = createToolExecutor({ input, screen });
  const r = await exec('mouse_click', { x: 1, y: 1 });
  assert.ok(r.error && /Take a screenshot first/.test(r.text));
  assert.strictEqual(log.length, 0);
});

test('screenshot returns the image for the model', async () => {
  const { input, screen } = fakes();
  const r = await createToolExecutor({ input, screen })('screenshot', {});
  assert.ok(Buffer.isBuffer(r.image));
  assert.match(r.text, /1280x720/);
});

test('double click and right button are forwarded', async () => {
  const { log, input, screen } = fakes({ scale: 1 });
  const exec = createToolExecutor({ input, screen });
  await exec('screenshot', {});
  await exec('mouse_click', { x: 5, y: 6, button: 'right', double: true });
  assert.deepStrictEqual(log[1], ['click', 'right', true]);
});

test('SAFETY: with NO approve callback, run_shell and write_file are DENIED (fail closed)', async () => {
  const dir = tmp();
  const target = path.join(dir, 'should-not-exist.txt');
  const { input, screen } = fakes();
  let shellRan = false;
  const exec = createToolExecutor({ input, screen, spawn: () => { shellRan = true; } }); // note: no approve
  const a = await exec('run_shell', { command: 'echo hi' });
  const b = await exec('write_file', { path: target, content: 'x' });
  assert.match(a.text, /DENIED/); assert.match(b.text, /DENIED/);
  assert.strictEqual(shellRan, false);
  assert.strictEqual(fs.existsSync(target), false);
});

test('SAFETY: approve() is asked with the exact command, and a "no" blocks it', async () => {
  const { input, screen } = fakes();
  const asked = [];
  let shellRan = false;
  const exec = createToolExecutor({
    input, screen, spawn: () => { shellRan = true; },
    approve: async (a) => { asked.push(a); return false; },
  });
  const r = await exec('run_shell', { command: 'rm -rf ~/important' });
  assert.deepStrictEqual(asked, [{ tool: 'run_shell', command: 'rm -rf ~/important' }]);
  assert.match(r.text, /DENIED/);
  assert.strictEqual(shellRan, false);
});

test('run_shell (approved) reports exit code, stdout and stderr', async () => {
  const { input, screen } = fakes();
  const exec = createToolExecutor({ input, screen, approve: async () => true });
  const ok = await exec('run_shell', { command: 'echo hello; echo oops 1>&2' });
  assert.match(ok.text, /exit_code: 0/); assert.match(ok.text, /hello/); assert.match(ok.text, /oops/);
  const bad = await exec('run_shell', { command: 'exit 3' });
  assert.match(bad.text, /exit_code: 3/);
});

test('run_shell output is truncated so it cannot flood the model context', async () => {
  const { input, screen } = fakes();
  const exec = createToolExecutor({ input, screen, approve: async () => true });
  const r = await exec('run_shell', { command: 'yes x | head -c 50000' });
  assert.ok(r.text.length < 9000);
  assert.match(r.text, /truncated/);
});

test('write_file / read_file / list_dir round trip (approved)', async () => {
  const dir = tmp();
  const { input, screen } = fakes();
  const exec = createToolExecutor({ input, screen, approve: async () => true });
  const f = path.join(dir, 'sub', 'a.txt');
  assert.match((await exec('write_file', { path: f, content: 'héllo' })).text, /Wrote 6 bytes/);
  assert.strictEqual((await exec('read_file', { path: f })).text, 'héllo');
  assert.match((await exec('list_dir', { path: path.join(dir, 'sub') })).text, /- a\.txt/);
});

test('read_file refuses binary files instead of dumping garbage into the context', async () => {
  const dir = tmp(); const f = path.join(dir, 'b.bin');
  fs.writeFileSync(f, Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
  const { input, screen } = fakes();
  const r = await createToolExecutor({ input, screen })('read_file', { path: f });
  assert.match(r.text, /binary file/);
});

test('errors become tool results the model can react to, never thrown exceptions', async () => {
  const { input, screen } = fakes();
  const exec = createToolExecutor({ input, screen });
  const r = await exec('read_file', { path: '/definitely/not/here.txt' });
  assert.ok(r.error); assert.match(r.text, /^Error:/);
});

test('input-layer rejections (kill switch, blocked combo) surface as tool errors', async () => {
  const { screen } = fakes();
  const input = { pressCombo: async () => { throw new Error('Emergency stop is engaged'); } };
  const r = await createToolExecutor({ input, screen })('press_keys', { keys: 'ctrl+c' });
  assert.ok(r.error); assert.match(r.text, /Emergency stop/);
});

test('unknown tool and malformed-JSON arguments give the model actionable feedback', async () => {
  const { input, screen } = fakes();
  const exec = createToolExecutor({ input, screen });
  assert.match((await exec('hack_the_planet', {})).text, /Unknown tool "hack_the_planet"/);
  const r = await exec('type_text', { __parseError: '{oops' });
  assert.ok(r.error); assert.match(r.text, /not valid JSON/);
});

test('wait is clamped so the model cannot stall the agent for minutes', async () => {
  const { input, screen } = fakes();
  const r = await createToolExecutor({ input, screen })('wait', { seconds: 0 });
  assert.match(r.text, /Waited 0s/);
});

test('finish marks the run done', async () => {
  const { input, screen } = fakes();
  const r = await createToolExecutor({ input, screen })('finish', { summary: 'all done' });
  assert.strictEqual(r.done, true); assert.strictEqual(r.text, 'all done');
});

test('resolvePath expands ~ and rejects empty', () => {
  assert.strictEqual(resolvePath('~/x'), path.join(os.homedir(), 'x'));
  assert.throws(() => resolvePath(''), /path is required/);
});

// ---------------------------------------------------------------- Stop, the time limit, and programs a command leaves running

// `sleep <unique number>` processes, found the way a person would: by what they are running (not by a pattern that matches this test too).
const sleepers = (arg) => fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).filter((d) => {
  try { const a = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0'); return a[0].endsWith('sleep') && a[1] === arg; } catch { return false; }
});
const killSleepers = (arg) => { for (const d of sleepers(arg)) { try { process.kill(Number(d), 'SIGKILL'); } catch { /* gone */ } } };
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 25)); } return !!(await fn()); };
let seq = 0;
const uniq = () => `29.${process.pid}${++seq}`;                       // a sleep length no other process has

test('STOP: a wait ends at once when Stop is pressed, and says so', async () => {
  const { input, screen } = fakes();
  const exec = createToolExecutor({ input, screen });
  const ac = new AbortController();
  const t0 = Date.now();
  const p = exec('wait', { seconds: 20 }, { signal: ac.signal });
  setTimeout(() => ac.abort(), 60);
  const r = await p;
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  assert.match(r.text, /pressed Stop/);
});

test('STOP: a wait that starts after Stop was pressed does not wait at all', async () => {
  const { input, screen } = fakes();
  const ac = new AbortController(); ac.abort();
  const t0 = Date.now();
  const r = await createToolExecutor({ input, screen })('wait', { seconds: 20 }, { signal: ac.signal });
  assert.ok(Date.now() - t0 < 500);
  assert.match(r.text, /pressed Stop/);
});

test('a wait nobody stops still waits the whole time, and does not leave a listener on the signal', async () => {
  const { input, screen } = fakes();
  const ac = new AbortController();
  const t0 = Date.now();
  const r = await createToolExecutor({ input, screen })('wait', { seconds: 0.2 }, { signal: ac.signal });
  assert.ok(Date.now() - t0 >= 190);
  assert.strictEqual(r.text, 'Waited 0.2s');
  ac.abort();                                                       // later: nothing is waiting any more, so nothing happens
});

test('STOP: a running shell command is killed with everything it started, and the answer comes back at once', async () => {
  const ARG = uniq();
  const { input, screen } = fakes();
  const exec = createToolExecutor({ input, screen, approve: async () => true });
  const ac = new AbortController();
  try {
    const p = exec('run_shell', { command: `echo begun; sleep ${ARG}; echo late` }, { signal: ac.signal });
    assert.ok(await until(() => sleepers(ARG).length === 1), 'the command is running');
    const t0 = Date.now();
    ac.abort();
    const r = await p;
    assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
    assert.match(r.text, /exit_code: STOPPED/);
    assert.ok(await until(() => sleepers(ARG).length === 0), 'nothing it started is left running');
  } finally { killSleepers(ARG); }
});

test('STOP: when Stop was pressed before the command started, it is never started', async () => {
  const { input, screen } = fakes();
  let started = false;
  const exec = createToolExecutor({ input, screen, approve: async () => true, spawn: () => { started = true; } });
  const ac = new AbortController(); ac.abort();
  const r = await exec('run_shell', { command: 'echo hi' }, { signal: ac.signal });
  assert.strictEqual(started, false);
  assert.match(r.text, /exit_code: STOPPED/);
});

test('a command that runs past the time limit is killed with what it started; what it printed so far is kept', async () => {
  const ARG = uniq();
  try {
    const text = await runShell(`echo partial-one; sleep 0.2; echo partial-two; sleep ${ARG}`, null, { timeoutMs: 900 });
    assert.match(text, /exit_code: TIMEOUT/);
    assert.match(text, /partial-one\npartial-two/);
    assert.ok(await until(() => sleepers(ARG).length === 0), 'nothing is left running');
  } finally { killSleepers(ARG); }
});

test('a program the command leaves running does not hold the answer back, and is not killed', async () => {
  const ARG = uniq();
  try {
    const t0 = Date.now();
    const text = await runShell(`sleep ${ARG} & echo started`, null, { drainMs: 150 });
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
    assert.match(text, /exit_code: 0/);
    assert.match(text, /started/);
    assert.match(text, /still running in the background/);
    assert.strictEqual(sleepers(ARG).length, 1, 'what the person asked to start keeps running');
  } finally { killSleepers(ARG); }
});

test('a program left running is not killed when it prints later (its output is still read, so the pipe is not broken)', async () => {
  const ARG = uniq();
  try {
    // The background shell writes TWICE after the answer has gone back, then starts the sleep. If the pipe were closed after the first write,
    // the second would kill it (a write to a closed pipe does that) and the sleep would never start.
    await runShell(`sh -c 'sleep 0.6; echo one; sleep 0.3; echo two; exec sleep ${ARG}' & echo started`, null, { drainMs: 100 });
    assert.ok(await until(() => sleepers(ARG).length === 1, 4000), 'the program lived through its own output');
  } finally { killSleepers(ARG); }
});

test('a command that prints without end is stopped, and says why', async () => {
  const t0 = Date.now();
  const text = await runShell('yes alles-test-output', null, {});
  assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0} ms`);
  assert.match(text, /exit_code: OUTPUT-TOO-LONG/);
  assert.match(text, /far too much/);
  assert.ok(text.length < 9000);
  const leftOver = () => fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).filter((d) => { try { return fs.readFileSync(`/proc/${d}/cmdline`, 'utf8') === 'yes\0alles-test-output\0'; } catch { return false; } });
  assert.ok(await until(() => leftOver().length === 0), 'the endless command is not left running');
});

test('a command gets no keyboard: one that asks for input ends instead of waiting for ever', async () => {
  const t0 = Date.now();
  const text = await runShell('cat', null, {});
  assert.ok(Date.now() - t0 < 3000);
  assert.match(text, /exit_code: 0/);
});

test('a folder that does not exist is an answer, not a hang', async () => {
  const text = await runShell('echo hi', path.join(tmp(), 'no-such-folder'), {});
  assert.match(text, /exit_code: -1/);
  assert.match(text, /does not exist/);   // was /ENOENT/: Node says "spawn /bin/sh ENOENT", which blames the shell instead of the folder
});

// ---------------------------------------------------------------- points outside the picture

test('a click outside the screenshot is refused with a clear message, and nothing is clicked', async () => {
  const { log, input, screen } = fakes();
  const exec = createToolExecutor({ input, screen });
  await exec('screenshot', {});
  for (const [x, y] of [[1400, 300], [300, 800], [-5, 10], [10, -1]]) {
    const r = await exec('mouse_click', { x, y });
    assert.strictEqual(r.error, true, `(${x}, ${y})`);
    assert.match(r.text, new RegExp(`\\(${x}, ${y}\\) is outside the screenshot, which is 1280x720`));
  }
  assert.deepStrictEqual(log.filter((l) => l[0] === 'click' || l[0] === 'moveTo'), []);
});

test('the corners and edges of the screenshot are inside it', async () => {
  const { log, input, screen } = fakes();
  const exec = createToolExecutor({ input, screen });
  await exec('screenshot', {});
  for (const [x, y] of [[0, 0], [1280, 720], [0, 720], [1280, 0]]) assert.ok(!(await exec('mouse_move', { x, y })).error, `(${x}, ${y})`);
  assert.strictEqual(log.filter((l) => l[0] === 'moveTo').length, 4);
});

test('a click without both numbers is refused', async () => {
  const { log, input, screen } = fakes();
  const exec = createToolExecutor({ input, screen });
  await exec('screenshot', {});
  for (const args of [{ x: 100 }, { y: 100 }, { x: 'left', y: 5 }, { x: null, y: 5 }, { x: NaN, y: 5 }, {}]) {
    const r = await exec('mouse_click', args);
    assert.strictEqual(r.error, true, JSON.stringify(args));
    assert.match(r.text, /x and y must be numbers/);
  }
  assert.deepStrictEqual(log.filter((l) => l[0] === 'click'), []);
});

test('a drag with either end outside the screenshot does not start, and says which end', async () => {
  const { input, screen } = fakes();
  const dragged = []; const scrolled = [];
  input.drag = async (...a) => dragged.push(a);
  input.scroll = async (...a) => scrolled.push(a);
  const exec = createToolExecutor({ input, screen });
  await exec('screenshot', {});
  const a = await exec('mouse_drag', { from_x: 10, from_y: 10, to_x: 2000, to_y: 10 });
  assert.match(a.text, /^Error: The end \(2000, 10\) is outside/);
  const b = await exec('mouse_drag', { from_x: -3, from_y: 10, to_x: 20, to_y: 10 });
  assert.match(b.text, /^Error: The start \(-3, 10\) is outside/);
  const c = await exec('mouse_scroll', { x: 5000, y: 5, direction: 'down' });
  assert.strictEqual(c.error, true);
  assert.deepStrictEqual([dragged, scrolled], [[], []]);
  assert.ok(!(await exec('mouse_drag', { from_x: 10, from_y: 10, to_x: 200, to_y: 100 })).error);
  assert.strictEqual(dragged.length, 1);
});

// ---------------------------------------------------------------- what a model can send that is not a tool call at all
test('tool names every object has (constructor, toString, __proto__ ...) are unknown tools, not functions to run', async () => {
  const { input, screen } = fakes();
  const exec = createToolExecutor({ input, screen });
  for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf', 'toLocaleString']) {
    const r = await exec(name, {});
    assert.ok(r.error, name); assert.match(r.text, /^Unknown tool "/, name); assert.strictEqual(typeof r.text, 'string', name);
  }
  for (const odd of [undefined, null, 5, {}, ['screenshot'], '']) {
    const r = await exec(odd, {});
    assert.ok(r.error, String(odd)); assert.match(r.text, /^Unknown tool/);
  }
});

test('an unknown tool name is quoted back only up to a point, so a garbled reply cannot fill the context', async () => {
  const { input, screen } = fakes();
  const r = await createToolExecutor({ input, screen })('x'.repeat(50_000), {});
  assert.ok(r.error); assert.ok(r.text.length < 600, `${r.text.length} chars`);
  assert.match(r.text, /Available: screenshot/, 'the list of real tools is still given');
});

test('arguments that were not JSON are quoted back only up to a point, and the answer says nothing was done', async () => {
  const { log, input, screen } = fakes();
  const r = await createToolExecutor({ input, screen })('mouse_click', { __parseError: `{"x": 10, "y": ${'9'.repeat(100_000)}` });
  assert.ok(r.error);
  assert.match(r.text, /^Your arguments were not valid JSON, so nothing was done \(you sent: \{"x": 10, "y": 9+… \(\d+ more characters\)\)\. Send them again as ONE JSON object\.$/);
  assert.ok(r.text.length < 600, `${r.text.length} chars`);
  assert.deepStrictEqual(log, [], 'nothing was clicked');
  const short = await createToolExecutor({ input, screen })('type_text', { __parseError: '{oops' });
  assert.match(short.text, /\(you sent: \{oops\)/);
});

test('finish with no summary, or one that is not text, still finishes', async () => {
  const { input, screen } = fakes();
  const exec = createToolExecutor({ input, screen });
  assert.deepStrictEqual(await exec('finish', {}), { text: 'Done.', done: true });
  assert.deepStrictEqual(await exec('finish', { summary: '   ' }), { text: 'Done.', done: true });
  assert.deepStrictEqual(await exec('finish', { summary: '  fine  ' }), { text: 'fine', done: true });
  assert.deepStrictEqual(await exec('finish', { summary: { files: 2 } }), { text: '{"files":2}', done: true });
  assert.deepStrictEqual(await exec('finish', { summary: 7 }), { text: '7', done: true });
});

test('a yes/no argument that comes as text is read as what it says: "false" is NOT a double click, and "true" is', async () => {
  const log = [];
  const input = { moveTo: async () => {}, click: async (b, o) => log.push(['click', b, o.double]), type: async (t, o) => { log.push(['type', t, o ? o.terminal : undefined]); return { typed: t.length }; } };
  const screen = fakes().screen;
  const exec = createToolExecutor({ input, screen });
  await exec('screenshot', {});
  const doubles = [];
  for (const d of [false, true, 'false', 'true', 'TRUE', ' true ', 'yes', 1, 0, null, undefined, '']) {
    log.length = 0;
    const r = await exec('mouse_click', { x: 10, y: 10, double: d });
    doubles.push([d, log[0][2], /^Double-/.test(r.text)]);
  }
  assert.deepStrictEqual(doubles.map(([, did]) => did), [false, true, false, true, true, true, false, false, false, false, false, false]);
  assert.deepStrictEqual(doubles.map(([, , said]) => said), doubles.map(([, did]) => did), 'and the answer to the model says the same as what was done');
  for (const [t, expected] of [[true, true], ['true', true], ['false', undefined], [false, undefined], [undefined, undefined], ['yes', undefined]]) {
    log.length = 0;
    await exec('type_text', { text: 'ls', terminal: t });
    assert.deepStrictEqual(log[0], ['type', 'ls', expected], String(t));
  }
});
