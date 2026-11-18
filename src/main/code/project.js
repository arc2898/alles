'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeIsSensitive, SENSITIVE_NAME } = require('../sensitive');

/**
 * Project - the one folder the coding area may touch, and the walls around it.
 *
 * Every path the model gives is turned into a real path HERE, and refused unless it is inside the folder after `..` is collapsed
 * AND after symbolic links are followed (a link inside the project that points at ~/.ssh must not be a way out). The check looks at
 * the nearest part of the path that exists, so a file that is about to be created is judged by the folder it will be created in.
 *
 *  - writes never go into a `.git` folder (a hook there runs code the next time git is used)
 *  - the folder itself may not be the whole disk, the home folder, or somewhere ALLES keeps secrets
 *  - names that usually hold secrets (.env, *.pem, id_rsa ...) are "sensitive": reading or writing them always asks
 */

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.cache', '.next', '.nuxt', 'dist', 'build', 'target', 'coverage', '.idea', '.gradle', '.tox']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

class ProjectError extends Error { constructor(message) { super(message); this.name = 'ProjectError'; } }

const within = (target, root) => target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

class Project {
  /** @param {string} root  an existing folder. Throws ProjectError (in plain words) if it is not acceptable. */
  constructor(root, { fsImpl = fs, home = os.homedir(), isSensitivePath = makeIsSensitive({ home }) } = {}) {
    this.fs = fsImpl;
    if (typeof root !== 'string' || !root || /\0/.test(root) || !path.isAbsolute(root)) throw new ProjectError('Choose a folder (a full path).');
    let real;
    try { real = fsImpl.realpathSync(root); } catch { throw new ProjectError('That folder does not exist.'); }
    let stat; try { stat = fsImpl.statSync(real); } catch { throw new ProjectError('That folder cannot be read.'); }
    if (!stat.isDirectory()) throw new ProjectError('That is a file, not a folder.');
    let realHome = home; try { realHome = fsImpl.realpathSync(home); } catch { /* keep as given */ }
    if (real === path.parse(real).root) throw new ProjectError('Choose a project folder, not the whole disk.');
    if (real === realHome || within(realHome, real)) throw new ProjectError('Choose a folder inside your home folder (a project), not the home folder itself or something that contains it.');
    if (isSensitivePath(real)) throw new ProjectError('That folder holds credentials or ALLES\'s own settings. Choose a project folder.');
    this.root = real;
    this.name = path.basename(real);
    this.isSensitivePath = isSensitivePath;
  }

  /** The nearest existing ancestor (or the path itself) as a real path: where the path REALLY is, links followed. */
  _realNearest(abs) {
    let cur = abs; const rest = [];
    for (let i = 0; i < 128; i++) {
      try { return path.join(this.fs.realpathSync(cur), ...rest.reverse()); }
      catch (e) {
        if (e && e.code === 'ELOOP') throw new ProjectError('A link loop was found in that path.');
        const parent = path.dirname(cur);
        if (parent === cur) return abs;
        rest.push(path.basename(cur)); cur = parent;
      }
    }
    throw new ProjectError('That path is too deep.');
  }

  /**
   * @param {string} p  relative to the project (an absolute path inside it is accepted too)
   * @returns {{abs:string, rel:string}}
   */
  resolve(p, { write = false } = {}) {
    if (typeof p !== 'string' || !p.trim()) throw new ProjectError('A path is required.');
    if (/\0/.test(p)) throw new ProjectError('That path is not valid.');
    const given = p.trim();
    const abs = path.resolve(this.root, given.startsWith('~') ? given.replace(/^~/, '/__no_home__') : given);   // "~" does not mean the home folder here
    if (!within(abs, this.root)) throw new ProjectError(`"${given}" is outside the project folder. Only files inside ${this.root} can be used.`);
    const real = this._realNearest(abs);
    if (!within(real, this.root)) throw new ProjectError(`"${given}" leads outside the project folder through a link. Only files inside the project can be used.`);
    const rel = path.relative(this.root, abs) || '.';
    // The REAL location counts too: a link called "hooks" that points at .git/hooks must not be a way around this rule.
    const relReal = path.relative(this.root, real) || '.';
    const isGit = (r) => r.split(path.sep).some((seg) => seg.toLowerCase() === '.git');
    if (write && (isGit(rel) || isGit(relReal))) throw new ProjectError('Changing the inside of a .git folder is not allowed (use git commands).');
    return { abs, rel };
  }

  /** Judged by the name given AND by where a link really leads (a link called notes.txt that points at .env is still .env). */
  isSensitive(rel) {
    const abs = path.join(this.root, rel);
    let real = abs; try { real = this._realNearest(abs); } catch { /* a loop: judged by its name */ }
    return SENSITIVE_NAME.test(path.basename(rel)) || SENSITIVE_NAME.test(path.basename(real)) || this.isSensitivePath(abs) || this.isSensitivePath(real);
  }

  /** Files and folders below `rel`, as relative paths (folders end with /), skipping the usual clutter. Capped. */
  list(rel = '.', { depth = 2, max = 300 } = {}) {
    const start = this.resolve(rel).abs;
    const out = []; let truncated = false;
    const walk = (dir, d) => {
      let entries;
      try { entries = this.fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      entries.sort((x, y) => (x.isDirectory() === y.isDirectory() ? x.name.localeCompare(y.name) : x.isDirectory() ? -1 : 1));
      for (const e of entries) {
        if (out.length >= max) { truncated = true; return; }
        if (e.isSymbolicLink()) continue;                      // never walk through a link
        const full = path.join(dir, e.name);
        const r = path.relative(this.root, full);
        if (e.isDirectory()) {
          out.push(`${r}/`);
          if (!IGNORED_DIRS.has(e.name) && d < depth) walk(full, d + 1);
        } else out.push(r);
      }
    };
    walk(start, 1);
    return { entries: out, truncated };
  }

  /** Text files below `rel` (not ignored, not linked, under the size limit), for searching. */
  *files(rel = '.') {
    const start = this.resolve(rel).abs;
    const stack = [start];
    while (stack.length) {
      const dir = stack.pop();
      let entries; try { entries = this.fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.isSymbolicLink()) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!IGNORED_DIRS.has(e.name)) stack.push(full); continue; }
        if (SENSITIVE_NAME.test(e.name)) continue;
        yield full;
      }
    }
  }
}

module.exports = { Project, ProjectError, IGNORED_DIRS, SENSITIVE_NAME, MAX_FILE_BYTES };
