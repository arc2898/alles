'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Dock, dockRect, bulgeDirection, edgeInset, edgeInsets, freeEdge, resolvePlacement, CONFIG, EDGES, ALIGNS } = require('../src/main/overlay/dock');

const R = (x, y, width, height) => ({ x, y, width, height });
const FULL = R(0, 0, 1920, 1080);
const GNOME_TOP = R(0, 32, 1920, 1048);
const KDE_BOTTOM = R(0, 0, 1920, 1032);
const KDE_LEFT = R(56, 0, 1864, 1080);

// dockRect returns the WINDOW (visible pill + transparent padding) and the inset.
// Behavioural assertions are about what the user SEES, so derive the visible rect.
const vis = (r) => ({ x: r.x + r.inset.left, y: r.y + r.inset.top, width: r.width - r.inset.left - r.inset.right, height: r.height - r.inset.top - r.inset.bottom });

function make({ busy = false } = {}) {
  let t = 1_000_000;
  const phases = [];
  const state = { busy };
  const dock = new Dock({
    now: () => t,
    busy: () => state.busy,
    onPhase: (p, prev) => phases.push(`${prev}>${p}`),
  });
  return { dock, phases, state, advance: (ms) => { t += ms; return dock.tick(); } };
}

// ---------------------------------------------------------------- state machine

test('starts hidden', () => {
  assert.strictEqual(make().dock.phase, 'hidden');
});

test('REVEAL: pointer must dwell on the strip; a fly-by does nothing', () => {
  const { dock, advance } = make();
  dock.pointerEnter();
  assert.strictEqual(advance(CONFIG.dwellMs - 1), 'hidden', 'not yet');
  assert.strictEqual(advance(1), 'peek', 'dwell reached');
});

test('REVEAL: leaving before the dwell time cancels it, and the timer restarts on re-entry', () => {
  const { dock, advance } = make();
  dock.pointerEnter(); advance(CONFIG.dwellMs - 20);
  dock.pointerLeave(); assert.strictEqual(advance(500), 'hidden');
  dock.pointerEnter();
  assert.strictEqual(advance(CONFIG.dwellMs - 1), 'hidden', 'dwell must restart from zero, not resume');
  assert.strictEqual(advance(1), 'peek');
});

test('CLICK: peek -> island; a second click collapses back to peek', () => {
  const { dock, advance } = make();
  dock.pointerEnter(); advance(CONFIG.dwellMs);
  dock.click(); assert.strictEqual(dock.phase, 'island');
  dock.click(); assert.strictEqual(dock.phase, 'peek');
});

test('CLICK: clicking the 3px hidden strip opens the island directly (no dead click)', () => {
  const { dock } = make();
  dock.click();
  assert.strictEqual(dock.phase, 'island');
});

test('HIDE: pointer leaving a peek hides it only after the grace delay', () => {
  const { dock, advance } = make();
  dock.pointerEnter(); advance(CONFIG.dwellMs);
  dock.pointerLeave();
  assert.strictEqual(advance(CONFIG.hideDelayMs - 1), 'peek');
  assert.strictEqual(advance(1), 'hidden');
});

test('HIDE: coming back within the grace period keeps it open (no flicker on a jittery mouse)', () => {
  const { dock, advance } = make();
  dock.pointerEnter(); advance(CONFIG.dwellMs);
  dock.pointerLeave(); advance(CONFIG.hideDelayMs - 50);
  dock.pointerEnter();
  assert.strictEqual(advance(2000), 'peek', 'still open after a long time with pointer inside');
});

test('HIDE: the island also auto-hides after the pointer leaves', () => {
  const { dock, advance } = make();
  dock.click(); dock.pointerLeave();
  assert.strictEqual(advance(CONFIG.hideDelayMs), 'hidden');
});

test('BUSY: the island NEVER auto-hides while the agent is working or awaiting approval', () => {
  const { dock, state, advance } = make({ busy: true });
  dock.summon(); dock.pointerLeave();
  assert.strictEqual(advance(60_000), 'island', 'stays open a full minute');
  state.busy = false;
  assert.strictEqual(advance(1), 'hidden', 'hides as soon as the agent is no longer busy');
});

test('BUSY: an explicit dismiss (Esc) still closes it - the user is always in control', () => {
  const { dock, state } = make({ busy: true });
  dock.summon();
  dock.dismiss();
  assert.strictEqual(dock.phase, 'hidden');
  void state;
});

test('SUMMON: opens the island from hidden (e.g. approval needed while nobody is hovering)', () => {
  const { dock } = make();
  dock.summon();
  assert.strictEqual(dock.phase, 'island');
});

// ---- an island opened WITHOUT the pointer (the keyboard, or the agent has news) ------------------------------------------
// MEASURED on a real GNOME Shell: when the pointer had visited the pill earlier, an island opened from the keyboard was shut
// again by the hide timer within one 50 ms tick - it still held the time of that OLD visit ("the pointer left a minute ago")
// - and about half of all "launch ALLES again to open the island" did nothing. Which half depended on timing alone.

const visitedAndLeft = (m) => {
  m.dock.pointerEnter(); m.advance(CONFIG.dwellMs); m.dock.pointerLeave(); m.advance(CONFIG.hideDelayMs);
  assert.strictEqual(m.dock.phase, 'hidden', 'setup: the earlier visit is over');
};

test('SUMMON: an island opened after the pointer visited and left earlier is NOT shut by that old visit (the real bug)', () => {
  const m = make(); visitedAndLeft(m);
  m.dock.summon();
  assert.strictEqual(m.advance(50), 'island', 'the very next tick');
  assert.strictEqual(m.advance(CONFIG.summonHoldMs - 51), 'island', 'and for the whole hold');
});

test('SUMMON: when the hold is over it hides like any island nobody is pointing at', () => {
  const m = make(); visitedAndLeft(m);
  m.dock.summon();
  assert.strictEqual(m.advance(CONFIG.summonHoldMs - 1), 'island');
  assert.strictEqual(m.advance(1), 'hidden');
});

test('SUMMON: a dock that never saw the pointer hides after the hold too (it is not stuck open for ever)', () => {
  const m = make();
  m.dock.summon();
  assert.strictEqual(m.advance(CONFIG.summonHoldMs - 1), 'island');
  assert.strictEqual(m.advance(1), 'hidden');
});

test('SUMMON: the pointer being on it keeps it open past the hold; leaving closes it after the usual grace', () => {
  const m = make(); m.dock.summon(); m.dock.pointerEnter();
  assert.strictEqual(m.advance(CONFIG.summonHoldMs * 3), 'island');
  m.dock.pointerLeave();
  assert.strictEqual(m.advance(CONFIG.hideDelayMs - 1), 'island');
  assert.strictEqual(m.advance(1), 'hidden');
});

test('SUMMON: the agent being busy still keeps it open past the hold, and it goes the moment the agent is done', () => {
  const m = make(); visitedAndLeft(m);
  m.state.busy = true;
  m.dock.summon();
  assert.strictEqual(m.advance(CONFIG.summonHoldMs * 5), 'island');
  m.state.busy = false;
  assert.strictEqual(m.advance(1), 'hidden');
});

test('SUMMON: summoning again while it is open starts the hold over (news arriving late is not cut short)', () => {
  const m = make();
  m.dock.summon(); m.advance(CONFIG.summonHoldMs - 1000);
  m.dock.summon();
  assert.strictEqual(m.advance(CONFIG.summonHoldMs - 1), 'island', 'a full hold from the second summon');
  assert.strictEqual(m.advance(1), 'hidden');
});

test('SUMMON from a peek pill: the pill grows into the island and the hold applies to it', () => {
  const m = make(); m.dock.pointerEnter(); m.advance(CONFIG.dwellMs); m.dock.pointerLeave(); m.advance(10);
  assert.strictEqual(m.dock.phase, 'peek');
  m.dock.summon();
  assert.strictEqual(m.dock.phase, 'island');
  assert.strictEqual(m.advance(CONFIG.summonHoldMs - 10), 'island');
});

test('SUMMON(Infinity), the keyboard asking: it stays until it is dismissed, however long nobody touches it', () => {
  const m = make(); visitedAndLeft(m);
  m.dock.summon(Infinity);
  assert.strictEqual(m.advance(10 * 60_000), 'island', 'ten minutes');
  m.dock.dismiss();
  assert.strictEqual(m.dock.phase, 'hidden', 'Esc / the shortcut again / a click elsewhere still close it');
});

test('SUMMON(Infinity): a pointer that merely brushes past (enter, leave) does not shorten it', () => {
  // XWayland sends such crossings when a window appears or resizes near where it last saw the pointer - measured.
  const m = make(); m.dock.summon(Infinity);
  m.advance(10); m.dock.pointerEnter(); m.advance(20); m.dock.pointerLeave();
  assert.strictEqual(m.advance(60_000), 'island');
});

test('SUMMON(Infinity): clicking the pill hands it back to the usual rules (no hold is left over)', () => {
  const m = make(); m.dock.summon(Infinity);
  m.dock.click();
  assert.strictEqual(m.dock.phase, 'peek');
  m.dock.pointerLeave();
  assert.strictEqual(m.advance(CONFIG.hideDelayMs), 'hidden');
});

test('SUMMON: a hold belongs to ONE opening - after a dismiss, an island opened by hovering is not held', () => {
  const m = make(); m.dock.summon(Infinity); m.dock.dismiss();
  m.dock.pointerEnter(); m.advance(CONFIG.dwellMs); m.dock.click();
  assert.strictEqual(m.dock.phase, 'island');
  m.dock.pointerLeave();
  assert.strictEqual(m.advance(CONFIG.hideDelayMs), 'hidden');
});

test('SUMMON: an ordinary summon never shortens a hold that is for ever (the agent finishes after the keyboard opened it)', () => {
  const m = make(); m.dock.summon(Infinity); m.advance(1000);
  m.dock.summon();
  assert.strictEqual(m.advance(10 * 60_000), 'island');
});

test('SUMMON: an odd hold length means the standard hold (never a silent zero)', () => {
  for (const odd of [NaN, -5, 0, 'soon', null, {}, undefined]) {
    const m = make(); visitedAndLeft(m);
    m.dock.summon(odd);
    assert.strictEqual(m.advance(CONFIG.summonHoldMs - 1), 'island', `hold given as ${String(odd)}`);
    assert.strictEqual(m.advance(1), 'hidden', `hold given as ${String(odd)}`);
  }
});

test('SUMMON: a short hold still gives the usual grace before hiding (never hides sooner than the pointer rule would)', () => {
  const m = make(); m.dock.summon(100);
  assert.strictEqual(m.advance(CONFIG.hideDelayMs - 1), 'island');
  assert.strictEqual(m.advance(1), 'hidden');
});

test('dismiss on an already hidden dock is a no-op (no spurious phase event)', () => {
  const { dock, phases } = make();
  dock.dismiss();
  assert.deepStrictEqual(phases, []);
});

test('phase callback fires once per real change, with the previous phase', () => {
  const { dock, phases, advance } = make();
  dock.pointerEnter(); advance(CONFIG.dwellMs); advance(50); advance(50); // extra ticks must not re-fire
  dock.click();
  dock.pointerLeave(); advance(CONFIG.hideDelayMs);
  assert.deepStrictEqual(phases, ['hidden>peek', 'peek>island', 'island>hidden']);
});

test('pointer already inside when the island collapses does not hide it', () => {
  const { dock, advance } = make();
  dock.click(); dock.pointerEnter();
  assert.strictEqual(advance(10_000), 'island');
});

// ---------------------------------------------------------------- geometry

test('inset reads the panel on each edge', () => {
  assert.strictEqual(edgeInset('top', FULL, GNOME_TOP), 32);
  assert.strictEqual(edgeInset('bottom', FULL, KDE_BOTTOM), 48);
  assert.strictEqual(edgeInset('left', FULL, KDE_LEFT), 56);
  assert.strictEqual(edgeInset('right', FULL, KDE_LEFT), 0);
  assert.throws(() => edgeInset('middle', FULL, FULL), /Unknown edge/);
});

test('GNOME: hidden strip sits flush against the bottom of the 32px bar, not under it', () => {
  const r = dockRect({ phase: 'hidden', edge: 'top', workArea: GNOME_TOP });
  assert.strictEqual(r.y, 32);
  assert.strictEqual(r.height, CONFIG.strip);
  assert.strictEqual(r.width, CONFIG.stripLength);
});

test('GNOME: the VISIBLE peek and island clear the bar by exactly the gap', () => {
  for (const phase of ['peek', 'island']) {
    const r = dockRect({ phase, edge: 'top', workArea: GNOME_TOP });
    assert.strictEqual(vis(r).y, 32 + CONFIG.gap, `${phase} visible clearance`);
    assert.ok(r.y >= 32, `${phase}: the transparent window must not overlap the bar either`);
  }
});

test('CLEARANCE: on every edge the visible pill is exactly `gap` from the panel, never more', () => {
  const cases = [
    ['top', GNOME_TOP, (v) => v.y - 32],
    ['bottom', KDE_BOTTOM, (v) => 1032 - (v.y + v.height)],
    ['left', KDE_LEFT, (v) => v.x - 56],
    ['right', FULL, (v) => 1920 - (v.x + v.width)],
  ];
  for (const [edge, wa, clearance] of cases) {
    for (const phase of ['peek', 'island']) {
      assert.strictEqual(clearance(vis(dockRect({ phase, edge, workArea: wa }))), CONFIG.gap, `${edge}/${phase}`);
    }
  }
});

test('PADDING: the far side keeps full room for droplets; the panel side keeps only the gap', () => {
  const { inset } = dockRect({ phase: 'peek', edge: 'top', workArea: GNOME_TOP });
  assert.deepStrictEqual(inset, { top: CONFIG.gap, right: CONFIG.pad, bottom: CONFIG.pad, left: CONFIG.pad });
  assert.deepStrictEqual(dockRect({ phase: 'peek', edge: 'bottom', workArea: KDE_BOTTOM }).inset.top, CONFIG.pad);
  assert.deepStrictEqual(dockRect({ phase: 'hidden', edge: 'top', workArea: GNOME_TOP }).inset, { top: 0, right: 0, bottom: 0, left: 0 }, 'hidden strip is unpadded');
});

test('KDE bottom panel: a bottom dock sits ABOVE the panel', () => {
  for (const phase of ['hidden', 'peek', 'island']) {
    const r = dockRect({ phase, edge: 'bottom', workArea: KDE_BOTTOM });
    assert.ok(r.y + r.height <= 1032, `${phase} overlaps the panel: bottom edge ${r.y + r.height}`);
  }
});

test('KDE left panel: a left dock sits to the RIGHT of the panel and keeps a READABLE horizontal shape', () => {
  const raw = dockRect({ phase: 'peek', edge: 'left', workArea: KDE_LEFT });
  const peek = vis(raw);
  assert.ok(raw.x >= 56, 'window does not overlap the panel');
  // Regression: side docks used to be rotated into a tall column, which squeezed the text to "Cli...".
  assert.deepStrictEqual([peek.width, peek.height], [CONFIG.peek.width, CONFIG.peek.height], 'same shape as a top dock');
  const isl = vis(dockRect({ phase: 'island', edge: 'left', workArea: KDE_LEFT }));
  assert.ok(isl.width >= isl.height, 'island is wider than tall, so the text stays readable');
  const strip = dockRect({ phase: 'hidden', edge: 'left', workArea: KDE_LEFT });
  assert.strictEqual(strip.x, 56);
  assert.strictEqual(strip.width, CONFIG.strip, 'only the hidden hit strip is oriented along the edge');
  assert.ok(strip.height > strip.width, 'a side strip is tall and thin');
});

test('right edge: dock is flush to the right side of the work area', () => {
  const strip = dockRect({ phase: 'hidden', edge: 'right', workArea: FULL });
  assert.strictEqual(strip.x + strip.width, 1920);
  const raw = dockRect({ phase: 'peek', edge: 'right', workArea: FULL });
  assert.strictEqual(raw.x + raw.width, 1920, 'window is flush to the right edge');
  assert.strictEqual(1920 - (vis(raw).x + vis(raw).width), CONFIG.gap, 'visible pill is `gap` in from it');
});

test('along: 0 / 0.5 / 1 slides the dock between the ends and never past them', () => {
  const isl = (along) => dockRect({ phase: 'island', edge: 'top', workArea: FULL, along });
  const mid = (r) => vis(r).x + vis(r).width / 2;
  assert.strictEqual(mid(isl(0.5)), 960, 'centred');
  assert.strictEqual(isl(0).x, 0, 'the ISLAND window reaches the left end (it is the largest shape)');
  assert.strictEqual(isl(1).x + isl(1).width, 1920, 'and the right end');
  assert.strictEqual(isl(-5).x, 0, 'clamped low');
  assert.strictEqual(isl(99).x + isl(99).width, 1920, 'clamped high');
  // Smaller phases share the island's centre, so they are inset from the corner - by design (see the EXACT test).
  const peek0 = vis(dockRect({ phase: 'peek', edge: 'top', workArea: FULL, along: 0 }));
  assert.ok(peek0.x > vis(isl(0)).x, 'the compact pill sits inside the corner so it grows in place');
  assert.ok(peek0.x >= 0);
});

test('the strip and the peek are centred on the SAME point, so the pill grows from where the cursor is', () => {
  const s = dockRect({ phase: 'hidden', edge: 'top', workArea: FULL });
  const p = dockRect({ phase: 'peek', edge: 'top', workArea: FULL });
  const i = dockRect({ phase: 'island', edge: 'top', workArea: FULL });
  const mid = (r) => r.x + r.width / 2;
  assert.strictEqual(mid(s), mid(p));
  assert.strictEqual(mid(p), mid(i));
});

test('every phase on every edge stays inside the work area (multi-monitor, negative origin too)', () => {
  const left = R(-1920, 32, 1920, 1048);
  for (const wa of [FULL, GNOME_TOP, KDE_BOTTOM, KDE_LEFT, left]) {
    for (const edge of ['top', 'bottom', 'left', 'right']) {
      for (const phase of ['hidden', 'peek', 'island']) {
        for (const along of [0, 0.5, 1]) {
          const r = dockRect({ phase, edge, workArea: wa, along });
          assert.ok(r.x >= wa.x && r.y >= wa.y && r.x + r.width <= wa.x + wa.width && r.y + r.height <= wa.y + wa.height,
            `${phase}/${edge}/${along} escaped ${JSON.stringify(wa)}: ${JSON.stringify(r)}`);
        }
      }
    }
  }
});

test('unknown phase / edge are rejected', () => {
  assert.throws(() => dockRect({ phase: 'giant', edge: 'top', workArea: FULL }), /Unknown phase/);
  assert.throws(() => dockRect({ phase: 'peek', edge: 'diagonal', workArea: FULL }), /Unknown edge/);
});

test('droplets bulge AWAY from the docked edge (the edge side has no headroom)', () => {
  assert.strictEqual(bulgeDirection('top'), 'down');
  assert.strictEqual(bulgeDirection('bottom'), 'up');
  assert.strictEqual(bulgeDirection('left'), 'right');
  assert.strictEqual(bulgeDirection('right'), 'left');
});

// ------------------------------------------------------------ placement (edge x align)

test('resolvePlacement: named aligns map to 0 / 0.5 / 1', () => {
  assert.deepStrictEqual(resolvePlacement({ edge: 'top', align: 'start' }), { edge: 'top', along: 0 });
  assert.deepStrictEqual(resolvePlacement({ edge: 'left', align: 'center' }), { edge: 'left', along: 0.5 });
  assert.deepStrictEqual(resolvePlacement({ edge: 'right', align: 'end' }), { edge: 'right', along: 1 });
});

test('resolvePlacement: a raw numeric `along` is honoured and clamped (fine-tune slider)', () => {
  assert.strictEqual(resolvePlacement({ edge: 'top', along: 0.25 }).along, 0.25);
  assert.strictEqual(resolvePlacement({ edge: 'top', along: -3 }).along, 0);
  assert.strictEqual(resolvePlacement({ edge: 'top', along: 42 }).along, 1);
});

test('resolvePlacement: a named align wins over a stale numeric along', () => {
  assert.strictEqual(resolvePlacement({ edge: 'top', align: 'end', along: 0.1 }).along, 1);
});

test('resolvePlacement: garbage from a hand-edited settings file falls back to top-center, never throws', () => {
  for (const bad of [undefined, null, {}, { edge: 'diagonal' }, { edge: 7, align: 'middle' }, { align: 'nope' }, { edge: 'top', along: NaN }, { edge: 'top', along: 'left' }]) {
    const r = resolvePlacement(bad);
    assert.ok(EDGES.includes(r.edge), JSON.stringify(bad));
    assert.ok(r.along >= 0 && r.along <= 1 && Number.isFinite(r.along), JSON.stringify(bad));
  }
  assert.deepStrictEqual(resolvePlacement({}), { edge: 'top', along: 0.5 });
  assert.deepStrictEqual(resolvePlacement({ edge: 'left', align: 'wat' }), { edge: 'left', along: 0.5 });
});

test('ALL 12 POSITIONS x ALL 3 PHASES: the window stays on-screen and the visible pill clears a panel by exactly `gap`', () => {
  const layouts = [
    ['no panel', FULL],
    ['GNOME top bar', GNOME_TOP],
    ['KDE bottom panel', KDE_BOTTOM],
    ['KDE left panel', KDE_LEFT],
    ['second monitor, negative origin', R(-1920, 32, 1920, 1048)],
  ];
  let checked = 0;
  for (const [name, wa] of layouts) {
    for (const edge of EDGES) {
      for (const align of Object.keys(ALIGNS)) {
        for (const phase of ['hidden', 'peek', 'island']) {
          const { along } = resolvePlacement({ edge, align });
          const r = dockRect({ phase, edge, along, workArea: wa });
          const where = `${name} / ${edge}-${align} / ${phase}`;
          assert.ok(r.x >= wa.x && r.y >= wa.y && r.x + r.width <= wa.x + wa.width && r.y + r.height <= wa.y + wa.height, `${where} escaped the work area: ${JSON.stringify(r)}`);
          if (phase !== 'hidden') {
            const v = vis(r);
            const dist = { top: v.y - wa.y, bottom: wa.y + wa.height - (v.y + v.height), left: v.x - wa.x, right: wa.x + wa.width - (v.x + v.width) }[edge];
            assert.strictEqual(dist, CONFIG.gap, `${where} clearance`);
          }
          checked++;
        }
      }
    }
  }
  assert.strictEqual(checked, layouts.length * 4 * 3 * 3);
});

test('corner placements: the ISLAND fills the corner, on all four corners', () => {
  const isl = (edge, align) => vis(dockRect({ phase: 'island', edge, along: ALIGNS[align], workArea: FULL }));
  assert.strictEqual(isl('top', 'start').x, CONFIG.pad, 'top-left');
  const tr = isl('top', 'end'); assert.strictEqual(tr.x + tr.width, 1920 - CONFIG.pad, 'top-right');
  const bl = isl('bottom', 'start'); assert.strictEqual(bl.x, CONFIG.pad); assert.strictEqual(bl.y + bl.height, 1080 - CONFIG.gap, 'bottom-left');
  const br = isl('bottom', 'end'); assert.strictEqual(br.x + br.width, 1920 - CONFIG.pad); assert.strictEqual(br.y + br.height, 1080 - CONFIG.gap, 'bottom-right');
});

test('side docks: start/center/end run TOP -> MIDDLE -> BOTTOM along the edge', () => {
  const y = (align) => vis(dockRect({ phase: 'peek', edge: 'left', along: ALIGNS[align], workArea: FULL })).y;
  assert.ok(y('start') < y('center') && y('center') < y('end'));
  assert.strictEqual(y('center') + CONFIG.peek.height / 2, 1080 / 2, 'centre is the vertical middle');
});

test('EXACT: the strip, peek and island share ONE centre for every edge/align/layout (pill appears under the cursor)', () => {
  // Regression: the strip used to sit at the raw `along` position while the pill was pushed
  // inward near a corner, so the pill materialised up to 100px away from where you hit it.
  for (const wa of [FULL, GNOME_TOP, KDE_BOTTOM, KDE_LEFT, R(-1920, 32, 1920, 1048)]) {
    for (const edge of EDGES) {
      for (const align of Object.keys(ALIGNS)) {
        const { along } = resolvePlacement({ edge, align });
        const vertical = edge === 'left' || edge === 'right';
        const c = (phase) => { const r = dockRect({ phase, edge, along, workArea: wa }); const v = phase === 'hidden' ? r : vis(r); return vertical ? v.y + v.height / 2 : v.x + v.width / 2; };
        assert.strictEqual(c('hidden'), c('peek'), `${edge}-${align} strip vs peek in ${JSON.stringify(wa)}`);
        assert.strictEqual(c('peek'), c('island'), `${edge}-${align} peek vs island in ${JSON.stringify(wa)}`);
      }
    }
  }
});

test('STRIP: the hidden hit target is exactly 2px thick x 8px long, oriented along the edge', () => {
  const top = dockRect({ phase: 'hidden', edge: 'top', workArea: FULL });
  assert.deepStrictEqual([top.width, top.height], [8, 2], 'top: 8 wide, 2 tall');
  const left = dockRect({ phase: 'hidden', edge: 'left', workArea: FULL });
  assert.deepStrictEqual([left.width, left.height], [2, 8], 'left: 2 wide, 8 tall');
  for (const edge of EDGES) assert.deepStrictEqual(dockRect({ phase: 'hidden', edge, workArea: FULL }).inset, { top: 0, right: 0, bottom: 0, left: 0 });
});

test('STRIP: flush against its edge / panel on all four sides (no gap, so the cursor can reach it)', () => {
  const t = dockRect({ phase: 'hidden', edge: 'top', workArea: GNOME_TOP }); assert.strictEqual(t.y, 32);
  const b = dockRect({ phase: 'hidden', edge: 'bottom', workArea: KDE_BOTTOM }); assert.strictEqual(b.y + b.height, 1032);
  const l = dockRect({ phase: 'hidden', edge: 'left', workArea: KDE_LEFT }); assert.strictEqual(l.x, 56);
  const r = dockRect({ phase: 'hidden', edge: 'right', workArea: FULL }); assert.strictEqual(r.x + r.width, 1920);
});

test('STRIP: a corner-start dock still keeps the strip fully on-screen', () => {
  for (const edge of EDGES) for (const align of ['start', 'end']) {
    const { along } = resolvePlacement({ edge, align });
    const s = dockRect({ phase: 'hidden', edge, along, workArea: FULL });
    assert.ok(s.x >= 0 && s.y >= 0 && s.x + s.width <= 1920 && s.y + s.height <= 1080, `${edge}-${align}: ${JSON.stringify(s)}`);
  }
});


// ------------------------------------------------------------ extra island height

test('EXTRA HEIGHT: only the island grows; hidden and peek are unchanged', () => {
  const cfg = { ...CONFIG, extraHeight: 90 };
  for (const phase of ['hidden', 'peek']) assert.deepStrictEqual(dockRect({ phase, edge: 'top', workArea: FULL, cfg }), dockRect({ phase, edge: 'top', workArea: FULL }), phase);
  const base = vis(dockRect({ phase: 'island', edge: 'top', workArea: FULL })), big = vis(dockRect({ phase: 'island', edge: 'top', workArea: FULL, cfg }));
  assert.strictEqual(big.height, base.height + 90); assert.strictEqual(big.width, base.width); assert.strictEqual(big.y, base.y, 'a top dock stays put and grows downward');
});

test('EXTRA HEIGHT: growing never slides the island ALONG its edge (the centre comes from the base size)', () => {
  // Only where nothing is clamped: at a corner (along 0 or 1) the island can only grow AWAY from the corner, so its
  // centre legitimately moves by half the extra (checked separately below).
  for (const edge of EDGES) for (const along of [0.3, 0.5, 0.7]) {
    const c = (extra) => { const v = vis(dockRect({ phase: 'island', edge, along, workArea: FULL, cfg: { ...CONFIG, extraHeight: extra } })); return edge === 'left' || edge === 'right' ? v.y + v.height / 2 : v.x + v.width / 2; };
    assert.strictEqual(c(0), c(120), `${edge}@${along}`);
  }
});

test('EXTRA HEIGHT: stays inside the work area and keeps the panel clearance on every edge', () => {
  for (const wa of [FULL, GNOME_TOP, KDE_BOTTOM, KDE_LEFT]) for (const edge of EDGES) for (const extra of [0, 50, 320, 9999, -50, NaN, undefined]) {
    const r = dockRect({ phase: 'island', edge, workArea: wa, cfg: { ...CONFIG, extraHeight: extra } });
    assert.ok(r.x >= wa.x && r.y >= wa.y && r.x + r.width <= wa.x + wa.width && r.y + r.height <= wa.y + wa.height, `${edge} extra=${extra} escaped ${JSON.stringify(wa)}`);
  }
  const v = vis(dockRect({ phase: 'island', edge: 'bottom', workArea: KDE_BOTTOM, cfg: { ...CONFIG, extraHeight: 200 } }));
  assert.strictEqual(1032 - (v.y + v.height), CONFIG.gap);
});

test('EXTRA HEIGHT: clamped to 320, and negative or junk values mean none', () => {
  const h = (extra) => vis(dockRect({ phase: 'island', edge: 'top', workArea: FULL, cfg: { ...CONFIG, extraHeight: extra } })).height;
  assert.strictEqual(h(99999), CONFIG.island.height + 320);
  for (const junk of [-10, NaN, undefined, null, 'abc']) assert.strictEqual(h(junk), CONFIG.island.height, String(junk));
});

test('EXTRA HEIGHT at a corner: the island grows AWAY from it - the corner-side edge stays flush and nothing goes off-screen', () => {
  const at = (extra, align) => dockRect({ phase: 'island', edge: 'left', along: align, workArea: FULL, cfg: { ...CONFIG, extraHeight: extra } });
  assert.strictEqual(at(100, 0).y, at(0, 0).y, 'left-start: the top edge does not move');
  const a = at(100, 1), b = at(0, 1);
  assert.strictEqual(a.y + a.height, b.y + b.height, 'left-end: the bottom edge does not move');
  assert.ok(a.y < b.y, 'so it grew upward instead');
});


test('DISMISS: a pointer that never sent a "leave" does not make the dock re-reveal instantly; a fresh enter does', () => {
  const { dock, advance } = make();
  dock.pointerEnter(); advance(CONFIG.dwellMs); dock.click();
  assert.strictEqual(dock.phase, 'island');
  dock.dismiss();
  assert.strictEqual(advance(5_000), 'hidden', 'stays hidden: there is no fresh enter');
  dock.pointerEnter();
  assert.strictEqual(advance(CONFIG.dwellMs), 'peek', 'a new enter reveals it as usual');
});

test('DISMISS on the hidden strip does not cancel a dwell that is already in progress', () => {
  const { dock, advance } = make();
  dock.pointerEnter(); advance(CONFIG.dwellMs - 20);
  dock.dismiss();
  assert.strictEqual(advance(20), 'peek');
});

// ---------------------------------------------------------------- where to start, and the welcome peek

test('edgeInsets reads all four edges at once, and agrees with edgeInset', () => {
  const screen = R(0, 0, 1920, 1080);
  const panels = [GNOME_TOP, KDE_BOTTOM, KDE_LEFT, R(0, 0, 1860, 1080), screen];
  for (const wa of panels) {
    const all = edgeInsets(screen, wa);
    assert.deepStrictEqual(all, { top: edgeInset('top', screen, wa), bottom: edgeInset('bottom', screen, wa), left: edgeInset('left', screen, wa), right: edgeInset('right', screen, wa) });
  }
  assert.deepStrictEqual(edgeInsets(screen, GNOME_TOP), { top: 32, bottom: 0, left: 0, right: 0 });
  assert.deepStrictEqual(edgeInsets(screen, screen), { top: 0, bottom: 0, left: 0, right: 0 });
});

test('freeEdge: a clear screen starts at the top, as it always did', () => {
  assert.strictEqual(freeEdge({ top: 0, bottom: 0, left: 0, right: 0 }), 'top');
});

test('freeEdge: a bar on the top (stock GNOME) moves the start to the bottom', () => {
  assert.strictEqual(freeEdge({ top: 32, bottom: 0, left: 0, right: 0 }), 'bottom');
});

test('freeEdge: top bar AND bottom panel -> the right edge; plus a left dock (Ubuntu-style) is still the right edge', () => {
  assert.strictEqual(freeEdge({ top: 32, bottom: 48, left: 0, right: 0 }), 'right');
  assert.strictEqual(freeEdge({ top: 32, bottom: 48, left: 70, right: 0 }), 'right');
});

test('freeEdge: a bottom panel (stock KDE) leaves the top edge', () => {
  assert.strictEqual(freeEdge({ top: 0, bottom: 44, left: 0, right: 0 }), 'top');
});

test('freeEdge: when every edge has something, the one with LEAST on it wins; ties keep top, bottom, right, left', () => {
  assert.strictEqual(freeEdge({ top: 32, bottom: 48, left: 70, right: 60 }), 'top');
  assert.strictEqual(freeEdge({ top: 50, bottom: 48, left: 70, right: 60 }), 'bottom');
  assert.strictEqual(freeEdge({ top: 50, bottom: 60, left: 70, right: 40 }), 'right');
  assert.strictEqual(freeEdge({ top: 50, bottom: 60, left: 20, right: 40 }), 'left');
  assert.strictEqual(freeEdge({ top: 10, bottom: 10, left: 10, right: 10 }), 'top');
  assert.strictEqual(freeEdge({ top: 5, bottom: 5, left: 0, right: 0 }), 'right', 'bottom and top both taken: right comes before left');
});

test('freeEdge: junk in means the top edge out, never an exception', () => {
  for (const junk of [null, undefined, {}, [], 'x', 5, { top: 'a', bottom: NaN, left: null, right: undefined }]) assert.strictEqual(freeEdge(junk), 'top', String(JSON.stringify(junk)));
  assert.strictEqual(freeEdge({ top: -10, bottom: 0, left: 0, right: 0 }), 'top', 'a negative inset is nothing');
  assert.strictEqual(freeEdge({ top: 0, bottom: -5, left: 0, right: 0 }), 'top', 'and does not make that edge look better than a clear one');
  assert.strictEqual(freeEdge({ top: 32, bottom: -5, left: 0, right: 0 }), 'bottom', 'it is simply a clear edge');
  assert.strictEqual(freeEdge({ top: 32, bottom: 'x', left: 0, right: 0 }), 'bottom', 'one unreadable edge counts as clear, the rest still decide');
});

test('peekFor shows the peek, and it hides again by itself after the time given', () => {
  const { dock, phases, advance } = make();
  dock.peekFor(5000);
  assert.strictEqual(dock.phase, 'peek');
  assert.deepStrictEqual(phases, ['hidden>peek']);
  assert.strictEqual(advance(4900), 'peek', 'still there just before');
  assert.strictEqual(advance(100), 'hidden', 'gone right at the time');
  assert.deepStrictEqual(phases, ['hidden>peek', 'peek>hidden']);
});

test('peekFor: a pointer that arrives keeps the pill, like any peek, and it hides after the pointer leaves', () => {
  const { dock, advance } = make();
  dock.peekFor(2000);
  advance(1000);
  dock.pointerEnter();
  assert.strictEqual(advance(10000), 'peek', 'pointer on it: stays');
  dock.pointerLeave();
  assert.strictEqual(advance(CONFIG.hideDelayMs - 1), 'peek');
  assert.strictEqual(advance(1), 'hidden');
});

test('peekFor never hides a pill while the agent is busy (same rule as every other hide)', () => {
  const { dock, advance, state } = make({ busy: true });
  dock.peekFor(1000);
  assert.strictEqual(advance(5000), 'peek');
  state.busy = false;
  assert.strictEqual(advance(50), 'hidden');
});

test('peekFor only acts from hidden: it never shrinks an island or interrupts a peek', () => {
  const a = make(); a.dock.click();                      // hidden -> island
  a.dock.peekFor(1000);
  assert.strictEqual(a.dock.phase, 'island');
  assert.strictEqual(a.advance(5000), 'island', 'and the hide timer was not armed');
  const b = make(); b.dock.pointerEnter(); b.advance(CONFIG.dwellMs);   // -> peek, pointer inside
  const before = b.phases.length;
  b.dock.peekFor(10);
  assert.strictEqual(b.phases.length, before, 'no phase change');
  assert.strictEqual(b.advance(5000), 'peek', 'pointer still inside: stays');
});

test('peekFor with a useless time does nothing; a huge one is capped at a minute', () => {
  for (const bad of [0, -5, NaN, undefined, null, 'x']) { const { dock } = make(); dock.peekFor(bad); assert.strictEqual(dock.phase, 'hidden', String(bad)); }
  const { dock, advance } = make();
  dock.peekFor(10 ** 9);
  assert.strictEqual(advance(59_000), 'peek');
  assert.strictEqual(advance(1_100), 'hidden');
});

test('peekFor while the pointer is already on the strip: the pill stays until the pointer leaves', () => {
  const { dock, advance } = make();
  dock.pointerEnter();                         // on the hot strip, dwell not reached yet
  advance(10);
  dock.peekFor(1000);
  assert.strictEqual(dock.phase, 'peek');
  assert.strictEqual(advance(5000), 'peek', 'the pointer is on it, so the timer does not hide it');
  dock.pointerLeave();
  assert.strictEqual(advance(CONFIG.hideDelayMs), 'hidden');
});


test('PERSISTENT: starts as a visible collapsed pill, never auto-hides, and explicit dismiss returns to the pill', () => {
  let t = 10_000; const phases = [];
  const dock = new Dock({ now: () => t, autoHide: () => false, onPhase: (p, prev) => phases.push(`${prev}>${p}`) });
  assert.strictEqual(dock.phase, 'peek');
  dock.pointerEnter(); dock.pointerLeave(); t += 60_000; dock.tick();
  assert.strictEqual(dock.phase, 'peek');
  dock.click(); assert.strictEqual(dock.phase, 'island');
  dock.dismiss(); assert.strictEqual(dock.phase, 'peek');
  assert.ok(phases.includes('island>peek'));
});

test('PERSISTENT: changing from hidden auto-hide mode to persistent mode reveals the pill without restart', () => {
  let t = 20_000; let persistent = false;
  const dock = new Dock({ now: () => t, autoHide: () => !persistent });
  assert.strictEqual(dock.phase, 'hidden');
  persistent = true; dock.tick();
  assert.strictEqual(dock.phase, 'peek');
  t += 60_000; dock.tick();
  assert.strictEqual(dock.phase, 'peek');
});


test('PERSISTENT: a task result expands briefly, then collapses to the visible pill', () => {
  let t = 50_000;
  const dock = new Dock({ now: () => t, autoHide: () => false });
  assert.strictEqual(dock.phase, 'peek');
  dock.summon();
  assert.strictEqual(dock.phase, 'island');
  dock.pointerLeave();
  t += CONFIG.summonHoldMs - 1; dock.tick();
  assert.strictEqual(dock.phase, 'island', 'result remains visible for the hold period');
  t += 1 + CONFIG.hideDelayMs; dock.tick();
  assert.strictEqual(dock.phase, 'peek', 'then collapses to the persistent pill, not hidden');
});

test('PERSISTENT: manual keyboard summon stays open until explicitly dismissed', () => {
  let t = 75_000;
  const dock = new Dock({ now: () => t, autoHide: () => false });
  dock.summon(Infinity);
  t += 120_000; dock.tick();
  assert.strictEqual(dock.phase, 'island');
  dock.dismiss(); assert.strictEqual(dock.phase, 'peek');
});
