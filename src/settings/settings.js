'use strict';
/**
 * ALLES Settings page. Runs sandboxed: no Node, no require, and the ONLY way out is window.alles (preload.cjs).
 *
 * HOW THIS FILE STAYS SAFE
 *  - Everything on screen is built with h(), which only ever creates text nodes. There is no innerHTML anywhere, so
 *    a provider called "<img onerror=...>" or an error message from a hostile server is shown as plain text.
 *  - The main process is the source of truth. Every change is sent, then the page re-reads everything and redraws.
 *    The page never keeps its own copy of what "should" be saved.
 *  - API keys go IN once (Add key) and are never read back: all the page ever gets is a short hint like "nvap…abc".
 *
 * HOW IT STAYS USABLE
 *  - A redraw never steals your place: the focused field, its text and cursor, and the scroll position are restored.
 *  - A redraw never swallows a click: while a mouse button is held down, redraws wait until it is released.
 *  - Actions run one after another, so "type a model, then press Test" tests the model you just typed.
 */
(function () {
  const M = window.SettingsModel;
  const bridge = window.alles;
  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- elements: text only, never HTML

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'fk') el.dataset.fk = v;                                             // "focus key": survives a redraw
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);        // CSSOM only: CSP forbids style attributes
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') { el.value = v; el.dataset.rendered = String(v); }          // remember what we drew, to tell "typed since" from "drawn"
      else if (k === 'checked' || k === 'disabled' || k === 'hidden') el[k] = v;           // properties, so they follow what the user does
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === undefined || kid === null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  let idCounter = 0;
  const uid = (prefix) => `${prefix}-${++idCounter}`;

  // ---------------------------------------------------------------- state

  const state = {
    loaded: false,
    fatal: null,                   // why we cannot show anything at all
    settings: null, keyStorage: null, info: null, routes: [],
    issues: { settings: null, keys: null },
    dismissed: new Set(),          // load-issue banners the person has closed
    pane: 'providers',
    openId: null,                  // the provider card that is open
    drafts: {},                    // text the main process refused, kept so a typo can be fixed ('routeId:field')
    notices: {},                   // why it was refused
    tests: {},                     // routeId -> { running } | { view } | { error }
    doctor: null,                  // "Check this computer": null | { running } | { view } | { error }
    confirmRemove: null,           // routeId waiting for a second click
    confirmPlain: false,           // plain-text key storage waiting for a second click
    lastSpot: null,                // where the placement diagram's pill was, so it can slide to the new spot
  };

  const PANES = [
    ['providers', 'Providers'],
    ['island', 'Island'],
    ['input', 'Mouse & keyboard'],
    ['safety', 'Safety'],
    ['storage', 'Key storage'],
    ['about', 'About'],
  ];

  // ---------------------------------------------------------------- talking to the main process

  async function api(name, payload) {
    try {
      const reply = await bridge.invoke(name, payload);
      return reply && typeof reply === 'object' ? reply : { ok: false, error: 'No answer from ALLES.' };
    } catch {
      return { ok: false, error: 'ALLES could not be reached. Close this window and open Settings again.' };
    }
  }

  // One thing at a time, in the order the person did them.
  let chain = Promise.resolve();
  function enqueue(fn) {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  }

  let refreshing = null;
  let refreshAgain = false;
  function refresh() {
    if (refreshing) { refreshAgain = true; return refreshing; }
    refreshing = (async () => {
      try {
        do {
          refreshAgain = false;
          const [g, d, i] = await Promise.all([api('settings:get'), api('settings:describe-providers'), api('settings:load-issue')]);
          if (!g.ok || !d.ok) {
            state.fatal = (!g.ok ? g.error : d.error) || 'Settings could not be loaded.';
          } else {
            state.fatal = null;
            state.settings = g.settings; state.keyStorage = g.keyStorage; state.info = g.info || {};
            state.routes = d.routes;
            state.issues = i.ok ? { settings: i.settings, keys: i.keys } : { settings: null, keys: null };
            if (!state.loaded) {
              // First look: open the first provider that still needs a key or a model, so the next step is right there.
              const todo = state.routes.find((r) => r.enabled && r.problemKind === 'setup');
              state.openId = todo ? todo.id : null;
            }
            state.loaded = true;
          }
          requestRender();
        } while (refreshAgain);
      } finally { refreshing = null; }
    })();
    return refreshing;
  }

  // ---------------------------------------------------------------- redraw without losing the person's place

  let pointerDown = false;
  let renderPending = false;
  document.addEventListener('pointerdown', () => { pointerDown = true; }, true);
  const pointerUp = () => { if (!pointerDown) return; pointerDown = false; setTimeout(() => { if (renderPending) render(); }, 0); };
  document.addEventListener('pointerup', pointerUp, true);
  document.addEventListener('pointercancel', pointerUp, true);
  window.addEventListener('blur', pointerUp);

  function requestRender() {
    if (pointerDown) { renderPending = true; return; }   // wait for the click to finish, or it would be lost
    render();
  }

  function captureFocus() {
    const a = document.activeElement;
    if (!a || !a.dataset || !a.dataset.fk) return null;
    const c = { fk: a.dataset.fk };
    // Text the person has typed but not committed yet must survive a redraw. Text they HAVE committed must not: the
    // saved value (which may have been corrected, e.g. clamped to a limit) is what the box should show afterwards.
    if (a.tagName === 'INPUT' && a.type !== 'checkbox' && a.value !== a.dataset.rendered) { c.value = a.value; c.start = a.selectionStart; c.end = a.selectionEnd; }
    return c;
  }

  function restoreFocus(c) {
    if (!c) return;
    const el = document.querySelector(`[data-fk="${CSS.escape(c.fk)}"]`);
    if (!el) return;
    if (c.value !== undefined && el.tagName === 'INPUT') {
      el.value = c.value;                                                  // text typed but not yet saved
      try { el.setSelectionRange(c.start, c.end); } catch { /* not every input type has a cursor */ }
    }
    el.focus({ preventScroll: true });
  }

  let toastTimer = null;
  function toast(message, tone) {
    const el = $('toast');
    el.textContent = message;
    el.dataset.tone = tone || '';
    el.dataset.show = 'true';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.dataset.show = 'false'; }, tone === 'problem' ? 6500 : 2600);
  }

  // ---------------------------------------------------------------- small building blocks

  function banner(tone, title, lines, onClose) {
    return h('div', { class: 'banner', 'data-tone': tone, role: tone === 'problem' ? 'alert' : null },
      h('div', { class: 'banner-body' },
        title ? h('p', { class: 'banner-title' }, title) : null,
        (lines || []).map((l) => h('p', null, l))),
      onClose ? h('button', { class: 'btn', 'data-kind': 'icon', 'aria-label': 'Dismiss', onclick: onClose }, '✕') : null);
  }

  function pane(id, title, lede, ...children) {
    return h('section', { class: 'pane', 'aria-labelledby': `h-${id}` },
      h('header', { class: 'pane-head' }, h('h1', { id: `h-${id}` }, title), lede ? h('p', { class: 'lede' }, lede) : null),
      children);
  }

  function row(title, desc, control, extra) {
    return h('div', { class: 'row' },
      h('div', { class: 'row-text' }, h('div', { class: 'row-title' }, title), desc ? h('p', { class: 'row-desc' }, desc) : null),
      control ? h('div', { class: 'row-control' }, control) : null,
      extra ? h('div', { class: 'row-extra' }, extra) : null);
  }

  function field(labelText, control, ...notes) {
    const id = uid('f');
    control.id = id;
    return h('div', { class: 'field' }, h('label', { class: 'field-label', for: id }, labelText), control, notes);
  }

  function switchEl({ checked, label, fk, onchange }) {
    return h('label', { class: 'switch' },
      h('input', { type: 'checkbox', role: 'switch', checked, 'aria-label': label, fk, onchange: (e) => onchange(e.target.checked) }),
      h('span', { class: 'switch-track', 'aria-hidden': 'true' }));
  }

  function segmented({ label, options, value, onPick, fk }) {
    return h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label },
      options.map(([val, text]) => h('button', { class: 'seg-item', role: 'radio', 'aria-checked': String(val === value), fk: `${fk}:${val}`, onclick: () => onPick(val) }, text)));
  }

  function textInput({ value, placeholder, fk, mono, label, onCommit }) {
    return h('input', {
      class: mono ? 'input mono' : 'input', type: 'text', value, placeholder, fk,
      spellcheck: 'false', autocomplete: 'off', 'aria-label': label,
      onchange: (e) => { e.target.dataset.rendered = e.target.value; onCommit(e.target.value.trim()); },
    });
  }

  // ---------------------------------------------------------------- actions (each one: send, then re-read everything)

  function patch(path, value) {
    const p = M.patchFor(path, value);
    if (!p) return Promise.resolve();
    return patchMany(p);
  }

  function patchMany(obj) {
    return enqueue(async () => {
      const res = await api('settings:update', obj);
      if (!res.ok) toast(res.error, 'problem');
      await refresh();
    });
  }

  /**
   * Change fields of one provider. If the main process refuses a model name or address it says why: show that next to
   * the field and keep what was typed so a typo can be fixed. The old, working value is left untouched.
   */
  function saveRoute(id, fields) {
    return enqueue(async () => {
      const res = await api('settings:update-route', { id, ...fields });
      for (const field of ['model', 'baseUrl']) {
        if (!(field in fields)) continue;
        const key = `${id}:${field}`;
        if (!res.ok) { state.notices[key] = res.error; state.drafts[key] = fields[field]; }
        else { delete state.notices[key]; delete state.drafts[key]; }
      }
      if (!res.ok && !('model' in fields) && !('baseUrl' in fields)) toast(res.error, 'problem');
      await refresh();
    });
  }

  function addRoute(kind) {
    return enqueue(async () => {
      const res = await api('settings:add-route', kind);
      if (!res.ok) { toast(res.error, 'problem'); return; }
      state.openId = res.id;
      await refresh();
    });
  }

  function removeRoute(id) {
    return enqueue(async () => {
      const res = await api('settings:remove-route', id);
      state.confirmRemove = null;
      if (!res.ok) toast(res.error, 'problem');
      else { if (state.openId === id) state.openId = null; delete state.tests[id]; toast('Provider removed.'); }
      await refresh();
    });
  }

  function moveRoute(id, delta) {
    return enqueue(async () => {
      const ids = M.moveId(state.routes.map((r) => r.id), id, delta);
      const res = await api('settings:reorder-routes', ids);
      if (!res.ok) toast(res.error, 'problem');
      await refresh();
    });
  }

  function addKey(routeId, input, errorEl) {
    const check = M.checkKeyInput(input.value);
    if (!check.ok) { errorEl.textContent = check.error; errorEl.hidden = false; input.setAttribute('aria-invalid', 'true'); return Promise.resolve(); }
    errorEl.hidden = true; input.removeAttribute('aria-invalid');
    return enqueue(async () => {
      const res = await api('settings:add-key', { routeId, key: check.key });
      if (!res.ok) { errorEl.textContent = res.error; errorEl.hidden = false; input.setAttribute('aria-invalid', 'true'); return; }
      input.value = '';                                              // the key does not linger in the page
      toast(res.mode === 'session' ? 'Key added. It is kept in memory only.' : 'Key added.', 'ready');
      await refresh();
    });
  }

  function removeKey(routeId, keyId) {
    return enqueue(async () => {
      const res = await api('settings:remove-key', { routeId, keyId });
      if (!res.ok) toast(res.error, 'problem'); else toast('Key removed.');
      await refresh();
    });
  }

  async function runTest(routeId, keyId) {
    await chain;                                                     // let a model name you just typed be saved first
    state.tests[routeId] = { running: true };
    requestRender();
    const res = await api('settings:test-route', keyId ? { routeId, keyId } : { routeId });
    state.tests[routeId] = res.ok ? { view: M.testView(res.result) } : { error: res.error };
    requestRender();
  }

  // A check is a snapshot of one moment. Leaving About forgets it (and drops an answer still on its way), so coming back never
  // shows "no API key" after the person has just added one in Providers.
  let doctorRun = 0;
  function forgetDoctor() { doctorRun++; state.doctor = null; }

  async function runDoctor() {
    if (state.doctor && state.doctor.running) return;              // a second press while it runs is not a second check
    const mine = ++doctorRun;
    state.doctor = { running: true };
    requestRender();
    const res = await api('settings:check-computer');
    if (mine !== doctorRun) return;                                // the person left About meanwhile: this answer is already out of date
    state.doctor = res.ok ? { view: M.computerCheckView(res) } : { error: res.error };
    requestRender();
  }

  function setPlainStorage(on) {
    state.confirmPlain = false;
    return enqueue(async () => {
      const res = await api('settings:update', { security: { keyStorage: on ? 'file' : 'session' } });
      if (!res.ok) toast(res.error, 'problem');
      await refresh();
    });
  }

  function saveMemoryKeys() {
    return enqueue(async () => {
      const res = await api('settings:migrate-session-keys');
      if (!res.ok) toast(res.error, 'problem');
      else toast(res.migrated ? `${res.migrated} key${res.migrated === 1 ? '' : 's'} saved.` : 'Nothing to save.', res.migrated ? 'ready' : '');
      await refresh();
    });
  }

  // ---------------------------------------------------------------- Providers

  const CHECK_ICONS = { ok: '✓', fail: '✕', skipped: '–', unknown: '·' };
  const CHECK_WORDS = { ok: 'Passed', fail: 'Failed', skipped: 'Skipped', unknown: 'Not run' };

  function renderProviders() {
    const routes = state.routes;
    return pane('providers', 'Providers',
      'ALLES asks the first provider that is ready. If it is rate-limited, out of credit or unreachable, it moves down the list and tries the first one again later. It needs a model that understands images and can use tools, so test each provider after adding its key.',
      routes.length
        ? h('ol', { class: 'chain' }, routes.map((r, i) => routeItem(r, i, routes)))
        : h('p', { class: 'empty' }, 'No providers yet. Add one below, then paste its API key.'),
      h('div', { class: 'add-provider' },
        h('span', { class: 'add-provider-label' }, 'Add a provider'),
        M.ADD_CHOICES.map((c) => h('button', { class: 'btn', fk: `add:${c.kind}`, disabled: routes.length >= M.MAX_ROUTES, onclick: () => addRoute(c.kind) }, `+ ${c.label}`))),
      routes.length >= M.MAX_ROUTES ? h('p', { class: 'fine' }, `That is the most providers ALLES can hold (${M.MAX_ROUTES}).`) : null);
  }

  function routeItem(route, index, routes) {
    const id = route.id;
    const status = M.routeStatus(route);
    const nextTone = routes[index + 1] ? M.routeStatus(routes[index + 1]).tone : status.tone;
    const open = state.openId === id;
    const test = state.tests[id];
    const first = index === 0; const last = index === routes.length - 1;

    return h('li', { class: 'route', 'data-tone': status.tone, 'data-next': nextTone, 'data-open': String(open), 'data-busy': String(!!(test && test.running)) },
      h('div', { class: 'bead-col' }, h('span', { class: 'bead', 'aria-hidden': 'true' }, String(index + 1))),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' },
          h('button', {
            class: 'card-toggle', 'aria-expanded': String(open), fk: `route:${id}:toggle`,
            onclick: () => {
              if (open) { for (const f of ['model', 'baseUrl']) { delete state.drafts[`${id}:${f}`]; delete state.notices[`${id}:${f}`]; } }
              state.openId = open ? null : id; state.confirmRemove = null; requestRender();
            },
          },
          h('span', { class: 'card-name' },
            h('span', { class: 'card-title' }, h('span', { class: 'sr-only' }, `Provider ${index + 1}: `), route.label),
            h('span', { class: 'card-sub mono' }, `${route.host || 'no address'} · ${route.model || 'no model'}`)),
          h('span', { class: 'chip' }, status.text)),
          h('div', { class: 'card-actions' },
            switchEl({ checked: route.enabled, label: `Use ${route.label}`, fk: `route:${id}:enabled`, onchange: (v) => saveRoute(id, { enabled: v }) }),
            h('button', { class: 'btn', 'data-kind': 'icon', 'aria-label': `Move ${route.label} up`, disabled: first, fk: `route:${id}:up`, onclick: () => moveRoute(id, -1) }, '▲'),
            h('button', { class: 'btn', 'data-kind': 'icon', 'aria-label': `Move ${route.label} down`, disabled: last, fk: `route:${id}:down`, onclick: () => moveRoute(id, +1) }, '▼'))),
        open ? routeBody(route) : null));
  }

  function routeBody(route) {
    const id = route.id;
    const f = M.routeFields(route);
    const draft = (name) => state.drafts[`${id}:${name}`];
    const notice = (name) => (state.notices[`${id}:${name}`] ? h('p', { class: 'field-note', 'data-tone': 'problem' }, state.notices[`${id}:${name}`]) : null);
    const test = state.tests[id];
    const testing = !!(test && test.running);

    const modelInput = textInput({ value: draft('model') !== undefined ? draft('model') : f.modelValue, placeholder: f.modelPlaceholder, fk: `route:${id}:model`, mono: true, label: 'Model', onCommit: (v) => saveRoute(id, { model: v }) });
    const urlInput = textInput({ value: draft('baseUrl') !== undefined ? draft('baseUrl') : f.urlValue, placeholder: f.urlPlaceholder, fk: `route:${id}:baseUrl`, mono: true, label: 'Address', onCommit: (v) => saveRoute(id, { baseUrl: v }) });
    if (state.notices[`${id}:model`]) modelInput.setAttribute('aria-invalid', 'true');
    if (state.notices[`${id}:baseUrl`]) urlInput.setAttribute('aria-invalid', 'true');

    const keyInput = h('input', {
      class: 'input mono', type: 'password', placeholder: 'Paste an API key', fk: `route:${id}:newkey`,
      autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', 'aria-label': `New API key for ${route.label}`,
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addKey(id, keyInput, keyError); } },
    });
    const keyError = h('p', { class: 'field-note', 'data-tone': 'problem', role: 'alert', hidden: true });

    const unverified = M.unverifiedNote(route);

    return h('div', { class: 'card-body' },
      h('div', { class: 'form-grid' },
        h('div', { class: 'span-2' }, field('Name', textInput({ value: f.labelValue, placeholder: 'Name', fk: `route:${id}:label`, label: 'Name', onCommit: (v) => saveRoute(id, { label: v }) }))),
        field('Model', modelInput, notice('model')),
        field('Address', urlInput, notice('baseUrl')),
        unverified ? h('p', { class: 'field-note span-2' }, unverified) : null),

      h('div', { class: 'sub-title' }, h('span', null, 'API keys'), h('span', { class: 'muted' }, route.keys.length ? `${route.keys.length} added` : '')),
      route.keys.length
        ? h('div', { class: 'keys' }, route.keys.map((k) => {
          const v = M.keyView(k);
          return h('div', { class: 'key-row' },
            h('span', { class: 'key-hint mono' }, v.hint),
            v.tags.map((t) => h('span', { class: 'tag' }, t)),
            h('button', { class: 'btn', 'data-size': 'small', disabled: testing, fk: `route:${id}:test:${k.id}`, 'aria-label': `Test key ${v.hint}`, onclick: () => runTest(id, k.id) }, 'Test'),
            h('button', { class: 'btn', 'data-size': 'small', 'data-kind': 'danger', fk: `route:${id}:rmkey:${k.id}`, 'aria-label': `Remove key ${v.hint}`, onclick: () => removeKey(id, k.id) }, 'Remove'));
        }))
        : h('p', { class: 'empty' }, 'No keys yet. Paste one below.'),
      h('div', { class: 'key-add' }, keyInput, h('button', { class: 'btn', 'data-kind': 'primary', fk: `route:${id}:addkey`, onclick: () => addKey(id, keyInput, keyError) }, 'Add key')),
      keyError,
      h('p', { class: 'fine' }, 'Add more than one key to spread the load. ALLES rotates between them and sets one aside while it is rate-limited. A key is never shown again after you add it.'),

      h('div', { class: 'sub-title' }, h('span', null, 'Test')),
      h('div', { class: 'test' },
        h('button', { class: 'btn', fk: `route:${id}:testall`, disabled: testing || !route.keys.length, onclick: () => runTest(id) }, testing ? 'Testing…' : 'Test provider'),
        h('span', { class: 'muted' }, route.keys.length ? 'Sends four tiny requests: text, an image, a tool call and the next step after it.' : 'Add a key to test it.')),
      testResult(test),

      h('div', { class: 'card-foot' }, state.confirmRemove === id
        ? h('div', { class: 'confirm' },
          h('span', { class: 'confirm-text' }, route.keys.length ? `Remove ${route.label} and its ${route.keys.length} key${route.keys.length === 1 ? '' : 's'}?` : `Remove ${route.label}?`),
          h('button', { class: 'btn', 'data-kind': 'danger', fk: `route:${id}:rm-yes`, onclick: () => removeRoute(id) }, 'Remove'),
          h('button', { class: 'btn', fk: `route:${id}:rm-no`, onclick: () => { state.confirmRemove = null; requestRender(); } }, 'Keep'))
        : h('button', { class: 'btn', 'data-kind': 'danger', fk: `route:${id}:rm`, onclick: () => { state.confirmRemove = id; requestRender(); } }, 'Remove provider')));
  }

  function testResult(test) {
    if (!test) return null;
    if (test.running) return h('p', { class: 'fine' }, 'Contacting the provider. This can take up to a minute.');
    if (test.error) return h('p', { class: 'verdict', 'data-usable': 'false' }, test.error);
    const v = test.view;
    return h('div', null,
      h('ul', { class: 'checks' }, v.checks.map((c) => h('li', { class: 'check', 'data-state': c.state },
        h('span', { class: 'check-icon', 'aria-hidden': 'true' }, CHECK_ICONS[c.state]),
        h('span', null, h('span', { class: 'sr-only' }, `${CHECK_WORDS[c.state]}: `), c.label, c.detail ? h('span', { class: 'check-detail' }, ` — ${c.detail}`) : null)))),
      v.verdict ? h('p', { class: 'verdict', 'data-usable': String(v.usable) }, v.verdict) : null);
  }

  // ---------------------------------------------------------------- Island

  function renderIsland() {
    const dock = state.settings.dock;
    const choice = M.alongChoice(dock.along);
    const labels = M.alongChoiceLabels(dock.edge);
    const spot = M.pillSpot(dock.edge, dock.along);
    const place = (s) => ({ left: `${s.left}%`, top: `${s.top}%`, width: `${s.width}%`, height: `${s.height}%` });

    // The pill is drawn where it WAS and then moved, so a change slides instead of jumping.
    const pill = h('span', { class: 'monitor-pill', style: place(state.lastSpot || spot) });
    if (state.lastSpot) requestAnimationFrame(() => requestAnimationFrame(() => Object.assign(pill.style, place(spot))));
    state.lastSpot = spot;

    const reset = dock.autoHide
      ? M.resetPlacement(state.info)
      : { edge: 'top', along: 0.5, label: 'Reset to top center' };
    const note = dock.autoHide ? M.edgeNote(dock.edge, state.info) : ''; 
    return pane('island', 'Island',
      dock.autoHide
        ? 'The pill hides when idle. Move the pointer to its edge to reveal it, or use the keyboard shortcut.'
        : 'The pill stays visible on your screen. Click it to expand into the island; click again or press Esc to collapse it.',
      h('div', { class: 'place' },
        h('div', { class: 'monitor', role: 'img', 'aria-label': `The pill is on the ${dock.edge} edge, ${choice === 'custom' ? 'at a custom spot' : labels[choice].toLowerCase()}.` }, pill),
        h('div', { class: 'place-controls' },
          h('div', { class: 'place-line' },
            h('span', { class: 'field-label' }, 'Edge'),
            segmented({ label: 'Screen edge', options: M.EDGES.map((e) => [e, M.EDGE_LABELS[e]]), value: dock.edge, fk: 'edge', onPick: (v) => patch('dock.edge', v) })),
          h('div', { class: 'place-line' },
            h('span', { class: 'field-label' }, 'Position'),
            segmented({ label: 'Position along the edge', options: [['start', labels.start], ['center', labels.center], ['end', labels.end]], value: choice, fk: 'along', onPick: (v) => patch('dock.along', M.ALONG[v]) })),
          choice === 'custom'
            ? h('div', { class: 'place-line' },
              h('span', { class: 'fine' }, 'You dragged the pill to a spot of your own.'),
              h('button', { class: 'btn', 'data-size': 'small', fk: 'reset-place', onclick: () => patchMany({ dock: { edge: reset.edge, along: reset.along, display: null } }) }, reset.label))
            : h('p', { class: 'fine' }, 'You can also drag the pill itself to any spot on any edge. ALLES remembers where you let go.'),
          note ? h('p', { class: 'fine', 'data-role': 'edge-note' }, note) : null)),
      h('h2', { class: 'section-title' }, 'Display'),
      h('div', { class: 'rows' },
        row('Keep pill visible', 'Keep the collapsed pill on screen at all times. Turn this off to use the auto-hide edge strip.',
          switchEl({ checked: !dock.autoHide, label: 'Keep the pill visible', fk: 'persistent-pill', onchange: (v) => patch('dock.autoHide', !v) })),
        row('Clock', 'The time shown on the pill.',
          segmented({ label: 'Clock format', options: [['24', '24-hour'], ['12', '12-hour']], value: dock.hour12 ? '12' : '24', fk: 'clock', onPick: (v) => patch('dock.hour12', v === '12') })),
        row('Tray icon', 'Stock GNOME has no tray, so this starts off. KDE shows it. On GNOME it needs the AppIndicator extension. Nothing in ALLES depends on it: the island has buttons for Settings, Stop and Quit.',
          switchEl({ checked: state.settings.tray.enabled, label: 'Show a tray icon', fk: 'tray', onchange: (v) => patch('tray.enabled', v) }))));
  }

  // ---------------------------------------------------------------- Mouse & keyboard

  function renderInput() {
    const mode = state.settings.input.backend;
    const status = M.inputStatus(state.info);
    return pane('input', 'Mouse & keyboard',
      'How ALLES moves the pointer and presses keys. Automatic is the right choice for almost everyone.',
      status.problem ? banner('attention', 'Using ydotool instead', [status.problem]) : null,
      h('div', { class: 'rows' },
        row('Method', M.inputNote(mode),
          segmented({ label: 'How the mouse and keyboard are driven', options: M.INPUT_CHOICES, value: mode, fk: 'input-mode', onPick: (v) => patch('input.backend', v) }))),
      h('h2', { class: 'section-title' }, 'In use now'),
      status.using
        ? [h('div', { class: 'rows', 'data-role': 'input-status' }, row(status.using, null, null)),
          status.lines.map((l) => h('p', { class: 'fine' }, l))]
        : h('p', { class: 'fine', 'data-role': 'input-status' }, 'Not known yet.'));
  }

  // ---------------------------------------------------------------- Safety

  function numberRow(title, desc, { value, limits, path, fk }) {
    const input = h('input', {
      class: 'input mono', 'data-narrow': 'true', type: 'text', inputmode: 'numeric', value: String(value), fk, 'aria-label': title,
      onchange: (e) => {
        e.target.dataset.rendered = e.target.value;                 // committed: the redraw shows what was saved
        const typed = e.target.value.trim();
        const n = M.parseIntInput(typed, limits.lo, limits.hi);
        if (n === null) { toast(`Enter a whole number from ${limits.lo} to ${limits.hi}.`, 'problem'); e.target.value = String(value); return; }
        if (String(n) !== typed) toast(`Using ${n}, the nearest allowed value.`);
        patch(path, n);
      },
    });
    return row(title, `${desc} Allowed: ${limits.lo} to ${limits.hi}.`, input);
  }

  function renderSafety() {
    const s = state.settings.safety; const a = state.settings.agent;
    const warnings = M.safetyWarnings(state.settings);
    return pane('safety', 'Safety',
      'Choose what ALLES must ask you about first. Whatever you pick here, it always asks before reading files that may hold passwords or keys, such as SSH keys and password stores. The Stop button on the island ends everything at once.',
      warnings.length ? banner('attention', 'Some protection is switched off', warnings.map((w) => w.text)) : null,
      h('div', { class: 'rows' },
        row('Ask before running shell commands', 'You see the whole command, and what is risky about it, before it runs.',
          switchEl({ checked: s.requireApprovalForShell, label: 'Ask before running shell commands', fk: 'safety-shell', onchange: (v) => patch('safety.requireApprovalForShell', v) })),
        row('Ask before writing files', 'You see the file path and the start of its content first.',
          switchEl({ checked: s.requireApprovalForFileWrites, label: 'Ask before writing files', fk: 'safety-files', onchange: (v) => patch('safety.requireApprovalForFileWrites', v) })),
        row('Allow key combinations that can end your session', 'Off keeps these blocked: Ctrl+Alt+Delete, Ctrl+Alt+Backspace, text consoles (Ctrl+Alt+F1 to F6), Alt+SysRq and locking the screen.',
          switchEl({ checked: s.allowDangerousKeys, label: 'Allow key combinations that can end your session', fk: 'safety-keys', onchange: (v) => patch('safety.allowDangerousKeys', v) }))),
      h('h2', { class: 'section-title' }, 'Limits'),
      h('div', { class: 'rows' },
        numberRow('Actions per minute', 'The most mouse and keyboard actions ALLES may take in a minute.', { value: s.maxActionsPerMinute, limits: M.LIMITS.maxActionsPerMinute, path: 'safety.maxActionsPerMinute', fk: 'limit-rate' }),
        numberRow('Steps per task', 'ALLES stops a task after this many steps.', { value: a.maxSteps, limits: M.LIMITS.maxSteps, path: 'agent.maxSteps', fk: 'limit-steps' }),
        numberRow('Screenshots kept', 'How many recent screenshots the model keeps looking at. Fewer is faster and cheaper.', { value: a.keepImages, limits: M.LIMITS.keepImages, path: 'agent.keepImages', fk: 'limit-images' })));
  }

  // ---------------------------------------------------------------- Key storage

  function renderStorage() {
    const v = M.keyStorageView(state.keyStorage, state.settings.security.keyStorage);
    const inMemory = M.memoryOnlyKeyCount(state.routes);
    const onDisk = M.persistedKeyCount(state.routes);
    const rows = [row(v.title, v.summary, null)];

    if (v.showOptIn) {
      rows.push(row('Save keys on this computer as plain text',
        'Without a system keyring, ALLES keeps keys in memory, so you paste them again every time it starts. This keeps them in a file that only your user can read. It is not encrypted, so it is not recommended on a shared computer.',
        switchEl({ checked: v.optInChecked || state.confirmPlain, label: 'Save keys as plain text', fk: 'plain', onchange: (on) => { if (on) { state.confirmPlain = true; requestRender(); } else setPlainStorage(false); } }),
        state.confirmPlain
          ? h('div', { class: 'confirm' },
            h('span', { class: 'confirm-text' }, 'Keys will be written to disk without encryption. Turn this on?'),
            h('button', { class: 'btn', 'data-kind': 'primary', fk: 'plain-yes', onclick: () => setPlainStorage(true) }, 'Turn on'),
            h('button', { class: 'btn', fk: 'plain-no', onclick: () => { state.confirmPlain = false; requestRender(); } }, 'Cancel'))
          : null));
    }
    if (inMemory > 0 && v.mode !== 'session') {
      rows.push(row(`${inMemory} key${inMemory === 1 ? ' is' : 's are'} held in memory only`, 'They will be gone after ALLES quits.',
        h('button', { class: 'btn', fk: 'save-memory-keys', onclick: saveMemoryKeys }, `Save ${inMemory === 1 ? 'it' : 'them'} now`)));
    }

    return pane('storage', 'Key storage',
      'Where ALLES keeps your API keys. They are never written to the settings file, and a key is never shown again after you add it.',
      v.warn ? banner('problem', 'Keys are stored as plain text', ['Anyone who can read your files, including backups, can read your keys.']) : null,
      h('div', { class: 'rows' }, rows),
      v.mode === 'session' && onDisk > 0
        ? h('p', { class: 'fine' }, `${onDisk} key${onDisk === 1 ? ' is' : 's are'} still saved in the key file from before. Remove ${onDisk === 1 ? 'it' : 'them'} from the provider if you want ${onDisk === 1 ? 'it' : 'them'} gone.`)
        : null);
  }

  // ---------------------------------------------------------------- About

  const DOCTOR_ICONS = { ok: '✓', warn: '!', problem: '✕', skipped: '–' };

  function doctorResult(d) {
    if (!d) return null;
    if (d.running) return h('p', { class: 'fine' }, 'Checking. This takes a few seconds.');
    if (d.error) return h('p', { class: 'verdict', 'data-tone': 'problem' }, d.error);
    const v = d.view;
    return h('div', { class: 'doctor-result' },
      h('p', { class: 'verdict', 'data-tone': v.tone }, v.headline),
      h('ul', { class: 'checks doctor-list' }, v.rows.map((c) => h('li', { class: 'check', 'data-state': c.state },
        h('span', { class: 'check-icon', 'aria-hidden': 'true' }, DOCTOR_ICONS[c.state]),
        h('span', null,
          h('span', { class: 'sr-only' }, `${c.word}: `),
          h('span', { class: 'check-title' }, c.title),
          c.detail ? h('span', { class: 'check-detail' }, ` — ${c.detail}`) : null,
          c.fix ? h('span', { class: 'check-fix' }, `What to do: ${c.fix}`) : null)))));
  }

  function doctorSection() {
    const d = state.doctor;
    const running = !!(d && d.running);
    const done = !!(d && !running);
    // aria-disabled, not disabled: a button that disables itself while the keyboard is on it throws the focus away.
    return h('section', { class: 'doctor', 'aria-labelledby': 'h-doctor' },
      h('h2', { class: 'section-title', id: 'h-doctor' }, 'Check this computer'),
      h('p', { class: 'lede' }, 'Tries what ALLES needs, one thing at a time, and says in plain words what to fix. It takes one screenshot (not kept) and opens the mouse and keyboard connection for a moment, but moves nothing.'),
      h('div', { class: 'test' },
        h('button', { class: 'btn', 'data-kind': done ? null : 'primary', 'aria-disabled': running ? 'true' : null, fk: 'doctor:run', onclick: runDoctor }, running ? 'Checking…' : done ? 'Check again' : 'Check now')),
      doctorResult(d));
  }

  function renderAbout() {
    const i = state.info || {};
    return pane('about', 'About', null,
      h('dl', { class: 'facts' },
        h('dt', null, 'App'), h('dd', null, `${i.name || 'ALLES'}${i.version ? ` ${i.version}` : ''}`),
        h('dt', null, 'Desktop'), h('dd', null, M.desktopText(i)),
        M.backendText(i) ? h('dt', null, 'Window system') : null, M.backendText(i) ? h('dd', null, M.backendText(i)) : null,
        M.inputText(i) ? h('dt', null, 'Mouse and keyboard') : null, M.inputText(i) ? h('dd', null, M.inputText(i)) : null,
        h('dt', null, 'Shortcut'), h('dd', null, M.shortcutText(i)),
        h('dt', null, 'Data folder'), h('dd', { class: 'mono' }, i.dataDir || 'Unknown')),
      h('p', { class: 'fine' }, 'Settings are saved the moment you change them.'),
      doctorSection());
  }

  // ---------------------------------------------------------------- the whole page

  const RENDERERS = { providers: renderProviders, island: renderIsland, input: renderInput, safety: renderSafety, storage: renderStorage, about: renderAbout };

  function renderRail() {
    $('rail').replaceChildren(
      h('div', { class: 'brand' }, h('span', { class: 'brand-dot', 'aria-hidden': 'true' }), 'ALLES'),
      ...PANES.map(([id, label]) => h('button', {
        class: 'nav-item', fk: `nav:${id}`, 'aria-current': state.pane === id ? 'page' : null,
        onclick: () => { if (state.pane !== id) forgetDoctor(); state.pane = id; state.confirmRemove = null; state.confirmPlain = false; requestRender(); },
      }, label)));
  }

  function renderIssues() {
    const out = [];
    for (const [key, title] of [['settings', 'Settings'], ['keys', 'Saved keys']]) {
      const text = state.issues[key];
      if (text && !state.dismissed.has(text)) out.push(banner('attention', title, [text], () => { state.dismissed.add(text); requestRender(); }));
    }
    return out;
  }

  function render() {
    renderPending = false;
    const main = $('main');
    const focus = captureFocus();
    const scroll = main.scrollTop;
    renderRail();
    if (state.fatal) {
      main.replaceChildren(h('div', { class: 'state' },
        h('div', null, h('p', null, state.fatal), h('button', { class: 'btn', 'data-kind': 'primary', onclick: () => refresh() }, 'Try again'))));
    } else if (!state.loaded) {
      main.replaceChildren(h('div', { class: 'state' }, h('p', null, 'Loading…')));
    } else {
      const body = RENDERERS[state.pane]();
      body.prepend(...renderIssues());                  // problems loading settings or keys sit above whatever pane is open
      main.replaceChildren(body);
    }
    main.scrollTop = scroll;
    restoreFocus(focus);
  }

  // ---------------------------------------------------------------- start

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.confirmRemove || state.confirmPlain) { state.confirmRemove = null; state.confirmPlain = false; requestRender(); }
  });

  if (!bridge || typeof bridge.invoke !== 'function') {
    state.fatal = 'The Settings page could not connect to ALLES. Close this window and open Settings again.';
    render();
  } else {
    let changedTimer = null;
    const soon = () => { clearTimeout(changedTimer); changedTimer = setTimeout(() => refresh(), 120); };
    bridge.onChanged(soon);                            // the pill was dragged, a key was added elsewhere...
    window.addEventListener('focus', soon);            // coming back to the window: provider problems may have changed
    render();
    refresh();
  }
})();
