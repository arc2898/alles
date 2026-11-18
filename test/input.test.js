'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { InputController, SafetyGate, parseCombo, comboToArgs, isDangerousCombo } = require('../src/main/computer/input');

// Records argv instead of spawning ydotool.
function fakeExec() {
  const calls = [];
  const exec = (bin, args, _opts, cb) => { calls.push({ bin, args }); cb(null, '', ''); };
  return { calls, exec };
}
const make = (gateOpts = {}) => {
  const f = fakeExec();
  const gate = new SafetyGate(gateOpts);
  return { ctl: new InputController({ gate, exec: f.exec }), gate, calls: f.calls };
};

test('argv matches the upstream README: Alt+F4 -> 56:1 62:1 62:0 56:0', () => {
  assert.deepStrictEqual(comboToArgs(parseCombo('alt+f4')), ['56:1', '62:1', '62:0', '56:0']);
});

test('argv matches the upstream README: Ctrl+Alt+F1 -> 29:1 56:1 59:1 59:0 56:0 29:0', () => {
  assert.deepStrictEqual(comboToArgs(parseCombo('ctrl+alt+f1')), ['29:1', '56:1', '59:1', '59:0', '56:0', '29:0']);
});

test('aliases resolve: super/meta/win/cmd are all LEFTMETA(125)', () => {
  for (const n of ['super', 'meta', 'win', 'cmd']) assert.strictEqual(parseCombo(n)[0].code, 125);
});

test('unknown keys are rejected, not silently dropped', () => {
  assert.throws(() => parseCombo('ctrl+banana'), /Unknown key "banana"/);
  assert.throws(() => parseCombo(''), /Empty key combo/);
});

test('click bitmask: left=0xC0, right=0xC1, middle=0xC2 (README: right click = 0xC1)', async () => {
  const { ctl, calls } = make();
  await ctl.click('left'); await ctl.click('right'); await ctl.click('middle');
  assert.deepStrictEqual(calls.map((c) => c.args), [['click', '0xC0'], ['click', '0xC1'], ['click', '0xC2']]);
});

test('double click uses --repeat 2 with a next-delay', async () => {
  const { ctl, calls } = make();
  await ctl.click('left', { double: true });
  assert.deepStrictEqual(calls[0].args, ['click', '--repeat', '2', '--next-delay', '60', '0xC0']);
});

test('moveTo uses --absolute; moveBy is relative (README syntax)', async () => {
  const { ctl, calls } = make();
  await ctl.moveTo(100, 200); await ctl.moveBy(-100, 100);
  assert.deepStrictEqual(calls[0].args, ['mousemove', '--absolute', '-x', '100', '-y', '200']);
  assert.deepStrictEqual(calls[1].args, ['mousemove', '-x', '-100', '-y', '100']);
});

test('type() passes text after "--" so text starting with "-" cannot be read as a flag', async () => {
  const { ctl, calls } = make();
  await ctl.type('--help');
  assert.strictEqual(calls[0].args.at(-2), '--');
  assert.strictEqual(calls[0].args.at(-1), '--help');
});

test('type() refuses empty and oversized text', async () => {
  const { ctl } = make();
  await assert.rejects(() => ctl.type(''), /non-empty/);
  await assert.rejects(() => ctl.type('x'.repeat(2001)), /2000/);
});

test('rejects NaN / absurd coordinates before touching ydotool', async () => {
  const { ctl, calls } = make();
  await assert.rejects(() => ctl.moveTo(NaN, 1), /Invalid x/);
  await assert.rejects(() => ctl.moveTo(1, 1e9), /Invalid y/);
  assert.strictEqual(calls.length, 0);
});

test('SAFETY: dangerous combos are blocked and never reach ydotool', async () => {
  const { ctl, calls } = make();
  for (const combo of ['ctrl+alt+delete', 'ctrl+alt+f3', 'alt+sysrq', 'super+l']) {
    await assert.rejects(() => ctl.pressCombo(combo), /Blocked dangerous/, combo);
  }
  assert.strictEqual(calls.length, 0);
});

test('SAFETY: aliases cannot bypass the blocklist (meta+l, win+l, cmd+l, control+alt+del)', async () => {
  const { ctl, calls } = make();
  for (const combo of ['meta+l', 'win+l', 'cmd+l', 'windows+l', 'control+alt+del', 'ctrl+alt+backspace']) {
    await assert.rejects(() => ctl.pressCombo(combo), /Blocked dangerous/, combo);
  }
  assert.strictEqual(calls.length, 0);
});

test('SAFETY: right-side modifiers cannot bypass the blocklist', () => {
  assert.ok(isDangerousCombo(parseCombo('rightctrl+rightalt+delete')));
  assert.ok(isDangerousCombo(parseCombo('rightmeta+l')));
});

test('SAFETY: ordinary combos still work (ctrl+c, ctrl+shift+t, alt+f4, super alone)', async () => {
  const { ctl, calls } = make();
  for (const combo of ['ctrl+c', 'ctrl+shift+t', 'alt+f4', 'super']) await ctl.pressCombo(combo);
  assert.strictEqual(calls.length, 4);
});

test('SAFETY: allowDangerous opt-in lets a blocked combo through', async () => {
  const { ctl, calls } = make({ allowDangerous: true });
  await ctl.pressCombo('super+l');
  assert.strictEqual(calls.length, 1);
});

test('SAFETY: emergency stop blocks EVERY action type until resumed', async () => {
  const { ctl, gate, calls } = make();
  gate.stop();
  await assert.rejects(() => ctl.moveTo(1, 1), /Emergency stop/);
  await assert.rejects(() => ctl.click(), /Emergency stop/);
  await assert.rejects(() => ctl.type('hi'), /Emergency stop/);
  await assert.rejects(() => ctl.pressCombo('ctrl+c'), /Emergency stop/);
  assert.strictEqual(calls.length, 0);
  gate.resume();
  await ctl.click();
  assert.strictEqual(calls.length, 1);
});

test('SAFETY: rate limit trips at the cap and recovers after a minute', async () => {
  let t = 5_000_000;
  const { ctl, calls } = make({ maxActionsPerMinute: 3, now: () => t });
  await ctl.click(); await ctl.click(); await ctl.click();
  await assert.rejects(() => ctl.click(), /Rate limit/);
  assert.strictEqual(calls.length, 3);
  t += 61_000;
  await ctl.click();
  assert.strictEqual(calls.length, 4);
});

test('a blocked action does not consume rate-limit budget', async () => {
  const { ctl, gate } = make({ maxActionsPerMinute: 2 });
  await assert.rejects(() => ctl.pressCombo('super+l'), /Blocked/);
  await assert.rejects(() => ctl.pressCombo('super+l'), /Blocked/);
  assert.strictEqual(gate.stamps.length, 0);
});

test('missing ydotool binary gives an actionable error', async () => {
  const gate = new SafetyGate();
  const ctl = new InputController({ gate, exec: (_b, _a, _o, cb) => cb(new Error('spawn ydotool ENOENT'), '', '') });
  await assert.rejects(() => ctl.click(), /ydotool is not installed/);
});

test('dead ydotoold daemon gives an actionable error', async () => {
  const gate = new SafetyGate();
  const ctl = new InputController({ gate, exec: (_b, _a, _o, cb) => cb(new Error('exit 1'), '', 'failed to connect socket') });
  await assert.rejects(() => ctl.click(), /ydotoold daemon is not running/);
});
