'use strict';

const { PRESETS } = require('./openai-compat');

/**
 * Turns the saved provider list (settings.providers.routes: NON-secret) plus the key store (secret) into
 * (a) the routes the ProviderRouter runs, and (b) a description the Settings screen can show.
 * Empty model / baseUrl in a saved route mean "use the preset for its kind".
 */

const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };

// A suggestion for ONE of the shipped routes that differs from its kind's preset. The NVIDIA fallback suggests a different MODEL from the
// primary: when the primary's model is overloaded or out of service (a newly released model on a trial endpoint often is), a second
// route on the same model would fail the same way. Empty `model` in the saved route still means "use the suggestion".
const SUGGESTED_FOR_ID = Object.freeze({
  'nvidia-fallback': { model: 'moonshotai/kimi-k2.6' },
});

function resolveRoute(r) {
  const preset = PRESETS[r.kind] || PRESETS.custom;
  const suggested = (r.id && SUGGESTED_FOR_ID[r.id]) || {};
  return {
    model: r.model || suggested.model || preset.model,
    baseUrl: r.baseUrl || preset.baseUrl,
    modelIsDefault: !r.model && !!preset.model,
    urlIsDefault: !r.baseUrl && !!preset.baseUrl,
  };
}

/** Routes for the ProviderRouter, in the user's priority order. Keys are decrypted here - main process only. */
function buildRoutes(routes, keyStore) {
  return routes.map((r) => {
    const x = resolveRoute(r);
    return { id: r.id, label: r.label, adapter: 'openai', model: x.model, baseUrl: x.baseUrl, enabled: r.enabled, keys: keyStore.secrets(r.id) };
  });
}

/**
 * What the Settings screen shows for each route. Contains NO secrets. `problem` is the single most useful
 * thing to tell the user about the route right now (or null when it is ready).
 * @param {object[]} routerStatus  ProviderRouter.status(), to surface a remembered rejection
 */
function describeRoutes(routes, keyStore, routerStatus = []) {
  return routes.map((r) => {
    const x = resolveRoute(r);
    const keys = keyStore.list(r.id);
    const unreadable = keys.filter((k) => !k.readable).length;
    const live = routerStatus.find((s) => s.id === r.id);

    // problemKind tells the UI how to colour it: 'setup' = not finished configuring yet (a nudge),
    // 'broken' = it should work but does not (the keys cannot be read, or the provider rejected it).
    let problem = null; let problemKind = null;
    if (!x.model) { problem = 'Choose a model.'; problemKind = 'setup'; }
    else if (!x.baseUrl) { problem = 'Set the base URL.'; problemKind = 'setup'; }
    else if (!keys.length) { problem = 'Add an API key.'; problemKind = 'setup'; }
    else if (unreadable === keys.length) { problem = 'The saved keys cannot be decrypted (the system keyring may be locked). Add the key again.'; problemKind = 'broken'; }
    else if (live && live.problem) { problem = live.problem; problemKind = 'broken'; }

    return {
      id: r.id, kind: r.kind, label: r.label, enabled: r.enabled,
      model: x.model, modelIsDefault: x.modelIsDefault,
      baseUrl: x.baseUrl, urlIsDefault: x.urlIsDefault, host: hostOf(x.baseUrl),
      // Suggested defaults were never verified against the live service; say so instead of implying they work.
      defaultsUnverified: x.modelIsDefault || x.urlIsDefault,
      keys, unreadableKeys: unreadable,
      ready: r.enabled && !problem, problem, problemKind,
    };
  });
}

/** Ids for a new custom route: custom, custom-2, custom-3 ... never colliding with an existing id. */
function nextRouteId(routes, base = 'custom') {
  const used = new Set(routes.map((r) => r.id));
  if (!used.has(base)) return base;
  for (let i = 2; i < 100; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now().toString(36)}`.slice(0, 32);
}

module.exports = { buildRoutes, describeRoutes, resolveRoute, nextRouteId, hostOf, SUGGESTED_FOR_ID };
