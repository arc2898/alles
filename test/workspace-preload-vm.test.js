'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { loadPreload } = require('./helpers/preload-vm');
const V = require('../src/workspace/voice-model');

const FILE = path.join(__dirname, '../src/workspace/preload.cjs');
const load = (opts) => loadPreload(FILE, opts);
const call = async (name, payload, opts) => { const p = load(opts); const reply = await p.api.invoke(name, payload); return { reply, invoked: p.invoked, raw: p.rawInvoked }; };
const forwarded = async (name, payload) => (await call(name, payload)).invoked;
const wav = V.encodeWav(new Int16Array(8000), 16000);

test('the REAL preload runs, exposes window.alles with exactly invoke and onEvent, and requires nothing but electron', () => {
  const { api, exposedAs } = load();
  assert.strictEqual(exposedAs, 'alles');
  assert.deepStrictEqual(Object.keys(api).sort(), ['invoke', 'onEvent']);
});

test('HOSTILE NAMES: inherited keys, near-misses and settings/other windows\' channels are refused; nothing is sent', async () => {
  const names = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'ws:', 'ws:state ', ' ws:state', 'WS:state', 'ws:nope', 'settings:get', 'settings:add-key', 'pill:event', 'ws:update-settings:x', null, undefined, 5, {}, ['ws:state']];
  for (const name of names) {
    const { reply, invoked } = await call(name, {});
    assert.deepStrictEqual(invoked, [], `"${String(name)}" got through`);
    assert.strictEqual(reply.ok, false); assert.match(reply.error, /Unknown action/);
  }
});

test('no-payload requests forward the channel only, whatever the page adds', async () => {
  for (const name of ['ws:state', 'ws:chat-stop', 'ws:history-clear', 'ws:code-pick', 'ws:code-stop', 'ws:code-tree', 'ws:code-revert-all', 'ws:speak-stop', 'ws:transcribe-stop']) {
    assert.deepStrictEqual(await forwarded(name, { evil: 1 }), [[name]], name);
    assert.deepStrictEqual(await forwarded(name, undefined), [[name]], name);
  }
});

test('session ids: 6-24 lowercase letters or digits, nothing that could become a path', async () => {
  for (const name of ['ws:history-get', 'ws:history-delete', 'ws:history-export']) {
    assert.deepStrictEqual(await forwarded(name, 'abc123def456'), [[name, 'abc123def456']]);
    for (const bad of ['', 'abc', '../../etc/passwd', 'ABC123DEF456', 'a/b/c/d/e/f', 'x'.repeat(25), null, undefined, 5, {}, ['abc123def456'], { id: 'abc123def456' }]) {
      assert.deepStrictEqual(await forwarded(name, bad), [], `${name} accepted ${JSON.stringify(bad)}`);
    }
  }
});

test('settings patch: only history, speech and code fields of the right type; everything else is dropped; nothing valid left = refused', async () => {
  const name = 'ws:update-settings';
  const sent = (await forwarded(name, { code: { autonomy: 'full', lastProject: '/x', maxSteps: 30 }, speech: { speakReplies: true, ttsEngine: 'rm', ttsRate: 1.5, __proto__: { x: 1 } }, safety: { requireApprovalForShell: false }, providers: { routes: [] }, history: { enabled: false, extra: 1 } }))[0][1];
  assert.deepStrictEqual(sent, { code: { autonomy: 'full', maxSteps: 30 }, speech: { speakReplies: true, ttsRate: 1.5 }, history: { enabled: false } });
  assert.deepStrictEqual(await forwarded(name, { safety: { requireApprovalForShell: false } }), []);
  assert.deepStrictEqual(await forwarded(name, { code: { autonomy: 'yolo' } }), []);
  assert.deepStrictEqual(await forwarded(name, { speech: { ttsRate: Infinity, ttsVoice: 5 } }), []);
  for (const bad of [null, undefined, 'x', [], 5]) assert.deepStrictEqual(await forwarded(name, bad), []);
});

test('chat: needs text; optional session id and spoken flag are checked; extra fields are dropped', async () => {
  const name = 'ws:chat-send';
  assert.deepStrictEqual((await forwarded(name, { text: 'hi', sessionId: 'abc123def456', spoken: true, evil: 1 }))[0][1], { text: 'hi', sessionId: 'abc123def456', spoken: true });
  assert.deepStrictEqual((await forwarded(name, { text: 'hi', sessionId: null }))[0][1], { text: 'hi' });
  for (const bad of [{ text: '' }, { text: 'x'.repeat(8001) }, { text: 5 }, { text: 'hi', sessionId: '../x' }, { text: 'hi', spoken: 'yes' }, {}, null, 'hi']) assert.deepStrictEqual(await forwarded(name, bad), [], JSON.stringify(bad));
});

test('history list and rename: bounded text, a known kind', async () => {
  assert.deepStrictEqual((await forwarded('ws:history-list', undefined))[0], ['ws:history-list', {}]);
  assert.deepStrictEqual((await forwarded('ws:history-list', { query: 'cart', kind: 'code', x: 1 }))[0][1], { query: 'cart', kind: 'code' });
  assert.deepStrictEqual(await forwarded('ws:history-list', { kind: 'secrets' }), []);
  assert.deepStrictEqual(await forwarded('ws:history-list', { query: 'x'.repeat(201) }), []);
  assert.deepStrictEqual((await forwarded('ws:history-rename', { id: 'abc123def456', title: 'New' }))[0][1], { id: 'abc123def456', title: 'New' });
  assert.deepStrictEqual(await forwarded('ws:history-rename', { id: 'abc123def456', title: '' }), []);
  assert.deepStrictEqual(await forwarded('ws:history-rename', { id: '../x', title: 'New' }), []);
});

test('text requests (code, speak) are bounded strings', async () => {
  for (const [name, max] of [['ws:code-open', 1000], ['ws:code-submit', 12000], ['ws:code-diff', 1000], ['ws:code-revert', 1000], ['ws:speak', 20000]]) {
    assert.deepStrictEqual(await forwarded(name, 'ok'), [[name, 'ok']]);
    for (const bad of ['', 'x'.repeat(max + 1), 5, null, {}, ['a']]) assert.deepStrictEqual(await forwarded(name, bad), [], `${name} ${JSON.stringify(bad)}`);
  }
});

test('approval answers: a text id and a real boolean, nothing else', async () => {
  assert.deepStrictEqual((await forwarded('ws:approval-answer', { id: 'q-1', allow: true, evil: 1 }))[0][1], { id: 'q-1', allow: true });
  for (const bad of [{ id: 'q-1', allow: 'true' }, { id: 'q-1', allow: 1 }, { id: '', allow: true }, { allow: true }, null, 'q-1']) assert.deepStrictEqual(await forwarded('ws:approval-answer', bad), [], JSON.stringify(bad));
});

test('audio: only a real byte array of a plausible size gets through', async () => {
  const name = 'ws:transcribe';
  const ok = await forwarded(name, { audio: wav });
  assert.strictEqual(ok.length, 1);
  for (const bad of [{ audio: 'a string' }, { audio: new Uint8Array(10) }, { audio: new Uint8Array(13 * 1024 * 1024) }, { audio: [1, 2, 3] }, { audio: { length: 5000 } }, {}, null, 'x']) assert.deepStrictEqual(await forwarded(name, bad), [], JSON.stringify(Object.keys(bad || {})));
  const ab = await forwarded(name, { audio: wav.buffer });
  assert.strictEqual(ab.length, 1, 'an ArrayBuffer is fine too');
});

test('a reply that is not an object, or a rejected request, becomes {ok:false} - invoke never throws or rejects', async () => {
  assert.strictEqual((await call('ws:state', undefined, { reply: () => 'nope' })).reply.ok, false);
  assert.strictEqual((await call('ws:state', undefined, { reply: () => { throw new Error('boom'); } })).reply.ok, false);
  assert.deepStrictEqual((await call('ws:state', undefined, { reply: () => ({ ok: true, x: 1 }) })).reply, { ok: true, x: 1 });
  const hostile = { get text() { throw new Error('trap'); } };
  assert.strictEqual((await call('ws:chat-send', hostile)).reply.ok, false);
});

test('onEvent: one page callback at a time, limited in number; a throwing callback does not break the bridge', () => {
  const p = load();
  p.api.onEvent('not a function');
  assert.strictEqual((p.listeners['ws:event'] || []).length, 0);
  for (let i = 0; i < 10; i++) p.api.onEvent(() => {});
  assert.strictEqual(p.listeners['ws:event'].length, 4);
  const q = load(); let got = null;
  q.api.onEvent(() => { throw new Error('page bug'); }); q.api.onEvent((x) => { got = x; });
  assert.doesNotThrow(() => q.emit('ws:event', { type: 'code' }));
});
