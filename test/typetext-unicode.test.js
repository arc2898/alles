'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { prepareUnicodeText, describeUnicodeRejection, prepareTypeText } = require('../src/main/computer/typetext');

const U = prepareUnicodeText;

test('plain text, newlines and tabs pass untouched, with no notes', () => {
  const r = U('Hello, World!\n\tIndented ~ ` ^ | \\ end');
  assert.strictEqual(r.text, 'Hello, World!\n\tIndented ~ ` ^ | \\ end');
  assert.deepStrictEqual([r.rejected, r.notes, r.replaced, r.removed], [[], [], [], 0]);
});

test('any script, accents, symbols and emoji pass unchanged: nothing is converted (unlike the plain-keyboard version)', () => {
  const s = 'café naïve ß ñ € ₹ ж 日本語 ไทย مرحبا \u{1F600} \u{1F468}‍\u{1F469}‍\u{1F467}';
  const r = U(s);
  assert.strictEqual(r.text, s);
  assert.deepStrictEqual(r.rejected, []);
});

test('curly quotes, dashes and ellipses are NOT converted here: the model meant them, and they can be entered', () => {
  const s = '“hi” — it’s…';
  assert.strictEqual(U(s).text, s);
  assert.notStrictEqual(prepareTypeText(s).text, s, 'whereas the plain version converts them');
});

test('zero-width characters are KEPT: emoji sequences and several scripts depend on them', () => {
  const s = 'a​b⁠c﻿d‌e‍f';
  const r = U(s);
  assert.strictEqual(r.text, s);
  assert.strictEqual(r.removed, 0);
});

test('CRLF and lone CR become LF, silently', () => {
  assert.strictEqual(U('a\r\nb\rc').text, 'a\nb\nc');
});

test('control characters are rejected and named: ESC, NUL, BEL, DEL and the C1 range', () => {
  const r = U('a\u001bb\u0000c\u0007d\u007fe\u0085f\u009fg');
  assert.strictEqual(r.text, 'abcdefg');
  assert.deepStrictEqual(r.rejected.map((x) => x.ch.codePointAt(0)).sort((a, b) => a - b), [0, 7, 0x1b, 0x7f, 0x85, 0x9f]);
  const msg = describeUnicodeRejection(r.rejected);
  assert.match(msg, /control character U\+001B/);
  assert.match(msg, /control character U\+007F/);
  assert.match(msg, /control character U\+0085/);
  assert.match(msg, /Nothing was typed/);
});

test('boundaries: the last control character below space and the first printable are told apart; no-break space is text', () => {
  assert.deepStrictEqual(U('\u001f').rejected.map((x) => x.ch), ['\u001f']);
  assert.strictEqual(U(' ').text, ' ');
  assert.deepStrictEqual(U('\u009f').rejected.length, 1);
  assert.strictEqual(U(' ').text, ' ', 'U+00A0 is just above the C1 range and is real text');
  assert.strictEqual(U('\n\t').text, '\n\t');
});

test('the control range is exact at both ends, in the check AND in the wording of the message', () => {
  const kept = (c) => U(String.fromCharCode(c)).rejected.length === 0;
  for (const c of [0x20, 0x7e, 0xa0, 0xa1, 0xad]) assert.ok(kept(c), `U+${c.toString(16)} is text`);
  for (const c of [0x1f, 0x7f, 0x80, 0x9e, 0x9f]) assert.ok(!kept(c), `U+${c.toString(16)} is a control character`);
  const said = (c) => describeUnicodeRejection(U(String.fromCharCode(c)).rejected);
  for (const c of [0x1f, 0x7f, 0x80, 0x9e, 0x9f]) assert.match(said(c), new RegExp(`control character U\\+${c.toString(16).toUpperCase().padStart(4, '0')}`));
  // the plain-keyboard message names characters by the same rule (it can be handed a character the checks never let through)
  const { describeRejection } = require('../src/main/computer/typetext');
  const plain = (c) => describeRejection([{ ch: String.fromCharCode(c), count: 1 }]);
  for (const c of [0x1f, 0x7f, 0x80, 0x9f]) assert.match(plain(c), /control character U\+/, `U+${c.toString(16)}`);
  for (const c of [0x20, 0x7e, 0xa0, 0xa1]) assert.doesNotMatch(plain(c), /control character/, `U+${c.toString(16)}`);
  assert.match(plain(0xa0), /" " \(U\+00A0\)/);
});

test('a lone surrogate (broken UTF-16) is rejected, a proper pair is not', () => {
  const r = U('x\ud83dy\ude00z');
  assert.strictEqual(r.text, 'xyz');
  assert.strictEqual(r.rejected.length, 2);
  assert.match(describeUnicodeRejection(r.rejected), /broken character U\+D83D/);
  assert.match(describeUnicodeRejection(r.rejected), /broken character U\+DE00/);
  assert.strictEqual(U('\u{1F600}').text, '\u{1F600}');
  assert.strictEqual(U('😀').rejected.length, 0, 'a high and a low half together are the emoji');
});

test('repeats are counted once per KIND', () => {
  const r = U('\u001b\u001b\u001b\u0000');
  assert.deepStrictEqual(r.rejected.map((x) => [x.ch.codePointAt(0), x.count]).sort((a, b) => a[0] - b[0]), [[0, 1], [0x1b, 3]]);
});

test('the message truncates a long list, and always says nothing was typed', () => {
  const many = Array.from({ length: 9 }, (_, i) => String.fromCharCode(0x0e + i)).join('');   // nine different control characters (not tab or newline)
  const r = U(many);
  assert.strictEqual(r.rejected.length, 9);
  const msg = describeUnicodeRejection(r.rejected);
  assert.match(msg, /Cannot enter 9 kind\(s\) of character/);
  assert.match(msg, /and 4 more/);
  assert.match(msg, /Nothing was typed/);
  assert.doesNotMatch(describeUnicodeRejection(U('\u0001').rejected), /and \d+ more/);
});

test('null, undefined and numbers do not throw', () => {
  assert.strictEqual(U(null).text, '');
  assert.strictEqual(U(undefined).text, '');
  assert.strictEqual(U(12345).text, '12345');
});

test('the result has the same shape as the plain-keyboard version, so one caller handles both', () => {
  assert.deepStrictEqual(Object.keys(U('x')).sort(), Object.keys(prepareTypeText('x')).sort());
});

test('idempotent: preparing already-prepared text changes nothing', () => {
  const once = U('a\r\né\u001b\u{1F600}').text;
  assert.strictEqual(U(once).text, once);
  assert.deepStrictEqual(U(once).rejected, []);
});

test('FUZZ: over 20,000 random strings every character is either kept or reported, and kept text never holds a control character', () => {
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const alphabet = [];
  for (let c = 0; c < 0x120; c++) alphabet.push(String.fromCodePoint(c));
  alphabet.push('₹', 'ж', '日', '\u{1F600}', '​', '‍', '\ud83d', '\ude00', '\r', ' ', '﻿');
  for (let i = 0; i < 20000; i++) {
    let s = '';
    const len = rnd(12);
    for (let j = 0; j < len; j++) s += alphabet[rnd(alphabet.length)];
    const r = U(s);
    for (const ch of r.text) {
      const c = ch.codePointAt(0);
      assert.ok(!((c < 0x20 && c !== 0x0a && c !== 0x09) || (c >= 0x7f && c <= 0x9f) || (c >= 0xd800 && c <= 0xdfff)), `kept a bad character in ${JSON.stringify(s)}`);
    }
    const normalised = s.replace(/\r\n?/g, '\n');
    assert.strictEqual([...r.text].length + r.rejected.reduce((n, x) => n + x.count, 0), [...normalised].length, `every character accounted for in ${JSON.stringify(s)}`);
  }
});
