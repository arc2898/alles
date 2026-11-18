'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Transcriber, checkWav, cleanTranscript, MAX_BYTES } = require('../src/main/speech/stt');
const V = require('../src/workspace/voice-model');
const { tmpDir } = require('./helpers/tmp');

const wavOf = (ms = 1000, rate = 16000) => V.encodeWav(new Int16Array(Math.round(rate * ms / 1000)).fill(100), rate);

function rig({ programs = [], settings = {}, route = null, fetchImpl } = {}) {
  const bin = tmpDir('alles-stt-bin-'); const models = tmpDir('alles-stt-model-');
  for (const p of programs) fs.writeFileSync(path.join(bin, p), '#!/bin/sh\n', { mode: 0o755 });
  const model = path.join(models, 'ggml-base.bin'); fs.writeFileSync(model, 'm');
  const calls = []; let seen = null;
  const spawn = (exe, args) => {
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => { c.killed = true; c.emit('close', null); };
    seen = fs.existsSync(args[args.indexOf('-f') + 1]) ? fs.readFileSync(args[args.indexOf('-f') + 1]).length : -1;
    calls.push({ exe: path.basename(exe), args, child: c, file: args[args.indexOf('-f') + 1] });
    return c;
  };
  const sp = { sttEngine: 'auto', whisperBinary: '', whisperModel: model, sttRoute: '', sttModel: 'whisper-1', language: '', ...settings };
  const t = new Transcriber({ getSettings: () => sp, getRoute: () => route, spawn, fetchImpl, env: { PATH: bin }, tmpDir: tmpDir('alles-stt-tmp-') });
  return { t, calls, model, seenSize: () => seen };
}
const tick = () => new Promise((r) => setImmediate(r));

test('checkWav accepts our own recordings and refuses everything else with a plain reason', () => {
  assert.strictEqual(checkWav(wavOf(1000)).ok, true);
  assert.strictEqual(checkWav(wavOf(1000)).ms, 1000);
  assert.match(checkWav(wavOf(100)).error, /too short/);
  assert.match(checkWav(Buffer.from('not a wav at all, just text that is long enough to pass a size check ......')).error, /not a WAV/);
  assert.match(checkWav(null).error, /No recording/);
  assert.match(checkWav(Buffer.alloc(MAX_BYTES + 1)).error, /too long/);
  const stereo = Buffer.from(wavOf(1000)); stereo.writeUInt16LE(2, 22);
  assert.match(checkWav(stereo).error, /16-bit mono/);
  const odd = Buffer.from(wavOf(1000)); odd.writeUInt32LE(1000, 24);
  assert.match(checkWav(odd).error, /sample rate/);
});

test('cleanTranscript drops the noise markers, keeps the words', () => {
  assert.strictEqual(cleanTranscript(' [BLANK_AUDIO] '), '');
  assert.strictEqual(cleanTranscript('Hello [MUSIC] there (music) friend *clicking*'), 'Hello there friend');
  assert.strictEqual(cleanTranscript('a (b) c'), 'a (b) c', 'ordinary brackets in speech stay');
});

test('detect: auto uses whisper-cli when it is ready (private), http only when whisper is not', () => {
  const route = { baseUrl: 'https://api.example/v1', keys: ['k1'] };
  assert.strictEqual(rig({ programs: ['whisper-cli'], route, settings: { sttRoute: 'r' } }).t.detect().chosen, 'whisper-cli');
  const h = rig({ route, settings: { sttRoute: 'r' } }).t.detect();
  assert.strictEqual(h.chosen, 'http'); assert.strictEqual(h.sendsAudioAway, true);
  const none = rig().t.detect();
  assert.strictEqual(none.chosen, null); assert.match(none.whisper.problem, /not installed/); assert.match(none.http.problem, /no provider/);
  assert.strictEqual(rig({ programs: ['whisper-cli'], settings: { sttEngine: 'off' } }).t.detect().chosen, 'off');
  assert.strictEqual(rig({ programs: ['whisper-cli'], settings: { sttEngine: 'http' } }).t.detect().chosen, null, 'a chosen engine is not swapped for another');
  assert.ok(!('binary' in none.whisper) && !('model' in none.whisper) && !('route' in none.http), 'no paths or keys in what the page is told');
});

test('detect: whisper without a model file, a provider without a key, a route that disappeared', () => {
  assert.match(rig({ programs: ['whisper-cli'], settings: { whisperModel: '/nope.bin' } }).t.detect().whisper.problem, /no model file/);
  assert.match(rig({ route: { baseUrl: 'https://x/v1', keys: [] }, settings: { sttRoute: 'r' } }).t.detect().http.problem, /no API key/);
  assert.match(rig({ route: null, settings: { sttRoute: 'gone' } }).t.detect().http.problem, /no longer exists/);
});

test('whisper-cli: runs with the model and a temporary file, returns the words, and deletes the file', async () => {
  const { t, calls, model, seenSize } = rig({ programs: ['whisper-cli'], settings: { language: 'hi' } });
  const p = t.transcribe(wavOf(1500));
  await tick();
  assert.strictEqual(calls[0].exe, 'whisper-cli');
  assert.deepStrictEqual(calls[0].args.slice(0, 2), ['-m', model]);
  assert.ok(calls[0].args.includes('-nt') && calls[0].args.includes('-np'));
  assert.deepStrictEqual(calls[0].args.slice(-2), ['-l', 'hi']);
  assert.ok(seenSize() > 40000, 'the file existed and held the recording when the program started');
  calls[0].child.stdout.emit('data', ' open the settings\n');
  calls[0].child.emit('close', 0);
  assert.deepStrictEqual(await p, { ok: true, text: 'open the settings', engine: 'whisper-cli' });
  assert.ok(!fs.existsSync(path.dirname(calls[0].file)), 'the temporary folder with the recording is gone');
});

test('whisper-cli failing or hearing nothing gives a clear message, and the recording is still deleted', async () => {
  const a = rig({ programs: ['whisper-cli'] });
  const pa = a.t.transcribe(wavOf()); await tick();
  a.calls[0].child.stderr.emit('data', 'loading\nfailed to load model');
  a.calls[0].child.emit('close', 2);
  const ra = await pa;
  assert.strictEqual(ra.ok, false); assert.match(ra.error, /code 2: failed to load model/);
  assert.ok(!fs.existsSync(path.dirname(a.calls[0].file)));
  const b = rig({ programs: ['whisper-cli'] });
  const pb = b.t.transcribe(wavOf()); await tick();
  b.calls[0].child.stdout.emit('data', '[BLANK_AUDIO]'); b.calls[0].child.emit('close', 0);
  assert.match((await pb).error, /No words were heard/);
});

test('Stop ends a recognition that is running', async () => {
  const { t, calls } = rig({ programs: ['whisper-cli'] });
  const ctl = new AbortController();
  const p = t.transcribe(wavOf(), { signal: ctl.signal }); await tick();
  ctl.abort();
  assert.deepStrictEqual(await p, { ok: false, error: 'Stopped.' });
  assert.strictEqual(calls[0].child.killed, true);
});

test('nothing is run for a recording that is not a proper WAV', async () => {
  const { t, calls } = rig({ programs: ['whisper-cli'] });
  assert.strictEqual((await t.transcribe(Buffer.from('x'.repeat(100)))).ok, false);
  assert.strictEqual(calls.length, 0);
});

test('not set up: says exactly what is missing and what the choices are', async () => {
  const r = await rig().t.transcribe(wavOf());
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /install whisper\.cpp/); assert.match(r.error, /provider that offers transcription/);
});

test('http: posts the recording to the saved provider, with its key, model and language', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ text: ' hello world ' }) }; };
  const { t } = rig({ route: { baseUrl: 'https://api.example/v1/', keys: ['key-one-1234'] }, settings: { sttRoute: 'r', sttModel: 'whisper-large-v3', language: 'en' }, fetchImpl });
  const r = await t.transcribe(wavOf());
  assert.deepStrictEqual(r, { ok: true, text: 'hello world', engine: 'http' });
  assert.strictEqual(seen.url, 'https://api.example/v1/audio/transcriptions');
  assert.strictEqual(seen.init.headers.Authorization, 'Bearer key-one-1234');
  assert.strictEqual(seen.init.body.get('model'), 'whisper-large-v3');
  assert.strictEqual(seen.init.body.get('language'), 'en');
  assert.strictEqual(seen.init.body.get('file').size, wavOf().length);
});

test('http: a refused key falls to the next key; a wrong address does not retry; keys never appear in errors', async () => {
  const used = [];
  const fetchImpl = async (url, init) => { used.push(init.headers.Authorization); return used.length === 1 ? { ok: false, status: 401, text: async () => 'bad key key-one-1234' } : { ok: true, status: 200, json: async () => ({ text: 'ok' }) }; };
  const a = rig({ route: { baseUrl: 'https://x/v1', keys: ['key-one-1234', 'key-two-5678'] }, settings: { sttRoute: 'r' }, fetchImpl });
  assert.strictEqual((await a.t.transcribe(wavOf())).text, 'ok');
  assert.deepStrictEqual(used, ['Bearer key-one-1234', 'Bearer key-two-5678']);

  const calls = [];
  const gone = async () => { calls.push(1); return { ok: false, status: 404, text: async () => 'no such route key-one-1234' }; };
  const b = rig({ route: { baseUrl: 'https://x/v1', keys: ['key-one-1234', 'key-two-5678'] }, settings: { sttRoute: 'r' }, fetchImpl: gone });
  const r = await b.t.transcribe(wavOf());
  assert.strictEqual(calls.length, 1, 'a 404 is not fixed by another key');
  assert.match(r.error, /said 404/); assert.ok(!r.error.includes('key-one-1234'));

  const down = async () => { throw new Error('connect ECONNREFUSED key-one-1234'); };
  const c = rig({ route: { baseUrl: 'https://x/v1', keys: ['key-one-1234'] }, settings: { sttRoute: 'r' }, fetchImpl: down });
  const rc = await c.t.transcribe(wavOf());
  assert.match(rc.error, /Could not reach/); assert.ok(!rc.error.includes('key-one-1234'));
});
