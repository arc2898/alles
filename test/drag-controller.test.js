'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { DragController } = require('../src/main/overlay/drag-controller');
const { dockRect, CONFIG } = require('../src/main/overlay/dock');

const R = (x, y, width, height) => ({ x, y, width, height });
const FULL = R(0, 0, 1920, 1080);
const D1 = { id: 1, bounds: FULL, workArea: FULL };
const D2 = { id: 2, bounds: R(1920, 0, 1920, 1080), workArea: R(1920, 0, 1920, 1080) };
const vis = (r) => ({ x: r.x + r.inset.left, y: r.y + r.inset.top, width: r.width - r.inset.left - r.inset.right, height: r.height - r.inset.top - r.inset.bottom });

const make = (displays = [D1], opts = {}) => new DragController({ getDisplays: () => displays, ...opts });
// The pointer is pressed at screen position (x,y) on a pill whose window sits at (wx,wy). Positions are SCREEN positions:
// that is what main reads from the desktop; the page's own coordinates are never used.
const START = { x: 800, y: 36 };
const press = (dc, { x = START.x, y = START.y, wx = 700, wy = 6, edge = 'top' } = {}) => dc.press({ pointer: { x, y }, win: { x: wx, y: wy }, currentEdge: edge });
const at = (x, y) => ({ pointer: { x, y } });
const by = (dx, dy, from = START) => at(from.x + dx, from.y + dy);

test('a press with no movement is a CLICK on release', () => {
  const dc = make(); press(dc);
  assert.deepStrictEqual(dc.release(), { kind: 'click' });
});

test('CLICK vs DRAG: movement under the threshold is still a click (a hand always wobbles)', () => {
  const dc = make(); press(dc);
  assert.deepStrictEqual(dc.move(by(3, 2)), { dragging: false });   // ~3.6px
  assert.deepStrictEqual(dc.move(by(4, 4)), { dragging: false });   // ~5.7px
  assert.deepStrictEqual(dc.release(), { kind: 'click' });
});

test('CLICK vs DRAG: crossing the threshold starts a drag, and it stays a drag even if you return', () => {
  const dc = make(); press(dc);
  assert.strictEqual(dc.move(by(20, 0)).dragging, true);
  assert.strictEqual(dc.move(by(0, 0)).dragging, true, 'back at the start, still dragging');
  assert.strictEqual(dc.release().kind, 'drop');
});

test('the window follows the pointer exactly: where it started + how far the pointer has travelled', () => {
  const dc = make(); press(dc, { wx: 700, wy: 6 });
  const m = dc.move(by(60, 60));
  assert.deepStrictEqual([m.x, m.y], [700 + 60, 6 + 60]);
});

test('THE REAL BUG: the answer does not depend on where the window is NOW - a window that has already moved under the pointer is not chased again', () => {
  // Measured on a real GNOME desktop: the page reported coordinates relative to the (moving) window, the window was moved
  // by the change in those, and so it kept undoing its own progress and fell hundreds of pixels behind the pointer.
  // The controller must give the same place for the same pointer however many times it is asked, and however the window moved.
  const dc = make(); press(dc, { wx: 700, wy: 6 });
  const first = dc.move(by(300, 200));
  for (let i = 0; i < 5; i++) assert.deepStrictEqual(dc.move(by(300, 200)), first, 'asking again moves it nowhere new');
  // a hand sweeping across the screen: after every single step the window sits exactly one pointer-travel from its origin
  const path = []; for (let i = 1; i <= 40; i++) path.push([START.x + i * 30, START.y + i * 7]);
  for (const [px, py] of path) {
    const m = dc.move(at(px, py));
    assert.deepStrictEqual([m.x, m.y], [700 + (px - START.x), 6 + (py - START.y)], `at pointer ${px},${py}`);
  }
});

test('move before any press does nothing', () => {
  const dc = make();
  assert.deepStrictEqual(dc.move(at(500, 500)), { dragging: false });
  assert.deepStrictEqual(dc.release(), { kind: 'click' });
});

test('a live snap preview is produced while dragging, and it names the nearest edge', () => {
  const dc = make(); press(dc);
  // Drag the pill down-left toward the left edge, well away from the top
  const m = dc.move(by(-790, 400));
  assert.strictEqual(m.dragging, true);
  assert.strictEqual(m.preview.edge, 'left');
  assert.strictEqual(m.preview.display, 1);
  assert.ok(m.preview.along >= 0 && m.preview.along <= 1);
});

test('release after a drag commits {edge, along, display}', () => {
  const dc = make(); press(dc);
  dc.move(by(900, 0));                                           // far right along the top
  const r = dc.release();
  assert.strictEqual(r.kind, 'drop');
  assert.strictEqual(r.edge, 'top');
  assert.ok(r.along > 0.6, `expected far right, got ${r.along}`);
});

test('the DROP uses where the pointer is at release, which can be past the last move that was reported', () => {
  const dc = make(); press(dc);
  dc.move(by(700, 400));                                         // last reported move: pointer at (1500, 436): nearer the top than the right
  assert.strictEqual(dc.preview.edge, 'top');
  const r = dc.release(at(1915, 436));                           // ...but the hand let go against the right edge
  assert.strictEqual(r.kind, 'drop');
  assert.strictEqual(r.edge, 'right');
});

test('releasing with no (or an unusable) pointer position falls back to the last preview', () => {
  for (const given of [undefined, {}, { pointer: null }, { pointer: { x: NaN, y: 3 } }, { pointer: { x: 'a', y: 3 } }]) {
    const dc = make(); press(dc); dc.move(by(900, 0));
    const r = dc.release(given);
    assert.strictEqual(r.kind, 'drop', JSON.stringify(given)); assert.strictEqual(r.edge, 'top', JSON.stringify(given));
  }
});

test('a release that follows no drag ignores the pointer it is given (a click stays a click)', () => {
  const dc = make(); press(dc); dc.move(by(2, 1));
  assert.deepStrictEqual(dc.release(at(1915, 500)), { kind: 'click' });
});

test('an unusable pointer position never starts, moves or ends anything', () => {
  for (const bad of [undefined, null, {}, { x: NaN, y: 1 }, { x: 1, y: Infinity }, { x: '5', y: 5 }]) {
    const dc = make(); dc.press({ pointer: bad, win: { x: 1, y: 1 } });
    assert.strictEqual(dc.state, 'idle', `a press at ${JSON.stringify(bad)} must not arm a drag`);
    assert.deepStrictEqual(dc.release(), { kind: 'click' });
  }
  const dc = make(); dc.press({ pointer: { x: 5, y: 5 }, win: null });
  assert.strictEqual(dc.state, 'idle', 'no window position either');
  const p = make(); press(p);
  assert.deepStrictEqual(p.move({ pointer: { x: NaN, y: 1 } }), { dragging: false }, 'while only pressed');
  const first = p.move(by(50, 0)); assert.strictEqual(first.dragging, true);
  assert.deepStrictEqual(p.move({ pointer: null }), first, 'while dragging it just holds still');
  assert.deepStrictEqual(p.move(), first, 'no argument at all');
});

test('after release the controller is idle and ready for a new drag', () => {
  const dc = make(); press(dc); dc.move(by(300, 0)); dc.release();
  assert.strictEqual(dc.state, 'idle');
  press(dc); assert.strictEqual(dc.state, 'pressed');
});

test('cancel (Escape / lost capture) mid-drag abandons it and commits nothing', () => {
  const dc = make(); press(dc); dc.move(by(500, 200));
  assert.deepStrictEqual(dc.cancel(), { kind: 'cancelled' });
  assert.deepStrictEqual(dc.release(), { kind: 'click' }, 'a later release must not commit the abandoned drag');
  assert.deepStrictEqual(dc.cancel(), { kind: 'none' }, 'cancelling when idle is harmless');
});

test('every edge is reachable by dragging toward it', () => {
  const targets = { top: [0, -300], bottom: [0, 900], left: [-900, 300], right: [900, 300] };
  for (const [edge, [dx, dy]] of Object.entries(targets)) {
    const dc = make([D1]); press(dc, { x: 1000, y: 530, wx: 900, wy: 500, edge: null });
    dc.move(by(dx, dy, { x: 1000, y: 530 }));
    assert.strictEqual(dc.release().edge, edge, `dragging by (${dx},${dy}) should reach ${edge}`);
  }
});

test('STICKY CORNERS across a whole drag: wobbling around a corner switches edge at most once', () => {
  const dc = make(); press(dc, { x: 800, y: 36, wx: 700, wy: 6 });
  let last = null, switches = 0;
  for (let i = 0; i < 300; i++) {
    // Pointer (screen) travels toward the top-left corner, jittering +/-7px around the diagonal.
    const sx = 700 + 100 - i * 2.2 + (i % 2 ? 7 : -7);
    const sy = 6 + 30 + 60 - i * 0.2 + (i % 2 ? -7 : 7);
    const m = dc.move(at(sx, sy));
    if (!m.dragging) continue;
    if (last && m.preview.edge !== last) switches++;
    last = m.preview.edge;
  }
  assert.ok(switches <= 1, `edge flipped ${switches} times during a shaky corner drag`);
});

test('MULTI-MONITOR: dragging onto the second display re-homes the dock there', () => {
  const dc = make([D1, D2]); press(dc, { x: 1800, y: 36, wx: 1700, wy: 6 });
  dc.move(at(2400, 36));                                         // pointer ends up at x ~ 2400
  const r = dc.release();
  assert.strictEqual(r.kind, 'drop');
  assert.strictEqual(r.display, 2);
  assert.strictEqual(r.edge, 'top');
});

test('MULTI-MONITOR: dropping in the gap/off-screen snaps to the nearest display instead of failing', () => {
  const left = { id: 1, bounds: R(0, 0, 1000, 1000), workArea: R(0, 0, 1000, 1000) };
  const right = { id: 2, bounds: R(1200, 0, 1000, 1000), workArea: R(1200, 0, 1000, 1000) };
  const dc = make([left, right]); press(dc, { x: 150, y: 26, wx: 100, wy: 6 });
  dc.move(at(1180, 26));                                         // pointer at x ~ 1180: in the gap, nearer `right`
  assert.strictEqual(dc.release().display, 2);
});

test('no displays available -> the drag cannot commit, and does not throw', () => {
  const dc = make([]); press(dc); dc.move(by(300, 160));
  assert.deepStrictEqual(dc.release(), { kind: 'click' }, 'nothing to snap to, so nothing is committed');
});

test('ROUND TRIP: drag to a spot, drop, rebuild the dock from what was saved - it lands where you dropped it', () => {
  const cases = [
    { from: { wx: 730, wy: 6 }, by: [-400, 0], edge: 'top' },     // slide left along the top
    { from: { wx: 730, wy: 6 }, by: [500, 0], edge: 'top' },      // slide right along the top
    { from: { wx: 730, wy: 6 }, by: [-700, 400], edge: 'left' },  // swing to the left side
    { from: { wx: 730, wy: 6 }, by: [960, 350], edge: 'right' },  // swing to the right side (pointer ends ~120px from it)
    { from: { wx: 730, wy: 6 }, by: [700, 300], edge: 'top' },    // same direction but stopping short: nearer the top, so it must NOT jump to the right
    { from: { wx: 730, wy: 6 }, by: [0, 1000], edge: 'bottom' },  // all the way down
  ];
  for (const c of cases) {
    const dc = make(); const s = { x: c.from.wx + 100, y: c.from.wy + 30 };
    press(dc, { ...s, ...c.from });
    const m = dc.move(by(c.by[0], c.by[1], s));
    const drop = dc.release();
    assert.strictEqual(drop.edge, c.edge, JSON.stringify(c));
    // The pointer's screen position at the drop:
    const pointer = { x: s.x + c.by[0], y: s.y + c.by[1] };
    const v = vis(dockRect({ phase: 'island', edge: drop.edge, along: drop.along, workArea: FULL }));
    const vertical = drop.edge === 'left' || drop.edge === 'right';
    const centre = vertical ? v.y + v.height / 2 : v.x + v.width / 2;
    const want = vertical ? pointer.y : pointer.x;
    // Allowed to differ only where the island would otherwise hang off-screen.
    const half = ((vertical ? CONFIG.island.height : CONFIG.island.width) + CONFIG.pad * 2) / 2;
    const lo = half, hi = (vertical ? 1080 : 1920) - half;
    const expected = Math.min(Math.max(want, lo), hi);
    assert.ok(Math.abs(centre - expected) <= 1, `${JSON.stringify(c)}: dropped at ${want}, restored at ${centre}, expected ${expected}`);
    void m;
  }
});

test('threshold is configurable', () => {
  const dc = make([D1], { threshold: 30 }); press(dc);
  assert.strictEqual(dc.move(by(20, 0)).dragging, false, '20px < 30px threshold');
  assert.strictEqual(dc.move(by(40, 0)).dragging, true, '40px >= 30px threshold');
});
