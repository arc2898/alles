// Reads the numbers the top bar shows. Only the file reading is here (GNOME's libraries); every calculation is in lib/resources.js,
// which the tests run. Reads only what the switched-on widgets need, and caches where the sensors are so a reading costs a few tiny reads.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {
  parseCpuStat, cpuPercent, parseMeminfo, memoryUsage, swapUsage, parseNetDev, netRate, parseLoadavg, pickTemperature, parseBattery, History,
} from '../lib/resources.js';

const decoder = new TextDecoder();

function readText(path) {
  try {
    const [ok, bytes] = GLib.file_get_contents(path);
    return ok ? decoder.decode(bytes) : null;
  } catch (_e) {
    return null;
  }
}

function listDir(path) {
  const out = [];
  try {
    const dir = GLib.Dir.open(path, 0);
    let name;
    while ((name = dir.read_name()) !== null) out.push(name);
    dir.close();
  } catch (_e) { /* the folder is not there: no such sensor */ }
  return out;
}

export class Sampler {
  constructor() {
    this._cpuPrev = null;
    this._netPrev = null;
    this._netAt = 0;
    this._hist = { cpu: new History(30), memory: new History(30), swap: new History(30), rx: new History(30), tx: new History(30) };
    this._sensors = null;       // [{label, path}] found once
    this._battery = undefined;  // path of the battery folder, null if none, undefined = not looked for yet
  }

  _findSensors() {
    const found = [];
    for (const z of listDir('/sys/class/thermal').filter((n) => n.startsWith('thermal_zone'))) {
      found.push({ label: (readText(`/sys/class/thermal/${z}/type`) || '').trim(), path: `/sys/class/thermal/${z}/temp` });
    }
    for (const h of listDir('/sys/class/hwmon').filter((n) => n.startsWith('hwmon'))) {
      const label = (readText(`/sys/class/hwmon/${h}/name`) || '').trim();
      for (const f of listDir(`/sys/class/hwmon/${h}`).filter((n) => /^temp\d+_input$/.test(n))) found.push({ label, path: `/sys/class/hwmon/${h}/${f}` });
    }
    return found;
  }

  _findBattery() {
    const b = listDir('/sys/class/power_supply').find((n) => /^BAT\d*$/.test(n));
    return b ? `/sys/class/power_supply/${b}` : null;
  }

  /** @param {Set<string>} need which readings to take (lib/widgets.js neededSamples) @returns the samples object lib/widgets.js expects */
  sample(need) {
    const s = {};
    if (need.has('cpu')) {
      const cur = parseCpuStat(readText('/proc/stat'));
      const percent = cpuPercent(this._cpuPrev, cur);
      this._cpuPrev = cur;
      if (percent != null) this._hist.cpu.push(percent);
      s.cpu = { percent, history: [...this._hist.cpu.values] };
    }
    if (need.has('load')) s.load = parseLoadavg(readText('/proc/loadavg'));
    if (need.has('memory') || need.has('swap')) {
      const info = parseMeminfo(readText('/proc/meminfo'));
      const mem = memoryUsage(info); const swap = swapUsage(info);
      if (need.has('memory') && mem) { this._hist.memory.push(mem.percent); s.memory = { ...mem, history: [...this._hist.memory.values] }; }
      if (need.has('swap') && swap) { this._hist.swap.push(swap.percent); s.swap = { ...swap, history: [...this._hist.swap.values] }; }
    }
    if (need.has('disk')) {
      try {
        const info = Gio.File.new_for_path('/').query_filesystem_info('filesystem::size,filesystem::free', null);
        const total = info.get_attribute_uint64('filesystem::size'); const free = info.get_attribute_uint64('filesystem::free');
        if (total > 0) s.disk = { used: total - free, total, percent: Math.round(((total - free) / total) * 1000) / 10 };
      } catch (_e) { /* no reading */ }
    }
    if (need.has('network')) {
      const cur = parseNetDev(readText('/proc/net/dev'));
      const now = GLib.get_monotonic_time() / 1e6;
      const rate = this._netPrev ? netRate(this._netPrev, cur, now - this._netAt) : null;
      this._netPrev = cur; this._netAt = now;
      if (rate) { this._hist.rx.push(rate.rx); this._hist.tx.push(rate.tx); s.network = { ...rate, rxHistory: [...this._hist.rx.values], txHistory: [...this._hist.tx.values] }; }
    }
    if (need.has('temperature')) {
      if (!this._sensors) this._sensors = this._findSensors();
      const readings = this._sensors.map((x) => ({ label: x.label, milli: Number((readText(x.path) || '').trim()) }));
      const celsius = pickTemperature(readings);
      if (celsius != null) s.temperature = { celsius };
    }
    if (need.has('battery')) {
      if (this._battery === undefined) this._battery = this._findBattery();
      if (this._battery) {
        const b = parseBattery({ capacity: readText(`${this._battery}/capacity`), status: readText(`${this._battery}/status`) });
        if (b) s.battery = b;
      }
    }
    return s;
  }
}
