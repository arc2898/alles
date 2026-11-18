'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { ChatService, MAX_MESSAGES } = require('../src/main/chat');
const { HistoryStore } = require('../src/main/history');
const { tmpDir } = require('./helpers/tmp');

function rig(replies) {
  const history = new HistoryStore({ dir: path.join(tmpDir('alles-chat-'), 'h'), setTimer: () => null });
  const sent = []; let i = 0;
  const router = { chat: async (req) => {
    sent.push(JSON.parse(JSON.stringify(req.messages)));
    const r = replies[Math.min(i++, replies.length - 1)];
    if (r instanceof Error) throw r;
    if (typeof r === 'function') return r(req);
    return { response: { content: r, toolCalls: [] } };
  } };
  return { chat: new ChatService({ createRouter: () => router, history }), history, sent };
}

test('a conversation keeps its context, is saved in History, and offers no tools', async () => {
  const r = rig(['Hello Asha.', 'Your name is Asha.']);
  const a = await r.chat.send({ text: 'My name is Asha' });
  assert.strictEqual(a.ok, true); assert.strictEqual(a.reply, 'Hello Asha.');
  const b = await r.chat.send({ sessionId: a.sessionId, text: 'What is my name?' });
  assert.strictEqual(b.sessionId, a.sessionId);
  assert.deepStrictEqual(r.sent[1].map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.strictEqual(r.sent[1][2].content, 'Hello Asha.');
  const got = r.history.get(a.sessionId);
  assert.deepStrictEqual(got.events.map((e) => [e.kind, e.text]), [['user', 'My name is Asha'], ['assistant', 'Hello Asha.'], ['user', 'What is my name?'], ['assistant', 'Your name is Asha.']]);
  assert.strictEqual(got.meta.kind, 'chat');
  assert.match(r.sent[0][0].content, /you can only talk/);
});

test('a chat opened from History carries on where it stopped (even after a restart)', async () => {
  const r = rig(['one', 'two']);
  const a = await r.chat.send({ text: 'first question' });
  const fresh = new ChatService({ createRouter: () => ({ chat: async (req) => { r.sent.push(req.messages); return { response: { content: 'two' } }; } }), history: r.history });
  await fresh.send({ sessionId: a.sessionId, text: 'second question' });
  const last = r.sent[r.sent.length - 1];
  assert.deepStrictEqual(last.map((m) => m.content).slice(1), ['first question', 'one', 'second question']);
});

test('spoken: the model is told its answer will be read aloud; typed: it is not', async () => {
  const r = rig(['ok', 'ok']);
  await r.chat.send({ text: 'hi', spoken: true });
  await r.chat.send({ text: 'hi again' });
  assert.match(r.sent[0][0].content, /READ ALOUD/);
  assert.doesNotMatch(r.sent[1][0].content, /READ ALOUD/);
});

test('a failed request leaves no half conversation: the question is not kept without an answer', async () => {
  const r = rig([new Error('All providers failed (nvidia:429)'), 'fine']);
  const bad = await r.chat.send({ text: 'q1' });
  assert.strictEqual(bad.ok, false); assert.match(bad.error, /All providers failed/);
  const good = await r.chat.send({ sessionId: bad.sessionId, text: 'q2' });
  assert.deepStrictEqual(r.sent[1].map((m) => m.content).slice(1), ['q2'], 'q1 was not sent again without an answer');
  assert.strictEqual(good.ok, true);
});

test('empty, too long, and an empty answer are plain errors', async () => {
  const r = rig(['']);
  assert.match((await r.chat.send({ text: '  ' })).error, /Write or say something/);
  assert.match((await r.chat.send({ text: 'x'.repeat(9000) })).error, /limit is 8000/);
  assert.match((await r.chat.send({ text: 'hi' })).error, /answered with nothing/);
  assert.strictEqual(r.history.list().length, 1);
});

test('one answer at a time; Stop drops the request and says so', async () => {
  let release;
  const slow = (req) => new Promise((res, rej) => { req.signal.addEventListener('abort', () => rej(new Error('Stopped by the user'))); release = () => res({ response: { content: 'late' } }); });
  const r = rig([slow]);
  const p = r.chat.send({ text: 'long one' });
  await new Promise((x) => setImmediate(x));
  assert.match((await r.chat.send({ text: 'second' })).error, /still answering/);
  assert.strictEqual(r.chat.stop(), true);
  const out = await p;
  assert.deepStrictEqual([out.ok, out.error], [false, 'Stopped.']);
  assert.strictEqual(r.chat.stop(), false);
  assert.strictEqual(release !== undefined, true);
});

test('a very long chat never grows without bound and always starts with the person', async () => {
  const r = rig(['a']);
  let id = null;
  for (let i = 0; i < MAX_MESSAGES; i++) { const o = await r.chat.send({ sessionId: id, text: `m${i}` }); id = o.sessionId; }
  const sent = r.sent[r.sent.length - 1];
  assert.ok(sent.length <= MAX_MESSAGES + 1);
  assert.strictEqual(sent[1].role, 'user');
});
