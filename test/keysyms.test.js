'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { CHARACTER_KEYS, keysymForKey, isPlainAscii } = require('../src/main/computer/keysyms');
const { codes } = require('../src/main/computer/keymap');
const { parseCombo } = require('../src/main/computer/input');

test('letters and digits: the keysym is the character code', () => {
  for (const c of 'abcdefghijklmnopqrstuvwxyz0123456789') assert.strictEqual(keysymForKey(c), c.charCodeAt(0), c);
});

test('punctuation keys give the character they make WITHOUT Shift', () => {
  const expected = { space: ' ', minus: '-', equal: '=', leftbrace: '[', rightbrace: ']', semicolon: ';', apostrophe: "'", grave: '`', backslash: '\\', comma: ',', dot: '.', slash: '/' };
  assert.deepStrictEqual(Object.keys(CHARACTER_KEYS).sort(), Object.keys(expected).sort());
  for (const [name, ch] of Object.entries(expected)) assert.strictEqual(keysymForKey(name), ch.charCodeAt(0), name);
});

test('every punctuation name is a real key name, so a shortcut can actually say it', () => {
  for (const name of Object.keys(CHARACTER_KEYS)) assert.ok(name in codes, `${name} is in the key table`);
  assert.deepStrictEqual(parseCombo('ctrl+slash').map((k) => k.canon), ['leftctrl', 'slash']);
});

test('keys that make no character go by position (null): modifiers, Enter, arrows, F-keys, editing keys, media keys', () => {
  for (const k of ['enter', 'tab', 'leftctrl', 'rightalt', 'leftshift', 'leftmeta', 'esc', 'f1', 'f12', 'up', 'down', 'home', 'pageup', 'backspace', 'delete', 'capslock', 'kp1', 'volumeup', 'sysrq', 'dollar', 'euro']) {
    assert.strictEqual(keysymForKey(k), null, k);
  }
});

test('anything that is not a key name is null, including names an object would inherit', () => {
  for (const bad of [undefined, null, 5, {}, [], '', 'A', 'ab', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) assert.strictEqual(keysymForKey(bad), null, String(bad));
});

test('every single-character key name in the key table has a keysym (nothing a shortcut can say is forgotten)', () => {
  for (const name of Object.keys(codes)) if (/^[a-z0-9]$/.test(name)) assert.notStrictEqual(keysymForKey(name), null, name);
});

test('isPlainAscii: exactly the printable range 0x20..0x7e', () => {
  assert.strictEqual(isPlainAscii('\u001f'), false);
  assert.strictEqual(isPlainAscii(' '), true);
  assert.strictEqual(isPlainAscii('~'), true);
  assert.strictEqual(isPlainAscii('\u007f'), false);
  for (const ch of ['\n', '\t', '\r', '\u0000', 'é', '₹', '\u{1F600}', ' ']) assert.strictEqual(isPlainAscii(ch), false, JSON.stringify(ch));
  let n = 0; for (let c = 0; c < 0x300; c++) if (isPlainAscii(String.fromCodePoint(c))) n++;
  assert.strictEqual(n, 95);
});
