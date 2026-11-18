'use strict';
/**
 * Preload for the pill window. contextIsolation stays ON and the renderer stays sandboxed; the page only gets
 * this narrow, explicit API. CommonJS on purpose: sandboxed preload scripts cannot use ESM.
 *
 * The tables below are the WHOLE contract between the page and the main process. main validates every payload
 * again (window.js cleanPayload) - the preload is the first gate, not the only one. test/preload-vm.test.js
 * runs THIS file with hostile input; test/bridge.test.js checks it against main.
 */
const { contextBridge, ipcRenderer } = require('electron');

// page -> main. name: payload kind, or null for "no payload". Anything not listed here is dropped.
const OUT = {
  'pointer-enter': null, 'pointer-leave': null, 'click': null, 'dismiss': null, 'blurred': null,
  'drag-start': null, 'drag-move': null, 'drag-end': null, 'drag-cancel': null,   // no coordinates: main reads the pointer itself
  // island controls: the NON-TRAY route to these actions (stock GNOME has no tray)
  'open-workspace': null, 'open-settings': null, 'stop-agent': null, 'quit-app': null,
  'submit-task': 'text', 'approval-answer': 'answer', 'island-height': 'number', 'engaged': 'flag',
};

const TEXT_MAX = 4000;
const CLEAN = {
  text: (v) => (typeof v === 'string' && v.length > 0 && v.length <= TEXT_MAX ? v : undefined),
  answer: (v) => (v && typeof v === 'object' && typeof v.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v.id) && typeof v.allow === 'boolean' ? { id: v.id, allow: v.allow } : undefined),
  number: (v) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 100000 ? v : undefined),
  flag: (v) => (typeof v === 'boolean' ? v : undefined),
};

const listen = (channel) => (cb) => {
  if (typeof cb === 'function') ipcRenderer.on(channel, (_e, payload) => cb(payload));
};

contextBridge.exposeInMainWorld('pill', {
  // main -> page
  onStatus: listen('pill:status'),
  onConfig: listen('pill:config'),
  onPhase: listen('pill:phase'),
  onDrag: listen('pill:drag'),
  onApproval: listen('pill:approval'),
  // page -> main
  send: (name, payload) => {
    // hasOwnProperty, NOT `name in OUT`: an object literal inherits 'constructor', 'toString', '__proto__'...
    if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(OUT, name)) return;
    const kind = OUT[name];
    if (kind === null) { ipcRenderer.send('pill:event', name); return; }      // extra arguments are ignored
    const clean = CLEAN[kind](payload);
    if (clean === undefined) return;
    ipcRenderer.send('pill:event', name, clean);
  },
});
