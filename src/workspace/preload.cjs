'use strict';
/**
 * Preload for the workspace window (Chat, History, Code, Voice). contextIsolation stays ON and the page stays sandboxed: it gets
 * exactly two things - invoke(name, payload) for the ws: requests below, and onEvent(cb) to hear what main reports (a coding
 * step, a question that needs a yes or no).
 *
 * This is the FIRST gate; main/workspace-ipc.js validates everything again and checks WHO is asking. The table below is the whole
 * contract (test/workspace-preload-vm.test.js runs this file with hostile input; test/workspace-bridge.test.js compares it with
 * what main registers). invoke() never throws or rejects: a refused or failed request comes back as { ok: false, error }.
 */
const { contextBridge, ipcRenderer } = require('electron');

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const SESSION_ID_RE = /^[a-z0-9]{6,24}$/;
const MAX_AUDIO = 12 * 1024 * 1024;

const sessionId = (v) => (typeof v === 'string' && SESSION_ID_RE.test(v) ? v : undefined);
const text = (max, { min = 0 } = {}) => (v) => (typeof v === 'string' && v.length <= max && v.length >= min ? v : undefined);
const flag = (v) => (typeof v === 'boolean' ? v : undefined);
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e6 ? v : undefined);
const oneOf = (list) => (v) => (typeof v === 'string' && list.includes(v) ? v : undefined);

// What ws:update-settings may change: only these values, each of the stated type. Providers, keys and safety are not here.
const PATCH = {
  history: { enabled: flag },
  speech: {
    speakReplies: flag, ttsEngine: oneOf(['auto', 'piper', 'espeak-ng', 'spd-say', 'browser', 'off']), ttsVoice: text(80), ttsRate: finite, piperModel: text(500),
    sttEngine: oneOf(['auto', 'whisper-cli', 'http', 'off']), whisperBinary: text(500), whisperModel: text(500), sttRoute: text(32), sttModel: text(200), language: text(12),
  },
  code: { autonomy: oneOf(['ask', 'edits', 'full']), maxSteps: finite },
};

function cleanPatch(v) {
  if (!isObject(v)) return undefined;
  const out = {};
  for (const section of Object.keys(PATCH)) {                       // walk OUR table, never the caller's keys
    if (!has(v, section) || !isObject(v[section])) continue;
    for (const field of Object.keys(PATCH[section])) {
      if (!has(v[section], field)) continue;
      const clean = PATCH[section][field](v[section][field]);
      if (clean === undefined) continue;
      (out[section] || (out[section] = {}))[field] = clean;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

const KINDS = ['chat', 'task', 'code'];
function cleanList(v) {
  if (v === undefined) return {};
  if (!isObject(v)) return undefined;
  const out = {};
  if (has(v, 'query')) { const q = text(200)(v.query); if (q === undefined) return undefined; out.query = q; }
  if (has(v, 'kind') && v.kind !== '') { const k = oneOf(KINDS)(v.kind); if (k === undefined) return undefined; out.kind = k; }
  return out;
}
function cleanRename(v) {
  if (!isObject(v)) return undefined;
  const id = sessionId(v.id); const title = text(200, { min: 1 })(v.title);
  return id !== undefined && title !== undefined ? { id, title } : undefined;
}
function cleanChat(v) {
  if (!isObject(v)) return undefined;
  const t = text(8000, { min: 1 })(v.text);
  if (t === undefined) return undefined;
  const out = { text: t };
  if (has(v, 'sessionId') && v.sessionId !== null) { const id = sessionId(v.sessionId); if (id === undefined) return undefined; out.sessionId = id; }
  if (has(v, 'spoken')) { const s = flag(v.spoken); if (s === undefined) return undefined; out.spoken = s; }
  return out;
}
function cleanCodeWrite(v) {
  if (!isObject(v)) return undefined;
  const path = text(1000, { min: 1 })(v.path);
  const content = text(2 * 1024 * 1024)(v.content);
  const hash = typeof v.hash === 'string' && /^[a-f0-9]{64}$/.test(v.hash) ? v.hash : undefined;
  return path !== undefined && content !== undefined && hash !== undefined ? { path, content, hash } : undefined;
}
function cleanApproval(v) {
  if (!isObject(v)) return undefined;
  const id = text(64, { min: 1 })(v.id); const allow = flag(v.allow);
  return id !== undefined && allow !== undefined ? { id, allow } : undefined;
}
function cleanAudio(v) {
  if (!isObject(v) || !has(v, 'audio')) return undefined;
  const a = v.audio;
  const isBytes = a instanceof Uint8Array || (a && typeof a === 'object' && Object.prototype.toString.call(a) === '[object Uint8Array]') || (a && typeof a === 'object' && Object.prototype.toString.call(a) === '[object ArrayBuffer]');
  if (!isBytes) return undefined;
  const size = typeof a.byteLength === 'number' ? a.byteLength : -1;
  if (size < 44 || size > MAX_AUDIO) return undefined;
  return { audio: a };
}

// page -> main. 'none' = no payload at all. Anything not listed is refused.
const REQUESTS = {
  'ws:state': 'none',
  'ws:update-settings': cleanPatch,
  'ws:chat-send': cleanChat,
  'ws:chat-stop': 'none',
  'ws:history-list': cleanList,
  'ws:history-get': sessionId,
  'ws:history-rename': cleanRename,
  'ws:history-delete': sessionId,
  'ws:history-clear': 'none',
  'ws:history-export': sessionId,
  'ws:code-pick': 'none',
  'ws:code-open': text(1000, { min: 1 }),
  'ws:code-submit': text(12000, { min: 1 }),
  'ws:code-stop': 'none',
  'ws:code-tree': 'none',
  'ws:code-read': text(1000, { min: 1 }),
  'ws:code-write': cleanCodeWrite,
  'ws:code-diff': text(1000, { min: 1 }),
  'ws:code-revert': text(1000, { min: 1 }),
  'ws:code-revert-all': 'none',
  'ws:approval-answer': cleanApproval,
  'ws:speak': text(20000, { min: 1 }),
  'ws:speak-stop': 'none',
  'ws:transcribe': cleanAudio,
  'ws:transcribe-stop': 'none',
};

const refused = (error) => Promise.resolve({ ok: false, error });
const NOT_REACHABLE = 'ALLES could not be reached. Close this window and open it again.';

function invoke(name, payload) {
  try {
    if (typeof name !== 'string' || !has(REQUESTS, name)) return refused('Unknown action.');
    const rule = REQUESTS[name];
    let reply;
    if (rule === 'none') reply = ipcRenderer.invoke(name);
    else {
      const clean = rule(payload);
      if (clean === undefined) return refused('That request was not valid.');
      reply = ipcRenderer.invoke(name, clean);
    }
    return Promise.resolve(reply).then((r) => (isObject(r) ? r : { ok: false, error: NOT_REACHABLE }), () => ({ ok: false, error: NOT_REACHABLE }));
  } catch {
    return refused('That request was not valid.');
  }
}

let callbacks = 0;
const MAX_CALLBACKS = 4;

contextBridge.exposeInMainWorld('alles', {
  invoke,
  // main -> page: something happened (a coding step, a question to answer). The payload is plain data made by main.
  onEvent: (cb) => {
    if (typeof cb !== 'function' || callbacks >= MAX_CALLBACKS) return;
    callbacks++;
    ipcRenderer.on('ws:event', (_e, payload) => { try { cb(payload); } catch { /* the page's problem */ } });
  },
});
