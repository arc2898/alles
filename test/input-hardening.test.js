'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { InputController, SafetyGate, childEnv, CHILD_ENV_KEYS } = require('../src/main/computer/input');
const { TOOL_SCHEMAS, createToolExecutor } = require('../src/main/tools');

// Unlike input.test.js this fake also records the OPTIONS (notably `env`) passed to exec.
function make(gateOpts = {}, ctlOpts = {}) {
  const calls = [];
  const exec = (bin, args, opts, cb) => { calls.push({ bin, args, opts }); cb(null, '', ''); };
  return { ctl: new InputController({ gate: new SafetyGate(gateOpts), exec, ...ctlOpts }), calls };
}

// ---------------------------------------------------------------- escape processing

test('type() disables the client\'s escape processing: --escape 0 sits right before the -- separator', () => {
  const { ctl, calls } = make();
  return ctl.type('hello').then(() => {
    assert.deepStrictEqual(calls[0].args, ['type', '--key-delay', '12', '--escape', '0', '--', 'hello']);
  });
});

test('backslashes reach the client exactly as given (no interpretation on our side either)', async () => {
  const { ctl, calls } = make();
  for (const t of ['C:\\dir\\', 'a\\nb', 'trailing\\', '\\x41']) { await ctl.type(t); assert.strictEqual(calls.at(-1).args.at(-1), t); }
});

// ---------------------------------------------------------------- minimal environment

test('SECURITY: a secret in OUR environment never reaches ydotool, for every kind of action', async () => {
  process.env.ALLES_TEST_SECRET = 'hunter2secret';
  try {
    const { ctl, calls } = make({ maxActionsPerMinute: 1000 });
    await ctl.type('abc\\'); await ctl.click('left'); await ctl.pressCombo('ctrl+c'); await ctl.moveTo(1, 2); await ctl.moveBy(3, 4);
    assert.strictEqual(calls.length, 5);
    for (const c of calls) {
      assert.ok(!('ALLES_TEST_SECRET' in c.opts.env), `secret leaked into the environment of "${c.args[0]}"`);
      assert.ok(!JSON.stringify(c.opts.env).includes('hunter2'));
    }
  } finally { delete process.env.ALLES_TEST_SECRET; }
});

test('the child environment holds only the whitelisted keys plus YDOTOOL_SOCKET', () => {
  const env = childEnv({ PATH: '/usr/bin', XDG_RUNTIME_DIR: '/run/user/1000', HOME: '/home/u', NVIDIA_API_KEY: 'nvapi-x', LD_PRELOAD: '/evil.so' }, '/run/user/1000/.ydotool_socket');
  assert.deepStrictEqual(Object.keys(env).sort(), ['PATH', 'XDG_RUNTIME_DIR', 'YDOTOOL_SOCKET']);
  for (const k of Object.keys(env)) assert.ok(k === 'YDOTOOL_SOCKET' || CHILD_ENV_KEYS.includes(k));
});

test('dangerous loader variables (LD_PRELOAD, LD_LIBRARY_PATH) are never forwarded', () => {
  const env = childEnv({ PATH: '/usr/bin', LD_PRELOAD: '/x.so', LD_LIBRARY_PATH: '/y', DYLD_INSERT_LIBRARIES: '/z' }, null);
  assert.ok(!('LD_PRELOAD' in env) && !('LD_LIBRARY_PATH' in env) && !('DYLD_INSERT_LIBRARIES' in env));
});

test('YDOTOOL_SOCKET: an explicit option wins; otherwise an inherited value is used; otherwise it is absent', () => {
  assert.strictEqual(childEnv({ YDOTOOL_SOCKET: '/inherited' }, '/explicit').YDOTOOL_SOCKET, '/explicit');
  assert.strictEqual(childEnv({ YDOTOOL_SOCKET: '/inherited' }, null).YDOTOOL_SOCKET, '/inherited');
  assert.ok(!('YDOTOOL_SOCKET' in childEnv({}, null)));
});

test('PATH falls back to a sane default so the binary can still be found', () => {
  assert.match(childEnv({}, null).PATH, /\/usr\/bin/);
});

test('non-string env values are ignored rather than forwarded', () => {
  assert.ok(!('PATH' in childEnv({ PATH: 42 }, null)) || typeof childEnv({ PATH: 42 }, null).PATH === 'string');
});

// ---------------------------------------------------------------- rejection and notes

test('rejected text makes NO client call', async () => {
  const { ctl, calls } = make();
  await assert.rejects(() => ctl.type('caf\u00e9'), /Cannot type 1 kind\(s\).*U\+00E9/);
  assert.strictEqual(calls.length, 0);
});

test('a rejected string does NOT consume rate-limit budget', async () => {
  const { ctl, calls } = make({ maxActionsPerMinute: 1 });
  for (let i = 0; i < 5; i++) await assert.rejects(() => ctl.type('\u65e5\u672c'));
  await ctl.type('ok');                    // still allowed: the rejections cost nothing
  assert.strictEqual(calls.length, 1);
});

test('typographic characters are converted and REPORTED in the return value', async () => {
  const { ctl, calls } = make();
  const r = await ctl.type('It\u2019s \u2014 fine');
  assert.strictEqual(calls[0].args.at(-1), "It's - fine");
  assert.strictEqual(r.typed, "It's - fine".length);
  assert.match(r.notes.join(' '), /converted 2 typographic/);
});

test('a plain string reports no notes', async () => {
  const { ctl } = make();
  assert.deepStrictEqual((await ctl.type('plain')).notes, []);
});

test('text that is only invisible characters is refused with a clear message', async () => {
  const { ctl, calls } = make();
  await assert.rejects(() => ctl.type('\u200B\uFEFF'), /Nothing to type/);
  assert.strictEqual(calls.length, 0);
});

test('newline and tab are still typable (they press Enter and Tab)', async () => {
  const { ctl, calls } = make();
  await ctl.type('a\nb\tc');
  assert.strictEqual(calls[0].args.at(-1), 'a\nb\tc');
});

test('emergency stop still wins over valid text', async () => {
  const { ctl, calls } = make(); ctl.gate.stop();
  await assert.rejects(() => ctl.type('hi'), /Emergency stop/);
  assert.strictEqual(calls.length, 0);
});

// ---------------------------------------------------------------- the tool the MODEL sees

const schema = () => TOOL_SCHEMAS.find((t) => t.function.name === 'type_text').function;

test('the type_text description warns the model about the ASCII-only limit up front', () => {
  assert.match(schema().description, /US-keyboard/);
  assert.match(schema().description, /rejected/);
  assert.match(schema().description, /newline presses Enter/i);
});

test('type_text tells the model what was converted', async () => {
  const input = { type: async () => ({ typed: 9, notes: ['converted 2 typographic character(s) to plain equivalents (\u2019 -> \')'] }) };
  const r = await createToolExecutor({ input, screen: {} })('type_text', { text: 'x' });
  assert.match(r.text, /^Typed 9 chars\./);
  assert.match(r.text, /Note: converted 2 typographic/);
});

test('type_text with no notes stays terse', async () => {
  const r = await createToolExecutor({ input: { type: async () => ({ typed: 3, notes: [] }) }, screen: {} })('type_text', { text: 'abc' });
  assert.strictEqual(r.text, 'Typed 3 chars.');
});

test('type_text surfaces a rejection to the model as an error it can act on', async () => {
  const { ctl } = make();
  const r = await createToolExecutor({ input: ctl, screen: {} })('type_text', { text: 'caf\u00e9' });
  assert.ok(r.error);
  assert.match(r.text, /Cannot type/);
  assert.match(r.text, /write_file/);
});

test('type_text rejects a non-string argument instead of crashing', async () => {
  const r = await createToolExecutor({ input: { type: async () => ({}) }, screen: {} })('type_text', { text: 42 });
  assert.ok(r.error); assert.match(r.text, /needs a "text" string/);
});
