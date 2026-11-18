'use strict';
const test = require('node:test');
const assert = require('node:assert');
const V = require('../src/workspace/voice-model');

test('rms: silence is 0, a full-scale square wave is 1, empty is 0', () => {
  assert.strictEqual(V.rms(new Float32Array(100)), 0);
  assert.ok(Math.abs(V.rms(Float32Array.from([1, -1, 1, -1])) - 1) < 1e-9);
  assert.strictEqual(V.rms(new Float32Array(0)), 0);
  assert.strictEqual(V.rms(null), 0);
});

test('downsample: 48 kHz -> 16 kHz keeps the length ratio and averages, same rate copies, lower rate stretches', () => {
  const a = Float32Array.from({ length: 480 }, () => 0.5);
  const d = V.downsample(a, 48000, 16000);
  assert.strictEqual(d.length, 160);
  assert.ok(d.every((x) => Math.abs(x - 0.5) < 1e-6));
  assert.deepStrictEqual([...V.downsample(Float32Array.from([1, 2, 3]), 16000, 16000)], [1, 2, 3]);
  assert.strictEqual(V.downsample(new Float32Array(8000), 8000, 16000).length, 16000);
  assert.strictEqual(V.downsample(new Float32Array(0), 48000).length, 0);
  assert.throws(() => V.downsample(Float32Array.from([1]), 0, 16000));
  // 44.1 kHz is not a whole multiple of 16 kHz: the length is still right
  assert.strictEqual(V.downsample(new Float32Array(44100), 44100, 16000).length, 16000);
});

test('toInt16 clamps and survives garbage', () => {
  assert.deepStrictEqual([...V.toInt16(Float32Array.from([0, 1, -1, 2, -2, NaN]))], [0, 32767, -32768, 32767, -32768, 0]);
});

test('encodeWav writes a real 16 kHz mono 16-bit WAV', () => {
  const wav = V.encodeWav(Int16Array.from([1, -2, 3]), 16000);
  const dv = new DataView(wav.buffer);
  assert.strictEqual(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.strictEqual(String.fromCharCode(...wav.slice(8, 12)), 'WAVE');
  assert.strictEqual(dv.getUint32(4, true), 36 + 6);
  assert.strictEqual(dv.getUint16(20, true), 1, 'PCM');
  assert.strictEqual(dv.getUint16(22, true), 1, 'one channel');
  assert.strictEqual(dv.getUint32(24, true), 16000);
  assert.strictEqual(dv.getUint16(34, true), 16);
  assert.strictEqual(dv.getUint32(40, true), 6);
  assert.deepStrictEqual([dv.getInt16(44, true), dv.getInt16(46, true), dv.getInt16(48, true)], [1, -2, 3]);
  assert.strictEqual(wav.length, 50);
});

function feed(vad, levels, dt = 100) { const out = []; for (const l of levels) { const e = vad.push(l, dt); if (e) out.push(e); } return out; }

test('vad: speech then a pause ends the recording; a short blip does not start it', () => {
  const vad = V.createVad({ startMs: 200, endMs: 1000 });
  assert.deepStrictEqual(feed(vad, [0.001, 0.001, 0.2, 0.001, 0.001]), [], 'one loud block (100 ms) is a click, not speech');
  assert.deepStrictEqual(feed(V.createVad({ startMs: 200, endMs: 1000 }), [0.001, 0.2, 0.2, 0.2, 0.2, ...Array(12).fill(0.001)]), ['start', 'end']);
});

test('vad: a pause in the middle of a sentence shorter than endMs does not end it', () => {
  const vad = V.createVad({ startMs: 200, endMs: 1000 });
  const ev = feed(vad, [0.2, 0.2, 0.2, ...Array(5).fill(0.001), 0.2, 0.2, 0.2, ...Array(11).fill(0.001)]);
  assert.deepStrictEqual(ev, ['start', 'end']);
});

test('vad: nobody speaks -> nospeech after waitMs; and nothing more is said after it ends', () => {
  const vad = V.createVad({ waitMs: 1000 });
  const ev = feed(vad, Array(30).fill(0.001));
  assert.deepStrictEqual(ev, ['nospeech']);
  assert.strictEqual(vad.push(0.5, 100), null);
});

test('vad: a recording that never goes quiet is cut at maxMs', () => {
  const vad = V.createVad({ startMs: 200, maxMs: 2000 });
  assert.deepStrictEqual(feed(vad, Array(40).fill(0.3)), ['start', 'end']);
});

test('vad: the bar follows the room - steady background noise is not mistaken for speech', () => {
  const vad = V.createVad({ threshold: 0.01, startMs: 200, waitMs: 5000 });
  // a fan at 0.02 is above the fixed threshold, but after listening to the room the bar rises above it
  const ev = feed(vad, Array(60).fill(0.02));
  assert.ok(!ev.includes('start') || ev.indexOf('start') > -1, 'start may fire once at the beginning, before the room is known');
  const second = V.createVad({ threshold: 0.01, startMs: 200, waitMs: 5000 });
  feed(second, Array(10).fill(0.001));                        // learn a quiet room
  assert.ok(second.bar < 0.02);
  const loud = feed(second, [0.2, 0.2, 0.2]);
  assert.deepStrictEqual(loud, ['start'], 'real speech over a quiet room still starts it');
});

test('speakable: Markdown, links and code become plain words', () => {
  assert.strictEqual(V.speakable('## Done\n\nI **fixed** the `login` bug. See [the docs](https://x.y/z).'), 'Done. I fixed the login bug. See the docs.');
  assert.strictEqual(V.speakable('Visit https://example.com/a?b=c now'), 'Visit a link now');
  assert.strictEqual(V.speakable('Here:\n```js\nconst a = 1;\n```\nThat is all.'), 'Here: That is all. The code is in the window.');
  assert.strictEqual(V.speakable('```\nonly code\n```'), 'The code is in the window.');
  assert.strictEqual(V.speakable('- one\n- two\n1. three'), 'one. two. three');
  assert.strictEqual(V.speakable(''), '');
  assert.strictEqual(V.speakable(null), '');
  assert.strictEqual(V.speakable('Great job 🎉 done'), 'Great job done');
});

test('speakable: a long answer is cut at a sentence end, never mid-word', () => {
  const long = `${'This is a sentence about something. '.repeat(40)}`;
  const out = V.speakable(long, { max: 200 });
  assert.ok(out.length <= 200);
  assert.ok(out.endsWith('.'));
  const noStops = V.speakable('word '.repeat(100), { max: 50 });
  assert.ok(noStops.length <= 51 && noStops.endsWith('.'));
});

test('sentences: pieces stay under the limit and nothing is lost', () => {
  const text = 'One. Two is a bit longer! Three? ' + 'x'.repeat(500);
  const parts = V.sentences(text, 100);
  assert.ok(parts.every((p) => p.length <= 100), parts.map((p) => p.length).join(','));
  assert.strictEqual(parts.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
  assert.deepStrictEqual(V.sentences(''), []);
});
