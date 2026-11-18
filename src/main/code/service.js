'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { writeAtomic } = require('../fs-atomic');
const { Agent } = require('../agent');
const { TaskRunner } = require('../runner');
const { codePrompt } = require('../identity');
const { Project, ProjectError, ChangeTracker, CODE_TOOL_SCHEMAS, createCodeExecutor, MAX_FILE_BYTES } = require('./tools');

/**
 * CodeService - the coding area: one project folder, one session at a time, ALLES working in it by itself.
 *
 * It owns the pieces that belong together: the walled project (project.js), what was changed (ChangeTracker), a TaskRunner that
 * runs the agent with the coding tools only, and what to remember about it in History. It tells the window what is going on
 * through ONE event, 'event', whose payload has a `type`:
 *   status {state, detail}   message {text}   tool {name, args, text, error}   finished {ok, summary}   changes {changes}
 * and the window asks it for the rest (the file tree, a diff, undo).
 *
 * A later request in the same session is told what was asked and done before it, and which files were changed, so
 * "now add a test for that" works. Opening another folder starts a new session (the old one stays in History).
 */

const MAX_TASK = 12_000;
const KEEP_TURNS = 5;
const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length <= n ? t : `${t.slice(0, n)}…`; };

class CodeService extends EventEmitter {
  /**
   * @param {object} o
   * @param {()=>{chat:Function}} o.createRouter     a router with today's providers and keys
   * @param {{request:Function, cancelAll:Function}} o.broker
   * @param {()=>object} o.getSettings               the whole settings object
   * @param {import('../history').HistoryStore} o.history
   * @param {()=>boolean} [o.canStart]               false while something else (the pill's task) is using ALLES
   */
  constructor({ createRouter, broker, getSettings, history, canStart = () => true, makeProject = (root) => new Project(root) }) {
    super();
    this.createRouter = createRouter; this.broker = broker; this.getSettings = getSettings; this.history = history; this.canStart = canStart; this.makeProject = makeProject;
    this.project = null; this.tracker = null; this.sessionId = null; this.turns = [];
    this.runner = new TaskRunner({
      createAgent: () => this._createAgent(),
      onStop: () => this.broker.cancelAll('Stopped by the user.'),
      maxTaskChars: MAX_TASK, contextWindowMs: -1,
    });
    for (const ev of ['status', 'message', 'tool']) this.runner.on(ev, (p) => this._onRunnerEvent(ev, p));
  }

  get busy() { return this.runner.busy; }
  get info() { return this.project ? { name: this.project.name, root: this.project.root, sessionId: this.sessionId, busy: this.busy } : null; }

  /** Open a project folder. Not while a task is running. */
  open(root) {
    if (this.busy) return { ok: false, error: 'Stop the running task first.' };
    let project;
    try { project = this.makeProject(root); }
    catch (e) { return { ok: false, error: e instanceof ProjectError ? e.message : `That folder cannot be used: ${e.message}` }; }
    this.project = project; this.tracker = new ChangeTracker(); this.sessionId = null; this.turns = [];
    return { ok: true, project: this.info, tree: this.tree() };
  }

  close() { if (!this.busy) { this.project = null; this.tracker = null; this.sessionId = null; this.turns = []; } }

  tree() { return this.project ? this.project.list('.', { depth: 2, max: 200 }) : { entries: [], truncated: false }; }

  /** Read a project file for the user's built-in editor. Sensitive files stay outside the editor. */
  readFile(relativePath) {
    if (!this.project) return { ok: false, error: 'Choose a project folder first.' };
    if (this.busy) return { ok: false, error: 'Stop the coding task before opening a file.' };
    try {
      const resolved = this.project.resolve(relativePath);
      const abs = fs.realpathSync(resolved.abs);
      const rel = path.relative(this.project.root, abs) || resolved.rel;
      if (this.project.isSensitive(rel)) return { ok: false, error: 'This file is classified as sensitive and cannot be opened in the editor.' };
      const stat = fs.statSync(abs);
      if (!stat.isFile()) return { ok: false, error: 'That path is not a file.' };
      if (stat.size > MAX_FILE_BYTES) return { ok: false, error: `This file is larger than the ${MAX_FILE_BYTES / 1024 / 1024} MB editor limit.` };
      const bytes = fs.readFileSync(abs);
      if (bytes.includes(0)) return { ok: false, error: 'This looks like a binary file and cannot be opened in the text editor.' };
      return { ok: true, path: rel, content: bytes.toString('utf8'), hash: crypto.createHash('sha256').update(bytes).digest('hex') };
    } catch (e) { return { ok: false, error: e instanceof ProjectError ? e.message : `Could not open the file: ${e.message}` }; }
  }

  /** Save a user-edited file atomically and add it to the same change/undo ledger as agent edits. */
  writeFile(relativePath, content, expectedHash) {
    if (!this.project || !this.tracker) return { ok: false, error: 'Choose a project folder first.' };
    if (this.busy) return { ok: false, error: 'Stop the coding task before saving a file.' };
    if (typeof content !== 'string') return { ok: false, error: 'File content must be text.' };
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) return { ok: false, error: `The editor limit is ${MAX_FILE_BYTES / 1024 / 1024} MB per file.` };
    if (content.includes('\0')) return { ok: false, error: 'NUL characters are not allowed in text files.' };
    try {
      const resolved = this.project.resolve(relativePath, { write: true });
      const abs = fs.realpathSync(resolved.abs);
      const rel = path.relative(this.project.root, abs) || resolved.rel;
      if (this.project.isSensitive(rel)) return { ok: false, error: 'Sensitive files cannot be saved through the editor.' };
      const stat = fs.statSync(abs);
      if (!stat.isFile()) return { ok: false, error: 'That path is not a file.' };
      if (stat.size > MAX_FILE_BYTES) return { ok: false, error: `This file is larger than the ${MAX_FILE_BYTES / 1024 / 1024} MB editor limit.` };
      if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) return { ok: false, error: 'The editor file version is missing. Reload the file before saving.' };
      const current = fs.readFileSync(abs);
      if (current.includes(0)) return { ok: false, error: 'This file is binary and cannot be saved from the text editor.' };
      const currentHash = crypto.createHash('sha256').update(current).digest('hex');
      if (currentHash !== expectedHash) return { ok: false, conflict: true, error: 'This file changed on disk after you opened it. Reload it before saving so you do not overwrite someone else’s changes.' };
      this.tracker.before(abs, rel);
      writeAtomic(fs, abs, content, stat.mode & 0o777);
      this.tracker.after(rel, content);
      const changes = this.tracker.list();
      const hash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
      this.emit('event', { type: 'changes', changes });
      return { ok: true, path: rel, changes, hash };
    } catch (e) { return { ok: false, error: e instanceof ProjectError ? e.message : `Could not save the file: ${e.message}` }; }
  }

  _createAgent() {
    const s = this.getSettings();
    const project = this.project;
    const executeTool = createCodeExecutor({
      project, tracker: this.tracker,
      getAutonomy: () => this.getSettings().code.autonomy,
      requireApprovalForShell: () => !this.getSettings().safety || this.getSettings().safety.requireApprovalForShell !== false,
      approve: (action) => this.broker.request(action),
    });
    const tree = this.tree().entries.slice(0, 60).join('\n');
    return new Agent({
      router: this.createRouter(), executeTool, tools: CODE_TOOL_SCHEMAS,
      maxSteps: s.code.maxSteps, keepImages: 0,
      systemPrompt: codePrompt({ project: project.name, root: project.root, tree }),
    });
  }

  _taskText(task) {
    const parts = [];
    if (this.turns.length) {
      parts.push('Earlier in this session:');
      this.turns.slice(-KEEP_TURNS).forEach((t, i) => parts.push(`${i + 1}. You were asked: "${clip(t.task, 300)}" and reported: "${clip(t.summary, 400)}"`));
      const changed = this.tracker.list().map((c) => c.path);
      if (changed.length) parts.push(`Files changed so far: ${changed.slice(0, 30).join(', ')}.`);
      parts.push('', `New request: ${task}`);
    } else parts.push(task);
    return parts.join('\n');
  }

  /** @returns {Promise<{ok:boolean, summary:string}>}  validation problems come back as {ok:false, summary} too */
  async submit(text) {
    if (!this.project) return { ok: false, summary: 'Choose a project folder first.' };
    if (!this.canStart()) return { ok: false, summary: 'ALLES is busy with a task from the pill. Wait for it, or stop it first.' };
    const task = typeof text === 'string' ? text.trim() : '';
    if (!task) return { ok: false, summary: 'Write what you want done in this project.' };
    if (task.length > MAX_TASK) return { ok: false, summary: `That request is ${task.length} characters; the limit is ${MAX_TASK}.` };
    if (this.busy) return { ok: false, summary: 'ALLES is already working. Stop it first, or wait for it to finish.' };
    if (!this.sessionId) this.sessionId = this.history.create({ kind: 'code', title: '', project: this.project.root });
    this.history.append(this.sessionId, { kind: 'user', text: task });
    this.emit('event', { type: 'session', sessionId: this.sessionId });
    let result;
    try { result = await this.runner.submit(this._taskText(task)); }
    catch (e) { result = { ok: false, summary: e.message }; }
    this.turns.push({ task, summary: result.summary });
    this.history.append(this.sessionId, { kind: 'assistant', text: result.summary || (result.ok ? 'Done.' : 'It stopped without a result.'), error: !result.ok });
    this.emit('event', { type: 'finished', ok: !!result.ok, summary: result.summary });
    this.emit('event', { type: 'changes', changes: this.tracker.list() });
    return { ok: !!result.ok, summary: result.summary };
  }

  stop() { return this.runner.stop(); }

  _onRunnerEvent(kind, p) {
    if (kind === 'status') this.emit('event', { type: 'status', state: p.state, detail: p.detail });
    else if (kind === 'message') { this.emit('event', { type: 'message', text: p.text }); }
    else if (kind === 'tool') {
      if (p.name === 'finish') return;                             // its text is the final summary, shown and saved when the task ends
      const text = String(p.result == null ? '' : p.result);
      this.history.append(this.sessionId, { kind: 'tool', name: p.name, args: p.args, text, error: p.error });
      this.emit('event', { type: 'tool', name: p.name, args: p.args, text, error: !!p.error });
      if (['write_file', 'edit_file'].includes(p.name) && !p.error) this.emit('event', { type: 'changes', changes: this.tracker.list() });
    }
  }

  changes() { return this.tracker ? this.tracker.list() : []; }
  diff(rel) { return this.tracker ? this.tracker.diff(rel) : null; }
  revert(rel) { if (!this.tracker) return { ok: false, error: 'No project is open.' }; if (this.busy) return { ok: false, error: 'Stop the running task first.' }; const r = this.tracker.revert(rel); this.emit('event', { type: 'changes', changes: this.tracker.list() }); return r; }
  revertAll() { if (!this.tracker) return { ok: false, error: 'No project is open.' }; if (this.busy) return { ok: false, error: 'Stop the running task first.' }; const r = this.tracker.revertAll(); this.emit('event', { type: 'changes', changes: this.tracker.list() }); return r; }
}

module.exports = { CodeService, MAX_TASK };
