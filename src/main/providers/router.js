'use strict';

const { redact } = require('../redact');

/**
 * ProviderRouter
 *
 * Routes a chat request through an ordered list of "routes". Each route is one provider with a
 * POOL of API keys. Walk routes in priority order; inside a route rotate through its keys,
 * skipping any that are cooling down. How a failure is handled depends on WHAT failed:
 *
 *   429 / 5xx / network  -> the KEY (or the network) is the problem: cool that key, try the next
 *                           key, then the next route.
 *   401 / 402 / 403      -> the KEY is bad or out of credit: long cooldown for that key.
 *   400 / 404 / 413 / 422 -> the REQUEST WAS REJECTED BY THIS ROUTE: typically a wrong model name,
 *                           or a model that cannot take images or tools. Every other key on the
 *                           same route would be rejected identically, so skip the rest of this
 *                           route (and remember it, so it is not re-tried on every agent step),
 *                           then carry on with the NEXT route.
 *
 * WHY 4xx DOES NOT STOP THE WHOLE REQUEST (this used to be "fatal"): routes are different
 * vendors with different models. A primary that cannot accept screenshots must not prevent a
 * vision-capable fallback from serving the task. If EVERY route rejects, that is reported as one
 * clear error - it then really is the request (or the setup) that is wrong.
 *
 * Adapters are injected so this file has no network code and is unit-testable.
 * Every message that leaves this file has the keys we hold stripped from it (see redact.js).
 */

const COOLDOWN_MS = {
  rateLimit: 60_000,      // 429: back off one minute
  server: 15_000,         // 5xx / network: short
  auth: 30 * 60_000,      // 401/402/403: key is bad or out of credit, long cooldown
  rejected: 10 * 60_000,  // 400/404/413/422: this ROUTE cannot serve this kind of request
};

class ProviderError extends Error {
  constructor(message, { status = null, retryAfterMs = null, cause = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.cause = cause;
  }
}

function classify(err) {
  const s = err && err.status;
  if (s === 429) return 'rateLimit';
  if (s === 401 || s === 402 || s === 403) return 'auth';
  if (s === 400 || s === 404 || s === 413 || s === 422) return 'rejected';          // 413: the request (screenshots) is bigger than this route takes
  return 'server'; // 5xx, timeouts, DNS, unknown -> retryable
}

class KeyPool {
  /**
   * @param {string[]} keys
   * @param {() => number} now  injectable clock for tests
   */
  constructor(keys, now = Date.now) {
    this.now = now;
    this.entries = keys
      .map((k) => (typeof k === 'string' ? k.trim() : ''))
      .filter(Boolean)
      .map((key, i) => ({ key, id: i, cooldownUntil: 0, failures: 0, uses: 0 }));
    this.cursor = 0;
  }

  get size() { return this.entries.length; }

  /** Next usable key (round-robin), or null if all are cooling down. */
  next() {
    const n = this.entries.length;
    for (let i = 0; i < n; i++) {
      const e = this.entries[(this.cursor + i) % n];
      if (e.cooldownUntil <= this.now()) {
        this.cursor = (this.cursor + i + 1) % n;
        e.uses++;
        return e;
      }
    }
    return null;
  }

  cool(entry, kind, retryAfterMs) {
    entry.failures++;
    entry.cooldownUntil = this.now() + (retryAfterMs ?? COOLDOWN_MS[kind] ?? COOLDOWN_MS.server);
  }

  ok(entry) { entry.failures = 0; }

  /** Safe-to-display status (never leaks the key itself). */
  status() {
    const t = this.now();
    return this.entries.map((e) => ({
      id: e.id,
      hint: e.key.length > 8 ? `${e.key.slice(0, 4)}…${e.key.slice(-3)}` : '****',
      available: e.cooldownUntil <= t,
      cooldownSec: Math.max(0, Math.ceil((e.cooldownUntil - t) / 1000)),
      failures: e.failures,
      uses: e.uses,
    }));
  }
}

class ProviderRouter {
  /**
   * @param {Array<{id:string,label:string,adapter:string,model:string,baseUrl?:string,keys:string[],enabled?:boolean}>} routes  priority order
   * @param {Record<string,(req:object, ctx:object)=>Promise<object>>} adapters
   */
  constructor(routes, adapters, { now = Date.now, onEvent = () => {} } = {}) {
    this.adapters = adapters;
    this.onEvent = onEvent;
    this.now = now;
    this.setRoutes(routes);
  }

  setRoutes(routes) {
    this.routes = routes.map((r) => ({
      ...r,
      enabled: r.enabled !== false,
      pool: new KeyPool(r.keys || [], this.now),
      rejectedUntil: 0,        // route-level cooldown after a 4xx rejection
      problem: null,           // why, in words, for the Settings screen
    }));
  }

  /**
   * Run a request. Returns { response, route, label, attempts }.
   * Throws a ProviderError only if EVERY route/key failed.
   */
  async chat(request) {
    const attempts = [];
    // The person pressed Stop: the request is dropped. That is not a failure of any key or provider, so nothing is cooled down and no
    // other key or provider is tried (each would be dropped at once, and every key would be left "cooling" for the next task).
    const stopped = () => !!(request && request.signal && request.signal.aborted);
    const stop = () => new ProviderError('Stopped by the user', { cause: attempts });

    for (const route of this.routes) {
      if (!route.enabled) continue;
      const adapter = this.adapters[route.adapter];
      if (!adapter) { attempts.push({ route: route.id, kind: 'config', error: `no adapter "${route.adapter}"` }); continue; }
      if (route.pool.size === 0) { attempts.push({ route: route.id, kind: 'nokeys', error: 'no API keys added' }); continue; }
      if (route.rejectedUntil > this.now()) { attempts.push({ route: route.id, kind: 'skipped', error: route.problem }); continue; }

      // Try every key in this route's pool at most once.
      let used = 0;
      for (let tried = 0; tried < route.pool.size; tried++) {
        if (stopped()) throw stop();
        const entry = route.pool.next();
        if (!entry) break; // everything in this pool is cooling down
        used++;

        this.onEvent({ type: 'attempt', route: route.id, label: route.label, keyId: entry.id });

        try {
          const response = await adapter(request, { apiKey: entry.key, model: route.model, baseUrl: route.baseUrl });
          route.pool.ok(entry);
          this.onEvent({ type: 'success', route: route.id, label: route.label, keyId: entry.id });
          return { response, route: route.id, label: route.label, attempts };
        } catch (err) {
          if (stopped()) throw stop();
          const kind = classify(err);
          const msg = redact(String((err && err.message) || err).slice(0, 300), [entry.key]);
          attempts.push({ route: route.id, keyId: entry.id, kind, status: (err && err.status) ?? null, error: msg });
          this.onEvent({ type: 'failure', route: route.id, label: route.label, keyId: entry.id, kind, status: (err && err.status) ?? null });

          if (kind === 'rejected') {
            route.rejectedUntil = this.now() + COOLDOWN_MS.rejected;
            route.problem = `${route.label} rejected the request: ${msg}`;
            this.onEvent({ type: 'route-rejected', route: route.id, label: route.label, problem: route.problem });
            break;   // the other keys of this route would be rejected the same way
          }
          route.pool.cool(entry, kind, err && err.retryAfterMs);
        }
      }
      // Keys exist but none could be used at all: they are all cooling down from earlier errors. Record that,
      // so the final error says "temporarily unavailable" and NOT "add a key" (the user already has keys).
      if (used === 0 && !(route.rejectedUntil > this.now())) attempts.push({ route: route.id, kind: 'cooling', status: null, error: 'all keys are cooling down after earlier errors' });
      this.onEvent({ type: 'route-exhausted', route: route.id, label: route.label });
    }

    const tried = attempts.filter((a) => a.kind !== 'nokeys' && a.kind !== 'config');
    const summary = attempts.map((a) => `${a.route}${a.keyId !== undefined ? '#' + a.keyId : ''}:${a.status ?? a.kind}`).join(', ');

    if (!tried.length) {
      throw new ProviderError('No usable API key is configured. Open Settings and add a key for at least one provider.', { cause: attempts });
    }
    if (tried.every((a) => a.kind === 'rejected' || a.kind === 'skipped')) {
      const first = tried.find((a) => a.kind === 'rejected') || tried[0];
      const labelOf = (id) => (this.routes.find((r) => r.id === id) || {}).label || id;
      // Name each provider and give ITS reason (a 'skipped' route already carries its label in the stored reason).
      const reasons = [...new Set(tried.map((a) => (a.kind === 'skipped' ? a.error : `${labelOf(a.route)}: ${a.error}`)))];
      throw new ProviderError(`Every provider rejected the request. ${reasons.join(' | ')}`, { status: first.status ?? 400, cause: attempts });
    }
    throw new ProviderError(`All providers failed (${summary})`, { cause: attempts });
  }

  /** Status snapshot for the settings GUI. */
  status() {
    return this.routes.map((r) => ({
      id: r.id, label: r.label, adapter: r.adapter, model: r.model,
      enabled: r.enabled, keys: r.pool.status(),
      problem: r.rejectedUntil > this.now() ? r.problem : null,
      problemForSec: Math.max(0, Math.ceil((r.rejectedUntil - this.now()) / 1000)),
    }));
  }
}

module.exports = { ProviderRouter, KeyPool, ProviderError, classify, COOLDOWN_MS };
