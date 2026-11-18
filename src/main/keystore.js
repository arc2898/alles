'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { writeAtomic } = require('./fs-atomic');

/**
 * KeyStore - where provider API keys live. NEVER settings.json (that file is meant to be readable
 * and shareable).
 *
 * THREE MODES, chosen by what the machine can actually do (measured in real Electron):
 *   keyring : Electron safeStorage is usable and backed by a real password manager
 *             (gnome-libsecret / kwallet). Each key is encrypted; the file holds only ciphertext.
 *   file    : NO keyring, and the user opted in (settings: security.keyStorage = 'file').
 *             Keys are saved as PLAIN TEXT in a 0600 file. Said so, in the UI, in those words.
 *   session : NO keyring, no opt-in (the default). Keys live in memory only and vanish on quit.
 *
 * Why not just call safeStorage.setUsePlainTextEncryption(true)? Measured: with no keyring on
 * GNOME it does NOTHING (still "not available"), and on other setups it yields an obfuscation
 * with a hard-coded key that looks like encryption but is not. We refuse to dress that up.
 *
 * Nothing here ever returns a secret except secrets(), which is for the main process only.
 * list() is what the UI gets: ids, hints, flags.
 */

const KEY_RE = /^[\x21-\x7E]{8,512}$/;      // visible ASCII, no spaces / line breaks (also blocks header injection)
const ROUTE_ID_RE = /^[a-z0-9-]{1,32}$/;
const ENTRY_ID_RE = /^[a-f0-9]{4,32}$/;
const MAX_KEYS_PER_ROUTE = 20;

class KeyStoreError extends Error {
  constructor(code, message) { super(message); this.name = 'KeyStoreError'; this.code = code; }
}

/** "nvap…abc". For prefixed keys the first 4 characters are the prefix, so little is revealed. */
const hintOf = (k) => (k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-3)}` : '****');

class KeyStore extends EventEmitter {
  /**
   * @param {string} file
   * @param {object} [o]
   * @param {object} [o.safeStorage]         Electron's safeStorage (or a fake)
   * @param {()=>('session'|'file')} [o.getPolicy]   what to do when no keyring exists
   */
  constructor(file, { safeStorage = null, getPolicy = () => 'session', fsImpl = fs, now = Date.now, newId = () => crypto.randomBytes(6).toString('hex') } = {}) {
    super();
    this.file = file; this.safeStorage = safeStorage; this.getPolicy = getPolicy;
    this.fs = fsImpl; this.now = now; this.newId = newId;
    this.mem = new Map();            // session-only keys: routeId -> [{id, secret, hint, addedAt}]
    this.loadIssue = null;
    this.data = this._load();
  }

  // ---------------------------------------------------------------- mode

  _enc() {
    const s = this.safeStorage;
    let available = false, backend = null;
    if (s) {
      try { available = !!s.isEncryptionAvailable(); } catch { /* treated as unavailable */ }
      try { if (typeof s.getSelectedStorageBackend === 'function') backend = s.getSelectedStorageBackend(); } catch { /* macOS/Windows have none */ }
    }
    return { available, backend };
  }

  mode() {
    const e = this._enc();
    if (e.available && e.backend !== 'basic_text') return 'keyring';
    return this.getPolicy() === 'file' ? 'file' : 'session';
  }

  status() {
    const e = this._enc(); const mode = this.mode();
    const summary = {
      keyring: `Keys are encrypted with your system keyring${e.backend ? ` (${e.backend})` : ''}.`,
      file: 'No system keyring is available. Keys are saved as PLAIN TEXT in a file only your user can read.',
      session: 'No system keyring is available, so keys are kept in memory only and must be re-entered each time ALLES starts.',
    }[mode];
    return { mode, backend: e.backend, encryptionAvailable: e.available, persistent: mode !== 'session', summary, loadIssue: this.loadIssue };
  }

  // ---------------------------------------------------------------- load / save

  _load() {
    const empty = () => ({ version: 1, routes: {} });
    let text;
    try { text = this.fs.readFileSync(this.file, 'utf8'); }
    catch (e) { if (e.code !== 'ENOENT') this.loadIssue = `Could not read the key file: ${e.message}`; return empty(); }

    let raw;
    try { raw = JSON.parse(text); }
    catch {
      const aside = `${this.file}.corrupt-${this.now()}`;
      try { this.fs.renameSync(this.file, aside); this.loadIssue = `The key file was unreadable; a copy was kept at ${aside}. Please re-enter your keys.`; }
      catch { this.loadIssue = 'The key file was unreadable and could not be backed up. Please re-enter your keys.'; }
      return empty();
    }

    const routes = {}; let dropped = 0;
    const src = raw && typeof raw.routes === 'object' && raw.routes && !Array.isArray(raw.routes) ? raw.routes : {};
    for (const [rid, list] of Object.entries(src)) {
      if (!ROUTE_ID_RE.test(rid) || !Array.isArray(list)) { dropped++; continue; }
      const seen = new Set(), out = [];
      for (const e of list.slice(0, MAX_KEYS_PER_ROUTE)) {
        const ok = e && typeof e === 'object' && typeof e.id === 'string' && ENTRY_ID_RE.test(e.id) && !seen.has(e.id)
          && (e.format === 'enc' || e.format === 'plain') && typeof e.data === 'string' && e.data.length > 0 && e.data.length < 4096;
        if (!ok) { dropped++; continue; }
        seen.add(e.id);
        out.push({ id: e.id, format: e.format, data: e.data, hint: typeof e.hint === 'string' ? e.hint.slice(0, 16) : '****', addedAt: Number.isFinite(e.addedAt) ? e.addedAt : 0 });
      }
      if (out.length) routes[rid] = out;
    }
    if (dropped) this.loadIssue = `${dropped} malformed key entr${dropped === 1 ? 'y was' : 'ies were'} ignored.`;
    return { version: 1, routes };
  }

  _save() { writeAtomic(this.fs, this.file, JSON.stringify(this.data, null, 2), 0o600); }

  _decrypt(entry) {
    if (entry.format === 'plain') return entry.data;
    const s = this.safeStorage;
    if (!s) return null;
    try { return s.isEncryptionAvailable() ? s.decryptString(Buffer.from(entry.data, 'base64')) : null; }
    catch { return null; }                         // keyring locked / changed: unreadable, not fatal
  }

  // ---------------------------------------------------------------- read (UI-safe)

  /** What the UI may see: never a secret. */
  list(routeId) {
    const out = [];
    for (const e of this.data.routes[routeId] || []) out.push({ id: e.id, hint: e.hint, addedAt: e.addedAt, persisted: true, readable: this._decrypt(e) !== null });
    for (const e of this.mem.get(routeId) || []) out.push({ id: e.id, hint: e.hint, addedAt: e.addedAt, persisted: false, readable: true });
    return out;
  }

  /** Decrypted keys for building the router. MAIN PROCESS ONLY. Unreadable entries are skipped. */
  secrets(routeId) {
    const out = [];
    for (const e of this.data.routes[routeId] || []) { const s = this._decrypt(e); if (s !== null) out.push(s); }
    for (const e of this.mem.get(routeId) || []) out.push(e.secret);
    return out;
  }

  /**
   * Decrypt exactly ONE key by its id, or null if it does not exist or cannot currently be decrypted.
   * MAIN PROCESS ONLY. This exists so a caller that has a specific key id from list() (e.g. "test this
   * key") can fetch that exact secret without index-pairing against secrets() - list() includes every
   * entry while secrets() SKIPS unreadable ones, so the two arrays are not index-aligned when any key
   * is unreadable, and pairing them by position silently returns the wrong secret.
   */
  secretById(routeId, keyId) {
    for (const e of this.data.routes[routeId] || []) if (e.id === keyId) return this._decrypt(e);
    for (const e of this.mem.get(routeId) || []) if (e.id === keyId) return e.secret;
    return null;
  }

  // ---------------------------------------------------------------- write

  add(routeId, secret) {
    if (typeof routeId !== 'string' || !ROUTE_ID_RE.test(routeId)) throw new KeyStoreError('invalid-route', 'Invalid provider id.');
    const key = typeof secret === 'string' ? secret.trim() : '';
    if (!KEY_RE.test(key)) throw new KeyStoreError('invalid-key', 'That does not look like an API key. Keys are 8 to 512 visible characters with no spaces or line breaks.');
    if (this.list(routeId).length >= MAX_KEYS_PER_ROUTE) throw new KeyStoreError('too-many', `At most ${MAX_KEYS_PER_ROUTE} keys per provider.`);
    if (this.secrets(routeId).includes(key)) throw new KeyStoreError('duplicate', 'That key is already added.');

    const mode = this.mode(); const id = this.newId(); const hint = hintOf(key); const addedAt = this.now();
    if (mode === 'session') {
      if (!this.mem.has(routeId)) this.mem.set(routeId, []);
      this.mem.get(routeId).push({ id, secret: key, hint, addedAt });
    } else {
      const entry = mode === 'keyring'
        ? { id, format: 'enc', data: this.safeStorage.encryptString(key).toString('base64'), hint, addedAt }
        : { id, format: 'plain', data: key, hint, addedAt };
      const list = this.data.routes[routeId] || (this.data.routes[routeId] = []);
      list.push(entry);
      try { this._save(); }
      catch (e) {                                   // do not keep a key that was not saved
        list.pop(); if (!list.length) delete this.data.routes[routeId];
        throw new KeyStoreError('save-failed', `Could not save the key: ${e.message}`);
      }
    }
    this.emit('change', routeId);
    return { id, hint, mode };
  }

  remove(routeId, keyId) {
    let removed = false;
    const list = this.data.routes[routeId];
    if (list) {
      const i = list.findIndex((e) => e.id === keyId);
      if (i >= 0) {
        const [gone] = list.splice(i, 1);
        if (!list.length) delete this.data.routes[routeId];
        try { this._save(); } catch (e) { (this.data.routes[routeId] || (this.data.routes[routeId] = [])).splice(i, 0, gone); throw new KeyStoreError('save-failed', `Could not save: ${e.message}`); }
        removed = true;
      }
    }
    const m = this.mem.get(routeId);
    if (m) { const i = m.findIndex((e) => e.id === keyId); if (i >= 0) { m.splice(i, 1); removed = true; if (!m.length) this.mem.delete(routeId); } }
    if (removed) this.emit('change', routeId);
    return removed;
  }

  removeRoute(routeId) {
    const persisted = Object.prototype.hasOwnProperty.call(this.data.routes, routeId);
    const inMemory = this.mem.has(routeId);
    if (!persisted && !inMemory) return false;

    // Persist the removal before discarding the in-memory copy. If the write fails, restore the exact
    // previous route so settings, disk and the live provider router cannot disagree.
    if (persisted) {
      const previous = this.data.routes[routeId];
      delete this.data.routes[routeId];
      try { this._save(); }
      catch (e) {
        this.data.routes[routeId] = previous;
        throw new KeyStoreError('save-failed', `Could not save: ${e.message}`);
      }
    }
    this.mem.delete(routeId);
    this.emit('change', routeId);
    return true;
  }

  /** After the user opts in to file storage (or a keyring appears): persist keys held only in memory. */
  migrateSession() {
    if (this.mode() === 'session') return 0;
    let n = 0;
    for (const [routeId, list] of [...this.mem]) {
      for (const e of list) {
        try { this.mem.get(routeId).splice(this.mem.get(routeId).indexOf(e), 1); this.add(routeId, e.secret); n++; }
        catch { (this.mem.get(routeId) || this.mem.set(routeId, []).get(routeId)).push(e); }
      }
      if (this.mem.get(routeId) && !this.mem.get(routeId).length) this.mem.delete(routeId);
    }
    return n;
  }
}

module.exports = { KeyStore, KeyStoreError, hintOf, KEY_RE, MAX_KEYS_PER_ROUTE };