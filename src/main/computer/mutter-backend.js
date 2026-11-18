'use strict';

const { MutterTransport, InputUnavailable, isSessionGone } = require('./mutter-transport');
const { readLayout, canType } = require('./keyboard-layout');
const { keysymForKey, isPlainAscii } = require('./keysyms');

/**
 * Mouse and keyboard through GNOME's own remote-input service: no daemon, no /dev/uinput, no setup.
 * (mutter-transport.js explains the service and how it is reached; this file decides what to send.)
 *
 * Everything below that looks odd was MEASURED on a real GNOME Shell 46, with a window that reported what reached it:
 *
 *  - The FIRST key of every new session is lost (the app never hears it, however long we wait first). A tap of Shift - harmless
 *    in any text box - goes first, once per session, and then every key arrives.
 *  - The FIRST pointer motion does not refresh which window is under the pointer, so a click right after it goes nowhere
 *    (cold window: 0 of 2 clicks; after a second motion: 2 of 2). Every move therefore sends its position twice, 70 ms apart.
 *  - An X11 app loses the FIRST wheel step each time the pointer enters one of its windows (it needs one scroll reading to know
 *    where the wheel "is"); a native Wayland app does not. A speck of smooth scrolling (0.05) first teaches it and is far too
 *    small to move anything, so the real steps all count.
 *  - Text goes by KEYSYM ("the letter z"), not by key position: with a German layout position-Z makes "y". But a keysym the
 *    layout cannot make types NOTHING (accents, rupee sign, emoji, CJK all measured: nothing). Those are pasted from the clipboard.
 *  - Absolute pointer coordinates are PHYSICAL pixels of the recorded area, i.e. the same pixels gnome-screenshot's pictures use.
 *  - A session's pointer only "wakes up" at its SECOND motion event. Before that a button press or a wheel turn reaches nobody, even
 *    with the pointer sitting right over the window (measured: 0 of 3 clicks and 0 of 3 scrolls; one absolute move, or one relative
 *    move, or none: lost; any two moves: all arrive). moveTo sends two, so this only bites when the first thing a session does is
 *    a click, a button press or a scroll - and "scroll where the pointer already is" is exactly that, at the start of every task.
 */

const BUTTONS = { left: 0x110, right: 0x111, middle: 0x112 };       // Linux evdev button codes
const buttonCode = (button) => (typeof button === 'string' && Object.prototype.hasOwnProperty.call(BUTTONS, button) ? BUTTONS[button] : 0);   // 0 = not a button (names like "toString" are not buttons)
const KEY = { CTRL: 29, SHIFT: 42, V: 47, ENTER: 28, TAB: 15 };      // evdev key codes (places on the keyboard)
const STOPPED_MESSAGE = 'Emergency stop is engaged - agent input is disabled';
const WAKES_POINTER = new Set(['button', 'axis', 'axisDiscrete']);     // the events that are lost on a pointer that has not had two motions yet

const T = {
  moveGap: 70, moveSettle: 40,                  // between the two motion events of a move, and after it
  clickHold: 45, doubleGap: 70,
  keyHold: 6, chordGap: 15, chordHold: 40,
  primeWait: 30,                                // after the first-key prime
  scrollPrime: 0.05, scrollPrimeWait: 30, scrollChunk: 10, scrollGap: 25,
  dragGrab: 120, dragStep: 18, dragEnd: 100,
  pasteSettle: 120, pasteWait: 250, pasteRestore: 450,
};

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * Split text into what is typed key by key, what is pasted, and Enter / Tab presses.
 * @param {string} text
 * @param {{canKey:boolean|((ch:string)=>boolean), canPaste:boolean}} how
 *        canKey: can the active layout make this character by keysym? (a plain true / false answers for every character)
 * @returns {{segments:{kind:'keys'|'paste'|'enter'|'tab', text:string}[], error?:string}}
 */
function planTyping(text, { canKey, canPaste }) {
  const can = typeof canKey === 'function' ? canKey : () => !!canKey;
  const segs = [];
  const push = (kind, ch) => {
    const last = segs[segs.length - 1];
    if (last && last.kind === kind && (kind === 'keys' || kind === 'paste')) last.text += ch;
    else segs.push({ kind, text: kind === 'enter' || kind === 'tab' ? '' : ch });
  };
  for (const ch of text) {
    if (ch === '\n') push('enter', '');
    else if (ch === '\t') push('tab', '');
    else if (isPlainAscii(ch) && can(ch)) push('keys', ch);
    else push('paste', ch);
  }
  // A few plain letters between two pasted pieces are cheaper to paste with them than to type between two pastes.
  for (let i = 1; i < segs.length - 1; i++) {
    if (segs[i].kind === 'keys' && segs[i].text.length <= 3 && segs[i - 1].kind === 'paste' && segs[i + 1].kind === 'paste') {
      segs.splice(i - 1, 3, { kind: 'paste', text: segs[i - 1].text + segs[i].text + segs[i + 1].text });
      i = Math.max(0, i - 2);
    }
  }
  if (!canPaste && segs.some((s) => s.kind === 'paste')) {
    return {
      segments: segs,
      error: can('a')
        ? 'These characters cannot be typed with the keyboard, and pasting them needs the clipboard, which is not available here.'
        : 'The active keyboard layout or input method cannot type Latin letters, and pasting text needs the clipboard, which is not available here. Switch to a Latin layout.',
    };
  }
  return { segments: segs };
}

class MutterBackend {
  /**
   * @param {object} [o]
   * @param {object}   [o.transport]   how to reach the service (tests give a fake)
   * @param {object}   [o.clipboard]   {readText, writeText, clear, availableFormats?}  - Electron's clipboard; without it only plain ASCII can be entered
   * @param {Function} [o.readLayout]  () => Promise<{latin, ime, id}>
   * @param {Function} [o.sleep]       (ms) => Promise
   * @param {Function} [o.setTimer] [o.clearTimer] [o.now]
   * @param {number}   [o.idleMs]      close the session (and the sharing indicator) after this long without use
   * @param {Function} [o.onUserStop]  called when the PERSON ends the session (the sharing indicator's stop button)
   * @param {Function} [o.log]
   */
  constructor({
    transport = new MutterTransport(), clipboard = null, readLayout: readLayoutFn = readLayout, sleep = sleepReal,
    setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, idleMs = 45_000, layoutTtlMs = 3000,
    onUserStop = null, log = () => {},
  } = {}) {
    this.transport = transport;
    this.clipboard = clipboard;
    this.readLayoutFn = readLayoutFn;
    this.sleep = sleep;
    this.setTimer = setTimer; this.clearTimer = clearTimer; this.now = now;
    this.idleMs = idleMs; this.layoutTtlMs = layoutTtlMs;
    this.onUserStop = onUserStop;
    this.log = log;
    this.cancelled = () => false;               // the front end points this at the emergency stop
    this.session = null;
    this.userStopped = false;
    this.lastSpace = null;
    this._opening = null;
    this._queue = Promise.resolve();
    this._idle = null;
    this._layout = null; this._layoutAt = 0;
    this._availability = null;
    this._displayHooked = false;
  }

  info() { return { name: 'gnome', label: 'GNOME direct input (no setup needed)', unicode: !!this.clipboard, scroll: true, drag: true }; }
  async capabilities() { return this.info(); }

  /** After the person stopped the session from the top bar: allow input again (a new task = a fresh start). */
  resume() { this.userStopped = false; }

  /** Open the session now (rather than at the first event) and say so if it cannot be opened: the error is flagged `unavailable`. */
  ready() { return this._exclusive(async () => { await this._ensure(); this._touch(); }); }

  // ------------------------------------------------------------------ session

  _stoppedError() {
    const e = new Error('The person stopped remote input from the screen-sharing indicator. Stop and ask them before doing anything else.');
    e.userStopped = true;
    return e;
  }

  /** @param {{width:number,height:number}} [hint]  size of the picture the model is working from: the best guess for the desktop if DisplayConfig cannot say */
  async _ensure(hint) {
    if (this.userStopped) throw this._stoppedError();
    if (this.session) return this.session;
    if (this._opening) return this._opening;
    this._opening = (async () => {
      if (!this._availability) this._availability = await this.transport.available();
      if (!this._availability.ok) { const r = this._availability.reason; this._availability = null; throw new InputUnavailable(r); }
      const d = await this.transport.desktop();
      const fallback = (hint && hint.width > 0 && hint.height > 0 ? hint : null) || this.lastSpace || { width: 1920, height: 1080 };
      const geo = d || { x: 0, y: 0, width: fallback.width, height: fallback.height, scale: 1 };
      const area = { x: geo.x, y: geo.y, width: geo.width, height: geo.height };
      const s = await this.transport.open(area);
      s.geometry = { ...area, scale: geo.scale || 1, streamWidth: Math.round(area.width * (geo.scale || 1)), streamHeight: Math.round(area.height * (geo.scale || 1)) };
      s.keyPrimed = false;
      s.motions = 0;                                       // pointer motion events sent in this session (see WAKES_POINTER)
      s.onClosed(() => this._sessionClosed(s));
      this.session = s;
      this._hookDisplayChanges();
      this.log(`GNOME input session open (${s.geometry.streamWidth}x${s.geometry.streamHeight} px, scale ${s.geometry.scale})`);
      return s;
    })().finally(() => { this._opening = null; });
    return this._opening;
  }

  _hookDisplayChanges() {
    if (this._displayHooked || typeof this.transport.onDisplayChange !== 'function') return;
    this._displayHooked = true;
    Promise.resolve(this.transport.onDisplayChange(() => { this.log('screens changed: next input opens a fresh session'); this._dropSession(); })).catch(() => { this._displayHooked = false; });
  }

  /** The service ended a session. If WE did not ask for that, the person did (stop button in the sharing indicator). */
  _sessionClosed(s) {
    if (this.session === s) this.session = null;
    if (s.closedByUs) return;
    this.userStopped = true;
    this.log('remote input was stopped by the person');
    if (this.onUserStop) { try { this.onUserStop(); } catch { /* the callback must not break us */ } }
  }

  _dropSession() {
    const s = this.session; this.session = null;
    if (this.clearTimer && this._idle) { this.clearTimer(this._idle); this._idle = null; }
    if (s) s.stop().catch(() => {});
  }

  _touch() {
    if (this._idle) this.clearTimer(this._idle);
    this._idle = this.setTimer(() => { this._idle = null; this.log('GNOME input session closed (idle)'); this._dropSession(); }, this.idleMs);
    if (this._idle && typeof this._idle.unref === 'function') this._idle.unref();
  }

  /** ONE event to the service, unless the emergency stop is engaged (then nothing is sent). */
  async _call(method, ...args) {
    if (this.cancelled()) throw new Error(STOPPED_MESSAGE);
    return this._send(method, args);
  }

  /**
   * Let go of a key or button. Three rules, all because a held Ctrl or mouse button left behind is the worst thing this file can do:
   * the emergency stop does NOT block it, it never opens a new session (a fresh session holds nothing), and it never throws
   * (if the session is gone the service has already released everything the session held).
   */
  async _letGo(method, value) {
    const s = this.session;
    if (!s) return;
    try { await s[method](value, false); this._touch(); } catch (e) { this.log(`could not release ${method} ${value}: ${(e && (e.text || e.message)) || e}`); }
  }

  /** One press, a short hold, one release. The release happens whatever goes wrong during the hold (emergency stop, session lost). */
  async _tap(method, value, hold) {
    await this._call(method, value, true);
    try { await this.sleep(hold); } finally { await this._letGo(method, value); }
  }

  /**
   * One event to the service WITHOUT the emergency-stop check (see _call). If the session has vanished (the Shell restarted, ...)
   * a fresh one is opened and the event is sent again, once. Key events first make sure the session's first-key loss has been
   * used up on a harmless Shift tap, and a button or wheel event makes sure the session's pointer has had its two motions: if it
   * has not, a step of 1 px to the left and straight back is sent (left first, so that a pointer in the top-left corner leaves the
   * Overview's hot corner and never re-enters it). That moves nothing for good and costs 110 ms, once per session.
   */
  async _send(method, args) {
    for (let attempt = 0; ; attempt++) {
      const s = await this._ensure();
      try {
        if ((method === 'keycode' || method === 'keysym') && !s.keyPrimed) {
          s.keyPrimed = true;
          await s.keycode(KEY.SHIFT, true); await s.keycode(KEY.SHIFT, false);
          await this.sleep(T.primeWait);
        }
        if (WAKES_POINTER.has(method) && s.motions < 2) {
          s.motions = 2;
          await s.pointerRelative(-1, 0);
          await this.sleep(T.moveGap);
          await s.pointerRelative(1, 0);
          await this.sleep(T.moveSettle);
        }
      } catch (e) {
        if (this.userStopped) throw this._stoppedError();
        if (isSessionGone(e) && attempt === 0) { this._sessionLost(s); continue; }
        throw this._wrap(e);
      }
      try {
        const r = await s[method](...args);
        if (method === 'pointerAbsolute' || method === 'pointerRelative') s.motions++;
        this._touch();
        return r;
      } catch (e) {
        if (this.userStopped) throw this._stoppedError();
        if (attempt === 0 && isSessionGone(e)) { this._sessionLost(s); continue; }
        throw this._wrap(e);
      }
    }
  }

  _sessionLost(s) { if (this.session === s) this.session = null; s.closedByUs = true; }

  _wrap(e) {
    if (e && (e.unavailable || e.userStopped)) return e;
    const wrapped = new Error(`GNOME remote input failed: ${(e && (e.text || e.message)) || e}`);
    if (isSessionGone(e)) wrapped.unavailable = true;
    return wrapped;
  }

  /** Run one whole action with nothing else interleaved (a click must not land in the middle of typing). */
  _exclusive(fn) {
    const p = this._queue.then(() => fn());
    this._queue = p.catch(() => {});
    return p;
  }

  async _getLayout() {
    if (this._layout && this.now() - this._layoutAt < this.layoutTtlMs) return this._layout;
    let l;
    try { l = await this.readLayoutFn(); } catch { l = null; }
    this._layout = l || { latin: true, ime: false, id: 'us' };
    this._layoutAt = this.now();
    return this._layout;
  }

  // ------------------------------------------------------------------ pointer

  /** Where (in the session's own pixels) a point of the picture the model saw is. `space` = size of that picture. */
  _toStream(s, x, y, space) {
    const g = s.geometry;
    const sp = space && space.width > 0 && space.height > 0 ? space : { width: g.streamWidth, height: g.streamHeight };
    if (space && space.width > 0) this.lastSpace = { width: space.width, height: space.height };
    const sx = clamp((x * g.streamWidth) / sp.width, 0, g.streamWidth - 1);
    const sy = clamp((y * g.streamHeight) / sp.height, 0, g.streamHeight - 1);
    return [Math.round(sx * 100) / 100, Math.round(sy * 100) / 100];
  }

  async _abs(x, y, space) {
    if (this.cancelled()) throw new Error(STOPPED_MESSAGE);      // before _ensure: a stopped agent must not open a session (and the sharing indicator)
    const s = await this._ensure(space);
    const [sx, sy] = this._toStream(s, x, y, space);
    await this._call('pointerAbsolute', sx, sy);
  }

  async _moveTo(x, y, space) {
    await this._abs(x, y, space);
    await this.sleep(T.moveGap);
    await this._abs(x, y, space);
    await this.sleep(T.moveSettle);
  }

  moveTo(x, y, space) { return this._exclusive(() => this._moveTo(x, y, space)); }

  moveBy(dx, dy) { return this._exclusive(() => this._call('pointerRelative', dx, dy)); }

  async _click(button, double) {
    const code = buttonCode(button);
    if (!code) throw new Error(`Unknown mouse button "${button}"`);
    for (let i = 0; i < (double ? 2 : 1); i++) {
      if (i) await this.sleep(T.doubleGap);
      await this._tap('button', code, T.clickHold);
    }
  }

  click(button = 'left', { double = false } = {}) { return this._exclusive(() => this._click(button, double)); }

  mouseDown(button = 'left') {
    if (!buttonCode(button)) return Promise.reject(new Error(`Unknown mouse button "${button}"`));
    return this._exclusive(() => this._call('button', buttonCode(button), true));
  }
  mouseUp(button = 'left') {
    if (!buttonCode(button)) return Promise.reject(new Error(`Unknown mouse button "${button}"`));
    return this._exclusive(() => this._letGo('button', buttonCode(button)));      // letting go is always allowed, even after an emergency stop
  }

  drag(from, to, { button = 'left', space } = {}) {
    return this._exclusive(async () => {
      const code = buttonCode(button);
      if (!code) throw new Error(`Unknown mouse button "${button}"`);
      await this._moveTo(from.x, from.y, space);
      await this._call('button', code, true);
      try {
        await this.sleep(T.dragGrab);
        const dist = Math.hypot(to.x - from.x, to.y - from.y);
        const steps = clamp(Math.round(dist / 30), 6, 40);
        for (let i = 1; i <= steps; i++) {
          await this._abs(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, space);
          await this.sleep(T.dragStep);
        }
        await this._abs(to.x, to.y, space);
        await this.sleep(T.dragEnd);
      } finally {
        // never leave the button held down, whatever went wrong on the way (an emergency stop included)
        await this._letGo('button', code);
      }
    });
  }

  /** Wheel notches: positive dy = down, positive dx = right. */
  scroll(dx, dy) {
    return this._exclusive(async () => {
      if (dy) await this._scrollAxis(0, dy);
      if (dx) await this._scrollAxis(1, dx);
    });
  }

  async _scrollAxis(axis, notches) {
    const sign = notches < 0 ? -1 : 1;
    let left = Math.min(Math.abs(Math.round(notches)), 100);
    if (!left) return;
    await this._call('axis', axis === 1 ? sign * T.scrollPrime : 0, axis === 0 ? sign * T.scrollPrime : 0, 1);
    await this.sleep(T.scrollPrimeWait);
    while (left > 0) {
      const n = Math.min(left, T.scrollChunk);
      await this._call('axisDiscrete', axis, sign * n);
      left -= n;
      if (left) await this.sleep(T.scrollGap);
    }
  }

  // ------------------------------------------------------------------ keyboard

  async _tapCode(code, gap) {
    await this._tap('keycode', code, T.keyHold);
    await this.sleep(gap);
  }

  async _typeKeys(text, gap) {
    for (const ch of text) {
      const sym = ch.codePointAt(0);                      // printable ASCII: the keysym number IS the character code
      await this._tap('keysym', sym, T.keyHold);
      await this.sleep(gap);
    }
  }

  /** Press keys together, hold briefly, let go in reverse. The ones already down are released even if a later press fails. */
  async _chord(ops) {
    const down = [];
    try {
      for (const op of ops) { await this._call(op.m, op.v, true); down.push(op); await this.sleep(T.chordGap); }
      await this.sleep(T.chordHold);
    } finally {
      for (const op of down.reverse()) { await this._letGo(op.m, op.v); await this.sleep(T.chordGap); }
    }
  }

  _saveClipboard() {
    const cb = this.clipboard;
    let text = ''; let nonText = false;
    try { text = String(cb.readText() || ''); } catch { /* unreadable: nothing to restore */ }
    try { if (typeof cb.availableFormats === 'function') nonText = cb.availableFormats().some((f) => !/^text\//i.test(f) && !/^(string|utf8_string|text)$/i.test(f)); } catch { /* ignore */ }
    return { text, nonText };
  }

  async _restoreClipboard(saved) {
    await this.sleep(T.pasteRestore);                    // the target reads the clipboard a moment AFTER the key: do not pull it away early
    try { if (saved.text) this.clipboard.writeText(saved.text); else if (typeof this.clipboard.clear === 'function') this.clipboard.clear(); } catch { /* best effort */ }
  }

  async _paste(text, shortcut) {
    try { this.clipboard.writeText(text); } catch (e) { throw new Error(`Could not use the clipboard to enter text: ${e.message}`); }
    await this.sleep(T.pasteSettle);
    const codes = shortcut === 'ctrl+shift+v' ? [KEY.CTRL, KEY.SHIFT, KEY.V] : [KEY.CTRL, KEY.V];
    await this._chord(codes.map((v) => ({ m: 'keycode', v })));
    await this.sleep(T.pasteWait);
  }

  /**
   * @param {string} text  already checked by the caller (no control characters except \n and \t)
   * @returns {{notes:string[]}}
   */
  typeText(text, { delayMs = 12, pasteKeys = 'ctrl+v' } = {}) {
    return this._exclusive(async () => {
      const layout = await this._getLayout();
      const plan = planTyping(text, { canKey: (ch) => canType(layout, ch), canPaste: !!this.clipboard });
      if (plan.error) throw new Error(plan.error);
      const gap = Math.max(0, Number(delayMs) || 0);
      const notes = [];
      let saved = null; let pasted = 0;
      try {
        for (const seg of plan.segments) {
          if (this.cancelled()) throw new Error(STOPPED_MESSAGE);
          if (seg.kind === 'keys') await this._typeKeys(seg.text, gap);
          else if (seg.kind === 'enter') await this._tapCode(KEY.ENTER, gap);
          else if (seg.kind === 'tab') await this._tapCode(KEY.TAB, gap);
          else {
            if (!saved) saved = this._saveClipboard();
            await this._paste(seg.text, pasteKeys);
            pasted += [...seg.text].length;
          }
        }
      } finally {
        if (saved) await this._restoreClipboard(saved);
      }
      if (pasted) {
        notes.push(`${pasted} character(s) the keyboard cannot type were pasted with ${pasteKeys === 'ctrl+shift+v' ? 'Ctrl+Shift+V' : 'Ctrl+V'}${saved && saved.nonText ? ' (the clipboard held something other than text, which is now gone)' : ''}`);
        if (layout.ime || layout.latin === false) notes.push(`the active keyboard layout (${layout.id || 'unknown'}) cannot type Latin letters, so all text was pasted`);
      }
      return { notes };
    });
  }

  /** @param {{canon:string, code:number}[]} keys  from parseCombo */
  pressKeys(keys) {
    return this._exclusive(async () => {
      const layout = await this._getLayout();
      // a letter or punctuation key goes by the character it makes when this layout can make it, otherwise by its place on the keyboard
      const ops = keys.map((k) => {
        const sym = keysymForKey(k.canon);
        return sym != null && canType(layout, String.fromCharCode(sym)) ? { m: 'keysym', v: sym } : { m: 'keycode', v: k.code };
      });
      await this._chord(ops);
    });
  }

  // ------------------------------------------------------------------ end

  /** Close the session (and with it GNOME's sharing indicator). The next action opens a new one. */
  close() { return this._exclusive(async () => { this._dropSession(); }); }

  /** Close everything for good (the app is quitting). */
  async dispose() {
    this._dropSession();
    try { if (typeof this.transport.close === 'function') this.transport.close(); } catch { /* ignore */ }
  }
}

module.exports = { MutterBackend, planTyping, BUTTONS, KEY, T, STOPPED_MESSAGE, InputUnavailable };
