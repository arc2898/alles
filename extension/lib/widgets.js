// Turns the latest readings into what the top bar and the pill's menu show. Pure: same input, same output, no GNOME.
import { formatPercent, formatBytes, formatRate, formatTemp, sparkline } from './resources.js';

const DEFAULT_LABEL = { cpu: 'CPU', memory: 'RAM', swap: 'Swap', disk: 'Disk', network: 'Net', temperature: 'Temp', battery: 'Bat', clock: '', command: '' };
const TITLE = { cpu: 'Processor', memory: 'Memory', swap: 'Swap', disk: 'Disk (/)', network: 'Network', temperature: 'Temperature', battery: 'Battery', clock: 'Time', command: 'Command' };

/** 'normal' | 'warn' | 'crit' - the colour hint for a reading. */
export function toneFor(type, s) {
  if (!s) return 'normal';
  const hi = (v, warn, crit) => (v >= crit ? 'crit' : v >= warn ? 'warn' : 'normal');
  switch (type) {
    case 'cpu': return s.percent == null ? 'normal' : hi(s.percent, 70, 90);
    case 'memory': return hi(s.percent, 80, 92);
    case 'swap': return hi(s.percent, 50, 80);
    case 'disk': return hi(s.percent, 85, 95);
    case 'temperature': return s.celsius == null ? 'normal' : hi(s.celsius, 75, 90);
    case 'battery': return s.charging ? 'normal' : s.percent <= 10 ? 'crit' : s.percent <= 20 ? 'warn' : 'normal';
    default: return 'normal';
  }
}

const two = (n) => String(n).padStart(2, '0');

/**
 * One widget -> { id, type, label, title, available, tone, text (for the bar), value, detail, fraction (for the menu) }.
 * `samples` = { cpu:{percent,history}, memory:{used,total,percent,history}, swap, disk, network:{rx,tx,rxHistory,txHistory},
 *               temperature:{celsius}, battery:{percent,charging,full}, commands:{[id]:{text}} } - any may be missing.
 */
export function widgetView(w, samples, now = new Date()) {
  const s = samples || {};
  const label = w.label || DEFAULT_LABEL[w.type] || '';
  const withSpark = (value, hist, max) => {
    const sp = sparkline(hist, max);
    if (w.style === 'spark') return sp || value;
    if (w.style === 'both') return sp ? `${value} ${sp}` : value;
    return value;
  };
  const base = { id: w.id, type: w.type, label, title: w.label || TITLE[w.type] || w.type, available: false, tone: 'normal', text: '', value: '', detail: '', fraction: null };
  switch (w.type) {
    case 'cpu': {
      const c = s.cpu; if (!c || c.percent == null) return { ...base, value: 'measuring…', text: '' };
      return { ...base, available: true, tone: toneFor('cpu', c), value: formatPercent(c.percent), text: withSpark(formatPercent(c.percent), c.history, 100), fraction: c.percent / 100, detail: s.load ? `load ${s.load.one} ${s.load.five} ${s.load.fifteen}` : '' };
    }
    case 'memory': {
      const m = s.memory; if (!m) return { ...base, value: 'not available' };
      return { ...base, available: true, tone: toneFor('memory', m), value: `${formatBytes(m.used)} of ${formatBytes(m.total)}`, text: withSpark(formatPercent(m.percent), m.history, 100), fraction: m.percent / 100, detail: formatPercent(m.percent) };
    }
    case 'swap': {
      const m = s.swap; if (!m) return { ...base, value: 'no swap' };
      return { ...base, available: true, tone: toneFor('swap', m), value: `${formatBytes(m.used)} of ${formatBytes(m.total)}`, text: withSpark(formatPercent(m.percent), m.history, 100), fraction: m.percent / 100, detail: formatPercent(m.percent) };
    }
    case 'disk': {
      const d = s.disk; if (!d) return { ...base, value: 'not available' };
      return { ...base, available: true, tone: toneFor('disk', d), value: `${formatBytes(d.total - d.used)} free of ${formatBytes(d.total)}`, text: formatPercent(d.percent), fraction: d.percent / 100, detail: formatPercent(d.percent) };
    }
    case 'network': {
      const n = s.network; if (!n) return { ...base, value: 'measuring…' };
      const down = `↓ ${formatRate(n.rx)}`; const up = `↑ ${formatRate(n.tx)}`;
      const spark = w.style !== 'text' ? sparkline(n.rxHistory, Math.max(...(n.rxHistory || [1]), 1024)) : '';
      return { ...base, available: true, value: `${down}   ${up}`, text: w.style === 'spark' && spark ? `${spark}` : `${down} ${up}${w.style === 'both' && spark ? ` ${spark}` : ''}` };
    }
    case 'temperature': {
      const t = s.temperature; if (!t || t.celsius == null) return { ...base, value: 'no sensor found' };
      return { ...base, available: true, tone: toneFor('temperature', t), value: formatTemp(t.celsius), text: formatTemp(t.celsius) };
    }
    case 'battery': {
      const b = s.battery; if (!b) return { ...base, value: 'no battery' };
      const state = b.full ? 'full' : b.charging ? 'charging' : 'on battery';
      return { ...base, available: true, tone: toneFor('battery', b), value: `${formatPercent(b.percent)} (${state})`, text: `${formatPercent(b.percent)}${b.charging ? '⚡' : ''}`, fraction: b.percent / 100 };
    }
    case 'clock': {
      const t = `${two(now.getHours())}:${two(now.getMinutes())}`;
      return { ...base, available: true, value: t, text: t };
    }
    case 'command': {
      const r = (s.commands || {})[w.id];
      if (!w.command) return { ...base, value: 'no command set' };
      if (!r) return { ...base, available: true, value: '…', text: '…' };
      return { ...base, available: true, tone: r.failed ? 'crit' : 'normal', value: r.text || (r.failed ? 'failed' : ''), text: r.text || (r.failed ? '⚠' : '') };
    }
    default: return base;
  }
}

/** The widgets that show in the bar, in order, as [{id, text, tone, label}] - only ones that have something to say. */
export function barItems(widgets, samples, { now = new Date(), compact = false } = {}) {
  const out = [];
  for (const w of widgets || []) {
    if (!w.enabled || w.where === 'menu') continue;
    const v = widgetView(w, samples, now);
    if (!v.available || !v.text) continue;
    out.push({ id: v.id, tone: v.tone, text: compact || !v.label ? v.text : `${v.label} ${v.text}` });
  }
  return out;
}

/** The widgets that show in the pill's menu, in order, with a title, a value, a detail line and a bar fraction. */
export function menuRows(widgets, samples, { now = new Date() } = {}) {
  const out = [];
  for (const w of widgets || []) {
    if (!w.enabled || w.where === 'bar') continue;
    const v = widgetView(w, samples, now);
    out.push({ id: v.id, title: v.title, value: v.value, detail: v.detail, fraction: v.fraction, tone: v.tone, available: v.available });
  }
  return out;
}

/** Which kinds of reading the sampler must take, from the widgets that are switched on (so it reads nothing nobody looks at). */
export function neededSamples(widgets) {
  const need = new Set();
  for (const w of widgets || []) if (w.enabled && w.type !== 'clock' && w.type !== 'command') need.add(w.type);
  if (need.has('cpu')) need.add('load');
  return need;
}
