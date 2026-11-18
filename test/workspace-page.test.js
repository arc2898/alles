'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadPreload } = require('./helpers/preload-vm');
const { attachWorkspaceIpc } = require('../src/main/workspace-ipc');
const M = require('../src/workspace/workspace-model');
const V = require('../src/workspace/voice-model');

const DIR = path.join(__dirname, '../src/workspace');
const read = (n) => fs.readFileSync(path.join(DIR, n), 'utf8');
const HTML = read('workspace.html'); const JS = read('workspace.js');
const noComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const unique = (a) => [...new Set(a)].sort();

// ---------------------------------------------------------------- the three pieces agree

test('the page, the preload and main know exactly the same list of requests', () => {
  const preload = fs.readFileSync(path.join(DIR, 'preload.cjs'), 'utf8');
  const table = preload.slice(preload.indexOf('const REQUESTS = {'), preload.indexOf('const refused'));
  const inPreload = unique([...table.matchAll(/'(ws:[a-z-]+)'/g)].map((m) => m[1]));
  const handlers = []; attachWorkspaceIpc({ handle: (n) => handlers.push(n) }, { settings: {}, history: {}, chat: {}, code: {}, speaker: {}, transcriber: {}, broker: {} }, { isTrusted: () => false });
  const inMain = unique(handlers);
  const inPage = unique([...noComments(JS).matchAll(/'(ws:[a-z-]+)'/g)].map((m) => m[1]));
  assert.deepStrictEqual(inPreload, inMain, 'preload and main differ');
  for (const n of inPage) assert.ok(inPreload.includes(n), `the page uses ${n}, which the preload refuses`);
  for (const n of inMain) assert.ok(inPage.includes(n), `${n} is allowed but nothing in the page uses it: an unused way in is a risk with no benefit`);
});

test('every ws: request the page makes passes the REAL preload with the payload the page builds', async () => {
  const p = loadPreload(path.join(DIR, 'preload.cjs'));
  const wav = V.encodeWav(new Int16Array(8000), 16000);
  const samples = [['ws:state'], ['ws:update-settings', { speech: { speakReplies: true } }], ['ws:update-settings', { code: { autonomy: 'edits' } }], ['ws:update-settings', { history: { enabled: false } }],
    ['ws:update-settings', { speech: { ttsRate: 1.2 } }], ['ws:chat-send', { text: 'hi', spoken: false }], ['ws:chat-send', { text: 'hi', sessionId: 'abc123def456', spoken: true }],
    ['ws:history-list', { query: '', kind: '' }], ['ws:history-get', 'abc123def456'], ['ws:history-rename', { id: 'abc123def456', title: 'x' }], ['ws:code-open', '/home/me/p'], ['ws:code-submit', 'do it'], ['ws:code-read', 'src/a.js'], ['ws:code-write', { path: 'src/a.js', content: 'x', hash: 'a'.repeat(64) }],
    ['ws:approval-answer', { id: 'q1', allow: false }], ['ws:speak', 'hello'], ['ws:transcribe', { audio: wav }]];
  for (const [name, payload] of samples) { const r = await p.api.invoke(name, payload); assert.notStrictEqual(r.error, 'That request was not valid.', `${name} ${String(JSON.stringify(payload)).slice(0, 80)}`); assert.notStrictEqual(r.error, 'Unknown action.', name); }
});

// ---------------------------------------------------------------- the page's files are safe to run

test('the page loads only its own files, has a strict policy, no inline script, no forms, no network addresses', () => {
  const csp = /Content-Security-Policy"\s+content="([^"]+)"/.exec(HTML)[1];
  assert.match(csp, /default-src 'none'/); assert.match(csp, /script-src 'self'/); assert.match(csp, /connect-src 'none'/); assert.match(csp, /form-action 'none'/); assert.match(csp, /base-uri 'none'/);
  assert.doesNotMatch(csp, /unsafe-|\*|https?:/);
  const scripts = [...HTML.matchAll(/<script([^>]*)>/g)];
  assert.ok(scripts.length >= 3 && scripts.every((s) => /\bsrc="[a-z-]+\.js"/.test(s[1])), 'every script is a local file');
  for (const [, , file] of HTML.matchAll(/<(script|link)[^>]*(?:src|href)="([^"]+)"/g).map ? [] : []) void file;
  for (const m of HTML.matchAll(/(?:src|href)="([^"]+)"/g)) { assert.match(m[1], /^[a-z-]+\.(js|css)$/, m[1]); assert.ok(fs.existsSync(path.join(DIR, m[1])), `${m[1]} exists`); }
  assert.ok(!/\son[a-z]+\s*=/i.test(HTML), 'no inline event handlers');
  assert.ok(!/<form|<iframe|<object|<embed|<webview/i.test(HTML));
  assert.ok(!/https?:\/\//.test(noComments(JS)), 'the script contains no web address');
});

test('text is never turned into markup: no innerHTML, insertAdjacentHTML, outerHTML, document.write, eval, Function(), setTimeout with a string', () => {
  const code = noComments(JS);
  for (const bad of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function/, /\bFunction\s*\(/, /setTimeout\s*\(\s*['"`]/, /setInterval\s*\(\s*['"`]/, /\.src\s*=/, /location\s*[.=]/, /fetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /localStorage|sessionStorage|indexedDB/, /window\.open/]) assert.doesNotMatch(code, bad, String(bad));
  assert.doesNotMatch(noComments(read('voice-model.js')) + noComments(read('workspace-model.js')), /innerHTML|eval\s*\(|document\./);
});

test('every element the script looks up exists in the page, and every id in the page is unique', () => {
  const ids = [...HTML.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.strictEqual(ids.length, new Set(ids).size, 'duplicate ids');
  const used = unique([...noComments(JS).matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  const madeByScript = M.TABS.map((t) => `tab-${t.id}`);                       // the tab buttons are built by buildTabs()
  for (const u of used) assert.ok(ids.includes(u) || madeByScript.includes(u), `the script looks up #${u}, which the page does not have`);
  assert.ok(noComments(JS).includes('`tab-${t.id}`') && noComments(JS).includes('`page-${t.id}`'), 'the script builds the tab ids the way this test assumes');
  for (const t of M.TABS) assert.ok(ids.includes(`page-${t.id}`), `page-${t.id}`);
});

test('the page is usable by keyboard and screen reader: tab roles, a labelled log, labelled inputs', () => {
  assert.match(HTML, /role="tablist"/); assert.match(HTML, /role="log"/);
  for (const m of HTML.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const attrs = m[2]; const id = (/\bid="([^"]+)"/.exec(attrs) || [])[1];
    const labelled = /aria-label=/.test(attrs) || (id && new RegExp(`for="${id}"`).test(HTML)) || /type="checkbox"/.test(attrs) && /<label[^>]*>\s*<input[^>]*id="[^"]+"/.test(HTML);
    assert.ok(labelled, `${m[0].slice(0, 70)} has no label`);
  }
});

// ---------------------------------------------------------------- the page really runs (with a pretend browser)

let REGISTRY = null;       // ids of elements the PAGE creates (the tab buttons) are found by getElementById too, as in a browser
class El {
  constructor(tag, id) { this.tag = tag; this.id = id || ''; this.children = []; this.attrs = {}; this.listeners = {}; this.hidden = false; this.value = ''; this.checked = false; this.disabled = false; this.className = ''; this.style = {}; this.options = []; this.parent = null; this._text = ''; this.focused = false; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get firstChild() { return this.children[0] || null; } get lastChild() { return this.children[this.children.length - 1] || null; } get childNodes() { return this.children; }
  appendChild(c) { c.parent = this; this.children.push(c); if (this.tag === 'select' && c.tag === 'option') this.options.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); this.options = this.options.filter((x) => x !== c); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id' && REGISTRY) REGISTRY[String(v)] = this; } getAttribute(k) { return this.attrs[k]; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  fire(ev, extra = {}) { const e = { preventDefault() {}, target: this, key: '', ...extra }; (this.listeners[ev] || []).forEach((f) => f(e)); if (this['on' + ev]) this['on' + ev](e); }
  focus() { this.focused = true; } select() {} querySelectorAll() { return []; }
  find(pred) { if (pred(this)) return this; for (const c of this.children) { const f = c.find && c.find(pred); if (f) return f; } return null; }
  all(pred, out = []) { if (pred(this)) out.push(this); this.children.forEach((c) => c.all && c.all(pred, out)); return out; }
}

function pretendPage({ reply, speakReplies = false, stt = 'whisper-cli', micError = null, voices = false } = {}) {
  const els = {}; REGISTRY = els;
  for (const m of HTML.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) { els[m[2]] = new El(m[1], m[2]); if (/\shidden[\s>]/.test(m[0])) els[m[2]].hidden = true; }
  const docListeners = {};
  const document = { getElementById: (id) => { if (!els[id]) throw new Error(`no #${id}`); return els[id]; }, createElement: (t) => new El(t), createTextNode: (t) => { const e = new El('#text'); e._text = t; return e; }, addEventListener: (ev, fn) => { (docListeners[ev] = docListeners[ev] || []).push(fn); } };
  const invoked = []; let pageEvents = null;
  const state = { ok: true, settings: { history: { enabled: true }, speech: { speakReplies, ttsEngine: 'auto', ttsVoice: '', ttsRate: 1, piperModel: '', sttEngine: 'auto', whisperBinary: '', whisperModel: '', sttRoute: '', sttModel: 'whisper-1', language: '' }, code: { autonomy: 'ask', maxSteps: 60, lastProject: '' } }, speech: { tts: { chosen: 'espeak-ng' }, stt: { chosen: stt, whisper: {}, http: {} } }, providers: [{ id: 'p1', label: 'NVIDIA' }], project: null };
  const keep = (v) => (v && typeof v === 'object' && v.audio ? v : (v === undefined ? v : JSON.parse(JSON.stringify(v))));   // the page runs in its own realm: compare plain copies
  const alles = { invoke: async (name, payload) => { invoked.push([name, keep(payload)]); const r = reply && reply(name, payload, state); if (r !== undefined) return r; if (name === 'ws:state') return state; return { ok: true }; }, onEvent: (cb) => { pageEvents = cb; } };
  // a microphone that can be fed sound
  const mic = { stopped: 0, closed: 0, node: null };
  class Ctx { constructor() { this.sampleRate = 48000; this.state = 'running'; this.destination = {}; } createMediaStreamSource() { return { connect() {} }; } createScriptProcessor() { mic.node = { connect() {}, disconnect() {}, onaudioprocess: null }; return mic.node; } close() { this.state = 'closed'; mic.closed++; } }
  const navigator = { mediaDevices: { getUserMedia: async () => { if (micError) { const e = new Error('x'); e.name = micError; throw e; } return { getTracks: () => [{ stop: () => { mic.stopped++; } }] }; } } };
  const said = [];
  class Utterance { constructor(text) { this.text = text; } }
  const synth = { cancels: 0, cancel() { this.cancels++; }, speak(u) { said.push(u.text); setImmediate(() => u.onend && u.onend()); } };
  const win = { alles, WorkspaceModel: M, VoiceModel: V, AudioContext: Ctx, ...(voices ? { speechSynthesis: synth, SpeechSynthesisUtterance: Utterance } : {}) };
  const ctx = vm.createContext({ window: win, document, navigator, setTimeout, clearTimeout, Float32Array, Uint8Array, Int16Array, Promise, console, String, Number, Math });
  new vm.Script(JS, { filename: 'workspace.js' }).runInContext(ctx);
  const sound = (level, ms = 100) => { const n = Math.round(48000 * ms / 1000); const buf = new Float32Array(n).fill(level); if (mic.node && typeof mic.node.onaudioprocess === 'function') mic.node.onaudioprocess({ inputBuffer: { getChannelData: () => buf } }); };   // after the recording ended the handler is gone, as in a browser
  return { els, invoked, mic, said, sound, emit: (ev) => pageEvents(ev), docListeners, state, named: (n) => invoked.filter((i) => i[0] === n) };
}
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

test('the page starts: four tabs, the chat page shown, the others hidden, settings loaded', async () => {
  const pg = pretendPage(); await settle();
  assert.deepStrictEqual(pg.named('ws:state').length, 1);
  assert.strictEqual(pg.els.tabs.children.length, 4);
  assert.strictEqual(pg.els['page-chat'].hidden, false);
  for (const id of ['page-code', 'page-history', 'page-voice']) assert.strictEqual(pg.els[id].hidden, true, id);
  assert.strictEqual(pg.els['tab-chat'].attrs['aria-selected'], 'true');
});

test('typing and sending: the question and the answer appear, and the request carries the text', async () => {
  const pg = pretendPage({ reply: (n, p) => (n === 'ws:chat-send' ? { ok: true, sessionId: 'abc123def456', reply: `echo ${p.text}` } : undefined) }); await settle();
  pg.els['chat-input'].value = 'hello there'; pg.els['chat-send'].fire('click'); await settle();
  assert.deepStrictEqual(pg.named('ws:chat-send')[0][1], { text: 'hello there', spoken: false });
  const log = pg.els['chat-log'].textContent;
  assert.match(log, /You.*hello there/); assert.match(log, /ALLES.*echo hello there/);
  assert.strictEqual(pg.els['chat-input'].value, '');
  pg.els['chat-input'].value = 'second'; pg.els['chat-send'].fire('click'); await settle();
  assert.strictEqual(pg.named('ws:chat-send')[1][1].sessionId, 'abc123def456', 'the conversation continues');
  pg.els['chat-new'].fire('click');
  pg.els['chat-input'].value = 'fresh'; pg.els['chat-send'].fire('click'); await settle();
  assert.strictEqual(pg.named('ws:chat-send')[2][1].sessionId, undefined, 'a new chat starts a new session');
});

test('Enter sends, Shift+Enter does not', async () => {
  const pg = pretendPage({ reply: (n) => (n === 'ws:chat-send' ? { ok: true, sessionId: 'abc123def456', reply: 'ok' } : undefined) }); await settle();
  pg.els['chat-input'].value = 'a'; pg.els['chat-input'].fire('keydown', { key: 'Enter', shiftKey: true }); await settle();
  assert.strictEqual(pg.named('ws:chat-send').length, 0);
  pg.els['chat-input'].fire('keydown', { key: 'Enter', shiftKey: false }); await settle();
  assert.strictEqual(pg.named('ws:chat-send').length, 1);
});

test('what the model says is shown as TEXT: markup in an answer never becomes an element', async () => {
  const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const pg = pretendPage({ reply: (n) => (n === 'ws:chat-send' ? { ok: true, sessionId: 'abc123def456', reply: evil } : undefined) }); await settle();
  pg.els['chat-input'].value = 'hi'; pg.els['chat-send'].fire('click'); await settle();
  assert.ok(pg.els['chat-log'].textContent.includes(evil), 'shown literally');
  assert.strictEqual(pg.els['chat-log'].all((e) => ['img', 'script'].includes(e.tag)).length, 0, 'no such element was made');
});

test('a failed answer is shown as an error message, not lost', async () => {
  const pg = pretendPage({ reply: (n) => (n === 'ws:chat-send' ? { ok: false, error: 'All providers failed (nvidia:429)' } : undefined) }); await settle();
  pg.els['chat-input'].value = 'hi'; pg.els['chat-send'].fire('click'); await settle();
  assert.match(pg.els['chat-log'].textContent, /All providers failed/);
  assert.strictEqual(pg.els['chat-send'].disabled, false, 'the person can try again');
});

test('a question from ALLES shows its card with the safe button focused; answering sends the answer and closes it', async () => {
  const pg = pretendPage(); await settle();
  pg.emit({ type: 'approval', question: { id: 'q9', kind: 'command', title: 'Run this shell command?', target: '/home/me/p', body: 'rm -rf build', risks: ['deletes files'] } });
  assert.strictEqual(pg.els.approval.hidden, false);
  assert.match(pg.els['ap-title'].textContent, /Run this shell command/); assert.match(pg.els['ap-body'].textContent, /rm -rf build/); assert.match(pg.els['ap-risks'].textContent, /deletes files/);
  assert.strictEqual(pg.els['ap-deny'].focused, true, 'Enter on the dialog is a "no"');
  pg.els['ap-allow'].fire('click'); await settle();
  assert.deepStrictEqual(pg.named('ws:approval-answer')[0][1], { id: 'q9', allow: true });
  assert.strictEqual(pg.els.approval.hidden, true);
  pg.emit({ type: 'approval', question: { id: 'q10', kind: 'file', title: 'Write this file?', target: '/p/a.js', body: '@@ -1,1 +1,1 @@\n-a\n+b' } });
  pg.docListeners.keydown.forEach((f) => f({ key: 'Escape' })); await settle();
  assert.deepStrictEqual(pg.named('ws:approval-answer')[1][1], { id: 'q10', allow: false }, 'Escape is a "no"');
  pg.emit({ type: 'approval', question: { id: 'q11', kind: 'command', title: 't', body: 'x' } });
  pg.emit({ type: 'approval-gone', id: 'q11' });
  assert.strictEqual(pg.els.approval.hidden, true, 'answered elsewhere (the pill): the card goes away');
});

test('coding steps arrive as events and show in the log; changes fill the list; a diff opens', async () => {
  const pg = pretendPage({ reply: (n) => (n === 'ws:code-diff' ? { ok: true, diff: '@@ -1,1 +1,1 @@\n-old\n+new' } : n === 'ws:code-tree' ? { ok: true, entries: ['a.js'] } : undefined) }); await settle();
  pg.emit({ type: 'code', payload: { type: 'tool', name: 'edit_file', args: '{"path":"src/a.js"}', text: 'Edited src/a.js (+1 -1)', error: false } });
  pg.emit({ type: 'code', payload: { type: 'finished', ok: true, summary: 'All done.' } });
  assert.match(pg.els['code-log'].textContent, /Edited src\/a\.js/); assert.match(pg.els['code-log'].textContent, /All done\./);
  pg.emit({ type: 'code', payload: { type: 'changes', changes: [{ path: 'src/a.js', status: 'modified', added: 1, removed: 1, revertible: true }] } });
  assert.match(pg.els['code-changes'].textContent, /src\/a\.js  \(changed, \+1 -1\)/);
  assert.strictEqual(pg.els['code-undo-all'].hidden, false);
  pg.els['code-changes'].find((e) => e.tag === 'button').fire('click'); await settle();
  assert.deepStrictEqual(pg.named('ws:code-diff')[0][1], 'src/a.js');
  assert.strictEqual(pg.els['code-diff'].hidden, false);
  const classes = pg.els['code-diff'].all((e) => e.tag === 'span').map((e) => e.className);
  assert.deepStrictEqual(classes, ['hunk', 'del', 'add']);
});

test('the coding autonomy menu shows the saved level and saves a change', async () => {
  const pg = pretendPage({ reply: (n, p, state) => { if (n === 'ws:update-settings') { Object.assign(state.settings.code, p.code); return state; } return undefined; } }); await settle();
  assert.strictEqual(pg.els['code-autonomy'].options.length, 3);
  assert.strictEqual(pg.els['code-autonomy'].value, 'ask');
  pg.els['code-autonomy'].value = 'full'; pg.els['code-autonomy'].fire('change', { target: pg.els['code-autonomy'] }); await settle();
  assert.deepStrictEqual(pg.named('ws:update-settings')[0][1], { code: { autonomy: 'full' } });
  assert.match(pg.els['code-autonomy-note'].textContent, /dangerous/);
});

test('Start is disabled until a project is chosen; running a task sends it and shows the result', async () => {
  const pg = pretendPage({ reply: (n, p) => { if (n === 'ws:code-pick') return { ok: true, project: { name: 'shop', root: '/home/me/shop' }, tree: { entries: ['src/'] } }; if (n === 'ws:code-submit') return { ok: true, summary: 'Added the test.' }; if (n === 'ws:code-tree') return { ok: true, entries: ['src/'] }; return undefined; } }); await settle();
  assert.strictEqual(pg.els['code-run'].disabled, true);
  pg.els['code-pick'].fire('click'); await settle();
  assert.match(pg.els['code-project'].textContent, /shop/); assert.strictEqual(pg.els['code-run'].disabled, false);
  pg.els['code-input'].value = 'add a test'; pg.els['code-run'].fire('click'); await settle();
  assert.deepStrictEqual(pg.named('ws:code-submit')[0][1], 'add a test');
  assert.match(pg.els['code-log'].textContent, /You.*add a test/); assert.match(pg.els['code-log'].textContent, /Added the test\./);
});

test('the IDE opens a real file in the editor, tracks dirty state and saves through the main process', async () => {
  const pg = pretendPage({ reply: (n, p) => {
    if (n === 'ws:code-pick') return { ok: true, project: { name: 'shop', root: '/home/me/shop' }, tree: { entries: ['src/a.js'] } };
    if (n === 'ws:code-read') return { ok: true, path: p, content: 'const value = 1;\n', hash: 'a'.repeat(64) };
    if (n === 'ws:code-write') return { ok: true, path: p.path, changes: [{ path: p.path, status: 'modified', added: 1, removed: 1, revertible: true }], hash: 'b'.repeat(64) };
    if (n === 'ws:code-tree') return { ok: true, entries: ['src/a.js'] };
    return undefined;
  } }); await settle();
  pg.els['code-pick'].fire('click'); await settle();
  const file = pg.els['code-tree'].find((e) => e.tag === 'button');
  assert.ok(file, 'file tree entry is an actionable button');
  file.fire('click'); await settle();
  assert.strictEqual(pg.els['code-editor'].value, 'const value = 1;\n');
  assert.strictEqual(pg.els['code-save'].disabled, true);
  pg.els['code-editor'].value = 'const value = 2;\n'; pg.els['code-editor'].fire('input');
  assert.strictEqual(pg.els['code-save'].disabled, false);
  assert.match(pg.els['code-file-state'].textContent, /Unsaved/);
  pg.els['code-save'].fire('click'); await settle();
  assert.deepStrictEqual(pg.named('ws:code-write')[0][1], { path: 'src/a.js', content: 'const value = 2;\n', hash: 'a'.repeat(64) });
  assert.match(pg.els['code-file-state'].textContent, /Saved/);
  assert.match(pg.els['code-changes'].textContent, /src\/a\.js/);
});

test('IDE dictation inserts text into the task composer but never executes it automatically', async () => {
  const pg = pretendPage({ reply: (n) => (n === 'ws:transcribe' ? { ok: true, text: 'fix the tests', engine: 'whisper-cli' } : undefined) }); await settle();
  pg.els['code-mic'].fire('click'); await settle();
  assert.match(pg.els['code-voice-status'].textContent, /^Listening/);
  assert.strictEqual(pg.els['voice-status'].textContent, '');
  pg.sound(0, 600); for (let i = 0; i < 4; i++) pg.sound(0.2, 100); for (let i = 0; i < 15; i++) pg.sound(0, 100);
  await settle(20);
  assert.strictEqual(pg.els['code-input'].value, 'fix the tests');
  assert.strictEqual(pg.named('ws:code-submit').length, 0);
  assert.strictEqual(pg.named('ws:chat-send').length, 0);
  assert.match(pg.els.toast.textContent, /review it/i);
});

test('History lists sessions grouped by day; opening one shows its transcript; deleting asks first', async () => {
  const now = Date.now();
  const pg = pretendPage({ reply: (n, p) => {
    if (n === 'ws:history-list') return { ok: true, sessions: [{ id: 'abc123def456', kind: 'chat', title: 'Zebras', updatedAt: now, preview: 'stripes', project: '' }] };
    if (n === 'ws:history-get') return { ok: true, meta: { id: p, kind: 'chat', title: 'Zebras', project: '' }, events: [{ kind: 'user', text: 'why stripes?' }, { kind: 'assistant', text: 'Camouflage, maybe.' }] };
    if (n === 'ws:history-delete') return { ok: true };
    return undefined; } }); await settle();
  pg.els['tab-history'].fire('click'); await settle();
  assert.match(pg.els['hist-list'].textContent, /Today/); assert.match(pg.els['hist-list'].textContent, /Zebras/);
  pg.els['hist-list'].find((e) => e.className === 'hist-item').fire('click'); await settle();
  assert.match(pg.els['hist-body'].textContent, /why stripes\?/); assert.match(pg.els['hist-body'].textContent, /Camouflage/);
  assert.strictEqual(pg.els['hist-actions'].hidden, false); assert.strictEqual(pg.els['hist-continue'].hidden, false);
  pg.els['hist-delete'].fire('click'); await settle();
  assert.strictEqual(pg.named('ws:history-delete').length, 0, 'nothing is deleted before the person says yes');
  assert.strictEqual(pg.els.confirm.hidden, false); assert.strictEqual(pg.els['cf-no'].focused, true);
  pg.els['cf-yes'].fire('click'); await settle();
  assert.deepStrictEqual(pg.named('ws:history-delete')[0][1], 'abc123def456');
});

test('"Continue this chat" loads the old messages into Chat and the next message joins that session', async () => {
  const pg = pretendPage({ reply: (n, p) => {
    if (n === 'ws:history-list') return { ok: true, sessions: [{ id: 'abc123def456', kind: 'chat', title: 'Old', updatedAt: Date.now(), preview: '' }] };
    if (n === 'ws:history-get') return { ok: true, meta: { id: p, kind: 'chat', title: 'Old', project: '' }, events: [{ kind: 'user', text: 'first question' }, { kind: 'assistant', text: 'first answer' }] };
    if (n === 'ws:chat-send') return { ok: true, sessionId: p.sessionId, reply: 'more' };
    return undefined; } }); await settle();
  pg.els['tab-history'].fire('click'); await settle();
  pg.els['hist-list'].find((e) => e.className === 'hist-item').fire('click'); await settle();
  pg.els['hist-continue'].fire('click'); await settle();
  assert.strictEqual(pg.els['page-chat'].hidden, false);
  assert.match(pg.els['chat-log'].textContent, /first question/);
  pg.els['chat-input'].value = 'and then?'; pg.els['chat-send'].fire('click'); await settle();
  assert.strictEqual(pg.named('ws:chat-send')[0][1].sessionId, 'abc123def456');
});

test('talking: Talk opens the microphone, the pause ends the recording, the words are sent as a message, the answer is spoken, and the microphone is released', async () => {
  const pg = pretendPage({ speakReplies: true, reply: (n, p) => {
    if (n === 'ws:transcribe') return { ok: true, text: 'what time is it', engine: 'whisper-cli' };
    if (n === 'ws:chat-send') return { ok: true, sessionId: 'abc123def456', reply: 'It is noon.' };
    if (n === 'ws:speak') return { ok: true, spoke: true, engine: 'espeak-ng' };
    return undefined; } }); await settle();
  pg.els['chat-mic'].fire('click'); await settle();
  assert.strictEqual(pg.els['chat-mic'].attrs['aria-pressed'], 'true'); assert.match(pg.els['voice-status'].textContent, /Listening/);
  assert.ok(pg.mic.node, 'the microphone was opened');
  for (let i = 0; i < 3; i++) pg.sound(0.001);          // a quiet room
  for (let i = 0; i < 4; i++) pg.sound(0.2);            // speech
  for (let i = 0; i < 15; i++) pg.sound(0.001);         // a pause: the detector ends the recording
  await settle(20);
  assert.strictEqual(pg.mic.stopped, 1, 'the microphone tracks were stopped'); assert.strictEqual(pg.mic.closed, 1, 'and the audio context closed');
  const t = pg.named('ws:transcribe')[0][1].audio;
  assert.ok(t instanceof Uint8Array && t.length > 44 && String.fromCharCode(...t.slice(0, 4)) === 'RIFF', 'a real WAV went to main');
  assert.deepStrictEqual(pg.named('ws:chat-send')[0][1], { text: 'what time is it', spoken: true });
  assert.match(pg.els['chat-log'].textContent, /It is noon\./);
  assert.strictEqual(pg.named('ws:speak')[0][1], 'It is noon.');
  assert.strictEqual(pg.els['voice-status'].textContent, '', 'back to idle');
});

test('hands-free: after ALLES has spoken it listens again by itself; switching hands-free off or Stop ends it', async () => {
  const pg = pretendPage({ speakReplies: true, reply: (n) => {
    if (n === 'ws:transcribe') return { ok: true, text: 'again', engine: 'x' };
    if (n === 'ws:chat-send') return { ok: true, sessionId: 'abc123def456', reply: 'ok' };
    if (n === 'ws:speak') return { ok: true, spoke: true };
    return undefined; } }); await settle();
  pg.els['chat-handsfree'].checked = true;
  pg.els['chat-mic'].fire('click'); await settle();
  const first = pg.mic.node;
  for (let i = 0; i < 3; i++) pg.sound(0.001); for (let i = 0; i < 4; i++) pg.sound(0.2); for (let i = 0; i < 15; i++) pg.sound(0.001);
  await settle(30);
  assert.strictEqual(pg.named('ws:chat-send').length, 1);
  assert.notStrictEqual(pg.mic.node, first, 'the microphone was opened again for the next turn');
  assert.match(pg.els['voice-status'].textContent, /Listening/);
  pg.els['chat-stop'].fire('click'); await settle(10);
  assert.strictEqual(pg.els['voice-status'].textContent, '');
  assert.strictEqual(pg.mic.closed, 2, 'Stop released the microphone');
});

test('talking with no speech recognition set up sends you to Voice & privacy and never opens the microphone', async () => {
  const pg = pretendPage({ stt: null }); await settle();
  pg.els['chat-mic'].fire('click'); await settle();
  assert.strictEqual(pg.mic.node, null);
  assert.strictEqual(pg.els['page-voice'].hidden, false);
  assert.match(pg.els.toast.textContent, /not set up/);
});

test('a microphone that is refused or missing is explained in words, and the page goes back to idle', async () => {
  for (const [name, expected] of [['NotAllowedError', /not allowed/], ['NotFoundError', /No microphone/]]) {
    const pg = pretendPage({ micError: name }); await settle();
    pg.els['chat-mic'].fire('click'); await settle(12);
    assert.match(pg.els.toast.textContent, expected, name);
    assert.strictEqual(pg.els['voice-status'].textContent, '', 'back to idle');
    assert.strictEqual(pg.els['chat-mic'].attrs['aria-pressed'], 'false');
    assert.strictEqual(pg.named('ws:transcribe').length, 0);
  }
});

test('nobody speaks: after a while it gives up, releases the microphone and says so', async () => {
  const pg = pretendPage(); await settle();
  pg.els['chat-mic'].fire('click'); await settle();
  for (let i = 0; i < 100; i++) pg.sound(0.001);                                // 10 s of quiet
  await settle(12);
  assert.match(pg.els.toast.textContent, /did not hear anything/);
  assert.strictEqual(pg.mic.stopped, 1); assert.strictEqual(pg.named('ws:transcribe').length, 0);
  assert.strictEqual(pg.els['voice-status'].textContent, '');
});

test('a recording that could not be understood is reported and nothing is sent to the chat', async () => {
  const pg = pretendPage({ reply: (n) => (n === 'ws:transcribe' ? { ok: false, error: 'No words were heard.' } : undefined) }); await settle();
  pg.els['chat-mic'].fire('click'); await settle();
  for (let i = 0; i < 3; i++) pg.sound(0.001); for (let i = 0; i < 4; i++) pg.sound(0.2); for (let i = 0; i < 15; i++) pg.sound(0.001);
  await settle(20);
  assert.match(pg.els.toast.textContent, /No words were heard/);
  assert.strictEqual(pg.named('ws:chat-send').length, 0);
  assert.strictEqual(pg.els['voice-status'].textContent, '');
});

test('sending the recording to a provider asks the person first, once', async () => {
  const pg = pretendPage({ stt: 'http', reply: (n, p, state) => { if (n === 'ws:state') { state.speech.stt.sendsAudioAway = true; return state; } return undefined; } }); await settle();
  pg.els['chat-mic'].fire('click'); await settle();
  assert.strictEqual(pg.els.confirm.hidden, false); assert.match(pg.els['cf-text'].textContent, /sent over the internet/);
  assert.strictEqual(pg.mic.node, null, 'the microphone is not opened until the person agrees');
  pg.els['cf-no'].fire('click'); await settle();
  assert.strictEqual(pg.mic.node, null);
  pg.els['chat-mic'].fire('click'); await settle(); pg.els['cf-yes'].fire('click'); await settle();
  assert.ok(pg.mic.node, 'after yes, it listens');
});

test('the Voice & privacy page shows what works and saves a changed setting', async () => {
  const pg = pretendPage({ reply: (n, p, state) => { if (n === 'ws:update-settings') { Object.assign(state.settings.speech, p.speech); return state; } return undefined; } }); await settle();
  pg.els['tab-voice'].fire('click'); await settle();
  assert.match(pg.els['voice-talk'].textContent, /espeak-ng/); assert.match(pg.els['voice-privacy'].textContent, /stays on this computer/);
  assert.strictEqual(pg.els['stt-route'].options.length, 2);
  pg.els['tts-engine'].value = 'piper'; pg.els['tts-engine'].fire('change', { target: pg.els['tts-engine'] }); await settle();
  assert.deepStrictEqual(pg.named('ws:update-settings')[0][1], { speech: { ttsEngine: 'piper' } });
  pg.els['hist-enabled'].checked = false; pg.els['hist-enabled'].fire('change', { target: pg.els['hist-enabled'] }); await settle();
  assert.deepStrictEqual(pg.named('ws:update-settings')[1][1], { history: { enabled: false } });
  pg.els['tts-test'].fire('click'); await settle();
  assert.ok(pg.named('ws:speak').length >= 1);
});

test('speech falls back to the browser\'s own voice when main says to, with the cleaned words, one sentence at a time', async () => {
  const pg = pretendPage({ speakReplies: true, voices: true, reply: (n) => {
    if (n === 'ws:chat-send') return { ok: true, sessionId: 'abc123def456', reply: 'Hello **there**. Second one.' };
    if (n === 'ws:speak') return { ok: true, spoke: false, reason: 'use-browser', words: 'Hello there. Second one.' };
    return undefined; } });
  await settle();
  pg.els['chat-input'].value = 'hi'; pg.els['chat-send'].fire('click'); await settle(20);
  assert.deepStrictEqual(pg.said, ['Hello there. Second one.'], 'the cleaned words, not the Markdown');
});

test('with no voice anywhere the person is told what to install, not left in silence', async () => {
  const pg = pretendPage({ speakReplies: true, voices: false, reply: (n) => {
    if (n === 'ws:chat-send') return { ok: true, sessionId: 'abc123def456', reply: 'Hello.' };
    if (n === 'ws:speak') return { ok: true, spoke: false, reason: 'use-browser', words: 'Hello.' };
    return undefined; } });
  await settle();
  pg.els['chat-input'].value = 'hi'; pg.els['chat-send'].fire('click'); await settle(20);
  assert.match(pg.els.toast.textContent, /Install espeak-ng/);
});

test('a coding result is shown once: from the "finished" event if it came, else from the reply', async () => {
  let pg;
  pg = pretendPage({ reply: (n) => { if (n === 'ws:code-pick') return { ok: true, project: { name: 'p', root: '/h/p' }, tree: { entries: [] } }; if (n === 'ws:code-submit') { pg.emit({ type: 'code', payload: { type: 'finished', ok: false, summary: 'Stopped by the user.' } }); return { ok: false, error: 'Stopped by the user.' }; } return undefined; } });
  await settle();
  pg.els['code-pick'].fire('click'); await settle();
  pg.els['code-input'].value = 'go'; pg.els['code-run'].fire('click'); await settle();
  assert.strictEqual(pg.els['code-log'].textContent.split('Stopped by the user.').length - 1, 1);
});
