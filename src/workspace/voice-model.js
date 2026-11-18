'use strict';

/**
 * Voice model. PURE: no DOM, no Electron, no Node-only calls. The page records sound and talks through these functions; the main
 * process reuses speakable() so what is read aloud is cleaned the same way everywhere. Works as a CommonJS module (tests, main)
 * and as a plain <script> (the sandboxed page cannot use require()).
 *
 *  - rms / downsample / toInt16 / encodeWav   what the microphone gives (floating point, the sound card's rate) -> the 16 kHz,
 *                                              16-bit, one-channel WAV that speech recognisers take
 *  - createVad                                 decides, from loudness alone, when a person started and stopped speaking
 *  - speakable / sentences                     turns an answer (Markdown, code, links) into words worth reading aloud
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VoiceModel = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  const TARGET_RATE = 16000;

  /** Loudness of a block of samples (0 = silence, 1 = as loud as the format allows). */
  function rms(samples) {
    const n = samples ? samples.length : 0;
    if (!n) return 0;
    let sum = 0;
    for (let i = 0; i < n; i++) { const v = samples[i]; sum += v * v; }
    return Math.sqrt(sum / n);
  }

  /** Lower the sample rate by averaging the samples that fall into each new sample (enough for speech; no extra library). */
  function downsample(input, fromRate, toRate = TARGET_RATE) {
    if (!input || !input.length) return new Float32Array(0);
    if (!(fromRate > 0) || !(toRate > 0)) throw new Error('sample rates must be positive');
    if (fromRate === toRate) return Float32Array.from(input);
    if (fromRate < toRate) {                         // a sound card below 16 kHz: stretch (rare, and still intelligible)
      const out = new Float32Array(Math.floor(input.length * toRate / fromRate));
      for (let i = 0; i < out.length; i++) out[i] = input[Math.min(input.length - 1, Math.floor(i * fromRate / toRate))];
      return out;
    }
    const ratio = fromRate / toRate;
    const out = new Float32Array(Math.floor(input.length / ratio));
    for (let i = 0; i < out.length; i++) {
      const start = Math.floor(i * ratio); const end = Math.min(input.length, Math.floor((i + 1) * ratio));
      let sum = 0; for (let j = start; j < end; j++) sum += input[j];
      out[i] = end > start ? sum / (end - start) : 0;
    }
    return out;
  }

  function toInt16(samples) {
    const out = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, Number.isFinite(samples[i]) ? samples[i] : 0));
      out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    }
    return out;
  }

  /** A complete WAV file (44-byte header + 16-bit little-endian samples, one channel). */
  function encodeWav(int16, sampleRate = TARGET_RATE) {
    const bytes = int16.length * 2;
    const buf = new ArrayBuffer(44 + bytes);
    const v = new DataView(buf);
    const tag = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
    tag(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); tag(8, 'WAVE');
    tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    tag(36, 'data'); v.setUint32(40, bytes, true);
    for (let i = 0; i < int16.length; i++) v.setInt16(44 + i * 2, int16[i], true);
    return new Uint8Array(buf);
  }

  /**
   * Voice activity detector. Feed it the loudness of each short block of sound and how long the block was (ms); it answers with
   * what just happened: null (nothing new), 'start' (someone began speaking), 'end' (they stopped: a pause long enough, or the
   * recording got too long) or 'nospeech' (nobody spoke for a long time: give up listening).
   *
   * The bar for "loud enough" follows the room: it is the larger of `threshold` and a few times the usual background level,
   * learned from the blocks while nobody speaks, so a fan or a quiet microphone does not keep it listening for ever.
   */
  function createVad({ threshold = 0.012, startMs = 160, endMs = 1300, maxMs = 45000, waitMs = 9000, noiseFactor = 2.8 } = {}) {
    let noise = 0; let loud = 0; let quiet = 0; let total = 0; let waited = 0; let speaking = false; let finished = false;
    return {
      get speaking() { return speaking; },
      get bar() { return Math.max(threshold, noise * noiseFactor); },
      push(level, dtMs) {
        if (finished) return null;
        const bar = Math.max(threshold, noise * noiseFactor);
        const isLoud = level >= bar;
        if (!speaking) {
          if (isLoud) { loud += dtMs; } else { loud = 0; noise = noise === 0 ? level : noise * 0.95 + level * 0.05; }
          waited += dtMs;
          if (loud >= startMs) { speaking = true; quiet = 0; total = loud; return 'start'; }
          if (waited >= waitMs) { finished = true; return 'nospeech'; }
          return null;
        }
        total += dtMs;
        if (isLoud) quiet = 0; else quiet += dtMs;
        if (quiet >= endMs || total >= maxMs) { finished = true; speaking = false; return 'end'; }
        return null;
      },
    };
  }

  /**
   * An answer as words to say aloud: code is not read out (it says so once), links become "a link", Markdown marks disappear, and
   * a long answer is cut at a sentence end - speech is for the gist, the window has the rest.
   */
  function speakable(text, { max = 700 } = {}) {
    let t = String(text == null ? '' : text);
    let hadCode = false;
    t = t.replace(/```[\s\S]*?(```|$)/g, () => { hadCode = true; return '\n'; });
    t = t.replace(/`([^`\n]+)`/g, '$1');
    t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
    t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    t = t.replace(/\bhttps?:\/\/\S+/gi, 'a link');
    t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/^\s*>\s?/gm, '').replace(/^\s*[-*+]\s+/gm, '').replace(/^\s*\d+[.)]\s+/gm, '');
    t = t.replace(/(\*\*|__|\*|_|~~)/g, '');
    t = t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F]/gu, '');
    t = t.replace(/([^.!?:;,\s])[ \t]*\n\s*/g, '$1. ').replace(/\s*\n\s*/g, ' ').replace(/\.\s*\./g, '.').replace(/\s+/g, ' ').trim();
    if (hadCode) t = t ? `${t} The code is in the window.` : 'The code is in the window.';
    if (t.length > max) {
      const cut = t.slice(0, max);
      const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
      t = end > max * 0.4 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, '')}.`;
    }
    return t;
  }

  /** Split into pieces of at most `max` characters at sentence ends (a speech engine given one very long piece may stall). */
  function sentences(text, max = 220) {
    const parts = String(text == null ? '' : text).match(/[^.!?]+[.!?]*\s*/g) || [];
    const out = []; let cur = '';
    for (const p of parts) {
      if ((cur + p).length > max && cur) { out.push(cur.trim()); cur = ''; }
      cur += p;
      while (cur.length > max) { const at = cur.lastIndexOf(' ', max); const k = at > 20 ? at : max; out.push(cur.slice(0, k).trim()); cur = cur.slice(k); }
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  return { TARGET_RATE, rms, downsample, toInt16, encodeWav, createVad, speakable, sentences };
}));
