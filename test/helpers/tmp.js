'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Temporary directories for tests, removed again when the test file's process ends.
 *
 * Before this existed every run of `npm test` left a few hundred folders in the system temp directory (some holding
 * test key files). `node --test` runs each test file in its own process, so one exit hook per process covers it.
 */
const made = [];

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

function removeAll() {
  while (made.length) {
    try { fs.rmSync(made.pop(), { recursive: true, force: true }); } catch { /* already gone */ }
  }
}

process.on('exit', removeAll);

module.exports = { tmpDir, removeAll };
