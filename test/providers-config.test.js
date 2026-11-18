'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { sanitize, applyPatch, cleanBaseUrl, DEFAULTS, DEFAULT_ROUTES, KINDS, MAX_ROUTES } = require('../src/main/settings');
const { buildRoutes, describeRoutes, resolveRoute, nextRouteId, hostOf, SUGGESTED_FOR_ID } = require('../src/main/providers/config');
const { PRESETS, chatCompletion } = require('../src/main/providers/openai-compat');
const { ProviderRouter } = require('../src/main/providers/router');
const { KeyStore } = require('../src/main/keystore');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const http = require('node:http');
const { tmpDir } = require('./helpers/tmp');

// Close the end-to-end test's servers even if it fails (see probe.test.js for why).
const openServers = [];
test.afterEach(() => { for (const o of openServers.splice(0)) { o.srv.closeAllConnections?.(); o.srv.close(); } });

const route = (o = {}) => ({ id: 'grok', kind: 'grok', label: 'Grok', model: '', baseUrl: '', enabled: true, ...o });
const sessionStore = () => new KeyStore(path.join(tmpDir('alles-cfg-'), 'keys.json'), { safeStorage: null });

// ---------------------------------------------------------------- schema

test('DEFAULTS: NVIDIA primary, then NVIDIA fallback, then Grok, then Gemini - the order you asked for', () => {
  assert.deepStrictEqual(DEFAULTS.providers.routes.map((r) => r.id), ['nvidia-primary', 'nvidia-fallback', 'grok', 'gemini']);
  assert.deepStrictEqual(DEFAULTS.providers.routes.map((r) => r.kind), ['nvidia', 'nvidia', 'grok', 'gemini']);
});

test('settings KINDS are exactly the provider presets (adding a preset without updating the schema fails here)', () => {
  assert.deepStrictEqual([...KINDS].sort(), Object.keys(PRESETS).sort());
});

test('a missing or corrupt providers section falls back to the defaults', () => {
  for (const bad of [undefined, null, 5, 'x', [], { providers: 3 }, { providers: { routes: 'nope' } }, { providers: { routes: null } }]) {
    assert.deepStrictEqual(sanitize(bad === undefined ? {} : bad).providers.routes.map((r) => r.id), DEFAULT_ROUTES.map((r) => r.id), JSON.stringify(bad));
  }
});

test('an EMPTY list the user chose is kept empty (deleting every provider is legitimate)', () => {
  assert.deepStrictEqual(sanitize({ providers: { routes: [] } }).providers.routes, []);
});

test('invalid routes are dropped one by one; valid neighbours survive', () => {
  const r = sanitize({ providers: { routes: [route({ id: 'ok-1' }), null, 5, { id: '../evil' }, { id: '' }, { kind: 'grok' }, route({ id: 'Bad Id' }), route({ id: 'ok-2' })] } }).providers.routes;
  assert.deepStrictEqual(r.map((x) => x.id), ['ok-1', 'ok-2']);
});

test('duplicate ids keep the FIRST occurrence (priority order is preserved)', () => {
  const r = sanitize({ providers: { routes: [route({ id: 'a', label: 'first' }), route({ id: 'b' }), route({ id: 'a', label: 'second' })] } }).providers.routes;
  assert.deepStrictEqual(r.map((x) => [x.id, x.label]), [['a', 'first'], ['b', 'Grok']]);
});

test('at most 12 routes', () => {
  const many = Array.from({ length: 30 }, (_, i) => route({ id: `r${i}` }));
  assert.strictEqual(sanitize({ providers: { routes: many } }).providers.routes.length, MAX_ROUTES);
});

test('unknown kind -> custom; label trimmed and capped; a blank label falls back to the id', () => {
  const [a, b] = sanitize({ providers: { routes: [route({ id: 'a', kind: 'skynet', label: '  ' + 'x'.repeat(100) + '  ' }), route({ id: 'b', label: '   ' })] } }).providers.routes;
  assert.strictEqual(a.kind, 'custom'); assert.strictEqual(a.label.length, 40);
  assert.strictEqual(b.label, 'b');
});

test('model ids: real-world shapes are accepted, junk is cleared', () => {
  const ok = ['meta/llama-3.2-90b-vision-instruct', 'grok-4', 'gemini-2.5-flash', 'models/gemini-2.5-flash', 'org/model:tag', 'name@2024-01',
    // the shipped suggestions themselves must be accepted when a person types them in
    PRESETS.nvidia.model, PRESETS.grok.model, PRESETS.gemini.model, 'moonshotai/kimi-k2.6'];
  for (const m of ok) assert.strictEqual(sanitize({ providers: { routes: [route({ model: m })] } }).providers.routes[0].model, m, m);
  for (const m of ['has space', 'a\nb', 'x'.repeat(121), '<script>', 'caf\u00e9', 5, {}]) assert.strictEqual(sanitize({ providers: { routes: [route({ model: m })] } }).providers.routes[0].model, '', JSON.stringify(m));
});

test('SECURITY: a stray apiKey / secret field on a route is dropped, so a key can never be written to settings.json', () => {
  const r = sanitize({ providers: { routes: [{ ...route(), apiKey: 'nvapi-SECRET1234567890', keys: ['nvapi-SECRET1234567890'], headers: { Authorization: 'Bearer x' } }] } });
  assert.ok(!JSON.stringify(r).includes('SECRET'));
  assert.deepStrictEqual(Object.keys(r.providers.routes[0]).sort(), ['baseUrl', 'enabled', 'id', 'kind', 'label', 'model']);
});

// ---------------------------------------------------------------- base URL rules (the key is sent to this host)

test('base URL: https is accepted; query, hash and trailing slashes are stripped', () => {
  assert.strictEqual(cleanBaseUrl('https://api.example.com/v1/?x=1#frag'), 'https://api.example.com/v1');
  assert.strictEqual(cleanBaseUrl('  https://api.x.ai/v1  '), 'https://api.x.ai/v1');
});

test('base URL: plain http is refused for remote hosts (the key would cross the network in clear text)', () => {
  assert.strictEqual(cleanBaseUrl('http://api.example.com/v1'), '');
  assert.strictEqual(cleanBaseUrl('http://192.168.1.50:8000/v1'), '', 'a LAN address is not "local" for this purpose');
});

test('base URL: plain http IS allowed for a server on this machine (self-hosted models)', () => {
  assert.strictEqual(cleanBaseUrl('http://localhost:8000/v1/'), 'http://localhost:8000/v1');
  assert.strictEqual(cleanBaseUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1');
  assert.strictEqual(cleanBaseUrl('http://[::1]:8000/v1'), 'http://[::1]:8000/v1');
});

test('base URL: other schemes, embedded credentials, garbage and over-long values are all refused', () => {
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://x.com', 'data:text/plain,hi', 'https://user:pw@x.com/v1', 'https://', 'not a url', '', '   ', null, undefined, 42, {}, 'https://x.com/' + 'a'.repeat(400)]) {
    assert.strictEqual(cleanBaseUrl(bad), '', String(bad).slice(0, 40));
  }
});

test('base URL: a long URL is REFUSED, never truncated into a different address', () => {
  const long = 'https://x.com/' + 'a'.repeat(400);
  assert.strictEqual(cleanBaseUrl(long), '');
});

test('the deceptive-host trick (a trusted name inside the path or userinfo) is not accepted as that host', () => {
  assert.strictEqual(cleanBaseUrl('https://api.x.ai@evil.example/v1'), '', 'userinfo');
  assert.strictEqual(hostOf(cleanBaseUrl('https://evil.example/api.x.ai/v1')), 'evil.example', 'the host is what comes before the path');
});

// ---------------------------------------------------------------- security.keyStorage

test('security.keyStorage: only "file" is accepted as an opt-in; anything else stays on the safe default', () => {
  assert.strictEqual(sanitize({}).security.keyStorage, 'session');
  assert.strictEqual(sanitize({ security: { keyStorage: 'file' } }).security.keyStorage, 'file');
  for (const bad of ['FILE', 'plaintext', true, 1, null, {}, 'keyring']) assert.strictEqual(sanitize({ security: { keyStorage: bad } }).security.keyStorage, 'session', JSON.stringify(bad));
});

test('applyPatch replaces the route list wholesale and validates what it is given', () => {
  const next = applyPatch(DEFAULTS, { providers: { routes: [route({ id: 'only', model: 'bad model!' , baseUrl: 'http://evil.com' })] } });
  assert.deepStrictEqual(next.providers.routes, [{ id: 'only', kind: 'grok', label: 'Grok', model: '', baseUrl: '', enabled: true }]);
});

// ---------------------------------------------------------------- buildRoutes

test('buildRoutes: empty model/baseUrl use the preset; explicit values win; order and flags are kept', () => {
  const ks = sessionStore();
  const out = buildRoutes([route({ id: 'a', kind: 'nvidia' }), route({ id: 'b', kind: 'grok', model: 'grok-3', baseUrl: 'https://proxy.example/v1', enabled: false })], ks);
  assert.deepStrictEqual(out.map((r) => [r.id, r.model, r.baseUrl, r.enabled, r.adapter]), [
    ['a', PRESETS.nvidia.model, PRESETS.nvidia.baseUrl, true, 'openai'],
    ['b', 'grok-3', 'https://proxy.example/v1', false, 'openai'],
  ]);
});

test('buildRoutes: each route gets ITS OWN keys from the key store', () => {
  const ks = sessionStore();
  ks.add('nvidia-primary', 'nvapi-PRIMARYKEY00001'); ks.add('nvidia-fallback', 'nvapi-FALLBACKKEY0001'); ks.add('grok', 'xai-GROKKEYNUMBER01'); ks.add('grok', 'xai-GROKKEYNUMBER02');
  const out = buildRoutes(DEFAULTS.providers.routes, ks);
  assert.deepStrictEqual(out.map((r) => [r.id, r.keys.length]), [['nvidia-primary', 1], ['nvidia-fallback', 1], ['grok', 2], ['gemini', 0]]);
  assert.deepStrictEqual(out[1].keys, ['nvapi-FALLBACKKEY0001']);
});

test('the NVIDIA default is a VISION model (ALLES sends screenshots; a text-only model would be rejected at once)', () => {
  assert.match(PRESETS.nvidia.model, /vision|vl/i);
});

test('every shipped route resolves to a model and an address (nothing is left for the person to guess)', () => {
  for (const r of DEFAULTS.providers.routes) {
    const x = resolveRoute(r);
    assert.ok(x.model && x.baseUrl, `${r.id}: ${JSON.stringify(x)}`);
    assert.match(x.baseUrl, /^https:\/\//, `${r.id} talks to its provider over https`);
  }
});

test('the NVIDIA fallback suggests a DIFFERENT model from the primary: one model being down must not take both routes down', () => {
  const out = Object.fromEntries(buildRoutes(DEFAULTS.providers.routes, sessionStore()).map((r) => [r.id, r]));
  assert.strictEqual(out['nvidia-primary'].model, PRESETS.nvidia.model);
  assert.strictEqual(out['nvidia-fallback'].model, 'moonshotai/kimi-k2.6');
  assert.notStrictEqual(out['nvidia-fallback'].model, out['nvidia-primary'].model);
  assert.strictEqual(out['nvidia-fallback'].baseUrl, out['nvidia-primary'].baseUrl, 'same service, different model');
});

test('the fallback model is still only a SUGGESTION: it shows as a default, and a model the person chose wins', () => {
  const ks = sessionStore();
  const fb = DEFAULTS.providers.routes.find((r) => r.id === 'nvidia-fallback');
  const [suggested] = describeRoutes([fb], ks);
  assert.strictEqual(suggested.model, 'moonshotai/kimi-k2.6');
  assert.strictEqual(suggested.modelIsDefault, true);
  assert.strictEqual(suggested.defaultsUnverified, true);
  const [chosen] = describeRoutes([{ ...fb, model: 'my/own-model', baseUrl: 'https://proxy.example/v1' }], ks);
  assert.strictEqual(chosen.model, 'my/own-model');
  assert.strictEqual(chosen.modelIsDefault, false);
  assert.strictEqual(buildRoutes([{ ...fb, model: 'my/own-model' }], ks)[0].model, 'my/own-model');
});

test('only the shipped fallback route gets its own suggestion: another NVIDIA route uses the plain preset', () => {
  const [a] = buildRoutes([route({ id: 'my-nvidia', kind: 'nvidia' })], sessionStore());
  assert.strictEqual(a.model, PRESETS.nvidia.model);
  assert.deepStrictEqual(Object.keys(SUGGESTED_FOR_ID), ['nvidia-fallback']);
});

// ---------------------------------------------------------------- describeRoutes

test('describeRoutes: the most useful problem is reported, in a sensible order', () => {
  const ks = sessionStore();
  const d = (r, status) => describeRoutes([r], ks, status)[0];
  assert.strictEqual(d(route({ id: 'c', kind: 'custom' })).problem, 'Choose a model.');
  assert.strictEqual(d(route({ id: 'c', kind: 'custom', model: 'm' })).problem, 'Set the base URL.');
  assert.strictEqual(d(route()).problem, 'Add an API key.');
  ks.add('grok', 'xai-GROKKEYNUMBER01');
  assert.strictEqual(d(route()).problem, null);
  assert.strictEqual(d(route()).ready, true);
  assert.strictEqual(d(route({ enabled: false })).ready, false, 'a disabled route is not "ready"');
  assert.match(d(route(), [{ id: 'grok', problem: 'Grok rejected the request: HTTP 404' }]).problem, /rejected the request/, 'a remembered rejection is surfaced');
});

test('describeRoutes: flags suggested defaults as unverified, and explicit values as not', () => {
  const ks = sessionStore();
  const [a, b] = describeRoutes([route({ id: 'a' }), route({ id: 'b', model: 'grok-3', baseUrl: 'https://proxy.example/v1' })], ks);
  assert.strictEqual(a.defaultsUnverified, true); assert.strictEqual(a.modelIsDefault, true);
  assert.strictEqual(b.defaultsUnverified, false);
  assert.strictEqual(b.host, 'proxy.example');
});

test('describeRoutes: shows the destination host, so a redirected key is visible to the user', () => {
  assert.strictEqual(describeRoutes([route()], sessionStore())[0].host, 'api.x.ai');
});

test('describeRoutes: undecryptable keys are called out, not silently ignored', () => {
  const file = path.join(tmpDir('alles-cfg-'), 'keys.json');
  fs.writeFileSync(file, JSON.stringify({ routes: { grok: [{ id: 'abcd1234', format: 'enc', data: 'AAAA', hint: 'xai-…001', addedAt: 1 }] } }));
  const d = describeRoutes([route()], new KeyStore(file, { safeStorage: null }))[0];
  assert.strictEqual(d.unreadableKeys, 1);
  assert.match(d.problem, /cannot be decrypted/);
});

test('SECURITY: describeRoutes never contains a secret, only hints', () => {
  const ks = sessionStore(); ks.add('grok', 'xai-TOPSECRETVALUE0001');
  const json = JSON.stringify(describeRoutes(DEFAULTS.providers.routes, ks));
  assert.ok(!json.includes('TOPSECRET'));
  assert.match(json, /xai-…001/);
});

test('nextRouteId never collides', () => {
  assert.strictEqual(nextRouteId([]), 'custom');
  assert.strictEqual(nextRouteId([{ id: 'custom' }]), 'custom-2');
  assert.strictEqual(nextRouteId([{ id: 'custom' }, { id: 'custom-2' }, { id: 'custom-3' }]), 'custom-4');
});

// ---------------------------------------------------------------- the whole chain, over real HTTP

test('END-TO-END: saved routes + key store -> router -> real HTTP: NVIDIA rejects (400), the fallback account serves', async () => {
  const seen = [];
  const mk = (handler) => new Promise((resolve) => { const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { seen.push({ auth: req.headers.authorization, model: JSON.parse(b).model }); handler(res); }); }); srv.listen(0, '127.0.0.1', () => { const h = { srv, base: `http://127.0.0.1:${srv.address().port}/v1` }; openServers.push(h); resolve(h); }); });
  const send = (res, st, o) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const primary = await mk((res) => send(res, 400, { error: 'model does not support images' }));
  const fallback = await mk((res) => send(res, 200, { choices: [{ message: { content: 'hello from the fallback account' } }] }));

  const ks = sessionStore(); ks.add('nvidia-primary', 'nvapi-PRIMARYKEY00001'); ks.add('nvidia-fallback', 'nvapi-FALLBACKKEY0001');
  const saved = [route({ id: 'nvidia-primary', kind: 'nvidia', baseUrl: primary.base, model: 'text-only-model' }), route({ id: 'nvidia-fallback', kind: 'nvidia', label: 'NVIDIA (fallback)', baseUrl: fallback.base, model: 'vision-model' })];
  const router = new ProviderRouter(buildRoutes(saved, ks), { openai: chatCompletion });
  const out = await router.chat({ messages: [{ role: 'user', content: 'hi' }] });

  assert.strictEqual(out.response.content, 'hello from the fallback account');
  assert.strictEqual(out.label, 'NVIDIA (fallback)');
  assert.deepStrictEqual(seen.map((s) => [s.auth, s.model]), [['Bearer nvapi-PRIMARYKEY00001', 'text-only-model'], ['Bearer nvapi-FALLBACKKEY0001', 'vision-model']], 'each route used ITS key and ITS model');
  assert.match(describeRoutes(saved, ks, router.status())[0].problem, /rejected the request/);
  primary.srv.close(); fallback.srv.close();
});
