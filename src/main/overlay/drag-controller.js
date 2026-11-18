'use strict';

const { snapPlacement, displayForPoint } = require('./drag');
const { CONFIG } = require('./dock');

/**
 * DragController - pure state machine for dragging the pill.
 *
 * WHY THE POINTER'S POSITION ON THE SCREEN, AND NOT THE PAGE'S COORDINATES
 * The page can only say where the pointer is relative to ITS OWN window - and the window is moving under the pointer
 * while it is dragged. Feeding that back ("move the window by how far the pointer is from where I grabbed it") makes
 * the window chase its own tail: measured on a real GNOME desktop, the pill lagged hundreds of pixels behind the
 * mouse and landed on the wrong edge. (Chromium's e.screenX/screenY are unusable - measured as 0,0 - so the page
 * cannot supply the true position either.) So the page only says "pressed", "moved", "released", and main reads where
 * the pointer really is (Electron's screen.getCursorScreenPoint(), checked against the real compositor) and hands it
 * to this controller. The window position is then simply  origin + (pointer now - pointer at the press),  and does not
 * depend on where the window happens to be at that moment.
 *
 * WHY A THRESHOLD
 * The pill is also a button (click = toggle island). A hand always moves a couple of pixels during a click, so
 * movement under `threshold` px is still a CLICK.
 *
 * States:  idle -> pressed -> dragging -> idle
 *   pressed   : button down, hasn't moved far enough to count as a drag yet
 *   dragging  : the pill follows the pointer; a snap preview is computed live
 */
const isPoint = (p) => !!p && typeof p === 'object' && Number.isFinite(p.x) && Number.isFinite(p.y);

class DragController {
  /**
   * @param {object} o
   * @param {()=>Array} o.getDisplays     current displays (Electron screen.getAllDisplays())
   * @param {number} [o.threshold]        px of movement before a press becomes a drag
   * @param {number} [o.stickiness]       corner hysteresis (see drag.js)
   */
  constructor({ getDisplays, threshold = 6, stickiness = 48, cfg = CONFIG } = {}) {
    this.getDisplays = getDisplays;
    this.threshold = threshold;
    this.stickiness = stickiness;
    this.cfg = cfg;
    this.reset();
  }

  reset() {
    this.state = 'idle';
    this.start = null;        // { x, y }  pointer position (screen space) at press
    this.origin = null;       // { x, y }  window top-left (screen space) at press
    this.point = null;        // { x, y }  latest pointer position, in SCREEN space
    this.current = null;      // edge we are currently snapped to (for hysteresis)
    this.preview = null;      // { edge, along, display } the drop would produce right now
    this.moved = 0;
    this._x = null; this._y = null;   // where the window was last told to go
  }

  /** Pointer pressed on the pill. `pointer` is its position on the screen, `win` the window's current top-left. */
  press({ pointer, win, currentEdge } = {}) {
    this.reset();
    if (!isPoint(pointer) || !isPoint(win)) return;           // no usable position: stay idle, so a release is just a click
    this.state = 'pressed';
    this.start = { x: pointer.x, y: pointer.y };
    this.origin = { x: win.x, y: win.y };
    this.current = currentEdge || null;
  }

  /**
   * Pointer moved while pressed. Returns:
   *   { dragging:false }                            still within the click threshold (or no usable position)
   *   { dragging:true, x, y, preview }             move the window to (x,y); show the snap preview
   */
  move({ pointer } = {}) {
    if (this.state === 'idle') return { dragging: false };
    if (!isPoint(pointer)) return this.state === 'dragging' ? { dragging: true, x: this._x, y: this._y, preview: this.preview } : { dragging: false };
    const dx = pointer.x - this.start.x;
    const dy = pointer.y - this.start.y;
    this.moved = Math.max(this.moved, Math.hypot(dx, dy));

    if (this.state === 'pressed') {
      if (this.moved < this.threshold) return { dragging: false };
      this.state = 'dragging';
    }

    // The window follows the pointer exactly: where it started + how far the pointer has travelled.
    this._x = Math.round(this.origin.x + dx);
    this._y = Math.round(this.origin.y + dy);
    this.point = { x: pointer.x, y: pointer.y };
    this.preview = this._snap(this.point);
    if (this.preview) this.current = this.preview.edge;
    return { dragging: true, x: this._x, y: this._y, preview: this.preview };
  }

  /**
   * Pointer released. `pointer` (optional) is where it is NOW, which can be a little past the last move that was
   * reported - the drop uses it, so the pill lands where the hand let go.
   *   { kind:'click' }                      it never became a drag: treat as a click
   *   { kind:'drop', edge, along, display } commit this placement
   */
  release({ pointer } = {}) {
    if (this.state === 'dragging' && isPoint(pointer)) {
      const later = this._snap({ x: pointer.x, y: pointer.y });
      if (later) { this.preview = later; this.current = later.edge; }
    }
    const was = this.state;
    const preview = this.preview;
    this.reset();
    if (was !== 'dragging' || !preview) return { kind: 'click' };
    return { kind: 'drop', ...preview };
  }

  /** Escape or lost capture mid-drag: abandon it, place nothing. */
  cancel() {
    const was = this.state;
    this.reset();
    return { kind: was === 'dragging' ? 'cancelled' : 'none' };
  }

  _snap(point) {
    const display = displayForPoint(this.getDisplays(), point);
    if (!display) return null;
    const wa = display.workArea;
    // margin = half the island's extent along whichever edge we snap to; snapPlacement
    // needs it before it knows the edge, so pick the edge first, then measure `along`.
    const edge = snapPlacement({ point, workArea: wa, current: this.current, stickiness: this.stickiness }).edge;
    const vertical = edge === 'left' || edge === 'right';
    const margin = ((vertical ? this.cfg.island.height : this.cfg.island.width) + this.cfg.pad * 2) / 2;
    const snapped = snapPlacement({ point, workArea: wa, current: edge, stickiness: this.stickiness, margin });
    return { edge: snapped.edge, along: snapped.along, display: display.id };
  }
}

module.exports = { DragController };
