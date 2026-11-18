'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn: nodeSpawn } = require('node:child_process');
const { findExecutable } = require('./which');

/**
 * Speaker - ALLES talking. It runs a speech program that is already on this computer; nothing is sent anywhere.
 *
 *   piper       natural voices (needs a voice file, set in the workspace window)       piper --model M --output_file F, then a player
 *   espeak-ng   robotic but small and everywhere                                        espeak-ng --stdin
 *   spd-say     whatever voice the desktop's speech service (speech-dispatcher) uses   spd-say -e -w
 *   browser     the page's own speechSynthesis; main cannot run it, so speak() answers {reason:'use-browser'}
 *
 * The text is handed over on STANDARD INPUT, never in a command line and never through a shell, so what ALLES says cannot be
 * turned into a command. One thing is spoken at a time: speak() ends whatever is being said. stop() ends it at once.
 */

const MAX_CHARS = 4000;
const ENGINE_ORDER = ['piper', 'espeak-ng', 'spd-say'];
const PLAYERS = ['paplay', 'pw-play', 'aplay'];
const TIMEOUT_MS = 5 * 60_000;

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
const goodVoice = (v) => typeof v === 'string' && v && !v.startsWith('-') && /^[A-Za-z0-9._+\-\/ ]{1,80}$/.test(v);

class Speaker {
  /**
   * @param {object} o
   * @param {()=>object} o.getSettings  settings.speech
   * @param {Function} [o.spawn] @param {object} [o.env] @param {object} [o.fsImpl] @param {string} [o.tmpDir]
   */
  constructor({ getSettings, spawn = nodeSpawn, env = process.env, fsImpl = fs, tmpDir = os.tmpdir() }) {
    this.getSettings = getSettings; this.spawn = spawn; this.env = env; this.fs = fsImpl; this.tmpDir = tmpDir;
    this.child = null; this.token = 0; this.engine = null;
  }

  get speaking() { return !!this.child; }

  _find(name) { return findExecutable(name, { env: this.env, fsImpl: this.fs }); }

  /** What could speak right now, and which one 'auto' (or the person's choice) would use. Cheap: only looks. */
  detect() {
    const s = this.getSettings() || {};
    const piperModel = s.piperModel && this.fs.existsSync(s.piperModel) ? s.piperModel : '';
    const found = {
      piper: { available: !!this._find('piper') && !!piperModel, why: !this._find('piper') ? 'piper is not installed' : !piperModel ? 'no voice file chosen' : '' },
      'espeak-ng': { available: !!this._find('espeak-ng'), why: this._find('espeak-ng') ? '' : 'espeak-ng is not installed' },
      'spd-say': { available: !!this._find('spd-say'), why: this._find('spd-say') ? '' : 'speech-dispatcher is not installed' },
    };
    let chosen = null;
    if (s.ttsEngine === 'off') chosen = 'off';
    else if (s.ttsEngine === 'browser') chosen = 'browser';
    else if (ENGINE_ORDER.includes(s.ttsEngine)) chosen = found[s.ttsEngine].available ? s.ttsEngine : null;
    else chosen = ENGINE_ORDER.find((e) => found[e].available) || 'browser';
    return { engines: found, chosen, piperModel };
  }

  /**
   * Say `text`. Resolves when it has been said (or stopped).
   * @returns {Promise<{ok:true, engine:string} | {ok:false, reason:'off'|'use-browser'|'no-engine'|'failed'|'stopped'|'empty', error?:string}>}
   */
  async speak(text, { signal = null } = {}) {
    this.stop();
    const say = String(text == null ? '' : text).trim().slice(0, MAX_CHARS);
    if (!say) return { ok: false, reason: 'empty' };
    const det = this.detect();
    if (det.chosen === 'off') return { ok: false, reason: 'off' };
    if (det.chosen === 'browser') return { ok: false, reason: 'use-browser' };
    if (!det.chosen) return { ok: false, reason: 'no-engine', error: `The speech engine you chose is not available (${(det.engines[(this.getSettings() || {}).ttsEngine] || {}).why || 'not found'}).` };

    const token = ++this.token;
    this.engine = det.chosen;
    const s = this.getSettings() || {};
    const rate = clamp(Number.isFinite(s.ttsRate) ? s.ttsRate : 1, 0.5, 2);
    const voice = goodVoice(s.ttsVoice) ? s.ttsVoice : '';
    let result;
    try {
      if (det.chosen === 'piper') result = await this._piper(say, det.piperModel, rate, token, signal);
      else if (det.chosen === 'espeak-ng') result = await this._run('espeak-ng', ['-s', String(Math.round(175 * rate)), ...(voice ? ['-v', voice] : []), '--stdin'], say, token, signal);
      else result = await this._run('spd-say', ['-e', '-w', '-r', String(Math.round(clamp((rate - 1) * 100, -100, 100))), ...(voice ? ['-y', voice] : [])], say, token, signal);
    } catch (e) { result = { ok: false, reason: 'failed', error: (e && e.message) || String(e) }; }
    if (this.token === token) { this.child = null; this.engine = null; }
    return result.ok ? { ok: true, engine: det.chosen } : result;
  }

  /** Be quiet now. */
  stop() {
    this.token++;
    const c = this.child; this.child = null;
    if (c) { try { c.kill('SIGKILL'); } catch { /* already over */ } }
    if (this.engine === 'spd-say') { try { const x = this.spawn(this._find('spd-say') || 'spd-say', ['-C'], { stdio: 'ignore' }); if (x && x.on) x.on('error', () => {}); } catch { /* best effort */ } }
    this.engine = null;
  }

  /** Run one speech program with the text on its standard input. */
  _run(name, args, text, token, signal, { stdinText = true } = {}) {
    return new Promise((resolve) => {
      const exe = this._find(name) || name;
      let child; let done = false; let err = ''; let timer = null;
      const finish = (r) => { if (done) return; done = true; clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); if (this.child === child) this.child = null; resolve(r); };
      const onAbort = () => { try { child && child.kill('SIGKILL'); } catch { /* gone */ } finish({ ok: false, reason: 'stopped' }); };
      try { child = this.spawn(exe, args, { stdio: [stdinText ? 'pipe' : 'ignore', 'ignore', 'pipe'] }); }
      catch (e) { finish({ ok: false, reason: 'failed', error: e.message }); return; }
      if (this.token !== token) { try { child.kill('SIGKILL'); } catch { /* gone */ } finish({ ok: false, reason: 'stopped' }); return; }
      this.child = child;
      if (child.stderr) { child.stderr.setEncoding && child.stderr.setEncoding('utf8'); child.stderr.on('data', (c) => { if (err.length < 400) err += c; }); }
      child.on('error', (e) => finish({ ok: false, reason: 'failed', error: e.message }));
      child.on('close', (code, sig) => {
        if (this.token !== token || sig) finish({ ok: false, reason: 'stopped' });
        else if (code === 0) finish({ ok: true });
        else finish({ ok: false, reason: 'failed', error: `${name} stopped with code ${code}${err.trim() ? `: ${err.trim().slice(0, 200)}` : ''}` });
      });
      timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish({ ok: false, reason: 'failed', error: `${name} took too long` }); }, TIMEOUT_MS);
      if (timer.unref) timer.unref();
      if (signal) { if (signal.aborted) { onAbort(); return; } signal.addEventListener('abort', onAbort, { once: true }); }
      if (stdinText && child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(`${text}\n`); }
    });
  }

  async _piper(text, model, rate, token, signal) {
    const player = PLAYERS.find((p) => this._find(p));
    if (!player) return { ok: false, reason: 'failed', error: 'No audio player found (install pulseaudio-utils, pipewire or alsa-utils).' };
    let dir = null;
    try {
      dir = this.fs.mkdtempSync(path.join(this.tmpDir, 'alles-tts-'));
      const wav = path.join(dir, 'say.wav');
      const made = await this._run('piper', ['--model', model, '--length_scale', String(Math.round((1 / rate) * 100) / 100), '--output_file', wav], text, token, signal);
      if (!made.ok) return made;
      return await this._run(player, player === 'aplay' ? ['-q', wav] : [wav], '', token, signal, { stdinText: false });
    } finally {
      if (dir) { try { this.fs.rmSync(dir, { recursive: true, force: true }); } catch { /* left for the system's temp cleaning */ } }
    }
  }
}

module.exports = { Speaker, MAX_CHARS, ENGINE_ORDER };
