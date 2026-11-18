'use strict';
/**
 * Preload for the Settings window. contextIsolation stays ON and the page stays sandboxed: it gets exactly two
 * things - invoke(name, payload) for the settings: requests below, and onChanged(cb) to hear that something changed.
 * CommonJS on purpose: sandboxed preload scripts cannot use ESM.
 *
 * This file is the FIRST gate. main/settings-ipc.js validates every request again and also checks WHO is asking,
 * so a mistake here is never the only thing between a page and your API keys. The tables below are the whole
 * contract; test/settings-preload-vm.test.js runs this very file with hostile input, and
 * test/settings-bridge.test.js checks it against what main registers.
 *
 * invoke() never throws and never rejects: a refused or failed request comes back as { ok: false, error } like
 * every other failure, so the page has exactly one shape to handle.
 */
const { contextBridge, ipcRenderer } = require('electron');

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const ROUTE_ID_RE = /^[a-z0-9-]{1,32}$/;
const KEY_ID_RE = /^[a-f0-9]{4,32}$/;
const KINDS = ['nvidia', 'grok', 'gemini', 'custom'];
const MAX_ROUTES = 12;

const routeId = (v) => (typeof v === 'string' && ROUTE_ID_RE.test(v) ? v : undefined);
const keyId = (v) => (typeof v === 'string' && KEY_ID_RE.test(v) ? v : undefined);
const text = (max) => (v) => (typeof v === 'string' && v.length <= max ? v : undefined);
const flag = (v) => (typeof v === 'boolean' ? v : undefined);
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e6 ? v : undefined);
const oneOf = (list) => (v) => (typeof v === 'string' && list.includes(v) ? v : undefined);

// A display is remembered by id (a string or a number); null means "follow the cursor / primary display".
function displayId(v) {
  if (v === null) return null;
  if (typeof v === 'string') return v.length <= 64 ? v : undefined;
  return finite(v);
}

// settings:update may change ONLY these values, each of the stated type. Providers and keys have their own requests.
const PATCH = {
  dock: {
    edge: oneOf(['top', 'bottom', 'left', 'right']),
    along: finite,
    display: displayId,
    autoHide: flag, hour12: flag,
  },
  agent: { maxSteps: finite, keepImages: finite },
  tray: { enabled: flag },
  input: { backend: oneOf(['auto', 'gnome', 'ydotool']) },
  security: { keyStorage: oneOf(['session', 'file']) },
  safety: { allowDangerousKeys: flag, maxActionsPerMinute: finite, requireApprovalForShell: flag, requireApprovalForFileWrites: flag },
};

function cleanPatch(v) {
  if (!isObject(v)) return undefined;
  const out = {};
  // Walk OUR table, never the caller's keys: anything extra (including __proto__ / constructor) is simply never read.
  for (const section of Object.keys(PATCH)) {
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

function cleanRouteEdit(v) {
  if (!isObject(v) || !has(v, 'id')) return undefined;
  const id = routeId(v.id);
  if (id === undefined) return undefined;
  const out = { id };
  const fields = { label: text(100), model: text(200), baseUrl: text(2000), enabled: flag };
  let n = 0;
  for (const k of Object.keys(fields)) {
    if (!has(v, k)) continue;
    const clean = fields[k](v[k]);
    if (clean === undefined) return undefined;            // a bad field refuses the whole edit rather than half-applying it
    out[k] = clean; n++;
  }
  return n ? out : undefined;
}

function cleanRouteIds(v) {
  if (!Array.isArray(v) || v.length > MAX_ROUTES) return undefined;
  const out = [];
  for (let i = 0; i < v.length; i++) { const id = routeId(v[i]); if (id === undefined) return undefined; out.push(id); }
  return out;
}

function cleanKeyAdd(v) {
  if (!isObject(v) || !has(v, 'routeId') || !has(v, 'key')) return undefined;
  const id = routeId(v.routeId); const key = text(4096)(v.key);
  return id !== undefined && key !== undefined && key.length > 0 ? { routeId: id, key } : undefined;
}

function cleanKeyRef(v) {
  if (!isObject(v) || !has(v, 'routeId') || !has(v, 'keyId')) return undefined;
  const r = routeId(v.routeId); const k = keyId(v.keyId);
  return r !== undefined && k !== undefined ? { routeId: r, keyId: k } : undefined;
}

function cleanTest(v) {
  if (!isObject(v) || !has(v, 'routeId')) return undefined;
  const r = routeId(v.routeId);
  if (r === undefined) return undefined;
  if (!has(v, 'keyId') || v.keyId === undefined) return { routeId: r };
  const k = keyId(v.keyId);
  return k !== undefined ? { routeId: r, keyId: k } : undefined;
}

// page -> main. channel: how its payload is cleaned. 'none' = no payload at all. Anything not listed is refused.
const REQUESTS = {
  'settings:get': 'none',
  'settings:describe-providers': 'none',
  'settings:load-issue': 'none',
  'settings:migrate-session-keys': 'none',
  'settings:check-computer': 'none',
  'settings:remove-route': routeId,
  'settings:add-route': oneOf(KINDS),
  'settings:update': cleanPatch,
  'settings:update-route': cleanRouteEdit,
  'settings:reorder-routes': cleanRouteIds,
  'settings:add-key': cleanKeyAdd,
  'settings:remove-key': cleanKeyRef,
  'settings:test-route': cleanTest,
};

const refused = (error) => Promise.resolve({ ok: false, error });
const NOT_REACHABLE = 'ALLES could not be reached. Close this window and open Settings again.';

function invoke(name, payload) {
  try {
    if (typeof name !== 'string' || !has(REQUESTS, name)) return refused('Unknown action.');
    const rule = REQUESTS[name];
    let reply;
    if (rule === 'none') {
      reply = ipcRenderer.invoke(name);                   // anything the page passed along is ignored
    } else {
      const clean = rule(payload);
      if (clean === undefined) return refused('That request was not valid.');
      reply = ipcRenderer.invoke(name, clean);
    }
    return Promise.resolve(reply).then((r) => (isObject(r) ? r : { ok: false, error: NOT_REACHABLE }), () => ({ ok: false, error: NOT_REACHABLE }));
  } catch {
    return refused('That request was not valid.');
  }
}

let changedCallbacks = 0;
const MAX_CALLBACKS = 4;             // the page registers one; a runaway loop must not pile up listeners

contextBridge.exposeInMainWorld('alles', {
  invoke,
  // main -> page: "something changed, ask again". Carries no data on purpose.
  onChanged: (cb) => {
    if (typeof cb !== 'function' || changedCallbacks >= MAX_CALLBACKS) return;
    changedCallbacks++;
    ipcRenderer.on('settings:changed', () => { try { cb(); } catch { /* the page's problem, not ours */ } });
  },
});
