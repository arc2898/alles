'use strict';

const { probeRoute } = require('./providers/probe');
const { nextRouteId, resolveRoute } = require('./providers/config');
const { KINDS, MAX_ROUTES, MODEL_RE, cleanBaseUrl } = require('./settings');
const { MAX_KEYS_PER_ROUTE } = require('./keystore');

/**
 * Settings IPC - the main-side half of the Settings window.
 *
 * DESIGN RULES (mirroring window.js's page<->main contract):
 *  1. Every call is a named REQUEST/RESPONSE (ipcMain.handle), not a fire-and-forget send: the settings
 *     UI needs return values (the new route id, the probe result, a validation error) to update itself.
 *  2. A secret NEVER leaves this file toward the renderer. add-key sends a plaintext key IN (over a
 *     contextIsolated, non-remote channel - this is the one place a key legitimately crosses the wire at
 *     all, exactly once, on explicit user action) and returns only {id, hint}. describe-providers returns
 *     app.describeProviders(), which lists each route's keys as hints and flags only (see its own tests in
 *     providers-config.test.js and keystore.test.js).
 *  3. Every handler validates its own input independently of whatever the preload already checked -
 *     the preload is the first gate, this is the second, exactly as window.js's cleanPayload is for the pill.
 *  4. Handlers return a uniform {ok, ...} or {ok:false, error} shape, so the renderer never needs a
 *     try/catch around invoke() for the expected failure cases (a bad key, an unreachable host).
 *  5. Every request is checked for WHO is asking before anything else happens. `isTrusted(event)` is required:
 *     there is no default, because "serve settings and API keys to anyone who asks" must never be what you get
 *     by forgetting an argument. An untrusted caller gets {ok:false, error:'Not allowed.'} and nothing runs.
 */

const ROUTE_ID_RE = /^[a-z0-9-]{1,32}$/;

const URL_PROBLEM = 'That address was not accepted. It must start with https:// (http:// is only allowed for localhost) and must not contain a user name or password.';
const MODEL_PROBLEM = 'That model name was not accepted. Use letters, digits and . _ : / @ + - only, up to 120 characters.';

function fail(error) { return { ok: false, error: String(error) }; }
function ok(data = {}) { return { ok: true, ...data }; }

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {import('./app').App} app  already `.create()`d
 * @param {{isTrusted:(event:object)=>boolean}} o  who may call: the Settings window's own page, nobody else
 * @returns {() => void} unsubscribe, mirroring attachPageEvents's return convention
 */
function attachSettingsIpc(ipcMain, app, { isTrusted } = {}) {
  if (typeof isTrusted !== 'function') throw new TypeError('attachSettingsIpc needs isTrusted(event): it will not serve settings and API keys to unchecked callers.');
  // A check that throws is a NO, never a yes.
  const trusted = (event) => { try { return isTrusted(event) === true; } catch { return false; } };

  const handlers = {
    // ---- read -------------------------------------------------------------------------------------
    'settings:get': async () => ok({ settings: app.settings.get(), keyStorage: app.keyStore.status(), info: app.info() }),
    'settings:describe-providers': async () => ok({ routes: app.describeProviders() }),
    'settings:load-issue': async () => ok({ settings: app.settings.loadIssue, keys: app.keyStore.loadIssue }),

    // ---- generic settings patch (dock placement, safety toggles, tray, security policy) -----------
    'settings:update': async (patch) => {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return fail('Invalid update.');
      // Route/key management goes through the dedicated handlers below (they need KeyStore, not just
      // SettingsStore), so a raw `providers` patch here is rejected rather than silently accepted and
      // then contradicted by whatever route-add/remove/edit calls follow it.
      if ('providers' in patch) return fail('Use the provider-specific actions to change routes.');
      const next = app.settings.update(patch);
      return ok({ settings: next });
    },

    // ---- provider routes ----------------------------------------------------------------------------
    'settings:add-route': async (kind) => {
      if (typeof kind !== 'string' || !KINDS.includes(kind)) return fail('Invalid provider kind.');
      const routes = app.settings.get().providers.routes;
      if (routes.length >= MAX_ROUTES) return fail(`At most ${MAX_ROUTES} providers.`);
      const id = nextRouteId(routes, kind === 'custom' ? 'custom' : kind);
      const label = { nvidia: 'NVIDIA', grok: 'Grok', gemini: 'Gemini', custom: 'Custom' }[kind] || kind;
      const route = { id, kind, label, model: '', baseUrl: '', enabled: true };
      app.settings.update({ providers: { routes: [...routes, route] } });
      return ok({ id });
    },

    'settings:update-route': async (patch) => {
      if (!patch || typeof patch !== 'object' || typeof patch.id !== 'string' || !ROUTE_ID_RE.test(patch.id)) return fail('Invalid route update.');
      const routes = app.settings.get().providers.routes;
      const i = routes.findIndex((r) => r.id === patch.id);
      if (i < 0) return fail('No such provider.');
      const fields = {};
      for (const k of ['label', 'model', 'baseUrl', 'enabled']) if (Object.prototype.hasOwnProperty.call(patch, k)) fields[k] = patch[k];
      // Refuse a bad value OUT LOUD. The settings store would quietly turn it into "use the default" - which would throw
      // away the address or model that was working a moment ago, and for an address could send the key somewhere else.
      // Nothing is applied unless every field in the request is acceptable.
      if ('label' in fields && typeof fields.label !== 'string') return fail('Invalid name.');
      if ('enabled' in fields && typeof fields.enabled !== 'boolean') return fail('Invalid setting.');
      if ('model' in fields) {
        if (typeof fields.model !== 'string') return fail('Invalid model.');
        fields.model = fields.model.trim();
        if (fields.model && !MODEL_RE.test(fields.model)) return fail(MODEL_PROBLEM);
      }
      if ('baseUrl' in fields) {
        if (typeof fields.baseUrl !== 'string') return fail('Invalid address.');
        fields.baseUrl = fields.baseUrl.trim();
        if (fields.baseUrl && cleanBaseUrl(fields.baseUrl) === '') return fail(URL_PROBLEM);
      }
      const next = routes.map((r, idx) => (idx === i ? { ...r, ...fields } : r));
      app.settings.update({ providers: { routes: next } });
      return ok({});
    },

    'settings:remove-route': async (routeId) => {
      if (typeof routeId !== 'string' || !ROUTE_ID_RE.test(routeId)) return fail('Invalid provider id.');
      const current = app.settings.get().providers.routes;
      if (!current.some((r) => r.id === routeId)) return fail('No such provider.');
      try { app.keyStore.removeRoute(routeId); }
      catch (e) { return fail(e && e.message ? e.message : 'Could not remove the provider keys.'); }
      const routes = current.filter((r) => r.id !== routeId);
      app.settings.update({ providers: { routes } });
      return ok({});
    },

    'settings:reorder-routes': async (ids) => {
      if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) return fail('Invalid order.');
      const routes = app.settings.get().providers.routes;
      const byId = new Map(routes.map((r) => [r.id, r]));
      // Every id in the INPUT must be a real, distinct route id, and every existing route must appear
      // exactly once. Checked against `ids` directly (not the filtered/mapped result) so an unknown id
      // cannot be silently dropped by .filter(Boolean) and coincidentally still pass a length check -
      // that was a real bug here: ids.map(byId.get).filter(Boolean) discards unknown ids before the
      // length comparison ever sees them, so [...validIds, 'not-a-real-id'] passed validation.
      const knownCount = ids.filter((id) => byId.has(id)).length;
      if (ids.length !== routes.length || knownCount !== ids.length || new Set(ids).size !== ids.length) {
        return fail('The new order does not match the existing providers.');
      }
      app.settings.update({ providers: { routes: ids.map((id) => byId.get(id)) } });
      return ok({});
    },

    // ---- keys: the only place a secret crosses this boundary, and only inbound -----------------------
    'settings:add-key': async (arg) => {
      if (!arg || typeof arg !== 'object' || typeof arg.routeId !== 'string' || !ROUTE_ID_RE.test(arg.routeId) || typeof arg.key !== 'string') return fail('Invalid key.');
      try { const r = app.keyStore.add(arg.routeId, arg.key); return ok({ id: r.id, hint: r.hint, mode: r.mode }); }
      catch (e) { return fail(e.message); }
    },
    'settings:remove-key': async (arg) => {
      if (!arg || typeof arg !== 'object' || typeof arg.routeId !== 'string' || typeof arg.keyId !== 'string') return fail('Invalid request.');
      const removed = app.keyStore.remove(arg.routeId, arg.keyId);
      return removed ? ok({}) : fail('Key not found.');
    },

    // ---- test a provider: decrypt ONE key here, call probeRoute, return only the (secret-free) result --
    'settings:test-route': async (arg) => {
      if (!arg || typeof arg !== 'object' || typeof arg.routeId !== 'string') return fail('Invalid request.');
      const routes = app.settings.get().providers.routes;
      const route = routes.find((r) => r.id === arg.routeId);
      if (!route) return fail('No such provider.');
      const resolved = resolveRoute(route);
      const entries = app.keyStore.list(route.id);
      if (!entries.length) return fail('Add an API key first.');
      const keyId = typeof arg.keyId === 'string' ? arg.keyId : entries[0].id;
      const apiKey = app.keyStore.secretById(route.id, keyId);
      if (apiKey === null) return fail('That key cannot be decrypted right now (the system keyring may be locked).');
      const result = await probeRoute({ route: { model: resolved.model, baseUrl: resolved.baseUrl }, apiKey });
      return ok({ result });
    },

    // ---- "check this computer": tries the screenshot and the mouse and keyboard, reports in plain words (doctor.js) -----------------
    'settings:check-computer': async () => ok(await app.checkComputer()),

    // ---- after the person turns on saved key storage: keys that were only being held in memory get saved now ------
    // (returns how many were moved; 0 while storage is still "this session only")
    'settings:migrate-session-keys': async () => ok({ migrated: app.keyStore.migrateSession() }),
  };

  const dispatch = async (name, payload) => {
    const fn = handlers[name];
    if (!fn) return fail(`Unknown action "${name}".`);
    try { return await fn(payload); } catch (e) { return fail(e.message || String(e)); }
  };

  for (const name of Object.keys(handlers)) {
    ipcMain.handle(name, (event, payload) => (trusted(event) ? dispatch(name, payload) : fail('Not allowed.')));
  }
  return () => { for (const name of Object.keys(handlers)) ipcMain.removeHandler(name); };
}

module.exports = { attachSettingsIpc, ROUTE_ID_RE };
