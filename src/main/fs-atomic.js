'use strict';
const path = require('node:path');

/**
 * Write `text` to `file` atomically and privately: temp file (created with `mode`) -> rename.
 * A crash mid-write leaves the OLD file intact, never a half-written one, and the file is never
 * world-readable, even briefly (mode is applied at creation, not by a later chmod).
 * The directory is created 0700.
 */
function writeAtomic(fsImpl, file, text, mode = 0o600) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fsImpl.writeFileSync(tmp, text, { mode });
    fsImpl.renameSync(tmp, file);
  } catch (e) {
    try { fsImpl.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw e;
  }
}
module.exports = { writeAtomic };
