'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadPreload } = require('./helpers/preload-vm');

const sendOnce = (name, payload) => { const p = loadPreload(); p.api.send(name, payload); return p.sent; };
const sendRaw = (name, payload) => { const p = loadPreload(); p.api.send(name, payload); return p.rawSent; };

test('the REAL preload runs, exposes window.pill, and requires nothing but electron', () => {
  const { api, exposedAs } = loadPreload();
  assert.strictEqual(exposedAs, 'pill');
  assert.deepStrictEqual(Object.keys(api).sort(), ['onApproval', 'onConfig', 'onDrag', 'onPhase', 'onStatus', 'send']);
});

test('HOSTILE NAMES: inherited object keys and non-strings are dropped (an object-literal whitelist would let these through)', () => {
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', 'pill:event', '', ' click', 'click ', null, undefined, 5, {}, ['click'], Symbol.iterator]) {
    assert.deepStrictEqual(sendOnce(name, { x: 1, y: 1 }), [], `"${String(name)}" got through`);
  }
});

test('no-payload events forward the name only - anything the page adds is discarded', () => {
  for (const name of ['pointer-enter', 'pointer-leave', 'click', 'dismiss', 'blurred', 'drag-start', 'drag-move', 'drag-end', 'drag-cancel', 'open-settings', 'stop-agent', 'quit-app']) {
    assert.deepStrictEqual(sendOnce(name, { evil: 'payload' }), [['pill:event', name]], name);
  }
});

test('DRAG events carry NO coordinates: the page cannot steer the pill, main reads the pointer itself', () => {
  for (const name of ['drag-start', 'drag-move']) {
    for (const given of [{ x: 1.5, y: -2 }, { x: 5e9, y: NaN }, [1, 2], 'x', 5, null]) assert.deepStrictEqual(sendOnce(name, given), [['pill:event', name]], `${name} with ${JSON.stringify(given)}`);
  }
});

test('TEXT: a non-empty string up to 4000 characters; nothing else', () => {
  assert.strictEqual(sendOnce('submit-task', 'hello').length, 1);
  assert.strictEqual(sendOnce('submit-task', 'x'.repeat(4000)).length, 1);
  for (const bad of ['', 'x'.repeat(4001), null, undefined, 5, {}, ['a'], true]) assert.deepStrictEqual(sendOnce('submit-task', bad), [], String(bad).slice(0, 20));
});

test('ANSWER: {id, allow:boolean} with a safe id; extra fields stripped; "truthy" answers rejected', () => {
  assert.deepStrictEqual(sendOnce('approval-answer', { id: 'a1B2_-x', allow: false, extra: 1 }), [['pill:event', 'approval-answer', { id: 'a1B2_-x', allow: false }]]);
  for (const bad of [{ id: 'abc', allow: 'true' }, { id: 'abc', allow: 1 }, { id: 'abc' }, { allow: true }, { id: '', allow: true }, { id: 'a'.repeat(65), allow: true }, { id: '../x', allow: true }, { id: 'a b', allow: true }, { id: 5, allow: true }, null, 'yes', true]) {
    assert.deepStrictEqual(sendOnce('approval-answer', bad), [], JSON.stringify(bad));
  }
});

test('NUMBER and FLAG', () => {
  assert.strictEqual(sendOnce('island-height', 0).length, 1); assert.strictEqual(sendOnce('island-height', -5.5).length, 1);
  for (const bad of [NaN, Infinity, -Infinity, '200', null, undefined, 100001, {}]) assert.deepStrictEqual(sendOnce('island-height', bad), [], String(bad));
  assert.strictEqual(sendOnce('engaged', true).length, 1); assert.strictEqual(sendOnce('engaged', false).length, 1);
  for (const bad of [1, 0, 'true', null, undefined, {}]) assert.deepStrictEqual(sendOnce('engaged', bad), [], String(bad));
});

test('LISTENERS: main -> page callbacks receive the payload only (never the IPC event object), and a non-function is ignored', () => {
  const { api, listeners } = loadPreload();
  const got = []; api.onApproval((p) => got.push(p)); api.onStatus((p) => got.push(p)); api.onPhase('not a function'); api.onDrag(null);
  assert.deepStrictEqual(Object.keys(listeners).sort(), ['pill:approval', 'pill:status']);
  listeners['pill:approval'][0]({ senderId: 1, secret: 'ipc-event-object' }, { id: 'q1' });
  listeners['pill:status'][0]({ senderId: 1 }, { state: 'acting' });
  assert.deepStrictEqual(got, [{ id: 'q1' }, { state: 'acting' }], 'the raw IPC event must never reach page code');
});

test('SAFE: what reaches main is REBUILT from plain values, so prototype tricks on the input do not survive', () => {
  const sneaky = Object.create({ id: 'abc', allow: true, extra: 'inherited' });      // fields only via the prototype
  const raw = sendRaw('approval-answer', sneaky);
  assert.strictEqual(raw.length, 1, 'readable through the prototype, so accepted...');
  const payload = raw[0][2];
  assert.deepStrictEqual(Object.keys(payload).sort(), ['allow', 'id']);
  assert.strictEqual(Object.getPrototypeOf(Object.getPrototypeOf(payload)), null, '...but the copy is a plain object: its prototype is Object.prototype, whose prototype is null');
  assert.ok(!('extra' in payload));
});
