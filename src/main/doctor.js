'use strict';

/**
 * "Check this computer": everything ALLES needs, tried one at a time, each answer in plain words. For a person who does not know what
 * a screenshot tool or a virtual keyboard is, "the screenshot tool is missing: run this" is the difference between a working
 * assistant and a mysterious silent failure.
 *
 *   const { checks, summary } = await checkComputer({ info, screen, input, providers, keyStatus, busy });
 *
 * Each check is { id, title, state, detail, fix }:
 *   state   'ok'        nothing to do
 *           'warn'      works, but the person should know something
 *           'problem'   ALLES cannot do its job until this is fixed (`fix` says how)
 *           'skipped'   not tried (a task is running: checking would get in its way)
 *   detail  one or two plain sentences
 *   fix     what to do about a warning or problem ('' when nothing)
 *
 * It never throws and never takes longer than the time limits below: a check that fails or hangs is a 'problem' with the reason, not a
 * broken page. The checks that touch the screen and the input only run when no task is running, and they leave nothing open: GNOME's
 * "sharing" indicator is gone again when the check ends.
 */

const SCREENSHOT_MS = 15_000;
const INPUT_MS = 15_000;

const clip = (s, n = 300) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length <= n ? t : `${t.slice(0, n)}…`; };
const check = (id, title, state, detail, fix = '') => ({ id, title, state, detail, fix });

/** Reject if `p` takes longer than `ms`: a hung tool or service must not hang the Settings page. */
function withTimeout(p, ms, what) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)} seconds`)), ms); });
  return Promise.race([Promise.resolve(p), limit]).finally(() => clearTimeout(timer));
}

function desktopCheck(info) {
  const desktop = clip((info && info.desktop) || '', 60);
  const session = clip((info && info.session) || '', 20);
  if (!desktop || desktop === 'Linux') {
    return check('desktop', 'Desktop', 'warn', `ALLES could not tell which desktop this is${session ? ` (${session} session)` : ''}. It is made for GNOME, and KDE Plasma should work too.`, 'If something below fails, say which desktop you use.');
  }
  const where = session ? `${desktop} on ${session === 'wayland' ? 'Wayland' : session === 'x11' ? 'X11' : session}` : desktop;
  if (desktop === 'GNOME') {
    return session === 'x11'
      ? check('desktop', 'Desktop', 'warn', `${where}. ALLES uses ydotool here instead of GNOME's own input, which needs a setup step (see below).`, 'A Wayland session needs no setup: choose "GNOME on Wayland" at the login screen.')
      : check('desktop', 'Desktop', 'ok', where);
  }
  if (desktop === 'KDE Plasma') return check('desktop', 'Desktop', 'warn', `${where}. KDE should work (screenshots with Spectacle, mouse and keyboard with ydotool) but has not been tried on a real KDE desktop yet.`, '');
  return check('desktop', 'Desktop', 'warn', `${where}. ALLES is made for GNOME and KDE Plasma; other desktops may not work.`, '');
}

function windowCheck(info) {
  const b = (info && info.backend) || {};
  if (b.placementHonoured === true) return check('window', 'Island placement', 'ok', 'The island can be placed exactly where you choose.');
  if (b.placementHonoured === false) {
    return check('window', 'Island placement', 'warn', 'ALLES runs as a native Wayland app, and the desktop does not let such an app choose where its window goes. The island may appear in the wrong place.', 'Start ALLES with the option --ozone-platform=x11 (npm start -- --ozone-platform=x11).');
  }
  return check('window', 'Island placement', 'warn', 'ALLES could not find out whether the island can be placed exactly.', 'If the island appears in the wrong place, start ALLES with --ozone-platform=x11.');
}

async function screenshotCheck(screen, ms) {
  if (!screen || typeof screen.capture !== 'function') return check('screenshot', 'Screenshots', 'problem', 'ALLES has no way to take a screenshot here.', '');
  try {
    const s = await withTimeout(screen.capture(), ms, 'The screenshot tool');
    const w = Number(s && s.width); const h = Number(s && s.height);
    const mw = Number(s && s.modelWidth); const mh = Number(s && s.modelHeight);
    if (!(w > 0 && h > 0)) return check('screenshot', 'Screenshots', 'problem', 'The screenshot tool ran but gave no usable picture.', 'Is the screen locked? Try again with the screen unlocked.');
    return check('screenshot', 'Screenshots', 'ok', `Works. The screen is ${w}x${h} pixels${mw > 0 && mh > 0 && (mw !== w || mh !== h) ? `; the AI model is sent a smaller copy, ${mw}x${mh}` : ''}.`);
  } catch (e) {
    const text = clip(e && e.message);
    const missing = /No screenshot tool found/i.test(text);
    return check('screenshot', 'Screenshots', 'problem', missing ? text : `The screenshot failed: ${text}`, missing ? '' : 'Is the screen locked? Is the screenshot tool installed and allowed to run?');
  }
}

async function inputCheck(input, isBusy, ms) {
  if (!input || typeof input.moveBy !== 'function') return check('input', 'Mouse and keyboard', 'problem', 'ALLES has no way to move the mouse or press keys here.', '');
  let failure = null;
  try {
    if (typeof input.resume === 'function') input.resume();          // the person asked: a Stop pressed earlier does not count now
    await withTimeout(input.moveBy(0, 0), ms, 'The mouse and keyboard service');      // opens the connection; moves nothing
  } catch (e) { failure = e; }
  let i = {};
  try { i = (typeof input.info === 'function' && input.info()) || {}; } catch { i = {}; }
  // Let go of what the check opened (GNOME's sharing indicator) - unless a task has started meanwhile: it is using the connection.
  try { if (typeof input.close === 'function' && !isBusy()) input.close(); } catch { /* nothing left to let go of */ }

  if (failure) {
    const text = clip(failure.message, 400);
    const ydotool = i.name === 'ydotool' || /ydotool/i.test(text);
    return check('input', 'Mouse and keyboard', 'problem', `ALLES could not send input: ${text}`,
      ydotool ? 'ydotool needs its background service (ydotoold) running and permission to use /dev/uinput. Running ./install.sh --ydotool sets this up (then log out and in once); until then, start ydotoold as root.' : 'Try the other method in Settings > Mouse & keyboard.');
  }
  const label = clip(i.label || '', 100) || 'an input method';
  if (i.fellBackBecause) {
    return check('input', 'Mouse and keyboard', 'warn', `${label} is in use, because GNOME's own input did not work here (${clip(i.fellBackBecause, 200)}).`, 'Using GNOME on Wayland with PipeWire running lets ALLES use GNOME\'s own input, which needs no setup.');
  }
  const extra = i.name === 'gnome'
    ? ' While ALLES works, GNOME shows a screen-sharing indicator in the top bar; its Stop button stops ALLES at once.'
    : i.unicode === true ? '' : ' It can type only what a US keyboard can (no accents or other scripts).';
  return check('input', 'Mouse and keyboard', i.unicode === false && i.name !== 'gnome' ? 'warn' : 'ok', `${label} is ready.${extra}`, '');
}

function providersCheck(providers) {
  const list = Array.isArray(providers) ? providers : [];
  const enabled = list.filter((r) => r && r.enabled !== false);
  const ready = enabled.filter((r) => r.ready);
  if (!enabled.length) return check('providers', 'AI providers', 'problem', 'No AI provider is switched on.', 'Open Settings > Providers and switch one on.');
  if (!ready.length) {
    const first = enabled.find((r) => r.problem) || enabled[0];
    return check('providers', 'AI providers', 'problem', `No AI provider is ready. ${clip(first.label, 40)}: ${clip(first.problem || 'not ready', 200)}`, 'Open Settings > Providers and add an API key, then press its Test button.');
  }
  const names = ready.map((r) => clip(r.label, 40)).join(', ');
  const rest = enabled.length - ready.length;
  const detail = `${names} ${ready.length === 1 ? 'is' : 'are'} ready${rest ? `; ${rest} more ${rest === 1 ? 'is' : 'are'} not (${enabled.filter((r) => !r.ready).map((r) => `${clip(r.label, 30)}: ${clip(r.problem || 'not ready', 80)}`).join('; ')})` : ''}.`;
  return check('providers', 'AI providers', 'ok', detail, '');
}

function keysCheck(providers, keyStatus) {
  const memory = (Array.isArray(providers) ? providers : []).reduce((n, r) => n + ((r && Array.isArray(r.keys) ? r.keys : []).filter((k) => k && k.persisted === false).length), 0);
  if (keyStatus && keyStatus.mode === 'session' && memory > 0) {
    return check('keys', 'Saving keys', 'warn', `Your ${memory === 1 ? 'API key is' : `${memory} API keys are`} kept in memory only, so ALLES will ask for ${memory === 1 ? 'it' : 'them'} again every time it starts (there is no system keyring on this computer).`, 'Settings > Key storage can save them in a file only you can read.');
  }
  if (keyStatus && keyStatus.mode === 'file') return check('keys', 'Saving keys', 'warn', 'Keys are saved as plain text in a file only your user can read (no system keyring is available).', '');
  if (keyStatus && keyStatus.mode === 'keyring') return check('keys', 'Saving keys', 'ok', 'Keys are stored encrypted by your system keyring.');
  return check('keys', 'Saving keys', 'ok', 'Nothing is kept on disk.');
}

/**
 * @param {object} o
 * @param {object} o.info         App.info() (desktop, session, backend)
 * @param {object} o.screen       ScreenCapture
 * @param {object} o.input        InputController
 * @param {object[]} o.providers  App.describeProviders()
 * @param {object} o.keyStatus    KeyStore.status()
 * @param {boolean|(()=>boolean)} o.busy   a task is running (a function is asked again, because a task can start during the check)
 * @param {{screenshotMs?:number, inputMs?:number}} [o.limits]  how long each step may take (tests make them short)
 */
async function checkComputer({ info = {}, screen = null, input = null, providers = [], keyStatus = null, busy = false, limits = {} } = {}) {
  const isBusy = () => { try { return typeof busy === 'function' ? busy() === true : busy === true; } catch { return true; } };
  const checks = [];
  const run = async (id, title, fn) => {
    try { checks.push(await fn()); } catch (e) { checks.push(check(id, title, 'problem', `This check failed: ${clip(e && e.message)}`)); }
  };
  const notTried = (id, title) => check(id, title, 'skipped', 'A task is running, so this was not tried. Check again when it has finished.');
  await run('desktop', 'Desktop', () => desktopCheck(info));
  await run('window', 'Island placement', () => windowCheck(info));
  if (isBusy()) {
    checks.push(notTried('screenshot', 'Screenshots'));
    checks.push(notTried('input', 'Mouse and keyboard'));
  } else {
    await run('screenshot', 'Screenshots', () => screenshotCheck(screen, limits.screenshotMs || SCREENSHOT_MS));
    // A task can start while the screenshot is being taken (that may take a while). Ask again before touching the input: trying it
    // releases the emergency stop (input.resume), and a Stop pressed during that task must stay pressed.
    if (isBusy()) checks.push(notTried('input', 'Mouse and keyboard'));
    else await run('input', 'Mouse and keyboard', () => inputCheck(input, isBusy, limits.inputMs || INPUT_MS));
  }
  await run('providers', 'AI providers', () => providersCheck(providers));
  await run('keys', 'Saving keys', () => keysCheck(providers, keyStatus));

  const problems = checks.filter((c) => c.state === 'problem').length;
  const warnings = checks.filter((c) => c.state === 'warn').length;
  const skipped = checks.filter((c) => c.state === 'skipped').length;
  const text = problems ? `${problems === 1 ? '1 thing needs' : `${problems} things need`} fixing before ALLES can do its job.`
    : warnings ? `ALLES should work. ${warnings === 1 ? '1 thing is' : `${warnings} things are`} worth a look.`
      : skipped ? 'Everything that could be tried works.' : 'Everything is ready.';
  return { checks, summary: { problems, warnings, skipped, text } };
}

module.exports = { checkComputer, withTimeout, SCREENSHOT_MS, INPUT_MS };
