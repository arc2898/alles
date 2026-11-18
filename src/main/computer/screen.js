'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Screen capture for Wayland - GNOME FIRST.
 *
 * Wayland does not let apps grab the screen directly, so we go through a
 * compositor-blessed route. WHICH route depends on the desktop:
 *
 *   GNOME (Mutter)  : gnome-screenshot -f <file>
 *                     Mutter 46.2 was inspected with wayland-info: it advertises NO
 *                     wlr-screencopy and NO ext-image-copy-capture, so `grim` cannot
 *                     work on GNOME. (KDE's `spectacle` is also not the GNOME route.)
 *   KDE Plasma      : spectacle -b -n -f -o <file>   (flags checked against --help)
 *   wlroots         : grim <file>                     (Sway, Hyprland, ...)
 *
 * BACKEND CHOICE: detect the desktop from XDG_CURRENT_DESKTOP, try that desktop's
 * tool FIRST, then the others as fallbacks. A missing tool produces an error that
 * names exactly what to install for THIS desktop, instead of a generic message.
 *
 * NOT VERIFIED: the xdg-desktop-portal Screenshot route. The portal started in a
 * headless Mutter but exported no Screenshot interface (its GNOME backend needs a
 * running gnome-shell), so a portal capture was never observed. It is therefore
 * deliberately NOT in the chain.
 *
 * COORDINATE MAPPING - the classic computer-use bug:
 * The model sees a DOWNSCALED image, but ydotool needs REAL pixel coordinates.
 * capture() returns the scale factor, and toScreen() converts model coords back.
 */

/** Each backend: how to detect it, how to invoke it, and what to tell the user to install. */
const BACKENDS = {
  'gnome-screenshot': {
    bin: 'gnome-screenshot',
    args: (file) => ['-f', file],
    install: 'gnome-screenshot  (Ubuntu/Debian: sudo apt install gnome-screenshot; Fedora: sudo dnf install gnome-screenshot)',
  },
  spectacle: {
    bin: 'spectacle',
    args: (file) => ['-b', '-n', '-f', '-o', file],
    install: 'spectacle  (KDE: usually preinstalled; else sudo apt/dnf/pacman install spectacle)',
  },
  grim: {
    bin: 'grim',
    args: (file) => [file],
    install: 'grim  (wlroots compositors only: Sway, Hyprland)',
  },
};

/** Preference order per desktop. The desktop's own tool goes first. */
const ORDER = {
  gnome: ['gnome-screenshot', 'spectacle', 'grim'],
  kde: ['spectacle', 'gnome-screenshot', 'grim'],
  wlroots: ['grim', 'gnome-screenshot', 'spectacle'],
  unknown: ['gnome-screenshot', 'spectacle', 'grim'],   // GNOME-first when we cannot tell
};

/**
 * Classify the desktop from XDG_CURRENT_DESKTOP (a colon-separated list, e.g.
 * "ubuntu:GNOME" or "KDE"). Case-insensitive; never throws on odd input.
 */
function detectDesktop(env = process.env) {
  const raw = `${env.XDG_CURRENT_DESKTOP || ''}:${env.XDG_SESSION_DESKTOP || ''}:${env.DESKTOP_SESSION || ''}`.toLowerCase();
  const parts = raw.split(/[:;,\s]+/).filter(Boolean);
  if (parts.some((p) => p === 'gnome' || p === 'gnome-xorg' || p === 'ubuntu' || p === 'unity' || p === 'pop' || p === 'zorin')) return 'gnome';
  if (parts.some((p) => p === 'kde' || p === 'plasma' || p === 'plasmawayland' || p === 'plasmax11')) return 'kde';
  if (parts.some((p) => ['sway', 'hyprland', 'wlroots', 'river', 'labwc', 'wayfire'].includes(p))) return 'wlroots';
  return 'unknown';
}

const MAX_MODEL_EDGE = 1280; // longest edge sent to the vision model

function run(bin, args, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${bin} failed: ${String(stderr || err.message).trim()}`));
      resolve(String(stdout));
    });
  });
}

function which(bin) {
  return new Promise((resolve) => execFile('which', [bin], (err) => resolve(!err)));
}

/** Read width/height straight from a PNG header (no image lib needed). */
function pngSize(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(sig)) throw new Error('Screenshot is not a valid PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Scale factor so the longest edge is <= MAX_MODEL_EDGE. Never upscales. */
function computeScale(width, height, maxEdge = MAX_MODEL_EDGE) {
  const longest = Math.max(width, height);
  return longest > maxEdge ? maxEdge / longest : 1;
}

/** Convert model-space coordinates (downscaled image) to real screen pixels. */
function toScreen(x, y, scale) {
  if (!(scale > 0)) throw new Error('Invalid scale');
  return { x: Math.round(x / scale), y: Math.round(y / scale) };
}

/**
 * A resizer for ScreenCapture made from Electron's nativeImage (the app has no image library of its own).
 * WITHOUT ONE a screenshot of any screen wider than MAX_MODEL_EDGE (1280 px: that is nearly every real screen, 1366x768 included)
 * is refused, so the app must hand this to ScreenCapture.
 */
function nativeResizer(nativeImage) {
  return (png, width, height) => {
    const img = nativeImage.createFromBuffer(png);
    if (!img || (typeof img.isEmpty === 'function' && img.isEmpty())) throw new Error('The screenshot could not be read as a picture');
    return img.resize({ width, height, quality: 'best' }).toPNG();
  };
}

class ScreenCapture {
  /**
   * @param {object} opts
   * @param {(png:Buffer, w:number, h:number)=>Buffer} [opts.resizer]  downscales a PNG.
   *        In the app this is backed by Electron's nativeImage (no extra deps).
   *        Tests inject a stub. If omitted, capture() refuses to hand back a
   *        mismatched image/scale pair rather than silently mis-aiming clicks.
   */
  constructor({ backend = null, tmpDir = os.tmpdir(), runImpl = run, whichImpl = which, resizer = null, env = process.env } = {}) {
    this.backend = backend; // a BACKENDS key, or null = auto-detect for this desktop
    this.env = env;
    this.tmpDir = tmpDir;
    this.run = runImpl;
    this.which = whichImpl;
    this.resizer = resizer;
  }

  /** Pick the first available backend for this desktop, or throw an actionable error. */
  async detect() {
    if (this.backend) return this.backend;
    const desktop = detectDesktop(this.env);
    const order = ORDER[desktop];
    for (const name of order) {
      if (await this.which(BACKENDS[name].bin)) { this.desktop = desktop; return (this.backend = name); }
    }
    const want = BACKENDS[order[0]].install;
    throw new Error(`No screenshot tool found for ${desktop === 'unknown' ? 'this desktop' : desktop.toUpperCase()}. Install ${want}.`);
  }

  /**
   * @returns {{png:Buffer, original:Buffer, width:number, height:number, scale:number, modelWidth:number, modelHeight:number}}
   *          png = the (downscaled) image the model sees; original = full resolution
   */
  async capture() {
    const backend = await this.detect();
    const file = path.join(this.tmpDir, `alles-shot-${process.pid}-${Date.now()}.png`);
    try {
      const b = BACKENDS[backend];
      if (!b) throw new Error(`Unknown screenshot backend "${backend}"`);
      await this.run(b.bin, b.args(file));

      if (!fs.existsSync(file)) throw new Error(`${backend} exited OK but produced no file (is the screen locked?)`);
      const png = fs.readFileSync(file);
      const { width, height } = pngSize(png);
      const scale = computeScale(width, height);
      const modelWidth = Math.round(width * scale);
      const modelHeight = Math.round(height * scale);

      // INVARIANT: the image the model sees must be exactly modelWidth x modelHeight,
      // because model coordinates are divided by `scale` to get real pixels.
      let modelPng = png;
      if (scale < 1) {
        if (!this.resizer) throw new Error('Screen is larger than the model limit but no resizer was provided');
        modelPng = this.resizer(png, modelWidth, modelHeight);
        const got = pngSize(modelPng);
        if (got.width !== modelWidth || got.height !== modelHeight) {
          throw new Error(`Resizer returned ${got.width}x${got.height}, expected ${modelWidth}x${modelHeight}`);
        }
      }
      return { png: modelPng, original: png, width, height, scale, modelWidth, modelHeight };
    } finally {
      try { fs.unlinkSync(file); } catch { /* already gone */ }
    }
  }
}

module.exports = { ScreenCapture, nativeResizer, pngSize, computeScale, toScreen, detectDesktop, BACKENDS, ORDER, MAX_MODEL_EDGE };
