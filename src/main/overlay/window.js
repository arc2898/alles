'use strict';

const path = require('node:path');
const { Dock, dockRect, bulgeDirection, resolvePlacement, edgeInsets, CONFIG } = require('./dock');
const { DragController } = require('./drag-controller');

/**
 * DockWindow - glue between the pure Dock and a real BrowserWindow.
 *
 * Electron is injected (`electron` param) so the wiring is testable with fakes.
 * Nothing here decides WHEN to show/hide; that is the Dock's job. This class
 * only turns a phase into a window rectangle and forwards events.
 *
 * WAYLAND NOTE: a compositor may ignore programmatic setBounds/setPosition for
 * a normal toplevel window (Wayland has no client-side positioning). We apply
 * bounds anyway, then READ THEM BACK; if the compositor placed the window
 * elsewhere we report it (`onPlacementMismatch`) instead of pretending it worked.
 */

// Padding around the island body for the droplets / goo blur (see layout.js).
const PAD = 20;

// Most the island may grow beyond its base height, and the longest task text accepted from the page.
// TEXT_MAX must equal runner.MAX_TASK_CHARS (a test enforces it).
const MAX_EXTRA = 320;
const TEXT_MAX = 4000;
const WORKING = new Set(['thinking', 'acting', 'waiting']);
const clampNum = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

class DockWindow {
  /**
   * @param {object} o
   * @param {object} o.electron   { BrowserWindow, screen }
   * @param {()=>{edge:string, along:number, display?:string}} o.getPrefs
   * @param {()=>boolean} o.isBusy
   * @param {(info:object)=>void} [o.onPlacementMismatch]
   */
  constructor({ electron, getPrefs, isBusy = () => false, onPlacementMismatch = () => {}, onPlacementChange = () => {}, onAction = () => {}, now = Date.now, preload = path.join(__dirname, '../../overlay/preload.cjs'), html = path.join(__dirname, '../../overlay/pill.html') }) {
    this.electron = electron;
    this.getPrefs = getPrefs;
    this.onPlacementMismatch = onPlacementMismatch;
    // Called with { edge, along, display } when the user DROPS the pill somewhere. The
    // owner persists it (settings store) and then calls refreshPlacement() via the
    // store's 'change' event, so this class never writes settings itself.
    this.onPlacementChange = onPlacementChange;
    // Called with 'open-settings' | 'stop-agent' | 'quit' when the user presses an island button.
    this.onAction = onAction;
    this.drag = new DragController({ getDisplays: () => this.electron.screen.getAllDisplays() });
    this.dragging = false;
    this.preload = preload;
    this.html = html;
    this.win = null;
    this.timer = null;
    this.lastStatus = { state: 'idle' };
    this.seq = 0;               // numbers each REAL status, so the page can tell a replay from a new event
    this.engaged = false;       // the user is typing in the prompt: the island must not hide under them
    this.extraHeight = 0;       // how much taller than the base island the content needs
    this.approval = null;       // the open approval question (or null), replayed to the page on reload
    this.dock = new Dock({
      now,
      // Default to auto-hide for incomplete/legacy test doubles; settings v2
      // explicitly defaults this to false so the collapsed pill persists.
      autoHide: () => { const p = this.getPrefs() || {}; return p.autoHide !== false; },
      // The island must stay open whenever hiding it would strand something: the user typing, an open question (a
      // question nobody can see is a hang until it times out), or the agent working. These are enforced HERE, not left
      // to whoever wires isBusy(), because forgetting one of them fails silently.
      busy: () => this.engaged || !!this.approval || WORKING.has(this.lastStatus.state) || isBusy(),
      onPhase: (phase, prev) => this._onPhase(phase, prev),
    });
  }

  /** Create the window in its initial persisted mode (visible pill or hidden hot-strip). Safe to call once. */
  create() {
    if (this.win) return this.win;
    const { BrowserWindow } = this.electron;
    const rect = this._rectFor(this.dock.phase);
    this.win = new BrowserWindow({
      ...this._windowOptions(rect),
      webPreferences: {
        preload: this.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    // Sits above normal windows but is a real, focusable-on-demand window.
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setVisibleOnAllWorkspaces(true);
    this._guardShape();
    this.win.loadFile(this.html);
    this.win.webContents.once('did-finish-load', () => this._pushState());

    // Pointer events come from the renderer (the strip is a real window, so the
    // compositor delivers them - no polling of the global cursor needed).
    this.timer = setInterval(() => { this.dock.tick(); this._checkShape(); }, 50);
    return this.win;
  }

  /**
   * The pill is a real window, so anything that shows window controls for the focused window (a top bar with a global menu, a
   * tiling extension, a keyboard shortcut) can maximize it, and it then covers the whole screen. It is never to be maximized, made
   * full screen or minimized: when the desktop does it anyway, it is undone at once and the pill goes back where it belongs.
   */
  _guardShape() {
    const win = this.win;
    if (typeof win.on !== 'function') return;
    const undo = () => {
      if (!win || win.isDestroyed()) return;
      try {
        if (typeof win.isFullScreen === 'function' && win.isFullScreen()) win.setFullScreen(false);
        if (typeof win.isMaximized === 'function' && win.isMaximized()) win.unmaximize();
        if (typeof win.isMinimized === 'function' && win.isMinimized()) { win.restore(); if (typeof win.showInactive === 'function') win.showInactive(); }
      } catch { /* the desktop refused: the bounds below still go back */ }
      this._applyBounds(this.dock.phase);
    };
    for (const ev of ['maximize', 'enter-full-screen', 'minimize']) win.on(ev, () => setTimeout(undo, 0));
    this._undoShape = undo;
  }

  /** The desktop does not always say it maximized or minimized the pill (full screen came without a word), so it is also looked at. */
  _checkShape() {
    const w = this.win;
    if (!w || w.isDestroyed() || !this._undoShape) return;
    const yes = (f) => typeof w[f] === 'function' && w[f]();
    if (yes('isMaximized') || yes('isFullScreen') || yes('isMinimized')) this._undoShape();
  }

  _windowOptions(rect) {
    return {
      ...rect,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      movable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: true,
      show: true,
      backgroundColor: '#00000000',
    };
  }

  _display() {
    const { screen } = this.electron;
    const prefs = this.getPrefs() || {};
    // A dragged-to placement is remembered per display. If that monitor is unplugged
    // we fall back rather than opening off-screen.
    if (prefs.display !== null && prefs.display !== undefined && typeof screen.getAllDisplays === 'function') {
      const saved = screen.getAllDisplays().find((d) => d.id === prefs.display);
      if (saved) return saved;
    }
    // NEVER read the cursor before our window exists. MEASURED on native Wayland (real
    // GNOME Mutter 46.2): screen.getCursorScreenPoint() BLOCKS FOREVER when the app has no
    // surface yet, because Wayland only reports the pointer to a client that has one. The
    // call raised no error - create() simply never returned and the app hung at launch.
    // So: primary display until a window exists, cursor-nearest display afterwards.
    const primary = () => {
      try { return screen.getPrimaryDisplay(); } catch (error) {
        // A transient display query failure must not prevent the assistant from
        // starting. Electron also exposes the complete display list; use its
        // first entry as a conservative fallback and let normal placement
        // verification report any compositor mismatch.
        try {
          const all = typeof screen.getAllDisplays === 'function' ? screen.getAllDisplays() : [];
          if (Array.isArray(all) && all.length) return all[0];
        } catch { /* report the original error below */ }
        throw error;
      }
    };
    if (!this.win || this.win.isDestroyed()) return primary();
    try { return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || primary(); }
    catch { return primary(); }
  }

  /** What the desktop has taken from each edge of the display the pill lives on: { top, bottom, left, right } in px. */
  edgeInsets() {
    const d = this._display();
    return edgeInsets(d.bounds, d.workArea);
  }

  /** First run: show the pill for `ms` so the person can see where it lives (it hides itself again). */
  introduce(ms) { this.dock.peekFor(ms); }

  _rectFor(phase) {
    const prefs = this.getPrefs();
    const display = this._display();
    const { edge, along } = resolvePlacement(prefs);
    return dockRect({ phase, edge, along, workArea: display.workArea, cfg: { ...CONFIG, extraHeight: phase === 'island' ? this.extraHeight : 0 } });
  }

  /** Put the window where the current phase (and content height) says it belongs, and check the compositor agreed. */
  _applyBounds(phase) {
    if (!this.win) return;
    const want = this._rectFor(phase);
    this.win.setBounds(want);
    // Wayland may refuse the move: verify instead of assuming.
    const got = this.win.getBounds();
    if (got.x !== want.x || got.y !== want.y) this.onPlacementMismatch({ phase, wanted: want, got });
  }

  _onPhase(phase) {
    if (!this.win) return;
    if (phase !== 'island') this.extraHeight = 0;        // leaving the island: the next opening starts at base height
    this._applyBounds(phase);
    this._pushState();
  }

  _pushState() {
    if (!this.win || this.win.isDestroyed()) return;
    const prefs = this.getPrefs();
    const { edge } = resolvePlacement(prefs);
    const wc = this.win.webContents;
    // inset = where the VISIBLE pill sits inside the (larger) transparent window.
    const { inset } = this._rectFor(this.dock.phase);
    wc.send('pill:phase', { phase: this.dock.phase, edge, bulge: bulgeDirection(edge), inset });
    // A REPLAY: the same status, re-sent because the phase changed. The page must not log its action again.
    wc.send('pill:status', { ...this.lastStatus, replay: true });
    wc.send('pill:approval', this.approval);
    if (prefs.hour12 !== undefined) wc.send('pill:config', { hour12: !!prefs.hour12 });
  }

  /** Agent status update (from Agent 'status' events). */
  setStatus(status) {
    this.lastStatus = { ...status, seq: ++this.seq };
    // Approval requests and finished tasks must be seen: open the island.
    if (status && (status.state === 'waiting' || status.state === 'done' || status.state === 'error')) this.dock.summon();
    this._send('pill:status', this.lastStatus);
  }

  /** Show (or clear, with null) the approval question. Opens the island: a question nobody can see is a hang. */
  showApproval(desc) {
    this.approval = desc || null;
    if (this.approval) this.dock.summon();
    this._send('pill:approval', this.approval);
  }

  /** The page reports how tall its content is; the island grows to fit (never past MAX_EXTRA). */
  setContentHeight(h) {
    if (!Number.isFinite(h)) return;
    const extra = clampNum(Math.round(h) - CONFIG.island.height, 0, MAX_EXTRA);
    if (extra === this.extraHeight) return;
    this.extraHeight = extra;
    if (this.dock.phase === 'island') this._applyBounds('island');     // bounds only: no status replay
  }

  setEngaged(flag) { this.engaged = !!flag; }

  /**
   * Call after the user changes placement in Settings. Re-applies the current
   * phase's geometry under the new edge/align immediately, and tells the page
   * (edge and bulge direction change with it).
   */
  refreshPlacement() {
    if (!this.win || this.win.isDestroyed()) return;
    this._onPhase(this.dock.phase);
  }

  // ---- dragging -----------------------------------------------------------
  // The page only says "pressed / moved / released"; WHERE the pointer is comes from the desktop (see drag-controller.js:
  // the page's own coordinates are relative to a window that is moving under the pointer, so they cannot be used).

  /** The pointer's position on the whole desktop, or null when the desktop will not say (never throws). */
  _pointer() {
    try {
      const p = this.electron.screen.getCursorScreenPoint();
      return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;
    } catch (e) { return null; }
  }

  dragStart() {
    if (!this.win || this.win.isDestroyed()) return;
    const b = this.win.getBounds();
    const { edge } = resolvePlacement(this.getPrefs());
    this.drag.press({ pointer: this._pointer(), win: { x: b.x, y: b.y }, currentEdge: edge });
  }

  dragMove() {
    if (!this.win || this.win.isDestroyed()) return;
    const r = this.drag.move({ pointer: this._pointer() });
    if (!r.dragging) return;
    if (!this.dragging) {
      this.dragging = true;
      // A drag must never be interrupted by the auto-hide timer.
      this.dock.pointerEnter();
    }
    this.win.setPosition(r.x, r.y);
    this._send('pill:drag', { active: true, preview: r.preview });
  }

  dragEnd() {
    const wasDragging = this.dragging;
    const r = this.drag.release({ pointer: this._pointer() });
    this.dragging = false;
    this._send('pill:drag', { active: false });
    if (r.kind === 'drop') {
      this.onPlacementChange({ edge: r.edge, along: r.along, display: r.display });
    } else if (wasDragging) {
      this.refreshPlacement();         // a drag that produced no drop: snap back
    }
    return r;                          // 'click' -> caller treats it as a click
  }

  dragCancel() {
    const r = this.drag.cancel();
    if (this.dragging) { this.dragging = false; this._send('pill:drag', { active: false }); this.refreshPlacement(); }
    return r;
  }

  _send(channel, payload) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  // Events forwarded from the renderer via ipcMain (see index.js).
  pointerEnter() { this.dock.pointerEnter(); }
  pointerLeave() { if (!this.dragging) this.dock.pointerLeave(); }
  click() { this.dock.click(); }
  dismiss() { this.dock.dismiss(); }

  /**
   * Open or close the island from the KEYBOARD side: the global shortcut, starting ALLES a second time, the tray entry.
   * Hidden -> island (and ask the desktop to give it the keyboard, so the person can type at once). Anything else ->
   * hidden. It must not be click(): click() is for the pill itself and turns an open island into a peek pill, which with
   * no pointer around never goes away again. A question waiting for an answer keeps the island open - closing it would
   * leave the agent waiting on a question nobody can see.
   *
   * The island it opens is HELD open (summon(Infinity)): the pointer is not on it, and the pointer rules would otherwise
   * close it again within a tick if the pointer had ever visited the pill before (measured on a real GNOME Shell - half of
   * all "launch ALLES again" did nothing).
   */
  toggle() {
    if (this.dock.phase === 'hidden' || (this.dock.phase === 'peek' && !this.dock.autoHide())) {
      this.dock.summon(Infinity);        // the person asked for it: it stays until THEY close it (a hold, not the pointer rules)
      if (this.win && !this.win.isDestroyed() && typeof this.win.focus === 'function') this.win.focus();
      return;
    }
    if (this.approval) return;
    this.dock.dismiss();
  }

  /**
   * The island's window lost the keyboard because the person went elsewhere (clicked another window, Alt-Tab...). That is
   * "click outside": close the island - unless it still has something to do. Busy = working, a question open, or text typed
   * into the box (the same rule that stops it hiding when the pointer leaves).
   */
  windowBlurred() {
    if (this.dock.phase !== 'island' || this.dock.busy() || this.dragging) return;
    this.dock.dismiss();
  }

  destroy() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

module.exports = { DockWindow, PAD, CONFIG };

/**
 * Route renderer -> main pointer events to the DockWindow.
 * Only the whitelisted names are honoured; anything else is ignored, so a
 * compromised page cannot drive arbitrary dock behaviour.
 */
const PAGE_EVENTS = {
  'pointer-enter': (dw) => dw.pointerEnter(),
  'pointer-leave': (dw) => dw.pointerLeave(),
  'click': (dw) => dw.click(),
  'dismiss': (dw) => { dw.dragCancel(); dw.dismiss(); },
  'blurred': (dw) => dw.windowBlurred(),
  'drag-start': (dw) => dw.dragStart(),
  'drag-move': (dw) => dw.dragMove(),
  'drag-end': (dw) => {
    // A press that never moved far enough is a plain click on the pill.
    const r = dw.dragEnd();
    if (r.kind === 'click') dw.click();
  },
  'drag-cancel': (dw) => dw.dragCancel(),
  // Island controls. DockWindow does not own these actions (the app does); it forwards them
  // to callbacks supplied by the owner, so this file stays free of app-level policy.
  'open-workspace': (dw) => dw.onAction('open-workspace'),
  'open-settings': (dw) => dw.onAction('open-settings'),
  'stop-agent': (dw) => dw.onAction('stop-agent'),
  'quit-app': (dw) => dw.onAction('quit'),
  'submit-task': (dw, text) => dw.onAction('submit-task', text),
  'approval-answer': (dw, a) => dw.onAction('approval-answer', a),
  'island-height': (dw, n) => dw.setContentHeight(n),
  'engaged': (dw, f) => dw.setEngaged(f),
};

/** Which events carry a payload, and of what kind. Anything not listed carries NONE. The preload mirrors this table. */
const PAYLOAD_KINDS = {
  'submit-task': 'text', 'approval-answer': 'answer', 'island-height': 'number', 'engaged': 'flag',
};

/** Reduce a page-supplied payload to exactly its kind, or undefined if it does not qualify. Never trust the preload alone. */
function cleanPayload(kind, v) {
  switch (kind) {
    case 'text': return typeof v === 'string' && v.length > 0 && v.length <= TEXT_MAX ? v : undefined;
    case 'answer': return v && typeof v === 'object' && typeof v.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v.id) && typeof v.allow === 'boolean' ? { id: v.id, allow: v.allow } : undefined;
    case 'number': return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 100000 ? v : undefined;
    case 'flag': return typeof v === 'boolean' ? v : undefined;
    default: return undefined;
  }
}

function attachPageEvents(ipcMain, dockWindow) {
  const handler = (event, name, payload) => {
    // Only accept events from OUR window, never from another renderer.
    if (dockWindow.win && event.sender !== dockWindow.win.webContents) return;
    if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(PAGE_EVENTS, name)) return;
    const fn = PAGE_EVENTS[name];
    const kind = Object.prototype.hasOwnProperty.call(PAYLOAD_KINDS, name) ? PAYLOAD_KINDS[name] : null;
    if (kind) {
      const clean = cleanPayload(kind, payload);
      if (clean === undefined) return;            // a malformed payload is ignored, never guessed at
      fn(dockWindow, clean);
    } else {
      fn(dockWindow);                             // no payload expected: anything sent along is ignored
    }
  };
  ipcMain.on('pill:event', handler);
  return () => ipcMain.removeListener('pill:event', handler);
}

module.exports.attachPageEvents = attachPageEvents;
module.exports.PAGE_EVENTS = PAGE_EVENTS;
module.exports.PAYLOAD_KINDS = PAYLOAD_KINDS;
module.exports.cleanPayload = cleanPayload;
module.exports.MAX_EXTRA = MAX_EXTRA;
module.exports.TEXT_MAX = TEXT_MAX;
