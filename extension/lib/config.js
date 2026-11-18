// The top-bar settings rules, as the extension needs them. This is a copy of src/main/topbar-config.js written as an ES module
// (GNOME Shell cannot load CommonJS). test/extension-libs.test.js gives both the same input and requires the same output.
// Nothing here is trusted: the settings file is just a file.

export const POSITIONS = ['left', 'center', 'right'];
export const FLOATING = ['auto', 'always', 'never'];
export const WIDGET_TYPES = ['cpu', 'memory', 'swap', 'disk', 'network', 'temperature', 'battery', 'clock', 'command'];
export const WIDGET_WHERE = ['bar', 'menu', 'both'];
export const WIDGET_STYLES = ['text', 'spark', 'both'];
export const COLOR_KEYS = ['idle', 'ready', 'working', 'attention', 'problem', 'listening'];
export const MAX_WIDGETS = 16;

export const DEFAULT_COLORS = Object.freeze({
  idle: '#7c8aa5', ready: '#5ee6a8', working: '#6aa9ff', attention: '#ffb454', problem: '#ff6b81', listening: '#ff8fa3',
  text: '', background: '',
});

const widget = (id, type, enabled, where) => ({ id, type, enabled, where, label: '', style: 'text' });
export const DEFAULT_WIDGETS = Object.freeze([
  widget('cpu', 'cpu', true, 'both'),
  widget('memory', 'memory', true, 'both'),
  widget('network', 'network', false, 'menu'),
  widget('disk', 'disk', true, 'menu'),
  widget('swap', 'swap', false, 'menu'),
  widget('temperature', 'temperature', false, 'menu'),
  widget('battery', 'battery', false, 'both'),
  widget('clock', 'clock', false, 'bar'),
]);

export const DEFAULT_TOPBAR = Object.freeze({
  enabled: true, floatingPill: 'auto', position: 'right', index: 0, showLabel: true, labelMaxChars: 28, compact: false, micButton: true,
  colors: DEFAULT_COLORS, widgets: DEFAULT_WIDGETS, resources: { intervalSec: 2 },
  shelf: { enabled: true, folder: '', keepDays: 0, maxShown: 12 },
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const bool = (v, d) => (typeof v === 'boolean' ? v : d);
const int = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(Math.max(v, lo), hi)) : d);
const oneOf = (list, v, d) => (typeof v === 'string' && list.includes(v) ? v : d);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const text = (v, max, d = '') => (typeof v === 'string' && !CONTROL.test(v) && v.trim().length <= max ? v.trim() : d);
const WIDGET_ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

export function cleanColor(v, fallback) {
  if (typeof v !== 'string' || CONTROL.test(v)) return fallback;
  const s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : fallback;
}

function cleanColors(v) {
  const c = isObj(v) ? v : {};
  const out = {};
  for (const k of COLOR_KEYS) out[k] = cleanColor(c[k], DEFAULT_COLORS[k]);
  for (const k of ['text', 'background']) out[k] = c[k] === '' ? '' : cleanColor(c[k], DEFAULT_COLORS[k]);
  return out;
}

function cleanWidget(w, usedIds) {
  if (!isObj(w) || !WIDGET_TYPES.includes(w.type)) return null;
  let id = typeof w.id === 'string' && WIDGET_ID_RE.test(w.id) ? w.id : w.type;
  if (usedIds.has(id)) { let n = 2; while (usedIds.has(`${id}-${n}`) && n < 100) n++; id = `${id}-${n}`.slice(0, 24); if (usedIds.has(id)) return null; }
  usedIds.add(id);
  const out = { id, type: w.type, enabled: bool(w.enabled, true), where: oneOf(WIDGET_WHERE, w.where, 'both'), label: text(w.label, 16), style: oneOf(WIDGET_STYLES, w.style, 'text') };
  if (w.type === 'command') {
    out.command = text(w.command, 300);
    out.intervalSec = int(w.intervalSec, 5, 3600, 30);
    out.timeoutSec = int(w.timeoutSec, 1, 10, 5);
  }
  return out;
}

function cleanWidgets(v) {
  if (!Array.isArray(v)) return DEFAULT_WIDGETS.map((w) => ({ ...w }));
  const used = new Set(); const out = [];
  for (const w of v) { if (out.length >= MAX_WIDGETS) break; const c = cleanWidget(w, used); if (c) out.push(c); }
  return out;
}

function cleanFolder(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s || s.length > 500 || CONTROL.test(s) || !s.startsWith('/') || s === '/' || /(^|\/)\.\.(\/|$)/.test(s)) return '';
  return s.replace(/\/+$/, '');
}

export function sanitizeTopbar(raw) {
  const r = isObj(raw) ? raw : {};
  const D = DEFAULT_TOPBAR;
  const res = isObj(r.resources) ? r.resources : {};
  const sh = isObj(r.shelf) ? r.shelf : {};
  return {
    enabled: bool(r.enabled, D.enabled),
    floatingPill: oneOf(FLOATING, r.floatingPill, D.floatingPill),
    position: oneOf(POSITIONS, r.position, D.position),
    index: int(r.index, 0, 20, D.index),
    showLabel: bool(r.showLabel, D.showLabel),
    labelMaxChars: int(r.labelMaxChars, 8, 60, D.labelMaxChars),
    compact: bool(r.compact, D.compact),
    micButton: bool(r.micButton, D.micButton),
    colors: cleanColors(r.colors),
    widgets: cleanWidgets(r.widgets),
    resources: { intervalSec: int(res.intervalSec, 1, 60, D.resources.intervalSec) },
    shelf: { enabled: bool(sh.enabled, D.shelf.enabled), folder: cleanFolder(sh.folder), keepDays: int(sh.keepDays, 0, 365, D.shelf.keepDays), maxShown: int(sh.maxShown, 3, 50, D.shelf.maxShown) },
  };
}

/** The whole settings file's text -> the top-bar section (defaults if the file is missing, empty or not JSON). */
export function topbarFromSettingsText(textOrNull) {
  let data = null;
  try { data = textOrNull ? JSON.parse(textOrNull) : null; } catch { data = null; }
  return sanitizeTopbar(isObj(data) ? data.topbar : null);
}
