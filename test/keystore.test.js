'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { KeyStore, KeyStoreError, hintOf, MAX_KEYS_PER_ROUTE } = require('../src/main/keystore');
const { redact } = require('../src/main/redact');
const { tmpDir } = require('./helpers/tmp');

const tmp = () => path.join(tmpDir('alles-keys-'), 'keys.json');
const KEY1 = 'nvapi-AAAAAAAAAAAA1111', KEY2 = 'nvapi-BBBBBBBBBBBB2222', KEY3 = 'xai-CCCCCCCCCCCC3333';

// A fake safeStorage. "Encryption" = reverse the bytes + a marker, so a plaintext key can never
// appear literally in the ciphertext, and decrypt genuinely inverts it.
function fakeSafe({ available = true, backend = 'gnome_libsecret', failDecrypt = false } = {}) {
  const s = {
    available, backend, failDecrypt,
    isEncryptionAvailable: () => s.available,
    getSelectedStorageBackend: () => s.backend,
    encryptString: (t) => { if (!s.available) throw new Error('Encryption is not available.'); return Buffer.concat([Buffer.from('v11'), Buffer.from(t, 'utf8').reverse()]); },
    decryptString: (b) => { if (s.failDecrypt || !s.available) throw new Error('decrypt failed'); return Buffer.from(b.subarray(3)).reverse().toString('utf8'); },
  };
  return s;
}
let n = 0; const ids = () => `${(++n).toString(16).padStart(4, '0')}abcd`;
const make = (file, o = {}) => new KeyStore(file, { newId: ids, ...o });

// ---------------------------------------------------------------- mode

test('MODE: real keyring -> "keyring"', () => {
  assert.strictEqual(make(tmp(), { safeStorage: fakeSafe() }).mode(), 'keyring');
});

test('MODE: no keyring, no opt-in -> "session" (memory only) - the safe default', () => {
  assert.strictEqual(make(tmp(), { safeStorage: fakeSafe({ available: false }) }).mode(), 'session');
  assert.strictEqual(make(tmp(), { safeStorage: null }).mode(), 'session');
});

test('MODE: no keyring + opt-in -> "file"', () => {
  assert.strictEqual(make(tmp(), { safeStorage: fakeSafe({ available: false }), getPolicy: () => 'file' }).mode(), 'file');
});

test('MODE: "basic_text" (hard-coded-key obfuscation) is NOT treated as a keyring, even though it reports available', () => {
  assert.strictEqual(make(tmp(), { safeStorage: fakeSafe({ available: true, backend: 'basic_text' }) }).mode(), 'session');
});

test('MODE: an opt-in for file storage does not downgrade a working keyring', () => {
  assert.strictEqual(make(tmp(), { safeStorage: fakeSafe(), getPolicy: () => 'file' }).mode(), 'keyring');
});

test('MODE: a safeStorage that throws is treated as unavailable, never crashes', () => {
  const bad = { isEncryptionAvailable() { throw new Error('boom'); }, getSelectedStorageBackend() { throw new Error('boom'); } };
  assert.strictEqual(make(tmp(), { safeStorage: bad }).mode(), 'session');
});

test('status() explains each mode in plain words, and file mode says PLAIN TEXT', () => {
  assert.match(make(tmp(), { safeStorage: fakeSafe() }).status().summary, /encrypted with your system keyring \(gnome_libsecret\)/);
  assert.match(make(tmp(), { safeStorage: null, getPolicy: () => 'file' }).status().summary, /PLAIN TEXT/);
  const s = make(tmp(), { safeStorage: null }).status();
  assert.match(s.summary, /memory only.*re-entered/);
  assert.strictEqual(s.persistent, false);
});

// ---------------------------------------------------------------- keyring mode

test('KEYRING: add -> list -> secrets round trip; the file holds ciphertext, never the key', () => {
  const file = tmp(); const ks = make(file, { safeStorage: fakeSafe() });
  const r = ks.add('nvidia-primary', KEY1);
  assert.strictEqual(r.mode, 'keyring');
  assert.deepStrictEqual(ks.secrets('nvidia-primary'), [KEY1]);
  const onDisk = fs.readFileSync(file, 'utf8');
  assert.ok(!onDisk.includes('AAAAAAAAAAAA1111'), 'plaintext key found in the key file');
  assert.match(onDisk, /"format": "enc"/);
});

test('KEYRING: keys survive a restart', () => {
  const file = tmp(); const safe = fakeSafe();
  make(file, { safeStorage: safe }).add('grok', KEY3);
  assert.deepStrictEqual(make(file, { safeStorage: safe }).secrets('grok'), [KEY3]);
});

test('SECURITY: the key file is 0600 and its directory 0700 (real disk)', () => {
  const file = tmp(); const ks = make(file, { safeStorage: fakeSafe() });
  ks.add('gemini', KEY1);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(path.dirname(file)).mode & 0o077, 0, 'directory must not be group/world accessible');
});

test('SECURITY: a directory the store CREATES is private (0700). The temp dir from tmp() already exists, so it cannot test this', () => {
  const base = tmpDir('alles-nested-');
  const file = path.join(base, 'config', 'alles', 'keys.json');           // neither level exists yet
  make(file, { safeStorage: fakeSafe() }).add('grok', KEY1);
  for (const dir of [path.join(base, 'config'), path.join(base, 'config', 'alles')]) {
    assert.strictEqual(fs.statSync(dir).mode & 0o077, 0, `${dir} is accessible to group/other`);
  }
});

test('SECURITY: list() never exposes a secret - only id, hint and flags', () => {
  const ks = make(tmp(), { safeStorage: fakeSafe() });
  ks.add('nvidia-primary', KEY1); ks.add('nvidia-primary', KEY2);
  const json = JSON.stringify(ks.list('nvidia-primary'));
  assert.ok(!json.includes('AAAAAAAA') && !json.includes('BBBBBBBB'));
  assert.deepStrictEqual(Object.keys(ks.list('nvidia-primary')[0]).sort(), ['addedAt', 'hint', 'id', 'persisted', 'readable']);
});

test('hint shows 4 + 3 characters only, and short keys are fully masked', () => {
  assert.strictEqual(hintOf('nvapi-AAAAAAAAAAAA1111'), 'nvap…111');
  assert.strictEqual(hintOf('12345678'), '****');
});

test('KEYRING: an entry that cannot be decrypted is flagged unreadable and skipped; the others still work', () => {
  const file = tmp(); const safe = fakeSafe();
  const ks = make(file, { safeStorage: safe });
  ks.add('grok', KEY1);
  safe.failDecrypt = true;                                    // keyring locked / changed
  assert.strictEqual(ks.list('grok')[0].readable, false);
  assert.deepStrictEqual(ks.secrets('grok'), []);
  safe.failDecrypt = false;
  assert.deepStrictEqual(ks.secrets('grok'), [KEY1]);
});

// ---------------------------------------------------------------- secretById: fetching ONE key by id

test('secretById: returns the exact secret for the id, not whatever happens to be at that index', () => {
  const ks = make(tmp(), { safeStorage: fakeSafe() });
  const a = ks.add('grok', KEY1); const b = ks.add('grok', KEY2);
  assert.strictEqual(ks.secretById('grok', a.id), KEY1);
  assert.strictEqual(ks.secretById('grok', b.id), KEY2);
});

test('secretById: null for an id that does not exist, or a route that does not exist, never throws', () => {
  const ks = make(tmp(), { safeStorage: fakeSafe() });
  ks.add('grok', KEY1);
  assert.strictEqual(ks.secretById('grok', 'no-such-id'), null);
  assert.strictEqual(ks.secretById('no-such-route', 'abcd1234'), null);
  assert.strictEqual(ks.secretById('grok', ''), null);
  assert.strictEqual(ks.secretById('grok', undefined), null);
});

test('secretById: null for an entry that cannot currently be decrypted, without throwing', () => {
  const file = tmp(); const safe = fakeSafe();
  const ks = make(file, { safeStorage: safe });
  const a = ks.add('grok', KEY1);
  safe.failDecrypt = true;
  assert.strictEqual(ks.secretById('grok', a.id), null);
  safe.failDecrypt = false;
  assert.strictEqual(ks.secretById('grok', a.id), KEY1);
});

test('secretById: THE BUG THIS EXISTS TO PREVENT - list() and secrets() are NOT index-aligned when an earlier key is unreadable, so index-pairing them silently returns the WRONG secret; secretById does not have this flaw', () => {
  const file = tmp(); const safe = fakeSafe();
  const ks = make(file, { safeStorage: safe });
  const first = ks.add('grok', KEY1);   // will become unreadable
  const second = ks.add('grok', KEY2);  // stays readable

  safe.failDecrypt = true;
  ks.add('gemini', KEY3); // touch a different route; irrelevant, just proving isolation
  // Re-open with a safeStorage where ONLY the specific ciphertext for KEY1 fails - simulate a single
  // corrupted/rotated entry rather than a globally locked keyring, which is the realistic failure mode.
  const selective = fakeSafe();
  const realDecrypt = selective.decryptString.bind(selective);
  selective.decryptString = (b) => { const s = realDecrypt(b); if (s === KEY1) throw new Error('this one entry is corrupted'); return s; };
  const ks2 = make(file, { safeStorage: selective });

  const list = ks2.list('grok');
  assert.strictEqual(list.length, 2, 'both entries still appear in list()');
  assert.strictEqual(list.find((k) => k.id === first.id).readable, false);
  assert.strictEqual(list.find((k) => k.id === second.id).readable, true);

  // secrets() SKIPS the unreadable one, so it is a 1-element array - if a caller paired list()[i] with
  // secrets()[i] by position, asking for the SECOND list entry (second.id) would incorrectly read
  // secrets()[1], which does not exist / would be the wrong value once more keys are added.
  const secretsArray = ks2.secrets('grok');
  assert.deepStrictEqual(secretsArray, [KEY2], 'confirms the misalignment: only 1 secret for 2 list entries');

  // secretById is immune: it looks up by id, not position.
  assert.strictEqual(ks2.secretById('grok', second.id), KEY2, 'correct key for the SECOND entry, despite the first being unreadable');
  assert.strictEqual(ks2.secretById('grok', first.id), null, 'correctly null for the actually-unreadable one');
});

test('KEYRING becoming unavailable later: stored keys become unreadable, not lost', () => {
  const file = tmp(); const safe = fakeSafe();
  make(file, { safeStorage: safe }).add('grok', KEY1);
  safe.available = false;
  const ks = make(file, { safeStorage: safe });
  assert.strictEqual(ks.list('grok').length, 1);
  assert.strictEqual(ks.list('grok')[0].readable, false);
  safe.available = true;
  assert.deepStrictEqual(ks.secrets('grok'), [KEY1]);
});

// ---------------------------------------------------------------- file mode

test('FILE: opted-in plain-text storage persists, with 0600, and is labelled as plain in the file', () => {
  const file = tmp(); const ks = make(file, { safeStorage: fakeSafe({ available: false }), getPolicy: () => 'file' });
  assert.strictEqual(ks.add('grok', KEY1).mode, 'file');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(file, 'utf8'), /"format": "plain"/);
  assert.deepStrictEqual(make(file, { safeStorage: null }).secrets('grok'), [KEY1], 'readable by a new process regardless of keyring');
});

// ---------------------------------------------------------------- session mode

test('SESSION: nothing is written to disk, keys work now, and are gone in the next process', () => {
  const file = tmp(); const ks = make(file, { safeStorage: null });
  assert.strictEqual(ks.add('grok', KEY1).mode, 'session');
  assert.strictEqual(fs.existsSync(file), false, 'a session-only key must never touch the disk');
  assert.deepStrictEqual(ks.secrets('grok'), [KEY1]);
  assert.strictEqual(ks.list('grok')[0].persisted, false);
  assert.deepStrictEqual(make(file, { safeStorage: null }).secrets('grok'), []);
});

test('SESSION -> FILE: keys held in memory are persisted when the user opts in', () => {
  const file = tmp(); let policy = 'session';
  const ks = make(file, { safeStorage: null, getPolicy: () => policy });
  ks.add('grok', KEY1); ks.add('gemini', KEY2);
  assert.strictEqual(ks.migrateSession(), 0, 'nothing to do while still in session mode');
  policy = 'file';
  assert.strictEqual(ks.migrateSession(), 2);
  assert.ok(ks.list('grok').every((k) => k.persisted));
  assert.deepStrictEqual(make(file, { safeStorage: null }).secrets('gemini'), [KEY2]);
  assert.strictEqual(ks.migrateSession(), 0, 'idempotent');
});

// ---------------------------------------------------------------- validation

test('VALIDATION: rejects anything that is not a plausible API key, with a message a person can act on', () => {
  const ks = make(tmp(), { safeStorage: fakeSafe() });
  const bad = ['', '   ', 'short', 'has space inside1234', 'line\nbreak12345678', 'tab\there12345678', 'caf\u00e9-key-123456789', 'x'.repeat(513), 12345678, null, undefined, {}, ['nvapi-AAAAAAAAAAAA1111']];
  for (const b of bad) assert.throws(() => ks.add('grok', b), (e) => e instanceof KeyStoreError && e.code === 'invalid-key' && /API key/.test(e.message), JSON.stringify(b));
  assert.strictEqual(ks.list('grok').length, 0);
});

test('VALIDATION: surrounding whitespace (from a paste) is trimmed, not rejected', () => {
  const ks = make(tmp(), { safeStorage: fakeSafe() });
  ks.add('grok', `  ${KEY1}\n`);
  assert.deepStrictEqual(ks.secrets('grok'), [KEY1]);
});

test('VALIDATION: a key containing CR/LF cannot be smuggled in to inject HTTP headers', () => {
  const ks = make(tmp(), { safeStorage: fakeSafe() });
  assert.throws(() => ks.add('grok', 'validkey1234\r\nX-Evil: 1'), /API key/);
});

test('VALIDATION: duplicates are refused per provider, but the same key on two providers is allowed', () => {
  const ks = make(tmp(), { safeStorage: fakeSafe() });
  ks.add('nvidia-primary', KEY1);
  assert.throws(() => ks.add('nvidia-primary', KEY1), (e) => e.code === 'duplicate');
  assert.doesNotThrow(() => ks.add('nvidia-fallback', KEY1));
});

test('VALIDATION: provider ids are restricted (no paths, no empty, no odd characters)', () => {
  const ks = make(tmp(), { safeStorage: fakeSafe() });
  for (const r of ['', '../x', 'a/b', 'A', 'x'.repeat(33), 'sp ace', null, undefined, 7]) assert.throws(() => ks.add(r, KEY1), (e) => e.code === 'invalid-route', String(r));
});

test('LIMIT: at most 20 keys per provider', () => {
  const ks = make(tmp(), { safeStorage: null });
  for (let i = 0; i < MAX_KEYS_PER_ROUTE; i++) ks.add('grok', `key-number-${String(i).padStart(4, '0')}-abcdef`);
  assert.throws(() => ks.add('grok', 'one-more-key-abcdefgh'), (e) => e.code === 'too-many');
});

// ---------------------------------------------------------------- remove

test('remove(): removes one key, keeps the rest, and persists', () => {
  const file = tmp(); const safe = fakeSafe(); const ks = make(file, { safeStorage: safe });
  const a = ks.add('grok', KEY1), b = ks.add('grok', KEY2);
  assert.strictEqual(ks.remove('grok', a.id), true);
  assert.deepStrictEqual(make(file, { safeStorage: safe }).secrets('grok'), [KEY2]);
  assert.strictEqual(ks.remove('grok', a.id), false, 'already gone');
  assert.strictEqual(ks.remove('grok', b.id), true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).routes, {}, 'an empty provider leaves no residue');
});

test('removeRoute(): deletes everything for one provider only', () => {
  const ks = make(tmp(), { safeStorage: fakeSafe() });
  ks.add('grok', KEY1); ks.add('grok', KEY2); ks.add('gemini', KEY3);
  assert.strictEqual(ks.removeRoute('grok'), true);
  assert.deepStrictEqual([ks.secrets('grok'), ks.secrets('gemini')], [[], [KEY3]]);
  assert.strictEqual(ks.removeRoute('grok'), false);
});

test("'change' fires on add and remove", () => {
  const ks = make(tmp(), { safeStorage: fakeSafe() }); const seen = [];
  ks.on('change', (r) => seen.push(r));
  const k = ks.add('grok', KEY1); ks.remove('grok', k.id);
  assert.deepStrictEqual(seen, ['grok', 'grok']);
});

// ---------------------------------------------------------------- failure handling

test('SAVE FAILURE: the key is NOT kept (no half-added state) and the error is actionable', () => {
  const file = tmp(); const broken = { ...fs, renameSync: () => { throw new Error('EROFS: read-only file system'); } };
  const ks = make(file, { safeStorage: fakeSafe(), fsImpl: broken });
  assert.throws(() => ks.add('grok', KEY1), (e) => e.code === 'save-failed' && /EROFS/.test(e.message));
  assert.deepStrictEqual(ks.secrets('grok'), []);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.tmp-')), [], 'temp file cleaned up');
});

test('CORRUPT FILE: moved aside (never deleted), reported, and the store keeps working', () => {
  const file = tmp(); fs.writeFileSync(file, '{ "routes": { "grok": [ {');
  const ks = make(file, { safeStorage: fakeSafe(), now: () => 777 });
  assert.match(ks.loadIssue, /unreadable.*keys\.json\.corrupt-777/);
  assert.strictEqual(fs.readFileSync(`${file}.corrupt-777`, 'utf8'), '{ "routes": { "grok": [ {');
  ks.add('grok', KEY1);
  assert.deepStrictEqual(make(file, { safeStorage: fakeSafe() }).secrets('grok'), [KEY1]);
});

test('MALFORMED ENTRIES are dropped individually and counted; valid neighbours survive', () => {
  const file = tmp(); const safe = fakeSafe();
  const good = make(file, { safeStorage: safe }); good.add('grok', KEY1);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.routes.grok.push({ id: 'zz', format: 'enc', data: 'x' }, { id: 'abcd1234', format: 'weird', data: 'x' }, null, 5);
  raw.routes['../evil'] = [{ id: 'abcd1234', format: 'plain', data: 'x' }];
  fs.writeFileSync(file, JSON.stringify(raw));
  const ks = make(file, { safeStorage: safe });
  assert.deepStrictEqual(ks.secrets('grok'), [KEY1]);
  assert.match(ks.loadIssue, /5 malformed key entries were ignored/);
});

test('a hostile key file cannot smuggle in extra entry fields or an over-long hint', () => {
  const file = tmp();
  fs.writeFileSync(file, JSON.stringify({ routes: { grok: [{ id: 'abcd1234', format: 'plain', data: 'realkey-12345678', hint: 'h'.repeat(500), extra: '<script>' }] } }));
  const l = make(file, { safeStorage: null }).list('grok')[0];
  assert.ok(l.hint.length <= 16);
  assert.ok(!('extra' in l));
});

test('a missing file is a normal first run: no issue reported', () => {
  assert.strictEqual(make(tmp(), { safeStorage: null }).loadIssue, null);
});

// ---------------------------------------------------------------- redact

test('REDACT: known keys are removed wherever they appear, including repeats', () => {
  const out = redact(`HTTP 401: bad key ${KEY1}; again ${KEY1}!`, [KEY1]);
  assert.ok(!out.includes('AAAAAAAA'));
  assert.strictEqual((out.match(/\[redacted\]/g) || []).length, 2);
});

test('REDACT: well-known key shapes are removed even when we do not hold that key', () => {
  for (const k of ['nvapi-ZZZZZZZZZZZZ9999', 'xai-ZZZZZZZZZZZZ9999', 'AIzaSyZZZZZZZZZZZZZZZZZZ', 'sk-ZZZZZZZZZZZZZZZZ9999', 'Bearer abc.def-ghi_jkl123456']) {
    assert.doesNotMatch(redact(`Incorrect API key provided: ${k} (see docs)`), /ZZZZ|abc\.def/, k);
  }
});

test('REDACT: ordinary text is left alone, and short "secrets" do not shred normal words', () => {
  assert.strictEqual(redact('Rate limit exceeded, retry in 30s'), 'Rate limit exceeded, retry in 30s');
  assert.strictEqual(redact('the cat sat', ['cat']), 'the cat sat');
  assert.strictEqual(redact(null), '');
  assert.strictEqual(redact(undefined, [undefined, null, 5]), '');
});

test('removeRoute is transactional: a failed disk write preserves persisted and in-memory keys', () => {
  const file = tmp();
  const ks = make(file, { safeStorage: fakeSafe() });
  ks.add('grok', KEY1);
  const beforeDisk = fs.readFileSync(file, 'utf8');
  const save = ks._save.bind(ks);
  ks._save = () => { throw new Error('disk full'); };
  assert.throws(() => ks.removeRoute('grok'), (e) => e instanceof KeyStoreError && /disk full/.test(e.message));
  assert.deepStrictEqual(ks.secrets('grok'), [KEY1]);
  assert.strictEqual(ks.list('grok').length, 1);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), beforeDisk);
  ks._save = save;
  assert.strictEqual(ks.removeRoute('grok'), true);
  assert.deepStrictEqual(ks.secrets('grok'), []);
});
