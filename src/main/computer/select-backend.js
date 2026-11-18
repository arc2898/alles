'use strict';

const { YdotoolBackend } = require('./ydotool-backend');
const { MutterBackend } = require('./mutter-backend');

/**
 * Choosing how input is carried out.
 *
 *   auto     (the default)  GNOME desktop: GNOME's own remote-input service, and if THAT turns out not to work here
 *                           (not a Wayland session, PipeWire missing ...) ydotool instead. Any other desktop: ydotool.
 *   gnome                   only GNOME's service; if it does not work the error says why (no quiet switch to something else).
 *   ydotool                 only ydotool.
 *
 * "Does not work here" is told apart from "this one action failed": only an error flagged `unavailable` (the way of sending
 * cannot be set up at all) makes auto switch, and it switches for good - a flaky connection must not bounce input between
 * two different virtual devices in the middle of a task.
 */

const MODES = ['auto', 'gnome', 'ydotool'];

class FallbackBackend {
  constructor({ primary, secondary, log = () => {} }) {
    this.primary = primary;
    this.secondary = secondary;
    this.log = log;
    this.active = primary;
    this.fellBackBecause = null;
    this._ready = false;
    this._cancelled = () => false;
  }

  // The emergency-stop check is handed to BOTH, so a long action stops between steps whichever one is carrying it out.
  set cancelled(fn) { this._cancelled = fn; this.primary.cancelled = fn; this.secondary.cancelled = fn; }
  get cancelled() { return this._cancelled; }

  info() {
    return { ...this.active.info(), auto: true, fellBackBecause: this.fellBackBecause };
  }

  _switch(why) {
    this.active = this.secondary;
    this.fellBackBecause = why.message;
    this.log(`input: GNOME direct input is not available (${why.message}); using ydotool instead`);
    try { const p = this.primary.close(); if (p && p.catch) p.catch(() => {}); } catch { /* ignore */ }
  }

  /** The answer to "what can the current way of sending do?" - made AFTER finding out whether the first choice works at all. */
  async capabilities() {
    if (this.active === this.primary && !this._ready) {
      try { if (typeof this.primary.ready === 'function') await this.primary.ready(); this._ready = true; }
      catch (e) { if (!e || !e.unavailable) throw e; this._switch(e); }
    }
    return this.active.info();
  }

  async _do(method, args) {
    if (this.active === this.secondary) return this.secondary[method](...args);
    try {
      const r = await this.primary[method](...args);
      this._ready = true;
      return r;
    } catch (e) {
      if (!e || !e.unavailable) throw e;
      this._switch(e);
      try { return await this.secondary[method](...args); } catch (e2) {
        if (e2 && typeof e2.message === 'string') e2.message = `${e2.message} (GNOME direct input was tried first: ${e.message})`;
        throw e2;
      }
    }
  }

  moveTo(...a) { return this._do('moveTo', a); }
  moveBy(...a) { return this._do('moveBy', a); }
  click(...a) { return this._do('click', a); }
  mouseDown(...a) { return this._do('mouseDown', a); }
  mouseUp(...a) { return this._do('mouseUp', a); }
  drag(...a) { return this._do('drag', a); }
  scroll(...a) { return this._do('scroll', a); }
  typeText(...a) { return this._do('typeText', a); }
  pressKeys(...a) { return this._do('pressKeys', a); }

  resume() { this.primary.resume(); this.secondary.resume(); }
  close() { return Promise.all([this.primary.close(), this.secondary.close()]); }
  async dispose() { await Promise.all([this.primary.dispose(), this.secondary.dispose()]); }
}

/**
 * @param {object} o
 * @param {'auto'|'gnome'|'ydotool'} [o.mode]
 * @param {string} o.desktop     'gnome' | 'kde' | ... (screen.js detectDesktop)
 * @param {string} [o.session]   XDG_SESSION_TYPE ('wayland', 'x11', ...)
 * @param {object} [o.clipboard] Electron's clipboard: lets GNOME direct input enter text the keyboard cannot type
 * @param {Function} [o.onUserStop]  the person ended GNOME's session from the sharing indicator
 * @param {object} [o.deps]      {ydotool:{...}, mutter:{...}} constructor options (tests)
 */
function createBackend({ mode = 'auto', desktop = 'unknown', session = '', clipboard = null, onUserStop = null, log = () => {}, deps = {} } = {}) {
  const ydotool = () => new YdotoolBackend(deps.ydotool || {});
  const gnome = () => new MutterBackend({ clipboard, onUserStop, log, ...(deps.mutter || {}) });
  if (mode === 'ydotool') return ydotool();
  if (mode === 'gnome') return gnome();
  // anything else - 'auto', or a mode nobody knows - is auto
  if (desktop === 'gnome' && session !== 'x11') return new FallbackBackend({ primary: gnome(), secondary: ydotool(), log });
  return ydotool();
}

module.exports = { FallbackBackend, createBackend, MODES };
