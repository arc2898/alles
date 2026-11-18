'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { diffLines, stat, unified, MAX_CELLS } = require('../src/main/code/diff');

const apply = (ops) => ({ before: ops.filter(([k]) => k !== '+').map(([, l]) => l), after: ops.filter(([k]) => k !== '-').map(([, l]) => l) });

test('diffLines: the ops rebuild both texts exactly', () => {
  const cases = [['a\nb\nc\n', 'a\nB\nc\n'], ['', 'x\ny\n'], ['x\ny\n', ''], ['same\n', 'same\n'], ['1\n2\n3\n4\n5\n', '2\n3\n9\n5\n6\n'], ['a', 'a\n'], ['no newline', 'no newline too']];
  for (const [b, a] of cases) {
    const { ops } = diffLines(b, a);
    const r = apply(ops);
    assert.deepStrictEqual(r.before, b.split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l === '')), JSON.stringify([b, a]));
    assert.deepStrictEqual(r.after, a.split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l === '')));
  }
});

test('stat counts what changed', () => {
  assert.deepStrictEqual(stat('a\nb\nc\n', 'a\nB\nc\nd\n'), { added: 2, removed: 1 });
  assert.deepStrictEqual(stat('', 'x\ny\n'), { added: 2, removed: 0 });
  assert.deepStrictEqual(stat('x\n', ''), { added: 0, removed: 1 });
  assert.deepStrictEqual(stat('same', 'same'), { added: 0, removed: 0 });
});

test('unified: hunks with context, line numbers that match', () => {
  const before = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
  const after = before.replace('line10\n', 'TEN\n');
  const text = unified(before, after);
  assert.strictEqual(text, ['@@ -7,7 +7,7 @@', ' line7', ' line8', ' line9', '-line10', '+TEN', ' line11', ' line12', ' line13'].join('\n'));
  assert.strictEqual(unified('a\n', 'a\n'), '(no changes)');
});

test('unified: two far-apart changes are two hunks', () => {
  const before = Array.from({ length: 40 }, (_, i) => `l${i + 1}`).join('\n') + '\n';
  const after = before.replace('l3\n', 'X\n').replace('l38\n', 'Y\n');
  assert.strictEqual(unified(before, after).split('\n').filter((l) => l.startsWith('@@')).length, 2);
});

test('a new file shows as all added; a deleted file as all removed', () => {
  assert.strictEqual(unified('', 'a\nb\n'), '@@ -1,0 +1,2 @@\n+a\n+b');
  assert.strictEqual(unified('a\nb\n', ''), '@@ -1,2 +1,0 @@\n-a\n-b');
});

test('a huge rewrite is not compared line by line (it would freeze), and says so', () => {
  const n = Math.ceil(Math.sqrt(MAX_CELLS)) + 50;
  const before = Array.from({ length: n }, (_, i) => `a${i}`).join('\n');
  const after = Array.from({ length: n }, (_, i) => `b${i}`).join('\n');
  const t0 = Date.now();
  const { tooBig } = diffLines(before, after);
  assert.strictEqual(tooBig, true);
  assert.ok(Date.now() - t0 < 2000);
  assert.match(unified(before, after, { maxLines: 10 }), /very large change/);
});

test('output is capped', () => {
  const before = ''; const after = Array.from({ length: 2000 }, (_, i) => `n${i}`).join('\n');
  assert.match(unified(before, after, { maxLines: 50 }), /more lines\)$/);
});
