'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/overlay/pill-model');

const at = (h, m) => new Date(2026, 8, 19, h, m);

test('clock 24h: zero-padded, midnight and noon', () => {
  assert.strictEqual(M.formatClock(at(0, 0)), '00:00');
  assert.strictEqual(M.formatClock(at(9, 5)), '09:05');
  assert.strictEqual(M.formatClock(at(12, 0)), '12:00');
  assert.strictEqual(M.formatClock(at(23, 59)), '23:59');
});

test('clock 12h: midnight is 12 AM, noon is 12 PM, 13:00 is 1 PM', () => {
  assert.strictEqual(M.formatClock(at(0, 7), true), '12:07 AM');
  assert.strictEqual(M.formatClock(at(12, 0), true), '12:00 PM');
  assert.strictEqual(M.formatClock(at(13, 30), true), '1:30 PM');
  assert.strictEqual(M.formatClock(at(11, 59), true), '11:59 AM');
});

test('acting maps tool names to human verbs; unknown tools degrade gracefully', () => {
  assert.strictEqual(M.viewFor({ state: 'acting', detail: 'mouse_click' }).label, 'Clicking');
  assert.strictEqual(M.viewFor({ state: 'acting', detail: 'screenshot' }).label, 'Looking at the screen');
  assert.strictEqual(M.viewFor({ state: 'acting', detail: 'mystery_tool' }).label, 'Using mystery_tool');
  assert.strictEqual(M.viewFor({ state: 'acting' }).label, 'Working…');
});

test('every tool the agent can call has a verb (no raw snake_case shown to the user)', () => {
  const { TOOL_SCHEMAS } = require('../src/main/tools');
  for (const t of TOOL_SCHEMAS) assert.ok(M.TOOL_VERBS[t.function.name], `no verb for ${t.function.name}`);
});

test('thinking shows the step number when given', () => {
  assert.strictEqual(M.viewFor({ state: 'thinking', detail: 'Step 3' }).label, 'Thinking… (step 3)');
  assert.strictEqual(M.viewFor({ state: 'thinking' }).label, 'Thinking…');
});

test('only done/error/waiting expand, and only when there is text to show', () => {
  assert.strictEqual(M.viewFor({ state: 'done', detail: 'Finished the report.' }).expanded, true);
  assert.strictEqual(M.viewFor({ state: 'error', detail: 'All providers failed' }).expanded, true);
  assert.strictEqual(M.viewFor({ state: 'waiting', detail: 'Run: ls' }).expanded, true);
  assert.strictEqual(M.viewFor({ state: 'done', detail: '' }).expanded, false, 'nothing to show -> stay compact');
  for (const s of ['idle', 'thinking', 'acting', 'stopped']) {
    assert.strictEqual(M.viewFor({ state: s, detail: 'x' }).expanded, false, s);
  }
});

test('working states never leak their detail into the reply area', () => {
  assert.strictEqual(M.viewFor({ state: 'acting', detail: 'run_shell' }).reply, '');
  assert.strictEqual(M.viewFor({ state: 'thinking', detail: 'Step 2' }).reply, '');
});

test('unknown or missing state falls back to idle instead of throwing', () => {
  assert.strictEqual(M.viewFor({ state: 'exploding' }).state, 'idle');
  assert.strictEqual(M.viewFor(null).state, 'idle');
  assert.strictEqual(M.viewFor(undefined).label, 'Idle');
});

test('terminal states linger then relax; idle/working states do not schedule a relax', () => {
  assert.ok(M.viewFor({ state: 'done', detail: 'x' }).lingerMs > 0);
  assert.ok(M.viewFor({ state: 'error', detail: 'x' }).lingerMs > M.viewFor({ state: 'done', detail: 'x' }).lingerMs, 'errors stay longer');
  assert.strictEqual(M.viewFor({ state: 'acting', detail: 'wait' }).lingerMs, 0);
  assert.strictEqual(M.viewFor({ state: 'idle' }).lingerMs, 0);
});

test('truncateReply: short text untouched, whitespace collapsed', () => {
  assert.strictEqual(M.truncateReply('  hello \n\n  world  '), 'hello world');
  assert.strictEqual(M.truncateReply(null), '');
  assert.strictEqual(M.truncateReply(undefined), '');
});

test('truncateReply: long text cut at a word boundary with an ellipsis, within the limit', () => {
  const long = 'word '.repeat(200);
  const out = M.truncateReply(long, 50);
  assert.ok(out.endsWith('…'));
  assert.ok(out.length <= 51, `length ${out.length}`);
  assert.ok(!/\swor…$/.test(out) || out.endsWith('word…'), 'should not end mid-word');
});

test('truncateReply: a single giant token with no spaces still gets cut', () => {
  const out = M.truncateReply('x'.repeat(1000), 40);
  assert.strictEqual(out.length, 41);
  assert.ok(out.endsWith('…'));
});

test('every state has a CSS accent variable defined in pill.html', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/overlay/pill.html'), 'utf8');
  for (const s of M.STATES) assert.ok(html.includes(`--c-${s}:`), `pill.html is missing --c-${s}`);
});

test('the pill preload exposes its API on window.pill through contextBridge', () => {
  // The whitelist-vs-handlers contract is checked in bridge.test.js.
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/overlay/preload.cjs'), 'utf8');
  assert.match(src, /contextBridge\.exposeInMainWorld\('pill'/);
});

test('activity log: newest last, capped, uses friendly verbs, and is immutable', () => {
  let log = [];
  const before = log;
  log = M.pushActivity(log, 'screenshot');
  assert.deepStrictEqual(log, [{ text: 'Looking at the screen', error: false }]);
  assert.strictEqual(before.length, 0, 'input array untouched');
  for (const t of ['mouse_click', 'type_text', 'press_keys', 'run_shell', 'wait']) log = M.pushActivity(log, t);
  assert.strictEqual(log.length, M.MAX_LOG);
  assert.strictEqual(log.at(-1).text, 'Waiting', 'newest is last');
  assert.ok(!log.some((a) => a.text === 'Looking at the screen'), 'oldest dropped');
});

test('activity log: an unknown tool degrades gracefully and errors are flagged', () => {
  assert.strictEqual(M.pushActivity([], 'mystery').at(0).text, 'Using mystery');
  assert.strictEqual(M.pushActivity([], 'run_shell', { error: true }).at(0).error, true);
});

// ---------------------------------------------------------------- prompt + approval view logic

test('busy states are exactly thinking, acting and waiting', () => {
  for (const s of ['thinking', 'acting', 'waiting']) assert.strictEqual(M.isBusyState(s), true, s);
  for (const s of ['idle', 'done', 'error', 'stopped', 'nonsense', undefined, null]) assert.strictEqual(M.isBusyState(s), false, String(s));
});

test('the prompt shows ONLY in the island, when nothing is running and no question is open', () => {
  const vis = (o) => M.promptView(o).visible;
  assert.strictEqual(vis({ phase: 'island', state: 'idle', approving: false }), true);
  assert.strictEqual(vis({ phase: 'island', state: 'done', approving: false }), true, 'a follow-up after a finished task');
  assert.strictEqual(vis({ phase: 'island', state: 'error', approving: false }), true, 'retry after an error');
  for (const phase of ['hidden', 'peek']) assert.strictEqual(vis({ phase, state: 'idle', approving: false }), false, phase);
  for (const state of ['thinking', 'acting', 'waiting']) assert.strictEqual(vis({ phase: 'island', state, approving: false }), false, state);
  assert.strictEqual(vis({ phase: 'island', state: 'idle', approving: true }), false, 'never while a question is open');
});

test('the prompt placeholder invites a follow-up after a finished task', () => {
  assert.match(M.promptView({ phase: 'island', state: 'idle' }).placeholder, /Ask ALLES/);
  assert.match(M.promptView({ phase: 'island', state: 'done' }).placeholder, /follow-up/);
});

test('approvalView: passes a full command through UNTOUCHED (the page must show all of it)', () => {
  const cmd = 'echo start && ' + 'x'.repeat(3000) + ' && rm -rf ~/precious';
  const v = M.approvalView({ id: 'q1', kind: 'command', title: 'Run this shell command?', target: '/home/u', body: cmd, risks: ['deletes files (rm -r / -f)'] });
  assert.strictEqual(v.body, cmd); assert.strictEqual(v.id, 'q1'); assert.deepStrictEqual(v.risks, ['deletes files (rm -r / -f)']);
});

test('approvalView: a clipped FILE preview says it was clipped, with the real numbers', () => {
  const v = M.approvalView({ id: 'q', kind: 'file', title: 't', body: 'x'.repeat(1000), truncated: true, total: 5000, bytes: 5000 });
  assert.match(v.note, /5000 bytes\. Showing the first 1000 of 5000 characters\./);
  assert.strictEqual(M.approvalView({ id: 'q', kind: 'file', body: 'hi', bytes: 2 }).note, '2 bytes');
});

test('approvalView: junk input never throws, and yields an unanswerable (id-less) question', () => {
  for (const junk of [null, undefined, 5, 'str', [], {}, { id: 5, body: 5, risks: 'x' }, { risks: [1, null, {}, 'ok', ''] }]) {
    const v = M.approvalView(junk);
    assert.strictEqual(typeof v.title, 'string'); assert.strictEqual(typeof v.body, 'string'); assert.ok(Array.isArray(v.risks));
  }
  assert.strictEqual(M.approvalView(null).id, '');
  assert.deepStrictEqual(M.approvalView({ risks: [1, null, {}, 'ok', ''] }).risks, ['ok']);
});

test('approvalView: at most 8 risk notes', () => {
  assert.strictEqual(M.approvalView({ id: 'q', risks: Array.from({ length: 20 }, (_, i) => 'r' + i) }).risks.length, 8);
});

test('the Allow button stays disabled briefly, but not so long that it is annoying', () => {
  assert.ok(M.ARM_MS >= 300 && M.ARM_MS <= 1000, `ARM_MS = ${M.ARM_MS}`);
});

// ---------------------------------------------------------------- scroll-to-end rule for Allow

test('allowState: the delay alone gates a short question; nothing else is required', () => {
  assert.deepStrictEqual(M.allowState({ armed: false, overflow: false, atEnd: true }), { enabled: false, hint: '' });
  assert.deepStrictEqual(M.allowState({ armed: true, overflow: false, atEnd: true }), { enabled: true, hint: '' });
  assert.strictEqual(M.allowState({ armed: true, overflow: false, atEnd: false }).enabled, true, 'not overflowing: "atEnd" is irrelevant');
});

test('allowState: a LONG question needs BOTH the delay AND a scroll to the end', () => {
  assert.strictEqual(M.allowState({ armed: true, overflow: true, atEnd: false }).enabled, false, 'armed but the tail is unseen');
  assert.strictEqual(M.allowState({ armed: false, overflow: true, atEnd: true }).enabled, false, 'scrolled but too early');
  assert.strictEqual(M.allowState({ armed: true, overflow: true, atEnd: true }).enabled, true);
});

test('allowState: tells the user WHY it is locked, from the moment the text is known to overflow', () => {
  assert.match(M.allowState({ armed: false, overflow: true, atEnd: false }).hint, /Scroll to the end/);
  assert.match(M.allowState({ armed: true, overflow: true, atEnd: false }).hint, /Allow unlocks/);
  assert.strictEqual(M.allowState({ armed: true, overflow: true, atEnd: true }).hint, '', 'no nagging once read');
});

test('allowState: junk input can only ever DISABLE Allow, never enable it', () => {
  for (const junk of [{}, { armed: 'yes' }, { armed: 1, overflow: true }, { overflow: true, atEnd: true }, { armed: undefined, overflow: false, atEnd: true }]) {
    const r = M.allowState(junk);
    assert.strictEqual(typeof r.enabled, 'boolean');
    if (!junk.armed) assert.strictEqual(r.enabled, false, JSON.stringify(junk));
  }
  assert.strictEqual(M.allowState({ armed: 'yes', overflow: false }).enabled, true, 'a truthy armed still counts (the page only ever passes a boolean)');
});

test('overflows / atScrollEnd: exact edges, and a few pixels of slack for sub-pixel scrolling', () => {
  assert.strictEqual(M.overflows({ clientHeight: 190, scrollHeight: 190 }), false);
  assert.strictEqual(M.overflows({ clientHeight: 190, scrollHeight: 191 }), false, '1px of rounding is not overflow');
  assert.strictEqual(M.overflows({ clientHeight: 190, scrollHeight: 192 }), true);
  assert.strictEqual(M.atScrollEnd({ scrollTop: 0, clientHeight: 190, scrollHeight: 400 }), false);
  assert.strictEqual(M.atScrollEnd({ scrollTop: 209, clientHeight: 190, scrollHeight: 400 }), true, 'exactly at the end');
  assert.strictEqual(M.atScrollEnd({ scrollTop: 206, clientHeight: 190, scrollHeight: 400 }), true, 'within the 4px slack');
  assert.strictEqual(M.atScrollEnd({ scrollTop: 200, clientHeight: 190, scrollHeight: 400 }), false, '10px short is NOT the end');
});

// ---------------------------------------------------------------- engagement: when must the island stay open under the person?

test('isEngaged: the box has the keyboard in an open island -> yes', () => {
  assert.strictEqual(M.isEngaged({ phase: 'island', prompting: true, windowFocused: true, promptActive: true, hasText: false }), true);
});

test('isEngaged: THE REAL BUG - the box is still the page\'s active element but the window lost the keyboard (the person clicked another app) -> NOT engaged', () => {
  assert.strictEqual(M.isEngaged({ phase: 'island', prompting: true, windowFocused: false, promptActive: true, hasText: false }), false);
});

test('isEngaged: a draft left in the box keeps the island open whoever has the keyboard', () => {
  assert.strictEqual(M.isEngaged({ phase: 'island', prompting: true, windowFocused: false, promptActive: false, hasText: true }), true);
  assert.strictEqual(M.isEngaged({ phase: 'island', prompting: true, windowFocused: true, promptActive: false, hasText: true }), true);
});

test('isEngaged: nothing counts unless the island is open AND the box is on screen', () => {
  for (const phase of ['hidden', 'peek']) assert.strictEqual(M.isEngaged({ phase, prompting: true, windowFocused: true, promptActive: true, hasText: true }), false, phase);
  assert.strictEqual(M.isEngaged({ phase: 'island', prompting: false, windowFocused: true, promptActive: true, hasText: true }), false, 'a hidden box (agent working, question open)');
});

test('isEngaged: no focus, no text, no box focused -> not engaged; junk input is just "no"', () => {
  assert.strictEqual(M.isEngaged({ phase: 'island', prompting: true, windowFocused: true, promptActive: false, hasText: false }), false);
  for (const junk of [undefined, null, {}, 5]) assert.strictEqual(M.isEngaged(junk || {}), false);
});
