'use strict';

/**
 * Thin DOM layer over PillModel. All decisions live in pill-model.js (tested);
 * this file only applies them and wires events.
 *
 * Talks to the main process through window.pill, exposed by overlay/preload.cjs.
 * If that bridge is missing (e.g. opened in a plain browser for design work)
 * it falls back to a harmless stub so the page still renders.
 */
(function () {
  const M = window.PillModel;
  const bridge = window.pill || {
    onStatus() {}, onConfig() {}, onPhase() {}, onDrag() {}, onApproval() {}, send() {},
  };

  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const label = $('label'), clock = $('clock'), reply = $('reply');
  const natural = $('natural'), promptEl = $('prompt');

  let hour12 = false;
  let activity = [];
  let lingerTimer = null;
  let phase = 'hidden';
  let state = 'idle';
  let approval = null;            // the open question, or null
  let armTimer = null;
  let armed = false;              // the short delay after a question appears has passed

  function tick() { clock.textContent = M.formatClock(new Date(), hour12); }
  tick();
  // Align to the minute boundary so the clock flips exactly on time, then tick each minute.
  setTimeout(() => { tick(); setInterval(tick, 60_000); }, 60_000 - (Date.now() % 60_000));

  // ---- what the island shows, and how tall it needs to be --------------------------------
  let lastHeight = -1, raf = 0;
  const ISLAND_BOTTOM_PAD = 12;

  /** Tell main how tall the content wants the island. Only in the island; only when it changed. */
  function reportHeight() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (phase !== 'island') return;
      const h = Math.ceil(natural.offsetHeight) + ISLAND_BOTTOM_PAD;
      if (h !== lastHeight) { lastHeight = h; bridge.send('island-height', h); }
    });
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(reportHeight).observe(natural);

  // ---- engagement: the island must not vanish under someone who is typing ---------------
  let engaged = false;
  let windowFocused = document.hasFocus();          // does this WINDOW have the keyboard? (the strip and peek never do)
  function syncEngaged() {
    const now = M.isEngaged({
      phase, prompting: body.classList.contains('prompting'), windowFocused,
      promptActive: document.activeElement === promptEl, hasText: promptEl.value.length > 0,
    });
    if (now !== engaged) { engaged = now; bridge.send('engaged', engaged); }
  }
  promptEl.addEventListener('focus', syncEngaged);
  promptEl.addEventListener('blur', syncEngaged);
  promptEl.addEventListener('input', syncEngaged);

  // "Click outside": the person went to another window, so this one lost the keyboard. Main closes the island unless it
  // still has something to do (see DockWindow.windowBlurred). Only while the island is open: the 2 px strip and the
  // peek pill never had the keyboard, so there is nothing to close.
  // The engagement is brought up to date FIRST (messages reach main in order): the prompt box is still this page's active
  // element after the window loses the keyboard, and main must not take that for "still typing".
  window.addEventListener('blur', () => { windowFocused = false; syncEngaged(); if (phase === 'island') bridge.send('blurred'); });
  window.addEventListener('focus', () => { windowFocused = true; syncEngaged(); });

  let focusTimer = 0;
  function focusPromptSoon() {
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => { if (phase === 'island' && !approval && !M.isBusyState(state)) promptEl.focus(); }, 80);
  }

  function refreshMode() {
    const pv = M.promptView({ phase, state, approving: !!approval });
    body.classList.toggle('busy', M.isBusyState(state));
    body.classList.toggle('approving', !!approval);
    body.classList.toggle('prompting', pv.visible);
    if (!pv.visible && document.activeElement === promptEl) promptEl.blur();
    promptEl.placeholder = pv.placeholder;
    syncEngaged();
    reportHeight();
  }

  function renderActivity() {
    const ul = $('activity');
    ul.textContent = '';
    // The header already names the CURRENT action, so the list shows only what came
    // before it (no duplicate row, and the bottom line gets its breathing room).
    for (const a of activity.slice(0, -1)) {
      const li = document.createElement('li');
      if (a.error) li.className = 'err';
      li.textContent = a.text;           // textContent, never innerHTML: tool names are untrusted-ish
      ul.appendChild(li);
    }
  }

  function apply(status) {
    const v = M.viewFor(status);
    clearTimeout(lingerTimer);
    // A REPLAY is the same status re-sent because the dock changed phase. Logging its action again would
    // list one action twice, so replays refresh the display but never touch the activity log.
    const replay = !!(status && status.replay);
    if (!replay && status && status.state === 'acting' && status.detail) {
      activity = M.pushActivity(activity, status.detail);
      renderActivity();
    } else if (v.state === 'idle' || (!replay && status && status.state === 'thinking' && status.detail === 'Step 1')) {
      activity = []; renderActivity();
    }

    state = v.state;
    body.dataset.state = v.state;
    body.style.setProperty('--accent', `var(--c-${v.state})`);
    label.textContent = v.label;
    reply.textContent = v.reply;
    body.classList.toggle('expanded', v.expanded);
    refreshMode();
    if (!M.isBusyState(v.state)) focusPromptSoon();

    // Finished states relax back to the compact idle pill on their own.
    if (v.lingerMs) lingerTimer = setTimeout(() => apply({ state: 'idle' }), v.lingerMs);
  }

  bridge.onStatus(apply);
  bridge.onConfig((cfg) => {
    if (cfg && typeof cfg.hour12 === 'boolean') { hour12 = cfg.hour12; tick(); }
  });

  // The dock (main process) owns hidden/peek/island; the page only reflects it in CSS.
  bridge.onPhase((p) => {
    if (!p) return;
    const was = phase;
    phase = p.phase;
    body.dataset.phase = p.phase;      // hidden | peek | island
    body.dataset.edge = p.edge;        // top | bottom | left | right
    body.dataset.bulge = p.bulge;      // which way the liquid droplets bulge (away from the edge)
    body.classList.toggle('island', p.phase === 'island');
    if (p.inset) {
      const r = document.documentElement.style;
      r.setProperty('--in-t', `${p.inset.top}px`);
      r.setProperty('--in-r', `${p.inset.right}px`);
      r.setProperty('--in-b', `${p.inset.bottom}px`);
      r.setProperty('--in-l', `${p.inset.left}px`);
    }
    if (was === 'island' && phase !== 'island') { lastHeight = -1; promptEl.blur(); }
    if (phase === 'island') { if (was !== 'island') lastHeight = -1; focusPromptSoon(); }
    refreshMode();
  });

  // ---- the approval question ------------------------------------------------------------
  function answer(allow) {
    if (!approval) return;
    const id = approval.id;
    approval = null;
    clearTimeout(armTimer);
    bridge.send('approval-answer', { id, allow });
    refreshMode();
    focusPromptSoon();
  }

  bridge.onApproval((d) => {
    clearTimeout(armTimer);
    if (!d) { approval = null; refreshMode(); return; }
    const v = M.approvalView(d);
    if (!v.id) { approval = null; refreshMode(); return; }          // a question without an id cannot be answered
    approval = v;
    $('ap-title').textContent = v.title;
    $('ap-target').textContent = v.target;
    $('ap-body').textContent = v.body;
    $('ap-body').scrollTop = 0;
    $('ap-note').textContent = v.note;
    const ul = $('ap-risks'); ul.textContent = '';
    for (const r of v.risks) { const li = document.createElement('li'); li.textContent = r; ul.appendChild(li); }

    // Allow is DISABLED briefly and never focused: a click or Enter that was already on its way (the user was
    // pressing the pill, or submitting a task) must not be able to answer a question it never saw. Deny is
    // always available - refusing must never be delayed. If the text is longer than its box, Allow ALSO waits
    // until the user has scrolled to the end (see allowState).
    armed = false;
    $('btn-deny').disabled = false;
    updateAllow();
    armTimer = setTimeout(() => { armed = true; updateAllow(); }, M.ARM_MS);
    refreshMode();
    requestAnimationFrame(updateAllow);            // measure once the text has been laid out
    $('btn-deny').focus({ preventScroll: true });
  });
  /** Re-evaluate whether Allow may be pressed, from the box's CURRENT scroll position. */
  function updateAllow() {
    const box = $('ap-body');
    const st = M.allowState({ armed, overflow: M.overflows(box), atEnd: M.atScrollEnd(box) });
    $('btn-allow').disabled = !st.enabled;
    $('ap-hint').textContent = st.hint;
  }
  $('ap-body').addEventListener('scroll', updateAllow);
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => { if (approval) updateAllow(); }).observe($('ap-body'));

  // FOCUS TRAP. Clicking a disabled button (Allow, in its first half-second) drops focus to the page body, and then
  // Enter has nothing to activate. Whenever focus falls out while a question is open it goes back to Deny, so the
  // default action of the keyboard is always the SAFE one, and Allow only ever happens by a deliberate act on it.
  document.addEventListener('focusout', () => {
    if (!approval) return;
    setTimeout(() => {
      const a = document.activeElement;
      if (approval && (!a || a === document.body)) $('btn-deny').focus({ preventScroll: true });
    }, 0);
  });
  $('btn-allow').addEventListener('click', () => { if (!$('btn-allow').disabled) answer(true); });        // disabled covers BOTH the delay and the scroll rule
  $('btn-deny').addEventListener('click', () => answer(false));

  // ---- the prompt ----------------------------------------------------------------------------
  function submit() {
    const text = promptEl.value.trim();
    if (!text || M.isBusyState(state) || approval) return;
    bridge.send('submit-task', text);
    promptEl.value = '';
    syncEngaged();
  }
  promptEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  $('btn-send').addEventListener('click', submit);

  // ---- pointer -> main. The reveal logic depends on these arriving. ----------
  body.addEventListener('pointerenter', () => { body.classList.add('hover'); bridge.send('pointer-enter'); });
  body.addEventListener('pointerleave', () => { body.classList.remove('hover'); if (!pressedId) bridge.send('pointer-leave'); });

  // ---- press / drag / release -------------------------------------------------
  // The pill is both a button (click toggles the island) and a drag handle. main decides
  // which: a press that never moves past a small threshold is reported as a click.
  //
  // MOVE / RELEASE LISTEN ON `window`, NOT ON THE PILL. Measured in real Electron: no
  // `gotpointercapture` event ever fired, so capture was not being held, and once the pointer
  // left the pill's box the pill's own pointermove handler stopped hearing about it. The
  // drag then froze after ~100px. Listening at window level works whether or not capture is
  // granted; setPointerCapture is kept as a best-effort extra for when it is honoured.
  // The page sends NO coordinates: they would be relative to a window that moves under the pointer (the pill chased
  // its own tail - measured on a real GNOME desktop), and screenX/screenY are unusable (measured as 0,0). Main reads
  // the pointer's true position from the desktop each time it hears "moved".
  let pressedId = null;

  body.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;                      // left button only
    // A press on a control, the prompt, or the approval question is a click or a text selection, never a drag.
    if (e.target.closest && e.target.closest('#controls, #promptbar, #approval')) return;
    pressedId = e.pointerId;
    try { body.setPointerCapture(e.pointerId); } catch (_) { /* capture is best-effort */ }
    body.classList.add('pressed');
    bridge.send('drag-start');
  });

  window.addEventListener('pointermove', (e) => {
    if (pressedId === null || e.pointerId !== pressedId) return;
    bridge.send('drag-move');
  }, true);

  const finish = (e, cancelled) => {
    if (pressedId === null || e.pointerId !== pressedId) return;
    pressedId = null;
    body.classList.remove('pressed');
    try { body.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
    bridge.send(cancelled ? 'drag-cancel' : 'drag-end');
    if (!body.matches(':hover')) bridge.send('pointer-leave');
  };
  window.addEventListener('pointerup', (e) => finish(e, false), true);
  window.addEventListener('pointercancel', (e) => finish(e, true), true);
  // NOTE: deliberately no `lostpointercapture` handler. Capture is never granted here, so it
  // would either never fire or (if it did) end a healthy drag early.

  // ---- island buttons: the NON-TRAY route to Settings / Stop / Quit -----------------
  // Stock GNOME has no system tray, so these must not depend on one.
  const wire = (id, action) => $(id).addEventListener('click', (e) => { e.stopPropagation(); bridge.send(action); });
  wire('btn-workspace', 'open-workspace');
  wire('btn-settings', 'open-settings');
  wire('btn-stop', 'stop-agent');
  wire('btn-quit', 'quit-app');

  // Escape: with a question open it means NO (never "hide the island and leave the agent waiting on a question
  // nobody can see"); otherwise it discards the draft and hides the island.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (approval) { answer(false); return; }
    promptEl.value = ''; syncEngaged();
    bridge.send('dismiss');
  });

  // Visual feedback while dragging (a grabbing cursor + a slightly lifted pill).
  bridge.onDrag((d) => {
    body.classList.toggle('dragging', !!(d && d.active));
    if (d && d.preview) body.dataset.snapEdge = d.preview.edge;
  });

  apply({ state: 'idle' });
})();
