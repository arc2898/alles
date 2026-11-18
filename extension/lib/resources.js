// System resource readings, as plain functions on the TEXT of the files the kernel provides (/proc/stat, /proc/meminfo,
// /proc/net/dev, /sys/...). Nothing here touches the disk or GNOME, so Node runs the same code in the tests that GNOME Shell
// runs in the top bar. The extension reads the files (ui/sampler.js) and hands the text to these functions.

const num = (s) => { const n = Number(s); return Number.isFinite(n) ? n : NaN; };

/** First line of /proc/stat: "cpu  user nice system idle iowait irq softirq steal ..." -> { idle, total } (clock ticks), or null. */
export function parseCpuStat(text) {
  const line = String(text || '').split('\n').find((l) => /^cpu\s/.test(l));
  if (!line) return null;
  const f = line.trim().split(/\s+/).slice(1, 9).map(num);               // user nice system idle iowait irq softirq steal
  if (f.length < 4 || f.some((x) => Number.isNaN(x) || x < 0)) return null;
  const total = f.reduce((a, b) => a + b, 0);
  const idle = f[3] + (f[4] || 0);
  return { idle, total };
}

/** Percent busy between two readings; null when there is nothing to compare (the first reading, a reset, no time passed). */
export function cpuPercent(prev, cur) {
  if (!prev || !cur) return null;
  const dt = cur.total - prev.total; const di = cur.idle - prev.idle;
  if (!(dt > 0) || di < 0 || di > dt) return null;
  return Math.round(((dt - di) / dt) * 1000) / 10;
}

/** /proc/meminfo -> bytes. */
export function parseMeminfo(text) {
  const get = (k) => { const m = new RegExp(`^${k}:\\s+(\\d+)\\s*kB`, 'm').exec(String(text || '')); return m ? Number(m[1]) * 1024 : NaN; };
  const out = { memTotal: get('MemTotal'), memAvailable: get('MemAvailable'), swapTotal: get('SwapTotal'), swapFree: get('SwapFree') };
  if (Number.isNaN(out.memTotal)) return null;
  if (Number.isNaN(out.memAvailable)) { const free = get('MemFree'); const buf = get('Buffers'); const cache = get('Cached'); out.memAvailable = [free, buf, cache].every((x) => !Number.isNaN(x)) ? free + buf + cache : free; }
  if (Number.isNaN(out.swapTotal)) { out.swapTotal = 0; out.swapFree = 0; }
  if (Number.isNaN(out.swapFree)) out.swapFree = 0;
  return out;
}

const pct = (used, total) => (total > 0 ? Math.round((used / total) * 1000) / 10 : 0);

export function memoryUsage(info) {
  if (!info) return null;
  const used = Math.max(0, info.memTotal - info.memAvailable);
  return { used, total: info.memTotal, percent: pct(used, info.memTotal) };
}
export function swapUsage(info) {
  if (!info || !(info.swapTotal > 0)) return null;
  const used = Math.max(0, info.swapTotal - info.swapFree);
  return { used, total: info.swapTotal, percent: pct(used, info.swapTotal) };
}

const VIRTUAL_IF = /^(lo|docker\d*|veth.*|br-.*|virbr.*|vmnet.*|vboxnet.*|tailscale.*)$/;
/** /proc/net/dev -> total bytes received and sent over real interfaces. */
export function parseNetDev(text) {
  let rx = 0; let tx = 0; let seen = 0;
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
    if (!m || VIRTUAL_IF.test(m[1])) continue;
    const f = m[2].trim().split(/\s+/).map(num);
    if (f.length < 9 || Number.isNaN(f[0]) || Number.isNaN(f[8])) continue;
    rx += f[0]; tx += f[8]; seen++;
  }
  return seen ? { rx, tx } : null;
}

/** Bytes per second between two readings (0 if a counter went backwards: an interface came or went). */
export function netRate(prev, cur, seconds) {
  if (!prev || !cur || !(seconds > 0)) return null;
  const r = (a, b) => (b >= a ? (b - a) / seconds : 0);
  return { rx: r(prev.rx, cur.rx), tx: r(prev.tx, cur.tx) };
}

export function parseLoadavg(text) {
  const f = String(text || '').trim().split(/\s+/).slice(0, 3).map(num);
  return f.length === 3 && f.every((x) => !Number.isNaN(x)) ? { one: f[0], five: f[1], fifteen: f[2] } : null;
}

const CPU_SENSORS = /^(x86_pkg_temp|coretemp|k10temp|zenpower|cpu[-_ ]?thermal|cpu|soc[-_ ]?thermal|acpitz)$/i;
/** [{ label, milli }] from thermal zones and hwmon chips -> degrees C of the sensor that most likely is the processor, or null. */
export function pickTemperature(readings) {
  const good = (readings || []).filter((r) => r && Number.isFinite(r.milli) && r.milli > -50000 && r.milli < 150000);
  if (!good.length) return null;
  const cpu = good.filter((r) => CPU_SENSORS.test(String(r.label || '')));
  const pool = cpu.length ? cpu : good;
  return Math.round(Math.max(...pool.map((r) => r.milli)) / 100) / 10;
}

/** { capacity: '87', status: 'Charging' } -> { percent, charging, full } or null. */
export function parseBattery(b) {
  if (!b) return null;
  const percent = num(String(b.capacity || '').trim());
  if (Number.isNaN(percent) || percent < 0 || percent > 100) return null;
  const status = String(b.status || '').trim().toLowerCase();
  return { percent, charging: status === 'charging', full: status === 'full' };
}

// ---- how numbers look ------------------------------------------------------------------------------------------------

export const formatPercent = (p) => (p == null ? '–' : `${Math.round(p)}%`);

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}
export const formatRate = (n) => (Number.isFinite(n) ? `${formatBytes(n)}/s` : '–');
export const formatTemp = (c) => (c == null ? '–' : `${Math.round(c)}°C`);

const BLOCKS = '▁▂▃▄▅▆▇█';
/** A tiny bar chart in text: the last `width` values scaled to 0..max. */
export function sparkline(values, max = 100, width = 8) {
  const v = (values || []).filter((x) => Number.isFinite(x)).slice(-width);
  if (!v.length) return '';
  const top = max > 0 ? max : Math.max(...v, 1);
  return v.map((x) => BLOCKS[Math.min(BLOCKS.length - 1, Math.max(0, Math.floor((Math.min(x, top) / top) * (BLOCKS.length - 1) + 0.5)))]).join('');
}

/** A short rolling list of readings. */
export class History {
  constructor(size = 30) { this.size = size; this.values = []; }
  push(v) { if (Number.isFinite(v)) { this.values.push(v); if (this.values.length > this.size) this.values.shift(); } }
  get last() { return this.values.length ? this.values[this.values.length - 1] : null; }
}
