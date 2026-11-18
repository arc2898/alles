'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** The full path of a program, or null. A name with a slash is checked as it is; a bare name is looked for on PATH. Never runs it. */
function findExecutable(name, { env = process.env, fsImpl = fs } = {}) {
  if (typeof name !== 'string' || !name || /[\0\r\n]/.test(name)) return null;
  const ok = (p) => { try { fsImpl.accessSync(p, fs.constants.X_OK); return !fsImpl.statSync(p).isDirectory(); } catch { return false; } };
  if (name.includes('/')) return ok(name) ? name : null;
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    if (ok(p)) return p;
  }
  return null;
}
module.exports = { findExecutable };
