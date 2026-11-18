'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn: nodeSpawn } = require('node:child_process');
const { findExecutable } = require('./which');
const { redact } = require('../redact');

/**
 * Transcriber - the person talking to ALLES. A recording (a 16 kHz WAV the workspace page made) comes in, text goes out.
 *
 *   whisper-cli   whisper.cpp on this computer. Private: the sound never leaves it. Needs the program and a model file.
 *   http          any server that speaks OpenAI's  POST /v1/audio/transcriptions  (OpenAI, Groq, a local faster-whisper server...).
 *                 It uses one of the person's SAVED provider routes for the address and key, so keys stay in the key store.
 *                 The sound IS sent to that server: the workspace page says so next to the choice.
 *
 * The recording is checked before anything is run (it must be a small, plain, 16-bit one-channel WAV), is written to a private
 * temporary folder only for whisper-cli, and is deleted again whatever happens.
 */

const MAX_BYTES = 12 * 1024 * 1024;     // about six minutes at 16 kHz, 16 bit
const MIN_MS = 300;
const WHISPER_NAMES = ['whisper-cli', 'whisper-cpp', 'whisper.cpp'];
const WHISPER_TIMEOUT_MS = 180_000;
const HTTP_TIMEOUT_MS = 90_000;
const MAX_TEXT = 8000;

/** Is this a WAV we can work with? Returns {ok:true, rate, ms} or {ok:false, error}. Never throws. */
function checkWav(bytes) {
  const b = bytes && bytes.buffer ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : (Buffer.isBuffer(bytes) ? bytes : null);
  if (!b) return { ok: false, error: 'No recording was received.' };
  if (b.length > MAX_BYTES) return { ok: false, error: 'That recording is too long. Speak in shorter pieces.' };
  if (b.length < 44 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE' || b.toString('latin1', 12, 16) !== 'fmt ') return { ok: false, error: 'The recording is not a WAV file.' };
  const fmt = b.readUInt16LE(20); const channels = b.readUInt16LE(22); const rate = b.readUInt32LE(24); const bits = b.readUInt16LE(34);
  if (fmt !== 1 || channels !== 1 || bits !== 16) return { ok: false, error: 'The recording must be 16-bit mono WAV.' };
  if (rate < 8000 || rate > 48000) return { ok: false, error: 'The recording has an unusual sample rate.' };
  // find the data chunk (a header can carry extra chunks)
  let at = 12; let dataBytes = -1;
  while (at + 8 <= b.length) {
    const id = b.toString('latin1', at, at + 4); const size = b.readUInt32LE(at + 4);
    if (id === 'data') { dataBytes = Math.min(size, b.length - at - 8); break; }
    at += 8 + size + (size % 2);
  }
  if (dataBytes < 0) return { ok: false, error: 'The recording has no sound in it.' };
  const ms = Math.round((dataBytes / 2 / rate) * 1000);
  if (ms < MIN_MS) return { ok: false, error: 'That was too short to hear. Hold the button a little longer.' };
  return { ok: true, rate, ms };
}

/** whisper.cpp marks silence and noises in brackets: [BLANK_AUDIO], (music), *clicking*. Not words the person said. */
function cleanTranscript(text) {
  let t = String(text == null ? '' : text);
  t = t.replace(/\[[^\]\n]{1,40}\]/g, ' ').replace(/\((?:music|silence|noise|applause|laughter|inaudible|blank_audio)[^)\n]{0,30}\)/gi, ' ').replace(/\*[A-Za-z ]{1,30}\*/g, ' ');
  return t.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

class Transcriber {
  /**
   * @param {object} o
   * @param {()=>object} o.getSettings                 settings.speech
   * @param {(id:string)=>({baseUrl:string, keys:string[]}|null)} o.getRoute   a saved provider's address and keys (main process only)
   */
  constructor({ getSettings, getRoute = () => null, spawn = nodeSpawn, fetchImpl = (...a) => fetch(...a), env = process.env, fsImpl = fs, tmpDir = os.tmpdir() }) {
    this.getSettings = getSettings; this.getRoute = getRoute; this.spawn = spawn; this.fetch = fetchImpl; this.env = env; this.fs = fsImpl; this.tmpDir = tmpDir;
  }

  _whisper() {
    const s = this.getSettings() || {};
    const names = s.whisperBinary ? [s.whisperBinary] : WHISPER_NAMES;
    let binary = null;
    for (const n of names) { binary = findExecutable(n, { env: this.env, fsImpl: this.fs }); if (binary) break; }
    const model = s.whisperModel && this.fs.existsSync(s.whisperModel) ? s.whisperModel : '';
    const problem = !binary ? 'whisper.cpp (whisper-cli) is not installed' : !model ? 'no model file chosen (a ggml-*.bin file)' : '';
    return { available: !problem, binary, model, problem };
  }

  _http() {
    const s = this.getSettings() || {};
    if (!s.sttRoute) return { available: false, problem: 'no provider chosen' };
    let route = null; try { route = this.getRoute(s.sttRoute); } catch { route = null; }
    if (!route || !route.baseUrl) return { available: false, problem: 'that provider no longer exists or has no address' };
    if (!route.keys || !route.keys.length) return { available: false, problem: 'that provider has no API key' };
    return { available: true, route, problem: '' };
  }

  /** What could understand speech right now, and which one would be used. Cheap: only looks. */
  detect() {
    const s = this.getSettings() || {};
    const whisper = this._whisper(); const http = this._http();
    let chosen = null;
    if (s.sttEngine === 'off') chosen = 'off';
    else if (s.sttEngine === 'whisper-cli') chosen = whisper.available ? 'whisper-cli' : null;
    else if (s.sttEngine === 'http') chosen = http.available ? 'http' : null;
    else chosen = whisper.available ? 'whisper-cli' : http.available ? 'http' : null;      // 'auto': the private one first
    const { binary, model, ...w } = whisper; const { route, ...h } = http;
    return { whisper: w, http: h, chosen, sendsAudioAway: chosen === 'http' };
  }

  /**
   * @param {Uint8Array|Buffer} wav
   * @returns {Promise<{ok:true, text:string, engine:string} | {ok:false, error:string}>}
   */
  async transcribe(wav, { signal = null } = {}) {
    const checked = checkWav(wav);
    if (!checked.ok) return checked;
    const s = this.getSettings() || {};
    const d = this.detect();
    if (d.chosen === 'off') return { ok: false, error: 'Speech recognition is switched off.' };
    if (!d.chosen) {
      return { ok: false, error: `Speech recognition is not set up. To keep your voice on this computer, install whisper.cpp and choose a model file (${d.whisper.problem}); or choose a provider that offers transcription (${d.http.problem}).` };
    }
    try {
      const text = d.chosen === 'whisper-cli' ? await this._runWhisper(Buffer.from(wav.buffer ? wav.buffer : wav, wav.byteOffset || 0, wav.byteLength || wav.length), s, signal) : await this._postHttp(wav, s, signal);
      const clean = cleanTranscript(text);
      if (!clean) return { ok: false, error: 'No words were heard. Try again, a little closer to the microphone.' };
      return { ok: true, text: clean, engine: d.chosen };
    } catch (e) {
      if (signal && signal.aborted) return { ok: false, error: 'Stopped.' };
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  async _runWhisper(wav, s, signal) {
    const w = this._whisper();
    let dir = null;
    try {
      dir = this.fs.mkdtempSync(path.join(this.tmpDir, 'alles-stt-'));
      try { this.fs.chmodSync(dir, 0o700); } catch { /* the default is already private */ }
      const file = path.join(dir, 'speech.wav');
      this.fs.writeFileSync(file, wav, { mode: 0o600 });
      const args = ['-m', w.model, '-f', file, '-nt', '-np', ...(s.language ? ['-l', s.language] : [])];
      return await new Promise((resolve, reject) => {
        let out = ''; let err = ''; let done = false; let child;
        const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); fn(v); };
        const onAbort = () => { try { child && child.kill('SIGKILL'); } catch { /* gone */ } finish(reject, new Error('Stopped.')); };
        const timer = setTimeout(() => { try { child && child.kill('SIGKILL'); } catch { /* gone */ } finish(reject, new Error('Speech recognition took too long.')); }, WHISPER_TIMEOUT_MS);
        if (timer.unref) timer.unref();
        try { child = this.spawn(w.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { finish(reject, e); return; }
        child.stdout.setEncoding && child.stdout.setEncoding('utf8'); child.stderr.setEncoding && child.stderr.setEncoding('utf8');
        child.stdout.on('data', (c) => { if (out.length < 200_000) out += c; });
        child.stderr.on('data', (c) => { if (err.length < 2000) err += c; });
        child.on('error', (e) => finish(reject, e));
        child.on('close', (code) => (code === 0 ? finish(resolve, out) : finish(reject, new Error(`whisper stopped with code ${code}${err.trim() ? `: ${err.trim().split('\n').pop().slice(0, 200)}` : ''}`))));
        if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
      });
    } finally {
      if (dir) { try { this.fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the system's temp cleaning will */ } }
    }
  }

  async _postHttp(wav, s, signal) {
    const { route } = this._http();
    const url = `${String(route.baseUrl).replace(/\/+$/, '')}/audio/transcriptions`;
    let lastError = 'The transcription server did not answer.';
    for (const key of route.keys.slice(0, 3)) {            // a key that is refused or rate-limited: the next one
      const form = new FormData();
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
      form.append('model', s.sttModel || 'whisper-1');
      form.append('response_format', 'json');
      if (s.language) form.append('language', s.language);
      const timeout = AbortSignal.timeout(HTTP_TIMEOUT_MS);
      const sig = signal && AbortSignal.any ? AbortSignal.any([signal, timeout]) : (signal || timeout);
      let res;
      try { res = await this.fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: sig, redirect: 'error' }); }
      catch (e) { if (signal && signal.aborted) throw e; lastError = redact(`Could not reach the transcription server: ${e.message}`, route.keys); continue; }
      if (res.ok) {
        let body; try { body = await res.json(); } catch { throw new Error('The transcription server answered with something that is not JSON.'); }
        return typeof body.text === 'string' ? body.text : '';
      }
      let detail = ''; try { detail = (await res.text()).slice(0, 200); } catch { /* no body */ }
      lastError = redact(`The transcription server said ${res.status}${detail ? `: ${detail}` : ''}`, route.keys);
      if (![401, 403, 429].includes(res.status)) break;      // another key will not change a 404 (wrong address or model)
    }
    throw new Error(lastError);
  }
}

module.exports = { Transcriber, checkWav, cleanTranscript, MAX_BYTES, MIN_MS };
