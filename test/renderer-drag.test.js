'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// REGRESSION: the drag froze after ~100px in real Electron because pointermove/up were listened
// for on the pill <body>. Pointer capture was never granted (no gotpointercapture event fires),
// so once the pointer left the pill's box those events stopped arriving. The unit tests for the
// drag maths all passed while the feature was broken; only a real-Electron run showed it.
// These checks pin the structural fix so it cannot silently regress.
const src = fs.readFileSync(path.join(__dirname, '../src/overlay/pill.js'), 'utf8');

test('drag-move is listened for on WINDOW (capture phase), not on the pill body', () => {
  assert.match(src, /window\.addEventListener\('pointermove',[\s\S]*?drag-move[\s\S]*?\}, true\)/);
  assert.doesNotMatch(src, /body\.addEventListener\('pointermove'/, 'a body-level pointermove handler is the bug');
});

test('release and cancel are listened for on WINDOW too, so a drag that ends outside the pill still ends', () => {
  assert.match(src, /window\.addEventListener\('pointerup'/);
  assert.match(src, /window\.addEventListener\('pointercancel'/);
  assert.doesNotMatch(src, /body\.addEventListener\('pointerup'/);
});

test('a drag is NOT ended by lostpointercapture (capture is never granted, so it is not a reliable signal)', () => {
  assert.doesNotMatch(src, /addEventListener\('lostpointercapture'/);
});

test('the pressed pointer id gates move/up, so a second pointer cannot hijack or end a drag', () => {
  assert.match(src, /e\.pointerId !== pressedId/);
});

test('press is left-button only (a right-click must never start a drag)', () => {
  assert.match(src, /e\.button !== 0\) return/);
});

test('the page sends NO coordinates with its drag events (they are relative to a window that moves under the pointer; main reads the pointer itself)', () => {
  assert.doesNotMatch(src, /bridge\.send\('drag-(start|move)',/);
  assert.match(src, /bridge\.send\('drag-start'\)/);
  assert.match(src, /bridge\.send\('drag-move'\)/);
});
