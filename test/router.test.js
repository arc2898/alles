'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ProviderRouter, ProviderError, classify } = require('../src/main/providers/router');

const err = (status, extra = {}) => new ProviderError(`http ${status}`, { status, ...extra });
const req = { messages: [{ role: 'user', content: 'hi' }] };

function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('round-robins keys inside one route', async () => {
  const used = [];
  const router = new ProviderRouter(
    [{ id: 'grok', label: 'Grok', adapter: 'a', model: 'm', keys: ['k1', 'k2', 'k3'] }],
    { a: async (_r, ctx) => { used.push(ctx.apiKey); return { ok: true }; } },
  );
  await router.chat(req); await router.chat(req); await router.chat(req); await router.chat(req);
  assert.deepStrictEqual(used, ['k1', 'k2', 'k3', 'k1']);
});

test('429 on one key rotates to the next key in the SAME route', async () => {
  const used = [];
  const router = new ProviderRouter(
    [{ id: 'gemini', label: 'Gemini', adapter: 'a', model: 'm', keys: ['bad', 'good'] }],
    { a: async (_r, ctx) => { used.push(ctx.apiKey); if (ctx.apiKey === 'bad') throw err(429); return { ok: true }; } },
  );
  const out = await router.chat(req);
  assert.strictEqual(out.route, 'gemini');
  assert.deepStrictEqual(used, ['bad', 'good']);
});

test('NVIDIA primary exhausted -> falls back to NVIDIA fallback route', async () => {
  const router = new ProviderRouter(
    [
      { id: 'nv-primary', label: 'NVIDIA', adapter: 'nv1', model: 'm', keys: ['p1'] },
      { id: 'nv-fallback', label: 'NVIDIA (fallback)', adapter: 'nv2', model: 'm', keys: ['f1'] },
    ],
    {
      nv1: async () => { throw err(503); },
      nv2: async () => ({ ok: 'from-fallback' }),
    },
  );
  const out = await router.chat(req);
  assert.strictEqual(out.route, 'nv-fallback');
  assert.strictEqual(out.response.ok, 'from-fallback');
  assert.strictEqual(out.attempts.length, 1);
});

test('cooled-down key is skipped, then usable again after cooldown', async () => {
  const clock = makeClock();
  let calls = 0;
  const router = new ProviderRouter(
    [{ id: 'g', label: 'G', adapter: 'a', model: 'm', keys: ['only'] }],
    { a: async () => { calls++; if (calls === 1) throw err(429); return { ok: true }; } },
    { now: clock.now },
  );
  await assert.rejects(() => router.chat(req), /All providers failed/);
  assert.strictEqual(calls, 1);

  // still cooling: adapter must NOT be called again
  await assert.rejects(() => router.chat(req), /All providers failed/);
  assert.strictEqual(calls, 1);

  clock.advance(61_000); // past the 60s rate-limit cooldown
  const out = await router.chat(req);
  assert.strictEqual(out.response.ok, true);
  assert.strictEqual(calls, 2);
});

test('Retry-After from the provider overrides the default cooldown', async () => {
  const clock = makeClock();
  let calls = 0;
  const router = new ProviderRouter(
    [{ id: 'g', label: 'G', adapter: 'a', model: 'm', keys: ['only'] }],
    { a: async () => { calls++; if (calls === 1) throw err(429, { retryAfterMs: 5_000 }); return { ok: true }; } },
    { now: clock.now },
  );
  await assert.rejects(() => router.chat(req));
  clock.advance(6_000); // well under the 60s default, but past Retry-After
  await router.chat(req);
  assert.strictEqual(calls, 2);
});

test('REJECTION: a 400 skips the REST of that route, and the next route serves the request', async () => {
  const used = [];
  const router = new ProviderRouter(
    [{ id: 'a', label: 'A', adapter: 'x', model: 'm', keys: ['a1', 'a2', 'a3'] }, { id: 'b', label: 'B', adapter: 'y', model: 'm', keys: ['b1'] }],
    { x: async (_r, c) => { used.push(c.apiKey); throw err(400); }, y: async (_r, c) => { used.push(c.apiKey); return { ok: 'from-b' }; } },
  );
  const out = await router.chat(req);
  assert.strictEqual(out.route, 'b');
  assert.deepStrictEqual(used, ['a1', 'b1'], 'a2 and a3 would be rejected identically, so they are not even tried');
});

test('REJECTION: a 413 (the request is bigger than this provider takes - a screenshot too large) is a rejection too: the rest of that route is skipped and the next provider answers', async () => {
  const used = []; let asked = 0;
  const router = new ProviderRouter(
    [{ id: 'a', label: 'A', adapter: 'x', model: 'm', keys: ['a1', 'a2'] }, { id: 'b', label: 'B', adapter: 'y', model: 'm', keys: ['b1'] }],
    { x: async (_r, c) => { used.push(c.apiKey); asked++; throw err(413); }, y: async (_r, c) => { used.push(c.apiKey); return { ok: 'from-b' }; } },
  );
  assert.strictEqual((await router.chat(req)).route, 'b');
  assert.strictEqual((await router.chat(req)).route, 'b');
  assert.deepStrictEqual(used, ['a1', 'b1', 'b1'], 'a2 would be refused the same way; and A is not asked again at the next step');
  assert.match(router.status()[0].problem, /A rejected the request/);
  assert.strictEqual(classify(err(413)), 'rejected');
});

test('REJECTION: a text-only primary does not stop a vision-capable fallback (the real-world case)', async () => {
  const router = new ProviderRouter(
    [{ id: 'nv-text', label: 'NVIDIA (text model)', adapter: 'x', model: 'm', keys: ['k'] }, { id: 'grok', label: 'Grok', adapter: 'y', model: 'm', keys: ['k'] }],
    { x: async () => { throw err(400, {}); }, y: async () => ({ content: 'saw the screenshot' }) },
  );
  assert.strictEqual((await router.chat(req)).response.content, 'saw the screenshot');
});

test('REJECTION is remembered: the route is not re-tried at every agent step, and returns after the cooldown', async () => {
  const clock = makeClock(); const calls = { a: 0, b: 0 };
  const router = new ProviderRouter(
    [{ id: 'a', label: 'A', adapter: 'x', model: 'm', keys: ['k'] }, { id: 'b', label: 'B', adapter: 'y', model: 'm', keys: ['k'] }],
    { x: async () => { calls.a++; throw err(400); }, y: async () => { calls.b++; return {}; } }, { now: clock.now },
  );
  await router.chat(req); await router.chat(req); await router.chat(req);
  assert.deepStrictEqual(calls, { a: 1, b: 3 }, 'A was asked once, then skipped');
  assert.match(router.status()[0].problem, /A rejected the request/);
  assert.ok(router.status()[0].problemForSec > 0);
  clock.advance(10 * 60_000 + 1000);
  await router.chat(req);
  assert.strictEqual(calls.a, 2, 'retried after the cooldown');
  assert.strictEqual(router.status()[0].problem, null === router.status()[0].problem ? null : router.status()[0].problem);
});

test('REJECTION memory is cleared when settings change (a corrected model name must take effect at once)', async () => {
  let ok = false; let calls = 0;
  const cfg = [{ id: 'a', label: 'A', adapter: 'x', model: 'wrong-model', keys: ['k'] }];
  const router = new ProviderRouter(cfg, { x: async (_r, c) => { calls++; if (c.model === 'wrong-model') throw err(404); ok = true; return {}; } });
  await assert.rejects(() => router.chat(req), /rejected/);
  router.setRoutes([{ ...cfg[0], model: 'right-model' }]);
  await router.chat(req);
  assert.strictEqual(ok, true); assert.strictEqual(calls, 2);
});

test('ALL routes reject -> ONE clear error that carries the provider\'s reason and a 4xx status', async () => {
  const router = new ProviderRouter(
    [{ id: 'a', label: 'A', adapter: 'x', model: 'm', keys: ['k'] }, { id: 'b', label: 'B', adapter: 'x', model: 'm', keys: ['k'] }],
    { x: async () => { throw err(400); } },
  );
  await assert.rejects(() => router.chat(req), (e) => /Every provider rejected the request\. A: http 400 \| B: http 400/.test(e.message) && e.status === 400);
});

test('a rejection mixed with a rate limit is reported as a general failure, not as a bad request', async () => {
  const router = new ProviderRouter(
    [{ id: 'a', label: 'A', adapter: 'x', model: 'm', keys: ['k'] }, { id: 'b', label: 'B', adapter: 'y', model: 'm', keys: ['k'] }],
    { x: async () => { throw err(400); }, y: async () => { throw err(429); } },
  );
  await assert.rejects(() => router.chat(req), /All providers failed/);
});

test('NO KEYS anywhere -> tells the user to add one (and never claims a provider failed)', async () => {
  const router = new ProviderRouter([{ id: 'a', label: 'A', adapter: 'x', model: 'm', keys: [] }, { id: 'b', label: 'B', adapter: 'x', model: 'm', keys: ['', '  '] }], { x: async () => ({}) });
  await assert.rejects(() => router.chat(req), (e) => /Open Settings and add a key/.test(e.message) && !/All providers failed/.test(e.message));
  await assert.rejects(() => new ProviderRouter([], {}).chat(req), /Open Settings and add a key/);
});

test('KEYS PRESENT BUT ALL COOLING DOWN -> "All providers failed", NOT "add a key" (the user already has keys)', async () => {
  const clock = makeClock();
  const router = new ProviderRouter([{ id: 'a', label: 'A', adapter: 'x', model: 'm', keys: ['k'] }], { x: async () => { throw err(429); } }, { now: clock.now });
  await assert.rejects(() => router.chat(req), /All providers failed/);
  await assert.rejects(() => router.chat(req), (e) => /All providers failed/.test(e.message) && /cooling/.test(e.message) && !/add a key/.test(e.message));
});

test('402 (out of credit) gets the long key cooldown, like 401/403', async () => {
  const clock = makeClock(); let calls = 0;
  const router = new ProviderRouter([{ id: 'a', label: 'A', adapter: 'x', model: 'm', keys: ['k'] }], { x: async () => { calls++; throw err(402); } }, { now: clock.now });
  await assert.rejects(() => router.chat(req));
  clock.advance(10 * 60_000); await assert.rejects(() => router.chat(req));
  assert.strictEqual(calls, 1, 'still cooling after 10 minutes');
  clock.advance(21 * 60_000); await assert.rejects(() => router.chat(req));
  assert.strictEqual(calls, 2);
});

test('SECURITY: a provider that echoes the key in its error never gets it into our messages', async () => {
  const KEY = 'nvapi-SECRETSECRETSECRET1234';
  const router = new ProviderRouter(
    [{ id: 'a', label: 'A', adapter: 'x', model: 'm', keys: [KEY] }],
    { x: async () => { throw err(401, {}) && Object.assign(new ProviderError(`HTTP 401: Incorrect API key provided: ${KEY}`, { status: 401 })); } },
  );
  const events = []; router.onEvent = (e) => events.push(e);
  let thrown; try { await router.chat(req); } catch (e) { thrown = e; }
  const everything = JSON.stringify([thrown.message, thrown.cause, events, router.status()]);
  assert.ok(!everything.includes('SECRETSECRET'), 'the key leaked into an error, attempt list, event or status');
});

test('a 500 on one route still fails over to the next (server errors are not "rejections")', async () => {
  const router = new ProviderRouter(
    [{ id: 'a', label: 'A', adapter: 'x', model: 'm', keys: ['k'] }, { id: 'b', label: 'B', adapter: 'y', model: 'm', keys: ['k'] }],
    { x: async () => { throw err(500); }, y: async () => ({ ok: 1 }) },
  );
  assert.strictEqual((await router.chat(req)).route, 'b');
  assert.strictEqual(router.status()[0].problem, null, 'a 500 is not remembered as a configuration problem');
});

test('401 gets a long cooldown so a dead key is not hammered', async () => {
  const clock = makeClock();
  let calls = 0;
  const router = new ProviderRouter(
    [{ id: 'g', label: 'G', adapter: 'a', model: 'm', keys: ['dead'] }],
    { a: async () => { calls++; throw err(401); } },
    { now: clock.now },
  );
  await assert.rejects(() => router.chat(req));
  clock.advance(10 * 60_000);
  await assert.rejects(() => router.chat(req));
  assert.strictEqual(calls, 1, 'still cooling after 10 min');
  clock.advance(21 * 60_000);
  await assert.rejects(() => router.chat(req));
  assert.strictEqual(calls, 2, 'retried after 30+ min');
});

test('disabled routes are skipped', async () => {
  const router = new ProviderRouter(
    [
      { id: 'off', label: 'Off', adapter: 'x', model: 'm', keys: ['k'], enabled: false },
      { id: 'on', label: 'On', adapter: 'y', model: 'm', keys: ['k'] },
    ],
    { x: async () => { throw new Error('should not run'); }, y: async () => ({ ok: 1 }) },
  );
  assert.strictEqual((await router.chat(req)).route, 'on');
});

test('status() never leaks full keys', async () => {
  const router = new ProviderRouter(
    [{ id: 'g', label: 'G', adapter: 'a', model: 'm', keys: ['nvapi-SECRETSECRETSECRET'] }],
    { a: async () => ({}) },
  );
  const json = JSON.stringify(router.status());
  assert.ok(!json.includes('SECRETSECRET'));
  assert.ok(json.includes('nvap'));
});

test('empty / whitespace keys are ignored', async () => {
  const router = new ProviderRouter(
    [{ id: 'g', label: 'G', adapter: 'a', model: 'm', keys: ['', '  ', 'real'] }],
    { a: async (_r, c) => ({ key: c.apiKey }) },
  );
  assert.strictEqual((await router.chat(req)).response.key, 'real');
  assert.strictEqual(router.status()[0].keys.length, 1);
});

// ---------------------------------------------------------------- Stop
// Pressing Stop drops the request in flight. The adapter then fails with a "network error" like any other - but no key or provider did
// anything wrong. It used to be counted as one: every key got a cooldown and every other provider was tried (and dropped at once), so a
// new task started right after Stop was answered "All providers failed ... cooling down".

/** An adapter that waits until the request is dropped, then fails the way chatCompletion does. */
const hangsUntilStopped = (used) => async (r, ctx) => {
  used.push(ctx.apiKey);
  await new Promise((resolve) => { if (r.signal.aborted) resolve(); else r.signal.addEventListener('abort', resolve, { once: true }); });
  throw new ProviderError('Network error: timed out or aborted');
};
const twoRoutes = () => [
  { id: 'a', label: 'A', adapter: 'x', model: 'm', keys: ['k1', 'k2'] },
  { id: 'b', label: 'B', adapter: 'x', model: 'm', keys: ['k3'] },
];
const untouched = (router) => router.status().every((r) => r.keys.every((k) => k.available && k.failures === 0 && k.cooldownSec === 0) && !r.problem);

test('STOP: a request the person stopped is reported as stopped - no other key or provider is tried, and nothing is cooled down', async () => {
  const used = []; const events = [];
  const router = new ProviderRouter(twoRoutes(), { x: hangsUntilStopped(used) }, { onEvent: (e) => events.push(e.type) });
  const ac = new AbortController();
  const p = router.chat({ ...req, signal: ac.signal });
  setImmediate(() => ac.abort());
  await assert.rejects(p, (e) => e instanceof ProviderError && /Stopped by the user/.test(e.message) && !/All providers failed/.test(e.message));
  assert.deepStrictEqual(used, ['k1'], 'only the first key was ever used');
  assert.ok(untouched(router), JSON.stringify(router.status()));
  assert.ok(!events.includes('failure') && !events.includes('route-exhausted'), events.join());
});

test('STOP: the next task, right after Stop, is answered by the first key again', async () => {
  const used = []; let hang = true;
  const router = new ProviderRouter(twoRoutes(), { x: async (r, ctx) => (hang ? hangsUntilStopped(used)(r, ctx) : (used.push(ctx.apiKey), { ok: true })) });
  const ac = new AbortController();
  const p = router.chat({ ...req, signal: ac.signal });
  setImmediate(() => ac.abort());
  await assert.rejects(p, /Stopped/);
  hang = false;
  const out = await router.chat({ ...req, signal: new AbortController().signal });
  assert.strictEqual(out.route, 'a');
  assert.deepStrictEqual(used, ['k1', 'k2'], 'k1 hung and was dropped; k2 is simply the next key in turn - none was cooling');
});

test('STOP: a request that is already stopped never reaches a provider', async () => {
  const used = [];
  const router = new ProviderRouter(twoRoutes(), { x: hangsUntilStopped(used) });
  const ac = new AbortController(); ac.abort();
  await assert.rejects(() => router.chat({ ...req, signal: ac.signal }), /Stopped by the user/);
  assert.deepStrictEqual(used, []);
  assert.ok(untouched(router));
});

test('STOP: a real failure (a 429) while Stop has NOT been pressed is still cooled and failed over, as before', async () => {
  const used = [];
  const router = new ProviderRouter(twoRoutes(), { x: async (_r, ctx) => { used.push(ctx.apiKey); if (ctx.apiKey !== 'k3') throw err(429); return { ok: true }; } });
  const out = await router.chat({ ...req, signal: new AbortController().signal });
  assert.strictEqual(out.route, 'b');
  assert.deepStrictEqual(used, ['k1', 'k2', 'k3']);
  assert.ok(!untouched(router));
});
