'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { prepareTypeText, describeRejection, SUBSTITUTIONS, INVISIBLE, isAllowed } = require('../src/main/computer/typetext');

const ALLOWED_ONLY = /^[\x20-\x7E\n\t]*$/;
const P = prepareTypeText;

test('every printable ASCII character, newline and tab pass through untouched, with no notes', () => {
  let all = '';
  for (let c = 0x20; c <= 0x7e; c++) all += String.fromCharCode(c);
  all += '\n\t';
  const r = P(all);
  assert.strictEqual(r.text, all);
  assert.deepStrictEqual([r.notes, r.rejected, r.replaced, r.removed], [[], [], [], 0]);
});

test('backslashes are ordinary characters here (interpretation is the client\'s job to NOT do)', () => {
  const r = P('C:\\Users\\new\\ and a\\nb and trailing\\');
  assert.strictEqual(r.text, 'C:\\Users\\new\\ and a\\nb and trailing\\');
  assert.strictEqual(r.rejected.length, 0);
});

test('CRLF and lone CR become LF, silently (it is not a content change)', () => {
  assert.strictEqual(P('a\r\nb\rc\nd').text, 'a\nb\nc\nd');
  assert.deepStrictEqual(P('a\r\nb').notes, []);
});

test('curly quotes are converted and the conversion is REPORTED', () => {
  const r = P('It\u2019s \u201Cfine\u201D');
  assert.strictEqual(r.text, 'It\'s "fine"');
  assert.strictEqual(r.notes.length, 1);
  assert.match(r.notes[0], /converted 3 typographic character/);
});

test('dashes, minus sign, ellipsis and exotic spaces map to plain ASCII', () => {
  assert.strictEqual(P('a\u2013b\u2014c\u2212d\u2011e').text, 'a-b-c-d-e');
  assert.strictEqual(P('wait\u2026').text, 'wait...');
  assert.strictEqual(P('a\u00A0b\u2009c\u202Fd\u2003e').text, 'a b c d e');
});

test('invisible characters are removed and counted', () => {
  const r = P('a\u200Bb\uFEFFc\u2060d');
  assert.strictEqual(r.text, 'abcd');
  assert.strictEqual(r.removed, 3);
  assert.match(r.notes.join(' '), /removed 3 invisible/);
});

test('REJECTION: accents, CJK and emoji are reported by character and code point, never dropped', () => {
  const r = P('caf\u00e9 \u65e5\u672c \ud83d\ude00');
  assert.deepStrictEqual(r.rejected.map((x) => x.ch), ['\u00e9', '\u65e5', '\u672c', '\ud83d\ude00']);
  assert.match(describeRejection(r.rejected), /"é" \(U\+00E9\)/);
  assert.match(describeRejection(r.rejected), /U\+1F600/);
  assert.match(describeRejection(r.rejected), /Nothing was typed/);
});

test('an emoji is ONE character (code point), not two surrogate halves', () => {
  const r = P('\ud83d\ude00');
  assert.strictEqual(r.rejected.length, 1);
  assert.strictEqual(r.rejected[0].count, 1);
});

test('a lone surrogate (invalid UTF-16) is rejected, not passed on', () => {
  assert.strictEqual(P('a\ud800b').rejected.length, 1);
});

test('control characters other than LF and TAB are rejected (ESC, NUL, BEL, DEL), and named as such', () => {
  const r = P('a\x1bb\x00c\x07d\x7f');
  assert.strictEqual(r.rejected.length, 4);
  assert.match(describeRejection(r.rejected), /control character U\+001B/);
});

test('repeats are counted once per KIND, with the count kept', () => {
  const r = P('\u00e9\u00e9\u00e9x\u00e8');
  assert.deepStrictEqual(r.rejected.map((x) => [x.ch, x.count]), [['\u00e9', 3], ['\u00e8', 1]]);
});

test('a mix keeps convertible characters converted and rejects only the genuinely untypable', () => {
  const r = P('It\u2019s caf\u00e9');
  assert.deepStrictEqual(r.rejected.map((x) => x.ch), ['\u00e9']);
  assert.ok(r.text.startsWith("It's caf"));
});

test('describeRejection truncates a long list', () => {
  const many = '\u00e0\u00e1\u00e2\u00e3\u00e4\u00e5\u00e6\u00e7';
  const msg = describeRejection(P(many).rejected);
  assert.match(msg, /8 kind\(s\)/);
  assert.match(msg, /and 3 more/);
});

test('null, undefined and numbers do not throw', () => {
  assert.strictEqual(P(null).text, '');
  assert.strictEqual(P(undefined).text, '');
  assert.strictEqual(P(12345).text, '12345');
});

test('every substitution produces only allowed ASCII (a substitution can never create a rejected character)', () => {
  for (const [from, to] of SUBSTITUTIONS) {
    assert.ok(!isAllowed(from), `${from} is already allowed, so it should not be in the table`);
    assert.match(to, ALLOWED_ONLY, `U+${from.codePointAt(0).toString(16)} maps to something untypable`);
  }
  for (const ch of INVISIBLE) assert.ok(!isAllowed(ch));
});

test('idempotent: preparing already-prepared text changes nothing and reports nothing', () => {
  const once = P('It\u2019s \u2014 ok\u2026\r\nnext');
  const twice = P(once.text);
  assert.strictEqual(twice.text, once.text);
  assert.deepStrictEqual([twice.notes, twice.rejected, twice.removed], [[], [], 0]);
});

test('FUZZ: over 20,000 random strings the output is ALWAYS typable, and every character is accounted for', () => {
  const alphabet = [
    ...'abcXYZ019 !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~', '\n', '\t', '\r', '\r\n',
    '\u2019', '\u201C', '\u2014', '\u2026', '\u00A0', '\u200B', '\uFEFF',            // convertible / invisible
    '\u00e9', '\u65e5', '\ud83d\ude00', '\ud800', '\u0301', '\u200F', '\u3000', '\x1b', '\x00', '\x7f', '\u0905',   // untypable
  ];
  let seed = 987654321; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let n = 0; n < 20000; n++) {
    const len = Math.floor(rnd() * 30);
    let s = ''; for (let i = 0; i < len; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    const r = P(s);

    assert.match(r.text, ALLOWED_ONLY, `output contains an untypable character for ${JSON.stringify(s)}`);
    for (const x of r.rejected) assert.ok(!isAllowed(x.ch) && !SUBSTITUTIONS.has(x.ch) && !INVISIBLE.has(x.ch), `wrongly rejected ${JSON.stringify(x.ch)}`);

    // conservation: every input code point ends up typed, expanded, removed or rejected - none vanish
    const norm = s.replace(/\r\n?/g, '\n');
    const ellipses = [...norm].filter((c) => c === '\u2026').length;
    const rejectedCount = r.rejected.reduce((a, x) => a + x.count, 0);
    assert.strictEqual([...norm].length, [...r.text].length - 2 * ellipses + r.removed + rejectedCount, `characters lost or invented for ${JSON.stringify(s)}`);

    const again = P(r.text);
    assert.strictEqual(again.text, r.text, 'not idempotent');
    assert.strictEqual(again.rejected.length, 0);
  }
});
