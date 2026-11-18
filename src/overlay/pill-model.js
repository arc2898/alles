'use strict';

/**
 * Pill view-model. PURE: no DOM, no Electron. The renderer script applies the
 * result; tests exercise this file directly.
 *
 * Works both as a CommonJS module (tests) and as a plain <script> (renderer),
 * because the renderer is sandboxed and cannot use require().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PillModel = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  const STATES = ['idle', 'thinking', 'acting', 'waiting', 'done', 'error', 'stopped'];

  // Friendly text per tool, so the pill says what the agent is DOING.
  const TOOL_VERBS = {
    screenshot: 'Looking at the screen',
    mouse_move: 'Moving the cursor',
    mouse_click: 'Clicking',
    mouse_scroll: 'Scrolling',
    mouse_drag: 'Dragging',
    type_text: 'Typing',
    press_keys: 'Pressing keys',
    run_shell: 'Running a command',
    read_file: 'Reading a file',
    write_file: 'Writing a file',
    list_dir: 'Browsing files',
    wait: 'Waiting',
    finish: 'Wrapping up',
  };

  const STATE_LABELS = {
    idle: 'Idle',
    thinking: 'Thinking…',
    waiting: 'Needs your approval',
    done: 'Done',
    error: 'Something went wrong',
    stopped: 'Stopped',
  };

  // How long a finished/failed pill stays expanded before it relaxes to idle.
  const LINGER_MS = { done: 12000, error: 15000, stopped: 4000 };

  const MAX_REPLY_CHARS = 280; // the pill shows a preview; the full text lives in the app window

  function pad(n) { return String(n).padStart(2, '0'); }

  /** "14:05" (24h) or "2:05 PM" (12h). Takes a Date so tests are deterministic. */
  function formatClock(date, hour12 = false) {
    const h = date.getHours(), m = date.getMinutes();
    if (!hour12) return `${pad(h)}:${pad(m)}`;
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
  }

  /** Trim to a preview without cutting mid-word where possible. */
  function truncateReply(text, max = MAX_REPLY_CHARS) {
    const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s.,;:]+$/, '')}…`;
  }

  /**
   * status event -> what the pill should show.
   * @param {{state:string, detail?:string}} status
   * @returns {{state, label, expanded, reply, lingerMs}}
   */
  function viewFor(status) {
    const state = STATES.includes(status && status.state) ? status.state : 'idle';
    const detail = (status && status.detail) || '';

    let label = STATE_LABELS[state];
    if (state === 'acting') label = TOOL_VERBS[detail] || (detail ? `Using ${detail}` : 'Working…');
    if (state === 'thinking' && /^Step \d+$/.test(detail)) label = `Thinking… (${detail.toLowerCase()})`;

    // Only terminal states carry a reply worth reading; working states stay compact.
    const showsReply = state === 'done' || state === 'error' || state === 'waiting';
    const reply = showsReply ? truncateReply(detail) : '';

    return {
      state,
      label,
      expanded: showsReply && reply.length > 0,
      reply,
      lingerMs: LINGER_MS[state] || 0,
    };
  }

  const MAX_LOG = 4;

  /**
   * Append a tool event to the visible activity log (newest last, capped).
   * Pure: returns a NEW array so callers/tests can compare before/after.
   */
  function pushActivity(log, toolName, { error = false } = {}) {
    const text = TOOL_VERBS[toolName] || `Using ${toolName}`;
    const next = log.concat([{ text, error: !!error }]);
    return next.slice(-MAX_LOG);
  }

  const BUSY_STATES = ['thinking', 'acting', 'waiting'];
  const isBusyState = (state) => BUSY_STATES.includes(state);

  // How long the Allow button stays disabled after a question appears. A click that was already on its way
  // (the user pressing the pill, dragging, double-clicking) must not be able to answer a question it never saw.
  const ARM_MS = 500;

  /** Should the prompt box be on screen? Only in the island, and never while the agent works or a question is open. */
  function promptView({ phase, state, approving }) {
    return {
      visible: phase === 'island' && !isBusyState(state) && !approving,
      placeholder: state === 'done' ? 'Ask a follow-up\u2026' : 'Ask ALLES to do something\u2026',
    };
  }

  /**
   * Is the person working in the prompt box, so that the island must not close under them?
   * Yes while the box has the keyboard - which needs the WINDOW to have it too (Chromium keeps a box "active" after its
   * window loses the keyboard, so without this check clicking another application never closed the island: measured on
   * a real GNOME desktop). Text left in the box (a draft) also counts, whoever has the keyboard. Only while the box is on
   * screen: a focused element that is hidden is not reliably blurred.
   */
  function isEngaged({ phase, prompting, windowFocused, promptActive, hasText }) {
    if (phase !== 'island' || !prompting) return false;
    return !!hasText || (!!windowFocused && !!promptActive);
  }

  /** An approval question (from main) -> exactly what the panel shows. Tolerates any junk: this renders untrusted text. */
  function approvalView(d) {
    const q = d && typeof d === 'object' ? d : {};
    const str = (v) => (typeof v === 'string' ? v : '');
    const body = str(q.body);
    const risks = Array.isArray(q.risks) ? q.risks.filter((r) => typeof r === 'string' && r).slice(0, 8) : [];
    let note = '';
    if (q.kind === 'file') {
      const size = Number.isFinite(q.bytes) ? `${q.bytes} bytes` : 'unknown size';
      note = q.truncated && Number.isFinite(q.total) ? `${size}. Showing the first ${body.length} of ${q.total} characters.` : size;
    }
    return { id: str(q.id), kind: str(q.kind) || 'other', title: str(q.title) || 'Allow this action?', target: str(q.target), body, note, risks };
  }

  /** Is a scrollable box scrolled to (within a few pixels of) its end? */
  function atScrollEnd(box, slack = 4) {
    return box.scrollTop + box.clientHeight >= box.scrollHeight - slack;
  }
  /** Is there more content than the box shows? */
  function overflows(box) { return box.scrollHeight > box.clientHeight + 1; }

  /**
   * May the Allow button be pressed, and what should the user be told?
   * Allow needs BOTH the short delay after the question appears AND, when the text is longer than the box, that the
   * user has scrolled to its end. A command padded with harmless lines so its dangerous tail is out of sight must
   * not be approvable by someone who never saw the tail. (The risk hints cannot be relied on for this: they are
   * pattern matches and shell can say anything.)
   */
  function allowState({ armed, overflow, atEnd }) {
    const hidden = !!overflow && !atEnd;
    return { enabled: !!armed && !hidden, hint: hidden ? 'This is longer than the box. Scroll to the end to read all of it \u2014 Allow unlocks when you have.' : '' };
  }

  return { MAX_LOG, BUSY_STATES, ARM_MS, atScrollEnd, overflows, allowState, isBusyState, promptView, isEngaged, approvalView, pushActivity, STATES, TOOL_VERBS, STATE_LABELS, LINGER_MS, MAX_REPLY_CHARS, formatClock, truncateReply, viewFor };
}));
