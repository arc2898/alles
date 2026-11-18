'use strict';

/**
 * Pill layout - PURE functions, no Electron imports, fully unit-testable.
 *
 * THE PROBLEM: KDE Plasma and GNOME both reserve screen edges for panels.
 *   - GNOME: a fixed ~32px top bar (scales with the display).
 *   - KDE:   a user-placed panel that can be top, bottom, left, right,
 *            floating, or auto-hidden.
 * We must not draw the pill underneath (or on top of) a panel.
 *
 * THE TRICK: Electron's screen.getDisplay*().bounds is the FULL display and
 * .workArea is the display MINUS panels. Comparing them tells us exactly which
 * edges are occupied and by how much, on any desktop, with no per-DE code.
 *
 *   topInset = workArea.y - bounds.y
 *   leftInset, rightInset, bottomInset likewise.
 *
 * CAVEAT: auto-hide and some floating panels do not reserve space, so their
 * inset reads as 0. The user offset (Settings) exists for exactly that case.
 */

const DEFAULTS = {
  gap: 6,            // px between the panel edge and the pill BODY
  // Transparent margin around the visible body. The liquid droplets and the
  // goo blur paint outside the body, so the window must be bigger than the
  // body or they get clipped. Values come from the droplet keyframes
  // (max excursion ~14px above / ~12px below) + ~15px of blur falloff.
  padding: { top: 29, bottom: 26, side: 20 },
  collapsed: { width: 168, height: 34 },   // idle pill: status dot + clock
  expanded:  { width: 460, height: 132 },  // active pill: shows the reply
};

function insets(bounds, workArea) {
  return {
    top: Math.max(0, workArea.y - bounds.y),
    left: Math.max(0, workArea.x - bounds.x),
    right: Math.max(0, (bounds.x + bounds.width) - (workArea.x + workArea.width)),
    bottom: Math.max(0, (bounds.y + bounds.height) - (workArea.y + workArea.height)),
  };
}

/** Which edge holds the panel that takes the most room (for diagnostics / UI text). */
function detectPanelEdge(bounds, workArea) {
  const i = insets(bounds, workArea);
  const [edge, size] = Object.entries(i).sort((a, b) => b[1] - a[1])[0];
  return size > 0 ? { edge, size } : { edge: null, size: 0 };
}

function clamp(v, lo, hi) {
  if (hi < lo) return lo; // window bigger than the area: pin to the start
  return Math.min(Math.max(v, lo), hi);
}

/**
 * Compute the window rectangle for the pill.
 *
 * @param {object} p
 * @param {{x,y,width,height}} p.bounds    full display
 * @param {{x,y,width,height}} p.workArea  display minus panels
 * @param {'collapsed'|'expanded'} p.mode
 * @param {{x:number,y:number}} [p.offset] user nudge from Settings (px)
 * @param {'top'|'bottom'} [p.anchor]      which edge to hug (default top)
 * @param {object} [p.sizes]               override DEFAULTS sizes
 * @returns {{x:number,y:number,width:number,height:number}}
 */
function computePillBounds({ bounds, workArea, mode = 'collapsed', offset = { x: 0, y: 0 }, anchor = 'top', sizes = DEFAULTS }) {
  const size = sizes[mode];
  if (!size) throw new Error(`Unknown pill mode "${mode}"`);
  const gap = sizes.gap ?? DEFAULTS.gap;

  // Centre horizontally in the WORK AREA, so a left/right KDE panel does not
  // push the pill off-centre relative to the usable screen.
  let x = Math.round(workArea.x + (workArea.width - size.width) / 2) + (offset.x || 0);
  let y = anchor === 'bottom'
    ? Math.round(workArea.y + workArea.height - size.height - gap) + (offset.y || 0)
    : Math.round(workArea.y + gap) + (offset.y || 0);

  // Never leave the usable area, whatever offset the user typed.
  x = clamp(x, workArea.x, workArea.x + workArea.width - size.width);
  y = clamp(y, workArea.y, workArea.y + workArea.height - size.height);
  return { x, y, width: size.width, height: size.height };
}

/**
 * Window rectangle for a body rectangle: the body grown by the transparent
 * padding. The window is what Electron positions; the BODY is what must clear
 * the panel, so we compute the body first and then pad it outward.
 *
 * The padded window is clamped into the display's work area so the transparent
 * margin never overlaps a panel either (a transparent window still eats clicks).
 */
function computeWindowBounds(args) {
  const sizes = args.sizes || DEFAULTS;
  const pad = sizes.padding || DEFAULTS.padding;
  const body = computePillBounds(args);
  const wa = args.workArea;

  let x = body.x - pad.side;
  let y = body.y - pad.top;
  const width = body.width + pad.side * 2;
  const height = body.height + pad.top + pad.bottom;

  // Keep the padded window inside the work area.
  const cx = clamp(x, wa.x, wa.x + wa.width - width);
  const cy = clamp(y, wa.y, wa.y + wa.height - height);
  // Where the body sits INSIDE the window (renderer positions the pill here).
  return {
    window: { x: cx, y: cy, width, height },
    body: { x: body.x - cx, y: body.y - cy, width: body.width, height: body.height },
  };
}

/** Pick the display the pill should live on: where the mouse cursor is, else primary. */
function pickDisplay(displays, cursorPoint, primaryId) {
  const hit = displays.find((d) => {
    const b = d.bounds;
    return cursorPoint.x >= b.x && cursorPoint.x < b.x + b.width && cursorPoint.y >= b.y && cursorPoint.y < b.y + b.height;
  });
  return hit || displays.find((d) => d.id === primaryId) || displays[0];
}

module.exports = { DEFAULTS, insets, detectPanelEdge, computePillBounds, computeWindowBounds, pickDisplay, clamp };
