'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { DockWindow, attachPageEvents, cleanPayload, PAYLOAD_KINDS, PAGE_EVENTS, MAX_EXTRA, TEXT_MAX } = require('../src/main/overlay/window');
const { MAX_TASK_CHARS } = require('../src/main/runner');
const { CONFIG } = require('../src/main/overlay/dock');

const WA = { x: 0, y: 32, width: 1920, height: 1048 }; // GNOME-style top bar

// Fake BrowserWindow that records calls. `refuseMove` simulates a Wayland
// compositor ignoring programmatic positioning.
function fakeElectron({ refuseMove = false, workArea = WA } = {}) {
  const rec = { created: null, calls: [], sent: [], cursor: { x: 500, y: 500 }, cursorBroken: false };
  class BrowserWindow {
    constructor(opts) { rec.created = opts; this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height }; this.destroyed = false;
      this.webContents = { send: (ch, payload) => rec.sent.push([ch, payload]), once: (_e, cb) => { this._loaded = cb; } }; }
    setAlwaysOnTop(...a) { rec.calls.push(['setAlwaysOnTop', ...a]); }
    setVisibleOnAllWorkspaces(...a) { rec.calls.push(['setVisibleOnAllWorkspaces', ...a]); }
    loadFile(f) { rec.calls.push(['loadFile', f]); }
    setBounds(b) { rec.calls.push(['setBounds', b]); if (!refuseMove) this.bounds = { ...b }; else this.bounds = { ...this.bounds, width: b.width, height: b.height }; }
    setPosition(x, y) { rec.calls.push(['setPosition', x, y]); if (!refuseMove) { this.bounds.x = x; this.bounds.y = y; } }
    getBounds() { return { ...this.bounds }; }
    isDestroyed() { return this.destroyed; }
    focus() { rec.calls.push(['focus']); }
    destroy() { this.destroyed = true; rec.calls.push(['destroy']); }
  }
  const screen = {
    // The test moves the pointer by setting rec.cursor; rec.cursorBroken = the desktop will not say where it is.
    getCursorScreenPoint: () => { if (rec.cursorBroken) throw new Error('no pointer position here'); return { ...rec.cursor }; },
    getDisplayNearestPoint: () => ({ workArea, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getPrimaryDisplay: () => ({ workArea }),
    getAllDisplays: () => [{ id: 1, workArea, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }],
  };
  return { electron: { BrowserWindow, screen }, rec };
}

// Every DockWindow made by make() is destroyed after the test, pass or fail.
// (A failing test that skips its own cleanup used to leave a live 50ms interval
// and hang the whole suite.)
const live = [];
test.afterEach(() => { while (live.length) live.pop().destroy(); });

function make(opts = {}) {
  const { electron, rec } = fakeElectron(opts);
  let t = 0; let busy = false; const mismatches = [];
  const prefs = { edge: 'top', along: 0.5, hour12: false, autoHide: true, ...(opts.prefs || {}) };
  const dw = new DockWindow({
    electron, getPrefs: () => prefs, isBusy: () => busy,
    onPlacementMismatch: (m) => mismatches.push(m), now: () => t,
    preload: '/x/preload.cjs', html: '/x/pill.html',
  });
  live.push(dw);
  return { dw, rec, mismatches, prefs, setBusy: (b) => { busy = b; }, advance: (ms) => { t += ms; dw.dock.tick(); } };
}
// The pill the user actually sees = window bounds minus the transparent padding.
// Tests assert on THIS, so they check what matters (size + clearance from the
// panel) rather than the padding implementation detail.
const lastPhaseMsg = (rec) => rec.sent.filter(([ch]) => ch === 'pill:phase').at(-1)[1];
const visible = (rec) => {
  const b = lastBounds(rec); const i = lastPhaseMsg(rec).inset;
  return { x: b.x + i.left, y: b.y + i.top, width: b.width - i.left - i.right, height: b.height - i.top - i.bottom };
};
const lastBounds = (rec) => rec.calls.filter((c) => c[0] === 'setBounds').at(-1)[1];

test('creates a frameless, transparent, non-taskbar window as a THIN STRIP at the panel edge', () => {
  const { dw, rec } = make();
  dw.create();
  const o = rec.created;
  assert.deepStrictEqual([o.frame, o.transparent, o.skipTaskbar, o.hasShadow], [false, true, true, false]);
  assert.strictEqual(o.height, CONFIG.strip, 'hidden = 3px strip');
  assert.strictEqual(o.y, 32, 'flush under the GNOME bar');
});

test('security: renderer is sandboxed with context isolation and NO node integration', () => {
  const { dw, rec } = make();
  dw.create();
  const wp = rec.created.webPreferences;
  assert.deepStrictEqual([wp.contextIsolation, wp.sandbox, wp.nodeIntegration], [true, true, false]);
  assert.strictEqual(wp.preload, '/x/preload.cjs');
});

test('persistent mode creates a visible collapsed pill and keeps it after pointer leave', () => {
  const { dw, rec, advance } = make({ prefs: { autoHide: false } });
  dw.create();
  assert.strictEqual(dw.dock.phase, 'peek');
  assert.strictEqual(rec.created.width, CONFIG.peek.width + 2 * 20, 'window is sized for the pill, not the edge strip');
  dw.pointerEnter(); dw.pointerLeave(); advance(30_000);
  assert.strictEqual(dw.dock.phase, 'peek', 'persistent pill remains visible when idle');
});

test('persistent mode expands on shortcut and collapses to the visible pill on Esc / click-outside', () => {
  const a = make({ prefs: { autoHide: false } }); a.dw.create();
  assert.strictEqual(a.dw.dock.phase, 'peek');
  a.dw.toggle(); assert.strictEqual(a.dw.dock.phase, 'island');
  a.dw.dismiss(); assert.strictEqual(a.dw.dock.phase, 'peek');
  a.dw.toggle(); a.dw.windowBlurred(); assert.strictEqual(a.dw.dock.phase, 'peek');
});

test('is always-on-top and visible on all workspaces, and loads the pill page', () => {
  const { dw, rec } = make();
  dw.create();
  assert.ok(rec.calls.some((c) => c[0] === 'setAlwaysOnTop' && c[1] === true));
  assert.ok(rec.calls.some((c) => c[0] === 'setVisibleOnAllWorkspaces' && c[1] === true));
  assert.deepStrictEqual(rec.calls.find((c) => c[0] === 'loadFile'), ['loadFile', '/x/pill.html']);
});

test('reveal: pointer dwell grows the window to the peek size, centred, clear of the bar', () => {
  const { dw, rec, advance } = make();
  dw.create();
  dw.pointerEnter(); advance(CONFIG.dwellMs);
  const v = visible(rec);
  assert.deepStrictEqual([v.width, v.height], [CONFIG.peek.width, CONFIG.peek.height], 'visible pill is the peek size');
  assert.strictEqual(v.y, 32 + CONFIG.gap, 'exactly `gap` below the GNOME bar');
  assert.strictEqual(v.x + v.width / 2, 1920 / 2, 'centred on the screen');
  assert.ok(lastBounds(rec).y >= 32, 'the transparent window itself never overlaps the bar');
});

test('click expands to the island; leaving collapses all the way back to the strip', () => {
  const { dw, rec, advance } = make();
  dw.create();
  dw.pointerEnter(); advance(CONFIG.dwellMs); dw.click();
  assert.deepStrictEqual([visible(rec).width, visible(rec).height], [CONFIG.island.width, CONFIG.island.height]);
  dw.pointerLeave(); advance(CONFIG.hideDelayMs);
  const b = lastBounds(rec);
  assert.deepStrictEqual([b.width, b.height], [CONFIG.stripLength, CONFIG.strip]);
});

test('the renderer is told the phase, docked edge and bulge direction on every change', () => {
  const { dw, rec, advance } = make();
  dw.create();
  dw.pointerEnter(); advance(CONFIG.dwellMs);
  const phases = rec.sent.filter(([ch]) => ch === 'pill:phase').map(([, p]) => p);
  assert.deepStrictEqual(phases.at(-1), { phase: 'peek', edge: 'top', bulge: 'down', inset: { top: CONFIG.gap, right: CONFIG.pad, bottom: CONFIG.pad, left: CONFIG.pad } });
});

test('WAYLAND: when the compositor ignores the move, the mismatch is REPORTED with wanted vs got', () => {
  const { dw, mismatches, advance } = make({ refuseMove: true });
  dw.create();
  dw.pointerEnter(); advance(CONFIG.dwellMs);
  assert.strictEqual(mismatches.length, 1);
  assert.strictEqual(mismatches[0].phase, 'peek');
  assert.notDeepStrictEqual([mismatches[0].got.x, mismatches[0].got.y], [mismatches[0].wanted.x, mismatches[0].wanted.y]);
});

test('WAYLAND: no mismatch is reported when the placement is honoured', () => {
  const { dw, mismatches, advance } = make();
  dw.create();
  dw.pointerEnter(); advance(CONFIG.dwellMs);
  assert.strictEqual(mismatches.length, 0);
});

test('approval request pops the island open even though nobody is hovering', () => {
  const { dw, rec } = make();
  dw.create();
  dw.setStatus({ state: 'waiting', detail: 'Run: rm -rf x' });
  assert.strictEqual(dw.dock.phase, 'island');
  assert.strictEqual(visible(rec).width, CONFIG.island.width);
});

test('done and error also surface the island; working states do not steal attention', () => {
  for (const [state, opens] of [['done', true], ['error', true], ['thinking', false], ['acting', false], ['idle', false]]) {
    const { dw } = make();
    dw.create();
    dw.setStatus({ state, detail: 'x' });
    assert.strictEqual(dw.dock.phase === 'island', opens, state);
    }
});

test('the latest status is re-sent on phase change so a freshly revealed pill is never blank', () => {
  const { dw, rec, advance } = make();
  dw.create();
  dw.setStatus({ state: 'acting', detail: 'mouse_click' });
  rec.sent.length = 0;
  dw.pointerEnter(); advance(CONFIG.dwellMs);
  assert.deepStrictEqual(rec.sent.find(([ch]) => ch === 'pill:status')[1], { state: 'acting', detail: 'mouse_click', seq: 1, replay: true });
});

test('edge preference is honoured: a left dock produces a tall, narrow window', () => {
  const { dw, rec } = make({ prefs: { edge: 'left' } });
  dw.create();
  assert.strictEqual(rec.created.width, CONFIG.strip);
  assert.strictEqual(rec.created.height, CONFIG.stripLength);
});

test('destroy stops the tick timer and closes the window; later events do not crash', () => {
  const { dw, rec } = make();
  dw.create();
  dw.destroy();
  assert.ok(rec.calls.some((c) => c[0] === 'destroy'));
  assert.doesNotThrow(() => { dw.setStatus({ state: 'done', detail: 'x' }); dw.click(); dw.pointerEnter(); });
});

// ------------------------------------------------------------ customisable placement

test('PLACEMENT: named align is honoured (top-left: the island opens against the left edge)', () => {
  const { dw, rec } = make({ prefs: { edge: 'top', align: 'start' }, workArea: { x: 0, y: 0, width: 1920, height: 1080 } });
  dw.create();
  dw.click(); // straight to the island
  assert.strictEqual(visible(rec).x, CONFIG.pad);
});

test('PLACEMENT: changing prefs then refreshPlacement() moves the dock immediately, in the current phase', () => {
  const { dw, rec, prefs, advance } = make({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } });
  dw.create();
  dw.pointerEnter(); advance(CONFIG.dwellMs); dw.click(); // island, top-center
  const before = visible(rec);
  assert.strictEqual(before.x + before.width / 2, 960);

  Object.assign(prefs, { edge: 'right', align: 'end' });
  dw.refreshPlacement();
  const after = visible(rec);
  assert.strictEqual(dw.dock.phase, 'island', 'phase is preserved across a move');
  assert.strictEqual(1920 - (after.x + after.width), CONFIG.gap, 'now hugging the right edge');
  assert.strictEqual(1080 - (after.y + after.height), CONFIG.pad, 'and at the bottom end');
  const msg = lastPhaseMsg(rec);
  assert.deepStrictEqual([msg.edge, msg.bulge], ['right', 'left'], 'the page is told the new edge and bulge direction');
});

test('PLACEMENT: a corrupted prefs object (null fields) never crashes window creation', () => {
  const { electron } = fakeElectron();
  const dw = new DockWindow({ electron, getPrefs: () => null, isBusy: () => false, preload: '/x', html: '/y' });
  live.push(dw);
  assert.doesNotThrow(() => dw.create());
});

test('PLACEMENT: refreshPlacement before create() or after destroy() is a harmless no-op', () => {
  const { dw } = make();
  assert.doesNotThrow(() => dw.refreshPlacement());
  dw.create(); dw.destroy();
  assert.doesNotThrow(() => dw.refreshPlacement());
});

test('PLACEMENT: every edge x align creates a window on-screen', () => {
  for (const edge of ['top', 'bottom', 'left', 'right']) {
    for (const align of ['start', 'center', 'end']) {
      const { dw, rec } = make({ prefs: { edge, align }, workArea: { x: 0, y: 0, width: 1920, height: 1080 } });
      dw.create();
      const o = rec.created;
      assert.ok(o.x >= 0 && o.y >= 0 && o.x + o.width <= 1920 && o.y + o.height <= 1080, `${edge}-${align}: ${JSON.stringify([o.x, o.y, o.width, o.height])}`);
    }
  }
});


// ------------------------------------------------------------ content height, engagement, approvals, sequencing

const openIsland = (m) => { m.dw.create(); m.dw.click(); return m; };

test('HEIGHT: the island grows to fit the page\'s content, and the transparent window follows', () => {
  const m = openIsland(make({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }));
  const base = visible(m.rec).height; assert.strictEqual(base, CONFIG.island.height);
  m.dw.setContentHeight(CONFIG.island.height + 90);
  assert.strictEqual(visible(m.rec).height, CONFIG.island.height + 90);
  assert.strictEqual(visible(m.rec).width, CONFIG.island.width, 'width is untouched');
});

test('HEIGHT: content SHORTER than the base island never shrinks it below base', () => {
  const m = openIsland(make({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }));
  m.dw.setContentHeight(40); assert.strictEqual(visible(m.rec).height, CONFIG.island.height);
});

test('HEIGHT: growth is capped, so a hostile or buggy page cannot make a screen-sized window', () => {
  const m = openIsland(make({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }));
  m.dw.setContentHeight(50000); assert.strictEqual(visible(m.rec).height, CONFIG.island.height + MAX_EXTRA);
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, 'tall']) assert.doesNotThrow(() => m.dw.setContentHeight(bad));
  assert.strictEqual(visible(m.rec).height, CONFIG.island.height + MAX_EXTRA, 'junk changed nothing');
});

test('HEIGHT: on a top dock the island grows DOWNWARD and keeps its clearance from the panel', () => {
  const m = openIsland(make({ workArea: { x: 0, y: 32, width: 1920, height: 1048 } }));
  m.dw.setContentHeight(CONFIG.island.height + 100);
  assert.strictEqual(visible(m.rec).y, 32 + CONFIG.gap);
});

test('HEIGHT: on a BOTTOM dock it grows UPWARD and stays above the panel', () => {
  const m = openIsland(make({ prefs: { edge: 'bottom' }, workArea: { x: 0, y: 0, width: 1920, height: 1032 } }));
  m.dw.setContentHeight(CONFIG.island.height + 100);
  const v = visible(m.rec); assert.strictEqual(1032 - (v.y + v.height), CONFIG.gap);
});

test('HEIGHT: leaving the island forgets the extra, so the next opening starts at base', () => {
  const m = openIsland(make({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }));
  m.dw.setContentHeight(CONFIG.island.height + 100);
  m.dw.dock.dismiss(); assert.strictEqual(m.dw.extraHeight, 0);
  m.dw.click(); assert.strictEqual(visible(m.rec).height, CONFIG.island.height);
});

test('HEIGHT: a content-height change moves the window bounds only - it must NOT replay the status (that duplicated the activity log)', () => {
  const m = openIsland(make({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }));
  m.dw.setStatus({ state: 'acting', detail: 'mouse_click' });
  m.rec.sent.length = 0;
  m.dw.setContentHeight(CONFIG.island.height + 60);
  assert.deepStrictEqual(m.rec.sent.filter(([ch]) => ch === 'pill:status'), []);
});

test('HEIGHT: refreshPlacement keeps the current extra height', () => {
  const m = openIsland(make({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }));
  m.dw.setContentHeight(CONFIG.island.height + 70); m.dw.refreshPlacement();
  assert.strictEqual(visible(m.rec).height, CONFIG.island.height + 70);
});

test('STATUS: each REAL status is numbered; a replay carries the same number and replay:true', () => {
  const m = make(); m.dw.create();
  m.dw.setStatus({ state: 'acting', detail: 'a' }); m.dw.setStatus({ state: 'acting', detail: 'a' });
  const fresh = m.rec.sent.filter(([ch]) => ch === 'pill:status').map(([, p]) => p);
  assert.deepStrictEqual(fresh.slice(-2).map((p) => [p.seq, !!p.replay]), [[1, false], [2, false]], 'two identical actions are two events, not one');
  m.rec.sent.length = 0; m.dw.dock.summon();
  const replay = m.rec.sent.find(([ch]) => ch === 'pill:status')[1];
  assert.deepStrictEqual([replay.seq, replay.replay], [2, true]);
});

test('ENGAGED: while the user is typing, the island does not auto-hide - and hides once they are done', () => {
  const m = make(); m.dw.create(); m.dw.click();
  m.dw.setEngaged(true); m.dw.pointerLeave(); assert.strictEqual(m.advance(60_000), undefined);
  assert.strictEqual(m.dw.dock.phase, 'island', 'still open a minute later');
  m.dw.setEngaged(false); m.advance(1);
  assert.strictEqual(m.dw.dock.phase, 'hidden');
});

test('APPROVAL: showApproval opens the island and sends the question to the page; null clears it', () => {
  const m = make(); m.dw.create();
  m.rec.sent.length = 0; m.dw.showApproval({ id: 'q1', title: 'Run this shell command?', body: 'ls' });
  assert.strictEqual(m.dw.dock.phase, 'island', 'a question nobody can see is a hang');
  assert.deepStrictEqual(m.rec.sent.find(([ch]) => ch === 'pill:approval')[1], { id: 'q1', title: 'Run this shell command?', body: 'ls' });
  m.dw.showApproval(null);
  assert.strictEqual(m.rec.sent.filter(([ch]) => ch === 'pill:approval').at(-1)[1], null);
});

test('APPROVAL: an open question is REPLAYED with the phase, so a reloaded page never loses it', () => {
  const m = make(); m.dw.create(); m.dw.showApproval({ id: 'q1', title: 't', body: 'b' });
  m.rec.sent.length = 0; m.dw.refreshPlacement();
  assert.deepStrictEqual(m.rec.sent.find(([ch]) => ch === 'pill:approval')[1].id, 'q1');
});

// ------------------------------------------------------------ payload validation in MAIN (second gate after the preload)

test('cleanPayload: every kind accepts its good values and rejects junk, independently of the preload', () => {
  assert.strictEqual(cleanPayload('text', 'hi'), 'hi'); assert.strictEqual(cleanPayload('text', ''), undefined); assert.strictEqual(cleanPayload('text', 'x'.repeat(TEXT_MAX + 1)), undefined);
  assert.deepStrictEqual(cleanPayload('answer', { id: 'ok_1', allow: true, extra: 1 }), { id: 'ok_1', allow: true });
  for (const bad of [{ id: 'a b', allow: true }, { id: 'ok', allow: 'true' }, { id: 'ok', allow: 1 }, null]) assert.strictEqual(cleanPayload('answer', bad), undefined);
  assert.strictEqual(cleanPayload('number', 5), 5); assert.strictEqual(cleanPayload('number', '5'), undefined); assert.strictEqual(cleanPayload('number', NaN), undefined);
  assert.strictEqual(cleanPayload('flag', false), false); assert.strictEqual(cleanPayload('flag', 0), undefined);
  assert.strictEqual(cleanPayload('nonsense', 'x'), undefined);
});

test('the page-facing text limit equals the runner\'s (they must never drift apart)', () => { assert.strictEqual(TEXT_MAX, MAX_TASK_CHARS); });

function ipcFor(dw) { const handlers = []; const ipc = { on: (_c, h) => handlers.push(h), removeListener() {} }; attachPageEvents(ipc, dw); return (name, payload, sender) => handlers[0]({ sender: sender || dw.win.webContents }, name, payload); }

test('MAIN GATE: a malformed payload sent straight over IPC (bypassing the preload) does nothing', () => {
  const m = make(); m.dw.create(); const actions = []; m.dw.onAction = (n, p) => actions.push([n, p]); const fire = ipcFor(m.dw);
  fire('submit-task', 5); fire('submit-task', ''); fire('submit-task', { evil: 1 });
  fire('approval-answer', { id: 'a b', allow: true }); fire('approval-answer', { id: 'ok', allow: 'true' });
  assert.deepStrictEqual(actions, []);
  fire('submit-task', 'real task'); fire('approval-answer', { id: 'ok', allow: true, extra: 1 });
  assert.deepStrictEqual(actions, [['submit-task', 'real task'], ['approval-answer', { id: 'ok', allow: true }]]);
});

test('MAIN GATE: inherited property names and unknown events are ignored; events from another window are ignored', () => {
  const m = make(); m.dw.create(); const actions = []; m.dw.onAction = (n) => actions.push(n); const fire = ipcFor(m.dw);
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'nope', null, 5]) assert.doesNotThrow(() => fire(name, undefined));
  fire('open-settings', undefined, { id: 'some other renderer' });
  assert.deepStrictEqual(actions, []);
  fire('open-settings'); assert.deepStrictEqual(actions, ['open-settings']);
});

test('MAIN GATE: a payload-free event ignores anything attached to it', () => {
  const m = make(); m.dw.create(); const actions = []; m.dw.onAction = (n, p) => actions.push([n, p]); const fire = ipcFor(m.dw);
  fire('stop-agent', { allow: true, id: 'x' });
  assert.deepStrictEqual(actions, [['stop-agent', undefined]]);
});

test('every event in PAGE_EVENTS with a payload kind is a known kind', () => {
  for (const [name, kind] of Object.entries(PAYLOAD_KINDS)) { assert.ok(PAGE_EVENTS[name], name); assert.ok(['text', 'answer', 'number', 'flag'].includes(kind), `${name}: ${kind}`); }
});


// ------------------------------------------------------------ the island must not hide something it is holding

test('KEEP OPEN: an open approval question holds the island open EVEN IF isBusy() says false (the bug the e2e found)', () => {
  const m = make(); m.dw.create(); m.dw.pointerLeave();
  m.dw.showApproval({ id: 'q1', title: 'Run this shell command?', body: 'ls' });
  assert.strictEqual(m.advance(120_000), undefined);
  assert.strictEqual(m.dw.dock.phase, 'island', 'still showing the question two minutes later');
  m.dw.showApproval(null); m.advance(1);
  assert.strictEqual(m.dw.dock.phase, 'hidden', 'and it lets go once the question is answered');
});

test('KEEP OPEN: while the agent is thinking, acting or waiting the island stays; once it is idle it may hide', () => {
  for (const [state, stays] of [['thinking', true], ['acting', true], ['waiting', true], ['idle', false], ['stopped', false]]) {
    const m = make(); m.dw.create(); m.dw.click(); m.dw.pointerLeave();
    m.dw.setStatus({ state, detail: 'x' }); m.advance(5_000);
    assert.strictEqual(m.dw.dock.phase === 'island', stays, state);
  }
});

test('NEWS: a finished or failed task keeps the island up long enough to be read, then lets it go', () => {
  for (const state of ['done', 'error']) {
    const m = make(); m.dw.create(); m.dw.click(); m.dw.pointerLeave(); m.advance(CONFIG.hideDelayMs);
    assert.strictEqual(m.dw.dock.phase, 'hidden', 'setup: the pointer visited earlier and is gone');
    m.dw.setStatus({ state, detail: 'x' });
    assert.strictEqual(m.dw.dock.phase, 'island', state);
    m.advance(CONFIG.summonHoldMs - 1);
    assert.strictEqual(m.dw.dock.phase, 'island', `${state}: still up just before the hold ends`);
    m.advance(1);
    assert.strictEqual(m.dw.dock.phase, 'hidden', `${state}: gone once it has been up for the hold`);
  }
});

test('KEEP OPEN: isBusy() supplied by the owner still counts (the three guards are added to it, not instead of it)', () => {
  const m = make(); m.dw.create(); m.dw.click(); m.dw.pointerLeave();
  m.setBusy(true); assert.strictEqual(m.advance(10_000), undefined); assert.strictEqual(m.dw.dock.phase, 'island');
  m.setBusy(false); m.advance(1); assert.strictEqual(m.dw.dock.phase, 'hidden');
});


// ------------------------------------------------------------ opening and closing from the keyboard side

const focusCalls = (rec) => rec.calls.filter((c) => c[0] === 'focus').length;

test('TOGGLE: hidden -> island, and the window is asked for the keyboard so the person can type at once', () => {
  const m = make(); m.dw.create();
  m.dw.toggle();
  assert.strictEqual(m.dw.dock.phase, 'island');
  assert.strictEqual(focusCalls(m.rec), 1);
});

test('TOGGLE: the island it opens STAYS, even though the pointer visited the pill earlier and is nowhere near (the real bug)', () => {
  // Measured on a real GNOME Shell: after a hover on the pill, toggle() opened the island and the hide timer - still holding the
  // time of that old "pointer left" - shut it again on the next 50 ms tick. About half of all keyboard openings did nothing.
  const m = make(); m.dw.create();
  m.dw.pointerEnter(); m.advance(CONFIG.dwellMs); m.dw.pointerLeave(); m.advance(CONFIG.hideDelayMs);
  assert.strictEqual(m.dw.dock.phase, 'hidden', 'setup: the earlier visit is over');
  m.dw.toggle();
  assert.strictEqual(m.dw.dock.phase, 'island');
  m.advance(50);
  assert.strictEqual(m.dw.dock.phase, 'island', 'the very next tick');
  m.advance(5 * 60_000);
  assert.strictEqual(m.dw.dock.phase, 'island', 'and five minutes later, with nobody touching it');
  m.dw.toggle();
  assert.strictEqual(m.dw.dock.phase, 'hidden', 'the shortcut again closes it');
});

test('TOGGLE: a pointer that brushes past the island (the desktop reports a crossing) does not close it', () => {
  const m = make(); m.dw.create(); m.dw.toggle();
  m.advance(10); m.dw.pointerEnter(); m.advance(20); m.dw.pointerLeave();
  m.advance(60_000);
  assert.strictEqual(m.dw.dock.phase, 'island');
});

test('TOGGLE: Esc and "click outside" close the island it opened, hold or no hold', () => {
  const a = make(); a.dw.create(); a.dw.toggle(); a.dw.dismiss();
  assert.strictEqual(a.dw.dock.phase, 'hidden', 'Esc');
  const b = make(); b.dw.create(); b.dw.toggle(); b.dw.windowBlurred();
  assert.strictEqual(b.dw.dock.phase, 'hidden', 'the window lost the keyboard');
});

test('TOGGLE: pressing it again CLOSES the island - never a peek pill left stuck on screen', () => {
  const m = make(); m.dw.create();
  m.dw.toggle(); m.dw.toggle();
  assert.strictEqual(m.dw.dock.phase, 'hidden');
  m.advance(10_000);
  assert.strictEqual(m.dw.dock.phase, 'hidden', 'and it stays closed');
  assert.strictEqual(focusCalls(m.rec), 1, 'closing does not ask for the keyboard');
});

test('TOGGLE: a peek pill (pointer hovering, then the shortcut) goes away too', () => {
  const m = make(); m.dw.create();
  m.dw.pointerEnter(); m.advance(CONFIG.dwellMs);
  assert.strictEqual(m.dw.dock.phase, 'peek');
  m.dw.toggle();
  assert.strictEqual(m.dw.dock.phase, 'hidden');
});

test('TOGGLE: with a question waiting for an answer the island stays open (closing it would strand the agent)', () => {
  const m = make(); m.dw.create();
  m.dw.showApproval({ id: 'a1', title: 'Run a command?', detail: 'ls' });
  assert.strictEqual(m.dw.dock.phase, 'island');
  m.dw.toggle();
  assert.strictEqual(m.dw.dock.phase, 'island');
  m.dw.showApproval(null); m.dw.toggle();
  assert.strictEqual(m.dw.dock.phase, 'hidden', 'once answered, it closes like any other');
});

test('TOGGLE: after the window is gone it does nothing and does not throw', () => {
  const m = make(); m.dw.create(); m.dw.destroy();
  assert.doesNotThrow(() => m.dw.toggle());
});

test('BLURRED ("click outside"): the island closes when its window loses the keyboard', () => {
  const m = openIsland(make());
  assert.strictEqual(m.dw.dock.phase, 'island');
  m.dw.windowBlurred();
  assert.strictEqual(m.dw.dock.phase, 'hidden');
});

test('BLURRED: not while the agent works, a question is open, or the person has typed something', () => {
  for (const state of ['thinking', 'acting', 'waiting']) {
    const m = openIsland(make()); m.dw.setStatus({ state, detail: 'x' }); m.dw.windowBlurred();
    assert.strictEqual(m.dw.dock.phase, 'island', state);
  }
  const q = openIsland(make()); q.dw.showApproval({ id: 'a1', title: 't', detail: 'd' }); q.dw.windowBlurred();
  assert.strictEqual(q.dw.dock.phase, 'island', 'question');
  const typing = openIsland(make()); typing.dw.setEngaged(true); typing.dw.windowBlurred();
  assert.strictEqual(typing.dw.dock.phase, 'island', 'typed text');
  const owner = openIsland(make()); owner.setBusy(true); owner.dw.windowBlurred();
  assert.strictEqual(owner.dw.dock.phase, 'island', 'owner says busy');
});

test('BLURRED: only the island reacts - a peek pill or the hidden strip is left alone', () => {
  const m = make(); m.dw.create();
  m.dw.windowBlurred();
  assert.strictEqual(m.dw.dock.phase, 'hidden');
  m.dw.pointerEnter(); m.advance(CONFIG.dwellMs);
  m.dw.windowBlurred();
  assert.strictEqual(m.dw.dock.phase, 'peek');
});

test('BLURRED: never interrupts a drag in progress', () => {
  const m = openIsland(make());
  m.dw.dragging = true;
  m.dw.windowBlurred();
  assert.strictEqual(m.dw.dock.phase, 'island');
});

test('"blurred" is an event the page may send, takes no payload, and reaches windowBlurred', () => {
  assert.ok(Object.prototype.hasOwnProperty.call(PAGE_EVENTS, 'blurred'));
  assert.ok(!Object.prototype.hasOwnProperty.call(PAYLOAD_KINDS, 'blurred'), 'no payload expected');
  const seen = [];
  PAGE_EVENTS.blurred({ windowBlurred: () => seen.push('blurred') });
  assert.deepStrictEqual(seen, ['blurred']);
});


// ------------------------------------------------------------ dragging the pill (the whole path, with a pointer the test moves)
// The drag maths alone passed every test while the real thing lagged hundreds of pixels behind the mouse (found on a real
// GNOME desktop): the window moved under the pointer and the page's coordinates, relative to that window, were fed back in.
// These tests move the POINTER and let the window follow, the way a desktop does.

const dragAt = (m, x, y) => { m.rec.cursor = { x, y }; };
const lastPosition = (rec) => rec.calls.filter((c) => c[0] === 'setPosition').at(-1);

test('DRAG: the window follows the pointer, and stays on it however many events arrive (no lag, no drift)', () => {
  const m = openIsland(make({ prefs: { edge: 'top', along: 0.5 } }));
  const start = m.dw.win.getBounds();
  dragAt(m, start.x + 100, start.y + 30); m.dw.dragStart();
  let x = start.x + 100, y = start.y + 30;
  for (let i = 0; i < 60; i++) {
    x += 17; y += 9; dragAt(m, x, y);
    m.dw.dragMove(); m.dw.dragMove();                          // a real compositor sends extra, synthetic moves too
    const at = m.dw.win.getBounds();
    assert.deepStrictEqual([at.x, at.y], [start.x + (x - (start.x + 100)), start.y + (y - (start.y + 30))], `step ${i}: the pill sits exactly where the pointer took it`);
  }
  assert.strictEqual(m.dw.dragging, true);
});

test('DRAG: dropping on a screen edge commits that edge, using the pointer position at the moment of release', () => {
  const placed = [];
  const m = openIsland(make({ prefs: { edge: 'bottom', along: 0.5 } })); m.dw.onPlacementChange = (p) => placed.push(p);
  const b = m.dw.win.getBounds();
  dragAt(m, b.x + 40, b.y + 20); m.dw.dragStart();
  dragAt(m, 1000, 300); m.dw.dragMove();                       // the last move that was reported: nearest the TOP edge
  assert.strictEqual(m.dw.drag.preview.edge, 'top');
  dragAt(m, 1916, 520);                                        // ...but the hand let go against the right edge
  const r = m.dw.dragEnd();
  assert.strictEqual(r.kind, 'drop');
  assert.strictEqual(placed.length, 1);
  assert.strictEqual(placed[0].edge, 'right');
  assert.strictEqual(placed[0].display, 1);
  assert.ok(placed[0].along > 0.2 && placed[0].along < 0.8, `along ${placed[0].along}`);
  assert.strictEqual(m.dw.dragging, false);
});

test('DRAG: a press and release without moving is a click and places nothing', () => {
  const placed = [];
  const m = openIsland(make()); m.dw.onPlacementChange = (p) => placed.push(p);
  dragAt(m, 700, 60); m.dw.dragStart(); dragAt(m, 702, 61); m.dw.dragMove();
  assert.strictEqual(m.dw.dragging, false, 'a wobble is not a drag');
  assert.strictEqual(m.dw.dragEnd().kind, 'click');
  assert.deepStrictEqual(placed, []);
  assert.strictEqual(lastPosition(m.rec), undefined, 'and the window was not moved');
});

test('DRAG: the coordinates a page sends are ignored - only the desktop\'s own pointer position counts', () => {
  const m = openIsland(make({ prefs: { edge: 'top', along: 0.5 } })); m.dw.onAction = () => {};
  const fire = ipcFor(m.dw);
  const b = m.dw.win.getBounds();
  dragAt(m, b.x + 50, b.y + 20); fire('drag-start', { x: 9e5, y: -9e5 });
  dragAt(m, b.x + 50 + 200, b.y + 20 + 100); fire('drag-move', { x: -123456, y: 654321 });
  const at = m.dw.win.getBounds();
  assert.deepStrictEqual([at.x, at.y], [b.x + 200, b.y + 100]);
});

test('DRAG: if the desktop cannot say where the pointer is, nothing moves, nothing throws, and the press ends as a click', () => {
  const placed = [];
  const m = openIsland(make()); m.dw.onPlacementChange = (p) => placed.push(p);
  m.rec.cursorBroken = true;
  assert.doesNotThrow(() => { m.dw.dragStart(); m.dw.dragMove(); m.dw.dragMove(); });
  assert.strictEqual(m.dw.dragging, false);
  assert.strictEqual(m.dw.dragEnd().kind, 'click');
  assert.deepStrictEqual(placed, []);
  assert.strictEqual(lastPosition(m.rec), undefined);
  // a pointer that answers with rubbish is the same as no answer
  for (const junk of [{ x: NaN, y: 1 }, { x: 1 }, { x: Infinity, y: 2 }, null, undefined, 'x']) {
    const q = openIsland(make()); q.rec.cursor = junk;
    assert.strictEqual(q.dw._pointer(), null, `${JSON.stringify(junk)} is not a position`);
    q.dw.dragStart(); q.dw.dragMove();
    assert.strictEqual(q.dw.dragging, false, JSON.stringify(junk));
  }
});

test('DRAG: the island is held open for the whole drag (the auto-hide timer must not fire mid-drag)', () => {
  const m = openIsland(make({ prefs: { edge: 'top', along: 0.5 } })); m.dw.pointerLeave();
  const b = m.dw.win.getBounds();
  dragAt(m, b.x + 60, b.y + 20); m.dw.dragStart(); dragAt(m, b.x + 400, b.y + 300); m.dw.dragMove();
  m.advance(10_000);
  assert.strictEqual(m.dw.dock.phase, 'island');
  m.dw.dragCancel(); m.advance(1);
});

test('DRAG: cancelling (Esc) mid-drag puts the pill back and commits nothing', () => {
  const placed = [];
  const m = openIsland(make({ prefs: { edge: 'top', along: 0.5 } })); m.dw.onPlacementChange = (p) => placed.push(p);
  const home = m.dw.win.getBounds();
  dragAt(m, home.x + 40, home.y + 20); m.dw.dragStart(); dragAt(m, 900, 700); m.dw.dragMove();
  assert.notDeepStrictEqual(m.dw.win.getBounds(), home);
  m.dw.dragCancel();
  assert.deepStrictEqual(placed, []);
  assert.deepStrictEqual({ x: m.dw.win.getBounds().x, y: m.dw.win.getBounds().y }, { x: home.x, y: home.y }, 'back where it lives');
  assert.strictEqual(m.dw.dragging, false);
});

test('the page sends drag events without coordinates, and main takes no payload for them', () => {
  for (const name of ['drag-start', 'drag-move']) assert.ok(!Object.prototype.hasOwnProperty.call(PAYLOAD_KINDS, name), name);
});

// ---------------------------------------------------------------- the desktop maximizes the pill (a global-menu top bar's button)
test('the pill is made unmaximizable', () => {
  const { dw, rec } = make();
  dw.create();
  for (const k of ['resizable', 'maximizable']) assert.strictEqual(rec.created[k], false, k);
});

test('when the desktop maximizes, fullscreens or minimizes the pill anyway, it is undone and the pill goes back where it was', async () => {
  const { electron, rec } = fakeElectron();
  const listeners = {};
  const Base = electron.BrowserWindow;
  const state = { max: false, full: false, min: false, log: [] };
  electron.BrowserWindow = class extends Base {
    on(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); return this; }
    isMaximized() { return state.max; } unmaximize() { state.max = false; state.log.push('unmaximize'); }
    isFullScreen() { return state.full; } setFullScreen(v) { state.full = v; state.log.push('fullscreen:' + v); }
    isMinimized() { return state.min; } restore() { state.min = false; state.log.push('restore'); }
  };
  const prefs = { edge: 'bottom', along: 0.5, hour12: false };
  const dw = new DockWindow({ electron, getPrefs: () => prefs, isBusy: () => false, onPlacementMismatch: () => {}, now: () => 0, preload: '/x/p.cjs', html: '/x/p.html' });
  live.push(dw);
  const win = dw.create();
  const box = (b) => ({ x: b.x, y: b.y, width: b.width, height: b.height });
  const home = box(win.getBounds());
  for (const [ev, flag] of [['maximize', 'max'], ['enter-full-screen', 'full'], ['minimize', 'min']]) {
    state[flag] = true; win.setBounds({ x: 0, y: 0, width: 1920, height: 1080 });         // what the desktop did
    listeners[ev].forEach((f) => f());
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(state[flag], false, `${ev} was undone`);
    assert.deepStrictEqual(box(win.getBounds()), home, `${ev}: back at the pill's own place and size`);
  }
  void rec;
});
