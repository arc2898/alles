'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { attachWorkspaceIpc } = require('../src/main/workspace-ipc');
const { SettingsStore } = require('../src/main/settings');
const { HistoryStore } = require('../src/main/history');
const { ApprovalBroker } = require('../src/main/approvals');
const { tmpDir } = require('./helpers/tmp');
const V = require('../src/workspace/voice-model');

function rig({ trusted = true } = {}) {
  const dir = tmpDir('alles-wsipc-');
  const handlers = {};
  const ipcMain = { handle: (n, f) => { handlers[n] = f; }, removeHandler: (n) => { delete handlers[n]; } };
  const settings = new SettingsStore(path.join(dir, 'settings.json'), { setTimer: () => null });
  const history = new HistoryStore({ dir: path.join(dir, 'h'), setTimer: () => null });
  const broker = new ApprovalBroker();
  const spoken = []; const transcribed = []; const calls = [];
  const speaker = { detect: () => ({ chosen: 'espeak-ng', engines: {} }), speak: async (t) => { spoken.push(t); return spoken.length === 99 ? { ok: false } : { ok: true, engine: 'espeak-ng' }; }, stop: () => calls.push('speak-stop') };
  const transcriber = { detect: () => ({ chosen: 'whisper-cli', whisper: {}, http: {} }), transcribe: async (wav, { signal }) => { transcribed.push(wav); return { ok: true, text: 'hello there', engine: 'whisper-cli' }; } };
  const chat = { convos: new Map(), send: async (o) => ({ ok: true, sessionId: o.sessionId || 'abcdef123456', reply: `echo ${o.text}`, got: o }), stop: () => true, forget: () => {} };
  const code = { info: null, open: (root) => (root.startsWith('/ok') ? { ok: true, project: { name: 'p', root }, tree: { entries: [] } } : { ok: false, error: 'That folder does not exist.' }), submit: async (t) => ({ ok: true, summary: `did ${t}` }), stop: () => calls.push('code-stop'), tree: () => ({ entries: ['a'], truncated: false }), readFile: (rel) => (rel === 'a.js' ? { ok: true, path: rel, content: 'const x = 1;' } : { ok: false, error: 'missing' }), writeFile: (rel, content) => (rel === 'a.js' ? { ok: true, path: rel, changes: [{ path: rel, content }] } : { ok: false, error: 'outside project' }), diff: (r) => (r === 'a.js' ? '@@ diff' : null), revert: (r) => ({ ok: r === 'a.js' }), revertAll: () => ({ ok: true, results: [] }) };
  const dialogs = []; const saveTo = path.join(dir, 'out.md');
  const dialog = { showOpenDialog: async (w, o) => { dialogs.push(o); return { canceled: false, filePaths: ['/ok/project'] }; }, showSaveDialog: async (w, o) => { dialogs.push(o); return { canceled: false, filePath: saveTo }; } };
  const ctx = { settings, history, chat, code, speaker, transcriber, broker, dialog, window: { win: null }, describeProviders: () => [{ id: 'nvidia-primary', label: 'NVIDIA', keys: [{ hint: '…abcd' }], baseUrl: 'https://secret.example/v1' }] };
  const bound = attachWorkspaceIpc(ipcMain, ctx, { isTrusted: () => trusted });
  const call = (name, payload) => handlers[name]({}, payload);
  return { call, handlers, ctx, spoken, transcribed, calls, dialogs, saveTo, bound, history, settings, broker };
}

test('it refuses to start without a way to tell who is asking', () => {
  assert.throws(() => attachWorkspaceIpc({ handle() {} }, {}, {}), /needs isTrusted/);
});

test('every request from anyone but the workspace page is refused, and nothing runs', async () => {
  const r = rig({ trusted: false });
  for (const name of r.bound.names) assert.deepStrictEqual(await r.call(name, {}), { ok: false, error: 'Not allowed.' }, name);
  assert.deepStrictEqual(r.spoken, []);
});

test('state: settings, what can speak and listen, providers by NAME only (no keys, no addresses)', async () => {
  const r = rig();
  const s = await r.call('ws:state');
  assert.strictEqual(s.ok, true);
  assert.deepStrictEqual(Object.keys(s.settings).sort(), ['code', 'history', 'speech']);
  assert.strictEqual(s.speech.tts.chosen, 'espeak-ng');
  assert.deepStrictEqual(s.providers, [{ id: 'nvidia-primary', label: 'NVIDIA' }]);
  const text = JSON.stringify(s);
  assert.ok(!text.includes('secret.example') && !text.includes('abcd'));
});

test('update-settings changes only history, speech and code - never providers, safety or keys', async () => {
  const r = rig();
  const before = r.settings.get();
  const out = await r.call('ws:update-settings', { code: { autonomy: 'full', lastProject: '/x' }, speech: { speakReplies: true, nope: 1 }, safety: { requireApprovalForShell: false }, providers: { routes: [] }, security: { keyStorage: 'file' }, dock: { edge: 'left' }, history: { enabled: false } });
  assert.strictEqual(out.ok, true);
  const now = r.settings.get();
  assert.strictEqual(now.code.autonomy, 'full'); assert.strictEqual(now.speech.speakReplies, true); assert.strictEqual(now.history.enabled, false);
  assert.strictEqual(now.code.lastProject, '', 'a field that is not on the list is ignored');
  assert.deepStrictEqual(now.safety, before.safety); assert.deepStrictEqual(now.providers, before.providers); assert.deepStrictEqual(now.security, before.security); assert.deepStrictEqual(now.dock, before.dock);
  assert.strictEqual((await r.call('ws:update-settings', { safety: { x: 1 } })).ok, false);
  assert.strictEqual((await r.call('ws:update-settings', 'x')).ok, false);
});

test('chat: passes the text, the session and the "spoken" flag; a bad session id is refused', async () => {
  const r = rig();
  const a = await r.call('ws:chat-send', { text: 'hi', spoken: true });
  assert.deepStrictEqual([a.ok, a.reply, a.got.spoken, a.got.sessionId], [true, 'echo hi', true, null]);
  assert.strictEqual((await r.call('ws:chat-send', { text: 'hi', sessionId: '../../x' })).ok, false);
  assert.strictEqual((await r.call('ws:chat-send', null)).ok, false);
});

test('history: list (with search and kind), get, rename, delete, clear, and ids that are not ids', async () => {
  const r = rig();
  const a = r.history.create({ kind: 'chat', title: 'Zebras' }); r.history.append(a, { kind: 'user', text: 'about stripes' });
  const b = r.history.create({ kind: 'code', title: 'Cart' });
  assert.deepStrictEqual((await r.call('ws:history-list', {})).sessions.map((s) => s.title).sort(), ['Cart', 'Zebras']);
  assert.deepStrictEqual((await r.call('ws:history-list', { query: 'stripes' })).sessions.map((s) => s.title), ['Zebras']);
  assert.deepStrictEqual((await r.call('ws:history-list', { kind: 'code' })).sessions.map((s) => s.title), ['Cart']);
  assert.strictEqual((await r.call('ws:history-get', a)).events.length, 1);
  assert.strictEqual((await r.call('ws:history-get', '../x')).ok, false);
  assert.strictEqual((await r.call('ws:history-rename', { id: a, title: 'Stripes' })).ok, true);
  assert.strictEqual((await r.call('ws:history-rename', { id: a, title: '  ' })).ok, false);
  assert.strictEqual((await r.call('ws:history-delete', b)).ok, true);
  assert.strictEqual((await r.call('ws:history-delete', b)).ok, false);
  assert.deepStrictEqual(await r.call('ws:history-clear'), { ok: true, removed: 1 });
});

test('history export asks where to save, writes Markdown there, and "cancel" saves nothing', async () => {
  const r = rig();
  const id = r.history.create({ title: 'My talk' }); r.history.append(id, { kind: 'user', text: 'hello' });
  const out = await r.call('ws:history-export', id);
  assert.deepStrictEqual([out.ok, out.saved], [true, r.saveTo]);
  assert.match(fs.readFileSync(r.saveTo, 'utf8'), /\*\*You:\*\* hello/);
  assert.strictEqual(r.dialogs[0].defaultPath, 'My talk.md');
  r.ctx.dialog.showSaveDialog = async () => ({ canceled: true });
  assert.deepStrictEqual(await r.call('ws:history-export', id), { ok: true, saved: null });
  assert.strictEqual((await r.call('ws:history-export', 'nope12345')).ok, false);
});

test('code: pick a folder (remembered), open a path, a bad folder says why, submit/diff/revert pass through', async () => {
  const r = rig();
  const picked = await r.call('ws:code-pick');
  assert.strictEqual(picked.ok, true); assert.strictEqual(r.settings.get().code.lastProject, '/ok/project');
  assert.deepStrictEqual(r.dialogs[0].properties, ['openDirectory']);
  assert.match((await r.call('ws:code-open', '/nope')).error, /does not exist/);
  assert.strictEqual((await r.call('ws:code-open', 42)).ok, false);
  assert.deepStrictEqual(await r.call('ws:code-submit', 'build it'), { ok: true, summary: 'did build it' });
  assert.deepStrictEqual(await r.call('ws:code-diff', 'a.js'), { ok: true, diff: '@@ diff' });
  assert.strictEqual((await r.call('ws:code-diff', 'zzz')).ok, false);
  assert.strictEqual((await r.call('ws:code-revert', 'a.js')).ok, true);
  await r.call('ws:code-stop'); assert.ok(r.calls.includes('code-stop'));
  r.ctx.dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  assert.deepStrictEqual(await r.call('ws:code-pick'), { ok: true, opened: false });
});

test('the IDE editor IPC reads and saves only validated file requests', async () => {
  const r = rig();
  assert.deepStrictEqual(await r.call('ws:code-read', 'a.js'), { ok: true, path: 'a.js', content: 'const x = 1;' });
  assert.strictEqual((await r.call('ws:code-read', '../outside')).ok, false);
  assert.deepStrictEqual(await r.call('ws:code-write', { path: 'a.js', content: 'const x = 2;', hash: 'a'.repeat(64) }), { ok: true, path: 'a.js', changes: [{ path: 'a.js', content: 'const x = 2;' }] });
  assert.strictEqual((await r.call('ws:code-write', { path: '../outside', content: 'x', hash: 'a'.repeat(64) })).ok, false);
  assert.strictEqual((await r.call('ws:code-write', { path: 'a.js', content: 42, hash: 'a'.repeat(64) })).ok, false);
});

test('a failing request never throws to the caller: it comes back as {ok:false}', async () => {
  const r = rig();
  r.ctx.code.tree = () => { throw new Error('disk on fire'); };
  assert.deepStrictEqual(await r.call('ws:code-tree'), { ok: false, error: 'disk on fire' });
});

test('approval answers go to the broker; a stale or invalid answer is refused', async () => {
  const r = rig();
  const seen = []; r.broker.on('resolved', (x) => seen.push(x));
  const p = r.broker.request({ tool: 'run_shell', command: 'ls', cwd: '/p' });
  let q; r.broker.on('request', (x) => { q = x; });
  await new Promise((x) => setImmediate(x));
  const id = r.broker.head.id;
  assert.strictEqual((await r.call('ws:approval-answer', { id: 'wrong', allow: true })).ok, false);
  assert.strictEqual((await r.call('ws:approval-answer', { id, allow: 'yes' })).ok, false);
  assert.strictEqual((await r.call('ws:approval-answer', { id, allow: false })).ok, true);
  assert.strictEqual((await p).allow, false);
  assert.strictEqual((await r.call('ws:approval-answer', { id, allow: true })).ok, false, 'a second answer to the same question does nothing');
  assert.ok(!q || q);
});

test('speak: the text is cleaned first; the browser fallback gets the cleaned words; failures are explained', async () => {
  const r = rig();
  const a = await r.call('ws:speak', 'Done. See **the** [docs](https://x.y).\n```js\ncode\n```');
  assert.deepStrictEqual([a.ok, a.spoke, a.engine], [true, true, 'espeak-ng']);
  assert.strictEqual(r.spoken[0], V.speakable('Done. See **the** [docs](https://x.y).\n```js\ncode\n```'));
  assert.ok(!r.spoken[0].includes('https') && !r.spoken[0].includes('```'));
  assert.deepStrictEqual(await r.call('ws:speak', '```\nonly\n```').then((x) => x.spoke), true);
  r.ctx.speaker.speak = async () => ({ ok: false, reason: 'use-browser' });
  const b = await r.call('ws:speak', 'Hello there');
  assert.deepStrictEqual([b.spoke, b.reason, b.words], [false, 'use-browser', 'Hello there']);
  r.ctx.speaker.speak = async () => ({ ok: false, reason: 'no-engine', error: 'not installed' });
  const c = await r.call('ws:speak', 'Hello');
  assert.deepStrictEqual([c.spoke, c.reason, c.error, c.words], [false, 'no-engine', 'not installed', undefined]);
  assert.deepStrictEqual(await r.call('ws:speak', '   '), { ok: true, spoke: false, reason: 'empty' });
  await r.call('ws:speak-stop'); assert.ok(r.calls.includes('speak-stop'));
});

test('transcribe: the recording goes to the transcriber, one at a time, and Stop ends it', async () => {
  const r = rig();
  const wav = V.encodeWav(new Int16Array(16000), 16000);
  const out = await r.call('ws:transcribe', { audio: wav });
  assert.deepStrictEqual(out, { ok: true, text: 'hello there', engine: 'whisper-cli' });
  assert.strictEqual(r.transcribed[0].length, wav.length);
  assert.strictEqual((await r.call('ws:transcribe', {})).ok, false);
  let release; let signal;
  r.ctx.transcriber.transcribe = (w, o) => new Promise((res) => { signal = o.signal; release = () => res({ ok: false, error: 'Stopped.' }); signal.addEventListener('abort', release); });
  const first = r.call('ws:transcribe', { audio: wav });
  await new Promise((x) => setImmediate(x));
  assert.match((await r.call('ws:transcribe', { audio: wav })).error, /Already listening/);
  await r.call('ws:transcribe-stop');
  assert.deepStrictEqual(await first, { ok: false, error: 'Stopped.' });
  r.ctx.transcriber.transcribe = async () => ({ ok: true, text: 'again', engine: 'x' });
  assert.strictEqual((await r.call('ws:transcribe', { audio: wav })).ok, true, 'after a stop, listening works again');
});
