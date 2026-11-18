'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { HistoryStore, MAX_EVENTS, MAX_SESSIONS } = require('../src/main/history');
const { tmpDir } = require('./helpers/tmp');

function make(extra = {}) {
  const dir = path.join(tmpDir('alles-hist-'), 'history');
  let t = 1_000;
  const store = new HistoryStore({ dir, now: () => (t += 10), setTimer: () => null, clearTimer: () => {}, ...extra });
  return { dir, store, tick: (n = 1000) => { t += n; } };
}

test('a session keeps what was said, in order, and names itself from the first thing the person said', () => {
  const { store } = make();
  const id = store.create({ kind: 'chat' });
  store.append(id, { kind: 'user', text: 'How do I rotate a PDF page?' });
  store.append(id, { kind: 'assistant', text: 'Use the pdf tool.' });
  const got = store.get(id);
  assert.deepStrictEqual(got.events.map((e) => [e.kind, e.text]), [['user', 'How do I rotate a PDF page?'], ['assistant', 'Use the pdf tool.']]);
  assert.strictEqual(got.meta.title, 'How do I rotate a PDF page?');
  assert.strictEqual(got.meta.count, 2);
  assert.strictEqual(got.meta.preview, 'Use the pdf tool.');
});

test('an explicit title is never replaced by the first message', () => {
  const { store } = make();
  const id = store.create({ title: 'Taxes 2026' });
  store.append(id, { kind: 'user', text: 'hello' });
  assert.strictEqual(store.get(id).meta.title, 'Taxes 2026');
});

test('the list is newest first, can be filtered by kind, and can be searched in titles AND in what was said', () => {
  const { store, tick } = make();
  const a = store.create({ kind: 'chat', title: 'Alpha' }); store.append(a, { kind: 'user', text: 'tell me about zebras' }); tick();
  const b = store.create({ kind: 'code', title: 'Beta', project: '/home/me/shop' }); store.append(b, { kind: 'user', text: 'add a cart page' }); tick();
  const c = store.create({ kind: 'task', title: 'Gamma' });
  assert.deepStrictEqual(store.list().map((r) => r.title), ['Gamma', 'Beta', 'Alpha']);
  assert.deepStrictEqual(store.list({ kind: 'code' }).map((r) => r.title), ['Beta']);
  assert.deepStrictEqual(store.list({ query: 'ZEBRAS' }).map((r) => r.title), ['Alpha'], 'found inside the conversation, any case');
  assert.deepStrictEqual(store.list({ query: 'shop' }).map((r) => r.title), ['Beta'], 'found by project folder');
  assert.deepStrictEqual(store.list({ query: 'nothing like this' }), []);
  assert.strictEqual(store.list({ limit: 1 }).length, 1);
  assert.ok(c);
});

test('it survives a restart: a new store reads the same sessions, and finds a session the list forgot', () => {
  const { dir, store } = make();
  const id = store.create({ title: 'Kept' }); store.append(id, { kind: 'user', text: 'one' }); store.flush();
  const again = new HistoryStore({ dir, setTimer: () => null });
  assert.strictEqual(again.get(id).events.length, 1);
  // a crash before the list was saved: the session file exists, the list does not
  const lost = store.create({ title: 'Lost' }); store.append(lost, { kind: 'user', text: 'two' });
  const third = new HistoryStore({ dir, setTimer: () => null });
  assert.ok(third.list().some((r) => r.id === lost && r.count === 1), 'rebuilt from the session file');
});

test('a half-written last line (a crash) costs that line only', () => {
  const { dir, store } = make();
  const id = store.create({}); store.append(id, { kind: 'user', text: 'safe' });
  fs.appendFileSync(path.join(dir, `s-${id}.jsonl`), '{"t":"ev","at":5,"k":"assistant","text":"cut o');
  assert.deepStrictEqual(store.get(id).events.map((e) => e.text), ['safe']);
});

test('API keys never reach the disk, neither the ones held nor ones that merely look like keys', () => {
  const { dir, store } = make({ secrets: () => ['my-very-secret-value-123'] });
  const id = store.create({});
  store.append(id, { kind: 'assistant', text: 'the key is my-very-secret-value-123 and also nvapi-ABCDEFGHIJKL' });
  store.append(id, { kind: 'tool', name: 'run_shell', args: { command: 'curl -H "Authorization: Bearer abcdefghijklmnop1234"' }, text: 'ok' });
  const raw = fs.readFileSync(path.join(dir, `s-${id}.jsonl`), 'utf8');
  assert.ok(!raw.includes('my-very-secret-value-123'));
  assert.ok(!raw.includes('nvapi-ABCDEFGHIJKL'));
  assert.ok(!raw.includes('abcdefghijklmnop1234'));
  assert.ok(raw.includes('[redacted]'));
});

test('history is private to the user', () => {
  const { dir, store } = make();
  const id = store.create({}); store.append(id, { kind: 'user', text: 'x' }); store.flush();
  assert.strictEqual(fs.statSync(path.join(dir, `s-${id}.jsonl`)).mode & 0o077, 0, 'session file');
  assert.strictEqual(fs.statSync(path.join(dir, 'index.json')).mode & 0o077, 0, 'list file');
  assert.strictEqual(fs.statSync(dir).mode & 0o077, 0, 'folder');
});

test('with history off nothing is written, ids still work, and what was saved before stays', () => {
  let on = true;
  const { dir, store } = make({ isEnabled: () => on });
  const kept = store.create({ title: 'Before' }); store.append(kept, { kind: 'user', text: 'kept' });
  on = false;
  const v = store.create({ title: 'During' });
  assert.ok(typeof v === 'string' && v.length > 4, 'a usable id');
  assert.strictEqual(store.append(v, { kind: 'user', text: 'secret chat' }), false);
  assert.strictEqual(store.append(kept, { kind: 'user', text: 'more' }), false, 'not even into an old session');
  assert.strictEqual(store.get(v), null);
  assert.deepStrictEqual(store.list().map((r) => r.title), ['Before']);
  assert.ok(!fs.readdirSync(dir).some((f) => f.includes(v)));
  assert.strictEqual(store.get(kept).events.length, 1);
});

test('a session id is never allowed to become a path', () => {
  const { store } = make();
  for (const bad of ['../../etc/passwd', 'a/b', '..', '', 'ABCDEF123456', 'x'.repeat(40), null, 42, {}]) {
    assert.strictEqual(store.get(bad), null, String(bad));
    assert.strictEqual(store.append(bad, { kind: 'user', text: 'x' }), false);
    assert.strictEqual(store.remove(bad), false);
    assert.strictEqual(store.rename(bad, 'x'), false);
  }
});

test('rename, remove and clear really change the files', () => {
  const { dir, store } = make();
  const a = store.create({ title: 'A' }); const b = store.create({ title: 'B' });
  assert.strictEqual(store.rename(a, '  New   name '), true);
  assert.strictEqual(store.get(a).meta.title, 'New name');
  assert.strictEqual(store.rename(a, '   '), false, 'an empty name is refused');
  assert.strictEqual(store.remove(a), true);
  assert.ok(!fs.existsSync(path.join(dir, `s-${a}.jsonl`)));
  assert.strictEqual(store.remove(a), false);
  assert.strictEqual(store.clear(), 1);
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.jsonl')));
  assert.deepStrictEqual(store.list(), []);
  assert.ok(b);
});

test('limits: a very long event is cut, a runaway session stops saving (and says so once), old sessions are dropped', () => {
  const { store, dir } = make();
  const id = store.create({});
  store.append(id, { kind: 'tool', name: 'run_shell', text: 'x'.repeat(100_000) });
  assert.ok(store.get(id).events[0].text.length < 20_100);
  assert.match(store.get(id).events[0].text, /more characters not kept/);
  for (let i = 0; i < MAX_EVENTS + 20; i++) store.append(id, { kind: 'note', text: `n${i}` });
  const events = store.get(id).events;
  assert.strictEqual(events.length, MAX_EVENTS + 1);
  assert.match(events[events.length - 1].text, /nothing more is saved/);
  for (let i = 0; i < MAX_SESSIONS + 5; i++) store.create({ title: `s${i}` });
  assert.ok(store.list({ limit: 1000 }).length <= MAX_SESSIONS);
  assert.ok(fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).length <= MAX_SESSIONS);
});

test('a damaged list file is rebuilt, and the person can be told', () => {
  const { dir, store } = make();
  const id = store.create({ title: 'Survivor' }); store.append(id, { kind: 'user', text: 'hi' }); store.flush();
  fs.writeFileSync(path.join(dir, 'index.json'), '{not json');
  const again = new HistoryStore({ dir, setTimer: () => null });
  assert.deepStrictEqual(again.list().map((r) => r.title), ['Survivor']);
  assert.match(again.loadIssue, /rebuilt/);
});

test('export gives readable Markdown with who said what', () => {
  const { store } = make();
  const id = store.create({ kind: 'code', title: 'Fix login', project: '/p' });
  store.append(id, { kind: 'user', text: 'fix the login bug' });
  store.append(id, { kind: 'tool', name: 'edit_file', args: { path: 'a.js' }, text: 'Edited a.js' });
  store.append(id, { kind: 'assistant', text: 'Fixed.' });
  const md = store.exportMarkdown(id);
  assert.match(md, /^# Fix login/);
  assert.match(md, /\*\*You:\*\* fix the login bug/);
  assert.match(md, /> edit_file/);
  assert.match(md, /\*\*ALLES:\*\* Fixed\./);
  assert.strictEqual(store.exportMarkdown('nope12345'), null);
});
