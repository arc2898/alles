'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { loadPreload } = require('./helpers/preload-vm');

const FILE = path.join(__dirname, '../src/settings/preload.cjs');
const load = (opts) => loadPreload(FILE, opts);

/**
 * The REAL settings/preload.cjs, run in a VM with a fake electron and fed hostile input. It is the first of two
 * gates in front of the API keys (main/settings-ipc.js is the second), so these tests look for what a
 * compromised page - or a bug in the page - could try: odd names, inherited keys, extra fields, wrong types,
 * objects that throw when touched.
 */

const call = async (name, payload, opts) => { const p = load(opts); const reply = await p.api.invoke(name, payload); return { reply, invoked: p.invoked, raw: p.rawInvoked }; };
const forwarded = async (name, payload) => (await call(name, payload)).invoked;

test('the REAL preload runs, exposes window.alles with exactly invoke and onChanged, and requires nothing but electron', () => {
  const { api, exposedAs } = load();
  assert.strictEqual(exposedAs, 'alles');
  assert.deepStrictEqual(Object.keys(api).sort(), ['invoke', 'onChanged']);
});

test('HOSTILE NAMES: inherited keys, near-misses and non-strings are refused and nothing is sent', async () => {
  const names = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'settings:', 'settings:get ', ' settings:get', 'Settings:get', 'settings:GET', 'settings:nope', 'pill:event', 'settings:get\n', '', null, undefined, 5, {}, ['settings:get'], Symbol.iterator, true];
  for (const name of names) {
    const { reply, invoked } = await call(name, {});
    assert.deepStrictEqual(invoked, [], `"${String(name)}" got through`);
    assert.strictEqual(reply.ok, false, String(name));
    assert.match(reply.error, /Unknown action/);
  }
});

test('no-payload requests forward the channel only - whatever the page adds is discarded', async () => {
  for (const name of ['settings:get', 'settings:describe-providers', 'settings:load-issue', 'settings:migrate-session-keys', 'settings:check-computer']) {
    assert.deepStrictEqual(await forwarded(name, { evil: 'payload', routeId: 'x' }), [[name]], name);
    assert.deepStrictEqual(await forwarded(name, undefined), [[name]], name);
  }
});

test('ROUTE ID: lowercase letters, digits and hyphens, 1 to 32 characters - nothing else reaches main', async () => {
  const name = 'settings:remove-route';
  assert.deepStrictEqual(await forwarded(name, 'nvidia-primary'), [[name, 'nvidia-primary']]);
  assert.deepStrictEqual(await forwarded(name, 'a'.repeat(32)), [[name, 'a'.repeat(32)]]);
  for (const bad of ['', 'a'.repeat(33), 'Grok', 'has space', '../etc', 'a/b', 'a.b', 'a_b', 'x\n', '__proto__', null, undefined, 5, {}, ['grok'], { id: 'grok' }]) {
    assert.deepStrictEqual(await forwarded(name, bad), [], `${name} accepted ${JSON.stringify(bad)}`);
  }
});

test('KIND: exactly the four provider kinds', async () => {
  for (const k of ['nvidia', 'grok', 'gemini', 'custom']) assert.deepStrictEqual(await forwarded('settings:add-route', k), [['settings:add-route', k]]);
  for (const bad of ['', 'NVIDIA', 'openai', 'constructor', 'toString', null, undefined, 5, {}, ['grok']]) assert.deepStrictEqual(await forwarded('settings:add-route', bad), [], JSON.stringify(bad));
});

test('PATCH: only whitelisted settings of the right type pass; everything else is stripped, never forwarded', async () => {
  const out = await forwarded('settings:update', {
    dock: { edge: 'left', along: 0.25, display: null, hour12: true, evil: 'x' },
    agent: { maxSteps: 10 },
    tray: { enabled: true },
    input: { backend: 'ydotool', evil: 'x' },
    security: { keyStorage: 'file' },
    safety: { allowDangerousKeys: false, maxActionsPerMinute: 60, requireApprovalForShell: true, requireApprovalForFileWrites: false },
    providers: { routes: [] },                 // not allowed through this request
    version: 99, __proto__x: 1,
  });
  assert.deepStrictEqual(out, [['settings:update', {
    dock: { edge: 'left', along: 0.25, display: null, hour12: true },
    agent: { maxSteps: 10 },
    tray: { enabled: true },
    input: { backend: 'ydotool' },
    security: { keyStorage: 'file' },
    safety: { allowDangerousKeys: false, maxActionsPerMinute: 60, requireApprovalForShell: true, requireApprovalForFileWrites: false },
  }]]);
});

test('PATCH: the mouse and keyboard method may only be one of the three the app knows', async () => {
  for (const ok of ['auto', 'gnome', 'ydotool']) assert.deepStrictEqual(await forwarded('settings:update', { input: { backend: ok } }), [['settings:update', { input: { backend: ok } }]], ok);
  for (const bad of ['', 'AUTO', 'x11', 'constructor', 'toString', '__proto__', null, undefined, 5, true, {}, ['gnome']]) {
    assert.deepStrictEqual(await forwarded('settings:update', { input: { backend: bad } }), [], JSON.stringify(bad));
  }
  assert.deepStrictEqual(await forwarded('settings:update', { input: { backend: 'gnome' }, dock: { edge: 'diagonal' } }), [['settings:update', { input: { backend: 'gnome' } }]], 'a bad neighbour does not take it down');
});

test('PATCH: the method names the preload allows are exactly the ones the settings store accepts', async () => {
  const { INPUT_BACKENDS } = require('../src/main/settings');
  for (const name of INPUT_BACKENDS) assert.deepStrictEqual(await forwarded('settings:update', { input: { backend: name } }), [['settings:update', { input: { backend: name } }]], name);
});

test('PATCH: a wrongly typed value is dropped on its own without losing its valid neighbours', async () => {
  const out = await forwarded('settings:update', { dock: { edge: 'diagonal', along: 0.5 }, tray: { enabled: 'yes' }, safety: { maxActionsPerMinute: NaN, requireApprovalForShell: false } });
  assert.deepStrictEqual(out, [['settings:update', { dock: { along: 0.5 }, safety: { requireApprovalForShell: false } }]]);
});

test('PATCH: nothing valid left means nothing is sent', async () => {
  for (const bad of [{}, { providers: {} }, { dock: {} }, { dock: { edge: 'nope' } }, { safety: { allowDangerousKeys: 1 } }, { dock: 'top' }, { dock: [1] }, null, undefined, 5, 'x', [], [{ dock: { edge: 'top' } }]]) {
    const { reply, invoked } = await call('settings:update', bad);
    assert.deepStrictEqual(invoked, [], JSON.stringify(bad));
    assert.strictEqual(reply.ok, false);
  }
});

test('PATCH: a prototype-pollution payload is inert (own "__proto__" keys are never read)', async () => {
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"dock":{"__proto__":{"edge":"left"},"edge":"top"},"constructor":{"prototype":{"x":1}}}');
  const out = await forwarded('settings:update', hostile);
  assert.deepStrictEqual(out, [['settings:update', { dock: { edge: 'top' } }]]);
  assert.strictEqual({}.polluted, undefined);
  assert.strictEqual({}.x, undefined);
});

test('PATCH: inherited values are ignored (a value only counts if the caller owns it)', async () => {
  const inherited = Object.create({ dock: { edge: 'left' } });
  assert.deepStrictEqual(await forwarded('settings:update', inherited), []);
  const partlyInherited = { dock: Object.create({ edge: 'left' }) };
  assert.deepStrictEqual(await forwarded('settings:update', partlyInherited), []);
});

test('PATCH: numbers must be finite and sane; the display id may be null, a short string or a number', async () => {
  for (const bad of [Infinity, -Infinity, NaN, 1e7, '5', null, {}]) assert.deepStrictEqual(await forwarded('settings:update', { dock: { along: bad } }), [], `along ${String(bad)}`);
  for (const ok of [null, 'DP-1', 2, 'a'.repeat(64)]) assert.strictEqual((await forwarded('settings:update', { dock: { display: ok } })).length, 1, JSON.stringify(ok));
  for (const bad of ['a'.repeat(65), {}, [], true, undefined, NaN]) assert.deepStrictEqual(await forwarded('settings:update', { dock: { display: bad } }), [], `display ${String(bad)}`);
});

test('ROUTE EDIT: id plus any of label, model, baseUrl, enabled - extras stripped, one bad field refuses the whole edit', async () => {
  assert.deepStrictEqual(await forwarded('settings:update-route', { id: 'grok', label: 'My Grok', model: 'grok-4', baseUrl: 'https://api.x.ai/v1', enabled: false, kind: 'nvidia', keys: ['x'] }),
    [['settings:update-route', { id: 'grok', label: 'My Grok', model: 'grok-4', baseUrl: 'https://api.x.ai/v1', enabled: false }]]);
  assert.deepStrictEqual(await forwarded('settings:update-route', { id: 'grok', model: '' }), [['settings:update-route', { id: 'grok', model: '' }]], 'clearing a field is allowed');
  for (const bad of [
    { id: 'grok' },                                     // nothing to change
    { model: 'x' },                                     // no id
    { id: 'Grok', model: 'x' }, { id: '../x', model: 'x' }, { id: 5, model: 'x' },
    { id: 'grok', model: 5 }, { id: 'grok', enabled: 'true' }, { id: 'grok', baseUrl: 'x'.repeat(2001) }, { id: 'grok', label: 'x'.repeat(101) },
    { id: 'grok', model: 'fine', enabled: 1 },          // one bad field spoils the edit
    null, undefined, 'grok', [], 5,
  ]) assert.deepStrictEqual(await forwarded('settings:update-route', bad), [], JSON.stringify(bad));
});

test('REORDER: an array of at most 12 valid route ids', async () => {
  assert.deepStrictEqual(await forwarded('settings:reorder-routes', ['a', 'b']), [['settings:reorder-routes', ['a', 'b']]]);
  assert.deepStrictEqual(await forwarded('settings:reorder-routes', []), [['settings:reorder-routes', []]]);
  const twelve = Array.from({ length: 12 }, (_, i) => `r${i}`);
  assert.strictEqual((await forwarded('settings:reorder-routes', twelve)).length, 1);
  for (const bad of [[...twelve, 'r12'], ['a', 5], ['a', null], ['a', 'B'], ['a', '../x'], 'a,b', { 0: 'a', length: 1 }, null, undefined, 5]) {
    assert.deepStrictEqual(await forwarded('settings:reorder-routes', bad), [], JSON.stringify(bad));
  }
});

test('ADD KEY: a valid route id and a non-empty string of at most 4096 characters; extras stripped', async () => {
  assert.deepStrictEqual(await forwarded('settings:add-key', { routeId: 'grok', key: 'xai-abcdef123456', extra: 1 }), [['settings:add-key', { routeId: 'grok', key: 'xai-abcdef123456' }]]);
  assert.strictEqual((await forwarded('settings:add-key', { routeId: 'grok', key: 'k'.repeat(4096) })).length, 1);
  for (const bad of [{ routeId: 'grok', key: '' }, { routeId: 'grok', key: 'k'.repeat(4097) }, { routeId: 'grok', key: 5 }, { routeId: 'grok' }, { key: 'abcdefgh' }, { routeId: 'GROK', key: 'abcdefgh' }, { routeId: '../x', key: 'abcdefgh' }, null, 'abcdefgh', []]) {
    assert.deepStrictEqual(await forwarded('settings:add-key', bad), [], JSON.stringify(bad));
  }
});

test('REMOVE KEY and TEST: route id plus a key id of 4 to 32 hex characters (test: key id optional)', async () => {
  assert.deepStrictEqual(await forwarded('settings:remove-key', { routeId: 'grok', keyId: 'ab12cd34ef56', x: 1 }), [['settings:remove-key', { routeId: 'grok', keyId: 'ab12cd34ef56' }]]);
  for (const bad of [{ routeId: 'grok' }, { keyId: 'ab12' }, { routeId: 'grok', keyId: 'xyz' }, { routeId: 'grok', keyId: 'AB12' }, { routeId: 'grok', keyId: 'ab1' }, { routeId: 'grok', keyId: 'a'.repeat(33) }, { routeId: 'grok', keyId: 5 }, null, 'x']) {
    assert.deepStrictEqual(await forwarded('settings:remove-key', bad), [], JSON.stringify(bad));
  }
  assert.deepStrictEqual(await forwarded('settings:test-route', { routeId: 'grok' }), [['settings:test-route', { routeId: 'grok' }]]);
  assert.deepStrictEqual(await forwarded('settings:test-route', { routeId: 'grok', keyId: undefined }), [['settings:test-route', { routeId: 'grok' }]]);
  assert.deepStrictEqual(await forwarded('settings:test-route', { routeId: 'grok', keyId: 'ab12cd34' }), [['settings:test-route', { routeId: 'grok', keyId: 'ab12cd34' }]]);
  for (const bad of [{ routeId: 'grok', keyId: 'nope' }, { routeId: 'grok', keyId: null }, { keyId: 'ab12cd34' }, { routeId: 5 }, null, 'grok']) {
    assert.deepStrictEqual(await forwarded('settings:test-route', bad), [], JSON.stringify(bad));
  }
});

test('the request main receives is a FRESH object, never the page\'s own', async () => {
  const input = { routeId: 'grok', key: 'xai-abcdef123456' };
  const { raw } = await call('settings:add-key', input);
  assert.notStrictEqual(raw[0][1], input);
  input.key = 'changed-after-the-fact';
  assert.strictEqual(raw[0][1].key, 'xai-abcdef123456');
});

test('invoke() never throws and always returns a promise, even for objects that explode when touched', async () => {
  const bomb = new Proxy({}, { get() { throw new Error('boom'); }, has() { throw new Error('boom'); }, ownKeys() { throw new Error('boom'); }, getOwnPropertyDescriptor() { throw new Error('boom'); } });
  const getterBomb = { get dock() { throw new Error('getter'); } };
  const circular = { dock: {} }; circular.dock.self = circular;
  for (const name of ['settings:update', 'settings:update-route', 'settings:add-key', 'settings:remove-key', 'settings:test-route', 'settings:reorder-routes', 'settings:add-route', 'settings:remove-route']) {
    for (const payload of [bomb, getterBomb, circular]) {
      const p = load();
      let result;
      assert.doesNotThrow(() => { result = p.api.invoke(name, payload); }, `${name} threw synchronously`);
      assert.ok(result && typeof result.then === 'function', `${name} must return a promise`);
      const reply = await result;                       // and the promise must not reject
      assert.strictEqual(reply.ok, false, name);
      assert.deepStrictEqual(p.invoked, [], `${name} sent something for a hostile payload`);
    }
  }
});

test('a hostile NAME object cannot throw either (toString that explodes, Symbol)', async () => {
  const p = load();
  const evilName = { toString() { throw new Error('toString'); } };
  assert.strictEqual((await p.api.invoke(evilName, {})).ok, false);
  assert.strictEqual((await p.api.invoke(Symbol('x'), {})).ok, false);
  assert.deepStrictEqual(p.invoked, []);
});

test('replies from main pass through unchanged', async () => {
  const { reply } = await call('settings:get', undefined, { reply: () => ({ ok: true, settings: { a: 1 } }) });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(reply)), { ok: true, settings: { a: 1 } });
});

test('if main fails or answers with junk, the page gets a normal {ok:false,error} - never a rejection or a stack trace', async () => {
  const failing = await call('settings:get', undefined, { reply: () => { throw new Error("No handler registered for 'settings:get' at /secret/path/app.js:12"); } });
  assert.strictEqual(failing.reply.ok, false);
  assert.match(failing.reply.error, /could not be reached/);
  assert.ok(!/secret|app\.js|No handler/.test(failing.reply.error), 'internal error text must not leak to the page');
  for (const junk of [undefined, null, 5, 'ok', true, [1, 2]]) {
    const r = await call('settings:get', undefined, { reply: () => junk });
    assert.strictEqual(r.reply.ok, false, JSON.stringify(junk));
  }
});

// ---------------------------------------------------------------- main -> page

test('onChanged registers one listener for settings:changed and calls back with NO data', () => {
  const p = load(); const calls = [];
  p.api.onChanged((...args) => calls.push(args));
  assert.strictEqual(Object.keys(p.listeners).join(), 'settings:changed');
  p.emit('settings:changed', { secret: 'leak?' });
  assert.deepStrictEqual(calls, [[]], 'the page learns THAT something changed, never WHAT');
});

test('onChanged ignores non-functions, survives a throwing callback, and caps how many listeners can pile up', () => {
  const p = load();
  for (const bad of [undefined, null, 'x', 5, {}, []]) p.api.onChanged(bad);
  assert.strictEqual((p.listeners['settings:changed'] || []).length, 0);
  p.api.onChanged(() => { throw new Error('page bug'); });
  assert.doesNotThrow(() => p.emit('settings:changed'));
  for (let i = 0; i < 50; i++) p.api.onChanged(() => {});
  assert.ok(p.listeners['settings:changed'].length <= 4, `listeners piled up: ${p.listeners['settings:changed'].length}`);
});

test('the preload offers the page no other way to reach ipc (no send, no on, no raw ipcRenderer)', () => {
  const { api } = load();
  for (const k of ['send', 'on', 'ipcRenderer', 'invokeRaw', 'sendSync', 'postMessage']) assert.strictEqual(api[k], undefined, k);
});
