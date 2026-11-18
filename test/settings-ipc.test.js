'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fakeElectron } = require('./helpers/fake-electron');
const { App } = require('../src/main/app');
const { attachSettingsIpc } = require('../src/main/settings-ipc');
const { tmpDir } = require('./helpers/tmp');
const { fakeComputer } = require('./helpers/fake-computer');

/**
 * INTEGRATION tests: real App (real SettingsStore, real KeyStore) with the Settings IPC attached by App.create()
 * itself, invoked through ipcMain.handle/ipcRenderer.invoke AS THE SETTINGS PAGE (the sender is the real
 * Settings window's webContents, because anything else is refused) - the same
 * request/response pattern a real preload uses, via fake-electron's ipcMain._invoke (see fake-electron.js
 * for why this is a distinct mechanism from the pill's fire-and-forget .on/.send).
 *
 * settings:test-route calls the real probeRoute() against a real HTTP server (an actual localhost
 * listener), the same way test/probe.test.js does, so the settings-window Test button is proven against
 * real network code, not a stub of it.
 */
// A test that fails part-way must not leave its app running: the island's 50 ms timer would keep the whole test run
// from ever finishing, and a hang tells you nothing. Every rig is registered here and torn down after its test.
const live = [];
test.afterEach(() => { while (live.length) { try { live.pop()._teardown(); } catch { /* it was already torn down */ } } });

function rig(opts = {}) {
  const dir = tmpDir('alles-sipc-');
  const { electron, internals } = fakeElectron(opts.electronOpts);
  const computer = fakeComputer(opts.computer);        // never the real screenshot tool or a real sharing session (see helpers/fake-computer.js)
  const app = new App({ electron, userDataDir: dir, shortcut: opts.shortcut, makeInputBackend: computer.makeInputBackend });
  live.push(app);
  app.create();                                         // attaches the Settings IPC, exactly as the real app does
  computer.install(app);
  const sender = app.settingsWindow.open().webContents;   // the one caller that is allowed in
  const invoke = (channel, payload) => internals.invoke(channel, payload, sender);
  const unsubscribe = () => app.unsubscribeSettingsIpc && app.unsubscribeSettingsIpc();
  return { app, electron, internals, invoke, unsubscribe, sender, computer };
}
async function withRig(opts, fn) {
  const r = rig(opts);
  try { return await fn(r); } finally { r.unsubscribe(); r.app._teardown(); }
}

// ---------------------------------------------------------------- wiring itself

test('attachSettingsIpc registers a handle() for every settings: channel it exposes', async () => {
  await withRig({}, async ({ invoke }) => {
    const res = await invoke('settings:get');
    assert.strictEqual(res.ok, true);
  });
});

test('an unknown channel name (never registered) rejects, exactly as real ipcMain.invoke would', async () => {
  await withRig({}, async ({ internals }) => {
    await assert.rejects(() => internals.invoke('settings:not-a-real-channel', {}, {}), /No handler registered/);
  });
});

test('unsubscribe() removes every handler, so re-attaching after it does not throw "second handler" errors', async () => {
  const r = rig({});
  r.unsubscribe();
  assert.doesNotThrow(() => { const again = attachSettingsIpc(r.electron.ipcMain, r.app, { isTrusted: () => true }); again(); });
  r.app._teardown();
});

// ---------------------------------------------------------------- settings:get / describe-providers

test('settings:get returns the real current settings AND the key storage mode/summary', async () => {
  await withRig({}, async ({ invoke, app }) => {
    const res = await invoke('settings:get');
    assert.deepStrictEqual(res.settings, app.settings.get());
    // fakeElectron() defaults safeStorage to a working keyring (see test/helpers/fake-electron.js), so
    // this is the realistic "everything is fine" baseline, not session/no-keyring.
    assert.strictEqual(res.keyStorage.mode, 'keyring');
    assert.match(res.keyStorage.summary, /encrypted with your system keyring/);
  });
});

test('settings:describe-providers reflects live changes made through settings:add-route etc', async () => {
  await withRig({}, async ({ invoke }) => {
    const before = await invoke('settings:describe-providers');
    const add = await invoke('settings:add-route', 'grok');
    assert.strictEqual(add.ok, true);
    const after = await invoke('settings:describe-providers');
    assert.strictEqual(after.routes.length, before.routes.length + 1);
    assert.ok(after.routes.some((r) => r.id === add.id && r.kind === 'grok'));
  });
});

// ---------------------------------------------------------------- settings:update (generic patch)

test('settings:update applies a valid patch and returns the new settings', async () => {
  await withRig({}, async ({ invoke, app }) => {
    const res = await invoke('settings:update', { dock: { edge: 'right' } });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.settings.dock.edge, 'right');
    assert.strictEqual(app.settings.get().dock.edge, 'right', 'the REAL settings store was actually updated');
  });
});

test('settings:update REJECTS a `providers` patch (that must go through the route-specific actions)', async () => {
  await withRig({}, async ({ invoke, app }) => {
    const before = app.settings.get().providers.routes.length;
    const res = await invoke('settings:update', { providers: { routes: [] } });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /provider-specific actions/);
    assert.strictEqual(app.settings.get().providers.routes.length, before, 'routes must be untouched by a rejected patch');
  });
});

test('settings:update rejects non-object / array / null payloads without touching settings', async () => {
  await withRig({}, async ({ invoke, app }) => {
    const before = JSON.stringify(app.settings.get());
    for (const bad of [null, undefined, 'x', 5, [], true]) {
      const res = await invoke('settings:update', bad);
      assert.strictEqual(res.ok, false, JSON.stringify(bad));
    }
    assert.strictEqual(JSON.stringify(app.settings.get()), before);
  });
});

test('a live settings:update actually reaches the running SafetyGate (proves the invoke wiring, not just SettingsStore)', async () => {
  await withRig({}, async ({ invoke, app }) => {
    assert.strictEqual(app.gate.allowDangerous, false);
    await invoke('settings:update', { safety: { allowDangerousKeys: true } });
    assert.strictEqual(app.gate.allowDangerous, true);
  });
});

// ---------------------------------------------------------------- routes: add / update / remove / reorder

test('settings:add-route rejects an invalid kind, and does not add a route', async () => {
  await withRig({}, async ({ invoke, app }) => {
    const before = app.settings.get().providers.routes.length;
    const res = await invoke('settings:add-route', 'not-a-real-provider');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(app.settings.get().providers.routes.length, before);
  });
});

test('settings:add-route: two custom adds never collide, whatever the starting id happens to be', async () => {
  await withRig({}, async ({ invoke }) => {
    const a = await invoke('settings:add-route', 'custom');
    const b = await invoke('settings:add-route', 'custom');
    assert.notStrictEqual(a.id, b.id);
    const desc = await invoke('settings:describe-providers');
    const added = desc.routes.filter((r) => r.id === a.id || r.id === b.id);
    assert.strictEqual(added.length, 2);
  });
});

test('settings:add-route enforces MAX_ROUTES', async () => {
  await withRig({}, async ({ invoke, app }) => {
    const { MAX_ROUTES } = require('../src/main/settings');
    while (app.settings.get().providers.routes.length < MAX_ROUTES) {
      const r = await invoke('settings:add-route', 'custom');
      assert.strictEqual(r.ok, true);
    }
    const overflow = await invoke('settings:add-route', 'custom');
    assert.strictEqual(overflow.ok, false);
    assert.match(overflow.error, new RegExp(String(MAX_ROUTES)));
  });
});

test('settings:update-route changes only the given fields, leaving the rest of the route untouched', async () => {
  await withRig({}, async ({ invoke, app }) => {
    const add = await invoke('settings:add-route', 'custom');
    await invoke('settings:update-route', { id: add.id, model: 'my-model', baseUrl: 'https://example.test/v1' });
    const route = app.settings.get().providers.routes.find((r) => r.id === add.id);
    assert.strictEqual(route.model, 'my-model');
    assert.strictEqual(route.baseUrl, 'https://example.test/v1');
    assert.strictEqual(route.kind, 'custom', 'kind was never touched by this update');
  });
});

test('settings:update-route rejects an unknown route id', async () => {
  await withRig({}, async ({ invoke }) => {
    const res = await invoke('settings:update-route', { id: 'nope-does-not-exist', model: 'x' });
    assert.strictEqual(res.ok, false);
  });
});

test('settings:update-route silently ignores fields outside the allow-list (e.g. an attempt to smuggle in a fake "keys" array or an arbitrary extra field)', async () => {
  await withRig({}, async ({ invoke, app }) => {
    const add = await invoke('settings:add-route', 'custom');
    await invoke('settings:update-route', { id: add.id, keys: ['nvapi-SHOULDNOTAPPEAR'], somethingElse: 1 });
    const json = JSON.stringify(app.settings.get());
    assert.ok(!json.includes('SHOULDNOTAPPEAR'));
    assert.ok(!json.includes('somethingElse'));
  });
});

// A refused edit is refused OUT LOUD and changes nothing. If the settings store were left to clean a bad value it would
// quietly turn it into "use the suggestion" - throwing away the model or address that was working a moment ago, and for
// an address possibly pointing a key at a different host. These tests are why that cannot come back.
const routeNow = (app, id) => app.settings.get().providers.routes.find((r) => r.id === id);
async function workingRoute(invoke) {
  const { id } = await invoke('settings:add-route', 'custom');
  const res = await invoke('settings:update-route', { id, label: 'Mine', model: 'works-fine', baseUrl: 'https://api.example.test/v1', enabled: true });
  assert.strictEqual(res.ok, true);
  return id;
}

test('settings:update-route REFUSES a model name that cannot be used, says why, and keeps the one that works', async () => {
  await withRig({}, async ({ invoke, app }) => {
    const id = await workingRoute(invoke);
    for (const bad of ['has space', 'semi;colon', '<script>', 'quote"s', 'a'.repeat(121), 'new\nline', 'emoji-\u{1F600}']) {
      const res = await invoke('settings:update-route', { id, model: bad });
      assert.strictEqual(res.ok, false, JSON.stringify(bad));
      assert.match(res.error, /model name was not accepted/, JSON.stringify(bad));
      assert.strictEqual(routeNow(app, id).model, 'works-fine', `${JSON.stringify(bad)} must not replace the working model`);
    }
    for (const bad of [5, null, true, {}, ['m']]) {
      const res = await invoke('settings:update-route', { id, model: bad });
      assert.deepStrictEqual(res, { ok: false, error: 'Invalid model.' }, JSON.stringify(bad));
      assert.strictEqual(routeNow(app, id).model, 'works-fine');
    }
    // Names that really are used by providers must still be fine.
    for (const good of ['meta/llama-3.1-70b-instruct', 'gemini-2.0-flash:latest', 'grok-4@2025+beta', 'a'.repeat(120)]) {
      assert.strictEqual((await invoke('settings:update-route', { id, model: good })).ok, true, good);
      assert.strictEqual(routeNow(app, id).model, good);
    }
  });
});

test('settings:update-route REFUSES an address the app will not send a key to, says why, and keeps the one that works', async () => {
  await withRig({}, async ({ invoke, app }) => {
    const id = await workingRoute(invoke);
    const bad = [
      'http://api.example.test/v1',                 // a key must not cross the internet unencrypted
      'ftp://api.example.test/v1', 'file:///etc/passwd', 'javascript:alert(1)',
      'https://user:pass@api.example.test/v1',      // a name and password in the address
      'not a url', 'api.example.test/v1',           // no scheme
      `https://${'a'.repeat(300)}.test/v1`,         // too long to keep whole (a cut-off address is a different address)
    ];
    for (const b of bad) {
      const res = await invoke('settings:update-route', { id, baseUrl: b });
      assert.strictEqual(res.ok, false, b);
      assert.match(res.error, /address was not accepted/, b);
      assert.strictEqual(routeNow(app, id).baseUrl, 'https://api.example.test/v1', `${b} must not replace the working address`);
    }
    for (const bad2 of [5, null, true, {}, ['https://x.test']]) {
      const res = await invoke('settings:update-route', { id, baseUrl: bad2 });
      assert.deepStrictEqual(res, { ok: false, error: 'Invalid address.' }, JSON.stringify(bad2));
      assert.strictEqual(routeNow(app, id).baseUrl, 'https://api.example.test/v1');
    }
    // Plain http is fine for a service running on this very computer.
    for (const local of ['http://localhost:11434/v1', 'http://127.0.0.1:8080/v1', 'http://[::1]:8080/v1']) {
      assert.strictEqual((await invoke('settings:update-route', { id, baseUrl: local })).ok, true, local);
      assert.strictEqual(routeNow(app, id).baseUrl, local);
    }
  });
});

test('settings:update-route is all-or-nothing: one bad field means NOTHING in that request is applied', async () => {
  await withRig({}, async ({ invoke, app }) => {
    const id = await workingRoute(invoke);
    const before = JSON.stringify(routeNow(app, id));
    for (const mixed of [
      { label: 'Renamed', model: 'bad model' }, { label: 'Renamed', baseUrl: 'ftp://x.test' },
      { enabled: false, model: 'bad model' }, { model: 'fine-too', baseUrl: 'nope' }, { label: 'Renamed', enabled: 'off' },
    ]) {
      const res = await invoke('settings:update-route', { id, ...mixed });
      assert.strictEqual(res.ok, false, JSON.stringify(mixed));
      assert.strictEqual(JSON.stringify(routeNow(app, id)), before, `${JSON.stringify(mixed)} was partly applied`);
    }
  });
});

test('settings:update-route trims what was typed, and a blank model or address means "use the suggestion"', async () => {
  await withRig({}, async ({ invoke, app }) => {
    const id = await workingRoute(invoke);
    assert.strictEqual((await invoke('settings:update-route', { id, model: '  padded-model  ', baseUrl: '  https://padded.example.test/v1/  ' })).ok, true);
    assert.strictEqual(routeNow(app, id).model, 'padded-model');
    assert.strictEqual(routeNow(app, id).baseUrl, 'https://padded.example.test/v1');
    for (const blank of ['', '   ', '\t']) {
      await invoke('settings:update-route', { id, model: 'works-fine', baseUrl: 'https://api.example.test/v1' });
      const res = await invoke('settings:update-route', { id, model: blank, baseUrl: blank });
      assert.strictEqual(res.ok, true, JSON.stringify(blank));
      assert.strictEqual(routeNow(app, id).model, '', 'blank model clears it');
      assert.strictEqual(routeNow(app, id).baseUrl, '', 'blank address clears it');
    }
  });
});

test('settings:update-route refuses a name or an on/off value of the wrong type, and changes nothing', async () => {
  await withRig({}, async ({ invoke, app }) => {
    const id = await workingRoute(invoke);
    const before = JSON.stringify(routeNow(app, id));
    for (const bad of [5, null, true, {}, ['a']]) assert.deepStrictEqual(await invoke('settings:update-route', { id, label: bad }), { ok: false, error: 'Invalid name.' }, JSON.stringify(bad));
    for (const bad of ['yes', 'false', 1, 0, null, {}, []]) assert.deepStrictEqual(await invoke('settings:update-route', { id, enabled: bad }), { ok: false, error: 'Invalid setting.' }, JSON.stringify(bad));
    assert.strictEqual(JSON.stringify(routeNow(app, id)), before);
    assert.strictEqual((await invoke('settings:update-route', { id, enabled: false })).ok, true);
    assert.strictEqual(routeNow(app, id).enabled, false);
  });
});

test('settings:remove-route removes the route from settings AND deletes any keys stored for it', async () => {
  await withRig({}, async ({ invoke, app }) => {
    const add = await invoke('settings:add-route', 'grok');
    await invoke('settings:add-key', { routeId: add.id, key: 'xai-REMOVEDROUTETEST0001' });
    assert.strictEqual(app.keyStore.list(add.id).length, 1);
    const res = await invoke('settings:remove-route', add.id);
    assert.strictEqual(res.ok, true);
    assert.ok(!app.settings.get().providers.routes.some((r) => r.id === add.id));
    assert.strictEqual(app.keyStore.list(add.id).length, 0, 'orphaned keys must not linger for a route id that could be reused');
  });
});

test('settings:reorder-routes actually changes the stored priority order (which the ProviderRouter reads on the next task)', async () => {
  await withRig({}, async ({ invoke, app }) => {
    const ids = app.settings.get().providers.routes.map((r) => r.id);
    const reversed = [...ids].reverse();
    const res = await invoke('settings:reorder-routes', reversed);
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(app.settings.get().providers.routes.map((r) => r.id), reversed);
  });
});

test('settings:reorder-routes rejects an order that drops or duplicates a route, leaving the original order intact', async () => {
  await withRig({}, async ({ invoke, app }) => {
    const ids = app.settings.get().providers.routes.map((r) => r.id);
    const before = JSON.stringify(app.settings.get().providers.routes);
    const dropped = await invoke('settings:reorder-routes', ids.slice(1));
    assert.strictEqual(dropped.ok, false);
    const duplicated = await invoke('settings:reorder-routes', [ids[0], ids[0], ...ids.slice(1)]);
    assert.strictEqual(duplicated.ok, false);
    // Same LENGTH as the real list and every id real - but one twice and one missing. A length check alone lets this
    // through and silently deletes a provider.
    const swapped = await invoke('settings:reorder-routes', [ids[0], ids[0], ...ids.slice(2)]);
    assert.strictEqual(swapped.ok, false, 'a repeated id with another one missing must be refused');
    assert.strictEqual(swapped.error, 'The new order does not match the existing providers.');
    const unknown = await invoke('settings:reorder-routes', [...ids, 'not-a-real-id']);
    assert.strictEqual(unknown.ok, false);
    assert.strictEqual(JSON.stringify(app.settings.get().providers.routes), before, 'a rejected reorder must not partially apply');
  });
});

// ---------------------------------------------------------------- keys

test('settings:add-key adds a real key to the real KeyStore, and returns only id/hint - never the secret', async () => {
  await withRig({}, async ({ invoke, app }) => {
    const add = await invoke('settings:add-route', 'grok');
    const res = await invoke('settings:add-key', { routeId: add.id, key: 'xai-REALKEYADDEDVIAIPC01' });
    assert.strictEqual(res.ok, true);
    assert.match(res.hint, /^xai-/);
    assert.ok(!JSON.stringify(res).includes('REALKEYADDEDVIAIPC01'), 'the raw secret must never appear in the IPC response');
    assert.deepStrictEqual(app.keyStore.secrets(add.id), ['xai-REALKEYADDEDVIAIPC01']);
  });
});

test('settings:add-key surfaces KeyStoreError messages instead of throwing across the ipc boundary', async () => {
  await withRig({}, async ({ invoke }) => {
    const add = await invoke('settings:add-route', 'grok');
    const res = await invoke('settings:add-key', { routeId: add.id, key: 'short' });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /API key/);
  });
});

test('settings:add-key rejects a malformed request shape', async () => {
  await withRig({}, async ({ invoke }) => {
    for (const bad of [null, {}, { routeId: 'x' }, { key: 'xai-ABCDEFGH12345678' }, { routeId: 5, key: 'xai-ABCDEFGH12345678' }, 'x']) {
      const res = await invoke('settings:add-key', bad);
      assert.strictEqual(res.ok, false, JSON.stringify(bad));
    }
  });
});

test('settings:remove-key removes exactly the given key, leaving siblings untouched', async () => {
  await withRig({}, async ({ invoke, app }) => {
    const add = await invoke('settings:add-route', 'grok');
    const k1 = await invoke('settings:add-key', { routeId: add.id, key: 'xai-FIRSTKEYAAAAAAAA0001' });
    await invoke('settings:add-key', { routeId: add.id, key: 'xai-SECONDKEYBBBBBBB0002' });
    const res = await invoke('settings:remove-key', { routeId: add.id, keyId: k1.id });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(app.keyStore.secrets(add.id), ['xai-SECONDKEYBBBBBBB0002']);
  });
});

test('settings:remove-key on a key that does not exist reports failure, not silent success', async () => {
  await withRig({}, async ({ invoke }) => {
    const add = await invoke('settings:add-route', 'grok');
    const res = await invoke('settings:remove-key', { routeId: add.id, keyId: 'not-a-real-key-id' });
    assert.strictEqual(res.ok, false);
  });
});

// ---------------------------------------------------------------- settings:test-route (probeRoute over REAL http)

test('settings:test-route against a REAL local http server that answers everything correctly reports usable:true', async () => {
  const http = require('node:http');
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body); seen.push(parsed);
      if (parsed.tools) { res.end(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'report_color', arguments: '{"color":"blue"}' } }] } }] })); return; }
      const hasImage = parsed.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
      res.end(JSON.stringify({ choices: [{ message: { content: hasImage ? 'Red' : 'OK' } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    await withRig({}, async ({ invoke }) => {
      const add = await invoke('settings:add-route', 'custom');
      await invoke('settings:update-route', { id: add.id, model: 'test-model', baseUrl: base });
      await invoke('settings:add-key', { routeId: add.id, key: 'sk-TESTROUTEKEY000000001' });
      const res = await invoke('settings:test-route', { routeId: add.id });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.result.usable, true, JSON.stringify(res.result));
      assert.strictEqual(seen.length, 4, 'text, image, tool call, and the step after it');
      assert.ok(seen[3].messages.some((m) => m.role === 'tool' && m.tool_call_id === 'c1'), 'the last request answers the tool call');
    });
  } finally { server.close(); }
});

test('settings:test-route: SECURITY - the decrypted key used for the real HTTP call never appears anywhere in the IPC response, even in an error', async () => {
  const http = require('node:http');
  const server = http.createServer((req, res) => { res.writeHead(401); res.end(JSON.stringify({ error: `bad key: ${req.headers.authorization}` })); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    await withRig({}, async ({ invoke }) => {
      const add = await invoke('settings:add-route', 'custom');
      await invoke('settings:update-route', { id: add.id, model: 'test-model', baseUrl: base });
      await invoke('settings:add-key', { routeId: add.id, key: 'sk-SECRETMUSTNOTLEAK0001' });
      const res = await invoke('settings:test-route', { routeId: add.id });
      assert.ok(!JSON.stringify(res).includes('SECRETMUSTNOTLEAK'), 'the API key leaked through the Test button result');
    });
  } finally { server.close(); }
});

test('settings:test-route with no keys yet fails clearly, without attempting a network call', async () => {
  await withRig({}, async ({ invoke }) => {
    const add = await invoke('settings:add-route', 'custom');
    await invoke('settings:update-route', { id: add.id, model: 'm', baseUrl: 'https://unreachable.invalid/v1' });
    const res = await invoke('settings:test-route', { routeId: add.id });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /Add an API key/);
  });
});

test('settings:test-route for a route that does not exist', async () => {
  await withRig({}, async ({ invoke }) => {
    const res = await invoke('settings:test-route', { routeId: 'not-a-real-route' });
    assert.strictEqual(res.ok, false);
  });
});

test('settings:test-route can target a SPECIFIC key by id when a route has more than one (this is the exact scenario secretById was added for)', async () => {
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    const goodKey = req.headers.authorization === 'Bearer sk-GOODKEYFORPROBE00001';
    if (!goodKey) { res.writeHead(401); res.end('{}'); return; }
    let body = ''; req.on('data', (c) => (body += c));
    req.on('end', () => { const parsed = JSON.parse(body); res.end(JSON.stringify({ choices: [{ message: { content: parsed.tools ? '' : 'OK', tool_calls: parsed.tools ? [{ id: 'c', type: 'function', function: { name: 'report_color', arguments: '{"color":"blue"}' } }] : undefined } }] })); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    await withRig({}, async ({ invoke }) => {
      const add = await invoke('settings:add-route', 'custom');
      await invoke('settings:update-route', { id: add.id, model: 'm', baseUrl: base });
      const bad = await invoke('settings:add-key', { routeId: add.id, key: 'sk-BADKEYFORPROBE000001' });
      const good = await invoke('settings:add-key', { routeId: add.id, key: 'sk-GOODKEYFORPROBE00001' });
      const usingBad = await invoke('settings:test-route', { routeId: add.id, keyId: bad.id });
      assert.strictEqual(usingBad.result.text.ok, false, 'the bad key must fail');
      const usingGood = await invoke('settings:test-route', { routeId: add.id, keyId: good.id });
      assert.strictEqual(usingGood.result.text.ok, true, 'the good key must succeed');
    });
  } finally { server.close(); }
});

// ---------------------------------------------------------------- migrate-session-keys

test('settings:migrate-session-keys is a no-op while still in session mode (no keyring, no opt-in)', async () => {
  await withRig({}, async ({ invoke }) => {
    const add = await invoke('settings:add-route', 'grok');
    await invoke('settings:add-key', { routeId: add.id, key: 'xai-MIGRATENOOPTEST0001' });
    const res = await invoke('settings:migrate-session-keys');
    assert.strictEqual(res.migrated, 0);
  });
});

test('settings:migrate-session-keys persists in-memory keys once the file-storage policy is turned on', async () => {
  // KeyStore.mode() re-checks safeStorage.isEncryptionAvailable() on every call (no caching), so it does
  // not matter that this runs after rig()'s internal app.create() - only that it runs before the
  // add-key call below, which is when mode() first actually gets consulted.
  const r = rig({});
  r.electron.safeStorage._setAvailable(false); // no keyring: KeyStore is in session mode, matching this test's premise
  try {
    const { invoke, app } = r;
    const add = await invoke('settings:add-route', 'grok');
    await invoke('settings:add-key', { routeId: add.id, key: 'xai-MIGRATETOFILETEST01' });
    assert.strictEqual(app.keyStore.mode(), 'session', 'precondition: no keyring, no opt-in yet');
    assert.strictEqual(app.keyStore.list(add.id)[0].persisted, false);
    await invoke('settings:update', { security: { keyStorage: 'file' } });
    const res = await invoke('settings:migrate-session-keys');
    assert.strictEqual(res.migrated, 1);
    assert.strictEqual(app.keyStore.list(add.id)[0].persisted, true);
  } finally { r.unsubscribe(); r.app._teardown(); }
});


// ---------------------------------------------------------------- settings:check-computer (doctor.js, through the app's own parts)

const checkById = (res) => Object.fromEntries(res.checks.map((c) => [c.id, c]));

test('settings:check-computer reports on this app\'s own screenshot tool and mouse/keyboard connection, and lets go of the connection', async () => {
  await withRig({}, async ({ invoke, computer }) => {
    const res = await invoke('settings:check-computer');
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.checks.map((c) => c.id), ['desktop', 'window', 'screenshot', 'input', 'providers', 'keys']);
    const by = checkById(res);
    assert.strictEqual(by.screenshot.state, 'ok');
    assert.match(by.screenshot.detail, /1366x768/);
    assert.strictEqual(by.input.state, 'ok');
    assert.match(by.input.detail, /GNOME's own input is ready/);
    assert.strictEqual(computer.screen.calls, 1, 'exactly one screenshot');
    assert.strictEqual(by.keys.state, 'ok');
    assert.match(by.keys.detail, /encrypted by your system keyring/);
    // Opened by a harmless move of zero, and let go of again: GNOME's sharing indicator must not stay on after a look.
    assert.deepStrictEqual(computer.backend.log, ['resume', ['moveBy', 0, 0], 'close']);
    assert.strictEqual(typeof res.summary.text, 'string');
  });
});

test('settings:check-computer sees the live provider state: no key is a problem with a fix, a key added through the real action makes it ready', async () => {
  await withRig({}, async ({ invoke }) => {
    const first = await invoke('settings:check-computer');
    assert.strictEqual(checkById(first).providers.state, 'problem');
    assert.match(checkById(first).providers.fix, /Settings > Providers/);
    assert.ok(first.summary.problems >= 1);
    const KEY = 'xai-DOCTORCHECKKEY000001';
    assert.strictEqual((await invoke('settings:add-key', { routeId: 'grok', key: KEY })).ok, true);
    const second = await invoke('settings:check-computer');
    assert.strictEqual(checkById(second).providers.state, 'ok', JSON.stringify(checkById(second).providers));
    assert.match(checkById(second).providers.detail, /Grok is ready/);
    assert.ok(!JSON.stringify(second).includes('DOCTORCHECKKEY'), 'an API key is never part of an answer');
  });
});

test('settings:check-computer tells the truth about where keys are kept: no system keyring means memory only, and a warning', async () => {
  const r = rig({});
  r.electron.safeStorage._setAvailable(false);               // this computer has no keyring
  try {
    assert.strictEqual((await r.invoke('settings:add-key', { routeId: 'grok', key: 'xai-DOCTORMEMORYONLY0001' })).ok, true);
    const keys = checkById(await r.invoke('settings:check-computer')).keys;
    assert.strictEqual(keys.state, 'warn');
    assert.match(keys.detail, /kept in memory only/);
    assert.match(keys.fix, /Key storage/);
  } finally { r.unsubscribe(); r.app._teardown(); }
});

test('settings:check-computer: a tool that fails is a problem ROW in a normal answer, and the connection that failed to open is still let go of', async () => {
  const computer = { screen: { fail: 'No screenshot tool found for GNOME. Install gnome-screenshot.' }, backend: { async moveBy() { throw new Error('no session bus'); } } };
  await withRig({ computer }, async ({ invoke, computer: c }) => {
    const res = await invoke('settings:check-computer');
    assert.strictEqual(res.ok, true, 'the check worked; what it found is in the rows');
    const by = checkById(res);
    assert.strictEqual(by.screenshot.state, 'problem');
    assert.match(by.screenshot.detail, /No screenshot tool found/);
    assert.strictEqual(by.input.state, 'problem');
    assert.match(by.input.detail, /no session bus/);
    assert.deepStrictEqual(c.backend.log, ['resume', 'close']);
  });
});

test('settings:check-computer while a task is running: no screenshot, nothing asked of the mouse and keyboard, and it says why', async () => {
  await withRig({}, async ({ invoke, app, computer }) => {
    let release; const held = new Promise((r) => { release = r; });
    app._createAgent = () => ({ on() {}, stop() {}, run: () => held });
    const finished = new Promise((r) => app.runner.once('finished', r));
    const started = app.runner.submit('a task');
    const before = computer.backend.log.slice();             // the task's own start (it released an old Stop)
    const res = await invoke('settings:check-computer');
    const by = checkById(res);
    assert.strictEqual(by.screenshot.state, 'skipped');
    assert.strictEqual(by.input.state, 'skipped');
    assert.match(by.screenshot.detail, /A task is running/);
    assert.strictEqual(computer.screen.calls, 0);
    assert.deepStrictEqual(computer.backend.log, before, 'not one request to the mouse and keyboard connection: a Stop pressed during the task must stay pressed');
    release({ ok: true, summary: 'done', steps: 1, stoppedBy: 'finish' });
    await finished; await started;
  });
});

test('settings:check-computer: asking again while a check runs gets that check\'s answer, and a later ask is a new check', async () => {
  await withRig({ computer: { screen: { delayMs: 40 } } }, async ({ invoke, computer }) => {
    const [a, b] = await Promise.all([invoke('settings:check-computer'), invoke('settings:check-computer')]);
    assert.strictEqual(computer.screen.calls, 1, 'two asks at once are one check');
    assert.deepStrictEqual(a, b);
    await invoke('settings:check-computer');
    assert.strictEqual(computer.screen.calls, 2, 'a later check looks again');
  });
});

// ---------------------------------------------------------------- WHO is asking

// A plausible, valid payload for every channel, so a refusal below can only be about the CALLER, not the content.
const NO_PAYLOAD = ['settings:get', 'settings:describe-providers', 'settings:load-issue', 'settings:migrate-session-keys', 'settings:check-computer'];
const VALID = {
  'settings:add-route': 'grok',
  'settings:update': { tray: { enabled: true } },
  'settings:update-route': { id: 'grok', model: 'sneaky-model' },
  'settings:remove-route': 'grok',
  'settings:reorder-routes': ['gemini', 'grok', 'nvidia-fallback', 'nvidia-primary'],
  'settings:add-key': { routeId: 'grok', key: 'xai-TRUSTGATETEST0001' },
  'settings:remove-key': { routeId: 'grok', keyId: 'abcd1234' },
  'settings:test-route': { routeId: 'grok' },
};

test('attachSettingsIpc refuses to be attached without a trust check (no "serve anyone" default)', () => {
  const r = rig({});
  r.unsubscribe();
  for (const opts of [undefined, {}, { isTrusted: undefined }, { isTrusted: 'yes' }, { isTrusted: true }, { isTrusted: null }]) {
    assert.throws(() => attachSettingsIpc(r.electron.ipcMain, r.app, opts), /isTrusted/, JSON.stringify(opts));
    assert.deepStrictEqual(r.internals.handledChannels().filter((c) => c.startsWith('settings:')), [], 'a refused attach must not leave handlers behind');
  }
  r.app._teardown();
});

test('EVERY settings channel refuses a caller that is not the Settings page - including the island\'s own page', async () => {
  await withRig({}, async ({ internals, app, invoke, computer }) => {
    const channels = internals.handledChannels().filter((c) => c.startsWith('settings:'));     // the workspace window's ws: channels are covered by workspace-app.test.js
    // The list must match EXACTLY: a new channel that is not added to VALID (or NO_PAYLOAD) fails here, so no
    // channel can ever ship without being covered by the trust-gate checks below.
    assert.deepStrictEqual([...channels].sort(), [...Object.keys(VALID), ...NO_PAYLOAD].sort(),
      'the set of settings channels changed - add the new channel to VALID (or NO_PAYLOAD) so the trust gate covers it');
    const before = { settings: app.settings.get(), keys: app.keyStore.list('grok') };
    const pillPage = app.dockWindow.win.webContents;       // a real, different renderer in this app
    const strangers = { 'the island page': pillPage, 'an unknown renderer': { id: 99 }, 'no sender at all': undefined, 'null sender': null };
    for (const channel of channels) {
      for (const [who, sender] of Object.entries(strangers)) {
        const res = await internals.invoke(channel, VALID[channel], sender);
        assert.deepStrictEqual(res, { ok: false, error: 'Not allowed.' }, `${channel} answered ${who}: ${JSON.stringify(res)}`);
      }
    }
    assert.deepStrictEqual(app.settings.get(), before.settings, 'a refused request must change nothing');
    assert.deepStrictEqual(app.keyStore.list('grok'), before.keys, 'no key may be added by a stranger');
    assert.strictEqual(computer.screen.calls, 0, 'a stranger must not be able to make ALLES take a screenshot');
    assert.deepStrictEqual(computer.backend.log, [], 'a stranger must not be able to open the mouse and keyboard connection');
    // ...and the same payloads are NOT refused for the real page (so the refusals above were about the caller).
    for (const channel of channels) {
      const res = await invoke(channel, VALID[channel]);
      assert.notStrictEqual(res.error, 'Not allowed.', `${channel} refused the real Settings page`);
    }
  });
});

test('a stranger cannot read API key hints, provider details or app info either', async () => {
  await withRig({}, async ({ invoke, internals, app }) => {
    await invoke('settings:add-key', { routeId: 'grok', key: 'xai-SECRETHINTCHECK0001' });
    const pillPage = app.dockWindow.win.webContents;
    for (const channel of ['settings:get', 'settings:describe-providers', 'settings:load-issue']) {
      const res = await internals.invoke(channel, undefined, pillPage);
      assert.ok(!JSON.stringify(res).includes('xai-'), `${channel} leaked a key hint to the island page`);
      assert.strictEqual(res.ok, false);
    }
  });
});

test('a stranger cannot make the app send an API key anywhere (settings:test-route never reaches the network)', async () => {
  const http = require('node:http');
  let hits = 0;
  const server = http.createServer((req, res) => { hits++; res.end('{}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    await withRig({}, async ({ invoke, internals, app }) => {
      const add = await invoke('settings:add-route', 'custom');
      await invoke('settings:update-route', { id: add.id, model: 'm', baseUrl: base });
      await invoke('settings:add-key', { routeId: add.id, key: 'custom-NETWORKGATE0001' });
      const res = await internals.invoke('settings:test-route', { routeId: add.id }, app.dockWindow.win.webContents);
      assert.deepStrictEqual(res, { ok: false, error: 'Not allowed.' });
      assert.strictEqual(hits, 0, 'the provider was contacted on behalf of a stranger');
    });
  } finally { server.close(); }
});

test('trust is judged on EVERY call: a closed Settings window\'s old page loses access at once', async () => {
  await withRig({}, async ({ invoke, internals, app, sender }) => {
    assert.strictEqual((await invoke('settings:get')).ok, true);
    app.settingsWindow.close();
    assert.deepStrictEqual(await internals.invoke('settings:get', undefined, sender), { ok: false, error: 'Not allowed.' });
    const fresh = app.settingsWindow.open().webContents;
    assert.strictEqual((await internals.invoke('settings:get', undefined, fresh)).ok, true);
    assert.deepStrictEqual(await internals.invoke('settings:get', undefined, sender), { ok: false, error: 'Not allowed.' }, 'the old page is still a stranger');
  });
});

test('a trust check that throws, or answers with anything but exactly true, means NO', async () => {
  const r = rig({});
  r.unsubscribe();
  const sender = r.sender;
  const tryWith = async (isTrusted) => {
    const off = attachSettingsIpc(r.electron.ipcMain, r.app, { isTrusted });
    try { return await r.internals.invoke('settings:get', undefined, sender); } finally { off(); }
  };
  assert.deepStrictEqual(await tryWith(() => { throw new Error('boom'); }), { ok: false, error: 'Not allowed.' });
  for (const answer of [1, 'yes', {}, [], 'true', undefined, null, 0]) {
    assert.deepStrictEqual(await tryWith(() => answer), { ok: false, error: 'Not allowed.' }, `treated ${JSON.stringify(answer)} as a yes`);
  }
  assert.strictEqual((await tryWith(() => true)).ok, true);
  r.app._teardown();
});

test('settings:get also carries read-only app info for the About section', async () => {
  await withRig({}, async ({ invoke }) => {
    const { info } = await invoke('settings:get');
    assert.strictEqual(info.name, 'ALLES');
    assert.strictEqual(info.version, '0.0.0-test');
    assert.strictEqual(typeof info.desktop, 'string');
    assert.strictEqual(info.shortcut, 'Control+Shift+D');
    assert.strictEqual(typeof info.shortcutRegistered, 'boolean');
    assert.ok(!JSON.stringify(info).match(/\bkeys?\b|secret|token|api/i), 'nothing that looks like a secret ( "keyboard" is a word of its own and fine)');
    assert.deepStrictEqual(Object.keys(info.input).sort(), ['auto', 'drag', 'fellBackBecause', 'label', 'mode', 'name', 'pending', 'scroll', 'unicode']);
  });
});
