'use strict';
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');

/**
 * ApprovalBroker - the human-in-the-loop gate for actions the agent must not take on its own.
 *
 * request(action) -> Promise<{allow:true} | {allow:false, reason}>. Never rejects, never hangs: a question
 * the user does not answer is a NO after `timeoutMs`, and Stop answers every open question with NO.
 *
 * SAFETY PROPERTIES (each has a test):
 *  - ONE question is on screen at a time; others wait in a queue and are asked in order. The user always
 *    answers exactly what they are looking at.
 *  - respond(id, ...) only accepts the id of the question currently shown. A stale, repeated or invented id
 *    is ignored, so a late click cannot approve a different, newer action.
 *  - A command too long to read is refused outright, never shown truncated: showing the first 4000
 *    characters of a 40,000-character command would let the dangerous part hide off-screen.
 *  - The description holds the FULL text (up to that limit); the UI must not shorten it.
 */

const MAX_SHOWN = 4000;        // longest command the user is asked to approve
const PREVIEW_CHARS = 1000;    // how much of a file's content is previewed
const DEFAULT_TIMEOUT_MS = 120_000;

// Hints shown next to a command. NOT a security boundary (shell has endless ways to say anything); they
// exist so a hurried user's eye is drawn to the dangerous part. Every pattern is tested both ways.
const RISKS = [
  [/(^|[\s;&|(])(sudo|doas|pkexec)\b/, 'runs with administrator rights'],
  [/(^|[\s;&|(])rm\s+(?:-\S*\s+)*-\S*[rRf]/, 'deletes files (rm -r / -f)'],
  [/\b(?:curl|wget)\b[^\n|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/, 'downloads code and runs it'],
  [/(^|[\s;&|(])dd\s[^\n;&|]*\bof=/, 'writes raw data (dd)'],
  [/(^|[\s;&|(])(?:mkfs(?:\.\w+)?|fdisk|parted|wipefs|sfdisk)\b/, 'formats or partitions a disk'],
  [/>\s*\/dev\/(?:sd|nvme|mmcblk|hd|vd)/, 'writes to a disk device'],
  [/(^|[\s;&|(])(?:chmod|chown)\s+(?:-\S*\s+)*-\S*R/, 'changes permissions recursively'],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, 'looks like a fork bomb'],
  [/(^|[\s;&|(])(?:shutdown|reboot|poweroff|halt)\b|systemctl\s+(?:poweroff|reboot|halt|suspend)/, 'shuts down or restarts the computer'],
  [/(^|[\s;&|(])(?:ssh|scp|sftp|rsync|nc|ncat|netcat|socat)\s/, 'connects to another machine'],
  [/\.ssh\/|id_rsa|id_ed25519|\.gnupg|\.aws\/|\.git-credentials|\.netrc|keys\.json|\/etc\/shadow/, 'touches credential files'],
  [/\bgit\s+push\b[^\n;&|]*(?:--force\b|\s-f\b)/, 'force-pushes to a git remote'],
  [/(^|[\s;&|(])(?:crontab|systemctl\s+(?:enable|--user\s+enable))\b|\.bashrc|\.profile|\.config\/autostart/, 'changes what runs automatically'],
];

function riskNotes(command) {
  const c = String(command == null ? '' : command);
  return RISKS.filter(([re]) => re.test(c)).map(([, note]) => note);
}

const clip = (text, max) => { const t = String(text == null ? '' : text); return t.length <= max ? { text: t, truncated: false, total: t.length } : { text: t.slice(0, max), truncated: true, total: t.length }; };

/** What the user is shown. `body` is complete (see MAX_SHOWN); only file previews are clipped, and say so. */
function describeAction(a) {
  const tool = a && a.tool;
  if (tool === 'run_shell') {
    const c = String(a.command == null ? '' : a.command);
    return { tool, kind: 'command', title: 'Run this shell command?', target: a.cwd || null, body: c, truncated: false, total: c.length, risks: riskNotes(c), tooLong: c.length > MAX_SHOWN };
  }
  if (tool === 'write_file') {
    const p = clip(a.preview, PREVIEW_CHARS);
    return { tool, kind: 'file', title: 'Write this file?', target: a.path, body: p.text, truncated: p.truncated, total: p.total, bytes: a.bytes, risks: riskNotes(`${a.path}\n${p.text}`), tooLong: false };
  }
  if (tool === 'read_file') {
    return { tool, kind: 'read', title: 'Read a sensitive file?', target: a.path, body: '', truncated: false, total: 0, risks: ['may contain passwords or keys, and its contents will be sent to your AI provider'], tooLong: false };
  }
  // JSON.stringify(undefined) is undefined, and it throws on circular data / BigInt: neither may break the safety path.
  let raw; try { raw = JSON.stringify(a); } catch { raw = undefined; }
  return { tool: String(tool), kind: 'other', title: `Allow ${String(tool)}?`, target: null, body: String(raw === undefined ? '' : raw).slice(0, 500), truncated: false, total: 0, risks: [], tooLong: false };
}

/** Does this action need a question at all? Sensitive reads ALWAYS do; the two toggles are the user's choice. */
function needsApproval(action, safety = {}) {
  switch (action && action.tool) {
    case 'run_shell': return safety.requireApprovalForShell !== false;
    case 'write_file': return safety.requireApprovalForFileWrites !== false;
    case 'read_file': return true;
    default: return true;              // an unknown tool asks rather than assuming it is harmless
  }
}

class ApprovalBroker extends EventEmitter {
  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout, newId = () => crypto.randomBytes(8).toString('hex') } = {}) {
    super();
    this.timeoutMs = timeoutMs; this.setTimer = setTimer; this.clearTimer = clearTimer; this.newId = newId;
    this.queue = []; this.head = null;
  }

  get pending() { return this.head ? { id: this.head.id, ...this.head.desc } : null; }
  get depth() { return this.queue.length + (this.head ? 1 : 0); }

  request(action) {
    const desc = describeAction(action);
    if (desc.tooLong) {
      return Promise.resolve({ allow: false, reason: `The command is ${desc.total} characters, too long to review safely (limit ${MAX_SHOWN}). Split it into smaller steps, or save it as a script with write_file and run that.` });
    }
    return new Promise((resolve) => { this.queue.push({ id: this.newId(), desc, resolve, timer: null }); this._pump(); });
  }

  /** The user's answer. Returns true only if it was for the question currently shown. */
  respond(id, allow) {
    const h = this.head;
    if (!h || typeof id !== 'string' || h.id !== id || typeof allow !== 'boolean') return false;
    this._settle(h, allow, allow ? null : 'The user said no.');
    return true;
  }

  /** Stop / quit: every open question (shown or waiting) becomes a NO. */
  cancelAll(reason = 'Stopped.') {
    const waiting = this.queue.splice(0);
    for (const w of waiting) w.resolve({ allow: false, reason });        // never shown, so no 'resolved' event
    if (this.head) this._settle(this.head, false, reason);
  }

  _pump() {
    if (this.head || !this.queue.length) return;
    const item = this.queue.shift();
    this.head = item;
    item.timer = this.setTimer(() => { if (this.head === item) this._settle(item, false, `No answer within ${Math.round(this.timeoutMs / 1000)} seconds, so it was treated as no.`); }, this.timeoutMs);
    if (item.timer && typeof item.timer.unref === 'function') item.timer.unref();
    this.emit('request', { id: item.id, ...item.desc });
  }

  _settle(item, allow, reason) {
    if (item.timer) this.clearTimer(item.timer);
    if (this.head === item) this.head = null;
    item.resolve(allow ? { allow: true } : { allow: false, reason });
    this.emit('resolved', { id: item.id, allow, reason: reason || null, tool: item.desc.tool });
    this._pump();
  }
}

module.exports = { ApprovalBroker, describeAction, needsApproval, riskNotes, RISKS, MAX_SHOWN, PREVIEW_CHARS, DEFAULT_TIMEOUT_MS };
