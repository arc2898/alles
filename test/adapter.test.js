'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { chatCompletion } = require('../src/main/providers/openai-compat');
const { ProviderRouter } = require('../src/main/providers/router');

// Close every mock server after each test, pass OR fail (a failing test used to skip its own close() and hang the run).
const opened = [];
test.afterEach(async () => { for (const m of opened.splice(0)) await m.close(); });

function startMock(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const rec = { url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null };
        seen.push(rec);
        handler(rec, res);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const h = { base: `http://127.0.0.1:${server.address().port}/v1`, seen, close: () => { server.closeAllConnections?.(); return new Promise((r) => server.close(() => r())); } };
      opened.push(h); resolve(h);
    });
  });
}
const json = (res, status, obj, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(obj));
};
const ok = (content, extra = {}) => ({ choices: [{ message: { content, ...extra } }], usage: { total_tokens: 5 } });

test('sends correct URL, Bearer auth, model and messages', async () => {
  const m = await startMock((_r, res) => json(res, 200, ok('hello')));
  const out = await chatCompletion(
    { messages: [{ role: 'user', content: 'hi' }] },
    { apiKey: 'nvapi-abc', model: 'test-model', baseUrl: m.base + '/' }, // trailing slash tolerated
  );
  assert.strictEqual(out.content, 'hello');
  assert.strictEqual(m.seen[0].url, '/v1/chat/completions');
  assert.strictEqual(m.seen[0].auth, 'Bearer nvapi-abc');
  assert.strictEqual(m.seen[0].body.model, 'test-model');
  await m.close();
});

test('parses tool calls and decodes JSON arguments', async () => {
  const m = await startMock((_r, res) => json(res, 200, ok('', {
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'mouse_click', arguments: '{"x":10,"y":20}' } }],
  })));
  const out = await chatCompletion({ messages: [], tools: [{ type: 'function', function: { name: 'mouse_click' } }] }, { apiKey: 'k', model: 'm', baseUrl: m.base });
  assert.deepStrictEqual(out.toolCalls, [{ id: 'c1', name: 'mouse_click', arguments: { x: 10, y: 20 } }]);
  assert.strictEqual(m.seen[0].body.tool_choice, 'auto');
  await m.close();
});

test('malformed tool-call JSON is surfaced, not thrown', async () => {
  const m = await startMock((_r, res) => json(res, 200, ok('', {
    tool_calls: [{ id: 'c1', function: { name: 'x', arguments: '{oops' } }],
  })));
  const out = await chatCompletion({ messages: [] }, { apiKey: 'k', model: 'm', baseUrl: m.base });
  assert.strictEqual(out.toolCalls[0].arguments.__parseError, '{oops');
  await m.close();
});

// ---------------------------------------------------------------- odd replies from real providers
// Each of these used to be able to break the NEXT request (and the whole task with it), or to crash the reader outright.

const readOne = async (message, extra = {}) => {
  const m = await startMock((_r, res) => json(res, 200, { choices: [{ message, ...extra }] }));
  const out = await chatCompletion({ messages: [] }, { apiKey: 'k', model: 'm', baseUrl: m.base });
  await m.close();
  return out;
};
const fnCall = (name, args, more = {}) => ({ type: 'function', function: { name, arguments: args }, ...more });

test('content: a list of parts becomes its text; anything that is not text becomes an empty string', async () => {
  assert.strictEqual((await readOne({ content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'there' }] })).content, 'Hello there');
  assert.strictEqual((await readOne({ content: ['a', { text: 'b' }, { type: 'image_url', text: 'no' }, null, 7] })).content, 'ab');
  for (const odd of [null, undefined, 5, {}, true]) assert.strictEqual((await readOne({ content: odd })).content, '', JSON.stringify(odd));
});

test('a refusal with no content is shown as the content; a refusal next to real content is not', async () => {
  assert.strictEqual((await readOne({ content: null, refusal: 'I cannot help with that.' })).content, 'I cannot help with that.');
  assert.strictEqual((await readOne({ content: 'Done.', refusal: 'ignored' })).content, 'Done.');
});

test('the finish reason is reported, and is an empty string when the provider sent none', async () => {
  assert.strictEqual((await readOne({ content: 'x' }, { finish_reason: 'length' })).finishReason, 'length');
  assert.strictEqual((await readOne({ content: 'x' }, { finish_reason: 'stop' })).finishReason, 'stop');
  assert.strictEqual((await readOne({ content: 'x' })).finishReason, '');
  assert.strictEqual((await readOne({ content: 'x' }, { finish_reason: 5 })).finishReason, '');
});

test('a tool call with no id (or an empty one) is given call_1, call_2 ..., and what goes back to the provider carries the same ids', async () => {
  const out = await readOne({ content: null, tool_calls: [fnCall('a', '{}'), fnCall('b', '{}', { id: '' }), fnCall('c', '{}', { id: 'real' }), fnCall('d', '{}', { id: 7 })] });
  assert.deepStrictEqual(out.toolCalls.map((c) => c.id), ['call_1', 'call_2', 'real', 'call_3']);
  assert.deepStrictEqual(out.raw.tool_calls.map((c) => c.id), ['call_1', 'call_2', 'real', 'call_3']);
});

test('ids already used EARLIER in the conversation are not handed out again: a call with no id gets a free number, a clashing id is suffixed', async () => {
  // (some servers number their calls from 0 in every reply, or send an empty id every time: two calls of one task must not share an id)
  const m = await startMock((_r, res) => json(res, 200, { choices: [{ message: { content: null, tool_calls: [fnCall('a', '{}'), fnCall('b', '{}', { id: 'call_0' }), fnCall('c', '{}', { id: 'taken' }), fnCall('d', '{}', { id: 'taken' })] } }] }));
  const call = (id) => ({ id, type: 'function', function: { name: 'x', arguments: '{}' } });
  const history = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: null, tool_calls: [call('call_1'), call('taken')] },
    { role: 'tool', tool_call_id: 'call_1', content: 'ok' }, { role: 'tool', tool_call_id: 'taken', content: 'ok' },
    null, 5, 'junk', { role: 'assistant', content: 'x', tool_calls: 'nope' }, { role: 'tool', tool_call_id: 7, content: 'x' },   // whatever else a history may hold
  ];
  const out = await chatCompletion({ messages: history }, { apiKey: 'k', model: 'm', baseUrl: m.base });
  assert.deepStrictEqual(out.toolCalls.map((c) => c.id), ['call_2', 'call_0', 'taken-2', 'taken-3']);
  assert.deepStrictEqual(out.raw.tool_calls.map((c) => c.id), ['call_2', 'call_0', 'taken-2', 'taken-3']);
});

test('the same id twice is made unique, in what the tools answer to and in what goes back', async () => {
  const out = await readOne({ content: null, tool_calls: [fnCall('a', '{}', { id: 'dup' }), fnCall('b', '{}', { id: 'dup' }), fnCall('c', '{}', { id: 'dup' })] });
  assert.deepStrictEqual(out.toolCalls.map((c) => c.id), ['dup', 'dup-2', 'dup-3']);
  assert.deepStrictEqual(out.raw.tool_calls.map((c) => c.id), ['dup', 'dup-2', 'dup-3']);
});

test('entries that are not tool calls at all are dropped; the real ones are kept and numbered from what is kept', async () => {
  const out = await readOne({ content: null, tool_calls: [null, 5, 'x', [], {}, { function: null }, { function: 'x' }, { function: {} }, { function: { name: '' } }, { function: { name: 7 } }, fnCall('real', '{}')] });
  assert.deepStrictEqual(out.toolCalls, [{ id: 'call_1', name: 'real', arguments: {} }]);
  assert.strictEqual(out.raw.tool_calls.length, 1);
});

test('no tool calls: an empty list, a null, or something that is not a list never crashes, and nothing is sent back as tool_calls', async () => {
  for (const odd of [[], null, undefined, {}, 'x', 5]) {
    const out = await readOne({ content: 'hi', tool_calls: odd });
    assert.deepStrictEqual(out.toolCalls, [], JSON.stringify(odd));
    assert.ok(!('tool_calls' in out.raw), `an empty tool_calls would be refused by a strict provider (${JSON.stringify(odd)})`);
  }
});

test('arguments: a string of JSON is read, and sent back exactly as the provider wrote it', async () => {
  const text = '{ "x": 10,  "y": [1, 2] }';
  const out = await readOne({ content: null, tool_calls: [fnCall('a', text)] });
  assert.deepStrictEqual(out.toolCalls[0].arguments, { x: 10, y: [1, 2] });
  assert.strictEqual(out.raw.tool_calls[0].function.arguments, text);
});

test('arguments: an object (some servers send one) is read, and goes back as a JSON string', async () => {
  const out = await readOne({ content: null, tool_calls: [fnCall('a', { x: 1 })] });
  assert.deepStrictEqual(out.toolCalls[0].arguments, { x: 1 });
  assert.strictEqual(out.raw.tool_calls[0].function.arguments, '{"x":1}');
});

test('arguments: JSON inside a JSON string is read too', async () => {
  const out = await readOne({ content: null, tool_calls: [fnCall('a', JSON.stringify('{"x":2}'))] });
  assert.deepStrictEqual(out.toolCalls[0].arguments, { x: 2 });
  assert.strictEqual(out.raw.tool_calls[0].function.arguments, '{"x":2}');
});

test('arguments: none, empty or blank mean "no arguments"', async () => {
  for (const none of [undefined, null, '', '   ']) {
    const out = await readOne({ content: null, tool_calls: [{ type: 'function', function: { name: 'screenshot', arguments: none } }] });
    assert.deepStrictEqual(out.toolCalls[0].arguments, {}, JSON.stringify(none));
    assert.strictEqual(out.raw.tool_calls[0].function.arguments, '{}');
  }
});

test('arguments that are not an object, or not JSON, are handed to the tools as a parse error - and go back as {} so the next request is valid', async () => {
  for (const bad of ['{oops', '{"x":', '[1,2]', 'null', '5', '"just words"', 7, true, [1]]) {
    const out = await readOne({ content: null, tool_calls: [fnCall('a', bad)] });
    assert.strictEqual(typeof out.toolCalls[0].arguments.__parseError, 'string', JSON.stringify(bad));
    assert.strictEqual(out.toolCalls[0].arguments.__parseError, typeof bad === 'string' ? bad : String(bad), JSON.stringify(bad));
    assert.strictEqual(out.raw.tool_calls[0].function.arguments, '{}', `a provider that parses its history would refuse ${JSON.stringify(bad)}`);
  }
});

test('whatever else the provider sent with a call is kept exactly (Gemini 3 thought signature), and a missing type becomes "function"', async () => {
  const extra = { google: { thought_signature: 'abc123==' } };
  const out = await readOne({ content: null, reasoning_content: 'thinking...', tool_calls: [{ id: 'g1', function: { name: 'a', arguments: '{}', future: 1 }, extra_content: extra }] });
  assert.deepStrictEqual(out.raw.tool_calls[0], { id: 'g1', type: 'function', function: { name: 'a', arguments: '{}', future: 1 }, extra_content: extra });
  assert.strictEqual(out.raw.reasoning_content, 'thinking...', 'the rest of the message is untouched');
});

test('max_tokens is sent when asked for, and not at all otherwise', async () => {
  const m = await startMock((_r, res) => json(res, 200, ok('x')));
  await chatCompletion({ messages: [], maxTokens: 4321 }, { apiKey: 'k', model: 'm', baseUrl: m.base });
  await chatCompletion({ messages: [] }, { apiKey: 'k', model: 'm', baseUrl: m.base });
  assert.strictEqual(m.seen[0].body.max_tokens, 4321);
  assert.ok(!('max_tokens' in m.seen[1].body));
  await m.close();
});

test('429 carries status and Retry-After', async () => {
  const m = await startMock((_r, res) => json(res, 429, { error: 'slow down' }, { 'Retry-After': '7' }));
  await assert.rejects(
    () => chatCompletion({ messages: [] }, { apiKey: 'k', model: 'm', baseUrl: m.base }),
    (e) => e.status === 429 && e.retryAfterMs === 7000,
  );
  await m.close();
});

test('unreachable host becomes a retryable error with no status', async () => {
  await assert.rejects(
    () => chatCompletion({ messages: [] }, { apiKey: 'k', model: 'm', baseUrl: 'http://127.0.0.1:1/v1' }),
    (e) => e.status === null && /Network error/.test(e.message),
  );
});

test('missing base URL / model are rejected as fatal config errors', async () => {
  await assert.rejects(() => chatCompletion({ messages: [] }, { apiKey: 'k', model: 'm', baseUrl: '' }), (e) => e.status === 400);
  await assert.rejects(() => chatCompletion({ messages: [] }, { apiKey: 'k', model: '', baseUrl: 'http://x' }), (e) => e.status === 400);
});

test('END-TO-END: NVIDIA 503 -> NVIDIA fallback 429 key1 -> key2 works, over real HTTP', async () => {
  const primary = await startMock((_r, res) => json(res, 503, { error: 'down' }));
  const fallback = await startMock((rec, res) => {
    if (rec.auth === 'Bearer fb-key-1') return json(res, 429, { error: 'limit' });
    return json(res, 200, ok('served by fallback key 2'));
  });
  const router = new ProviderRouter(
    [
      { id: 'nv-primary', label: 'NVIDIA', adapter: 'openai', model: 'm', baseUrl: primary.base, keys: ['pk'] },
      { id: 'nv-fallback', label: 'NVIDIA fallback', adapter: 'openai', model: 'm', baseUrl: fallback.base, keys: ['fb-key-1', 'fb-key-2'] },
    ],
    { openai: chatCompletion },
  );
  const out = await router.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.strictEqual(out.route, 'nv-fallback');
  assert.strictEqual(out.response.content, 'served by fallback key 2');
  assert.deepStrictEqual(out.attempts.map((a) => a.status), [503, 429]);
  await primary.close(); await fallback.close();
});

test('SECURITY (real HTTP): a server that echoes our Authorization header in its error body cannot leak the key', async () => {
  const KEY = 'nvapi-ECHOECHOECHOECHO9999';
  const m = await startMock((rec, res) => json(res, 401, { error: { message: `Incorrect API key provided. You sent: ${rec.auth}` } }));
  const router = new ProviderRouter([{ id: 'a', label: 'A', adapter: 'openai', model: 'm', baseUrl: m.base, keys: [KEY] }], { openai: chatCompletion });
  let thrown; try { await router.chat({ messages: [] }); } catch (e) { thrown = e; }
  assert.ok(thrown, 'expected a failure');
  assert.ok(!JSON.stringify([thrown.message, thrown.cause]).includes('ECHOECHO'), 'key leaked: ' + thrown.message);
  await m.close();
});

test('real HTTP: a 400 from the primary falls through to a working secondary', async () => {
  const bad = await startMock((_r, res) => json(res, 400, { error: 'this model does not support image input' }));
  const good = await startMock((_r, res) => json(res, 200, ok('served by the vision model')));
  const router = new ProviderRouter(
    [{ id: 'text', label: 'Text model', adapter: 'openai', model: 'm', baseUrl: bad.base, keys: ['k1'] }, { id: 'vision', label: 'Vision model', adapter: 'openai', model: 'm', baseUrl: good.base, keys: ['k2'] }],
    { openai: chatCompletion });
  const out = await router.chat({ messages: [] });
  assert.strictEqual(out.route, 'vision');
  assert.match(router.status()[0].problem, /does not support image input/);
  await bad.close(); await good.close();
});

// ---------------------------------------------------------------- thinking written into the message
const thinking = async (content) => (await readOne({ content })).content;

test('THINKING in the message: a <think> block ahead of the answer is not part of the answer', async () => {
  assert.strictEqual(await thinking('<think>The user wants OK.\nSay OK.</think>\n\nOK'), 'OK');
  assert.strictEqual(await thinking('  <THINK>plan</Think>Done.'), 'Done.');
  assert.strictEqual(await thinking('<think>a</think><think>b</think>The answer'), 'The answer', 'more than one block');
  assert.strictEqual(await thinking('<think>a</think>'), '', 'all thinking and no answer is no answer');
});

test('THINKING in the message: the opening tag may be missing (the prompt opened it), and then everything up to </think> is thinking', async () => {
  assert.strictEqual(await thinking('I should click the button.\n</think>\nClicking now.'), 'Clicking now.');
});

test('THINKING in the message: a message that ends while the model is still thinking has no answer in it', async () => {
  assert.strictEqual(await thinking('<think>Let me think about where the button is'), '');
  assert.strictEqual(await thinking('<think>a</think><think>and then more'), '');
});

test('THINKING in the message: an answer that only TALKS about the tags is left exactly as it is', async () => {
  for (const text of ['Models write <think> before they answer.', 'Open it with <think> and close it with </think>.', 'x <think>y</think> z', '  plain words  ', '', 'No tags at all.']) {
    assert.strictEqual(await thinking(text), text, text);
  }
});

test('THINKING in the message: only the answer is returned as content - the provider\'s own message in raw is untouched', async () => {
  const out = await readOne({ content: '<think>hm</think>Hello', reasoning_content: 'hm' });
  assert.strictEqual(out.content, 'Hello');
  assert.strictEqual(out.raw.content, '<think>hm</think>Hello');
  assert.strictEqual(out.raw.reasoning_content, 'hm');
});

test('THINKING in the message: with nothing left but a refusal, the refusal is what is shown', async () => {
  assert.strictEqual((await readOne({ content: '<think>no</think>', refusal: 'I cannot do that.' })).content, 'I cannot do that.');
});

// ---------------------------------------------------------------- max_tokens / max_completion_tokens
const WANTS_COMPLETION = { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } };
const ctxFor = (m) => ({ apiKey: 'k', model: 'm', baseUrl: m.base });

test('MAX TOKENS: a provider that asks for max_completion_tokens instead gets ONE more try with that name, and its answer is used', async () => {
  const m = await startMock((rec, res) => (rec.body.max_tokens !== undefined ? json(res, 400, WANTS_COMPLETION) : json(res, 200, ok('fine'))));
  const tools = [{ type: 'function', function: { name: 't', parameters: { type: 'object', properties: {} } } }];
  const out = await chatCompletion({ messages: [{ role: 'user', content: 'hi' }], tools, maxTokens: 777 }, ctxFor(m));
  assert.strictEqual(out.content, 'fine');
  assert.strictEqual(m.seen.length, 2);
  assert.strictEqual(m.seen[1].body.max_completion_tokens, 777);
  assert.ok(!('max_tokens' in m.seen[1].body));
  const { max_tokens: a, ...first } = m.seen[0].body; const { max_completion_tokens: b, ...second } = m.seen[1].body;
  assert.deepStrictEqual([a, b], [777, 777]);
  assert.deepStrictEqual(second, first, 'the rest of the request is exactly the same');
});

test('MAX TOKENS: only for that complaint - any other 400 is the answer, with no second try', async () => {
  const m = await startMock((_r, res) => json(res, 400, { error: { message: 'The model does not support images.' } }));
  await assert.rejects(() => chatCompletion({ messages: [], maxTokens: 100 }, ctxFor(m)), (e) => e.status === 400 && /does not support images/.test(e.message));
  assert.strictEqual(m.seen.length, 1);
});

test('MAX TOKENS: only once - if the second try is refused too, that refusal is the error', async () => {
  const m = await startMock((_r, res) => json(res, 400, WANTS_COMPLETION));
  await assert.rejects(() => chatCompletion({ messages: [], maxTokens: 100 }, ctxFor(m)), (e) => e.status === 400 && /max_completion_tokens/.test(e.message));
  assert.strictEqual(m.seen.length, 2);
});

test('MAX TOKENS: with no limit asked for there is nothing to swap, so no second try', async () => {
  const m = await startMock((_r, res) => json(res, 400, WANTS_COMPLETION));
  await assert.rejects(() => chatCompletion({ messages: [] }, ctxFor(m)), (e) => e.status === 400);
  assert.strictEqual(m.seen.length, 1);
});

test('MAX TOKENS: the second try is a 429 or 5xx like any other - the status is kept so the router can fail over', async () => {
  let n = 0;
  const m = await startMock((_r, res) => (++n === 1 ? json(res, 400, WANTS_COMPLETION) : json(res, 429, { error: 'slow down' }, { 'Retry-After': '7' })));
  await assert.rejects(() => chatCompletion({ messages: [], maxTokens: 100 }, ctxFor(m)), (e) => e.status === 429 && e.retryAfterMs === 7000);
});

// ---------------------------------------------------------------- time limit and Stop
const goesQuietAfterHeaders = () => startMock((_r, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"choices":['); });

test('TIME LIMIT covers reading the answer too: a server that sends its headers and then goes quiet is given up on', async () => {
  const m = await goesQuietAfterHeaders();
  const t0 = Date.now();
  await assert.rejects(() => chatCompletion({ messages: [] }, ctxFor(m), { timeoutMs: 200 }),
    (e) => e.status == null && /timed out or aborted/.test(e.message) && !/invalid JSON/.test(e.message));
  assert.ok(Date.now() - t0 < 3000);
});

test('STOP while the answer is being read ends the request at once, as an abort (not as "invalid JSON")', async () => {
  const m = await goesQuietAfterHeaders();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 150);
  const t0 = Date.now();
  await assert.rejects(() => chatCompletion({ messages: [], signal: ac.signal }, ctxFor(m), { timeoutMs: 60_000 }),
    (e) => e.status == null && /timed out or aborted/.test(e.message));
  assert.ok(Date.now() - t0 < 3000);
});

test('STOP before the request is even sent: nothing is sent', async () => {
  const m = await startMock((_r, res) => json(res, 200, ok('x')));
  const ac = new AbortController(); ac.abort();
  await assert.rejects(() => chatCompletion({ messages: [], signal: ac.signal }, ctxFor(m)), /timed out or aborted/);
  assert.strictEqual(m.seen.length, 0);
});

test('LISTENERS: a task\'s Stop signal is not left carrying one listener per request (a long task used to leak them)', async () => {
  const { getEventListeners } = require('node:events');
  const m = await startMock((_r, res) => json(res, 200, ok('x')));
  const ac = new AbortController();
  for (let i = 0; i < 15; i++) await chatCompletion({ messages: [], signal: ac.signal }, ctxFor(m));
  assert.strictEqual(getEventListeners(ac.signal, 'abort').length, 0);
  await assert.rejects(() => chatCompletion({ messages: [], signal: ac.signal }, ctxFor({ base: 'http://127.0.0.1:1/v1' })), /Network error/);
  assert.strictEqual(getEventListeners(ac.signal, 'abort').length, 0, 'not after a failure either');
});
