'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn: nodeSpawn } = require('node:child_process');
const { runShell } = require('../tools');
const { riskNotes } = require('../approvals');
const diff = require('./diff');
const { Project, ProjectError, MAX_FILE_BYTES } = require('./project');

/**
 * The coding area's tools: what ALLES may do to ONE project folder. No screen, no mouse, no keyboard - only files and commands,
 * and only inside the folder (project.js). Schemas are OpenAI function-calling format like the rest of ALLES.
 *
 * WHAT NEEDS A YES (the person's "autonomy" setting, code.autonomy):
 *   ask    every file change and every command
 *   edits  file changes inside the project happen by themselves; every command asks
 *   full   file changes happen by themselves; shell commands still follow the explicit Safety setting (approval is ON by default)
 *          and commands with known risk indicators always ask, regardless of that setting
 * Questions go to the ApprovalBroker like every other question in ALLES, in the same words (run_shell / write_file).
 *
 * UNDO: every file change is remembered (ChangeTracker) so the person can see exactly what changed and put a file back.
 * A command can change anything; its effects are NOT tracked, and the page says so.
 */

const fn = (name, description, properties = {}, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

const CODE_TOOL_SCHEMAS = [
  fn('list_files', 'List files and folders in the project (relative paths; folders end with /). Call this first to learn the layout.', { path: { type: 'string', description: 'folder, default "."' }, depth: { type: 'number', description: 'levels, default 2' } }),
  fn('read_file', 'Read a text file in the project. For a long file give start_line and end_line (1-based).', { path: { type: 'string' }, start_line: { type: 'number' }, end_line: { type: 'number' } }, ['path']),
  fn('search', 'Find text in the project files (plain text, not a pattern). Returns file:line: text.', { text: { type: 'string' }, path: { type: 'string', description: 'folder to search, default "."' }, ignore_case: { type: 'boolean' } }, ['text']),
  fn('write_file', 'Create a file, or replace a whole file, with the content given. For a small change to an existing file use edit_file instead.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  fn('edit_file', 'Change a file by replacing old_text with new_text. old_text must appear EXACTLY ONCE in the file (include enough surrounding lines to make it unique).', { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, ['path', 'old_text', 'new_text']),
  fn('run_command', 'Run a shell command in the project folder (tests, build, git, a formatter...). It has no keyboard, so it cannot ask questions. Output is cut if long.', { command: { type: 'string' }, cwd: { type: 'string', description: 'a folder inside the project, default the project folder' }, timeout_seconds: { type: 'number', description: 'default 120, at most 600' } }, ['command']),
  fn('finish', 'Call when the work is done (or you cannot go on), with a short summary for the user: what you changed, what you ran, what is left.', { summary: { type: 'string' } }, ['summary']),
];

const MAX_OUT = 12_000;
const clipText = (s, n = MAX_OUT) => (s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} characters; read the file in parts with start_line/end_line]` : s);

/** What was done to files, kept so it can be shown and undone. */
class ChangeTracker {
  constructor({ fsImpl = fs } = {}) { this.fs = fsImpl; this.files = new Map(); }
  /** Call BEFORE a file is changed: remembers how it was the first time only. */
  before(abs, rel) {
    if (this.files.has(rel)) return;
    let text = null; let skipped = false;
    try {
      const st = this.fs.statSync(abs);
      if (st.size > MAX_FILE_BYTES) skipped = true;
      else { const buf = this.fs.readFileSync(abs); if (buf.includes(0)) skipped = true; else text = buf.toString('utf8'); }
    } catch { text = null; }                              // did not exist
    this.files.set(rel, { abs, before: text, after: text, skipped });
  }
  /** Call AFTER the change. */
  after(rel, text) { const f = this.files.get(rel); if (f) f.after = text; }
  list() {
    const out = [];
    for (const [rel, f] of this.files) {
      if (!f.skipped && f.before === f.after) continue;     // changed and changed back
      const st = f.skipped ? { added: 0, removed: 0 } : diff.stat(f.before, f.after);
      out.push({ path: rel, status: f.after === null ? 'deleted' : f.before === null ? 'added' : 'modified', ...st, revertible: !f.skipped });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }
  diff(rel) { const f = this.files.get(rel); if (!f) return null; return f.skipped ? '(a large or binary file: its content is not shown)' : diff.unified(f.before, f.after); }
  /** Put one file back as it was. Refuses if the file has been changed by someone else since. */
  revert(rel) {
    const f = this.files.get(rel);
    if (!f) return { ok: false, error: 'That file was not changed by ALLES.' };
    if (f.skipped) return { ok: false, error: 'That file is large or binary, so ALLES did not keep a copy of it.' };
    let now = null; try { now = this.fs.readFileSync(f.abs, 'utf8'); } catch { now = null; }
    if (now !== f.after) return { ok: false, error: 'That file has been changed since (by you or a command), so it was left alone.' };
    try {
      if (f.before === null) this.fs.rmSync(f.abs, { force: true });
      else this.fs.writeFileSync(f.abs, f.before);
    } catch (e) { return { ok: false, error: e.message }; }
    this.files.delete(rel);
    return { ok: true };
  }
  revertAll() {
    const results = [...this.files.keys()].map((rel) => ({ path: rel, ...this.revert(rel) }));
    return { ok: results.every((r) => r.ok), results };
  }
  clear() { this.files.clear(); }
}

/**
 * @param {object} o
 * @param {Project} o.project
 * @param {ChangeTracker} o.tracker
 * @param {(action:object)=>Promise<boolean|{allow:boolean,reason?:string}>} o.approve   the ApprovalBroker's request
 * @param {()=>string} o.getAutonomy    'ask' | 'edits' | 'full'
 */
function createCodeExecutor({ project, tracker, approve, getAutonomy = () => 'ask', requireApprovalForShell = () => true, spawn = nodeSpawn }) {
  if (typeof approve !== 'function') approve = async () => false;           // FAIL CLOSED, as in tools/index.js
  const ask = async (action) => {
    const v = await approve(action);
    const allow = v === true || (!!v && v.allow === true);
    const reason = v && typeof v === 'object' && v.reason ? String(v.reason) : '';
    return { allow, text: allow ? '' : `DENIED${reason ? `: ${reason}` : ' by the user.'} Do not retry the same action; ask the user what to do instead.` };
  };
  const autonomy = () => { const a = getAutonomy(); return a === 'edits' || a === 'full' ? a : 'ask'; };

  const readText = (abs) => {
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new ProjectError('That is not a file.');
    if (st.size > MAX_FILE_BYTES) throw new ProjectError(`That file is ${st.size} bytes, too large to read whole.`);
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) throw new ProjectError('That looks like a binary file.');
    return buf.toString('utf8');
  };

  /** Ask if this file change needs a yes; returns {allow, text}. */
  const approveChange = async (rel, abs, newText, previewText) => {
    const sensitive = project.isSensitive(rel);
    if (!sensitive && autonomy() !== 'ask') return { allow: true, text: '' };
    return ask({ tool: 'write_file', path: abs, bytes: Buffer.byteLength(newText), preview: previewText, ...(sensitive ? { sensitive: true } : {}) });
  };

  const commit = (rel, abs, text) => {
    tracker.before(abs, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    tracker.after(rel, text);
  };

  const handlers = {
    async list_files({ path: p = '.', depth }) {
      const d = depth != null && Number.isFinite(Number(depth)) ? Math.min(Math.max(Math.round(Number(depth)), 1), 5) : 2;
      const { entries, truncated } = project.list(p, { depth: d });
      return { text: entries.length ? `${entries.join('\n')}${truncated ? '\n…(more not shown: list a subfolder)' : ''}` : '(empty)' };
    },
    async read_file({ path: p, start_line, end_line }) {
      const { abs, rel } = project.resolve(p);
      if (project.isSensitive(rel)) { const v = await ask({ tool: 'read_file', path: abs, sensitive: true }); if (!v.allow) return { text: v.text }; }
      const text = readText(abs);
      const all = text.split('\n');
      const a = start_line != null && Number.isFinite(Number(start_line)) ? Math.max(1, Math.round(Number(start_line))) : 1;
      const b = end_line != null && Number.isFinite(Number(end_line)) ? Math.min(all.length, Math.round(Number(end_line))) : all.length;
      if (a > b) throw new ProjectError(`start_line ${a} is after end_line ${b} (the file has ${all.length} lines).`);
      const body = all.slice(a - 1, b).join('\n');
      const ranged = a !== 1 || b !== all.length;
      return { text: clipText(`${ranged ? `[lines ${a}-${b} of ${all.length}]\n` : ''}${body}`) };
    },
    async search({ text, path: p = '.', ignore_case }) {
      if (typeof text !== 'string' || !text) throw new ProjectError('text is required.');
      const ic = ignore_case === true || ignore_case === 'true';
      const needle = ic ? text.toLowerCase() : text;
      const hits = []; let scanned = 0;
      for (const file of project.files(p)) {
        if (hits.length >= 80 || scanned >= 4000) break;
        let content;
        try { const st = fs.statSync(file); if (st.size > MAX_FILE_BYTES) continue; const buf = fs.readFileSync(file); if (buf.includes(0)) continue; content = buf.toString('utf8'); } catch { continue; }
        scanned++;
        const rows = content.split('\n');
        for (let i = 0; i < rows.length && hits.length < 80; i++) {
          if ((ic ? rows[i].toLowerCase() : rows[i]).includes(needle)) hits.push(`${path.relative(project.root, file)}:${i + 1}: ${rows[i].trim().slice(0, 200)}`);
        }
      }
      return { text: hits.length ? `${hits.join('\n')}${hits.length >= 80 ? '\n…(first 80 matches)' : ''}` : 'No matches.' };
    },
    async write_file({ path: p, content }) {
      if (typeof content !== 'string') throw new ProjectError('content must be text.');
      const { abs, rel } = project.resolve(p, { write: true });
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) throw new ProjectError('That is a folder.');
      const v = await approveChange(rel, abs, content, content.slice(0, 1000));
      if (!v.allow) return { text: v.text };
      commit(rel, abs, content);
      return { text: `Wrote ${Buffer.byteLength(content)} bytes to ${rel}` };
    },
    async edit_file({ path: p, old_text, new_text }) {
      if (typeof old_text !== 'string' || !old_text) throw new ProjectError('old_text is required (the exact text to replace).');
      if (typeof new_text !== 'string') throw new ProjectError('new_text must be text (it may be empty to delete old_text).');
      const { abs, rel } = project.resolve(p, { write: true });
      const text = readText(abs);
      const at = text.indexOf(old_text);
      if (at < 0) throw new ProjectError(`old_text was not found in ${rel}. Read the file again and copy the text exactly, including spaces and line breaks.`);
      if (text.indexOf(old_text, at + 1) >= 0) throw new ProjectError(`old_text appears more than once in ${rel}. Include more surrounding lines so it matches only one place.`);
      const next = text.slice(0, at) + new_text + text.slice(at + old_text.length);
      const preview = diff.unified(text, next, { maxLines: 40 });
      const v = await approveChange(rel, abs, next, preview);
      if (!v.allow) return { text: v.text };
      commit(rel, abs, next);
      const { added, removed } = diff.stat(text, next);
      return { text: `Edited ${rel} (+${added} -${removed})` };
    },
    async run_command({ command, cwd, timeout_seconds }, { signal } = {}) {
      if (typeof command !== 'string' || !command.trim()) throw new ProjectError('command is required.');
      const where = cwd ? project.resolve(cwd).abs : project.root;
      const risky = riskNotes(command).length > 0;
      if (autonomy() !== 'full' || requireApprovalForShell() || risky) {
        const v = await ask({ tool: 'run_shell', command, cwd: where });
        if (!v.allow) return { text: v.text };
      }
      const t = Number(timeout_seconds);
      const timeoutMs = Math.min(timeout_seconds != null && Number.isFinite(t) && t > 0 ? t : 120, 600) * 1000;   // null, 0, negative or junk = the default
      return { text: await runShell(command, where, { spawn, signal, timeoutMs }) };
    },
    async finish({ summary }) {
      const said = typeof summary === 'string' ? summary.trim() : (summary == null ? '' : JSON.stringify(summary));
      return { text: said || 'Done.', done: true };
    },
  };

  return async function executeTool(name, args, { signal = null } = {}) {
    const h = typeof name === 'string' && Object.prototype.hasOwnProperty.call(handlers, name) ? handlers[name] : null;
    if (!h) return { text: `Unknown tool "${String(name).slice(0, 60)}". Available: ${Object.keys(handlers).join(', ')}`, error: true };
    if (args && typeof args.__parseError === 'string') return { text: `Your arguments were not valid JSON, so nothing was done (you sent: ${String(args.__parseError).slice(0, 300)}). Send them again as ONE JSON object.`, error: true };
    try { return await h(args || {}, { signal }); }
    catch (e) { return { text: `Error: ${e && e.message ? e.message : e}`, error: true }; }
  };
}

module.exports = { CODE_TOOL_SCHEMAS, createCodeExecutor, ChangeTracker, Project, ProjectError, MAX_FILE_BYTES };
