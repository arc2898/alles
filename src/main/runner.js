'use strict';
const { EventEmitter } = require('node:events');

/**
 * TaskRunner - one task at a time, from "the user typed something" to a result.
 *
 * What it guarantees (each has a test):
 *  - Only ONE task runs. The slot is taken BEFORE anything asynchronous happens, so two submits in the
 *    same tick cannot both start.
 *  - The status pill can never be left stuck on "Thinking...". If the agent throws, or building it
 *    throws, the runner emits an error status itself.
 *  - submit() rejects only for VALIDATION problems (empty, too long, busy). A task that fails while
 *    running resolves to {ok:false,...}, so callers have one shape to handle.
 *  - stop() also engages the emergency stop on the input layer and answers open approval questions with
 *    NO (via onStop), so a tool call already in flight cannot keep clicking after the user said stop.
 *  - `busy` is false by the time 'finished' is emitted.
 *
 * Light continuity: a follow-up sent soon after a successful task is given that task and its outcome, so
 * "now do the same for the other file" works. It is a short text hint, not a saved conversation.
 */

const MAX_TASK_CHARS = 4000;
const CONTEXT_WINDOW_MS = 15 * 60_000;
const CONTEXT_CLIP = 400;

class RunnerError extends Error { constructor(code, message) { super(message); this.name = 'RunnerError'; this.code = code; } }

const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length <= n ? t : `${t.slice(0, n)}…`; };

class TaskRunner extends EventEmitter {
  /**
   * @param {object} o
   * @param {()=>object} o.createAgent   returns an Agent (or anything with run/stop/on)
   * @param {()=>void} [o.onStart]       runs before each task (e.g. clear the emergency stop)
   * @param {()=>void} [o.onStop]        runs on stop() (e.g. engage the emergency stop, deny open questions)
   * @param {number} [o.contextWindowMs] how long a finished task is remembered for "now do the same for..."; a negative number turns that off
   * @param {number} [o.maxTaskChars]    the longest request accepted (the coding area takes longer ones than the pill)
   */
  constructor({ createAgent, onStart = () => {}, onStop = () => {}, now = Date.now, contextWindowMs = CONTEXT_WINDOW_MS, maxTaskChars = MAX_TASK_CHARS }) {
    super();
    this.createAgent = createAgent; this.onStart = onStart; this.onStop = onStop; this.now = now; this.contextWindowMs = contextWindowMs; this.maxTaskChars = maxTaskChars;
    this.agent = null; this.running = false; this.last = null;
  }

  get busy() { return this.running; }

  _withContext(task) {
    const l = this.last;
    if (!l || this.now() - l.at > this.contextWindowMs) return task;
    return `Earlier you were asked: "${clip(l.task, CONTEXT_CLIP)}" and you reported: "${clip(l.summary, CONTEXT_CLIP)}".\n\nNew request: ${task}`;
  }

  async submit(text) {
    if (this.running) throw new RunnerError('busy', 'ALLES is already working on a task. Stop it first, or wait for it to finish.');
    const task = typeof text === 'string' ? text.trim() : '';
    if (!task) throw new RunnerError('empty', 'Type what you want ALLES to do.');
    if (task.length > this.maxTaskChars) throw new RunnerError('too-long', `That request is ${task.length} characters; the limit is ${this.maxTaskChars}.`);

    this.running = true;                       // take the slot before any await
    let result;
    try {
      const agent = this.createAgent();
      this.agent = agent;
      for (const ev of ['status', 'message', 'tool', 'route']) agent.on(ev, (p) => this.emit(ev, p));
      this.onStart();
      result = await agent.run(this._withContext(task));
    } catch (e) {
      const msg = `Something went wrong: ${(e && e.message) || e}`;
      result = { ok: false, summary: msg, steps: 0, stoppedBy: 'error' };
      this.emit('status', { state: 'error', detail: msg });          // never leave the pill on "Thinking..."
    } finally {
      this.agent = null; this.running = false;
    }
    if (result.ok && result.summary) this.last = { task, summary: result.summary, at: this.now() };
    this.emit('finished', result);
    return result;
  }

  /** @returns {boolean} whether a task was running */
  stop() {
    if (!this.running) return false;
    try { if (this.agent) this.agent.stop(); } finally { this.onStop(); }
    return true;
  }
}

module.exports = { TaskRunner, RunnerError, MAX_TASK_CHARS, CONTEXT_WINDOW_MS };
