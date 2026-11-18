'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { PAGE_EVENTS, PAYLOAD_KINDS } = require('../src/main/overlay/window');
const { loadPreload } = require('./helpers/preload-vm');

// This file exists because of a real bug: main sent 'pill:phase' and the page
// sent pointer events, but the preload/renderer never connected them, so the dock
// could not reveal itself - while every mock-based unit test still passed.
// These checks read the actual source of all three layers and compare them.

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const windowSrc = read('src/main/overlay/window.js');
const preloadSrc = read('src/overlay/preload.cjs');
const pillSrc = read('src/overlay/pill.js');

const uniq = (arr) => [...new Set(arr)].sort();

// Every event name the page passes to bridge.send(...), including ternaries such as
// bridge.send(cancelled ? 'drag-cancel' : 'drag-end'), which a plain-literal regex misses.
function pageSentEvents(src) {
  const names = [];
  for (const m of src.matchAll(/bridge\.send\(([^;\n]*?)(?:,\s*\{[^}]*\})?\)\s*[;)]?/g)) {
    for (const lit of m[1].matchAll(/'([a-z-]+)'/g)) names.push(lit[1]);
  }
  return uniq(names);
}
const matchAll = (src, re) => uniq([...src.matchAll(re)].map((m) => m[1]));

test('every channel MAIN sends to the pill is listened for by the preload', () => {
  const sent = matchAll(windowSrc, /\.send\('(pill:[a-z]+)'/g);
  const listened = matchAll(preloadSrc, /listen\('(pill:[a-z]+)'\)/g);
  assert.ok(sent.length >= 3, `expected main to send several channels, found ${sent}`);
  for (const ch of sent) assert.ok(listened.includes(ch), `main sends "${ch}" but preload never listens for it`);
});

test('every listener the preload exposes is actually USED by the renderer', () => {
  const exposed = matchAll(preloadSrc, /^\s{2}(on[A-Z]\w+):/gm);
  assert.ok(exposed.length >= 3);
  for (const name of exposed) assert.match(pillSrc, new RegExp(`bridge\\.${name}\\(`), `preload exposes ${name} but pill.js never calls it`);
});

const SAMPLE = { text: 'open the calculator', answer: { id: 'abc123', allow: true }, number: 200, flag: true };

test('every event the page can SEND gets through the REAL preload and has a handler in main', () => {
  const sentByPage = pageSentEvents(pillSrc);
  assert.ok(sentByPage.length >= 8, `page should send pointer, drag, prompt and approval events; found ${sentByPage}`);
  for (const ev of sentByPage) {
    assert.ok(PAGE_EVENTS[ev], `page sends "${ev}" but main has no handler for it`);
    const pre = loadPreload();
    pre.api.send(ev, SAMPLE[PAYLOAD_KINDS[ev]]);
    assert.strictEqual(pre.sent.length, 1, `the preload dropped "${ev}"`);
  }
});

test('the reveal-critical events specifically are wired end to end', () => {
  // `click` is no longer sent by the page: a press+release is reported as drag-start/drag-end and
  // MAIN decides whether it was a click (movement under the threshold) or a drag.
  const sent = pageSentEvents(pillSrc);
  for (const ev of ['pointer-enter', 'pointer-leave', 'drag-start', 'drag-move', 'drag-end', 'drag-cancel', 'dismiss']) {
    assert.ok(sent.includes(ev), `pill.js does not send ${ev}`);
    assert.ok(PAGE_EVENTS[ev], `no main handler for ${ev}`);
  }
});

test('a press that never becomes a drag still opens the island (click semantics survive the rewrite)', () => {
  const calls = [];
  const dw = { dragEnd: () => ({ kind: 'click' }), click: () => calls.push('click'), dragCancel() {}, dismiss() {} };
  PAGE_EVENTS['drag-end'](dw);
  assert.deepStrictEqual(calls, ['click']);
  const dropped = [];
  PAGE_EVENTS['drag-end']({ dragEnd: () => ({ kind: 'drop' }), click: () => dropped.push('click') });
  assert.deepStrictEqual(dropped, [], 'a real drop must NOT also fire a click');
});


test('PARITY: the preload passes EXACTLY the events main handles - no dead entries, no unguarded ones', () => {
  const passes = (name, payload) => { const pre = loadPreload(); pre.api.send(name, payload); return pre.sent.length === 1; };
  for (const name of Object.keys(PAGE_EVENTS)) assert.ok(passes(name, SAMPLE[PAYLOAD_KINDS[name]]), `main handles "${name}" but the preload would drop it`);
  for (const bogus of ['nope', 'pill:event', 'CLICK', 'click ', 'open-settings2']) assert.ok(!passes(bogus, undefined), `the preload passed "${bogus}", which main does not handle`);
});


test('PAYLOAD KINDS: the preload attaches a payload to exactly the events main expects one for', () => {
  for (const name of Object.keys(PAGE_EVENTS)) {
    const kind = PAYLOAD_KINDS[name] || null;
    const pre = loadPreload();
    pre.api.send(name, kind ? SAMPLE[kind] : { sneaky: 'payload' });
    assert.strictEqual(pre.sent[0].length, kind ? 3 : 2, `${name}: ${kind ? 'should carry a payload' : 'must carry none'}`);
  }
});

test('the pill page does not reference APIs the preload no longer provides', () => {
  const used = matchAll(pillSrc, /bridge\.(\w+)\(/g);
  const provided = matchAll(preloadSrc, /^\s{2}(\w+):/gm);
  for (const fn of used) assert.ok(provided.includes(fn), `pill.js calls bridge.${fn}() but the preload does not expose it`);
});
