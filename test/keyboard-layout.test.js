'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readLayout, parseSources, parseCurrent, describeSource, missingFor, canType, isLatin, NON_LATIN, ALL_ASCII, CHILD_ENV_KEYS } = require('../src/main/computer/keyboard-layout');
const DATA = require('../src/main/computer/keyboard-layout-data');

const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const xkb = (id) => ({ type: 'xkb', id });
const lay = (id) => describeSource([xkb(id)], 0);
const hasAnyLetter = (s) => [...LETTERS].some((c) => s.includes(c));

// ------------------------------------------------------------------ reading gsettings

test('parseSources reads what gsettings prints, tolerates spacing, and gives [] for anything else', () => {
  assert.deepStrictEqual(parseSources("[('xkb', 'us'), ('xkb', 'de')]"), [xkb('us'), xkb('de')]);
  assert.deepStrictEqual(parseSources("[('xkb', 'us'), ('ibus', 'mozc-jp')]"), [xkb('us'), { type: 'ibus', id: 'mozc-jp' }]);
  assert.deepStrictEqual(parseSources("[( 'xkb' ,  'in+eng' )]"), [xkb('in+eng')]);
  assert.deepStrictEqual(parseSources('@a(ss) []'), []);
  for (const bad of ['', null, undefined, 'garbage', '[(1, 2)]', 42]) assert.deepStrictEqual(parseSources(bad), []);
});

test('parseCurrent reads the active index', () => {
  assert.strictEqual(parseCurrent('uint32 1'), 1);
  assert.strictEqual(parseCurrent('uint32 12'), 12);
  for (const bad of ['', null, undefined, 'none']) assert.strictEqual(parseCurrent(bad), 0);
});

// ------------------------------------------------------------------ what each layout can type (the generated facts)

test('US, Dvorak, AltGr-international, German without dead keys, Turkish, Polish and English (India) can make every character', () => {
  for (const id of ['us', 'us+dvorak', 'us+altgr-intl', 'de+nodeadkeys', 'tr', 'pl', 'in+eng']) {
    const l = lay(id);
    assert.deepStrictEqual([id, l.missing, l.latin, l.ime, l.known], [id, '', true, false, true]);
  }
});

test('German and Spanish have no plain ^ and ` (dead keys): those two are pasted, everything else is typed', () => {
  for (const id of ['de', 'es']) {
    const l = lay(id);
    assert.ok(l.missing.includes('^') && l.missing.includes('`'), id);
    assert.strictEqual(hasAnyLetter(l.missing), false, `${id} makes every letter`);
    assert.strictEqual(l.latin, true);
    assert.strictEqual(canType(l, 'a'), true); assert.strictEqual(canType(l, '^'), false); assert.strictEqual(canType(l, '`'), false);
    assert.strictEqual(canType(l, '@'), true, 'AltGr+Q on a German keyboard: the service presses AltGr itself');
  }
});

test('measured on a real GNOME Shell 46 (scripts/gnome-e2e, scenario F): exactly these characters cannot be typed by keysym on these layouts', () => {
  // The service takes the FIRST key that carries a character on any level and presses only Shift and AltGr, so "<" on a British keyboard
  // (Shift+comma, but also Shift+AltGr+Z, and Z comes first) types "z"; a dead accent key types nothing usable; and so on.
  const measured = { gb: '<>', fr: '$<>', it: '<>', cz: '<>', de: '^`', es: '<>^`', br: '<>^`', pt: '<>^`~', fi: '<>^`|~', 'us+intl': '"^~', 'us+colemak': '~' };
  for (const [id, gaps] of Object.entries(measured)) assert.strictEqual(lay(id).missing, gaps, id);
  assert.strictEqual(canType(lay('gb'), '<'), false);
  assert.strictEqual(canType(lay('gb'), ','), true);
  assert.strictEqual(canType(lay('us+intl'), '\''), true, 'the plain apostrophe is on AltGr: the service presses that');
  // a character on a key numbered above 255 (the Russian dollar sign) never reaches an X11 application, so it is pasted
  assert.strictEqual(canType(lay('ru'), '$'), false);
  assert.strictEqual(canType(lay('ru'), '5'), true);
});

test('plain "Indian" is Devanagari (no Latin letters); "English (India)" is Latin: the two must not be confused', () => {
  const hindi = lay('in');
  assert.strictEqual(hindi.latin, false);
  assert.ok([...LETTERS].every((c) => hindi.missing.includes(c)));
  assert.strictEqual(lay('in+tel').latin, false);
  assert.strictEqual(lay('in+eng').latin, true);
});

test('layouts without Latin letters cannot make a lowercase letter: Russian, Ukrainian, Greek, Hebrew, Arabic, Thai, Bulgarian, Armenian', () => {
  for (const id of ['ru', 'ua', 'gr', 'il', 'ara', 'th', 'bg', 'am', 'us+rus', 'ru+phonetic']) {
    const l = lay(id);
    assert.strictEqual(l.latin, false, id);
    assert.ok([...'abcdefghijklmnopqrstuvwxyz'].every((c) => l.missing.includes(c)), `${id}: every lowercase letter is missing`);
    assert.strictEqual(l.known, true, id);
  }
});

test('"latin" means every letter is typeable: Hebrew has capital Latin letters on Shift but no lowercase, so it is not Latin', () => {
  const il = lay('il');
  assert.strictEqual(canType(il, 'Q'), true, 'a capital is on Shift');
  assert.strictEqual(canType(il, 'q'), false);
  assert.strictEqual(il.latin, false);
});

test('Cyrillic-by-default layouts have Latin variants, and those variants are Latin', () => {
  assert.strictEqual(lay('rs').latin, false);
  assert.strictEqual(lay('rs+latin').latin, true);
  assert.strictEqual(lay('by').latin, false);
  assert.strictEqual(lay('by+latin').latin, true);
});

test('digits still work on a Russian layout, so they are typed; ^ and the @ on it are not', () => {
  const l = lay('ru');
  assert.strictEqual(canType(l, '5'), true);
  assert.strictEqual(canType(l, '@'), false);
});

test('an input method (ibus) types nothing by keysym: everything is pasted, keys go by place', () => {
  const l = describeSource([xkb('us'), { type: 'ibus', id: 'mozc-jp' }], 1);
  assert.deepStrictEqual([l.ime, l.latin, l.missing, l.id], [true, false, ALL_ASCII, 'mozc-jp']);
  assert.strictEqual(canType(l, 'a'), false);
});

test('the active source is the one `current` points at; a bad index is clamped, not a crash', () => {
  const list = [xkb('us'), xkb('ru'), xkb('de')];
  assert.strictEqual(describeSource(list, 1).id, 'ru');
  assert.strictEqual(describeSource(list, 2).id, 'de');
  assert.strictEqual(describeSource(list, 99).id, 'de');
  assert.strictEqual(describeSource(list, -3).id, 'us');
  assert.strictEqual(describeSource(list, NaN).id, 'us');
  assert.strictEqual(describeSource([], 0).id, 'us', 'no sources at all: a US layout');
});

test('base and variant are split out of the id', () => {
  const l = lay('de+nodeadkeys');
  assert.deepStrictEqual([l.base, l.variant], ['de', 'nodeadkeys']);
  assert.deepStrictEqual([lay('us').base, lay('us').variant], ['us', '']);
});

// ------------------------------------------------------------------ layouts the table does not know

test('an unknown layout is guessed from its name, and is marked as a guess', () => {
  assert.deepStrictEqual([lay('zz').missing, lay('zz').known, lay('zz').latin], ['', false, true]);
  assert.deepStrictEqual([lay('us+brandnew').missing, lay('us+brandnew').known], ['', false]);
});

test('an unknown variant of a non-Latin layout is non-Latin unless its name says Latin (pasting is the safe side)', () => {
  assert.strictEqual(lay('ru+brandnew').latin, false);
  assert.strictEqual(lay('ru+brandnew').known, false);
  for (const id of ['ru+newlatin', 'ru+newlat']) assert.deepStrictEqual([lay(id).latin, lay(id).known, lay(id).missing], [true, false, ''], id);
  assert.strictEqual(lay('in+brandnew').latin, false, 'unknown Indian variants are not assumed to be English');
});

test('words like "us", "eng" and "qwerty" in an unknown variant name do NOT make it Latin (Arabic "qwerty" is Arabic)', () => {
  for (const id of ['ara+qwertynew', 'ru+newus', 'in+english-new', 'ara+us']) assert.strictEqual(lay(id).latin, false, id);
  assert.strictEqual(lay('ara+qwerty').latin, false, 'and the one the table knows says the same');
});

test('isLatin: every letter of both cases must be typeable; punctuation does not matter', () => {
  assert.strictEqual(isLatin(''), true);
  assert.strictEqual(isLatin('^`'), true);
  for (const c of ['a', 'q', 'z', 'A', 'Q', 'Z']) assert.strictEqual(isLatin(c), false, `missing ${c}`);
  assert.strictEqual(isLatin(ALL_ASCII), false);
});

test('Braille has no letters: it is not Latin, in the table and as a guess for a variant the table does not know', () => {
  assert.ok(NON_LATIN.has('brai'));
  assert.strictEqual(lay('brai').latin, false);
  assert.ok([...LETTERS].every((c) => missingFor('brai').missing.includes(c)));
  assert.strictEqual(lay('brai+not-in-the-table').latin, false);
});

test('every base layout in the fallback list really is non-Latin in the generated table (the guess agrees with the facts)', () => {
  for (const base of NON_LATIN) {
    if (!(base in DATA.MISSING) && !DATA.COMPLETE.includes(base)) continue;      // not in the table: nothing to compare
    const lowerMissing = base in DATA.MISSING ? [...'abcdefghijklmnopqrstuvwxyz'].filter((c) => DATA.MISSING[base].includes(c)).length : 0;
    assert.ok(lowerMissing >= 20, `${base} should lack (nearly all) Latin letters, the table says it lacks ${lowerMissing} of 26`);
  }
});

// ------------------------------------------------------------------ canType

test('canType: printable ASCII by the layout\'s gaps; anything else is never typeable', () => {
  const l = { latin: true, ime: false, missing: '^`' };
  assert.strictEqual(canType(l, 'a'), true);
  assert.strictEqual(canType(l, ' '), true);
  assert.strictEqual(canType(l, '~'), true);
  assert.strictEqual(canType(l, '^'), false);
  for (const ch of ['é', '₹', '\u{1F600}', '\n', '\t', '\u0000', '\u007f']) assert.strictEqual(canType(l, ch), false, JSON.stringify(ch));
  assert.strictEqual(canType(null, 'a'), false);
  assert.strictEqual(canType(undefined, 'a'), false);
});

test('canType: a layout described only by `latin` (an older or simpler source) is judged by that', () => {
  assert.strictEqual(canType({ latin: true, ime: false }, 'q'), true);
  assert.strictEqual(canType({ latin: false, ime: false }, 'q'), false);
  assert.strictEqual(canType({ latin: true, ime: true }, 'q'), false);
});

// ------------------------------------------------------------------ readLayout (the real call, with a fake gsettings)

const GSETTINGS = (sources, current) => [
  `org.gnome.desktop.input-sources current uint32 ${current}`,
  'org.gnome.desktop.input-sources mru-sources @a(ss) []',
  'org.gnome.desktop.input-sources per-window false',
  'org.gnome.desktop.input-sources show-all-sources false',
  `org.gnome.desktop.input-sources sources ${sources}`,
  'org.gnome.desktop.input-sources xkb-options @as []',
].join('\n');
const execReturning = (out, { err = null, calls = null } = {}) => (bin, args, opts, cb) => { if (calls) calls.push({ bin, args, opts }); cb(err, out); };

test('readLayout: asks gsettings for the input sources and returns the active one', async () => {
  const calls = [];
  const l = await readLayout({ exec: execReturning(GSETTINGS("[('xkb', 'us'), ('xkb', 'de')]", 1), { calls }), env: { PATH: '/usr/bin' } });
  assert.strictEqual(l.id, 'de');
  assert.ok(l.missing.includes('^'));
  assert.deepStrictEqual([calls[0].bin, calls[0].args], ['gsettings', ['list-recursively', 'org.gnome.desktop.input-sources']]);
  assert.strictEqual(calls[0].opts.timeout, 2000);
});

test('readLayout: the child sees only a whitelisted environment: no API keys, nothing else of ours', async () => {
  const calls = [];
  const env = { PATH: '/bin', HOME: '/home/a', LANG: 'en_US.UTF-8', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', NVIDIA_API_KEY: 'nvapi-secret', XAI_API_KEY: 'xai-secret', GEMINI_API_KEY: 'g-secret', ELECTRON_RUN_AS_NODE: '1' };
  await readLayout({ exec: execReturning(GSETTINGS("[('xkb', 'us')]", 0), { calls }), env });
  assert.deepStrictEqual(Object.keys(calls[0].opts.env).sort(), ['DBUS_SESSION_BUS_ADDRESS', 'HOME', 'LANG', 'PATH']);
  assert.ok(!JSON.stringify(calls[0].opts.env).includes('secret'));
  assert.ok(CHILD_ENV_KEYS.every((k) => !/KEY|TOKEN|SECRET/i.test(k)));
});

test('readLayout: with no PATH in our environment the child still finds gsettings', async () => {
  const calls = [];
  await readLayout({ exec: execReturning(GSETTINGS("[('xkb', 'us')]", 0), { calls }), env: {} });
  assert.match(calls[0].opts.env.PATH, /\/usr\/bin/);
});

test('readLayout: gsettings missing or failing means "a US layout", marked as a guess; it never throws', async () => {
  const a = await readLayout({ exec: execReturning('', { err: new Error('ENOENT') }) });
  assert.deepStrictEqual([a.id, a.latin, a.missing, a.guessed], ['us', true, '', true]);
  const b = await readLayout({ exec: () => { throw new Error('spawn blew up'); } });
  assert.deepStrictEqual([b.id, b.guessed], ['us', true]);
  const c = await readLayout({ exec: execReturning('complete nonsense\n\n???') });
  assert.strictEqual(c.id, 'us');
});

test('readLayout: a reply that arrives twice is used once', async () => {
  const l = await readLayout({ exec: (bin, args, opts, cb) => { cb(null, GSETTINGS("[('xkb', 'ru')]", 0)); cb(null, GSETTINGS("[('xkb', 'de')]", 0)); } });
  assert.strictEqual(l.id, 'ru');
});

test('readLayout: an input method source is reported as one', async () => {
  const l = await readLayout({ exec: execReturning(GSETTINGS("[('xkb', 'us'), ('ibus', 'libpinyin')]", 1), {}) });
  assert.deepStrictEqual([l.ime, l.id], [true, 'libpinyin']);
});

// ------------------------------------------------------------------ the generated table itself

test('the table: every entry is a clean, sorted list of printable ASCII, and no layout is both gappy and complete', () => {
  assert.ok(typeof DATA.VERSION === 'string' && DATA.VERSION.length > 0);
  for (const [id, miss] of Object.entries(DATA.MISSING)) {
    assert.match(id, /^[a-z0-9]+(\+[\w.-]+)?$/, `id ${id}`);
    assert.ok(miss.length > 0, `${id}: an empty list belongs in COMPLETE`);
    assert.ok([...miss].every((c) => c >= ' ' && c <= '~'), `${id}: only printable ASCII`);
    assert.strictEqual(new Set(miss).size, miss.length, `${id}: no repeats`);
    assert.deepStrictEqual([...miss], [...miss].sort(), `${id}: sorted`);
    assert.ok(!DATA.COMPLETE.includes(id), `${id} is in both lists`);
  }
  assert.strictEqual(new Set(DATA.COMPLETE).size, DATA.COMPLETE.length);
  assert.ok(Object.keys(DATA.MISSING).length > 300 && DATA.COMPLETE.length > 50, 'a real table, not a stub');
});

test('the table: the default layouts of Latin-script languages can make every letter (guards the generator against dropping keys)', () => {
  const latinBases = ['us', 'gb', 'de', 'fr', 'es', 'it', 'pt', 'br', 'se', 'no', 'dk', 'fi', 'nl', 'pl', 'cz', 'sk', 'hu', 'ro', 'tr', 'ie', 'ch', 'be', 'ca', 'is', 'hr', 'si', 'ee', 'lv', 'lt', 'mt'];
  for (const id of latinBases) {
    assert.ok(id in DATA.MISSING || DATA.COMPLETE.includes(id), `${id} is in the table`);
    assert.strictEqual(hasAnyLetter(missingFor(id).missing), false, `${id} lacks a letter`);
  }
  // the US layout in particular: all 95 printable characters, including the backquote and backslash keys
  assert.ok(DATA.COMPLETE.includes('us'));
});

test('the table: the file says it is generated, and by what', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'computer', 'keyboard-layout-data.js'), 'utf8');
  assert.match(src, /GENERATED by scripts\/gen-layout-data\.py/);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts', 'gen-layout-data.py')));
});

// ------------------------------------------------------------------ the generator's model of the service (needs python3, libxkbcommon and xkb-data: skipped where they are not)

const explain = (id, chars) => spawnSync('python3', ['-I', path.join(__dirname, '..', 'scripts', 'gen-layout-data.py'), '--explain', id, chars], { encoding: 'utf8' });

test('the generator replays the service\'s choice: on a British keyboard "<" is found first on the Z key, on a level the service cannot press', (t) => {
  const r = explain('gb', '<a');
  if (r.status !== 0 || /does not compile/.test(r.stdout)) return t.skip('python3 with libxkbcommon and xkb-data is needed');
  const [lt, a] = r.stdout.trim().split('\n');
  assert.match(lt, /level 3 \(the service cannot press that level\).*= WRONG$/);
  assert.match(a, /level 0 -> keysym 0x61 = OK$/);
});

test('the generator and the checked-in table agree (checked when this machine has the xkb-data version the table was made from)', (t) => {
  const v = spawnSync('dpkg-query', ['-W', '-f=${Version}', 'xkb-data'], { encoding: 'utf8' });
  if (v.error || v.status !== 0 || v.stdout.trim() !== DATA.VERSION) return t.skip(`the table was made from xkb-data ${DATA.VERSION}`);
  for (const id of ['us', 'gb', 'ru', 'us+intl', 'de', 'fr', 'br']) {
    const r = explain(id, ALL_ASCII);
    if (r.status !== 0 || /does not compile/.test(r.stdout)) return t.skip('python3 with libxkbcommon is needed');
    const lines = r.stdout.split('\n').filter(Boolean);
    assert.strictEqual(lines.length, ALL_ASCII.length, id);
    const gaps = [...ALL_ASCII].filter((c, i) => !/= OK$/.test(lines[i])).join('');
    assert.strictEqual(gaps, lay(id).missing, `${id}: what the generator finds now, and what the table says`);
  }
});

test('the generator: on a US keyboard "<" is Shift+comma, which the service can press', (t) => {
  const r = explain('us', '<');
  if (r.status !== 0 || /does not compile/.test(r.stdout)) return t.skip('python3 with libxkbcommon and xkb-data is needed');
  assert.match(r.stdout.trim(), /level 1 -> keysym 0x3c = OK$/);
});
