'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ApprovalBroker } = require('../src/main/approvals');
const { wireApprovals } = require('../src/main/wiring');

function rig() {
  let n = 0; const broker = new ApprovalBroker({ newId: () => `q${++n}`, setTimer: () => ({ unref() {} }), clearTimer() {} });
  const calls = []; const dock = { showApproval: (d) => calls.push(['approval', d && d.id]), setStatus: (s) => calls.push(['status', s.state, s.detail, !!s.replay]) };
  const w = wireApprovals({ broker, dock }); return { broker, calls, w };
}

test('a question is shown on the island and the pill says it needs approval', () => {
  const { broker, calls } = rig(); broker.request({ tool: 'run_shell', command: 'ls' });
  assert.deepStrictEqual(calls, [['approval', 'q1'], ['status', 'waiting', 'Run this shell command?', false]]);
});

test('ALLOW: the question is cleared and the pill returns to "acting" for that tool, as a REPLAY (no duplicate log line)', async () => {
  const { broker, calls, w } = rig(); const p = broker.request({ tool: 'run_shell', command: 'ls' }); calls.length = 0;
  assert.strictEqual(w.answer({ id: 'q1', allow: true }), true);
  assert.deepStrictEqual((await p), { allow: true });
  assert.deepStrictEqual(calls, [['approval', null], ['status', 'acting', 'run_shell', true]]);
});

test('DENY: the question is cleared and the pill goes back to thinking', async () => {
  const { broker, calls, w } = rig(); const p = broker.request({ tool: 'write_file', path: '/x', bytes: 1, preview: 'a' }); calls.length = 0;
  w.answer({ id: 'q1', allow: false }); assert.strictEqual((await p).allow, false);
  assert.deepStrictEqual(calls, [['approval', null], ['status', 'thinking', '', true]]);
});

test('answer() ignores a wrong id, junk, and a non-boolean allow - and reports that it did nothing', () => {
  const { broker, w } = rig(); broker.request({ tool: 'run_shell', command: 'ls' });
  for (const bad of [{ id: 'nope', allow: true }, { id: 'q1', allow: 'yes' }, null, undefined, {}, 5]) assert.strictEqual(w.answer(bad), false, JSON.stringify(bad));
  assert.notStrictEqual(broker.pending, null);
});

test('STOP clears the question from the screen', async () => {
  const { broker, calls } = rig(); const p = broker.request({ tool: 'run_shell', command: 'ls' }); calls.length = 0;
  broker.cancelAll('Stopped by the user.'); assert.strictEqual((await p).allow, false);
  assert.deepStrictEqual(calls[0], ['approval', null]);
});

test('two queued questions: the second appears only after the first is answered', () => {
  const { broker, calls, w } = rig(); broker.request({ tool: 'run_shell', command: 'A' }); broker.request({ tool: 'run_shell', command: 'B' });
  assert.deepStrictEqual(calls.filter((c) => c[0] === 'approval'), [['approval', 'q1']]);
  w.answer({ id: 'q1', allow: true });
  assert.deepStrictEqual(calls.filter((c) => c[0] === 'approval').map((c) => c[1]), ['q1', null, 'q2']);
});
