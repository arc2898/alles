'use strict';

/**
 * Line diff for the coding area: what a change did to a file, as the familiar "-old / +new" text with a little context.
 * Pure. The common start and end of the two texts are set aside first, so the usual small edit in a big file costs nothing;
 * what is left in the middle is compared with a longest-common-subsequence table, which is refused (and said so) above
 * MAX_CELLS so a huge rewrite can never freeze the app.
 */

const MAX_CELLS = 4_000_000;
const CONTEXT = 3;

const lines = (t) => { const s = String(t == null ? '' : t); if (!s) return []; const a = s.split('\n'); if (a[a.length - 1] === '') a.pop(); return a; };

/** @returns {{ops:Array<[' '|'+'|'-', string]>, tooBig:boolean}} */
function diffLines(before, after) {
  const a = lines(before); const b = lines(after);
  let head = 0; while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0; while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ma = a.slice(head, a.length - tail); const mb = b.slice(head, b.length - tail);
  const ops = a.slice(0, head).map((l) => [' ', l]);
  if (ma.length * mb.length > MAX_CELLS) {
    return { ops: [...ops, ...ma.map((l) => ['-', l]), ...mb.map((l) => ['+', l]), ...a.slice(a.length - tail).map((l) => [' ', l])], tooBig: true };
  }
  const n = ma.length; const m = mb.length;
  const w = m + 1; const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i * w + j] = ma[i] === mb[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (ma[i] === mb[j]) { ops.push([' ', ma[i]]); i++; j++; }
    else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) ops.push(['-', ma[i++]]);
    else ops.push(['+', mb[j++]]);
  }
  while (i < n) ops.push(['-', ma[i++]]);
  while (j < m) ops.push(['+', mb[j++]]);
  for (const l of a.slice(a.length - tail)) ops.push([' ', l]);
  return { ops, tooBig: false };
}

/** Counts of added and removed lines. */
function stat(before, after) {
  const { ops } = diffLines(before, after);
  let added = 0; let removed = 0;
  for (const [k] of ops) { if (k === '+') added++; else if (k === '-') removed++; }
  return { added, removed };
}

/** The change as text: "@@ -start,count +start,count @@" hunks with CONTEXT unchanged lines around each change. */
function unified(before, after, { maxLines = 600 } = {}) {
  const { ops, tooBig } = diffLines(before, after);
  const changed = ops.map(([k]) => k !== ' ');
  if (!changed.some(Boolean)) return '(no changes)';
  const keep = new Array(ops.length).fill(false);
  changed.forEach((c, i) => { if (c) for (let k = Math.max(0, i - CONTEXT); k <= Math.min(ops.length - 1, i + CONTEXT); k++) keep[k] = true; });
  const out = []; let aLine = 1; let bLine = 1; let i = 0;
  while (i < ops.length) {
    if (!keep[i]) { if (ops[i][0] !== '+') aLine++; if (ops[i][0] !== '-') bLine++; i++; continue; }
    let j = i; const body = []; const startA = aLine; const startB = bLine; let ca = 0; let cb = 0;
    while (j < ops.length && keep[j]) {
      const [k, text] = ops[j];
      body.push(`${k}${text}`);
      if (k !== '+') { aLine++; ca++; } if (k !== '-') { bLine++; cb++; }
      j++;
    }
    out.push(`@@ -${startA},${ca} +${startB},${cb} @@`, ...body);
    i = j;
  }
  let text = out.length > maxLines ? `${out.slice(0, maxLines).join('\n')}\n… (${out.length - maxLines} more lines)` : out.join('\n');
  if (tooBig) text = `(a very large change: shown as everything removed, then everything added)\n${text}`;
  return text;
}

module.exports = { diffLines, stat, unified, MAX_CELLS };
