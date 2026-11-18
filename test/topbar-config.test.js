'use strict';
const test = require('node:test');
const assert = require('node:assert');
const T = require('../src/main/topbar-config');
const { sanitize, DEFAULTS } = require('../src/main/settings');

test('defaults: on, right side, CPU and memory in the bar, shelf on, nothing runs a command', () => {
  const t = T.sanitizeTopbar({});
  assert.deepStrictEqual(t, JSON.parse(JSON.stringify(T.DEFAULT_TOPBAR)));
  assert.strictEqual(t.enabled, true); assert.strictEqual(t.position, 'right');
  assert.deepStrictEqual(t.widgets.filter((w) => w.enabled && w.where !== 'menu').map((w) => w.id), ['cpu', 'memory']);
  assert.ok(!t.widgets.some((w) => w.type === 'command'), 'no command widget until the person makes one');
  assert.deepStrictEqual(T.sanitizeTopbar(t), t, 'sanitizing twice changes nothing');
});

test('colours: #rgb and #RRGGBB are accepted and normalised, everything else falls back, text/background may be empty (theme)', () => {
  const c = T.sanitizeTopbar({ colors: { ready: '#ABC', working: '#00FF00', attention: 'red', problem: 'rgb(1,2,3)', idle: '#12345', listening: 5, text: '', background: '#111' } }).colors;
  assert.strictEqual(c.ready, '#aabbcc'); assert.strictEqual(c.working, '#00ff00');
  assert.strictEqual(c.attention, T.DEFAULT_COLORS.attention); assert.strictEqual(c.problem, T.DEFAULT_COLORS.problem);
  assert.strictEqual(c.idle, T.DEFAULT_COLORS.idle); assert.strictEqual(c.listening, T.DEFAULT_COLORS.listening);
  assert.strictEqual(c.text, ''); assert.strictEqual(c.background, '#111111');
  for (const bad of ['url(javascript:1)', '#fff; background: url(x)', '#ggg', '\n#fff']) assert.strictEqual(T.cleanColor(bad, 'X'), 'X', bad);
});

test('position, order, label length, resource interval and shelf numbers are clamped; choices outside the list are refused', () => {
  const t = T.sanitizeTopbar({ position: 'bottom', floatingPill: 'sometimes', index: 99, labelMaxChars: 1, resources: { intervalSec: 0 }, shelf: { keepDays: 9999, maxShown: 1 } });
  assert.deepStrictEqual([t.position, t.floatingPill, t.index, t.labelMaxChars, t.resources.intervalSec, t.shelf.keepDays, t.shelf.maxShown], ['right', 'auto', 20, 8, 1, 365, 3]);
  assert.strictEqual(T.sanitizeTopbar({ position: 'left' }).position, 'left');
  assert.strictEqual(T.sanitizeTopbar({ resources: { intervalSec: 'fast' } }).resources.intervalSec, 2);
});

test('widgets: unknown types and non-objects are dropped, ids are made safe and unique, at most 16, an empty list stays empty', () => {
  const t = T.sanitizeTopbar({ widgets: [{ type: 'cpu' }, { type: 'cpu', id: 'cpu' }, { type: 'bogus' }, 5, null, { type: 'memory', id: '../x', where: 'nowhere', style: 'big', label: 'RAM' }] });
  assert.deepStrictEqual(t.widgets.map((w) => [w.id, w.type, w.where, w.style, w.label]), [['cpu', 'cpu', 'both', 'text', ''], ['cpu-2', 'cpu', 'both', 'text', ''], ['memory', 'memory', 'both', 'text', 'RAM']]);
  assert.strictEqual(T.sanitizeTopbar({ widgets: Array.from({ length: 40 }, (_, i) => ({ type: 'clock', id: `c${i}` })) }).widgets.length, T.MAX_WIDGETS);
  assert.deepStrictEqual(T.sanitizeTopbar({ widgets: [] }).widgets, []);
  assert.strictEqual(T.sanitizeTopbar({ widgets: 'nope' }).widgets.length, T.DEFAULT_WIDGETS.length, 'not a list: the defaults');
});

test('a command widget keeps its command (as text), clamps its timing, and no other type carries one', () => {
  const t = T.sanitizeTopbar({ widgets: [{ type: 'command', id: 'up', command: 'uptime -p', intervalSec: 1, timeoutSec: 99, label: 'Up' }, { type: 'cpu', command: 'rm -rf ~' }, { type: 'command', command: 'a\nb' }] });
  assert.deepStrictEqual(t.widgets[0], { id: 'up', type: 'command', enabled: true, where: 'both', label: 'Up', style: 'text', command: 'uptime -p', intervalSec: 5, timeoutSec: 10 });
  assert.ok(!('command' in t.widgets[1]), 'a CPU widget cannot smuggle a command');
  assert.strictEqual(t.widgets[2].command, '', 'a command with a line break is dropped');
});

test('shelf folder: an absolute path only; "/", relative paths and ".." are refused', () => {
  for (const bad of ['/', 'relative/dir', '../x', '/a/../b', '', 5, null, 'a\nb', `/${'x'.repeat(600)}`]) assert.strictEqual(T.sanitizeTopbar({ shelf: { folder: bad } }).shelf.folder, '', String(bad).slice(0, 20));
  assert.strictEqual(T.sanitizeTopbar({ shelf: { folder: '/home/me/Shelf/' } }).shelf.folder, '/home/me/Shelf');
});

test('hostile input never throws and always gives a complete section', () => {
  for (const bad of [undefined, null, 0, 'x', [], true, () => 1, { widgets: [{ type: { toString() { throw new Error('x'); } } }] }, { colors: 5 }, { shelf: [] }, { resources: 'x' }, JSON.parse('{"__proto__": {"enabled": false}}')]) {
    const t = T.sanitizeTopbar(bad);
    assert.deepStrictEqual(Object.keys(t).sort(), Object.keys(T.DEFAULT_TOPBAR).sort());
    assert.strictEqual(typeof t.enabled, 'boolean');
  }
});

test('settings: the new sections are part of the saved settings, and speech has safe wake-word defaults', () => {
  const s = sanitize({});
  assert.strictEqual(s.version, 3);
  assert.deepStrictEqual(Object.keys(s.topbar).sort(), Object.keys(T.DEFAULT_TOPBAR).sort());
  assert.strictEqual(s.speech.wakeWord, false, 'the microphone is never open for a wake word until asked');
  assert.strictEqual(s.speech.wakePhrase, 'hey alles'); assert.strictEqual(s.speech.speakPillReplies, true); assert.strictEqual(s.speech.recorder, 'auto');
  assert.deepStrictEqual(sanitize(s), s);
  assert.deepStrictEqual(Object.keys(DEFAULTS).sort(), Object.keys(s).sort());
});

test('settings: wake phrase, recorder, microphone name, threads and the vocabulary hint are checked', () => {
  const s = sanitize({ speech: { wakeWord: true, wakePhrase: '  Hey   Computer ', wakeSensitivity: 5, recorder: 'rm', micSource: 'alsa_input.pci-0000_00_1f.3.analog-stereo', whisperThreads: 99, whisperPrompt: ' ALLES, GNOME, Debian ' } }).speech;
  assert.deepStrictEqual([s.wakeWord, s.wakePhrase, s.wakeSensitivity, s.recorder, s.micSource, s.whisperThreads, s.whisperPrompt], [true, 'Hey Computer', 1, 'auto', 'alsa_input.pci-0000_00_1f.3.analog-stereo', 32, 'ALLES, GNOME, Debian']);
  for (const bad of ['', 'hi', 'a;b', 'x'.repeat(60), '123 456', 'one two three four five six', 5, null]) assert.strictEqual(sanitize({ speech: { wakePhrase: bad } }).speech.wakePhrase, 'hey alles', String(bad));
  assert.strictEqual(sanitize({ speech: { micSource: 'a b; c' } }).speech.micSource, '');
  assert.strictEqual(sanitize({ speech: { whisperPrompt: 'a\nb' } }).speech.whisperPrompt, '');
});

test('settings: a topbar patch changes the top bar and nothing else', () => {
  const { applyPatch } = require('../src/main/settings');
  const base = sanitize({});
  const next = applyPatch(base, { topbar: { position: 'left', colors: { ready: '#00ff00' } } });
  assert.strictEqual(next.topbar.position, 'left'); assert.strictEqual(next.topbar.colors.ready, '#00ff00');
  assert.deepStrictEqual(next.dock, base.dock); assert.deepStrictEqual(next.speech, base.speech);
});
