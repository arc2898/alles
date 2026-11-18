'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SettingsStore, sanitize, applyPatch, DEFAULTS } = require('../src/main/settings');
const { tmpDir } = require('./helpers/tmp');

const tmpFile = () => path.join(tmpDir('arc-settings-'), 'settings.json');

// Manual timers so debounce is deterministic and nothing can hang the suite.
function timers() {
  const q = []; let id = 0;
  return {
    setTimer: (fn) => { const t = { id: ++id, fn, unref() {} }; q.push(t); return t; },
    clearTimer: (t) => { const i = q.indexOf(t); if (i >= 0) q.splice(i, 1); },
    fire: () => { const all = q.splice(0); all.forEach((t) => t.fn()); return all.length; },
    pending: () => q.length,
  };
}
const make = (file, extra = {}) => { const t = timers(); const store = new SettingsStore(file, { ...t, ...extra }); return { store, t }; };

// ------------------------------------------------------------------ sanitize

test('sanitize({}) equals the defaults', () => {
  assert.deepStrictEqual(sanitize({}), DEFAULTS);
});

test('settings v1 migrates to persistent pill defaults; v2 can explicitly re-enable auto-hide', () => {
  const migrated = sanitize({ version: 1, dock: { autoHide: true, edge: 'left' } });
  assert.strictEqual(migrated.version, 3);
  assert.strictEqual(migrated.dock.autoHide, false, '0.2.x always wrote the old auto-hide default; 0.3.0 migrates it');
  assert.strictEqual(migrated.dock.edge, 'left');
  assert.strictEqual(sanitize({ version: 2, dock: { autoHide: true } }).dock.autoHide, true);
});

test('sanitize never throws on hostile input, and always returns a full valid object', () => {
  for (const bad of [undefined, null, 0, 'x', [], true, () => 1, { dock: null }, { dock: 5 }, { dock: [] }, { agent: 'a', safety: 9 }, { dock: { edge: {}, along: {} } }]) {
    const s = sanitize(bad);
    assert.deepStrictEqual(Object.keys(s).sort(), Object.keys(DEFAULTS).sort(), 'same sections as the defaults, whatever they are');
    assert.ok(['top', 'bottom', 'left', 'right'].includes(s.dock.edge));
    assert.ok(s.dock.along >= 0 && s.dock.along <= 1);
  }
});

test('sanitize is PER-FIELD: one bad value does not reset its neighbours', () => {
  const s = sanitize({ dock: { edge: 'left', along: 'banana', hour12: true }, safety: { maxActionsPerMinute: 30 } });
  assert.strictEqual(s.dock.edge, 'left', 'good field kept');
  assert.strictEqual(s.dock.hour12, true, 'good field kept');
  assert.strictEqual(s.dock.along, DEFAULTS.dock.along, 'bad field defaulted');
  assert.strictEqual(s.safety.maxActionsPerMinute, 30);
});

test('sanitize clamps numbers into range instead of rejecting them', () => {
  const s = sanitize({ dock: { along: 7 }, agent: { maxSteps: 99999, keepImages: -4 }, safety: { maxActionsPerMinute: 0 } });
  assert.strictEqual(s.dock.along, 1);
  assert.strictEqual(s.agent.maxSteps, 200);
  assert.strictEqual(s.agent.keepImages, 0);
  assert.strictEqual(s.safety.maxActionsPerMinute, 1);
});

test('sanitize rejects NaN / Infinity / non-booleans', () => {
  const s = sanitize({ dock: { along: NaN, autoHide: 'yes' }, agent: { maxSteps: Infinity } });
  assert.strictEqual(s.dock.along, 0.5);
  assert.strictEqual(s.dock.autoHide, false);
  assert.strictEqual(s.agent.maxSteps, DEFAULTS.agent.maxSteps);
});

test('SAFETY DEFAULTS are the safe ones: dangerous keys OFF, approvals ON', () => {
  assert.strictEqual(DEFAULTS.safety.allowDangerousKeys, false);
  assert.strictEqual(DEFAULTS.safety.requireApprovalForShell, true);
  assert.strictEqual(DEFAULTS.safety.requireApprovalForFileWrites, true);
  // and a corrupted safety block falls back to SAFE, never to permissive
  const s = sanitize({ safety: { allowDangerousKeys: 'true', requireApprovalForShell: null } });
  assert.strictEqual(s.safety.allowDangerousKeys, false);
  assert.strictEqual(s.safety.requireApprovalForShell, true);
});

test('the settings file has NO place for API keys', () => {
  const s = sanitize({ apiKeys: { nvidia: 'nvapi-SECRET' }, dock: { apiKey: 'nvapi-SECRET' }, providers: [{ keys: ['nvapi-SECRET'] }] });
  assert.ok(!JSON.stringify(s).includes('SECRET'), 'unknown fields, including secrets, are dropped');
});

test('applyPatch validates patched values and ignores unknown sections', () => {
  const next = applyPatch(DEFAULTS, { dock: { edge: 'diagonal', along: 0.25 }, hacker: { x: 1 } });
  assert.strictEqual(next.dock.edge, 'top', 'invalid edge rejected');
  assert.strictEqual(next.dock.along, 0.25, 'valid sibling applied');
  assert.ok(!('hacker' in next));
});

// ------------------------------------------------------------------ the mouse and keyboard method

test('input.backend: "auto" is the default, and exactly the three methods the input code knows are accepted', () => {
  const { INPUT_BACKENDS } = require('../src/main/settings');
  const { MODES } = require('../src/main/computer/select-backend');
  assert.strictEqual(DEFAULTS.input.backend, 'auto');
  assert.deepStrictEqual(INPUT_BACKENDS, MODES, 'the settings store and the input code must agree on the names');
  for (const m of MODES) assert.strictEqual(sanitize({ input: { backend: m } }).input.backend, m);
});

test('input.backend: anything else falls back to automatic, per field, without disturbing the rest', () => {
  for (const bad of ['', 'AUTO', 'x11', 'toString', '__proto__', 5, null, true, {}, [], ['gnome']]) {
    assert.strictEqual(sanitize({ input: { backend: bad }, dock: { edge: 'left' } }).input.backend, 'auto', JSON.stringify(bad));
  }
  for (const bad of [null, 5, 'gnome', [], undefined]) assert.deepStrictEqual(sanitize({ input: bad }).input, { backend: 'auto' });
  assert.strictEqual(sanitize({ input: { backend: 'nope' }, dock: { edge: 'left' } }).dock.edge, 'left');
});

test('input.backend can be changed with a patch, and a bad patch value does not stick', () => {
  assert.strictEqual(applyPatch(DEFAULTS, { input: { backend: 'ydotool' } }).input.backend, 'ydotool');
  assert.strictEqual(applyPatch(DEFAULTS, { input: { backend: 'gnome' } }).input.backend, 'gnome');
  assert.strictEqual(applyPatch(sanitize({ input: { backend: 'gnome' } }), { input: { backend: 'bogus' } }).input.backend, 'auto');
  assert.ok(!('extra' in applyPatch(DEFAULTS, { input: { backend: 'gnome', extra: 1 } }).input), 'no other fields in the section');
});

test('input.backend survives a save and a reload, and a change is announced with the old and new value', () => {
  const file = tmpFile();
  const { store } = make(file);
  const seen = [];
  store.on('change', (next, prev) => seen.push([prev.input.backend, next.input.backend]));
  store.update({ input: { backend: 'ydotool' } });
  store.update({ input: { backend: 'ydotool' } });         // the same again: nothing happened
  assert.deepStrictEqual(seen, [['auto', 'ydotool']]);
  store.flush();
  assert.strictEqual(new SettingsStore(file).get().input.backend, 'ydotool');
});

// ------------------------------------------------------------------ persistence

test('missing file -> defaults, no issue reported', () => {
  const { store } = make(tmpFile());
  assert.deepStrictEqual(store.get(), DEFAULTS);
  assert.strictEqual(store.loadIssue, null);
});

test('ROUND TRIP ON REAL DISK: what you save is what the next launch loads', () => {
  const file = tmpFile();
  const a = make(file);
  a.store.update({ dock: { edge: 'right', along: 0.8125 } });
  assert.strictEqual(a.store.flush(), true);
  const b = make(file);
  assert.strictEqual(b.store.get().dock.edge, 'right');
  assert.strictEqual(b.store.get().dock.along, 0.8125);
});

test('debounce: a burst of updates (dragging) causes ONE write, not one per update', () => {
  const file = tmpFile();
  let writes = 0;
  const countingFs = { ...fs, writeFileSync: (...a) => { writes++; return fs.writeFileSync(...a); } };
  const { store, t } = make(file, { fsImpl: countingFs });
  for (let i = 0; i < 60; i++) store.update({ dock: { along: i / 60 } });
  assert.strictEqual(writes, 0, 'nothing written mid-drag');
  assert.strictEqual(t.pending(), 1, 'exactly one pending save');
  t.fire();
  assert.strictEqual(writes, 1);
  assert.ok(Math.abs(JSON.parse(fs.readFileSync(file, 'utf8')).dock.along - 59 / 60) < 1e-9, 'the LAST position won');
});

test('flush() on quit writes a pending change immediately, and is a no-op when clean', () => {
  const file = tmpFile();
  const { store, t } = make(file);
  store.update({ dock: { edge: 'bottom' } });
  assert.strictEqual(store.flush(), true);
  assert.strictEqual(t.pending(), 0, 'pending timer cancelled');
  assert.strictEqual(store.flush(), false, 'nothing dirty -> nothing written');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).dock.edge, 'bottom');
});

test('an update that changes nothing does not emit, mark dirty, or schedule a write', () => {
  const { store, t } = make(tmpFile());
  let events = 0; store.on('change', () => events++);
  store.update({ dock: { edge: 'top', along: 0.5 } });   // identical to defaults
  store.update({ dock: { edge: 'bogus' } });             // sanitizes back to the same value
  assert.strictEqual(events, 0);
  assert.strictEqual(t.pending(), 0);
});

test("'change' fires with (next, prev) so listeners can react to exactly what moved", () => {
  const { store } = make(tmpFile());
  const seen = [];
  store.on('change', (next, prev) => seen.push([prev.dock.edge, next.dock.edge]));
  store.update({ dock: { edge: 'left' } });
  assert.deepStrictEqual(seen, [['top', 'left']]);
});

test('get() returns a copy: mutating it cannot corrupt the store', () => {
  const { store } = make(tmpFile());
  const g = store.get(); g.dock.edge = 'left'; g.safety.allowDangerousKeys = true;
  assert.strictEqual(store.get().dock.edge, 'top');
  assert.strictEqual(store.get().safety.allowDangerousKeys, false);
});

test('reset() restores defaults', () => {
  const { store } = make(tmpFile());
  store.update({ dock: { edge: 'left', along: 0.1 }, safety: { allowDangerousKeys: true } });
  store.reset();
  assert.deepStrictEqual(store.get(), DEFAULTS);
});

// ------------------------------------------------------------------ crash safety

test('CORRUPT FILE: moved aside (not deleted), defaults used, and the issue is reported', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ "dock": { "edge": "left", ');   // truncated JSON, e.g. a crash mid-write
  const { store } = make(file, { now: () => 12345 });
  assert.deepStrictEqual(store.get(), DEFAULTS);
  assert.match(store.loadIssue, /unreadable.*settings\.json\.corrupt-12345/);
  assert.strictEqual(fs.readFileSync(`${file}.corrupt-12345`, 'utf8'), '{ "dock": { "edge": "left", ', 'the user data is preserved');
  assert.strictEqual(fs.existsSync(file), false, 'the bad file no longer blocks the next save');
});

test('after recovering from a corrupt file, the next save works normally', () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'not json at all');
  const { store } = make(file);
  store.update({ dock: { edge: 'right' } }); store.flush();
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).dock.edge, 'right');
});

test('a file that parses but holds junk is sanitized, not treated as corrupt', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ dock: { edge: 'sideways', along: 3 }, agent: { maxSteps: 5 } }));
  const { store } = make(file);
  assert.strictEqual(store.loadIssue, null);
  assert.strictEqual(store.get().dock.edge, 'top');
  assert.strictEqual(store.get().dock.along, 1);
  assert.strictEqual(store.get().agent.maxSteps, 5);
});

test('ATOMIC WRITE: a failure while writing leaves the ORIGINAL file untouched and no temp file behind', () => {
  const file = tmpFile();
  const good = make(file); good.store.update({ dock: { edge: 'left' } }); good.store.flush();
  const before = fs.readFileSync(file, 'utf8');

  const brokenFs = { ...fs, writeFileSync: (p, d) => { fs.writeFileSync(p, String(d).slice(0, 10)); throw new Error('disk full'); } };
  const { store } = make(file, { fsImpl: brokenFs });
  let err = null; store.on('save-error', (e) => { err = e; });
  store.update({ dock: { edge: 'right' } });
  assert.strictEqual(store.flush(), false);
  assert.match(err.message, /disk full/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'original untouched');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.tmp-')), [], 'temp file cleaned up');
});

test('a failed save keeps the change dirty so a later flush retries it', () => {
  const file = tmpFile();
  let fail = true;
  const flaky = { ...fs, renameSync: (...a) => { if (fail) throw new Error('EBUSY'); return fs.renameSync(...a); } };
  const { store } = make(file, { fsImpl: flaky });
  store.on('save-error', () => {});
  store.update({ dock: { edge: 'bottom' } });
  assert.strictEqual(store.flush(), false);
  fail = false;
  assert.strictEqual(store.flush(), true);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).dock.edge, 'bottom');
});

test('an unreadable-but-present file (permissions) is reported rather than silently ignored', () => {
  const file = tmpFile();
  const eacces = { ...fs, readFileSync: () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; } };
  const { store } = make(file, { fsImpl: eacces });
  assert.match(store.loadIssue, /Could not read settings/);
  assert.deepStrictEqual(store.get(), DEFAULTS);
});

// ---------------------------------------------------------------- first run

test('firstRun: no settings file yet means the very first run', () => {
  const store = new SettingsStore(tmpFile());
  assert.strictEqual(store.firstRun, true);
});

test('firstRun: false once there is a file to read, however little it holds', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{}');
  assert.strictEqual(new SettingsStore(file).firstRun, false);
  const saved = new SettingsStore(tmpFile());
  saved.update({ dock: { edge: 'left' } }); saved.flush();
  assert.strictEqual(new SettingsStore(saved.file).firstRun, false, 'a store that saved something is not new the next time');
});

test('firstRun: a file that cannot be understood is reset, which makes it a fresh start', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ not json');
  const store = new SettingsStore(file);
  assert.strictEqual(store.firstRun, true);
  assert.ok(store.loadIssue, 'and the person is told about it');
});

test('firstRun: a file that exists but cannot be READ is NOT a first run - the choices may be in it', () => {
  const file = tmpFile();
  const fsImpl = { ...fs, readFileSync: () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; } };
  const store = new SettingsStore(file, { fsImpl });
  assert.strictEqual(store.firstRun, false);
  assert.ok(store.loadIssue);
});

// ---- the sections the workspace window uses: history, speech, code ----------------------------------------------------
test('history, speech and code have safe defaults and survive a round trip', () => {
  const { sanitize, DEFAULTS } = require('../src/main/settings');
  const s = sanitize({});
  assert.strictEqual(s.history.enabled, true);
  assert.strictEqual(s.speech.speakReplies, false, 'ALLES never talks until asked to');
  assert.strictEqual(s.code.autonomy, 'ask', 'the coding area asks before every change until told otherwise');
  assert.deepStrictEqual(sanitize(s), s, 'sanitizing twice changes nothing');
  assert.deepStrictEqual(s.speech, DEFAULTS.speech);
});

test('speech and code settings: every bad value falls back on its own, good ones are kept', () => {
  const { sanitize } = require('../src/main/settings');
  const s = sanitize({
    speech: { speakReplies: 'yes', ttsEngine: 'rm -rf', ttsVoice: 'en-us+f3', ttsRate: 9, piperModel: '/m/a.onnx\nx', sttEngine: 'http',
      whisperBinary: 'whisper-cli', whisperModel: '/m/ggml.bin', sttRoute: 'custom-1', sttModel: 'whisper-large-v3', language: 'hi' },
    code: { autonomy: 'yolo', maxSteps: 5000, lastProject: '/home/me/proj' },
    history: { enabled: false },
  });
  assert.strictEqual(s.speech.speakReplies, false);
  assert.strictEqual(s.speech.ttsEngine, 'auto');
  assert.strictEqual(s.speech.ttsVoice, 'en-us+f3');
  assert.strictEqual(s.speech.ttsRate, 2, 'a rate is clamped, not dropped');
  assert.strictEqual(s.speech.piperModel, '', 'a path with a line break is refused');
  assert.strictEqual(s.speech.sttEngine, 'http');
  assert.strictEqual(s.speech.whisperBinary, 'whisper-cli');
  assert.strictEqual(s.speech.whisperModel, '/m/ggml.bin');
  assert.strictEqual(s.speech.sttRoute, 'custom-1');
  assert.strictEqual(s.speech.sttModel, 'whisper-large-v3');
  assert.strictEqual(s.speech.language, 'hi');
  assert.strictEqual(s.code.autonomy, 'ask');
  assert.strictEqual(s.code.maxSteps, 200);
  assert.strictEqual(s.code.lastProject, '/home/me/proj');
  assert.strictEqual(s.history.enabled, false);
  const bad = sanitize({ speech: { ttsVoice: 'a;b|c', sttRoute: '../x', sttModel: 'a b', language: 'en us' } });
  assert.strictEqual(bad.speech.ttsVoice, ''); assert.strictEqual(bad.speech.sttRoute, '');
  assert.strictEqual(bad.speech.sttModel, 'whisper-1'); assert.strictEqual(bad.speech.language, '');
});

test('a settings patch can change the new sections without touching the others', () => {
  const { applyPatch, sanitize } = require('../src/main/settings');
  const base = sanitize({});
  const next = applyPatch(base, { code: { autonomy: 'edits' }, speech: { speakReplies: true } });
  assert.strictEqual(next.code.autonomy, 'edits'); assert.strictEqual(next.code.maxSteps, 60);
  assert.strictEqual(next.speech.speakReplies, true); assert.strictEqual(next.speech.ttsEngine, 'auto');
  assert.deepStrictEqual(next.dock, base.dock);
});
