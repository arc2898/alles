'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Speaker } = require('../src/main/speech/tts');
const { findExecutable } = require('../src/main/speech/which');
const { tmpDir } = require('./helpers/tmp');

/** A folder of pretend programs, and a spawn that records what was run and lets the test end each one. */
function rig(programs, settings = {}) {
  const bin = tmpDir('alles-tts-bin-');
  for (const p of programs) { fs.writeFileSync(path.join(bin, p), '#!/bin/sh\n', { mode: 0o755 }); }
  const calls = []; const children = [];
  const spawn = (exe, args, opts) => {
    const c = new EventEmitter(); c.stdin = { written: '', ended: false, on() {}, end(t) { this.written += t || ''; this.ended = true; } };
    c.stderr = new EventEmitter(); c.stderr.setEncoding = () => {}; c.killed = false;
    c.kill = () => { c.killed = true; setImmediate(() => c.emit('close', null, 'SIGKILL')); };
    calls.push({ exe: path.basename(exe), args, opts, child: c }); children.push(c);
    return c;
  };
  const sp = new Speaker({ getSettings: () => ({ ttsEngine: 'auto', ttsVoice: '', ttsRate: 1, piperModel: '', ...settings }), spawn, env: { PATH: bin }, tmpDir: tmpDir('alles-tts-tmp-') });
  const finish = (i = children.length - 1, code = 0) => setImmediate(() => children[i].emit('close', code, null));
  return { sp, calls, children, finish, bin };
}

test('findExecutable finds programs on PATH, ignores folders and non-executables, and never runs anything', () => {
  const { bin } = rig(['espeak-ng']);
  fs.mkdirSync(path.join(bin, 'adir')); fs.writeFileSync(path.join(bin, 'plain'), 'x', { mode: 0o644 });
  const env = { PATH: bin };
  assert.strictEqual(findExecutable('espeak-ng', { env }), path.join(bin, 'espeak-ng'));
  assert.strictEqual(findExecutable('adir', { env }), null);
  assert.strictEqual(findExecutable('plain', { env }), null);
  assert.strictEqual(findExecutable('missing', { env }), null);
  assert.strictEqual(findExecutable('', { env }), null);
  assert.strictEqual(findExecutable('a\nb', { env }), null);
  assert.strictEqual(findExecutable(path.join(bin, 'espeak-ng'), { env: {} }), path.join(bin, 'espeak-ng'));
});

test('auto picks the first engine that exists, in the order piper, espeak-ng, spd-say; the browser is the last resort', () => {
  assert.strictEqual(rig(['espeak-ng', 'spd-say']).sp.detect().chosen, 'espeak-ng');
  assert.strictEqual(rig(['spd-say']).sp.detect().chosen, 'spd-say');
  assert.strictEqual(rig([]).sp.detect().chosen, 'browser');
  const model = path.join(tmpDir('alles-voice-'), 'v.onnx'); fs.writeFileSync(model, 'x');
  assert.strictEqual(rig(['piper', 'espeak-ng'], { piperModel: model }).sp.detect().chosen, 'piper');
  assert.strictEqual(rig(['piper', 'espeak-ng']).sp.detect().chosen, 'espeak-ng', 'piper without a voice file is not usable');
});

test('a chosen engine that is missing is reported, never silently replaced', async () => {
  const { sp } = rig(['espeak-ng'], { ttsEngine: 'spd-say' });
  const r = await sp.speak('hello');
  assert.deepStrictEqual([r.ok, r.reason], [false, 'no-engine']);
  assert.match(r.error, /speech-dispatcher is not installed/);
});

test('"off" and "browser" never start a program', async () => {
  const off = rig(['espeak-ng'], { ttsEngine: 'off' });
  assert.strictEqual((await off.sp.speak('hi')).reason, 'off');
  const br = rig(['espeak-ng'], { ttsEngine: 'browser' });
  assert.strictEqual((await br.sp.speak('hi')).reason, 'use-browser');
  assert.strictEqual(off.calls.length + br.calls.length, 0);
});

test('espeak-ng: the text goes in on standard input (not in the command line), with rate and voice', async () => {
  const { sp, calls, finish } = rig(['espeak-ng'], { ttsRate: 1.5, ttsVoice: 'en-us+f3' });
  const p = sp.speak('Hello; $(rm -rf ~) world');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(calls[0].exe, 'espeak-ng');
  assert.deepStrictEqual(calls[0].args, ['-s', '263', '-v', 'en-us+f3', '--stdin']);
  assert.ok(!calls[0].args.join(' ').includes('rm -rf'), 'what is said never becomes an argument');
  assert.strictEqual(calls[0].child.stdin.written, 'Hello; $(rm -rf ~) world\n');
  finish();
  assert.deepStrictEqual(await p, { ok: true, engine: 'espeak-ng' });
  assert.strictEqual(sp.speaking, false);
});

test('a voice that looks like an option is ignored, not passed on', async () => {
  const { sp, calls, finish } = rig(['espeak-ng'], { ttsVoice: '-x' });
  const p = sp.speak('hi'); await new Promise((r) => setImmediate(r));
  assert.ok(!calls[0].args.includes('-v'));
  finish(); await p;
});

test('spd-say: waits for the end and reads from standard input', async () => {
  const { sp, calls, finish } = rig(['spd-say'], { ttsRate: 1 });
  const p = sp.speak('hello'); await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(calls[0].args, ['-e', '-w', '-r', '0']);
  finish(); assert.strictEqual((await p).ok, true);
});

test('speaking something new ends what was being said, and stop() ends it at once', async () => {
  const { sp, calls, children, finish } = rig(['espeak-ng']);
  const first = sp.speak('one'); await new Promise((r) => setImmediate(r));
  const second = sp.speak('two'); await new Promise((r) => setImmediate(r));
  assert.strictEqual(children[0].killed, true);
  assert.strictEqual((await first).reason, 'stopped');
  sp.stop();
  assert.strictEqual(children[1].killed, true);
  assert.strictEqual((await second).reason, 'stopped');
  assert.strictEqual(calls.length, 2);
  finish;
});

test('the Stop signal ends speech', async () => {
  const { sp, children } = rig(['espeak-ng']);
  const ctl = new AbortController();
  const p = sp.speak('long talk', { signal: ctl.signal }); await new Promise((r) => setImmediate(r));
  ctl.abort();
  assert.strictEqual((await p).reason, 'stopped');
  assert.strictEqual(children[0].killed, true);
});

test('a program that fails says why, in words', async () => {
  const { sp, children } = rig(['espeak-ng']);
  const p = sp.speak('hi'); await new Promise((r) => setImmediate(r));
  children[0].stderr.emit('data', 'no audio device');
  children[0].emit('close', 3, null);
  const r = await p;
  assert.strictEqual(r.ok, false); assert.match(r.error, /code 3: no audio device/);
});

test('empty text says nothing; very long text is cut', async () => {
  const { sp, calls, finish } = rig(['espeak-ng']);
  assert.strictEqual((await sp.speak('   ')).reason, 'empty');
  const p = sp.speak('x'.repeat(20000)); await new Promise((r) => setImmediate(r));
  assert.ok(calls[0].child.stdin.written.length <= 4001);
  finish(); await p;
});

test('piper: speaks into a temporary file, plays it, and removes it afterwards', async () => {
  const model = path.join(tmpDir('alles-voice-'), 'v.onnx'); fs.writeFileSync(model, 'x');
  const { sp, calls, children } = rig(['piper', 'paplay'], { piperModel: model, ttsRate: 2 });
  const p = sp.speak('hi there');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(calls[0].exe, 'piper');
  assert.deepStrictEqual(calls[0].args.slice(0, 4), ['--model', model, '--length_scale', '0.5']);
  const wav = calls[0].args[calls[0].args.indexOf('--output_file') + 1];
  assert.ok(fs.existsSync(path.dirname(wav)));
  children[0].emit('close', 0, null);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(calls[1].exe, 'paplay'); assert.deepStrictEqual(calls[1].args, [wav]);
  children[1].emit('close', 0, null);
  assert.deepStrictEqual(await p, { ok: true, engine: 'piper' });
  assert.ok(!fs.existsSync(path.dirname(wav)), 'the temporary folder is gone');
});

test('piper without any audio player says what to install', async () => {
  const model = path.join(tmpDir('alles-voice-'), 'v.onnx'); fs.writeFileSync(model, 'x');
  const { sp } = rig(['piper'], { piperModel: model });
  const r = await sp.speak('hi');
  assert.match(r.error, /No audio player found/);
});
