'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

/**
 * SettingsStore - persisted, validated, crash-safe app settings.
 *
 * DESIGN RULES
 *  1. Every read is sanitized. A hand-edited or corrupted file can never put the
 *     app in an invalid state: bad fields fall back to defaults individually
 *     (one bad field does not reset the rest).
 *  2. Writes are ATOMIC: write to a temp file, then rename over the target. A
 *     crash or power loss mid-write leaves the old file intact, never a half file.
 *  3. A file that fails to parse is moved aside (settings.json.corrupt-<time>) so
 *     the user's data is never silently destroyed, then defaults are used.
 *  4. API KEYS ARE NOT IN THIS FILE. They go through the encrypted key store
 *     (safeStorage). This file is plain JSON a person may read or share.
 */

const EDGES = ['top', 'bottom', 'left', 'right'];

// How the mouse and keyboard are driven. Must list exactly computer/select-backend.js MODES (a test enforces it; it is not
// required from here so that reading settings never loads the input code).
const INPUT_BACKENDS = ['auto', 'gnome', 'ydotool'];

// Provider kinds. providers/openai-compat.js PRESETS must have exactly these keys (a test enforces it).
const KINDS = ['nvidia', 'grok', 'gemini', 'custom'];
const MAX_ROUTES = 12;

// The out-of-the-box provider list, in PRIORITY order: NVIDIA primary, NVIDIA fallback (a second
// account/key/model), then Grok and Gemini. Empty model / baseUrl mean "use the preset for this kind".
const DEFAULT_ROUTES = Object.freeze([
  { id: 'nvidia-primary', kind: 'nvidia', label: 'NVIDIA', model: '', baseUrl: '', enabled: true },
  { id: 'nvidia-fallback', kind: 'nvidia', label: 'NVIDIA (fallback)', model: '', baseUrl: '', enabled: true },
  { id: 'grok', kind: 'grok', label: 'Grok', model: '', baseUrl: '', enabled: true },
  { id: 'gemini', kind: 'gemini', label: 'Gemini', model: '', baseUrl: '', enabled: true },
]);

// Speech. 'auto' picks the first engine found on this computer. See speech/tts.js and speech/stt.js for what each name runs.
const TTS_ENGINES = ['auto', 'piper', 'espeak-ng', 'spd-say', 'browser', 'off'];
const STT_ENGINES = ['auto', 'whisper-cli', 'http', 'off'];
// What the coding area may do without asking: 'ask' = ask before every file change and command, 'edits' = change files inside the
// project folder by itself but ask before a command, 'full' = file edits by itself; shell commands still obey the Safety approval toggle.
const CODE_AUTONOMY = ['ask', 'edits', 'full'];

const { DEFAULT_TOPBAR, sanitizeTopbar } = require('./topbar-config');

// Which program records the microphone. 'auto' = the first one found (see speech/recorder.js).
const RECORDERS = ['auto', 'parec', 'pw-record', 'arecord'];

const DEFAULTS = Object.freeze({
  version: 3,
  dock: {
    edge: 'top',
    along: 0.5,          // 0..1 position along the edge; the source of truth for placement
    display: null,       // id of the display it lives on; null = follow the cursor / primary
    autoHide: false,
    hour12: false,
  },
  agent: {
    maxSteps: 40,
    keepImages: 2,
  },
  // The tray icon is OPTIONAL and OFF by default: stock GNOME has no tray, and Electron
  // cannot tell us whether one exists (see tray.js). Nothing depends on it.
  tray: {
    enabled: false,
  },
  // 'auto' = GNOME's own remote-input service on GNOME (nothing to install), ydotool anywhere else or if that does not work.
  input: {
    backend: 'auto',
  },
  providers: {
    routes: DEFAULT_ROUTES.map((r) => ({ ...r })),
  },
  security: {
    // What to do with API keys when the system keyring is unavailable: 'session' = memory only
    // (safe default), 'file' = plain text in a 0600 file. See keystore.js.
    keyStorage: 'session',
  },
  safety: {
    allowDangerousKeys: false,
    maxActionsPerMinute: 120,
    requireApprovalForShell: true,
    requireApprovalForFileWrites: true,
  },
  // What the workspace window remembers. Turn it off and nothing new is written (what is already saved stays until deleted).
  history: {
    enabled: true,
  },
  speech: {
    speakReplies: false,       // read ALLES's answers aloud (the workspace window's speaker button)
    ttsEngine: 'auto', ttsVoice: '', ttsRate: 1, piperModel: '',
    sttEngine: 'auto', whisperBinary: '', whisperModel: '',
    sttRoute: '', sttModel: 'whisper-1',      // for sttEngine 'http': which saved provider to send the recording to (its address and key), and the model
    language: '',                              // '' = let the engine find out; otherwise a code such as 'en' or 'hi'
    // Talking to the pill. The wake word is OFF until the person turns it on: while it is on, the microphone is open and every
    // phrase is checked ON THIS COMPUTER (never sent anywhere) to hear the wake phrase; nothing is kept.
    wakeWord: false, wakePhrase: 'hey alles', wakeSensitivity: 0.6,
    speakPillReplies: true,                    // when a task was given by voice, read the result aloud
    earcon: true,                              // a short sound when ALLES starts listening
    recorder: 'auto', micSource: '',           // which recording program, and which microphone ('' = the system default)
    whisperThreads: 0, whisperPrompt: '',      // 0 = choose from the number of cores; a few words that help it spell names right
  },
  // The pill inside the GNOME top bar (the GNOME Shell extension), its widgets and its shelf. See topbar-config.js.
  topbar: DEFAULT_TOPBAR,
  code: {
    autonomy: 'ask',
    maxSteps: 60,
    lastProject: '',
  },
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v, lo, hi, fallback) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : fallback);
const int = (v, lo, hi, fallback) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(Math.max(v, lo), hi)) : fallback);
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);

const ROUTE_ID_RE = /^[a-z0-9-]{1,32}$/;
const MODEL_RE = /^[A-Za-z0-9._:\/@+-]{1,120}$/;

/**
 * A provider endpoint must be https, except for a local server (self-hosted models). Credentials inside the
 * URL, and anything unparseable, are refused: the API key is sent to this host, so a lax rule here is a
 * way to send it somewhere unintended. Empty string = "use the preset".
 */
function cleanBaseUrl(v) {
  if (typeof v !== 'string' || !v.trim()) return '';
  let u; try { u = new URL(v.trim()); } catch { return ''; }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return '';
  if (u.username || u.password) return '';
  u.hash = ''; u.search = '';
  const out = u.toString().replace(/\/+$/, '');
  return out.length <= 300 ? out : '';           // never TRUNCATE: a cut-off URL is a different address
}

function sanitizeRoute(r) {
  if (!isObj(r) || typeof r.id !== 'string' || !ROUTE_ID_RE.test(r.id)) return null;
  return {
    id: r.id,
    kind: KINDS.includes(r.kind) ? r.kind : 'custom',
    label: typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 40) : r.id,
    model: typeof r.model === 'string' && MODEL_RE.test(r.model.trim()) ? r.model.trim() : '',
    baseUrl: cleanBaseUrl(r.baseUrl),
    enabled: bool(r.enabled, true),
  };
}

function sanitizeRoutes(v) {
  if (!Array.isArray(v)) return DEFAULT_ROUTES.map((r) => ({ ...r }));   // missing / corrupt -> the defaults
  const seen = new Set(); const out = [];
  for (const item of v) {
    const r = sanitizeRoute(item);
    if (r && !seen.has(r.id)) { seen.add(r.id); out.push(r); }
    if (out.length >= MAX_ROUTES) break;
  }
  return out;                                                              // an empty list the user chose stays empty
}

// A file name or command name in a setting: no line breaks or NUL (it is passed as ONE argument, never through a shell).
const pathText = (v, fallback = '') => (typeof v === 'string' && v.length <= 500 && !/[\0\r\n]/.test(v) ? v.trim() : fallback);
const LANG_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
/** A wake phrase is a few plain words: letters, spaces, apostrophes, hyphens. Anything else (or too short/long) = the default. */
function cleanWakePhrase(v, fallback) {
  if (typeof v !== 'string') return fallback;
  const t = v.trim().replace(/\s+/g, ' ');
  return /^[\p{L}][\p{L}' -]{2,38}$/u.test(t) && t.split(' ').length <= 5 ? t : fallback;
}
const VOICE_RE = /^[A-Za-z0-9._+\-\/ ]{0,80}$/;

/** Coerce ANY value into a fully valid settings object. Never throws. */
function sanitize(raw) {
  const r = isObj(raw) ? raw : {};
  const d = isObj(r.dock) ? r.dock : {};
  const a = isObj(r.agent) ? r.agent : {};
  const s = isObj(r.safety) ? r.safety : {};
  const t = isObj(r.tray) ? r.tray : {};
  const inp = isObj(r.input) ? r.input : {};
  const pv = isObj(r.providers) ? r.providers : {};
  const sec = isObj(r.security) ? r.security : {};
  const hi = isObj(r.history) ? r.history : {};
  const sp = isObj(r.speech) ? r.speech : {};
  const co = isObj(r.code) ? r.code : {};
  const D = DEFAULTS;
  // Settings written by ALLES 0.2.x used version 1 and always persisted the
  // auto-hide default. Version 2 makes the new persistent pill the default;
  // migrate v1 installs instead of accidentally preserving that old default.
  const incomingVersion = Number.isInteger(r.version) ? r.version : 1;
  const legacyDockAutoHide = incomingVersion < 2 ? D.dock.autoHide : d.autoHide;
  return {
    version: 3,
    dock: {
      edge: EDGES.includes(d.edge) ? d.edge : D.dock.edge,
      along: num(d.along, 0, 1, D.dock.along),
      display: typeof d.display === 'string' || (typeof d.display === 'number' && Number.isFinite(d.display)) ? d.display : null,
      autoHide: bool(legacyDockAutoHide, D.dock.autoHide),
      hour12: bool(d.hour12, D.dock.hour12),
    },
    agent: {
      maxSteps: int(a.maxSteps, 1, 200, D.agent.maxSteps),
      keepImages: int(a.keepImages, 0, 10, D.agent.keepImages),
    },
    tray: {
      enabled: bool(t.enabled, D.tray.enabled),
    },
    input: {
      backend: INPUT_BACKENDS.includes(inp.backend) ? inp.backend : D.input.backend,
    },
    providers: {
      routes: sanitizeRoutes(pv.routes),
    },
    security: {
      keyStorage: sec.keyStorage === 'file' ? 'file' : 'session',
    },
    safety: {
      allowDangerousKeys: bool(s.allowDangerousKeys, D.safety.allowDangerousKeys),
      maxActionsPerMinute: int(s.maxActionsPerMinute, 1, 1000, D.safety.maxActionsPerMinute),
      requireApprovalForShell: bool(s.requireApprovalForShell, D.safety.requireApprovalForShell),
      requireApprovalForFileWrites: bool(s.requireApprovalForFileWrites, D.safety.requireApprovalForFileWrites),
    },
    history: { enabled: bool(hi.enabled, D.history.enabled) },
    speech: {
      speakReplies: bool(sp.speakReplies, D.speech.speakReplies),
      ttsEngine: TTS_ENGINES.includes(sp.ttsEngine) ? sp.ttsEngine : D.speech.ttsEngine,
      ttsVoice: typeof sp.ttsVoice === 'string' && VOICE_RE.test(sp.ttsVoice) ? sp.ttsVoice.trim() : D.speech.ttsVoice,
      ttsRate: num(sp.ttsRate, 0.5, 2, D.speech.ttsRate),
      piperModel: pathText(sp.piperModel),
      sttEngine: STT_ENGINES.includes(sp.sttEngine) ? sp.sttEngine : D.speech.sttEngine,
      whisperBinary: pathText(sp.whisperBinary),
      whisperModel: pathText(sp.whisperModel),
      sttRoute: typeof sp.sttRoute === 'string' && (sp.sttRoute === '' || ROUTE_ID_RE.test(sp.sttRoute)) ? sp.sttRoute : '',
      sttModel: typeof sp.sttModel === 'string' && MODEL_RE.test(sp.sttModel.trim()) ? sp.sttModel.trim() : D.speech.sttModel,
      language: typeof sp.language === 'string' && LANG_RE.test(sp.language.trim()) ? sp.language.trim() : '',
      wakeWord: bool(sp.wakeWord, D.speech.wakeWord),
      wakePhrase: cleanWakePhrase(sp.wakePhrase, D.speech.wakePhrase),
      wakeSensitivity: num(sp.wakeSensitivity, 0, 1, D.speech.wakeSensitivity),
      speakPillReplies: bool(sp.speakPillReplies, D.speech.speakPillReplies),
      earcon: bool(sp.earcon, D.speech.earcon),
      recorder: RECORDERS.includes(sp.recorder) ? sp.recorder : D.speech.recorder,
      micSource: typeof sp.micSource === 'string' && /^[A-Za-z0-9._:+-]{0,120}$/.test(sp.micSource) ? sp.micSource : '',
      whisperThreads: int(sp.whisperThreads, 0, 32, D.speech.whisperThreads),
      whisperPrompt: typeof sp.whisperPrompt === 'string' && sp.whisperPrompt.length <= 200 && !/[\u0000-\u001f\u007f]/.test(sp.whisperPrompt) ? sp.whisperPrompt.trim() : '',
    },
    code: {
      autonomy: CODE_AUTONOMY.includes(co.autonomy) ? co.autonomy : D.code.autonomy,
      maxSteps: int(co.maxSteps, 1, 200, D.code.maxSteps),
      lastProject: pathText(co.lastProject),
    },
    topbar: sanitizeTopbar(r.topbar),
  };
}

/** Deep-merge `patch` into `base`, then sanitize, so patches are validated too. */
function applyPatch(base, patch) {
  const merged = JSON.parse(JSON.stringify(base));
  if (isObj(patch)) {
    for (const k of ['dock', 'agent', 'tray', 'input', 'providers', 'security', 'safety', 'history', 'speech', 'code', 'topbar']) if (isObj(patch[k])) Object.assign(merged[k], patch[k]);
  }
  return sanitize(merged);
}

class SettingsStore extends EventEmitter {
  /**
   * @param {string} file  absolute path to settings.json
   * @param {{fsImpl?:object, now?:()=>number, debounceMs?:number, setTimer?:Function, clearTimer?:Function}} [opts]
   */
  constructor(file, { fsImpl = fs, now = Date.now, debounceMs = 400, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    super();
    this.file = file;
    this.fs = fsImpl;
    this.now = now;
    this.debounceMs = debounceMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.dirty = false;
    this.loadIssue = null;     // set if the file was corrupt, so the UI can tell the user
    // True when there was no settings file to read (first ever run) or it was unreadable and has been reset: the app
    // may then pick sensible starting values for things that depend on the screen. A file that merely could not be
    // READ for another reason (permissions) is NOT a first run: the person's choices may well be in it.
    this.firstRun = false;
    this.data = this._load();
  }

  _load() {
    let text;
    try {
      text = this.fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') this.firstRun = true;
      else this.loadIssue = `Could not read settings: ${e.message}`;
      return sanitize({});
    }
    try {
      return sanitize(JSON.parse(text));
    } catch (e) {
      this.firstRun = true;
      // Keep the unreadable file for the user instead of overwriting it.
      const aside = `${this.file}.corrupt-${this.now()}`;
      try { this.fs.renameSync(this.file, aside); this.loadIssue = `Settings file was unreadable; kept a copy at ${aside} and reset to defaults.`; }
      catch { this.loadIssue = 'Settings file was unreadable and could not be backed up; reset to defaults.'; }
      return sanitize({});
    }
  }

  get() { return JSON.parse(JSON.stringify(this.data)); }

  /**
   * Apply a partial update. Emits 'change' with (next, prev). Persists after a
   * short debounce so dragging (dozens of updates/second) does not hammer the disk.
   */
  update(patch) {
    const prev = this.data;
    const next = applyPatch(prev, patch);
    if (JSON.stringify(prev) === JSON.stringify(next)) return this.get();
    this.data = next;
    this.dirty = true;
    this.emit('change', JSON.parse(JSON.stringify(next)), JSON.parse(JSON.stringify(prev)));
    this._schedule();
    return this.get();
  }

  reset() { return this.update(JSON.parse(JSON.stringify(DEFAULTS))); }

  _schedule() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => { this.timer = null; this.flush(); }, this.debounceMs);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Write now. Call on quit so the last drag position is never lost. */
  flush() {
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
    if (!this.dirty) return false;
    const tmp = `${this.file}.tmp-${process.pid}`;
    try {
      this.fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      this.fs.renameSync(tmp, this.file);           // atomic replace
      this.dirty = false;
      return true;
    } catch (e) {
      try { this.fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
      this.emit('save-error', e);
      return false;
    }
  }
}

module.exports = { SettingsStore, sanitize, applyPatch, cleanBaseUrl, MODEL_RE, DEFAULTS, DEFAULT_ROUTES, EDGES, INPUT_BACKENDS, KINDS, MAX_ROUTES, TTS_ENGINES, STT_ENGINES, CODE_AUTONOMY, RECORDERS };
