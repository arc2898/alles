'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const T = require('../src/main/topbar-config');

const load = (name) => import(pathToFileURL(path.join(__dirname, '../extension/lib', name)).href);

// ------------------------------------------------------------------ the two copies of the settings rules agree

test('the extension\'s settings rules and the app\'s give the SAME answer for hostile, odd and random input', async () => {
  const E = await load('config.js');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(E.DEFAULT_TOPBAR)), JSON.parse(JSON.stringify(T.DEFAULT_TOPBAR)));
  for (const k of ['POSITIONS', 'FLOATING', 'WIDGET_TYPES', 'WIDGET_WHERE', 'WIDGET_STYLES', 'COLOR_KEYS', 'MAX_WIDGETS']) assert.deepStrictEqual(E[k], T[k], k);
  const corpus = [undefined, null, 0, 'x', [], true, {}, { enabled: false, position: 'left', index: 3 }, { colors: { ready: '#ABC', text: '', background: 'red' } },
    { widgets: [{ type: 'command', command: 'uptime -p', intervalSec: 1 }, { type: 'cpu' }, { type: 'cpu' }, { type: 'x' }, 5] }, { shelf: { folder: '/home/a/b/', keepDays: 5000, maxShown: 0 } },
    { resources: { intervalSec: 99 }, labelMaxChars: 'lots' }, { widgets: 'no' }, JSON.parse('{"__proto__": {"enabled": false}, "enabled": true}')];
  let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const junk = () => pick([undefined, null, 0, 1, -5, 1e9, NaN, '', 'x', '#fff', '#12345g', 'left', 'both', 'cpu', 'command', true, false, [], {}, '/tmp/x', '../x', 'a\nb', 'x'.repeat(400)]);
  for (let i = 0; i < 400; i++) {
    corpus.push({ enabled: junk(), floatingPill: junk(), position: junk(), index: junk(), showLabel: junk(), labelMaxChars: junk(), compact: junk(), micButton: junk(),
      colors: rnd() < 0.7 ? { idle: junk(), ready: junk(), text: junk(), background: junk(), listening: junk() } : junk(),
      widgets: rnd() < 0.8 ? Array.from({ length: Math.floor(rnd() * 20) }, () => ({ id: junk(), type: pick(['cpu', 'memory', 'swap', 'disk', 'network', 'temperature', 'battery', 'clock', 'command', junk()]), enabled: junk(), where: junk(), label: junk(), style: junk(), command: junk(), intervalSec: junk(), timeoutSec: junk() })) : junk(),
      resources: rnd() < 0.5 ? { intervalSec: junk() } : junk(), shelf: rnd() < 0.7 ? { enabled: junk(), folder: junk(), keepDays: junk(), maxShown: junk() } : junk() });
  }
  corpus.forEach((input, i) => assert.deepStrictEqual(E.sanitizeTopbar(input), T.sanitizeTopbar(input), `input #${i}: ${String(JSON.stringify(input)).slice(0, 120)}`));
});

test('reading the settings FILE: missing, empty, damaged or foreign content gives the defaults; a good file gives its top bar', async () => {
  const E = await load('config.js');
  const d = JSON.parse(JSON.stringify(T.DEFAULT_TOPBAR));
  for (const t of [null, '', '{not json', '[]', '"x"', '{}', '{"topbar": 5}']) assert.deepStrictEqual(E.topbarFromSettingsText(t), d, String(t));
  assert.strictEqual(E.topbarFromSettingsText(JSON.stringify({ topbar: { position: 'center' }, speech: { x: 1 } })).position, 'center');
});

// ------------------------------------------------------------------ system readings

const STAT1 = 'cpu  1000 0 500 8000 500 0 0 0 0 0\ncpu0 500 0 250 4000 250 0 0 0 0 0\nintr 123\n';
const STAT2 = 'cpu  1200 0 600 8600 600 0 0 0 0 0\n';

test('CPU: the percent busy between two readings; nothing to compare gives null, never NaN or a wrong number', async () => {
  const R = await load('resources.js');
  const a = R.parseCpuStat(STAT1); const b = R.parseCpuStat(STAT2);
  assert.deepStrictEqual(a, { idle: 8500, total: 10000 });
  assert.strictEqual(R.cpuPercent(a, b), 30, '300 of 1000 ticks were not idle');
  assert.strictEqual(R.cpuPercent(null, b), null); assert.strictEqual(R.cpuPercent(a, a), null, 'no time passed');
  assert.strictEqual(R.cpuPercent(b, a), null, 'a counter that went backwards');
  for (const bad of ['', 'cpu a b c d', 'nothing', null, undefined, 'cpu  -1 0 0 0']) assert.strictEqual(R.parseCpuStat(bad), null, String(bad));
});

test('memory and swap from /proc/meminfo: "used" means what applications hold (total minus AVAILABLE, not minus free)', async () => {
  const R = await load('resources.js');
  const info = R.parseMeminfo('MemTotal:       16384000 kB\nMemFree:         1000000 kB\nMemAvailable:    8192000 kB\nSwapTotal:       4096000 kB\nSwapFree:        3072000 kB\n');
  assert.strictEqual(info.memTotal, 16384000 * 1024);
  assert.deepStrictEqual(R.memoryUsage(info), { used: 8192000 * 1024, total: 16384000 * 1024, percent: 50 });
  assert.deepStrictEqual(R.swapUsage(info), { used: 1024000 * 1024, total: 4096000 * 1024, percent: 25 });
  assert.strictEqual(R.swapUsage(R.parseMeminfo('MemTotal: 100 kB\nMemAvailable: 50 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n')), null, 'no swap');
  assert.strictEqual(R.parseMeminfo('garbage'), null);
  const old = R.parseMeminfo('MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 100 kB\nCached: 300 kB\n');
  assert.strictEqual(old.memAvailable, 500 * 1024, 'an old kernel without MemAvailable');
});

test('network: real interfaces only, rates per second, a counter reset is zero not a huge negative', async () => {
  const R = await load('resources.js');
  const dev = (rx, tx) => `Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n    lo: 999999 10 0 0 0 0 0 0 999999 10 0 0 0 0 0 0\n  eth0: ${rx} 10 0 0 0 0 0 0 ${tx} 10 0 0 0 0 0 0\ndocker0: 5000 1 0 0 0 0 0 0 5000 1 0 0 0 0 0 0\n`;
  const a = R.parseNetDev(dev(1000, 500)); const b = R.parseNetDev(dev(3000, 1500));
  assert.deepStrictEqual(a, { rx: 1000, tx: 500 });
  assert.deepStrictEqual(R.netRate(a, b, 2), { rx: 1000, tx: 500 });
  assert.deepStrictEqual(R.netRate(b, a, 2), { rx: 0, tx: 0 });
  assert.strictEqual(R.netRate(a, b, 0), null); assert.strictEqual(R.parseNetDev('nothing'), null);
});

test('temperature: the processor\'s sensor if there is one, ignoring nonsense readings; battery from capacity and status', async () => {
  const R = await load('resources.js');
  assert.strictEqual(R.pickTemperature([{ label: 'nvme', milli: 70000 }, { label: 'coretemp', milli: 54500 }, { label: 'iwlwifi', milli: 40000 }]), 54.5);
  assert.strictEqual(R.pickTemperature([{ label: 'x', milli: 41000 }, { label: 'y', milli: 43000 }]), 43, 'no processor label: the hottest');
  assert.strictEqual(R.pickTemperature([{ label: 'coretemp', milli: 9999999 }, { label: 'a', milli: NaN }]), null);
  assert.strictEqual(R.pickTemperature([]), null);
  assert.deepStrictEqual(R.parseBattery({ capacity: '87\n', status: 'Charging\n' }), { percent: 87, charging: true, full: false });
  assert.deepStrictEqual(R.parseBattery({ capacity: '100', status: 'Full' }), { percent: 100, charging: false, full: true });
  assert.strictEqual(R.parseBattery({ capacity: 'x' }), null); assert.strictEqual(R.parseBattery(null), null);
  assert.deepStrictEqual(R.parseLoadavg('0.52 0.40 0.30 1/500 1234'), { one: 0.52, five: 0.4, fifteen: 0.3 });
});

test('numbers read well: percent, bytes, rates, degrees, and a text sparkline', async () => {
  const R = await load('resources.js');
  assert.deepStrictEqual([R.formatPercent(23.4), R.formatPercent(null), R.formatBytes(512), R.formatBytes(1536), R.formatBytes(5.5 * 1024 ** 3), R.formatBytes(-1), R.formatRate(2048), R.formatTemp(54.4), R.formatTemp(null)],
    ['23%', '–', '512 B', '1.5 KB', '5.5 GB', '–', '2 KB/s', '54°C', '–']);
  assert.strictEqual(R.sparkline([0, 50, 100], 100, 8), '▁▅█');
  assert.strictEqual(R.sparkline([], 100), ''); assert.strictEqual(R.sparkline([NaN, 'x']), '');
  assert.strictEqual(R.sparkline(Array.from({ length: 20 }, () => 100), 100, 5).length, 5, 'only the last few');
  const h = new R.History(3); [1, 2, 3, 4, NaN].forEach((v) => h.push(v));
  assert.deepStrictEqual(h.values, [2, 3, 4]); assert.strictEqual(h.last, 4);
});

// ------------------------------------------------------------------ widgets

const samples = () => ({
  cpu: { percent: 42.3, history: [10, 20, 42] }, load: { one: 0.5, five: 0.4, fifteen: 0.3 },
  memory: { used: 8 * 1024 ** 3, total: 16 * 1024 ** 3, percent: 50, history: [50, 50] }, swap: null,
  disk: { used: 90 * 1024 ** 3, total: 100 * 1024 ** 3, percent: 90 }, network: { rx: 2048, tx: 1024, rxHistory: [1, 2, 3], txHistory: [] },
  temperature: { celsius: 80 }, battery: { percent: 15, charging: false, full: false }, commands: { up: { text: 'up 2 hours' }, bad: { failed: true, text: '' } },
});

test('bar items: only enabled widgets that belong in the bar and have a reading, labelled, in the given order', async () => {
  const W = await load('widgets.js'); const D = await load('config.js');
  const items = W.barItems(D.sanitizeTopbar({}).widgets, samples(), { now: new Date(2026, 10, 4, 9, 5) });
  assert.deepStrictEqual(items.map((i) => i.text), ['CPU 42%', 'RAM 50%']);
  assert.deepStrictEqual(W.barItems(D.sanitizeTopbar({}).widgets, samples(), { compact: true }).map((i) => i.text), ['42%', '50%']);
  const custom = D.sanitizeTopbar({ widgets: [{ type: 'clock', where: 'bar' }, { type: 'cpu', label: 'Busy', style: 'both', where: 'bar' }, { type: 'network', where: 'both', style: 'text' }, { type: 'memory', where: 'menu' }, { type: 'temperature', where: 'bar' }, { type: 'battery', where: 'bar' }, { type: 'swap', where: 'bar' }] }).widgets;
  const texts = W.barItems(custom, samples(), { now: new Date(2026, 10, 4, 9, 5) }).map((i) => i.text);
  assert.deepStrictEqual([texts[0], texts[2], texts[3], texts[4]], ['09:05', 'Net ↓ 2 KB/s ↑ 1 KB/s', 'Temp 80°C', 'Bat 15%']);
  assert.match(texts[1], /^Busy 42% [▁-█]+$/, 'a custom label, the value and a sparkline');
  assert.ok(!texts.some((t) => /swap/i.test(t)), 'no swap: nothing to say, so nothing in the bar');
});

test('menu rows: values, details, bar fractions, tones; unavailable readings say why instead of disappearing', async () => {
  const W = await load('widgets.js'); const D = await load('config.js');
  const rows = W.menuRows(D.sanitizeTopbar({ widgets: ['cpu', 'memory', 'swap', 'disk', 'network', 'temperature', 'battery'].map((type) => ({ type, where: 'menu' })) }).widgets, samples());
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.strictEqual(by.cpu.value, '42%'); assert.strictEqual(by.cpu.fraction, 0.423); assert.match(by.cpu.detail, /load 0.5/);
  assert.strictEqual(by.memory.value, '8 GB of 16 GB');
  assert.deepStrictEqual([by.swap.value, by.swap.available], ['no swap', false]);
  assert.strictEqual(by.disk.value, '10 GB free of 100 GB'); assert.strictEqual(by.disk.tone, 'warn');
  assert.strictEqual(by.network.value, '↓ 2 KB/s   ↑ 1 KB/s');
  assert.strictEqual(by.temperature.tone, 'warn'); assert.strictEqual(by.battery.tone, 'warn');
  assert.match(by.battery.value, /15% \(on battery\)/);
  assert.deepStrictEqual(W.menuRows(D.sanitizeTopbar({}).widgets.map((w) => ({ ...w, where: 'bar' })), samples()), [], 'bar-only widgets are not in the menu');
  const none = W.menuRows(D.sanitizeTopbar({ widgets: [{ type: 'cpu', where: 'menu' }] }).widgets, {});
  assert.strictEqual(none[0].value, 'measuring…');
});

test('thresholds: warn and crit colours', async () => {
  const W = await load('widgets.js');
  assert.deepStrictEqual([W.toneFor('cpu', { percent: 50 }), W.toneFor('cpu', { percent: 75 }), W.toneFor('cpu', { percent: 95 })], ['normal', 'warn', 'crit']);
  assert.strictEqual(W.toneFor('battery', { percent: 5, charging: true }), 'normal', 'charging is not an alarm');
  assert.strictEqual(W.toneFor('battery', { percent: 5, charging: false }), 'crit');
  assert.strictEqual(W.toneFor('cpu', null), 'normal'); assert.strictEqual(W.toneFor('mystery', { percent: 99 }), 'normal');
});

test('command widgets show the last output, an error mark when it failed, and "no command set" when empty', async () => {
  const W = await load('widgets.js'); const D = await load('config.js');
  const ws = D.sanitizeTopbar({ widgets: [{ type: 'command', id: 'up', command: 'uptime -p', where: 'both' }, { type: 'command', id: 'bad', command: 'false', where: 'both' }, { type: 'command', id: 'empty', where: 'menu' }, { type: 'command', id: 'new', command: 'date', where: 'both' }] }).widgets;
  const items = W.barItems(ws, samples()); assert.deepStrictEqual(items.map((i) => i.text), ['up 2 hours', '⚠', '…']);
  assert.strictEqual(items[1].tone, 'crit');
  assert.strictEqual(W.menuRows(ws, samples()).find((r) => r.id === 'empty').value, 'no command set');
});

test('the sampler reads only what is switched on', async () => {
  const W = await load('widgets.js'); const D = await load('config.js');
  assert.deepStrictEqual([...W.neededSamples(D.sanitizeTopbar({}).widgets)].sort(), ['cpu', 'disk', 'load', 'memory']);
  assert.deepStrictEqual([...W.neededSamples(D.sanitizeTopbar({ widgets: [] }).widgets)], []);
  assert.deepStrictEqual([...W.neededSamples(D.sanitizeTopbar({ widgets: [{ type: 'clock' }, { type: 'command', command: 'date' }] }).widgets)], []);
});

// ------------------------------------------------------------------ commands

test('splitCommand: quotes and backslashes like a shell, but ; | $() > & are ordinary characters (there is no shell)', async () => {
  const C = await load('command.js');
  assert.deepStrictEqual(C.splitCommand('uptime -p'), ['uptime', '-p']);
  assert.deepStrictEqual(C.splitCommand(`sh -c "echo 'hi there'"`), ['sh', '-c', "echo 'hi there'"]);
  assert.deepStrictEqual(C.splitCommand("echo a\\ b 'c d' \"e\\\"f\""), ['echo', 'a b', 'c d', 'e"f']);
  assert.deepStrictEqual(C.splitCommand('ls ; rm -rf ~ | cat $(id) > x &'), ['ls', ';', 'rm', '-rf', '~', '|', 'cat', '$(id)', '>', 'x', '&']);
  assert.deepStrictEqual(C.splitCommand('echo ""'), ['echo', '']);
  for (const bad of ['', '   ', 'echo "open', "echo 'open", 'a\nb', 'a\u0000b', 5, null, undefined, 'x '.repeat(50)]) assert.strictEqual(C.splitCommand(bad), null, String(bad).slice(0, 20));
});

test('firstLine: the first non-empty line, control characters removed, shortened with an ellipsis', async () => {
  const C = await load('command.js');
  assert.strictEqual(C.firstLine('\n\n  up 2 hours  \nsecond'), 'up 2 hours');
  assert.strictEqual(C.firstLine('a\u001b[31mred\u001b[0m'), 'a[31mred[0m', 'the escape character is removed (a terminal colour code cannot do anything in the bar)');
  assert.strictEqual(C.firstLine('x'.repeat(100), 10), 'xxxxxxxxx…');
  assert.strictEqual(C.firstLine(null), ''); assert.strictEqual(C.firstLine('\n\n'), '');
});

// ------------------------------------------------------------------ the shelf

test('shelf names: safe, unique, readable', async () => {
  const S = await load('shelf.js');
  assert.strictEqual(S.safeName('../../etc/passwd'), 'etc passwd'); assert.strictEqual(S.safeName('.hidden'), 'hidden'); assert.strictEqual(S.safeName('   '), 'item');
  assert.ok(S.safeName(`${'a'.repeat(300)}.pdf`).endsWith('.pdf') && S.safeName(`${'a'.repeat(300)}.pdf`).length <= 120);
  assert.strictEqual(S.snippetFileName(new Date(2026, 10, 4, 15, 30, 12)), 'snippet-20261104-153012.txt');
  assert.strictEqual(S.snippetTitle('\n\n  Meeting notes\nmore'), 'Meeting notes'); assert.strictEqual(S.snippetTitle('x'.repeat(100), 10), 'xxxxxxxxx…');
  assert.strictEqual(S.uniqueName('a.pdf', ['b']), 'a.pdf'); assert.strictEqual(S.uniqueName('a.pdf', ['a.pdf', 'a (2).pdf']), 'a (3).pdf'); assert.strictEqual(S.uniqueName('noext', ['noext']), 'noext (2)');
});

test('shelf listing: newest first, hidden things and the marker left out, kinds, a "more" count', async () => {
  const S = await load('shelf.js');
  const e = [{ name: 'old.png', size: 1, mtimeMs: 1 }, { name: S.MARKER, mtimeMs: 99 }, { name: 'dir', isDir: true, mtimeMs: 5 }, { name: 'snippet-1.txt', mtimeMs: 9 }, { name: 'new.pdf', mtimeMs: 7 }];
  const l = S.listEntries(e, { max: 3 });
  assert.deepStrictEqual(l.items.map((i) => [i.name, i.kind]), [['snippet-1.txt', 'text'], ['new.pdf', 'file'], ['dir', 'folder']]);
  assert.deepStrictEqual([l.more, l.total], [1, 4]);
  assert.strictEqual(S.summarise(l), '4 items'); assert.strictEqual(S.summarise({ total: 0 }), 'Empty'); assert.strictEqual(S.summarise({ total: 1 }), '1 item');
  assert.deepStrictEqual(S.listEntries(null), { items: [], more: 0, total: 0 });
});

test('expiry: only old, visible items, only when a number of days is set, and only in a folder that is meant to be tidied', async () => {
  const S = await load('shelf.js'); const DAY = 86400000; const now = 100 * DAY;
  const e = [{ name: 'a', mtimeMs: now - 10 * DAY }, { name: 'b', mtimeMs: now - 2 * DAY }, { name: '.alles-shelf', mtimeMs: 0 }, { name: 'c', mtimeMs: NaN }];
  assert.deepStrictEqual(S.expired(e, 7, now).map((x) => x.name), ['a']);
  assert.deepStrictEqual(S.expired(e, 0, now), [], '0 = keep for ever');
  assert.strictEqual(S.mayExpire({ isDefaultFolder: false, hasMarker: false }), false, 'Documents is never tidied');
  assert.strictEqual(S.mayExpire({ isDefaultFolder: true }), true); assert.strictEqual(S.mayExpire({ hasMarker: true }), true);
});

test('what goes on the clipboard so that pasting in the file manager copies the file', async () => {
  const S = await load('shelf.js');
  assert.strictEqual(S.pathToUri('/home/me/My Files/a b#1.txt'), 'file:///home/me/My%20Files/a%20b%231.txt');
  assert.strictEqual(S.copiedFilesPayload(['/a/b.txt', '/c d']), 'copy\nfile:///a/b.txt\nfile:///c%20d');
  assert.match(S.humanAge(Date.now() - 5000), /just now/); assert.strictEqual(S.humanAge(0, 90 * 60 * 1000), '2 h ago'); assert.strictEqual(S.humanAge(0, 86400000), 'yesterday');
});

// ------------------------------------------------------------------ the pill's look

test('the pill: not running, approval first, listening, working, done, error', async () => {
  const St = await load('state.js');
  const cfg = { labelMaxChars: 12, colors: { ready: '#5ee6a8', idle: '#7c8aa5' } };
  assert.deepStrictEqual([St.describeState({ running: false }, cfg).orb, St.describeState({ running: false }, cfg).label], ['idle', 'ALLES']);
  const run = (state) => St.describeState({ running: true, state }, cfg);
  assert.strictEqual(run({ status: { state: 'idle' } }).orb, 'ready');
  assert.strictEqual(run({ status: { state: 'thinking', label: 'Thinking…' } }).orb, 'working');
  assert.strictEqual(run({ status: { state: 'acting', label: 'Opening the settings window' } }).label, 'Opening the…', 'long labels are cut to the setting');
  assert.deepStrictEqual([run({ status: { state: 'done', reply: 'All done.' } }).orb, run({ status: { state: 'done', reply: 'All done.' } }).tooltip], ['ready', 'All done.']);
  assert.strictEqual(run({ status: { state: 'error', label: 'Failed' } }).orb, 'problem');
  assert.strictEqual(run({ status: { state: 'stopped' } }).orb, 'idle');
  assert.strictEqual(run({ status: { state: 'thinking' }, voice: { state: 'listening' } }).orb, 'listening');
  assert.strictEqual(run({ status: { state: 'idle' }, voice: { state: 'transcribing' } }).orb, 'working');
  const ap = run({ status: { state: 'thinking' }, voice: { state: 'listening' }, approval: { id: 'q', title: 'Run a command?' } });
  assert.deepStrictEqual([ap.orb, ap.approval.id], ['attention', 'q'], 'a question to answer beats everything');
  const armed = run({ status: { state: 'idle' }, voice: { state: 'wake', wake: true, wakePhrase: 'hey alles' } });
  assert.strictEqual(armed.armed, true); assert.match(armed.tooltip, /hey alles/);
  assert.strictEqual(St.describeState({ running: true, state: {} }, cfg).orb, 'ready', 'a state with nothing in it does not throw');
  assert.strictEqual(St.orbStyle({ colors: { working: '#6aa9ff', idle: '#000000' } }, 'working'), 'background-color: #6aa9ff;');
});
