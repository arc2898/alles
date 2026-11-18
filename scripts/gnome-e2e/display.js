'use strict';
/**
 * The screens of the throw-away GNOME Shell: give them scales, the way the Settings app does. Tests only.
 */
const { execFile } = require('node:child_process');
const dbusNext = require('dbus-next');
const { sleep } = require('./lib');

/**
 * Give the screens the scales asked for, left to right (DisplayConfig.ApplyMonitorsConfig). A scale the screen's mode does not allow is
 * replaced by the nearest one it does. Returns what each screen really got: [{ mode, wanted, scale, supported }].
 */
async function applyScales(scales) {
  if (scales.some((v) => Math.abs(v - Math.round(v)) > 1e-6)) {
    await new Promise((resolve) => execFile('gsettings', ['set', 'org.gnome.mutter', 'experimental-features', "['scale-monitor-framebuffer']"], () => resolve()));
    await sleep(1500);
  }
  const bus = dbusNext.sessionBus();
  bus.on('error', () => { /* a closed bus at the very end is fine */ });
  const got = [];
  try {
    const obj = await bus.getProxyObject('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig');
    const dc = obj.getInterface('org.gnome.Mutter.DisplayConfig');
    const [serial, monitors] = await dc.GetCurrentState();
    let x = 0;
    const logical = monitors.map((m, i) => {
      const spec = m[0]; const modes = m[1];
      const cur = modes.find((md) => md[6]['is-current'] && md[6]['is-current'].value) || modes[0];
      const wanted = scales[i] || 1;
      const supported = (cur[5] || []).map(Number);
      const scale = supported.length ? supported.reduce((a, b) => (Math.abs(b - wanted) < Math.abs(a - wanted) ? b : a)) : wanted;     // the nearest scale the screen allows
      got.push({ mode: cur[0], wanted, scale, supported });
      const lm = [x, 0, scale, 0, i === 0, [[spec[0], cur[0], {}]]];                       // (x, y, scale, transform, primary, [(connector, mode, properties)])
      x += Math.round(cur[1] / scale);
      return lm;
    });
    await dc.ApplyMonitorsConfig(serial, 1, logical, {});
  } finally { try { bus.disconnect(); } catch { /* already closed */ } }
  await sleep(2500);
  return got;
}

/** The scales asked for in the environment (ALLES_E2E_SCALES="2" or "2,1"), and the one the pictures of the desktop are made at: the largest. */
function scalesFromEnv(env = process.env) {
  const scales = (env.ALLES_E2E_SCALES || '').split(',').map((x) => Number(x.trim())).filter((x) => x > 0);
  return { scales, scale: scales.length ? Math.max(...scales) : 1 };
}

module.exports = { applyScales, scalesFromEnv };
