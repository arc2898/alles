'use strict';

/**
 * Dock controller - PURE state machine + geometry. No Electron, no timers of
 * its own: the caller feeds it events and a clock, and it returns what to show.
 * That makes every behaviour below unit-testable.
 *
 * MODEL (mirrors a KDE auto-hide panel):
 *
 *   hidden ──pointer enters hot strip (after dwell)──▶ peek
 *   peek   ──click──▶ island          peek ──pointer leaves (after delay)──▶ hidden
 *   island ──pointer leaves (after delay) / Esc / click-outside──▶ hidden
 *   island stays open while the agent is working or waiting for approval.
 *
 * WHY A HOT STRIP AND NOT CURSOR POLLING:
 * Electron documents mouse "forward" for a click-through window on macOS and
 * Windows ONLY. On Linux/Wayland a fully click-through window never sees the
 * pointer arrive. So while hidden we keep a real, thin, non-transparent-to-
 * input strip at the edge. The compositor delivers pointer events to it like
 * any other window - exactly how an auto-hide panel works.
 */

const EDGES = ['top', 'left', 'right', 'bottom'];

// Position ALONG the chosen edge. For top/bottom docks start=left, end=right;
// for left/right docks start=top, end=bottom.
const ALIGNS = { start: 0, center: 0.5, end: 1 };

/**
 * Resolve a user placement to { edge, along }. Accepts a named align or a raw
 * 0..1 number (for a fine-tune slider). Invalid input falls back to the safe
 * default (top-center) instead of throwing, because this reads a settings file
 * a human can hand-edit and a bad value must never stop the app starting.
 */
function resolvePlacement(input) {
  // NOT a default parameter: `prefs = {}` only covers undefined, and a corrupted
  // settings file can yield null (or a string/number/array) instead.
  const prefs = input !== null && typeof input === 'object' ? input : {};
  const edge = EDGES.includes(prefs.edge) ? prefs.edge : 'top';
  let along = 0.5;
  if (typeof prefs.align === 'string' && prefs.align in ALIGNS) along = ALIGNS[prefs.align];
  else if (typeof prefs.along === 'number' && Number.isFinite(prefs.along)) along = Math.min(Math.max(prefs.along, 0), 1);
  return { edge, along };
}

const CONFIG = {
  strip: 2,            // px thickness of the hidden hit target (perpendicular to the edge)
  stripLength: 8,      // px length of the hidden hit target ALONG the edge
  dwellMs: 120,        // pointer must stay on the strip this long (ignores fly-bys)
  hideDelayMs: 450,    // grace period after the pointer leaves before hiding
  summonHoldMs: 12000, // an island opened by the agent's news (finished, failed, a question) stays at least this long with no pointer on it
  peek:   { width: 168, height: 34 },
  // Sized so the IDLE island (status row + prompt bar) fits without growing: measured content is 138px at the default
  // font. Opening at less and then growing would make the island visibly twitch on every open. The page still reports
  // its real height, so a wider font or a reply/question simply grows it further.
  island: { width: 460, height: 140 },
  gap: 6,              // clearance from a panel
  // Transparent margin around the VISIBLE pill in peek/island. The goo blur and
  // droplets paint into it. Must equal --pad in pill.html (checked by a test).
  pad: 20,
};

/** Panel-aware inset for one edge: how many px of the display that edge loses. */
function edgeInset(edge, bounds, workArea) {
  switch (edge) {
    case 'top':    return Math.max(0, workArea.y - bounds.y);
    case 'left':   return Math.max(0, workArea.x - bounds.x);
    case 'right':  return Math.max(0, (bounds.x + bounds.width) - (workArea.x + workArea.width));
    case 'bottom': return Math.max(0, (bounds.y + bounds.height) - (workArea.y + workArea.height));
    default: throw new Error(`Unknown edge "${edge}"`);
  }
}

const clamp = (v, lo, hi) => (hi < lo ? lo : Math.min(Math.max(v, lo), hi));

/** What a display has lost on each edge to panels and docks, in px: { top, bottom, left, right }. */
function edgeInsets(bounds, workArea) {
  return {
    top: edgeInset('top', bounds, workArea),
    bottom: edgeInset('bottom', bounds, workArea),
    left: edgeInset('left', bounds, workArea),
    right: edgeInset('right', bounds, workArea),
  };
}

/**
 * The edge ALLES should start on: the one with the least on it (normally nothing at all).
 *
 * A panel between the pointer and the screen border ruins the hidden strip. The screen border is a wall the pointer
 * stops against, so a 2 px strip there is easy to hit; next to a panel it is just a thin line the pointer flies
 * across on its way into the panel. Measured on a real GNOME Shell: the strip under the 32 px top bar was not hit by
 * a normal movement. Ties keep this order: top, bottom, right, left - so a clean screen still gets the top edge.
 */
function freeEdge(insets) {
  let best = 'top';
  let bestInset = Infinity;
  for (const e of ['top', 'bottom', 'right', 'left']) {
    const n = Number(insets && insets[e]);
    const v = Number.isFinite(n) && n > 0 ? n : 0;
    if (v < bestInset) { best = e; bestInset = v; }
  }
  return best;
}


/**
 * Rectangle for the window in a given phase, docked to `edge` of `workArea`.
 *
 * Top/bottom docks are horizontal pills; left/right docks are the same shapes
 * rotated (width/height swapped) so the pill hangs off the side.
 *
 * `along` is the position along the edge as a 0..1 fraction (0.5 = centred),
 * so the user can slide the dock toward a corner in Settings.
 *
 * Geometry is expressed against the WORK AREA, which already excludes any
 * KDE/GNOME panel, so the dock sits flush against the panel, never under it.
 */
function dockRect({ phase, edge = 'top', workArea, along = 0.5, cfg = CONFIG }) {
  if (!EDGES.includes(edge)) throw new Error(`Unknown edge "${edge}"`);
  if (!['hidden', 'peek', 'island'].includes(phase)) throw new Error(`Unknown phase "${phase}"`);
  const vertical = edge === 'left' || edge === 'right';
  const a = clamp(along, 0, 1);

  // ---- 1. Where does the pill's CENTRE sit along the edge? --------------------
  // Computed ONCE, from the biggest shape (the island), and shared by every phase.
  // Why the biggest: near a corner the island gets pushed inward to stay on-screen.
  // If the strip sat at the raw `along` position instead, the pill would appear
  // up to ~100px away from where the cursor hit the strip. Deriving the strip from
  // the same centre makes that drift impossible by construction.
  const alongExtent = (size, padAlong) => size + padAlong * 2;             // window extent along the edge
  const islandAlong = alongExtent(vertical ? cfg.island.height : cfg.island.width, cfg.pad);
  const span = vertical ? workArea.height : workArea.width;
  const origin = vertical ? workArea.y : workArea.x;
  const rawCentre = origin + islandAlong / 2 + (span - islandAlong) * a;   // island window's centre
  const centre = Math.round(rawCentre);

  // ---- 2. Visible size for this phase ----------------------------------------
  let vw, vh;
  if (phase === 'hidden') {
    vw = vertical ? cfg.strip : cfg.stripLength;
    vh = vertical ? cfg.stripLength : cfg.strip;
  } else {
    // The visible pill keeps its natural, readable, horizontal shape on EVERY edge
    // (rotating it into a tall column made the text unreadable). Only the hidden
    // strip is oriented along the edge, since it is just a hit target.
    const sz = phase === 'peek' ? cfg.peek : cfg.island;
    vw = sz.width; vh = sz.height;
    // The island grows when it has more to show (reply + prompt, an approval question). The CENTRE above
    // is computed from the BASE island size on purpose, so growing never slides the pill along its edge.
    if (phase === 'island') vh += Math.max(0, Math.min(Number(cfg.extraHeight) || 0, 320));
  }

  // ---- 3. Transparent padding (asymmetric on purpose) ------------------------
  //   * away from the docked edge : full `pad` - droplets bulge that way
  //   * toward the docked edge    : only `gap` - a window can never extend past the
  //     work area into a KDE/GNOME panel, so that side's clearance IS the gap
  //   * the hidden strip has NO padding: it must stay a thin, exact hit target
  const hidden = phase === 'hidden';
  const padAway = hidden ? 0 : cfg.pad;
  const padSide = hidden ? 0 : cfg.pad;
  const padEdge = hidden ? 0 : cfg.gap;
  const P = { top: padSide, right: padSide, bottom: padSide, left: padSide };
  if (edge === 'top') { P.top = padEdge; P.bottom = padAway; }
  else if (edge === 'bottom') { P.bottom = padEdge; P.top = padAway; }
  else if (edge === 'left') { P.left = padEdge; P.right = padAway; }
  else { P.right = padEdge; P.left = padAway; }

  const w = vw + P.left + P.right;
  const h = vh + P.top + P.bottom;

  // ---- 4. Place the window: centred on `centre` along the edge, flush across it
  let x, y;
  if (!vertical) {
    x = Math.round(centre - w / 2);
    y = edge === 'top' ? workArea.y : workArea.y + workArea.height - h;
  } else {
    y = Math.round(centre - h / 2);
    x = edge === 'left' ? workArea.x : workArea.x + workArea.width - w;
  }
  x = clamp(x, workArea.x, workArea.x + workArea.width - w);
  y = clamp(y, workArea.y, workArea.y + workArea.height - h);
  return { x, y, width: w, height: h, inset: P };
}

/**
 * Which way should the liquid droplets bulge? Away from the edge the pill is
 * docked to, because the edge side has no headroom (it is pinned to a panel or
 * the screen border). This fixes the clipped-droplet problem noted earlier.
 */
function bulgeDirection(edge) {
  return { top: 'down', bottom: 'up', left: 'right', right: 'left' }[edge];
}

class Dock {
  /**
   * @param {object} o
   * @param {(phase:string, prev:string)=>void} o.onPhase  called on every phase change
   * @param {()=>number} [o.now]
   * @param {()=>boolean} [o.busy]   true while the agent works / awaits approval -> never auto-hide
   */
  constructor({ onPhase = () => {}, now = Date.now, busy = () => false, autoHide = () => true, cfg = CONFIG } = {}) {
    this.cfg = cfg;
    this.now = now;
    this.busy = busy;
    this.autoHide = typeof autoHide === 'function' ? autoHide : () => !!autoHide;
    this.onPhase = onPhase;
    // Persistent mode starts as a visible collapsed pill; auto-hide mode starts
    // with the small edge hot-strip and reveals on pointer dwell.
    this.phase = this.autoHide() ? 'hidden' : 'peek';
    this.enteredAt = null;   // when the pointer entered the current hot area
    this.leftAt = null;      // when the pointer left it
    this.pointerInside = false;
    this.holdUntil = 0;      // the island was opened WITHOUT the pointer and must stay until this time (Infinity = until dismissed)
  }

  _set(next) {
    if (next === this.phase) return;
    const prev = this.phase;
    this.phase = next;
    if (next !== 'island') this.holdUntil = 0;     // a hold belongs to the island it was asked for
    this.onPhase(next, prev);
  }

  /** Pointer entered the strip / pill window. */
  pointerEnter() {
    this.pointerInside = true;
    this.leftAt = null;
    if (this.enteredAt === null) this.enteredAt = this.now();
  }

  /** Pointer left the strip / pill window. */
  pointerLeave() {
    this.pointerInside = false;
    this.enteredAt = null;
    this.leftAt = this.now();
  }

  /** User clicked the pill. */
  click() {
    if (this.phase === 'peek') this._set('island');
    else if (this.phase === 'island') this._set('peek'); // second click collapses
    // a click on the hidden 3px strip is treated as a reveal request too
    else if (this.phase === 'hidden') this._set('island');
  }

  /**
   * Esc, or a click outside the island. In auto-hide mode it returns to the hidden hot-strip; in persistent mode
   * it collapses to the visible pill. Pointer state is cleared so a dismissed island cannot immediately reopen
   * because a compositor omitted a leave event when the window changed size.
   */
  dismiss() {
    if (this.phase === 'hidden') return;
    // In persistent mode Esc, click-outside and the keyboard toggle collapse
    // the expanded island back to its always-visible pill, never off-screen.
    this._set(this.autoHide() ? 'hidden' : 'peek');
    this.pointerInside = false; this.enteredAt = null; this.leftAt = null;
  }

  /**
   * Show the peek pill for `ms` although the pointer is nowhere near (the first-run "this is where I live" cue).
   * It rides on the normal hide rule: if the pointer arrives it stays like any peek, otherwise tick() hides it
   * once `ms` have passed. Only from hidden - it never shrinks an island that is open.
   */
  peekFor(ms) {
    if (this.phase !== 'hidden') return;
    const span = Math.min(Math.max(Number(ms) || 0, 0), 60000);
    if (span <= 0) return;
    this._set('peek');
    // Arm the normal hide timer as if the pointer had left `span` ms from now. If the pointer IS on the pill, the
    // pointerInside flag still holds it open; this never touches that flag.
    this.leftAt = this.now() - this.cfg.hideDelayMs + span;
  }

  /**
   * Open the island although the pointer is nowhere near it: the agent has news (a question, finished, failed) or the person asked
   * from the keyboard. Such an island must not be closed by the pointer rules for a while, because those rules look at when the
   * pointer LAST left - and that may have been minutes ago, at some earlier visit to the pill. MEASURED on a real GNOME Shell: an
   * island opened this way after the pointer had once visited the pill was shut again by the very next 50 ms tick.
   *
   * @param {number} [holdMs]  how long it stays regardless of the pointer. Infinity = until it is dismissed (the keyboard asked for
   *   it, so the keyboard - Esc, the shortcut again, a click elsewhere - closes it). Anything else that is not a positive number
   *   means the standard hold, never zero. Once the hold is over the usual rules apply: busy, pointer on it, grace period.
   */
  summon(holdMs) {
    this._set('island');
    const span = holdMs === Infinity ? Infinity : (Number.isFinite(holdMs) && holdMs > 0 ? holdMs : this.cfg.summonHoldMs);
    this.holdUntil = Math.max(this.holdUntil, span === Infinity ? Infinity : this.now() + span);
    // Count the time away from NOW. Not from some older visit (that closed it at once) and not "never" (a dock that has never seen
    // the pointer has no leave time at all, and would stay open for ever once the hold ended). While the pointer IS on the island
    // this value is not looked at (the hide rule needs the pointer gone, and its leaving sets the time afresh).
    this.leftAt = this.now();
  }

  /**
   * Advance time-based transitions. Call on a short interval (~50ms) while the
   * app runs, and after every event. Returns the current phase.
   */
  tick() {
    const t = this.now();

    // Apply a live switch from auto-hide to persistent without requiring a
    // restart. A hidden hot-strip becomes the normal, visible collapsed pill.
    const hideEnabled = this.autoHide();
    if (!hideEnabled && this.phase === 'hidden') this._set('peek');
    if (hideEnabled && this.phase !== 'hidden' && !this.pointerInside && this.leftAt === null) this.leftAt = t;

    // hidden -> peek: pointer has dwelled on the strip long enough.
    if (this.phase === 'hidden' && this.pointerInside && this.enteredAt !== null
        && t - this.enteredAt >= this.cfg.dwellMs) {
      this._set('peek');
    }

    // Expanded island -> collapsed phase after the grace/hold period. In auto-hide mode, peek also hides.
    const collapsible = this.phase === 'island' || (hideEnabled && this.phase === 'peek');
    if (collapsible && !this.pointerInside && this.leftAt !== null
        && t - this.leftAt >= this.cfg.hideDelayMs && !this.busy() && t >= this.holdUntil) {
      // Auto-hide mode collapses all the way to its hot-strip. Persistent mode
      // keeps its collapsed pill on screen, including after a task-result toast.
      this._set(hideEnabled ? 'hidden' : 'peek');
    }
    return this.phase;
  }
}

module.exports = { Dock, dockRect, bulgeDirection, edgeInset, edgeInsets, freeEdge, resolvePlacement, CONFIG, EDGES, ALIGNS };
