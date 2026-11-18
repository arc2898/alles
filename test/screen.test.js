'use strict';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const fs = require('node:fs');
const { ScreenCapture, nativeResizer, pngSize, computeScale, toScreen, detectDesktop, BACKENDS, ORDER, MAX_MODEL_EDGE } = require('../src/main/computer/screen');

// Build a tiny but VALID PNG of a given size (all-black RGB) with no image lib.
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const row = Buffer.alloc(1 + w * 3); // filter byte + pixels
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('pngSize reads real dimensions from the header', () => {
  assert.deepStrictEqual(pngSize(makePng(1920, 1080)), { width: 1920, height: 1080 });
  assert.deepStrictEqual(pngSize(makePng(7, 3)), { width: 7, height: 3 });
});

test('pngSize rejects garbage and truncated data', () => {
  assert.throws(() => pngSize(Buffer.from('not a png at all, definitely')), /not a valid PNG/);
  assert.throws(() => pngSize(Buffer.alloc(5)), /not a valid PNG/);
});

test('computeScale: downscales big screens, never upscales small ones', () => {
  assert.strictEqual(computeScale(1920, 1080), MAX_MODEL_EDGE / 1920);
  assert.strictEqual(computeScale(1280, 720), 1);
  assert.strictEqual(computeScale(800, 600), 1);
  assert.strictEqual(computeScale(1080, 1920), MAX_MODEL_EDGE / 1920); // portrait uses the LONG edge
});

test('toScreen: model coords map back to real pixels (1920x1080 -> 1280x720)', () => {
  const s = computeScale(1920, 1080);
  assert.deepStrictEqual(toScreen(640, 360, s), { x: 960, y: 540 });   // centre stays centre
  assert.deepStrictEqual(toScreen(0, 0, s), { x: 0, y: 0 });
  assert.deepStrictEqual(toScreen(1280, 720, s), { x: 1920, y: 1080 }); // far corner
});

test('toScreen: round-trip error stays within 1px for HiDPI 3840x2160', () => {
  const s = computeScale(3840, 2160);
  for (const [rx, ry] of [[0, 0], [1234, 567], [3839, 2159], [1920, 1080]]) {
    const mx = rx * s, my = ry * s;
    const back = toScreen(mx, my, s);
    assert.ok(Math.abs(back.x - rx) <= 1 && Math.abs(back.y - ry) <= 1, `(${rx},${ry}) -> (${back.x},${back.y})`);
  }
});

test('toScreen rejects a bad scale', () => {
  assert.throws(() => toScreen(1, 1, 0), /Invalid scale/);
  assert.throws(() => toScreen(1, 1, -1), /Invalid scale/);
  assert.throws(() => toScreen(1, 1, NaN), /Invalid scale/);
});

// Fake tool runner that "takes a screenshot" by writing a PNG to the -o path.
function fakeRunner(png, { produceFile = true } = {}) {
  const calls = [];
  const runImpl = async (bin, args) => {
    calls.push({ bin, args });
    if (!produceFile) return '';
    const out = bin === 'spectacle' ? args[args.indexOf('-o') + 1]
      : bin === 'gnome-screenshot' ? args[args.indexOf('-f') + 1]
      : args[0];
    fs.writeFileSync(out, png);
    return '';
  };
  return { calls, runImpl };
}
const stubResizer = (_png, w, h) => makePng(w, h);

test('capture (spectacle): correct flags, returns model-sized image + scale', async () => {
  const f = fakeRunner(makePng(1920, 1080));
  const cap = new ScreenCapture({ backend: 'spectacle', runImpl: f.runImpl, resizer: stubResizer });
  const r = await cap.capture();
  assert.deepStrictEqual(f.calls[0].args.slice(0, 4), ['-b', '-n', '-f', '-o']);
  assert.strictEqual(r.width, 1920); assert.strictEqual(r.height, 1080);
  assert.strictEqual(r.modelWidth, 1280); assert.strictEqual(r.modelHeight, 720);
  // THE INVARIANT: the image handed to the model matches the coordinate space.
  assert.deepStrictEqual(pngSize(r.png), { width: r.modelWidth, height: r.modelHeight });
  assert.deepStrictEqual(pngSize(r.original), { width: 1920, height: 1080 });
});

test('capture (grim): uses grim with the output path', async () => {
  const f = fakeRunner(makePng(1280, 720));
  const cap = new ScreenCapture({ backend: 'grim', runImpl: f.runImpl });
  const r = await cap.capture();
  assert.strictEqual(f.calls[0].bin, 'grim');
  assert.strictEqual(r.scale, 1);
});

test('small screens need no resizer and pass through untouched', async () => {
  const png = makePng(1024, 768);
  const cap = new ScreenCapture({ backend: 'grim', runImpl: fakeRunner(png).runImpl }); // NO resizer
  const r = await cap.capture();
  assert.strictEqual(r.scale, 1);
  assert.ok(r.png.equals(png));
});

test('INVARIANT: large screen without a resizer FAILS instead of mis-aiming clicks', async () => {
  const cap = new ScreenCapture({ backend: 'grim', runImpl: fakeRunner(makePng(1920, 1080)).runImpl });
  await assert.rejects(() => cap.capture(), /no resizer was provided/);
});

test('INVARIANT: a resizer returning the wrong size is caught', async () => {
  const badResizer = () => makePng(999, 999);
  const cap = new ScreenCapture({ backend: 'grim', runImpl: fakeRunner(makePng(1920, 1080)).runImpl, resizer: badResizer });
  await assert.rejects(() => cap.capture(), /Resizer returned 999x999, expected 1280x720/);
});

test('capture cleans up its temp file, even on failure', async () => {
  const before = fs.readdirSync(require('node:os').tmpdir()).filter((n) => n.startsWith('alles-shot-')).length;
  const cap = new ScreenCapture({ backend: 'grim', runImpl: fakeRunner(makePng(1920, 1080)).runImpl }); // will throw: no resizer
  await assert.rejects(() => cap.capture());
  const after = fs.readdirSync(require('node:os').tmpdir()).filter((n) => n.startsWith('alles-shot-')).length;
  assert.strictEqual(after, before, 'leaked a screenshot temp file');
});

test('tool exits OK but writes nothing (e.g. locked screen) -> clear error', async () => {
  const cap = new ScreenCapture({ backend: 'spectacle', runImpl: fakeRunner(null, { produceFile: false }).runImpl });
  await assert.rejects(() => cap.capture(), /produced no file/);
});

// ---- desktop-aware backend selection (GNOME first) --------------------------------
// Every test pins `env` explicitly: leaving it to process.env would make the result depend on
// whatever desktop the developer happens to be running.
const ALL = ['gnome-screenshot', 'spectacle', 'grim'];
const mk = (have, desktop) => new ScreenCapture({ whichImpl: async (b) => have.includes(b), env: { XDG_CURRENT_DESKTOP: desktop } });

test('detectDesktop: GNOME and the distros that ship it are all recognised as gnome', () => {
  for (const v of ['GNOME', 'ubuntu:GNOME', 'GNOME-Classic:GNOME', 'gnome', 'Unity', 'zorin:GNOME', 'pop:GNOME']) {
    assert.strictEqual(detectDesktop({ XDG_CURRENT_DESKTOP: v }), 'gnome', v);
  }
});

test('detectDesktop: KDE / wlroots recognised; an unrecognised desktop is "unknown", not guessed', () => {
  assert.strictEqual(detectDesktop({ XDG_CURRENT_DESKTOP: 'KDE' }), 'kde');
  assert.strictEqual(detectDesktop({ XDG_SESSION_DESKTOP: 'plasma' }), 'kde');
  assert.strictEqual(detectDesktop({ XDG_CURRENT_DESKTOP: 'sway' }), 'wlroots');
  assert.strictEqual(detectDesktop({ XDG_CURRENT_DESKTOP: 'Hyprland' }), 'wlroots');
  assert.strictEqual(detectDesktop({ XDG_CURRENT_DESKTOP: 'X-Cinnamon' }), 'unknown', 'no evidence about Cinnamon, so no claim');
  assert.strictEqual(detectDesktop({}), 'unknown');
  assert.strictEqual(detectDesktop({ XDG_CURRENT_DESKTOP: undefined }), 'unknown');
});

test('GNOME: gnome-screenshot is chosen FIRST even when spectacle and grim are also installed', async () => {
  assert.strictEqual(await mk(ALL, 'GNOME').detect(), 'gnome-screenshot');
});

test('KDE: spectacle is chosen first (the KDE behaviour is preserved)', async () => {
  assert.strictEqual(await mk(ALL, 'KDE').detect(), 'spectacle');
});

test('wlroots: grim is chosen first', async () => {
  assert.strictEqual(await mk(ALL, 'sway').detect(), 'grim');
});

test('unknown desktop defaults to the GNOME-first order', async () => {
  assert.strictEqual(await mk(ALL, undefined).detect(), 'gnome-screenshot');
});

test('fallback: on GNOME with gnome-screenshot missing, another installed tool is used', async () => {
  assert.strictEqual(await mk(['spectacle', 'grim'], 'GNOME').detect(), 'spectacle');
  assert.strictEqual(await mk(['grim'], 'GNOME').detect(), 'grim');
});

test('GNOME with NO tool: the error names what to install for GNOME specifically', async () => {
  await assert.rejects(() => mk([], 'GNOME').detect(), (e) => /GNOME/.test(e.message) && /gnome-screenshot/.test(e.message) && /apt install/.test(e.message));
});

test('KDE with NO tool: the error names spectacle, not gnome-screenshot', async () => {
  await assert.rejects(() => mk([], 'KDE').detect(), (e) => /KDE/.test(e.message) && /spectacle/.test(e.message) && !/^.*Install gnome-screenshot/.test(e.message));
});

test('every desktop order lists every known backend exactly once (no dead or duplicate entries)', () => {
  for (const [d, order] of Object.entries(ORDER)) {
    assert.deepStrictEqual([...order].sort(), Object.keys(BACKENDS).sort(), d);
  }
});

test('BACKENDS: each tool is invoked with the flags verified against its --help output', () => {
  assert.deepStrictEqual(BACKENDS['gnome-screenshot'].args('/tmp/x.png'), ['-f', '/tmp/x.png']);
  assert.deepStrictEqual(BACKENDS.spectacle.args('/tmp/x.png'), ['-b', '-n', '-f', '-o', '/tmp/x.png']);
  assert.deepStrictEqual(BACKENDS.grim.args('/tmp/x.png'), ['/tmp/x.png']);
});

test('capture() on GNOME invokes gnome-screenshot -f <file> and returns a usable image', async () => {
  const f = fakeRunner(makePng(1920, 1080));
  const cap = new ScreenCapture({ runImpl: f.runImpl, resizer: stubResizer, whichImpl: async (b) => b === 'gnome-screenshot', env: { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' } });
  const r = await cap.capture();
  assert.strictEqual(f.calls[0].bin, 'gnome-screenshot');
  assert.strictEqual(f.calls[0].args[0], '-f');
  assert.deepStrictEqual(pngSize(r.png), { width: r.modelWidth, height: r.modelHeight });
});

test('an unknown explicit backend name is rejected clearly', async () => {
  const cap = new ScreenCapture({ backend: 'imaginary', runImpl: fakeRunner(makePng(10, 10)).runImpl });
  await assert.rejects(() => cap.capture(), /Unknown screenshot backend "imaginary"/);
});

test('nativeResizer shrinks with Electron\'s nativeImage: the size asked for, at best quality; a picture that cannot be read is an error', () => {
  const calls = [];
  const fake = { createFromBuffer: (b) => ({ isEmpty: () => b.length === 0, resize: (o) => { calls.push(o); return { toPNG: () => Buffer.from('shrunk') }; } }) };
  const out = nativeResizer(fake)(Buffer.from('big'), 640, 360);
  assert.deepStrictEqual(calls, [{ width: 640, height: 360, quality: 'best' }]);
  assert.strictEqual(out.toString(), 'shrunk');
  assert.throws(() => nativeResizer(fake)(Buffer.alloc(0), 1, 1), /could not be read/);
});
