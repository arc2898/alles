'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startFakeModel, protocolProblems } = require('../scripts/gnome-e2e/fake-model');

// The scripted AI that the real-desktop tests talk to. It is the judge in those tests: it answers a request that breaks the rules of the
// chat format with a 400, as the fussiest real providers do. A judge that lets things slide would make every one of those tests pass for
// nothing, so what it catches is pinned here.

const sys = { role: 'system', content: 'You are ALLES.' };
const user = (c = 'do it') => ({ role: 'user', content: c });
const call = (id, name = 'wait', args = '{}') => ({ id, type: 'function', function: { name, arguments: args } });
const asst = (content, calls) => ({ role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) });
const tool = (id, content = 'ok') => ({ role: 'tool', tool_call_id: id, content });
const has = (messages, re) => protocolProblems(messages).some((p) => re.test(p));

test('a well-formed conversation has no problems, with one call, several calls, a screenshot and a text-only turn', () => {
  assert.deepStrictEqual(protocolProblems([sys, user()]), []);
  assert.deepStrictEqual(protocolProblems([sys, user(), asst(null, [call('a')]), tool('a')]), []);
  assert.deepStrictEqual(protocolProblems([sys, user(), asst('', [call('a'), call('b')]), tool('b'), tool('a'), user([{ type: 'text', text: 'Current screen:' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }])]), [], 'answers in any order');
  assert.deepStrictEqual(protocolProblems([sys, user(), asst('partial words'), user('carry on')]), []);
});

test('an assistant message that says nothing and asks for nothing is a problem (content null, empty, blank, or an empty list)', () => {
  for (const content of [null, '', '  \n', [], undefined]) assert.ok(has([sys, user(), asst(content)], /says nothing and asks for nothing/), JSON.stringify(content));
});

test('tool_calls that are an empty list, or not a list, are a problem', () => {
  assert.ok(has([sys, user(), { role: 'assistant', content: 'x', tool_calls: [] }], /not a non-empty list/));
  assert.ok(has([sys, user(), { role: 'assistant', content: 'x', tool_calls: 'nope' }], /not a non-empty list/));
});

test('a tool call needs an id of its own, the type "function", a name, and arguments that are a string holding a JSON object', () => {
  const noId = call('a'); delete noId.id;
  assert.ok(has([sys, user(), asst(null, [noId]), tool('a')], /has no id/));
  assert.ok(has([sys, user(), asst(null, [call('a'), call('a')]), tool('a'), tool('a')], /repeats the id a/));
  assert.ok(has([sys, user(), asst(null, [{ ...call('a'), type: undefined }]), tool('a')], /not "function"/));
  assert.ok(has([sys, user(), asst(null, [call('a', '')]), tool('a')], /no function name/));
  for (const bad of ['{oops', '', '[1]', 'null', '5', '"x"', {}, null]) {
    assert.ok(has([sys, user(), asst(null, [call('a', 'wait', bad)]), tool('a')], /arguments that are not a string holding a JSON object/), JSON.stringify(bad));
  }
});

test('every tool call is answered, once, by its id, right behind the message that asked', () => {
  assert.ok(has([sys, user(), asst(null, [call('a'), call('b')]), tool('a')], /were never answered/));
  assert.ok(has([sys, user(), asst(null, [call('a')]), tool('zzz')], /answers "zzz"/));
  assert.ok(has([sys, user(), asst(null, [call('a')]), tool('a'), tool('a')], /answers "a"/), 'the same call answered twice');
  assert.ok(has([sys, user(), asst(null, [call('a')]), tool('a'), tool('b')], /answers "b"/));
  assert.ok(has([sys, user(), asst(null, [call('a'), call('b')]), tool('a'), user('hm'), tool('b')], /before the tool calls b were answered/), 'something else in between');
  assert.ok(has([sys, user(), tool('a')], /answers "a"/), 'an answer with no call');
});

test('a tool answer has to be text', () => {
  assert.ok(has([sys, user(), asst(null, [call('a')]), { role: 'tool', tool_call_id: 'a' }], /not text/));
  assert.ok(has([sys, user(), asst(null, [call('a')]), { role: 'tool', tool_call_id: 'a', content: 5 }], /not text/));
});

test('two user messages in a row, and two assistant messages in a row, are problems', () => {
  assert.ok(has([sys, user(), user('again')], /right after another user message/));
  assert.ok(has([sys, user(), asst('a'), asst('b')], /right after another assistant message/));
  assert.ok(!has([sys, user(), asst(null, [call('a')]), tool('a'), user('screen')], /./), 'a user message behind a tool answer is fine');
});

test('an empty user message is a problem', () => {
  assert.ok(has([sys, user('')], /is empty/));
});

test('the conversation must end with something to answer', () => {
  assert.ok(has([sys, user(), asst('done')], /nothing to answer/));
  assert.ok(has([], /no messages/));
});

// ---------------------------------------------------------------- over HTTP
const post = async (m, messages) => {
  const res = await fetch(`${m.url}/p/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer k' }, body: JSON.stringify({ model: 'x', messages }) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const withModel = async (script, opts, fn) => { const m = await startFakeModel(script, opts); try { return await fn(m); } finally { await m.close(); } };

test('STRICT model: a request that breaks the rules gets a 400 that says which rule, and is recorded; the script is not asked', async () => {
  let asked = 0;
  await withModel(async () => { asked++; return { text: 'hi' }; }, undefined, async (m) => {
    const r = await post(m, [sys, user(), asst(''), user('x')]);
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error.message, /^Invalid request: .*says nothing and asks for nothing/);
    assert.strictEqual(m.violations.length, 1);
    assert.deepStrictEqual([m.violations[0].path, m.violations[0].n], ['/p/v1', 1]);
    assert.strictEqual(asked, 0);
    const fine = await post(m, [sys, user()]);
    assert.strictEqual(fine.status, 200);
    assert.strictEqual(asked, 1);
    m.reset();
    assert.deepStrictEqual(m.violations, []);
  });
});

test('NOT strict: the same request is recorded as a violation but answered', async () => {
  await withModel(async () => ({ text: 'hi' }), { strict: false }, async (m) => {
    const r = await post(m, [sys, user(), asst(''), user('x')]);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(m.violations.length, 1);
  });
});

test('REPLIES: calls can have no id, a chosen id, arguments as an object, or arguments that are a broken string', async () => {
  await withModel(async () => ({ calls: [{ name: 'a', args: { x: 1 }, id: null }, { name: 'b', args: { x: 2 }, id: 'dup' }, { name: 'c', args: { x: 3 }, id: 'dup', argsAsObject: true }, { name: 'd', args: '{"x":' }] }), undefined, async (m) => {
    const { body } = await post(m, [sys, user()]);
    const c = body.choices[0].message.tool_calls;
    assert.ok(!('id' in c[0]));
    assert.deepStrictEqual([c[1].id, c[2].id], ['dup', 'dup']);
    assert.strictEqual(c[1].function.arguments, '{"x":2}');
    assert.deepStrictEqual(c[2].function.arguments, { x: 3 });
    assert.strictEqual(c[3].function.arguments, '{"x":');
    assert.strictEqual(body.choices[0].finish_reason, 'tool_calls');
  });
});

test('REPLIES: the finish reason can be chosen, and a whole message can be sent as it is', async () => {
  await withModel(async (ctx) => (ctx.n === 1
    ? { text: '', finishReason: 'length' }
    : { message: { role: 'assistant', content: [{ type: 'text', text: 'parts' }], refusal: null, reasoning_content: 'hm' }, finishReason: 'stop' }), undefined, async (m) => {
    const a = (await post(m, [sys, user()])).body.choices[0];
    assert.deepStrictEqual([a.finish_reason, a.message.content], ['length', '']);
    const b = (await post(m, [sys, user()])).body.choices[0];
    assert.deepStrictEqual(b.message.content, [{ type: 'text', text: 'parts' }]);
    assert.strictEqual(b.message.reasoning_content, 'hm');
  });
});
