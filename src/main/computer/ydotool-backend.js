'use strict';

const { execFile } = require('node:child_process');
const { prepareTypeText } = require('./typetext');

/**
 * Mouse + keyboard through ydotool 1.x (a virtual keyboard and mouse made at the kernel level through /dev/uinput).
 *
 * WHY: Wayland forbids apps from injecting input into other apps. ydotool sidesteps that at the kernel, which every desktop
 * (KDE Plasma, GNOME, Sway ...) treats like real hardware. It needs the `ydotoold` daemon running and access to /dev/uinput.
 * On GNOME there is a way that needs no setup (mutter-backend.js); this one is the way that works EVERYWHERE.
 *
 * This file only builds ydotool's command lines. Which actions are allowed (emergency stop, rate limit, blocked key
 * combinations) is decided BEFORE anything gets here, in input.js.
 */

// The ydotool client gets a MINIMAL environment, never ours.
// Verified against the real 1.x client: with escape processing on, text ending in a
// backslash makes it read past the end of the string and TYPE ITS OWN FIRST ENVIRONMENT
// VARIABLE as keystrokes. With our real environment that could put an API key into
// whatever window has focus. `--escape 0` (see typeText) removes the parser entirely; this
// is the second, independent layer: even if it ever ran, only harmless values are in memory.
const CHILD_ENV_KEYS = ['PATH', 'XDG_RUNTIME_DIR'];
function childEnv(parent, socket) {
  const env = {};
  for (const k of CHILD_ENV_KEYS) if (typeof parent[k] === 'string') env[k] = parent[k];
  if (!env.PATH) env.PATH = '/usr/local/bin:/usr/bin:/bin';
  const sock = socket || parent.YDOTOOL_SOCKET;
  if (sock) env.YDOTOOL_SOCKET = sock;
  return env;
}

const MOUSE_BUTTONS = { left: 0x00, right: 0x01, middle: 0x02 };
/** A real button name. (`'toString' in MOUSE_BUTTONS` is true: names an object inherits must not pass for buttons.) */
const isMouseButton = (button) => typeof button === 'string' && Object.prototype.hasOwnProperty.call(MOUSE_BUTTONS, button);
const CLICK_DOWN = 0x40;
const CLICK_UP = 0x80;
const buttonArg = (button, bits) => {
  if (!isMouseButton(button)) throw new Error(`Unknown mouse button "${button}"`);
  return `0x${((MOUSE_BUTTONS[button] | bits).toString(16)).toUpperCase()}`;
};

/** Build the ydotool `key` argument list: press all in order, release in reverse. */
function comboToArgs(keys) {
  return [
    ...keys.map((k) => `${k.code}:1`),
    ...[...keys].reverse().map((k) => `${k.code}:0`),
  ];
}

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

class YdotoolBackend {
  constructor({ bin = 'ydotool', socket = null, exec = execFile, sleep = sleepReal } = {}) {
    this.bin = bin;
    this.exec = exec;
    this.socket = socket;      // ydotoold socket path; ydotool's defaults are used if null
    this.sleep = sleep;
    this.cancelled = () => false;
  }

  info() { return { name: 'ydotool', label: 'ydotool (virtual keyboard and mouse)', unicode: false, scroll: true, drag: true }; }
  async capabilities() { return this.info(); }
  resume() {}

  _run(args) {
    return new Promise((resolve, reject) => {
      const env = childEnv(process.env, this.socket);
      this.exec(this.bin, args, { env, timeout: 10_000 }, (err, stdout, stderr) => {
        if (err) {
          const hint = /ENOENT/.test(err.message)
            ? 'ydotool is not installed'
            : /socket|connect|ydotoold/i.test(`${stderr}${err.message}`)
              ? 'ydotoold daemon is not running (start it: systemctl --user enable --now ydotool)'
              : String(stderr || err.message).trim();
          const e = new Error(`ydotool failed: ${hint}`);
          if (/ENOENT|socket|connect|ydotoold/i.test(`${stderr}${err.message}`)) e.unavailable = true;
          return reject(e);
        }
        resolve(String(stdout || '').trim());
      });
    });
  }

  // `space` (the size of the picture the coordinates were measured in) is not needed here: ydotool is given plain pixels.
  moveTo(x, y) { return this._run(['mousemove', '--absolute', '-x', String(x), '-y', String(y)]); }
  moveBy(dx, dy) { return this._run(['mousemove', '-x', String(dx), '-y', String(dy)]); }

  click(button = 'left', { double = false } = {}) {
    const arg = buttonArg(button, CLICK_DOWN | CLICK_UP);
    return this._run(double ? ['click', '--repeat', '2', '--next-delay', '60', arg] : ['click', arg]);
  }
  mouseDown(button = 'left') { return this._run(['click', buttonArg(button, CLICK_DOWN)]); }
  mouseUp(button = 'left') { return this._run(['click', buttonArg(button, CLICK_UP)]); }

  /** Press, glide to the end in a few steps, release. The button is let go even if a step fails. */
  async drag(from, to, { button = 'left' } = {}) {
    await this.moveTo(from.x, from.y);
    await this.mouseDown(button);
    try {
      await this.sleep(120);
      const steps = 5;
      for (let i = 1; i <= steps; i++) {
        if (this.cancelled()) throw new Error('Emergency stop is engaged - agent input is disabled');
        await this.moveTo(Math.round(from.x + ((to.x - from.x) * i) / steps), Math.round(from.y + ((to.y - from.y) * i) / steps));
      }
      await this.sleep(100);
    } finally {
      try { await this.mouseUp(button); } catch { /* nothing more to do: the daemon is gone */ }
    }
  }

  /**
   * Wheel notches: positive dy = down, positive dx = right. ydotool's `mousemove --wheel -x H -y V` writes REL_HWHEEL = H and
   * REL_WHEEL = V (read in its source, Client/tool_mousemove.c), and in the kernel's terms a POSITIVE vertical wheel value is
   * "away from the user" = scrolling UP, so scrolling down by n sends -n.
   */
  async scroll(dx, dy) {
    const v = Math.round(dy || 0); const h = Math.round(dx || 0);
    if (v) await this._run(['mousemove', '--wheel', '-x', '0', '-y', String(-v)]);
    if (h) await this._run(['mousemove', '--wheel', '-x', String(h), '-y', '0']);
  }

  /**
   * `text` has already been through prepareTypeText in input.js. It is checked AGAIN here, because the failure it prevents is
   * severe: the client turns any byte >= 0x80 into a key code read from before its own table (see typetext.js).
   */
  async typeText(text, { delayMs = 12 } = {}) {
    // Text that comes back from the preparation unchanged is made of allowed characters only; anything converted, removed or
    // rejected shows up as a difference.
    const again = prepareTypeText(text);
    if (again.text !== text) throw new Error('ydotool can only type plain US-keyboard characters; nothing was typed');
    // `--escape 0`: the client must not interpret backslashes (it would turn "\n" into Enter,
    // "C:\Users" into a mangled path, and a trailing "\" into an environment-variable leak).
    await this._run(['type', '--key-delay', String(delayMs), '--escape', '0', '--', text]);
    return { notes: [] };
  }

  pressKeys(keys) { return this._run(['key', ...comboToArgs(keys)]); }

  close() {}
  async dispose() {}
}

module.exports = { YdotoolBackend, childEnv, CHILD_ENV_KEYS, comboToArgs, MOUSE_BUTTONS, isMouseButton };
