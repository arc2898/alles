'use strict';

const { codes, aliases } = require('./keymap');
const { prepareTypeText, describeRejection, prepareUnicodeText, describeUnicodeRejection } = require('./typetext');
const { YdotoolBackend, childEnv, CHILD_ENV_KEYS, comboToArgs, MOUSE_BUTTONS, isMouseButton } = require('./ydotool-backend');

/**
 * InputController - the one door every mouse and keyboard action goes through.
 *
 * It does the part that must be the same whatever carries the input out:
 *   - SAFETY: every action passes `gate` first. Nothing is sent if the emergency stop is engaged, the rate limit is hit,
 *     or the action matches a blocked pattern (key combinations that end the session). The gate is pure logic and unit-tested.
 *   - CHECKING: coordinates, button names, key names and the text itself are validated before anything is sent.
 *
 * and hands the actual sending to a BACKEND:
 *   - mutter-backend.js    GNOME's own remote-input service: nothing to install, exact pointer positions, any text.
 *   - ydotool-backend.js   a virtual device made with ydotool + /dev/uinput: works on every desktop, needs setup.
 * Both answer the same questions (moveTo, click, drag, scroll, typeText, pressKeys ...), so they can be swapped at any time.
 */

// Combos that can destroy the session or bypass the human. Blocked unless the
// user explicitly enables `allowDangerous` in Settings.
const DANGEROUS_COMBOS = [
  ['ctrl', 'alt', 'delete'],
  ['ctrl', 'alt', 'backspace'],
  ['ctrl', 'alt', 'f1'], ['ctrl', 'alt', 'f2'], ['ctrl', 'alt', 'f3'],
  ['ctrl', 'alt', 'f4'], ['ctrl', 'alt', 'f5'], ['ctrl', 'alt', 'f6'],
  ['alt', 'sysrq'],
  ['super', 'l'], // lock screen: the agent locking you out mid-task is never wanted
];

function normalizeKey(name) {
  const k = String(name).trim().toLowerCase().replace(/^key_/, '');
  const canon = aliases[k] || k;
  if (!(canon in codes)) throw new Error(`Unknown key "${name}"`);
  return { name: k, canon, code: codes[canon] };
}

/** Parse "ctrl+shift+t" into ordered normalized keys. */
function parseCombo(combo) {
  const parts = String(combo).split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('Empty key combo');
  return parts.map(normalizeKey);
}

// Every spelling of a modifier collapses to ONE family, so the blocklist cannot
// be dodged with an alias ("meta", "win", "cmd") or the right-hand key.
const FAMILY = {
  leftctrl: 'ctrl', rightctrl: 'ctrl',
  leftalt: 'alt', rightalt: 'alt',
  leftshift: 'shift', rightshift: 'shift',
  leftmeta: 'super', rightmeta: 'super',
};

function familyOf(key) {
  return FAMILY[key.canon] || key.canon;
}

function isDangerousCombo(keys) {
  const held = new Set(keys.map(familyOf));
  return DANGEROUS_COMBOS.some((combo) => combo.every((c) => held.has(c)));
}

class SafetyGate {
  constructor({ maxActionsPerMinute = 120, allowDangerous = false, now = Date.now } = {}) {
    this.maxPerMin = maxActionsPerMinute;
    this.allowDangerous = allowDangerous;
    this.now = now;
    this.stopped = false;
    this.stamps = [];
  }
  stop() { this.stopped = true; }
  resume() { this.stopped = false; this.stamps = []; }

  /** Throws if the action must not run. */
  check(action) {
    if (this.stopped) throw new Error('Emergency stop is engaged - agent input is disabled');

    const t = this.now();
    this.stamps = this.stamps.filter((s) => t - s < 60_000);
    if (this.stamps.length >= this.maxPerMin) {
      throw new Error(`Rate limit: more than ${this.maxPerMin} input actions/minute`);
    }

    if (action.type === 'key' && !this.allowDangerous && isDangerousCombo(action.keys)) {
      throw new Error(`Blocked dangerous key combo "${action.combo}" (enable in Settings > Safety to allow)`);
    }
    this.stamps.push(t);
  }
}

class InputController {
  /**
   * @param {object} [o]
   * @param {SafetyGate} [o.gate]
   * @param {object} [o.backend]   what carries the input out. Default: ydotool (with `bin`, `socket`, `exec` as options for it).
   */
  constructor({ gate = new SafetyGate(), backend = null, bin, socket, exec } = {}) {
    this.gate = gate;
    this.backend = null;
    this.setBackend(backend || new YdotoolBackend({ bin, socket, exec }), { closeOld: false });
  }

  /** Swap the way input is carried out (the person changed it in Settings). The old one is closed. */
  setBackend(backend, { closeOld = true } = {}) {
    const old = this.backend;
    this.backend = backend;
    backend.cancelled = () => this.gate.stopped;     // lets a long action (typing, a drag) stop between steps
    if (closeOld && old && old !== backend) { try { const p = old.dispose ? old.dispose() : old.close && old.close(); if (p && p.catch) p.catch(() => {}); } catch { /* ignore */ } }
  }

  /** What the current backend is and can do (name, label, unicode, scroll, drag ...). */
  info() { return this.backend.info(); }

  /** A new task starts: the emergency stop is released, and so is a stop the person made from GNOME's sharing indicator. */
  resume() { this.gate.resume(); if (typeof this.backend.resume === 'function') this.backend.resume(); }

  /** Let go of whatever the backend holds open (GNOME's sharing indicator, a connection). The next action reopens it. */
  close() { try { const p = this.backend.close(); if (p && p.catch) p.catch(() => {}); } catch { /* ignore */ } }

  async dispose() { try { await this.backend.dispose(); } catch { /* ignore */ } }

  /** `space` = {width, height} of the picture the coordinates were read from (the screenshot), when it is not the screen itself. */
  async moveTo(x, y, { space } = {}) {
    this._int(x, 'x'); this._int(y, 'y');
    this.gate.check({ type: 'move' });
    return this.backend.moveTo(x, y, space);
  }

  async moveBy(dx, dy) {
    this._int(dx, 'dx'); this._int(dy, 'dy');
    this.gate.check({ type: 'move' });
    return this.backend.moveBy(dx, dy);
  }

  async click(button = 'left', { double = false } = {}) {
    if (!isMouseButton(button)) throw new Error(`Unknown mouse button "${button}"`);
    this.gate.check({ type: 'click' });
    return this.backend.click(button, { double });
  }

  /** Press at `from`, move to `to`, release. */
  async drag(from, to, { button = 'left', space } = {}) {
    if (!from || !to) throw new Error('drag() needs a start and an end');
    this._int(from.x, 'from x'); this._int(from.y, 'from y'); this._int(to.x, 'to x'); this._int(to.y, 'to y');
    if (!isMouseButton(button)) throw new Error(`Unknown mouse button "${button}"`);
    this.gate.check({ type: 'drag' });
    return this.backend.drag({ x: from.x, y: from.y }, { x: to.x, y: to.y }, { button, space });
  }

  /** Turn the mouse wheel by whole notches at the pointer: positive dy = down, positive dx = right. */
  async scroll(dx = 0, dy = 0) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) > 1000 || Math.abs(dy) > 1000) throw new Error(`Invalid scroll amount: ${dx}, ${dy}`);
    if (!Math.round(dx) && !Math.round(dy)) throw new Error('Nothing to scroll: the amount is zero');
    this.gate.check({ type: 'scroll' });
    return this.backend.scroll(Math.round(dx), Math.round(dy));
  }

  /**
   * Type text. Returns { typed, notes } - `notes` lists any conversions made, so the caller
   * can tell the model exactly what was typed. Throws (typing NOTHING) if the text contains
   * characters that cannot be entered.
   * @param {object} [o]
   * @param {number}  [o.delayMs]   pause between keys
   * @param {boolean} [o.terminal]  the focused window is a terminal: pasted characters need Ctrl+Shift+V there
   */
  async type(text, { delayMs = 12, terminal = false } = {}) {
    if (typeof text !== 'string' || !text.length) throw new Error('type() needs non-empty text');
    if (text.length > 2000) throw new Error('Refusing to type more than 2000 chars at once');
    const caps = await this.backend.capabilities();
    // Validate BEFORE the safety gate: a rejected string must not use up rate-limit budget.
    const prepared = caps.unicode ? prepareUnicodeText(text) : prepareTypeText(text);
    if (prepared.rejected.length) throw new Error(caps.unicode ? describeUnicodeRejection(prepared.rejected) : describeRejection(prepared.rejected));
    if (!prepared.text.length) throw new Error('Nothing to type after removing invisible characters');
    this.gate.check({ type: 'type' });
    const r = await this.backend.typeText(prepared.text, { delayMs, pasteKeys: terminal ? 'ctrl+shift+v' : 'ctrl+v' });
    return { typed: caps.unicode ? [...prepared.text].length : prepared.text.length, notes: [...prepared.notes, ...((r && r.notes) || [])] };
  }

  async pressCombo(combo) {
    const keys = parseCombo(combo);
    this.gate.check({ type: 'key', keys, combo });
    return this.backend.pressKeys(keys);
  }

  _int(v, name) {
    if (!Number.isFinite(v) || Math.abs(v) > 20000) throw new Error(`Invalid ${name}: ${v}`);
  }
}

module.exports = { InputController, SafetyGate, childEnv, CHILD_ENV_KEYS, parseCombo, comboToArgs, isDangerousCombo, normalizeKey, DANGEROUS_COMBOS };
