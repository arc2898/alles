'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/workspace/workspace-model');

const at = (y, mo, d, h = 12, mi = 0) => new Date(y, mo, d, h, mi).getTime();
const NOW = at(2026, 10, 4, 15, 30);        // 4 Nov 2026, 15:30

test('history groups: today, yesterday, this week, older - newest first, empty groups left out', () => {
  const s = [{ id: 'a', updatedAt: at(2026, 10, 4, 9) }, { id: 'b', updatedAt: at(2026, 10, 3, 23) }, { id: 'c', updatedAt: at(2026, 10, 1) }, { id: 'd', updatedAt: at(2026, 9, 1) }];
  assert.deepStrictEqual(M.groupSessions(s, NOW).map((g) => [g.label, g.items.map((i) => i.id)]), [['Today', ['a']], ['Yesterday', ['b']], ['Earlier this week', ['c']], ['Older', ['d']]]);
  assert.deepStrictEqual(M.groupSessions([s[0]], NOW).map((g) => g.label), ['Today']);
  assert.deepStrictEqual(M.groupSessions([], NOW), []);
});

test('time labels: a clock time today, a date otherwise', () => {
  assert.strictEqual(M.timeLabel(at(2026, 10, 4, 9, 5), NOW), '09:05');
  assert.strictEqual(M.timeLabel(at(2026, 9, 28, 18, 40), NOW), '28 Oct, 18:40');
  assert.strictEqual(M.timeLabel(0, NOW), '');
});

test('coding steps read as short lines, whether the arguments are an object or the JSON text that History keeps', () => {
  assert.strictEqual(M.toolSummary('edit_file', { path: 'src/a.js' }), 'Edited src/a.js');
  assert.strictEqual(M.toolSummary('edit_file', '{"path":"src/b.js","old_text":"x"}'), 'Edited src/b.js');
  assert.strictEqual(M.toolSummary('run_command', { command: 'npm test' }), 'Ran: npm test');
  assert.strictEqual(M.toolSummary('run_command', { command: 'x'.repeat(200) }).length <= 85, true);
  assert.strictEqual(M.toolSummary('search', { text: 'TODO' }), 'Searched for "TODO"');
  assert.strictEqual(M.toolSummary('list_files', { path: '.' }), 'Listed the project');
  assert.strictEqual(M.toolSummary('read_file', 'not json'), 'Read a file');
  assert.strictEqual(M.toolSummary('mystery', {}), 'mystery');
});

test('transcript rows: who spoke, and tool steps carry a heading', () => {
  assert.deepStrictEqual(M.eventRow({ kind: 'user', text: 'hi' }), { role: 'you', who: 'You', text: 'hi' });
  assert.strictEqual(M.eventRow({ kind: 'assistant', text: 'yo', error: true }).error, true);
  const t = M.eventRow({ kind: 'tool', name: 'run_command', args: '{"command":"ls"}', text: 'exit_code: 0' });
  assert.deepStrictEqual([t.role, t.heading, t.text], ['tool', 'Ran: ls', 'exit_code: 0']);
  assert.strictEqual(M.eventRow({ kind: 'note', text: 'Stopped.' }).role, 'note');
});

test('diff lines get a style by their first character', () => {
  assert.deepStrictEqual(['@@ -1,2 +1,2 @@', '+a', '-b', ' c', ''].map(M.diffLineClass), ['hunk', 'add', 'del', 'ctx', 'ctx']);
});

test('autonomy: every level has a label and a sentence; an unknown level reads as "ask"', () => {
  for (const k of ['ask', 'edits', 'full']) { assert.ok(M.AUTONOMY[k].label); assert.ok(M.AUTONOMY[k].note.length > 20); }
  assert.strictEqual(M.autonomyNote('bogus'), M.AUTONOMY.ask.note);
  assert.match(M.autonomyNote('full'), /dangerous/);
});

test('the change list says new / changed with counts', () => {
  assert.strictEqual(M.changeLabel({ path: 'a.js', status: 'added', added: 3, removed: 0 }), 'a.js  (new, +3)');
  assert.strictEqual(M.changeLabel({ path: 'b.js', status: 'modified', added: 2, removed: 1 }), 'b.js  (changed, +2 -1)');
});

test('a question card: a command, a file change shown as a diff, a sensitive read', () => {
  const cmd = M.approvalView({ id: 'q1', kind: 'command', title: 'Run this shell command?', target: '/p', body: 'npm test', risks: [] });
  assert.deepStrictEqual([cmd.targetLabel, cmd.allowLabel, cmd.denyLabel, cmd.bodyIsDiff], ['In folder', 'Run it', "Don't", false]);
  const file = M.approvalView({ id: 'q2', kind: 'file', title: 'Write this file?', target: '/p/a.js', body: '@@ -1,1 +1,1 @@\n-a\n+b', risks: ['x'] });
  assert.strictEqual(file.bodyIsDiff, true); assert.strictEqual(file.allowLabel, 'Write it'); assert.deepStrictEqual(file.risks, ['x']);
  const read = M.approvalView({ id: 'q3', kind: 'read', title: 'Read a sensitive file?', target: '/p/.env' });
  assert.strictEqual(read.allowLabel, 'Allow'); assert.strictEqual(read.body, '');
  assert.strictEqual(M.approvalView(null).title, 'Allow this?');
});

test('voice conversation: push to talk, one turn, and hands-free keeps going', () => {
  const n = M.nextVoiceState;
  let s = 'idle';
  const run = (events, opts) => events.map((e) => (s = n(s, e, opts)));
  assert.deepStrictEqual(run(['mic', 'heard', 'text', 'reply'], { speakReplies: false }), ['listening', 'transcribing', 'thinking', 'idle']);
  s = 'idle';
  assert.deepStrictEqual(run(['mic', 'heard', 'text', 'reply', 'spoken'], { speakReplies: true }), ['listening', 'transcribing', 'thinking', 'speaking', 'idle']);
  s = 'idle';
  assert.deepStrictEqual(run(['mic', 'heard', 'text', 'reply', 'spoken', 'heard'], { speakReplies: true, handsFree: true }), ['listening', 'transcribing', 'thinking', 'speaking', 'listening', 'transcribing']);
});

test('voice conversation: nothing heard, an error, Stop, and the microphone pressed again all end up idle, from anywhere', () => {
  const n = M.nextVoiceState;
  assert.strictEqual(n('transcribing', 'none'), 'idle');
  assert.strictEqual(n('listening', 'none'), 'idle');
  assert.strictEqual(n('thinking', 'none'), 'idle');
  for (const st of ['listening', 'transcribing', 'thinking', 'speaking']) assert.strictEqual(n(st, 'stop', { handsFree: true }), 'idle', st);
  assert.strictEqual(n('speaking', 'mic'), 'idle', 'pressing the microphone interrupts ALLES');
  assert.strictEqual(n('listening', 'mic'), 'idle', 'pressing it again stops recording');
  assert.strictEqual(n('bogus', 'mic'), 'idle');
  assert.strictEqual(n('idle', 'reply'), 'idle');
});

test('speech summary: tells in plain words what works, and where the voice goes', () => {
  const ok = M.speechSummary({ tts: { chosen: 'espeak-ng' }, stt: { chosen: 'whisper-cli' } });
  assert.match(ok.talk, /speaks with espeak-ng/); assert.strictEqual(ok.talkOk, true);
  assert.match(ok.privacy, /stays on this computer/); assert.strictEqual(ok.listenOk, true);
  const http = M.speechSummary({ tts: { chosen: 'browser' }, stt: { chosen: 'http' } });
  assert.match(http.talk, /espeak-ng or speech-dispatcher/); assert.match(http.privacy, /sent over the internet/);
  const none = M.speechSummary({ tts: { chosen: null }, stt: { chosen: null, whisper: { problem: 'whisper.cpp (whisper-cli) is not installed' }, http: { problem: 'no provider chosen' } } });
  assert.match(none.talk, /not available/); assert.match(none.listen, /install whisper\.cpp/); assert.match(none.listen, /no provider chosen/); assert.strictEqual(none.listenOk, false);
  assert.match(M.speechSummary({ tts: { chosen: 'off' }, stt: { chosen: 'off' } }).listen, /switched off/);
  assert.deepStrictEqual(M.speechSummary(null), { talk: '', listen: '', listenOk: false, talkOk: false, privacy: '' });
});
