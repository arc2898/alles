'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { installLifecycle } = require('../src/main/lifecycle');

function fakeApp() { const a = new EventEmitter(); a.quitCalls = 0; a.quit = () => { a.quitCalls++; }; return a; }

test('registers a window-all-closed listener (Electron only stays alive if one exists)', () => {
  const app = fakeApp();
  installLifecycle(app);
  assert.ok(app.listenerCount('window-all-closed') >= 1);
});

test('closing the last window does NOT quit the app', () => {
  const app = fakeApp();
  installLifecycle(app);
  app.emit('window-all-closed');
  assert.strictEqual(app.quitCalls, 0);
});

test('explicit quit() does quit, and marks the app as quitting', () => {
  const app = fakeApp();
  const lc = installLifecycle(app);
  assert.strictEqual(lc.state.quitting, false);
  lc.quit();
  assert.strictEqual(app.quitCalls, 1);
  assert.strictEqual(lc.state.quitting, true);
});

test('an externally triggered quit (before-quit, e.g. logout) is also recorded', () => {
  const app = fakeApp();
  const lc = installLifecycle(app);
  app.emit('before-quit');
  assert.strictEqual(lc.state.quitting, true);
});
