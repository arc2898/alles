'use strict';

/**
 * Drag placement - PURE geometry, no Electron.
 *
 * Given where the pointer is on the screen, decide which edge the dock snaps to
 * and how far along that edge it sits (0..1). Free placement: any edge, any
 * position, remembered by the settings store.
 *
 * KEY PROBLEM - corners. Near a corner two edges are almost equally close, so a
 * naive "nearest edge" flips back and forth every few pixels as the hand shakes.
 * We add HYSTERESIS: once snapped to an edge, the pointer must get clearly
 * closer (by `stickiness` px) to a different edge before we switch.
 *
 * All positions are in the WORK AREA (screen minus panels), so a snapped dock
 * sits against a KDE/GNOME panel rather than under it.
 */

const EDGES = ['top', 'bottom', 'left', 'right'];

/** Distance from a point to each edge of the work area (negative if outside). */
function edgeDistances(point, wa) {
  return {
    top: point.y - wa.y,
    bottom: wa.y + wa.height - point.y,
    left: point.x - wa.x,
    right: wa.x + wa.width - point.x,
  };
}

/**
 * Nearest edge with hysteresis.
 * @param {{x:number,y:number}} point
 * @param {{x,y,width,height}} wa
 * @param {string|null} current  edge the dock is currently snapped to (null = none yet)
 * @param {number} stickiness    px a competing edge must beat the current one by
 */
function nearestEdge(point, wa, current = null, stickiness = 48) {
  const d = edgeDistances(point, wa);
  let best = EDGES[0];
  for (const e of EDGES) if (d[e] < d[best]) best = e;   // ties resolve by EDGES order: deterministic
  if (current && EDGES.includes(current) && best !== current) {
    // Only leave the current edge if the new one is clearly closer.
    if (d[current] - d[best] < stickiness) return current;
  }
  return best;
}

/** Fraction 0..1 along an edge for a pointer position, given the extent the dock can travel. */
function alongFor(edge, point, wa, { margin = 0 } = {}) {
  const vertical = edge === 'left' || edge === 'right';
  const origin = (vertical ? wa.y : wa.x) + margin;
  const span = (vertical ? wa.height : wa.width) - margin * 2;
  if (span <= 0) return 0.5;
  const v = ((vertical ? point.y : point.x) - origin) / span;
  return Math.min(Math.max(v, 0), 1);
}

/**
 * Full snap: pointer -> { edge, along }.
 * `margin` is half the island's extent along the edge, so `along` is measured for
 * the dock's CENTRE and 0/1 mean "island flush to the corner", matching dockRect().
 */
function snapPlacement({ point, workArea, current = null, stickiness = 48, margin = 0 }) {
  const edge = nearestEdge(point, workArea, current, stickiness);
  return { edge, along: alongFor(edge, point, workArea, { margin }) };
}

/**
 * Inverse of dockRect's centre computation: where (in screen px) should the
 * dock's centre be for a saved {edge, along}? Used to draw a drag preview.
 */
function centreFor({ edge, along }, workArea, extentAlong) {
  const vertical = edge === 'left' || edge === 'right';
  const span = vertical ? workArea.height : workArea.width;
  const origin = vertical ? workArea.y : workArea.x;
  return Math.round(origin + extentAlong / 2 + (span - extentAlong) * Math.min(Math.max(along, 0), 1));
}

/**
 * Which display owns this point? Returns the display whose bounds contain it,
 * or the NEAREST one when the point is in a gap between monitors.
 */
function displayForPoint(displays, point) {
  if (!displays || !displays.length) return null;
  const inside = displays.find((d) => point.x >= d.bounds.x && point.x < d.bounds.x + d.bounds.width
    && point.y >= d.bounds.y && point.y < d.bounds.y + d.bounds.height);
  if (inside) return inside;
  let best = displays[0], bestDist = Infinity;
  for (const d of displays) {
    const b = d.bounds;
    const dx = Math.max(b.x - point.x, 0, point.x - (b.x + b.width - 1));
    const dy = Math.max(b.y - point.y, 0, point.y - (b.y + b.height - 1));
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) { bestDist = dist; best = d; }
  }
  return best;
}

module.exports = { EDGES, edgeDistances, nearestEdge, alongFor, snapPlacement, centreFor, displayForPoint };
