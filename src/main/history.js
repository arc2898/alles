'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeAtomic } = require('./fs-atomic');
const { redact } = require('./redact');

/**
 * HistoryStore - what was said and done, kept on this computer so the workspace window can show it again.
 *
 * LAYOUT   <dir>/index.json              one small summary per session (what the History list shows)
 *          <dir>/s-<id>.jsonl            one session: a first line with its details, then one line per event
 *
 * WHY ONE FILE PER SESSION, ONE LINE PER EVENT: adding an event is an append, not a rewrite of everything said so far, and a
 * crash in the middle of a line costs that one line (a half line at the end is skipped when reading), never the session.
 *
 * PRIVACY (each has a test)
 *  - Files are private to the user (0600 in a 0700 folder).
 *  - Text is cleaned of API keys before it is written (redact.js), and no event is longer than MAX_TEXT.
 *  - `isEnabled()` is the person's switch: off means nothing new is written. Nothing already saved is touched by that.
 *  - A session id is checked against a strict pattern before it ever becomes part of a file name.
 *  - remove() and clear() really delete the files.
 */

const KINDS = ['chat', 'task', 'code'];
const EVENT_KINDS = ['user', 'assistant', 'tool', 'status', 'note'];
const MAX_SESSIONS = 300;
const MAX_EVENTS = 4000;            // one session stops recording here (and says so once)
const MAX_TEXT = 20_000;            // one event
const MAX_ARGS = 2_000;             // what a tool was asked to do
const MAX_TITLE = 80;
const ID_RE = /^[a-z0-9]{6,24}$/;
const FLUSH_MS = 400;
const VOLATILE_PREFIX = 'v';        // an id handed out while history is off: it names nothing on disk

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length <= n ? t : `${t.slice(0, n)}… [${t.length - n} more characters not kept]`; };
const oneLine = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length <= n ? t : `${t.slice(0, n - 1)}…`; };

class HistoryStore {
  /**
   * @param {object} o
   * @param {string} o.dir
   * @param {object} [o.fsImpl]
   * @param {()=>number} [o.now]
   * @param {()=>string} [o.newId]
   * @param {()=>boolean} [o.isEnabled]       the person's "remember what happens" switch
   * @param {()=>string[]} [o.secrets]        exact secrets to strip (the API keys held right now)
   * @param {Function} [o.setTimer] @param {Function} [o.clearTimer]
   */
  constructor({ dir, fsImpl = fs, now = Date.now, newId = () => crypto.randomBytes(8).toString('hex').slice(0, 12), isEnabled = () => true, secrets = () => [], setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.dir = dir; this.fs = fsImpl; this.now = now; this.newId = newId; this.isEnabled = isEnabled; this.secrets = secrets;
    this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.timer = null; this.dirty = false;
    this.index = null;            // Map id -> summary, loaded on first use
    this.counts = new Map();      // id -> events written (so the cap is checked without reading the file)
    this.loadIssue = null;
  }

  // ---------------------------------------------------------------- files

  _secrets() { try { return this.secrets() || []; } catch { return []; } }
  _file(id) { return path.join(this.dir, `s-${id}.jsonl`); }
  _indexFile() { return path.join(this.dir, 'index.json'); }
  _validId(id) { return typeof id === 'string' && ID_RE.test(id); }

  _readLines(id) {
    let text;
    try { text = this.fs.readFileSync(this._file(id), 'utf8'); } catch { return null; }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* a half line from a crash, or damage: skipped */ }
    }
    return out;
  }

  _load() {
    if (this.index) return this.index;
    this.index = new Map();
    let fromFile = null;
    try { fromFile = JSON.parse(this.fs.readFileSync(this._indexFile(), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') this.loadIssue = 'The history list could not be read; it was rebuilt from the saved sessions.'; }
    if (isObj(fromFile) && Array.isArray(fromFile.sessions)) {
      for (const s of fromFile.sessions) if (isObj(s) && this._validId(s.id)) this.index.set(s.id, this._cleanSummary(s));
    }
    // Sessions on disk that the list does not know (a crash before the list was saved, or a list that was damaged) are added back.
    let names = [];
    try { names = this.fs.readdirSync(this.dir); } catch { /* no folder yet */ }
    let added = false;
    for (const name of names) {
      const m = /^s-([a-z0-9]{6,24})\.jsonl$/.exec(name);
      if (!m || this.index.has(m[1])) continue;
      const lines = this._readLines(m[1]);
      const head = lines && lines.find((l) => l && l.t === 'meta');
      if (!head) continue;
      const events = lines.filter((l) => l && l.t === 'ev');
      const last = events[events.length - 1];
      this.index.set(m[1], this._cleanSummary({ ...head, id: m[1], updatedAt: (last && last.at) || head.createdAt, count: events.length, preview: this._previewOf(events) }));
      added = true;
    }
    if (added || this.loadIssue) this._markDirty();
    return this.index;
  }

  _cleanSummary(s) {
    return {
      id: s.id, kind: KINDS.includes(s.kind) ? s.kind : 'chat', title: oneLine(s.title, MAX_TITLE),
      project: typeof s.project === 'string' ? s.project.slice(0, 500) : '',
      createdAt: Number.isFinite(s.createdAt) ? s.createdAt : 0, updatedAt: Number.isFinite(s.updatedAt) ? s.updatedAt : 0,
      count: Number.isInteger(s.count) && s.count >= 0 ? s.count : 0, preview: oneLine(s.preview, 140),
      titled: s.titled === true,
    };
  }

  _previewOf(events) {
    const last = [...events].reverse().find((e) => e && (e.k === 'assistant' || e.k === 'user') && e.text);
    return last ? oneLine(last.text, 140) : '';
  }

  _markDirty() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = this.setTimer(() => { this.timer = null; this.flush(); }, FLUSH_MS);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Write the list now (also called when the app quits). */
  flush() {
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
    if (!this.dirty || !this.index) return;
    this.dirty = false;
    const sessions = [...this.index.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    try { writeAtomic(this.fs, this._indexFile(), JSON.stringify({ version: 1, sessions })); }
    catch (e) { this.dirty = true; this.loadIssue = `The history list could not be saved: ${e.message}`; }
  }

  // ---------------------------------------------------------------- writing

  /**
   * Start a session. Returns its id. With history off the id is a "volatile" one: it works everywhere a session id does, and
   * nothing is written for it.
   */
  create({ kind = 'chat', title = '', project = '' } = {}) {
    if (!this.isEnabled()) return `${VOLATILE_PREFIX}${crypto.randomBytes(5).toString('hex')}`;
    const index = this._load();
    let id = this.newId();
    while (!this._validId(id) || index.has(id)) id = crypto.randomBytes(8).toString('hex').slice(0, 12);
    const at = this.now();
    const sec = this._secrets();
    const summary = this._cleanSummary({ id, kind, title: redact(title, sec) || 'New conversation', project: redact(project, sec), createdAt: at, updatedAt: at, count: 0, preview: '', titled: !!title });
    const header = { t: 'meta', kind: summary.kind, title: summary.title, project: summary.project, createdAt: at, titled: summary.titled };
    try { writeAtomic(this.fs, this._file(id), `${JSON.stringify(header)}\n`); }
    catch (e) { this.loadIssue = `History could not be saved: ${e.message}`; return `${VOLATILE_PREFIX}${crypto.randomBytes(5).toString('hex')}`; }
    index.set(id, summary); this.counts.set(id, 0);
    this._prune();
    this._markDirty();
    return id;
  }

  _prune() {
    if (this.index.size <= MAX_SESSIONS) return;
    const oldest = [...this.index.values()].sort((a, b) => a.updatedAt - b.updatedAt).slice(0, this.index.size - MAX_SESSIONS);
    for (const s of oldest) this._drop(s.id);
  }

  _drop(id) {
    try { this.fs.unlinkSync(this._file(id)); } catch { /* already gone */ }
    this.index.delete(id); this.counts.delete(id);
  }

  /**
   * Add one event to a session. `ev` = { kind: 'user'|'assistant'|'tool'|'status'|'note', text, name?, args?, error? }.
   * @returns {boolean} whether it was written
   */
  append(id, ev) {
    if (!this.isEnabled() || !this._validId(id) || !isObj(ev)) return false;
    const index = this._load();
    const s = index.get(id);
    if (!s) return false;
    const k = EVENT_KINDS.includes(ev.kind) ? ev.kind : 'note';
    let n = this.counts.get(id);
    if (n === undefined) { n = s.count; this.counts.set(id, n); }
    if (n > MAX_EVENTS) return false;
    const secrets = (() => { try { return this.secrets() || []; } catch { return []; } })();
    const clean = (v, max) => clip(redact(v, secrets), max);
    const at = this.now();
    const line = { t: 'ev', at, k, text: n === MAX_EVENTS ? 'This session is long: nothing more is saved from here on.' : clean(ev.text, MAX_TEXT) };
    if (ev.name) line.name = oneLine(redact(ev.name, secrets), 60);
    if (ev.args !== undefined && ev.args !== null) { let a; try { a = typeof ev.args === 'string' ? ev.args : JSON.stringify(ev.args); } catch { a = ''; } if (a) line.args = clean(a, MAX_ARGS); }
    if (ev.error) line.error = true;
    try { this.fs.appendFileSync(this._file(id), `${JSON.stringify(line)}\n`, { mode: 0o600 }); }
    catch (e) { this.loadIssue = `History could not be saved: ${e.message}`; return false; }
    this.counts.set(id, n + 1);
    s.count = n + 1; s.updatedAt = at;
    if (k === 'user' || k === 'assistant') s.preview = oneLine(line.text, 140);
    if (k === 'user' && !s.titled && line.text.trim()) { s.title = oneLine(line.text, MAX_TITLE); s.titled = true; }
    this._markDirty();
    return true;
  }

  // ---------------------------------------------------------------- reading

  /** @returns {{meta:object, events:object[]}|null} */
  get(id) {
    if (!this._validId(id)) return null;
    const s = this._load().get(id);
    if (!s) return null;
    const lines = this._readLines(id);
    if (!lines) return null;
    const events = lines.filter((l) => l && l.t === 'ev').map((l) => ({ at: l.at, kind: l.k, text: String(l.text == null ? '' : l.text), ...(l.name ? { name: l.name } : {}), ...(l.args ? { args: l.args } : {}), ...(l.error ? { error: true } : {}) }));
    return { meta: { ...s }, events };
  }

  /**
   * The sessions, newest first. `query` finds words in the title or anywhere in what was said (not case sensitive).
   * @param {{query?:string, kind?:string, limit?:number}} [o]
   */
  list({ query = '', kind = '', limit = 100 } = {}) {
    let rows = [...this._load().values()].sort((a, b) => b.updatedAt - a.updatedAt);
    if (KINDS.includes(kind)) rows = rows.filter((r) => r.kind === kind);
    const q = String(query || '').trim().toLowerCase();
    if (q) {
      rows = rows.filter((r) => {
        if (r.title.toLowerCase().includes(q) || r.preview.toLowerCase().includes(q) || r.project.toLowerCase().includes(q)) return true;
        const lines = this._readLines(r.id) || [];
        return lines.some((l) => l && l.t === 'ev' && typeof l.text === 'string' && l.text.toLowerCase().includes(q));
      });
    }
    const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_SESSIONS) : 100;
    return rows.slice(0, n).map((r) => ({ ...r }));
  }

  rename(id, title) {
    if (!this._validId(id)) return false;
    const s = this._load().get(id);
    const t = oneLine(redact(title, this._secrets()), MAX_TITLE);
    if (!s || !t) return false;
    s.title = t; s.titled = true;
    this._markDirty();
    return true;
  }

  remove(id) {
    if (!this._validId(id) || !this._load().has(id)) return false;
    this._drop(id);
    this._markDirty();
    return true;
  }

  /** Delete every session. Returns how many. */
  clear() {
    const ids = [...this._load().keys()];
    for (const id of ids) this._drop(id);
    this._markDirty(); this.flush();
    return ids.length;
  }

  /** A session as Markdown text, for saving or sharing. */
  exportMarkdown(id) {
    const got = this.get(id);
    if (!got) return null;
    const { meta, events } = got;
    const when = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) : '');
    const out = [`# ${meta.title}`, '', `${meta.kind === 'code' ? 'Coding session' : meta.kind === 'task' ? 'Task' : 'Chat'}, ${when(meta.createdAt)}${meta.project ? `, project ${meta.project}` : ''}`, ''];
    for (const e of events) {
      if (e.kind === 'user') out.push(`**You:** ${e.text}`, '');
      else if (e.kind === 'assistant') out.push(`**ALLES:** ${e.text}`, '');
      else if (e.kind === 'tool') out.push(`> ${e.name || 'tool'}${e.args ? ` ${e.args}` : ''}${e.error ? ' (failed)' : ''}`, '>', ...String(e.text).split('\n').slice(0, 20).map((l) => `> ${l}`), '');
      else out.push(`_${e.text}_`, '');
    }
    return out.join('\n');
  }
}

module.exports = { HistoryStore, KINDS, EVENT_KINDS, MAX_SESSIONS, MAX_EVENTS, MAX_TEXT, MAX_TITLE, ID_RE };
