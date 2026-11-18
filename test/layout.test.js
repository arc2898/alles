'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { insets, detectPanelEdge, computePillBounds, pickDisplay, DEFAULTS } = require('../src/main/overlay/layout');

const R = (x, y, width, height) => ({ x, y, width, height });
const FULL = R(0, 0, 1920, 1080);

// Realistic panel layouts, expressed the way Electron reports them.
const GNOME_TOP = R(0, 32, 1920, 1048);          // 32px top bar
const KDE_BOTTOM = R(0, 0, 1920, 1032);          // default Plasma: 48px bottom panel
const KDE_TOP = R(0, 44, 1920, 1036);            // panel moved to top
const KDE_LEFT = R(56, 0, 1864, 1080);           // vertical panel on the left
const KDE_NONE = FULL;                            // auto-hide / floating: reserves nothing

test('insets: reads each edge from bounds vs workArea', () => {
  assert.deepStrictEqual(insets(FULL, GNOME_TOP), { top: 32, left: 0, right: 0, bottom: 0 });
  assert.deepStrictEqual(insets(FULL, KDE_BOTTOM), { top: 0, left: 0, right: 0, bottom: 48 });
  assert.deepStrictEqual(insets(FULL, KDE_LEFT), { top: 0, left: 56, right: 0, bottom: 0 });
  assert.deepStrictEqual(insets(FULL, KDE_NONE), { top: 0, left: 0, right: 0, bottom: 0 });
});

test('detectPanelEdge names the panel edge and size', () => {
  assert.deepStrictEqual(detectPanelEdge(FULL, GNOME_TOP), { edge: 'top', size: 32 });
  assert.deepStrictEqual(detectPanelEdge(FULL, KDE_BOTTOM), { edge: 'bottom', size: 48 });
  assert.deepStrictEqual(detectPanelEdge(FULL, KDE_LEFT), { edge: 'left', size: 56 });
  assert.deepStrictEqual(detectPanelEdge(FULL, KDE_NONE), { edge: null, size: 0 });
});

test('GNOME: pill sits BELOW the 32px top bar, horizontally centred', () => {
  const b = computePillBounds({ bounds: FULL, workArea: GNOME_TOP });
  assert.strictEqual(b.y, 32 + DEFAULTS.gap);
  assert.strictEqual(b.x, (1920 - DEFAULTS.collapsed.width) / 2);
  assert.ok(b.y >= 32, 'must not overlap the GNOME top bar');
});

test('KDE top panel: pill clears the 44px panel', () => {
  const b = computePillBounds({ bounds: FULL, workArea: KDE_TOP });
  assert.strictEqual(b.y, 44 + DEFAULTS.gap);
});

test('KDE default bottom panel: pill hugs the very top (nothing there to avoid)', () => {
  const b = computePillBounds({ bounds: FULL, workArea: KDE_BOTTOM });
  assert.strictEqual(b.y, DEFAULTS.gap);
});

test('KDE left panel: pill centres in the USABLE area, not the full screen', () => {
  const b = computePillBounds({ bounds: FULL, workArea: KDE_LEFT });
  const expectedX = Math.round(56 + (1864 - DEFAULTS.collapsed.width) / 2);
  assert.strictEqual(b.x, expectedX);
  assert.ok(b.x >= 56, 'must not overlap the left panel');
});

test('bottom anchor places the pill above a bottom panel', () => {
  const b = computePillBounds({ bounds: FULL, workArea: KDE_BOTTOM, anchor: 'bottom' });
  assert.strictEqual(b.y + b.height + DEFAULTS.gap, 1032);
  assert.ok(b.y + b.height <= 1032);
});

test('expanded mode is larger and stays centred', () => {
  const c = computePillBounds({ bounds: FULL, workArea: GNOME_TOP, mode: 'collapsed' });
  const e = computePillBounds({ bounds: FULL, workArea: GNOME_TOP, mode: 'expanded' });
  assert.ok(e.width > c.width && e.height > c.height);
  assert.strictEqual(e.x + e.width / 2, c.x + c.width / 2, 'same centre line');
  assert.strictEqual(e.y, c.y, 'grows downward from the same top edge');
});

test('user offset nudges the pill (for auto-hide panels that report no inset)', () => {
  const base = computePillBounds({ bounds: FULL, workArea: KDE_NONE });
  const moved = computePillBounds({ bounds: FULL, workArea: KDE_NONE, offset: { x: 40, y: 30 } });
  assert.strictEqual(moved.x, base.x + 40);
  assert.strictEqual(moved.y, base.y + 30);
});

test('CLAMP: an absurd offset can never push the pill off the usable area', () => {
  for (const offset of [{ x: 99999, y: 99999 }, { x: -99999, y: -99999 }]) {
    const b = computePillBounds({ bounds: FULL, workArea: GNOME_TOP, offset, mode: 'expanded' });
    assert.ok(b.x >= GNOME_TOP.x && b.x + b.width <= GNOME_TOP.x + GNOME_TOP.width, `x out of range: ${b.x}`);
    assert.ok(b.y >= GNOME_TOP.y && b.y + b.height <= GNOME_TOP.y + GNOME_TOP.height, `y out of range: ${b.y}`);
  }
});

test('CLAMP: a window larger than the work area pins to its origin instead of NaN', () => {
  const tiny = R(0, 0, 100, 50);
  const b = computePillBounds({ bounds: tiny, workArea: tiny, mode: 'expanded' });
  assert.deepStrictEqual([b.x, b.y], [0, 0]);
  assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y));
});

test('multi-monitor: a second display with a NEGATIVE origin is handled', () => {
  const left = { id: 2, bounds: R(-1920, 0, 1920, 1080), workArea: R(-1920, 32, 1920, 1048) };
  const b = computePillBounds({ bounds: left.bounds, workArea: left.workArea });
  assert.ok(b.x >= -1920 && b.x + b.width <= 0, 'stays on the left monitor');
  assert.strictEqual(b.y, 32 + DEFAULTS.gap);
});

test('HiDPI: logical sizes are used as-is (Electron reports DIPs, so no manual scale factor)', () => {
  const dip = R(0, 0, 1920, 1080); // a 3840x2160 panel at 200% scaling reports 1920x1080
  const b = computePillBounds({ bounds: dip, workArea: R(0, 32, 1920, 1048) });
  assert.strictEqual(b.width, DEFAULTS.collapsed.width);
});

test('unknown mode is rejected', () => {
  assert.throws(() => computePillBounds({ bounds: FULL, workArea: FULL, mode: 'giant' }), /Unknown pill mode/);
});

test('pickDisplay: follows the cursor, falls back to primary', () => {
  const displays = [
    { id: 1, bounds: R(0, 0, 1920, 1080) },
    { id: 2, bounds: R(1920, 0, 1920, 1080) },
  ];
  assert.strictEqual(pickDisplay(displays, { x: 2500, y: 400 }, 1).id, 2);
  assert.strictEqual(pickDisplay(displays, { x: 100, y: 100 }, 2).id, 1);
  assert.strictEqual(pickDisplay(displays, { x: 99999, y: 99999 }, 2).id, 2, 'cursor off-screen -> primary');
  assert.strictEqual(pickDisplay(displays, { x: 99999, y: 99999 }, 42).id, 1, 'unknown primary -> first');
});

// ---- window padding (droplets + goo blur paint outside the body) ------------
const { computeWindowBounds } = require('../src/main/overlay/layout');

test('WINDOW: is the body grown by the padding, and the body offset inside it is reported', () => {
  const r = computeWindowBounds({ bounds: R(0, 0, 3000, 2000), workArea: R(0, 0, 3000, 2000), offset: { x: 0, y: 200 } });
  // far from every edge, so nothing is clamped: pure padding math
  assert.strictEqual(r.window.width, DEFAULTS.collapsed.width + DEFAULTS.padding.side * 2);
  assert.strictEqual(r.window.height, DEFAULTS.collapsed.height + DEFAULTS.padding.top + DEFAULTS.padding.bottom);
  assert.deepStrictEqual([r.body.x, r.body.y], [DEFAULTS.padding.side, DEFAULTS.padding.top]);
});

test('WINDOW: body absolute position == window origin + body offset (renderer and main agree)', () => {
  for (const wa of [GNOME_TOP, KDE_TOP, KDE_BOTTOM, KDE_LEFT, KDE_NONE]) {
    const body = computePillBounds({ bounds: FULL, workArea: wa });
    const r = computeWindowBounds({ bounds: FULL, workArea: wa });
    assert.strictEqual(r.window.x + r.body.x, body.x, 'x');
    assert.strictEqual(r.window.y + r.body.y, body.y, 'y');
  }
});

test('WINDOW: never overlaps a panel, on every layout, in both modes', () => {
  for (const wa of [GNOME_TOP, KDE_TOP, KDE_BOTTOM, KDE_LEFT]) {
    for (const mode of ['collapsed', 'expanded']) {
      const { window: w } = computeWindowBounds({ bounds: FULL, workArea: wa, mode });
      assert.ok(w.x >= wa.x && w.y >= wa.y, `window starts inside work area (${JSON.stringify(wa)})`);
      assert.ok(w.x + w.width <= wa.x + wa.width && w.y + w.height <= wa.y + wa.height, 'window ends inside work area');
    }
  }
});

test('WINDOW: body offset inside the window is never negative (body cannot be outside its own window)', () => {
  for (const wa of [GNOME_TOP, KDE_TOP, KDE_BOTTOM, KDE_LEFT, KDE_NONE]) {
    const r = computeWindowBounds({ bounds: FULL, workArea: wa });
    assert.ok(r.body.x >= 0 && r.body.y >= 0, JSON.stringify(r.body));
    assert.ok(r.body.x + r.body.width <= r.window.width && r.body.y + r.body.height <= r.window.height, 'body fits in window');
  }
});

test('WINDOW: pinned under a top panel, the available headroom is REPORTED (not silently assumed)', () => {
  // Under GNOME's bar the window is clamped to the panel edge, so the body has
  // less top room than DEFAULTS.padding.top. The renderer needs to know.
  const r = computeWindowBounds({ bounds: FULL, workArea: GNOME_TOP });
  assert.ok(r.body.y < DEFAULTS.padding.top, 'headroom is squeezed by the panel');
  assert.strictEqual(r.body.y, DEFAULTS.gap, 'exactly the configured gap remains above the body');
});
