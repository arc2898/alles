'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * Run the REAL overlay/preload.cjs in a fresh VM context with a fake `electron`, and return what it exposed
 * plus everything it tried to send. This tests the file's BEHAVIOUR (hostile names, hostile payloads),
 * not its text - a regex over the source cannot tell a working whitelist from a broken one.
 */
function loadPreload(file = path.join(__dirname, '../../src/overlay/preload.cjs'), { reply = () => ({ ok: true }) } = {}) {
  const sent = []; const invoked = []; const listeners = {}; let exposed = null;
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed = { name, api }; } },
    ipcRenderer: {
      send: (...a) => sent.push(a),
      // ipcRenderer.invoke(channel, ...args) -> Promise of whatever `reply(channel, ...args)` returns (or throws, to simulate a failure)
      invoke: (...a) => { invoked.push(a); try { return Promise.resolve(reply(...a)); } catch (e) { return Promise.reject(e); } },
      on: (ch, fn) => { (listeners[ch] || (listeners[ch] = [])).push(fn); },
    },
  };
  const wrapper = new vm.Script(`(function (require) {${fs.readFileSync(file, 'utf8')}\n})`, { filename: file }).runInContext(vm.createContext({}));
  wrapper((m) => { if (m !== 'electron') throw new Error(`preload required "${m}"`); return electron; });
  if (!exposed) throw new Error('the preload exposed nothing');
  // Objects built INSIDE the VM have a different Object.prototype, so assert.deepStrictEqual calls them "not
  // reference-equal" to identical objects from the test realm. `sent` is a plain-JSON copy for comparisons;
  // `rawSent` keeps the originals for the few tests that inspect prototypes.
  const view = { get sent() { return JSON.parse(JSON.stringify(sent)); }, rawSent: sent };
  return {
    api: exposed.api, exposedAs: exposed.name, get sent() { return view.sent; }, rawSent: sent, listeners,
    get invoked() { return JSON.parse(JSON.stringify(invoked)); }, rawInvoked: invoked,
    /** Simulate main -> page: run every listener the preload registered for `channel`. */
    emit(channel, ...args) { (listeners[channel] || []).forEach((fn) => fn({}, ...args)); },
  };
}
module.exports = { loadPreload };
