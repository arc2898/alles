'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EDGES, edgeDistances, nearestEdge, alongFor, snapPlacement, centreFor, displayForPoint } = require('../src/main/overlay/drag');
const { dockRect, CONFIG } = require('../src/main/overlay/dock');

const R = (x, y, width, height) => ({ x, y, width, height });
const FULL = R(0, 0, 1920, 1080);
const GNOME = R(0, 32, 1920, 1048);
const KDE_LEFT = R(56, 0, 1864, 1080);
const vis = (r) => ({ x: r.x + r.inset.left, y: r.y + r.inset.top, width: r.width - r.inset.left - r.inset.right, height: r.height - r.inset.top - r.inset.bottom });
const islandAlong = (edge) => (edge === 'left' || edge === 'right' ? CONFIG.island.height : CONFIG.island.width) + CONFIG.pad * 2;

// ------------------------------------------------------------------ nearest edge

test('distances are measured to the WORK AREA, so a panel counts as the edge', () => {
  assert.deepStrictEqual(edgeDistances({ x: 100, y: 100 }, GNOME), { top: 68, bottom: 980, left: 100, right: 1820 });
});

test('nearest edge: each region of the screen picks the obvious edge', () => {
  assert.strictEqual(nearestEdge({ x: 960, y: 20 }, FULL), 'top');
  assert.strictEqual(nearestEdge({ x: 960, y: 1060 }, FULL), 'bottom');
  assert.strictEqual(nearestEdge({ x: 15, y: 540 }, FULL), 'left');
  assert.strictEqual(nearestEdge({ x: 1905, y: 540 }, FULL), 'right');
});

test('nearest edge respects a panel: dragging near a KDE left panel snaps to the work area edge, not the screen edge', () => {
  // x=70 is only 14px from the panel's inner edge (x=56) but 70px from the screen edge.
  assert.strictEqual(nearestEdge({ x: 70, y: 540 }, KDE_LEFT), 'left');
  assert.strictEqual(edgeDistances({ x: 70, y: 540 }, KDE_LEFT).left, 14);
});

test('points outside the work area (over a panel) still resolve to a sensible edge, never throw', () => {
  for (const p of [{ x: -50, y: -50 }, { x: 5000, y: 5000 }, { x: 960, y: 0 }, { x: 0, y: 0 }]) {
    assert.ok(EDGES.includes(nearestEdge(p, GNOME)), JSON.stringify(p));
  }
});

test('exact ties resolve deterministically (same input, same edge, every time)', () => {
  const p = { x: 100, y: 100 };                       // equidistant from top and left
  const first = nearestEdge(p, FULL);
  for (let i = 0; i < 50; i++) assert.strictEqual(nearestEdge(p, FULL), first);
});

// ------------------------------------------------------------------ hysteresis

test('HYSTERESIS: near a corner, a small wobble does NOT flip the edge', () => {
  // Snapped to top. Pointer is 30px from the top and 25px from the left: left is closer,
  // but only by 5px - well under the 48px stickiness - so we must stay on top.
  assert.strictEqual(nearestEdge({ x: 25, y: 30 }, FULL, 'top', 48), 'top');
});

test('HYSTERESIS: a decisive move to another edge DOES switch', () => {
  // top distance 300, left distance 10: left wins by 290 > 48.
  assert.strictEqual(nearestEdge({ x: 10, y: 300 }, FULL, 'top', 48), 'left');
});

test('HYSTERESIS: no flicker - a shaky path across the corner diagonal produces at most ONE switch', () => {
  // Simulate a hand jittering +/-6px around the diagonal x==y while drifting outward.
  let current = null, switches = 0;
  for (let i = 0; i < 400; i++) {
    const base = 20 + i * 0.4;
    const jitter = (i % 2 ? 1 : -1) * 6;
    const next = nearestEdge({ x: base + jitter, y: base - jitter }, FULL, current, 48);
    if (current && next !== current) switches++;
    current = next;
  }
  assert.ok(switches <= 1, `edge flipped ${switches} times on a corner wobble`);
});

test('WITHOUT hysteresis the same wobble DOES flicker (proves the test above is meaningful)', () => {
  let current = null, switches = 0;
  for (let i = 0; i < 400; i++) {
    const base = 20 + i * 0.4; const jitter = (i % 2 ? 1 : -1) * 6;
    const next = nearestEdge({ x: base + jitter, y: base - jitter }, FULL, current, 0);   // stickiness 0 = off
    if (current && next !== current) switches++;
    current = next;
  }
  assert.ok(switches > 20, `expected heavy flicker with hysteresis off, got ${switches}`);
});

test('an invalid `current` edge is ignored rather than trusted', () => {
  assert.strictEqual(nearestEdge({ x: 960, y: 10 }, FULL, 'diagonal'), 'top');
  assert.strictEqual(nearestEdge({ x: 960, y: 10 }, FULL, undefined), 'top');
});

// ------------------------------------------------------------------ along

test('along: 0 / 0.5 / 1 at the two ends and the middle of each edge', () => {
  assert.strictEqual(alongFor('top', { x: 0, y: 0 }, FULL), 0);
  assert.strictEqual(alongFor('top', { x: 960, y: 0 }, FULL), 0.5);
  assert.strictEqual(alongFor('top', { x: 1920, y: 0 }, FULL), 1);
  assert.strictEqual(alongFor('left', { x: 0, y: 540 }, FULL), 0.5);
  assert.strictEqual(alongFor('right', { x: 1920, y: 1080 }, FULL), 1);
});

test('along is clamped, so dragging past the screen end saves a valid value', () => {
  assert.strictEqual(alongFor('top', { x: -400, y: 0 }, FULL), 0);
  assert.strictEqual(alongFor('top', { x: 99999, y: 0 }, FULL), 1);
});

test('along uses the work area: a KDE left panel shifts the origin of a top dock', () => {
  assert.strictEqual(alongFor('top', { x: 56, y: 0 }, KDE_LEFT), 0);
  assert.strictEqual(alongFor('top', { x: 56 + 1864 / 2, y: 0 }, KDE_LEFT), 0.5);
});

test('along with a degenerate (zero/negative) span does not divide by zero', () => {
  assert.strictEqual(alongFor('top', { x: 5, y: 0 }, R(0, 0, 0, 100)), 0.5);
  assert.strictEqual(alongFor('top', { x: 5, y: 0 }, R(0, 0, 100, 100), { margin: 80 }), 0.5);
});

// ------------------------------------------------------------------ round trip through dockRect

test('ROUND TRIP: drop anywhere on any edge -> saved {edge, along} -> dockRect puts the dock where you dropped it', () => {
  let checked = 0;
  for (const wa of [FULL, GNOME, KDE_LEFT]) {
    for (const edge of EDGES) {
      const vertical = edge === 'left' || edge === 'right';
      const half = islandAlong(edge) / 2;
      // Drop the centre at several places that ARE reachable (island fully on-screen)
      const lo = (vertical ? wa.y : wa.x) + half, hi = (vertical ? wa.y + wa.height : wa.x + wa.width) - half;
      for (const t of [0, 0.1, 0.33, 0.5, 0.8, 1]) {
        const dropAlong = Math.round(lo + (hi - lo) * t);
        const point = vertical
          ? { x: edge === 'left' ? wa.x + 10 : wa.x + wa.width - 10, y: dropAlong }
          : { x: dropAlong, y: edge === 'top' ? wa.y + 10 : wa.y + wa.height - 10 };
        const snapped = snapPlacement({ point, workArea: wa, margin: half });
        assert.strictEqual(snapped.edge, edge, `expected ${edge} for ${JSON.stringify(point)} in ${JSON.stringify(wa)}`);
        const v = vis(dockRect({ phase: 'island', edge: snapped.edge, along: snapped.along, workArea: wa }));
        const centre = vertical ? v.y + v.height / 2 : v.x + v.width / 2;
        assert.ok(Math.abs(centre - dropAlong) <= 1, `${edge} t=${t}: dropped at ${dropAlong}, restored at ${centre}`);
        checked++;
      }
    }
  }
  assert.strictEqual(checked, 3 * 4 * 6);
});

test('ROUND TRIP: a drop so close to a corner that the island would hang off-screen is held on-screen (by design)', () => {
  const half = islandAlong('top') / 2;
  const snapped = snapPlacement({ point: { x: 1900, y: 10 }, workArea: FULL, margin: half });
  assert.strictEqual(snapped.along, 1);
  const v = vis(dockRect({ phase: 'island', edge: 'top', along: snapped.along, workArea: FULL }));
  assert.ok(v.x + v.width <= 1920, 'the island never leaves the screen');
  assert.ok(v.x + v.width / 2 < 1900, 'so its centre stops short of the raw drop point');
});

test('centreFor is the inverse of the along fraction used by dockRect', () => {
  for (const edge of ['top', 'left']) {
    const extent = islandAlong(edge);
    for (const along of [0, 0.25, 0.5, 1]) {
      const c = centreFor({ edge, along }, FULL, extent);
      const v = vis(dockRect({ phase: 'island', edge, along, workArea: FULL }));
      const actual = edge === 'top' ? v.x + v.width / 2 : v.y + v.height / 2;
      assert.ok(Math.abs(c - actual) <= 1, `${edge} along=${along}: centreFor ${c} vs dockRect ${actual}`);
    }
  }
});

// ------------------------------------------------------------------ multi-monitor

const D1 = { id: 1, bounds: R(0, 0, 1920, 1080), workArea: GNOME };
const D2 = { id: 2, bounds: R(1920, 0, 1920, 1080), workArea: R(1920, 0, 1920, 1080) };
const DL = { id: 3, bounds: R(-1920, 0, 1920, 1080), workArea: R(-1920, 0, 1920, 1080) };

test('displayForPoint picks the display containing the pointer, including a negative-origin monitor', () => {
  assert.strictEqual(displayForPoint([D1, D2, DL], { x: 100, y: 100 }).id, 1);
  assert.strictEqual(displayForPoint([D1, D2, DL], { x: 2500, y: 500 }).id, 2);
  assert.strictEqual(displayForPoint([D1, D2, DL], { x: -500, y: 500 }).id, 3);
});

test('displayForPoint: a pointer in a gap or off every monitor snaps to the NEAREST one', () => {
  const gap1 = { id: 1, bounds: R(0, 0, 1000, 1000) }, gap2 = { id: 2, bounds: R(1200, 0, 1000, 1000) };
  assert.strictEqual(displayForPoint([gap1, gap2], { x: 1050, y: 500 }).id, 1);
  assert.strictEqual(displayForPoint([gap1, gap2], { x: 1150, y: 500 }).id, 2);
  assert.strictEqual(displayForPoint([gap1, gap2], { x: 500, y: 5000 }).id, 1);
  assert.strictEqual(displayForPoint([], { x: 0, y: 0 }), null);
});

test('the right and bottom pixel of a display belong to it (bounds are half-open)', () => {
  assert.strictEqual(displayForPoint([D1, D2], { x: 1919, y: 1079 }).id, 1);
  assert.strictEqual(displayForPoint([D1, D2], { x: 1920, y: 500 }).id, 2);
});
