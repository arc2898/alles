'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const zlib = require('node:zlib');
const { probeRoute, hintFor, PROBE_TOKENS } = require('../src/main/providers/probe');
const { ProviderError } = require('../src/main/providers/router');
const { solidPng, noisyPng } = require('../src/main/util/png');

// ---------------------------------------------------------------- a configurable fake model server
// Every server is closed after each test, pass OR fail. A failing test that skipped its own close() used to
// leave a listening socket behind, so the whole test process never exited and hung the run.
const opened = [];
test.afterEach(async () => { for (const s of opened.splice(0)) await s.close(); });

function server(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      let b = ''; req.on('data', (c) => (b += c));
      req.on('end', () => { const body = JSON.parse(b || '{}'); seen.push({ body, auth: req.headers.authorization }); handler(body, res, req); });
    });
    srv.listen(0, '127.0.0.1', () => { const h = { seen, base: `http://127.0.0.1:${srv.address().port}/v1`, close: () => { srv.closeAllConnections?.(); return new Promise((r) => srv.close(() => r())); } }; opened.push(h); resolve(h); });
  });
}
const reply = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const ok = (content, extra = {}) => ({ choices: [{ message: { content, ...extra } }] });
const toolCall = (name, args) => ({ tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const hasImage = (body) => body.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));

const FULL = (body, res) => (body.tools ? reply(res, 200, ok('', toolCall('report_color', { color: 'blue' }))) : hasImage(body) ? reply(res, 200, ok('Red.')) : reply(res, 200, ok('OK')));
const KEY = 'nvapi-PROBEKEY0000000001';
const probe = (srv, o = {}) => probeRoute({ route: { model: 'm', baseUrl: srv.base }, apiKey: KEY, timeoutMs: 3000, ...o });

// ---------------------------------------------------------------- the good case + what is actually sent

test('a capable model passes all four checks: usable', async () => {
  const s = await server(FULL); const r = await probe(s);
  assert.deepStrictEqual([r.text.ok, r.vision.ok, r.tools.ok, r.followup.ok, r.usable], [true, true, true, true, true]);
  assert.match(r.summary, /Works/);
  assert.strictEqual(s.seen.length, 4);
  await s.close();
});

test('the four requests are the right shape: plain text, a REAL screenshot-sized PNG, a tool schema, and the tool answer sent back', async () => {
  const s = await server(FULL); await probe(s);
  const [text, vision, tools, followup] = s.seen.map((x) => x.body);
  assert.ok(!hasImage(text) && !text.tools, 'text check must be plain');
  assert.strictEqual(text.max_tokens, PROBE_TOKENS);

  const part = vision.messages[0].content.find((p) => p.type === 'image_url');
  const b64 = part.image_url.url.replace(/^data:image\/png;base64,/, '');
  const png = Buffer.from(b64, 'base64');
  assert.deepStrictEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'valid PNG signature');
  assert.deepStrictEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1280, 720], 'the size ALLES sends: a screenshot the model can take in');
  assert.ok(png.length > 250_000 && png.length < 700_000, `as heavy as a real screenshot (${png.length} bytes), not a flat colour that compresses to nothing`);
  // decode the pixel data: it really is (mostly) red
  const idat = png.subarray(png.indexOf('IDAT') + 4, png.lastIndexOf('IEND') - 8);
  const raw = zlib.inflateSync(idat);
  assert.strictEqual(raw.length, 720 * (1 + 1280 * 3));
  for (const [i, want] of [[1, 220], [2, 30], [3, 30]]) assert.ok(Math.abs(raw[i] - want) <= 1, `first pixel ${raw[i]} vs ${want}`);

  assert.strictEqual(tools.tools[0].function.name, 'report_color');
  assert.strictEqual(tools.tool_choice, 'auto');

  // the follow-up is what ALLES sends at every step: the user's ask, the model's OWN tool call, and the tool's answer
  assert.deepStrictEqual(followup.messages.map((m) => m.role), ['user', 'assistant', 'tool']);
  assert.deepStrictEqual(followup.messages[1].tool_calls, toolCall('report_color', { color: 'blue' }).tool_calls, 'the model\'s tool call goes back as received');
  assert.strictEqual(followup.messages[2].tool_call_id, 'c1', 'the answer names the call it answers');
  assert.strictEqual(typeof followup.messages[2].content, 'string');
  assert.strictEqual(followup.tools[0].function.name, 'report_color', 'the tools stay on offer, as they do in a real step');
  for (const x of s.seen) { assert.strictEqual(x.auth, `Bearer ${KEY}`); assert.strictEqual(x.body.model, 'm'); assert.strictEqual(x.body.max_tokens, PROBE_TOKENS); }
  await s.close();
});

test('THINKING model: gets room to think first (a 16-token limit left it with an empty answer, and a working model was called broken)', async () => {
  // Behaves like the models that reason before answering: the thinking is spent from the same token limit.
  const THINKS = 300;
  const s = await server((body, res) => {
    const room = (body.max_tokens || 4096) - THINKS;
    const say = (content, extra = {}) => (room < 8 ? reply(res, 200, { choices: [{ finish_reason: 'length', message: { content: '' } }] }) : reply(res, 200, ok(content, extra)));
    return body.tools ? say('', toolCall('report_color', { color: 'blue' })) : hasImage(body) ? say('Red.') : say('OK');
  });
  const r = await probe(s);
  assert.strictEqual(r.usable, true, r.summary);
  await s.close();
});

test('an EMPTY answer is reported as nothing said, not as a wrong answer', async () => {
  const s = await server((_b, res) => reply(res, 200, ok('')));
  const r = await probe(s);
  assert.strictEqual(r.text.ok, false);
  assert.match(r.text.hint, /it said nothing/);
  await s.close();
});

test('the judge accepts natural phrasings ("Red.", "RED", "OK!")', async () => {
  const s = await server((body, res) => (body.tools ? reply(res, 200, ok('', toolCall('report_color', { color: 'x' }))) : hasImage(body) ? reply(res, 200, ok('The image is RED.')) : reply(res, 200, ok('ok!'))));
  assert.strictEqual((await probe(s)).usable, true);
  await s.close();
});

// ---------------------------------------------------------------- models that are reachable but useless to ALLES

test('TEXT-ONLY model (rejects images with 400): reported precisely, and the other checks still run', async () => {
  const s = await server((body, res) => (hasImage(body) ? reply(res, 400, { error: 'image input not supported' }) : FULL(body, res)));
  const r = await probe(s);
  assert.deepStrictEqual([r.text.ok, r.vision.ok, r.tools.ok, r.usable], [true, false, true, false]);
  assert.match(r.vision.hint, /does not accept images.*vision-capable/);
  assert.match(r.summary, /Images:/); assert.doesNotMatch(r.summary, /Tools:/);
  assert.strictEqual(s.seen.filter((x) => hasImage(x.body)).length, 2, 'the screenshot-sized picture, then the tiny one to be sure it is not just the size');
  await s.close();
});

// ---------------------------------------------------------------- a provider that takes pictures, but not ones as big as a screenshot

/** A provider with a limit on the size of a picture (NVIDIA's older vision endpoints: about 180 000 characters inline). */
const sizeLimited = (status, limit = 100_000) => (body, res) => {
  const big = body.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url' && p.image_url.url.length > limit));
  return big ? reply(res, status, { error: { message: `Image too large: inline images are limited to ${limit} characters` } }) : FULL(body, res);
};

test('PICTURE SIZE: a provider that takes a tiny picture but refuses a screenshot-sized one is caught, and the hint says it is the SIZE', async () => {
  for (const status of [400, 413, 422]) {
    const s = await server(sizeLimited(status));
    const r = await probe(s);
    assert.strictEqual(r.vision.ok, false, String(status));
    assert.strictEqual(r.vision.status, status);
    assert.match(r.vision.hint, /^The model takes pictures, but refused one the size of a screenshot \(about \d+ KB\)\./, String(status));
    assert.match(r.vision.hint, /Image too large: inline images are limited to 100000 characters/, 'the provider\'s own words are in the hint');
    assert.doesNotMatch(r.vision.hint, /does not accept images/, 'NOT blamed on the model');
    assert.deepStrictEqual([r.text.ok, r.tools.ok, r.followup.ok, r.usable], [true, true, true, false]);
    assert.match(r.summary, /^Images: The model takes pictures, but refused one/);
    assert.strictEqual(s.seen.length, 5, 'text, big picture, tiny picture, tools, follow-up');
    await s.close();
  }
});

test('PICTURE SIZE: the size in the hint is the size of the picture that was sent', async () => {
  const s = await server(sizeLimited(400));
  const r = await probe(s);
  const sent = s.seen.find((x) => hasImage(x.body)).body.messages[0].content.find((p) => p.type === 'image_url').image_url.url;
  const kb = Math.round(Buffer.from(sent.replace(/^data:image\/png;base64,/, ''), 'base64').length / 1000);
  assert.ok(r.vision.hint.includes(`about ${kb} KB`), `${kb} KB: ${r.vision.hint}`);
  await s.close();
});

test('PICTURE SIZE: a provider that takes screenshot-sized pictures is not asked twice (the tiny one is only for telling the two causes apart)', async () => {
  const s = await server(FULL);
  await probe(s);
  assert.strictEqual(s.seen.filter((x) => hasImage(x.body)).length, 1);
  await s.close();
});

test('PICTURE SIZE: a wrong answer about a big picture is a blind model, not a size problem (no second picture)', async () => {
  const s = await server((body, res) => (hasImage(body) ? reply(res, 200, ok('I can see a picture.')) : FULL(body, res)));
  const r = await probe(s);
  assert.match(r.vision.hint, /did not identify/);
  assert.strictEqual(s.seen.filter((x) => hasImage(x.body)).length, 1);
  await s.close();
});

test('PICTURE SIZE: a refused key or a rate limit on the picture is not mistaken for a size problem (no second picture)', async () => {
  for (const status of [401, 403, 429, 500]) {
    const s = await server((body, res) => (hasImage(body) ? reply(res, status, { error: 'nope' }) : FULL(body, res)));
    const r = await probe(s);
    assert.doesNotMatch(r.vision.hint, /takes pictures, but refused/, String(status));
    assert.strictEqual(s.seen.filter((x) => hasImage(x.body)).length, 1, String(status));
    await s.close();
  }
});

test('NO-TOOLS model (rejects tools with 400)', async () => {
  const s = await server((body, res) => (body.tools ? reply(res, 400, { error: 'tools unsupported' }) : FULL(body, res)));
  const r = await probe(s);
  assert.deepStrictEqual([r.text.ok, r.vision.ok, r.tools.ok], [true, true, false]);
  assert.match(r.tools.hint, /rejected tool calling/);
  await s.close();
});

test('BLIND model (accepts the image but ignores it) is caught, though no HTTP error occurred', async () => {
  const s = await server((body, res) => (hasImage(body) ? reply(res, 200, ok('I can see a picture.')) : FULL(body, res)));
  const r = await probe(s);
  assert.strictEqual(r.vision.ok, false);
  assert.strictEqual(r.vision.status, null, 'not an HTTP failure');
  assert.match(r.vision.hint, /did not identify.*ignoring images/);
  await s.close();
});

test('CHATTY model (answers in prose instead of calling the tool) is caught', async () => {
  const s = await server((body, res) => (body.tools ? reply(res, 200, ok('Sure, the colour is blue!')) : FULL(body, res)));
  const r = await probe(s);
  assert.strictEqual(r.tools.ok, false);
  assert.match(r.tools.hint, /replied in text instead of calling the tool/);
  await s.close();
});

test('a text-only AND tool-less model reports BOTH problems in one summary', async () => {
  const s = await server((body, res) => (hasImage(body) || body.tools ? reply(res, 400, {}) : reply(res, 200, ok('OK'))));
  const r = await probe(s);
  assert.match(r.summary, /Images:.*Tools:/);
  await s.close();
});

// ---------------------------------------------------------------- the second step of a tool call

test('FOLLOW-UP: a provider that refuses the tool\'s answer (400) is caught - the first step would have worked, the second would not', async () => {
  const s = await server((body, res) => (body.messages.some((m) => m.role === 'tool') ? reply(res, 400, { error: 'unknown role tool' }) : FULL(body, res)));
  const r = await probe(s);
  assert.deepStrictEqual([r.text.ok, r.vision.ok, r.tools.ok, r.followup.ok, r.usable], [true, true, true, false, false]);
  assert.match(r.followup.hint, /rejected the tool's answer/);
  assert.match(r.summary, /Next step:/); assert.doesNotMatch(r.summary, /Images:|Tools:/);
  await s.close();
});

test('FOLLOW-UP, Gemini 3 style: the signature the provider attached to its tool call must come back, and it does', async () => {
  // Gemini 3 answers 400 ("Function call is missing a thought_signature") unless tool_calls[i].extra_content.google.thought_signature
  // is sent back with the next request. The probe sends the provider's tool call back untouched, which carries it.
  const SIG = { google: { thought_signature: 'SIG-abc123' } };
  const s = await server((body, res) => {
    if (body.tools && !body.messages.some((m) => m.role === 'tool')) return reply(res, 200, ok('', { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'report_color', arguments: '{"color":"blue"}' }, extra_content: SIG }] }));
    if (body.messages.some((m) => m.role === 'tool')) {
      const sent = body.messages.find((m) => m.role === 'assistant').tool_calls[0].extra_content;
      return sent && sent.google && sent.google.thought_signature === 'SIG-abc123' ? reply(res, 200, ok('Done.')) : reply(res, 400, { error: 'Function call is missing a thought_signature in functionCall parts.' });
    }
    return FULL(body, res);
  });
  const r = await probe(s);
  assert.strictEqual(r.followup.ok, true, r.summary);
  assert.strictEqual(r.usable, true);
  await s.close();
});

test('FOLLOW-UP: when a provider DOES complain about a thought signature, the hint says what it is and that it should not happen', async () => {
  const s = await server((body, res) => (body.messages.some((m) => m.role === 'tool') ? reply(res, 400, { error: 'Function call is missing a thought_signature in functionCall parts.' }) : FULL(body, res)));
  const r = await probe(s);
  assert.match(r.followup.hint, /thought signature/);
  assert.match(r.followup.hint, /should not happen/);
  await s.close();
});

test('FOLLOW-UP: the model may answer with text OR with another tool call - both are fine; saying nothing is not', async () => {
  const again = await server((body, res) => (body.messages.some((m) => m.role === 'tool') ? reply(res, 200, ok('', toolCall('report_color', { color: 'green' }))) : FULL(body, res)));
  assert.strictEqual((await probe(again)).usable, true, 'another tool call is a fine answer');
  await again.close();
  const quiet = await server((body, res) => (body.messages.some((m) => m.role === 'tool') ? reply(res, 200, ok('')) : FULL(body, res)));
  const r = await probe(quiet);
  assert.strictEqual(r.followup.ok, false);
  assert.match(r.followup.hint, /said nothing after being given the tool's answer/);
  await quiet.close();
});

test('FOLLOW-UP: a tool call that comes back with no id is given one, and the answer goes back under that id (the provider then decides)', async () => {
  const s = await server((body, res) => (body.tools ? reply(res, 200, ok('', { tool_calls: [{ type: 'function', function: { name: 'report_color', arguments: '{"color":"blue"}' } }] })) : hasImage(body) ? reply(res, 200, ok('Red.')) : reply(res, 200, ok('OK'))));
  const r = await probe(s);
  assert.strictEqual(r.tools.ok, true);
  assert.strictEqual(r.followup.ok, true, JSON.stringify(r.followup));
  assert.strictEqual(s.seen.length, 4);
  const sent = s.seen[3].body.messages;
  assert.strictEqual(sent.find((m) => m.role === 'assistant').tool_calls[0].id, 'call_1');
  assert.strictEqual(sent.find((m) => m.role === 'tool').tool_call_id, 'call_1', 'the answer carries the id the call was given');
  await s.close();
});

test('FOLLOW-UP: a provider that refuses the history it was given still fails the check, with the hint', async () => {
  const s = await server((body, res) => {
    if (!body.tools) return hasImage(body) ? reply(res, 200, ok('Red.')) : reply(res, 200, ok('OK'));
    if (body.messages.some((m) => m.role === 'tool')) return reply(res, 400, { error: 'tool_call_id does not match' });
    return reply(res, 200, ok('', { tool_calls: [{ type: 'function', function: { name: 'report_color', arguments: '{"color":"blue"}' } }] }));
  });
  const r = await probe(s);
  assert.strictEqual(r.followup.ok, false);
  assert.match(r.followup.hint, /rejected the tool's answer/);
  await s.close();
});

test('FOLLOW-UP: it is not tried when the tool check failed (and then it is not blamed in the summary either)', async () => {
  const s = await server((body, res) => (body.tools ? reply(res, 200, ok('Sure, blue!')) : FULL(body, res)));
  const r = await probe(s);
  assert.strictEqual(s.seen.length, 3);
  assert.deepStrictEqual([r.tools.ok, r.followup.ok, r.followup.skipped], [false, false, true]);
  assert.match(r.summary, /Tools:/); assert.doesNotMatch(r.summary, /Next step:/);
  await s.close();
});

// ---------------------------------------------------------------- failures that make the other checks pointless

test('a refused key (401) stops after ONE request: the other checks would fail identically and cost tokens', async () => {
  const s = await server((_b, res) => reply(res, 401, { error: 'bad key' }));
  const r = await probe(s);
  assert.strictEqual(s.seen.length, 1);
  assert.strictEqual(r.text.status, 401);
  assert.match(r.summary, /key was refused/);
  assert.deepStrictEqual([r.vision.skipped, r.tools.skipped, r.followup.skipped], [true, true, true]);
  // Every skipped row blames the check that really stopped the run - the first one - not "the tool check", which was never tried.
  for (const row of [r.vision, r.tools, r.followup]) assert.match(row.hint, /basic check/);
  await s.close();
});

test('wrong model / base URL (404) stops after one request with an actionable hint', async () => {
  const s = await server((_b, res) => reply(res, 404, { error: 'no such model' }));
  const r = await probe(s);
  assert.strictEqual(s.seen.length, 1);
  assert.match(r.summary, /model or base URL was not found/);
  await s.close();
});

test('rate limited (429) stops after one request', async () => {
  const s = await server((_b, res) => reply(res, 429, {}));
  const r = await probe(s);
  assert.strictEqual(s.seen.length, 1);
  assert.match(r.summary, /Rate limited/);
  await s.close();
});

test('an unreachable server is reported as such, with one attempt only', async () => {
  const r = await probeRoute({ route: { model: 'm', baseUrl: 'http://127.0.0.1:1/v1' }, apiKey: KEY, timeoutMs: 2000 });
  assert.strictEqual(r.text.status, null);
  assert.match(r.summary, /Could not reach the server/);
  assert.strictEqual(r.vision.skipped, true);
});

test('a server that never answers is reported as too slow, not as a hang', async () => {
  const s = await server(() => { /* never responds */ });
  const t0 = Date.now();
  const r = await probe(s, { timeoutMs: 200 });
  assert.ok(Date.now() - t0 < 2500, 'the probe must give up on its own');
  assert.match(r.summary, /took too long/);
  await s.close();
});

test('402 (out of credit) has its own explanation', () => {
  assert.match(hintFor('text', 402, ''), /out of credit/);
});

// ---------------------------------------------------------------- guard rails

test('missing model / base URL / key: says what to do and sends NOTHING', async () => {
  const s = await server(FULL);
  for (const [o, msg] of [[{ route: { model: '', baseUrl: s.base }, apiKey: KEY }, /Choose a model/], [{ route: { model: 'm', baseUrl: '' }, apiKey: KEY }, /base URL/], [{ route: { model: 'm', baseUrl: s.base }, apiKey: '' }, /Add an API key/], [{ route: null, apiKey: KEY }, /Choose a model/]]) {
    const r = await probeRoute(o); assert.strictEqual(r.usable, false); assert.match(r.summary, msg);
  }
  assert.strictEqual(s.seen.length, 0);
  await s.close();
});

test('SECURITY: a server that echoes our Authorization header cannot get the key into the result', async () => {
  const s = await server((_b, res, req) => reply(res, 401, { error: `you sent ${req.headers.authorization}` }));
  const r = await probe(s);
  assert.ok(!JSON.stringify(r).includes('PROBEKEY'), 'key leaked into the probe result');
  await s.close();
});

test('hintFor: every status a provider is likely to send maps to plain language', () => {
  const cases = [[401, /refused/], [403, /refused/], [404, /not found/], [429, /Rate limited/], [400, /rejected the request/], [422, /rejected the request/], [413, /request was too big/], [500, /provider returned an error/]];
  for (const [status, re] of cases) assert.match(hintFor('text', status, ''), re, String(status));
  assert.match(hintFor('vision', 400, ''), /images/); assert.match(hintFor('tools', 400, ''), /tool/);
  assert.match(hintFor('vision', 413, ''), /picture was too big/);
  assert.match(hintFor('text', null, 'Network error: timed out or aborted'), /too long/);
  assert.match(hintFor('text', null, 'Network error: ECONNREFUSED'), /Could not reach/);
  assert.match(hintFor('followup', 400, ''), /tool's answer/);
  assert.match(hintFor('followup', 400, 'missing a thought_signature'), /thought signature/);
  assert.match(hintFor('followup', 429, ''), /Rate limited/);
});

test('solidPng produces the requested size and colour', () => {
  const png = solidPng(5, 3, [1, 2, 3]);
  assert.deepStrictEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [5, 3]);
  const raw = zlib.inflateSync(png.subarray(png.indexOf('IDAT') + 4, png.indexOf('IEND') - 8));
  assert.strictEqual(raw.length, 3 * (1 + 5 * 3));
  assert.deepStrictEqual([raw[1], raw[2], raw[3]], [1, 2, 3]);
});

test('noisyPng: the size and colour asked for, within one step of it; the same every time; as heavy as a screenshot; edges of the range do not wrap', () => {
  const png = noisyPng(64, 48, [220, 30, 30]);
  assert.deepStrictEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [64, 48]);
  const raw = zlib.inflateSync(png.subarray(png.indexOf('IDAT') + 4, png.lastIndexOf('IEND') - 8));
  assert.strictEqual(raw.length, 48 * (1 + 64 * 3));
  let off = 0; let n = 0;
  for (let y = 0; y < 48; y++) for (let x = 0; x < 64 * 3; x++) { const v = raw[y * (1 + 64 * 3) + 1 + x]; assert.ok(Math.abs(v - [220, 30, 30][x % 3]) <= 1); if (v !== [220, 30, 30][x % 3]) off++; n++; }
  assert.ok(off / n > 0.05 && off / n < 0.3, `about one sample in seven is off by one (${(off / n).toFixed(2)})`);
  assert.ok(noisyPng(64, 48, [220, 30, 30]).equals(png), 'the same bytes every time');
  assert.ok(!noisyPng(64, 48, [220, 30, 30], 2).equals(png), 'another seed, another noise');
  const edge = zlib.inflateSync((() => { const p = noisyPng(64, 48, [0, 255, 0]); return p.subarray(p.indexOf('IDAT') + 4, p.lastIndexOf('IEND') - 8); })());
  for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) { const o = y * (1 + 64 * 3) + 1 + x * 3; assert.ok(edge[o] <= 1 && edge[o + 1] >= 254 && edge[o + 2] <= 1, `${edge[o]},${edge[o + 1]},${edge[o + 2]}`); }
  const big = noisyPng(1280, 720, [220, 30, 30]);
  assert.ok(big.length > 250_000 && big.length < 700_000, `${big.length} bytes`);
});

test('SECURITY (independent of the adapter): an error that contains the key is redacted by the probe ITSELF', async () => {
  // The adapter already redacts response bodies, so the HTTP test above cannot tell whether the probe's
  // own layer works. Inject a chat function that throws a message containing the key, bypassing the adapter.
  const chat = async () => { throw new ProviderError(`HTTP 401: Incorrect API key provided: ${KEY}`, { status: 401 }); };
  const r = await probeRoute({ route: { model: 'm', baseUrl: 'http://unused.invalid/v1' }, apiKey: KEY, chat });
  assert.ok(!JSON.stringify(r).includes('PROBEKEY'), 'the probe leaked the key it was given');
  assert.match(r.text.error, /\[redacted\]/);
});
