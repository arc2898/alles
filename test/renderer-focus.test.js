'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// REGRESSION (found on a real GNOME desktop): clicking another application did not close the island, because the prompt box
// stayed the page's active element after its window lost the keyboard, and "box is active" meant "still typing". The rule is
// in pill-model.js (isEngaged, tested there); these pins keep the page wired to it, in the right order.
const src = fs.readFileSync(path.join(__dirname, '../src/overlay/pill.js'), 'utf8');

test('the page decides "engaged" with the tested rule, not with its own copy of it', () => {
  assert.match(src, /M\.isEngaged\(\{/);
  assert.doesNotMatch(src, /document\.activeElement === promptEl \|\| promptEl\.value\.length > 0/, 'the old inline rule is the bug');
});

test('the page tracks whether its WINDOW has the keyboard, and feeds that into the rule', () => {
  assert.match(src, /let windowFocused = document\.hasFocus\(\)/);
  assert.match(src, /windowFocused,/);
  assert.match(src, /window\.addEventListener\('focus', \(\) => \{ windowFocused = true; syncEngaged\(\); \}\)/);
});

test('on blur the engagement is brought up to date BEFORE main is told the window was blurred (messages arrive in order)', () => {
  const m = src.match(/window\.addEventListener\('blur', \(\) => \{([^}]*)\}\);/);
  assert.ok(m, 'no window blur handler');
  const body = m[1];
  const iSync = body.indexOf('syncEngaged()'); const iSend = body.indexOf("bridge.send('blurred')");
  assert.ok(body.includes('windowFocused = false'), 'the handler must record the loss');
  assert.ok(iSync >= 0 && iSend >= 0 && iSync < iSend, `syncEngaged() must come before the blurred message: ${body.trim()}`);
});

test('"blurred" is only sent from the open island (the strip and the peek never had the keyboard)', () => {
  assert.match(src, /if \(phase === 'island'\) bridge\.send\('blurred'\)/);
});
