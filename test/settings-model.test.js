'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const M = require('../src/settings/settings-model');
const { sanitize, applyPatch, KINDS, MAX_ROUTES, EDGES: SETTINGS_EDGES } = require('../src/main/settings');
const { KEY_RE } = require('../src/main/keystore');
const { describeRoutes } = require('../src/main/providers/config');
const { probeRoute } = require('../src/main/providers/probe');
const { DANGEROUS_COMBOS } = require('../src/main/computer/input');

/**
 * The Settings page's decisions, proven without a window. Where the model keeps a COPY of a rule that the main
 * process enforces (key format, numeric bounds, provider kinds, edges), a test compares the copy to the source.
 */

// ---------------------------------------------------------------- placement

test('alongChoice names the three alignments and calls anything else "custom" (a dragged position)', () => {
  assert.strictEqual(M.alongChoice(0), 'start');
  assert.strictEqual(M.alongChoice(0.5), 'center');
  assert.strictEqual(M.alongChoice(1), 'end');
  assert.strictEqual(M.alongChoice(0.37), 'custom');
  assert.strictEqual(M.alongChoice(0.495), 'center', 'a hair off centre is still centre');
  for (const bad of [NaN, undefined, null, 'x', {}]) assert.strictEqual(M.alongChoice(bad), 'custom', String(bad));
});

test('the alignment words follow the edge: a side edge starts at the TOP of the screen, not the left', () => {
  assert.deepStrictEqual(M.alongChoiceLabels('top'), { start: 'Left', center: 'Center', end: 'Right' });
  assert.deepStrictEqual(M.alongChoiceLabels('bottom'), { start: 'Left', center: 'Center', end: 'Right' });
  assert.deepStrictEqual(M.alongChoiceLabels('left'), { start: 'Top', center: 'Middle', end: 'Bottom' });
  assert.deepStrictEqual(M.alongChoiceLabels('right'), { start: 'Top', center: 'Middle', end: 'Bottom' });
});

test('the model lists exactly the edges the settings store accepts', () => {
  assert.deepStrictEqual([...M.EDGES].sort(), [...SETTINGS_EDGES].sort());
  assert.deepStrictEqual(Object.keys(M.EDGE_LABELS).sort(), [...SETTINGS_EDGES].sort());
});

test('pillSpot puts the diagram pill on the chosen edge and slides it along that edge only', () => {
  const top = M.pillSpot('top', 0.5), bottom = M.pillSpot('bottom', 0.5), left = M.pillSpot('left', 0.5), right = M.pillSpot('right', 0.5);
  assert.ok(top.top < bottom.top, 'top is above bottom');
  assert.ok(left.left < right.left, 'left is left of right');
  assert.strictEqual(M.pillSpot('top', 0).top, M.pillSpot('top', 1).top, 'sliding along the top edge does not change its height');
  assert.strictEqual(M.pillSpot('left', 0).left, M.pillSpot('left', 1).left, 'sliding along the left edge does not change its x');
  assert.ok(M.pillSpot('top', 0).left < M.pillSpot('top', 1).left, 'along 0 is the LEFT end of a horizontal edge');
  assert.ok(M.pillSpot('left', 0).top < M.pillSpot('left', 1).top, 'along 0 is the TOP end of a vertical edge');
  // The pill is centred when along = 0.5.
  assert.ok(Math.abs(top.left + top.width / 2 - 50) < 1e-9);
  assert.ok(Math.abs(left.top + left.height / 2 - 50) < 1e-9);
});

test('pillSpot keeps the same small gap from every edge it can touch (never flush, never lopsided)', () => {
  const gap = (v) => Math.round(v * 1e9) / 1e9;
  const a = M.pillSpot('top', 0); const z = M.pillSpot('top', 1);
  assert.ok(a.left > 0, 'at the start of an edge the pill is not flush with the corner');
  assert.strictEqual(gap(a.left), gap(100 - (z.left + z.width)), 'the gap at the start of the top edge equals the gap at its end');
  const t = M.pillSpot('top', 0.5); const b = M.pillSpot('bottom', 0.5);
  assert.ok(t.top > 0, 'the pill on the top edge is not flush with the border');
  assert.strictEqual(gap(t.top), gap(100 - (b.top + b.height)), 'the gap above the top pill equals the gap below the bottom pill');
  const s0 = M.pillSpot('left', 0); const s1 = M.pillSpot('left', 1);
  assert.ok(s0.top > 0);
  assert.strictEqual(gap(s0.top), gap(100 - (s1.top + s1.height)), 'the gap at the start of the left edge equals the gap at its end');
  const l = M.pillSpot('left', 0.5); const r = M.pillSpot('right', 0.5);
  assert.ok(l.left > 0);
  assert.strictEqual(gap(l.left), gap(100 - (r.left + r.width)), 'the gap beside the left pill equals the gap beside the right pill');
  assert.strictEqual(gap(a.left), gap(t.top), 'the same gap everywhere');
});

test('pillSpot never leaves the diagram, whatever it is given', () => {
  for (const edge of [...M.EDGES, 'diagonal', undefined, null]) {
    for (const along of [-5, 0, 0.3, 1, 7, NaN, undefined, null, 'x', Infinity]) {
      const p = M.pillSpot(edge, along);
      for (const v of Object.values(p)) assert.ok(Number.isFinite(v), `${edge}/${along}: ${JSON.stringify(p)}`);
      assert.ok(p.left >= 0 && p.top >= 0 && p.left + p.width <= 100 && p.top + p.height <= 100, `${edge}/${along}: ${JSON.stringify(p)}`);
    }
  }
  assert.deepStrictEqual(M.pillSpot('diagonal', 0.5), M.pillSpot('top', 0.5), 'an unknown edge is drawn as top, like the dock does');
});

// ---------------------------------------------------------------- provider rows

test('moveId swaps with a neighbour, on a copy, and ignores the ends and unknown ids', () => {
  const ids = ['a', 'b', 'c'];
  assert.deepStrictEqual(M.moveId(ids, 'b', -1), ['b', 'a', 'c']);
  assert.deepStrictEqual(M.moveId(ids, 'b', +1), ['a', 'c', 'b']);
  assert.deepStrictEqual(M.moveId(ids, 'a', -1), ['a', 'b', 'c'], 'cannot move the first one up');
  assert.deepStrictEqual(M.moveId(ids, 'c', +1), ['a', 'b', 'c'], 'cannot move the last one down');
  assert.deepStrictEqual(M.moveId(ids, 'zzz', -1), ['a', 'b', 'c']);
  assert.deepStrictEqual(M.moveId(ids, 'b', 0), ['a', 'b', 'c']);
  assert.deepStrictEqual(ids, ['a', 'b', 'c'], 'the input is never modified');
  assert.deepStrictEqual(M.moveId(undefined, 'a', 1), []);
});

test('routeFields shows a suggestion as a placeholder, never as text the user "typed"', () => {
  const f = M.routeFields({ label: 'NVIDIA', model: 'meta/some-model', modelIsDefault: true, baseUrl: 'https://x.test/v1', urlIsDefault: true });
  assert.strictEqual(f.modelValue, '');
  assert.strictEqual(f.modelPlaceholder, 'meta/some-model');
  assert.strictEqual(f.urlValue, '');
  assert.strictEqual(f.urlPlaceholder, 'https://x.test/v1');
  const own = M.routeFields({ label: 'Mine', model: 'my-model', modelIsDefault: false, baseUrl: 'https://mine.test/v1', urlIsDefault: false });
  assert.strictEqual(own.modelValue, 'my-model');
  assert.strictEqual(own.urlValue, 'https://mine.test/v1');
  assert.strictEqual(own.modelPlaceholder, 'Model name');
  assert.doesNotThrow(() => M.routeFields(undefined));
  assert.strictEqual(M.routeFields(null).modelValue, '');
});

test('the suggestion warning appears exactly when a default is in use', () => {
  assert.match(M.unverifiedNote({ defaultsUnverified: true }), /best guesses/);
  assert.strictEqual(M.unverifiedNote({ defaultsUnverified: false }), '');
  assert.strictEqual(M.unverifiedNote(undefined), '');
});

test('routeStatus: off beats everything, setup gaps are a nudge, rejections are problems', () => {
  assert.deepStrictEqual(M.routeStatus({ enabled: false, problem: 'Add an API key.', problemKind: 'setup' }), { tone: 'off', text: 'Turned off' });
  assert.deepStrictEqual(M.routeStatus({ enabled: true, problem: 'Add an API key.', problemKind: 'setup' }), { tone: 'attention', text: 'Add an API key.' });
  assert.deepStrictEqual(M.routeStatus({ enabled: true, problem: 'The provider rejected it.', problemKind: 'broken' }), { tone: 'problem', text: 'The provider rejected it.' });
  assert.deepStrictEqual(M.routeStatus({ enabled: true, problem: 'Something', }), { tone: 'problem', text: 'Something' }, 'an unclassified problem is shown as a problem, not hidden');
  assert.deepStrictEqual(M.routeStatus({ enabled: true, problem: null }), { tone: 'ready', text: 'Ready' });
  assert.deepStrictEqual(M.routeStatus(undefined), { tone: 'off', text: 'Turned off' }, 'no data is never shown as Ready');
  assert.strictEqual(M.routeStatus({ enabled: 'yes', problem: null }).tone, 'off', 'only a real true counts as enabled');
});

test('routeStatus reads the REAL describeRoutes output for every situation a provider can be in', () => {
  const route = { id: 'g', kind: 'grok', label: 'Grok', model: '', baseUrl: '', enabled: true };
  const keys = (list) => ({ list: () => list });
  const key = { id: 'aaaa', hint: 'xai-…abc', addedAt: 1, persisted: true, readable: true };

  const noKey = describeRoutes([route], keys([]))[0];
  assert.strictEqual(M.routeStatus(noKey).tone, 'attention');
  assert.match(M.routeStatus(noKey).text, /API key/);

  const ready = describeRoutes([route], keys([key]))[0];
  assert.deepStrictEqual(M.routeStatus(ready), { tone: 'ready', text: 'Ready' });

  const locked = describeRoutes([route], keys([{ ...key, readable: false }]))[0];
  assert.strictEqual(M.routeStatus(locked).tone, 'problem');
  assert.match(M.routeStatus(locked).text, /cannot be decrypted/);

  const rejected = describeRoutes([route], keys([key]), [{ id: 'g', problem: 'The model was not found.' }])[0];
  assert.deepStrictEqual(M.routeStatus(rejected), { tone: 'problem', text: 'The model was not found.' });

  const noModel = describeRoutes([{ ...route, kind: 'custom', id: 'c' }], keys([key]))[0];
  assert.strictEqual(M.routeStatus(noModel).tone, 'attention', 'a custom provider with no model is unfinished, not broken');

  const off = describeRoutes([{ ...route, enabled: false }], keys([key]))[0];
  assert.strictEqual(M.routeStatus(off).tone, 'off');
});

// ---------------------------------------------------------------- keys

test('the key check accepts exactly what the key store accepts', () => {
  assert.strictEqual(M.KEY_RE_SOURCE, KEY_RE.source, 'the page and the key store must agree on what a key looks like');
  const samples = ['nvapi-' + 'x'.repeat(40), 'AIza' + 'b'.repeat(35), 'xai-' + 'y'.repeat(60), 'short', '1234567', '12345678', 'has space in it', 'tab\there', 'new\nline', 'smart“quote', 'ключ-ключ-ключ', 'a'.repeat(512), 'a'.repeat(513), ''];
  for (const s of samples) {
    const ours = M.checkKeyInput(s).ok;
    assert.strictEqual(ours, KEY_RE.test(s.trim()), `disagreement on ${JSON.stringify(s.slice(0, 30))}`);
  }
});

test('checkKeyInput trims what was pasted and says what is wrong in plain words', () => {
  assert.deepStrictEqual(M.checkKeyInput('  abcd1234efgh \n'), { ok: true, key: 'abcd1234efgh' });
  assert.match(M.checkKeyInput('').error, /Paste your API key/);
  assert.match(M.checkKeyInput('   ').error, /Paste your API key/);
  assert.match(M.checkKeyInput(undefined).error, /Paste your API key/);
  assert.match(M.checkKeyInput('too short').error, /does not look like an API key/);
  assert.match(M.checkKeyInput('has a space inside it').error, /no spaces/);
});

test('keyView exposes a hint and tags, never anything else from the entry', () => {
  const v = M.keyView({ id: 'ab12', hint: 'nvap…abc', secret: 'SUPER-SECRET', data: 'SUPER-SECRET', persisted: true, readable: true });
  assert.deepStrictEqual(v, { id: 'ab12', hint: 'nvap…abc', tags: [] });
  assert.ok(!JSON.stringify(v).includes('SUPER-SECRET'));
  assert.deepStrictEqual(M.keyView({ id: 'x', hint: 'k', persisted: false, readable: true }).tags, ['memory only']);
  assert.deepStrictEqual(M.keyView({ id: 'x', hint: 'k', persisted: true, readable: false }).tags, ["can't be decrypted"]);
  assert.deepStrictEqual(M.keyView({ id: 'x', hint: 'k', persisted: false, readable: false }).tags, ['memory only', "can't be decrypted"]);
  assert.strictEqual(M.keyView({ id: 'x' }).hint, '****', 'a missing hint is masked, not blank');
  assert.doesNotThrow(() => M.keyView(null));
});

test('memoryOnlyKeyCount counts keys that will not survive a restart', () => {
  const routes = [
    { keys: [{ persisted: true }, { persisted: false }, { persisted: false }] },
    { keys: [{ persisted: false }] },
    { keys: [] }, {}, null,
  ];
  assert.strictEqual(M.memoryOnlyKeyCount(routes), 3);
  assert.strictEqual(M.memoryOnlyKeyCount(undefined), 0);
  assert.strictEqual(M.memoryOnlyKeyCount([{ keys: [{ persisted: true }] }]), 0);
  assert.strictEqual(M.memoryOnlyKeyCount([{ keys: [{}, { persisted: 'no' }, { persisted: null }] }]), 0, 'only an explicit persisted:false means memory only');
});

test('persistedKeyCount counts keys written to disk, the opposite of memoryOnlyKeyCount', () => {
  const routes = [{ keys: [{ persisted: true }, { persisted: false }] }, { keys: [{ persisted: true }, { persisted: true }] }, {}, null];
  assert.strictEqual(M.persistedKeyCount(routes), 3);
  assert.strictEqual(M.memoryOnlyKeyCount(routes), 1);
  assert.strictEqual(M.persistedKeyCount(undefined), 0);
  assert.strictEqual(M.persistedKeyCount([{ keys: [{}] }]), 0, 'a key with no persisted flag is not claimed to be on disk');
});

test('keyStorageView gives each mode a plain title', () => {
  assert.strictEqual(M.keyStorageView({ mode: 'keyring' }, 'session').title, 'Encrypted with your system keyring');
  assert.strictEqual(M.keyStorageView({ mode: 'session' }, 'session').title, 'Kept in memory only');
  assert.strictEqual(M.keyStorageView({ mode: 'file' }, 'file').title, 'Saved as plain text');
  assert.strictEqual(M.keyStorageView(undefined, undefined).title, 'Kept in memory only');
});

test('desktopText reads like a person would say it, and copes with missing parts', () => {
  assert.strictEqual(M.desktopText({ desktop: 'GNOME', session: 'wayland' }), 'GNOME on Wayland');
  assert.strictEqual(M.desktopText({ desktop: 'KDE Plasma', session: 'x11' }), 'KDE Plasma on X11');
  assert.strictEqual(M.desktopText({ desktop: 'GNOME', session: '' }), 'GNOME');
  assert.strictEqual(M.desktopText({ desktop: '', session: 'wayland' }), 'Wayland');
  assert.strictEqual(M.desktopText({ desktop: 'GNOME', session: 'mir' }), 'GNOME on mir');
  assert.strictEqual(M.desktopText(undefined), 'Unknown');
});

test('shortcutText: says it works only when it is really registered, and otherwise says what to do instead', () => {
  assert.strictEqual(M.shortcutText({ shortcut: 'Control+Alt+Space', shortcutRegistered: true }), 'Ctrl+Alt+Space opens and closes the island.');
  const no = M.shortcutText({ shortcut: 'Control+Alt+Space', shortcutRegistered: false });
  assert.match(no, /^Ctrl\+Alt\+Space is not available on this desktop/);
  assert.match(no, /pill on the screen edge/);
  assert.match(no, /second time/);
  assert.doesNotMatch(M.shortcutText({ shortcut: 'Control+Alt+Space' }), /opens and closes/, 'unknown is never claimed to work');
  assert.doesNotThrow(() => M.shortcutText(undefined));
});

test('keyStorageView: the plain-text opt-in is only offered when there is no keyring, and file mode always warns', () => {
  const kr = M.keyStorageView({ mode: 'keyring', summary: 'Encrypted.' }, 'session');
  assert.deepStrictEqual([kr.mode, kr.showOptIn, kr.warn, kr.optInChecked], ['keyring', false, false, false]);
  const sess = M.keyStorageView({ mode: 'session', summary: 'Memory only.' }, 'session');
  assert.deepStrictEqual([sess.mode, sess.showOptIn, sess.warn, sess.optInChecked], ['session', true, false, false]);
  const file = M.keyStorageView({ mode: 'file', summary: 'Plain text.' }, 'file');
  assert.deepStrictEqual([file.mode, file.showOptIn, file.warn, file.optInChecked], ['file', true, true, true]);
  assert.strictEqual(M.keyStorageView(undefined, undefined).mode, 'session', 'unknown is the safe mode');
  assert.strictEqual(M.keyStorageView({ mode: 'bogus' }, 'file').mode, 'session');
});

// ---------------------------------------------------------------- the Test button, against the REAL probe

const fakeChat = (script) => async (req) => {
  const kind = req.messages.some((m) => m.role === 'tool') ? 'followup' : req.tools ? 'tools' : (Array.isArray(req.messages[0].content) ? 'vision' : 'text');
  const r = script[kind];
  if (r instanceof Error) throw r;
  return r;
};
// A tool call as the adapter hands it over: the parsed calls AND the provider's own message (which goes back unchanged).
const TOOL_REPLY = { content: '', toolCalls: [{ id: 'c1', name: 'report_color', arguments: { color: 'blue' } }], raw: { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'report_color', arguments: '{"color":"blue"}' } }] } };
const GOOD = { text: { content: 'OK' }, vision: { content: 'Red' }, tools: TOOL_REPLY, followup: { content: 'Done.' } };
const httpError = (status, message = 'boom') => Object.assign(new Error(message), { status });
const ROUTE = { model: 'm', baseUrl: 'https://x.test/v1' };

test('testView: a provider that passes all four checks is usable', async () => {
  const res = await probeRoute({ route: ROUTE, apiKey: 'k'.repeat(12), now: () => 1000, chat: fakeChat(GOOD) });
  const v = M.testView(res);
  assert.strictEqual(v.usable, true);
  assert.deepStrictEqual(v.checks.map((c) => [c.key, c.state]), [['text', 'ok'], ['vision', 'ok'], ['tools', 'ok'], ['followup', 'ok']]);
  assert.deepStrictEqual(v.checks.map((c) => c.label), ['Replies to text', 'Understands images', 'Can use tools', 'Carries on after a tool call']);
  assert.match(v.summary, /Works/);
  assert.match(v.verdict, /Works/, 'a working provider keeps its good-news line');
});

test('testView: a text-only model replies but is not usable, and says which check failed and why', async () => {
  const res = await probeRoute({ route: ROUTE, apiKey: 'k'.repeat(12), chat: fakeChat({ ...GOOD, vision: httpError(400, 'images unsupported') }) });
  const v = M.testView(res);
  assert.strictEqual(v.usable, false);
  assert.deepStrictEqual(v.checks.map((c) => c.state), ['ok', 'fail', 'ok', 'ok']);
  assert.match(v.checks[1].detail, /does not accept images/);
  assert.match(v.summary, /Images:/);
  assert.strictEqual(v.verdict, 'ALLES needs all four checks to pass before it can use this provider.', 'the closing line says what it means, not what the rows already said');
});

test('testView: a model that does the first step but refuses the second is not usable, and the row says what ALLES needs', async () => {
  const res = await probeRoute({ route: ROUTE, apiKey: 'k'.repeat(12), chat: fakeChat({ ...GOOD, followup: httpError(400, 'unknown role tool') }) });
  const v = M.testView(res);
  assert.strictEqual(v.usable, false);
  assert.deepStrictEqual(v.checks.map((c) => c.state), ['ok', 'ok', 'ok', 'fail']);
  assert.match(v.checks[3].detail, /rejected the tool's answer/);
  assert.match(v.summary, /Next step:/);
});

test('testView: when the tool check fails the follow-up is shown as skipped, not failed', async () => {
  const res = await probeRoute({ route: ROUTE, apiKey: 'k'.repeat(12), chat: fakeChat({ ...GOOD, tools: { content: 'Sure!', toolCalls: [], raw: {} } }) });
  const v = M.testView(res);
  assert.deepStrictEqual(v.checks.map((c) => c.state), ['ok', 'ok', 'fail', 'skipped']);
});

test('testView: a refused key fails the first check and the other two are shown as skipped, not failed', async () => {
  const res = await probeRoute({ route: ROUTE, apiKey: 'k'.repeat(12), chat: fakeChat({ text: httpError(401, 'bad key') }) });
  const v = M.testView(res);
  assert.strictEqual(v.usable, false);
  assert.deepStrictEqual(v.checks.map((c) => c.state), ['fail', 'skipped', 'skipped', 'skipped']);
  assert.match(v.checks[0].detail, /key was refused/);
  assert.match(v.checks[1].detail, /Not tested/);
});

test('testView: nothing to test yet (no model) is an empty, not-usable result with the reason', async () => {
  const res = await probeRoute({ route: { model: '', baseUrl: 'https://x.test' }, apiKey: 'k'.repeat(12), chat: fakeChat({}) });
  const v = M.testView(res);
  assert.strictEqual(v.usable, false);
  assert.deepStrictEqual(v.checks.map((c) => c.state), ['unknown', 'unknown', 'unknown', 'unknown']);
  assert.match(v.summary, /Choose a model/);
  assert.match(v.verdict, /Choose a model/, 'when nothing ran, the reason IS the verdict');
});

test('testView survives garbage and never claims "usable" for it', () => {
  for (const bad of [undefined, null, 5, 'x', [], {}, { usable: 'yes' }, { text: 7, vision: 'a', tools: [] }]) {
    const v = M.testView(bad);
    assert.strictEqual(v.usable, false, JSON.stringify(bad));
    assert.strictEqual(v.checks.length, 4);
  }
  assert.strictEqual(M.testView({ usable: true }).usable, true);
});

// ---------------------------------------------------------------- computerCheckView ("Check this computer")

const row = (id, state, extra = {}) => ({ id, title: `Title ${id}`, state, detail: `Detail ${id}`, fix: '', ...extra });

test('computerCheckView: a healthy answer is green, keeps the rows in order, and uses the headline main wrote', () => {
  const v = M.computerCheckView({ checks: [row('a', 'ok'), row('b', 'ok'), row('c', 'ok')], summary: { text: 'Everything is ready.' } });
  assert.strictEqual(v.tone, 'ok');
  assert.strictEqual(v.headline, 'Everything is ready.');
  assert.deepStrictEqual(v.rows.map((r) => r.id), ['a', 'b', 'c']);
  assert.deepStrictEqual(v.rows[0], { id: 'a', title: 'Title a', state: 'ok', word: 'Fine', detail: 'Detail a', fix: '' });
});

test('computerCheckView: the tone is the worst row - a problem beats a warning beats fine, and "not tried" changes nothing', () => {
  const tone = (...states) => M.computerCheckView({ checks: states.map((s, i) => row(`r${i}`, s)) }).tone;
  assert.strictEqual(tone('ok', 'skipped', 'ok'), 'ok');
  assert.strictEqual(tone('ok', 'warn', 'skipped'), 'warn');
  assert.strictEqual(tone('warn', 'problem', 'ok'), 'problem');
  assert.strictEqual(tone('problem'), 'problem');
});

test('computerCheckView: every state has its own plain word for screen readers and the page', () => {
  const words = M.computerCheckView({ checks: ['ok', 'warn', 'problem', 'skipped'].map((s) => row(s, s)) }).rows.map((r) => [r.state, r.word]);
  assert.deepStrictEqual(words, [['ok', 'Fine'], ['warn', 'Worth a look'], ['problem', 'Needs fixing'], ['skipped', 'Not tried']]);
  assert.deepStrictEqual(Object.keys(M.DOCTOR_WORDS).sort(), ['ok', 'problem', 'skipped', 'warn']);
});

test('computerCheckView: the fix line is kept for the page to show', () => {
  const v = M.computerCheckView({ checks: [row('x', 'problem', { fix: 'Open Settings > Providers.' })] });
  assert.strictEqual(v.rows[0].fix, 'Open Settings > Providers.');
});

test('computerCheckView: a state nobody knows shows as "worth a look" - never hidden, never an error', () => {
  const v = M.computerCheckView({ checks: [row('x', 'weird'), row('y', undefined), row('z', 5)] });
  assert.deepStrictEqual(v.rows.map((r) => [r.state, r.word]), [['warn', 'Worth a look'], ['warn', 'Worth a look'], ['warn', 'Worth a look']]);
  assert.strictEqual(v.tone, 'warn');
});

test('computerCheckView: missing or odd pieces of a row become plain defaults, text only', () => {
  const v = M.computerCheckView({ checks: [{ state: 'ok' }, { id: 7, title: {}, state: 'ok', detail: 42, fix: ['x'] }, null, 5, 'text', [], { id: 'last', title: 'Last', state: 'ok' }] });
  assert.deepStrictEqual(v.rows.map((r) => r.id), ['check-1', 'check-2', 'last'], 'null, a number, a string and an array are not rows');
  for (const r of v.rows.slice(0, 2)) { assert.strictEqual(r.title, 'Check'); assert.strictEqual(r.detail, ''); assert.strictEqual(r.fix, ''); }
});

test('computerCheckView: no headline from main -> one chosen by the tone, and a blank headline counts as none', () => {
  assert.strictEqual(M.computerCheckView({ checks: [row('a', 'ok')] }).headline, 'Everything that could be tried works.');
  assert.match(M.computerCheckView({ checks: [row('a', 'warn')] }).headline, /should work/);
  assert.match(M.computerCheckView({ checks: [row('a', 'problem')] }).headline, /needs fixing/);
  assert.strictEqual(M.computerCheckView({ checks: [row('a', 'ok')], summary: { text: '   ' } }).headline, 'Everything that could be tried works.');
  assert.strictEqual(M.computerCheckView({ checks: [row('a', 'ok')], summary: 'a string, not an object' }).headline, 'Everything that could be tried works.');
  assert.strictEqual(M.computerCheckView({ checks: [row('a', 'ok')], summary: { text: 12 } }).headline, 'Everything that could be tried works.');
});

test('computerCheckView: an answer with no rows is a PROBLEM, never a green "everything works"; and garbage never throws', () => {
  for (const bad of [undefined, null, 5, 'x', [], {}, { checks: 'no' }, { checks: [] }, { checks: [null, 5, 'x'] }, { ok: true }]) {
    const v = M.computerCheckView(bad);
    assert.deepStrictEqual(v.rows, [], JSON.stringify(bad));
    assert.strictEqual(v.tone, 'problem', JSON.stringify(bad));
    assert.match(v.headline, /no answer/, JSON.stringify(bad));
  }
});

test('computerCheckView reads what the REAL check produces, for a healthy and a broken computer', async () => {
  const { checkComputer } = require('../src/main/doctor');
  const info = { desktop: 'GNOME', session: 'wayland', backend: { placementHonoured: true } };
  const input = { resume() {}, close() {}, async moveBy() {}, info: () => ({ name: 'gnome', label: "GNOME's own input", unicode: true }) };
  const screen = { capture: async () => ({ width: 1366, height: 768, modelWidth: 1280, modelHeight: 720 }) };
  const providers = [{ id: 'nvidia', label: 'NVIDIA', enabled: true, ready: true, problem: null, keys: [{ id: 'a', persisted: true }] }];
  const good = M.computerCheckView(await checkComputer({ info, screen, input, providers, keyStatus: { mode: 'keyring' } }));
  assert.deepStrictEqual([good.tone, good.headline, good.rows.length, good.rows.every((r) => r.state === 'ok')], ['ok', 'Everything is ready.', 6, true]);
  const bad = M.computerCheckView(await checkComputer({ info, screen: { capture: async () => { throw new Error('No screenshot tool found.'); } }, input, providers: [], keyStatus: { mode: 'keyring' } }));
  assert.strictEqual(bad.tone, 'problem');
  assert.strictEqual(bad.headline, '2 things need fixing before ALLES can do its job.');
  assert.deepStrictEqual(bad.rows.filter((r) => r.state === 'problem').map((r) => r.id), ['screenshot', 'providers']);
  assert.ok(bad.rows.find((r) => r.id === 'providers').fix.length > 0, 'a problem row that can be fixed says how');
});

test('timings are shown in seconds with one decimal', () => {
  const v = M.testView({ text: { ok: true, ms: 1234 }, vision: { ok: true, ms: 80 }, tools: { ok: true }, followup: { ok: true, ms: 2500 } });
  assert.deepStrictEqual(v.checks.map((c) => c.detail), ['1.2 s', '0.1 s', '', '2.5 s']);
});

// ---------------------------------------------------------------- safety, numbers, patches

test('safetyWarnings: one reminder per protection that is switched off, nothing when all is on', () => {
  assert.deepStrictEqual(M.safetyWarnings({ safety: { requireApprovalForShell: true, requireApprovalForFileWrites: true, allowDangerousKeys: false } }), []);
  assert.deepStrictEqual(M.safetyWarnings({ safety: { requireApprovalForShell: false, requireApprovalForFileWrites: true, allowDangerousKeys: false } }).map((w) => w.id), ['shell']);
  assert.deepStrictEqual(M.safetyWarnings({ safety: { requireApprovalForShell: false, requireApprovalForFileWrites: false, allowDangerousKeys: true } }).map((w) => w.id), ['shell', 'files', 'keys']);
  assert.deepStrictEqual(M.safetyWarnings(undefined), [], 'no data -> no invented warnings');
});

test('the dangerous-keys warning names every combination the safety gate actually blocks', () => {
  const text = M.safetyWarnings({ safety: { allowDangerousKeys: true } })[0].text;
  assert.match(text, /Ctrl\+Alt\+Delete/);
  assert.match(text, /Ctrl\+Alt\+Backspace/);
  assert.match(text, /Ctrl\+Alt\+F1 to F6/);
  assert.match(text, /Alt\+SysRq/);
  assert.match(text, /Super\+L/);
  // If a combination is ever added to the blocklist, this fails until the warning says so too.
  const named = new Set(['ctrl+alt+delete', 'ctrl+alt+backspace', 'alt+sysrq', 'super+l', ...[1, 2, 3, 4, 5, 6].map((n) => `ctrl+alt+f${n}`)]);
  for (const combo of DANGEROUS_COMBOS) assert.ok(named.has(combo.join('+')), `blocked combo ${combo.join('+')} is not mentioned in the warning`);
});

test('parseIntInput accepts plain whole numbers, clamps them, and leaves everything else alone', () => {
  assert.strictEqual(M.parseIntInput('42', 1, 200), 42);
  assert.strictEqual(M.parseIntInput(' 7 ', 1, 200), 7);
  assert.strictEqual(M.parseIntInput('0', 1, 200), 1, 'clamped up');
  assert.strictEqual(M.parseIntInput('999', 1, 200), 200, 'clamped down');
  for (const bad of ['', '  ', 'abc', '4.5', '-3', '1e3', '0x10', '12 34', '1234567', null, undefined]) assert.strictEqual(M.parseIntInput(bad, 1, 200), null, JSON.stringify(bad));
});

test('the numeric bounds in the model are exactly the ones the settings store clamps to', () => {
  const lo = sanitize({ safety: { maxActionsPerMinute: -1e9 }, agent: { maxSteps: -1e9, keepImages: -1e9 } });
  const hi = sanitize({ safety: { maxActionsPerMinute: 1e9 }, agent: { maxSteps: 1e9, keepImages: 1e9 } });
  assert.strictEqual(lo.safety.maxActionsPerMinute, M.LIMITS.maxActionsPerMinute.lo);
  assert.strictEqual(hi.safety.maxActionsPerMinute, M.LIMITS.maxActionsPerMinute.hi);
  assert.strictEqual(lo.agent.maxSteps, M.LIMITS.maxSteps.lo);
  assert.strictEqual(hi.agent.maxSteps, M.LIMITS.maxSteps.hi);
  assert.strictEqual(lo.agent.keepImages, M.LIMITS.keepImages.lo);
  assert.strictEqual(hi.agent.keepImages, M.LIMITS.keepImages.hi);
});

test('patchFor builds a two-level patch the settings store applies, and refuses anything shaped like an attack', () => {
  assert.deepStrictEqual(M.patchFor('safety.maxActionsPerMinute', 5), { safety: { maxActionsPerMinute: 5 } });
  const next = applyPatch(sanitize({}), M.patchFor('safety.maxActionsPerMinute', 5));
  assert.strictEqual(next.safety.maxActionsPerMinute, 5);
  for (const bad of ['', 'safety', 'a.b.c', '.x', 'x.', '__proto__.polluted', 'safety.__proto__', 'constructor.prototype', 'safety.constructor', 'a.prototype']) {
    assert.strictEqual(M.patchFor(bad, true), null, bad);
  }
  assert.strictEqual({}.polluted, undefined);
});

test('the page stops offering new providers at the same limit the settings store enforces', () => {
  assert.strictEqual(M.MAX_ROUTES, MAX_ROUTES);
  const many = Array.from({ length: MAX_ROUTES + 5 }, (_, i) => ({ id: `r${i}`, kind: 'custom', label: 'x', model: '', baseUrl: '', enabled: true }));
  assert.strictEqual(sanitize({ providers: { routes: many } }).providers.routes.length, M.MAX_ROUTES);
});

test('the Add provider buttons offer exactly the provider kinds the settings store knows', () => {
  assert.deepStrictEqual(M.ADD_CHOICES.map((c) => c.kind).sort(), [...KINDS].sort());
  for (const c of M.ADD_CHOICES) assert.ok(c.label.length > 0);
});

test('the model file is plain browser-safe code: no require(), no Node globals, no DOM access', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/settings/settings-model'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\brequire\s*\(/.test(code), 'require() would break in the sandboxed page');
  assert.ok(!/\b(process|Buffer|__dirname|document|window)\b/.test(code), 'the model must stay pure');
});

// ---------------------------------------------------------------- an edge with a bar on it

const GNOME_INFO = { edges: { top: 32, bottom: 0, left: 0, right: 0 }, freeEdge: 'bottom' };

test('edgeNote: nothing to say when the chosen edge is clear', () => {
  for (const edge of ['bottom', 'left', 'right']) assert.strictEqual(M.edgeNote(edge, GNOME_INFO), '', edge);
});

test('edgeNote: a bar on the chosen edge is named, with the clearer edge suggested', () => {
  const note = M.edgeNote('top', GNOME_INFO);
  assert.match(note, /bar or dock on the top edge/);
  assert.match(note, /hard to reach/);
  assert.match(note, /The bottom edge is clear\./);
});

test('edgeNote only suggests an edge that really is clearer', () => {
  const both = { edges: { top: 32, bottom: 48, left: 0, right: 0 }, freeEdge: 'right' };
  assert.match(M.edgeNote('top', both), /The right edge is clear\./);
  assert.doesNotMatch(M.edgeNote('top', { edges: { top: 32, bottom: 48, left: 0, right: 0 }, freeEdge: 'top' }), /is clear/, 'never "the top edge is clear" about the edge it just said is busy');
  assert.doesNotMatch(M.edgeNote('top', { edges: { top: 32, bottom: 40, left: 40, right: 50 }, freeEdge: 'bottom' }), /is clear/, 'bottom is no clearer here than top, so no suggestion');
  assert.match(M.edgeNote('top', { edges: { top: 32, bottom: 40, left: 40, right: 50 }, freeEdge: 'bottom' }), /bar or dock on the top edge/, 'but the warning stays');
  assert.doesNotMatch(M.edgeNote('top', { edges: { top: 32 }, freeEdge: 'sideways' }), /is clear/, 'an unknown edge is never suggested');
});

test('edgeNote copes with missing or wrong information by saying nothing', () => {
  for (const info of [undefined, null, {}, { edges: null }, { edges: [] }, { edges: { top: 'x' } }, { edges: { top: NaN } }, { edges: { top: 0 } }, { edges: { top: -3 } }, 'x', 5]) {
    assert.strictEqual(M.edgeNote('top', info), '', JSON.stringify(info));
  }
  assert.strictEqual(M.edgeNote('sideways', GNOME_INFO), '');
});

test('resetPlacement goes to the clearest edge, centred, and says so in words that fit the edge', () => {
  assert.deepStrictEqual(M.resetPlacement(GNOME_INFO), { edge: 'bottom', along: 0.5, label: 'Reset to bottom center' });
  assert.deepStrictEqual(M.resetPlacement({ freeEdge: 'left' }), { edge: 'left', along: 0.5, label: 'Reset to left middle' });
  assert.deepStrictEqual(M.resetPlacement({ freeEdge: 'right' }), { edge: 'right', along: 0.5, label: 'Reset to right middle' });
  assert.deepStrictEqual(M.resetPlacement({ freeEdge: 'top' }), { edge: 'top', along: 0.5, label: 'Reset to top center' });
});

test('resetPlacement falls back to the top edge when the clearest edge is not known', () => {
  for (const info of [undefined, null, {}, { freeEdge: 'sideways' }, { freeEdge: 7 }]) assert.strictEqual(M.resetPlacement(info).edge, 'top', JSON.stringify(info));
});

test('resetPlacement always yields something the settings store accepts as a placement', () => {
  for (const edge of M.EDGES) {
    const r = M.resetPlacement({ freeEdge: edge });
    const clean = sanitize({ dock: { edge: r.edge, along: r.along, display: null } }).dock;
    assert.deepStrictEqual({ edge: clean.edge, along: clean.along }, { edge: r.edge, along: r.along }, edge);
  }
});

// ---------------------------------------------------------------- the window system, in words

test('backendText: X11 mode through XWayland says the pill sits exactly where it is put', () => {
  const t = M.backendText({ session: 'wayland', backend: { platform: 'x11', reason: 'electron-default', placementHonoured: true, xAvailable: true } });
  assert.match(t, /X11 mode, through XWayland/);
  assert.match(t, /exactly where you put it/);
});

test('backendText: plain X11 does not mention XWayland', () => {
  const t = M.backendText({ session: 'x11', backend: { platform: 'x11', reason: 'electron-default', placementHonoured: true, xAvailable: true } });
  assert.match(t, /^X11\./);
  assert.doesNotMatch(t, /XWayland/);
});

test('backendText: native Wayland WARNS that the pill may not stay on its edge, and says how to get X11 mode', () => {
  const t = M.backendText({ session: 'wayland', backend: { platform: 'wayland', reason: 'command-line', placementHonoured: false, xAvailable: true } });
  assert.match(t, /native Wayland app/);
  assert.match(t, /may not stay on the screen edge/);
  assert.match(t, /--ozone-platform=x11/);
  assert.doesNotMatch(t, /ALLES_OZONE_PLATFORM/, 'that variable never worked and is gone');
});

test('backendText: native Wayland because there is no XWayland does not tell the person to change a setting that would not help', () => {
  const t = M.backendText({ session: 'wayland', backend: { platform: 'wayland', reason: 'command-line', placementHonoured: false, xAvailable: false } });
  assert.match(t, /no X11 layer/);
  assert.match(t, /may not stay on the screen edge/);
  assert.doesNotMatch(t, /--ozone-platform/);
});

test('backendText says nothing when nobody knows - there is nothing true to say', () => {
  for (const info of [undefined, null, {}, { backend: null }, { backend: {} }, { backend: { placementHonoured: null } }, { backend: { placementHonoured: 'yes' } }, { backend: 'x11' }]) {
    assert.strictEqual(M.backendText(info), '', JSON.stringify(info));
  }
});

// ---------------------------------------------------------------- mouse and keyboard

test('the Method control offers exactly the methods the settings store accepts, in the same order, each with a note', () => {
  const { INPUT_BACKENDS } = require('../src/main/settings');
  assert.deepStrictEqual(M.INPUT_CHOICES.map(([value]) => value), INPUT_BACKENDS);
  for (const [value, label] of M.INPUT_CHOICES) {
    assert.ok(label.length > 0);
    assert.strictEqual(sanitize({ input: { backend: value } }).input.backend, value, `${value} is accepted by the store`);
    assert.ok(M.inputNote(value).length > 20, `${value} is explained`);
  }
  assert.strictEqual(new Set(M.INPUT_CHOICES.map(([, label]) => label)).size, M.INPUT_CHOICES.length, 'labels are distinct');
});

test('inputNote: each method is described differently, and anything unknown reads as automatic (as the app treats it)', () => {
  assert.match(M.inputNote('auto'), /switches to ydotool/);
  assert.match(M.inputNote('gnome'), /Only GNOME/);
  assert.match(M.inputNote('ydotool'), /ydotoold/);
  assert.strictEqual(new Set(['auto', 'gnome', 'ydotool'].map(M.inputNote)).size, 3);
  for (const odd of ['', 'AUTO', 'x11', undefined, null, 5, {}, 'toString', '__proto__', 'constructor', 'hasOwnProperty']) assert.strictEqual(M.inputNote(odd), M.inputNote('auto'), String(odd));
});

const GNOME_IN = { mode: 'auto', name: 'gnome', label: 'GNOME direct input (no setup needed)', unicode: true, scroll: true, drag: true, auto: true, fellBackBecause: null, pending: false };
const YDO_IN = { mode: 'ydotool', name: 'ydotool', label: 'ydotool (virtual keyboard and mouse)', unicode: false, scroll: true, drag: true, auto: false, fellBackBecause: null, pending: false };

test('inputStatus: GNOME direct input is named, can enter any character, and mentions the sharing indicator and its Stop button', () => {
  const v = M.inputStatus({ input: GNOME_IN });
  assert.strictEqual(v.using, 'GNOME direct input (no setup needed)');
  assert.strictEqual(v.problem, '');
  assert.match(v.lines.join(' '), /any character/);
  assert.match(v.lines.join(' '), /screen-sharing indicator/);
  assert.match(v.lines.join(' '), /Stop button stops ALLES at once/);
  assert.doesNotMatch(v.lines.join(' '), /current task ends/);
});

test('inputStatus: ydotool is named and honest about typing only what a US keyboard can, with no sharing-indicator talk', () => {
  const v = M.inputStatus({ input: YDO_IN });
  assert.strictEqual(v.using, 'ydotool (virtual keyboard and mouse)');
  assert.match(v.lines.join(' '), /US keyboard/);
  assert.match(v.lines.join(' '), /Accents, emoji and other scripts cannot be entered/);
  assert.doesNotMatch(v.lines.join(' '), /sharing/);
  assert.doesNotMatch(v.lines.join(' '), /any character/);
});

test('inputStatus: when automatic mode gave up on GNOME the reason is shown as a problem, without a doubled full stop', () => {
  const base = { ...YDO_IN, mode: 'auto', auto: true };
  assert.strictEqual(M.inputStatus({ input: { ...base, fellBackBecause: 'PipeWire is not running.' } }).problem,
    "GNOME's own input did not work here (PipeWire is not running), so ALLES switched to ydotool. Restart ALLES to try GNOME's own input again.", 'names keep their capitals');
  const a = M.inputStatus({ input: { ...base, fellBackBecause: 'not a GNOME Wayland session  ' } }).problem;
  assert.match(a, /\(not a GNOME Wayland session\), so ALLES switched to ydotool/);
  assert.doesNotMatch(a, /\.\./);
  assert.match(M.inputStatus({ input: { ...base, fellBackBecause: '...' } }).problem, /^GNOME's own input did not work here, so ALLES switched/, 'a reason that says nothing is left out');
  assert.strictEqual(M.inputStatus({ input: base }).problem, '');
});

test('inputStatus: a choice waiting for the current task to end is said so', () => {
  assert.match(M.inputStatus({ input: { ...GNOME_IN, pending: true } }).lines.join(' '), /starts when the current task ends/);
  assert.doesNotMatch(M.inputStatus({ input: { ...GNOME_IN, pending: 'yes' } }).lines.join(' '), /current task ends/, 'only a real true counts');
});

test('inputStatus and inputText say nothing when nobody knows - and never throw', () => {
  for (const info of [undefined, null, {}, 5, 'x', { input: null }, { input: 5 }, { input: {} }, { input: { label: 5 } }, { input: { label: '' } }, { input: [] }]) {
    assert.deepStrictEqual(M.inputStatus(info), { using: '', problem: '', lines: [] }, JSON.stringify(info));
    assert.strictEqual(M.inputText(info), '', JSON.stringify(info));
  }
});

test('inputText: the one-line About entry names the method, and says so when GNOME direct input was given up on', () => {
  assert.strictEqual(M.inputText({ input: GNOME_IN }), 'GNOME direct input (no setup needed)');
  assert.strictEqual(M.inputText({ input: { ...YDO_IN, fellBackBecause: 'no PipeWire' } }), "ydotool (virtual keyboard and mouse). GNOME's own input did not work here.");
  assert.strictEqual(M.inputText({ input: YDO_IN }), 'ydotool (virtual keyboard and mouse)');
});

test('inputStatus and inputText trust only real text and real booleans', () => {
  for (const bad of [5, {}, [], true, ['x'], null]) {
    assert.strictEqual(M.inputStatus({ input: { ...YDO_IN, fellBackBecause: bad } }).problem, '', JSON.stringify(bad));
    assert.strictEqual(M.inputText({ input: { ...YDO_IN, fellBackBecause: bad } }), YDO_IN.label, JSON.stringify(bad));
  }
  for (const bad of ['yes', 1, {}, [], 'true', null]) {
    assert.match(M.inputStatus({ input: { ...GNOME_IN, unicode: bad } }).lines.join(' '), /US keyboard/, JSON.stringify(bad));
  }
  assert.strictEqual(M.inputText({ input: { label: '', fellBackBecause: 'no PipeWire' } }), '', 'with nothing to name there is nothing to say');
});
