'use strict';

const { EventEmitter } = require('node:events');
const { TOOL_SCHEMAS } = require('./tools');

// The prompt (and the assistant's name) lives in identity.js so the two are edited together.
const { systemPrompt: buildSystemPrompt } = require('./identity');

// A long task piles up tool output (shell output, file contents). A model has a limited context: past it the provider refuses the request
// and the task dies. Past this many characters of text (about 50 000 tokens) the OLDEST tool outputs are cut short; the newest few are never touched.
const MAX_CONTEXT_CHARS = 200_000;
const KEEP_RECENT_TOOLS = 6;
const SHORT_KEEP = 300;

// A reply can come back with nothing in it: a thinking model that used all the room it was given thinking, an answer the provider blocked,
// a hiccup. Or it can be cut off in the middle. Neither is an answer. The model is asked to carry on, up to this many times in a row; then
// the task ends and says why. Each ask uses up a step like any other.
const MAX_EMPTY_REPLIES = 2;
// The most a reply may write. Left out, a provider picks its own limit, and some pick a small one: a thinking model then runs out while still
// thinking and sends back nothing at all. Generous on purpose: it is a ceiling, and costs nothing when the reply is short.
const DEFAULT_MAX_TOKENS = 8192;

const NUDGE_EMPTY = 'Your last reply was empty. Carry on with the task: take the next action by calling a tool, or call finish with a short summary if the task is done.';
const NUDGE_CUT = 'Your last reply was cut off because it was too long. Keep replies short: take the next action by calling a tool, or call finish with a short summary if the task is done.';
const HINT_CUT_CALL = '\nYour reply was cut off because it was too long, so this call is incomplete and nothing was done. Split the work into smaller pieces and try again.';

/** Why the task ended, in the person's words, when the model kept sending nothing. */
function emptyReplyText(finishReason) {
  if (finishReason === 'length') return 'The AI ran out of room before it could answer: its thinking used up everything it was allowed to write, even after being asked again. Try again, or choose a model that thinks less in Settings.';
  if (finishReason === 'content_filter') return 'The AI provider blocked the answer (its content filter), even after being asked again. Try wording the task differently.';
  return 'The AI answered with nothing, even after being asked again. Try again; if it keeps happening, use Test in Settings to check the model.';
}

const textLength = (m) => (typeof m.content === 'string' ? m.content.length
  : Array.isArray(m.content) ? m.content.reduce((n, part) => n + (part && typeof part.text === 'string' ? part.text.length : 0), 0) : 0);

/**
 * Status states drive the on-screen pill:
 *   idle | thinking | acting | waiting (approval) | done | error | stopped
 *
 * Events:  'status' {state, detail}   'message' {role, text}
 *          'tool'   {name, args, result}   'route' {label}
 */
class Agent extends EventEmitter {
  /**
   * @param {object} deps
   * @param {{chat:Function}} deps.router
   * @param {(name:string,args:object,opts:{signal:AbortSignal})=>Promise<{text:string,image?:Buffer,done?:boolean,error?:boolean}>} deps.executeTool
   *        `opts.signal` fires when the person presses Stop: a tool that takes time (wait, a shell command) must end at once
   * @param {number} [deps.maxSteps]
   * @param {number} [deps.keepImages]  how many recent screenshots stay in context
   * @param {string} [deps.systemPrompt] defaults to identity.systemPrompt() (GNOME wording)
   * @param {number} [deps.maxContextChars] text past which the oldest tool outputs are shortened (see MAX_CONTEXT_CHARS)
   * @param {number} [deps.maxTokens] the most one reply may write (see DEFAULT_MAX_TOKENS)
   * @param {object[]|(()=>object[])} [deps.tools]  the tool list, or a function that gives it. A function is asked again before EVERY
   *        model request, so the list can follow what has become known during the task (what the keyboard backend can type).
   */
  constructor({ router, executeTool, maxSteps = 40, keepImages = 2, tools = TOOL_SCHEMAS, systemPrompt = buildSystemPrompt(), maxContextChars = MAX_CONTEXT_CHARS, maxTokens = DEFAULT_MAX_TOKENS }) {
    super();
    this.systemPrompt = systemPrompt;
    this.router = router;
    this.executeTool = executeTool;
    this.maxSteps = maxSteps;
    this.keepImages = keepImages;
    this.maxContextChars = maxContextChars;
    this.maxTokens = maxTokens;
    this.tools = tools;
    this.abortController = null;
    this.running = false;
  }

  _status(state, detail = '') { this.emit('status', { state, detail }); }

  /** The tools to offer for the next request. A list that cannot be worked out must never end the task: use the standard one. */
  _tools() {
    if (typeof this.tools !== 'function') return this.tools;
    try {
      const list = this.tools();
      return Array.isArray(list) && list.length ? list : TOOL_SCHEMAS;
    } catch { return TOOL_SCHEMAS; }
  }

  stop() {
    if (this.abortController) this.abortController.abort();
  }

  /**
   * Run one task to completion.
   * @returns {{ok:boolean, summary:string, steps:number, stoppedBy?:string}}
   */
  async run(task) {
    if (this.running) throw new Error('Agent is already running a task');
    this.running = true;
    this.abortController = new AbortController();
    const { signal } = this.abortController;

    const messages = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: task },
    ];

    let emptyInARow = 0;
    try {
      for (let step = 1; step <= this.maxSteps; step++) {
        if (signal.aborted) return this._end(false, 'Stopped by user', step - 1, 'user');

        this._status('thinking', `Step ${step}`);
        let result;
        try {
          result = await this.router.chat({ messages: this._prune(messages), tools: this._tools(), maxTokens: this.maxTokens, signal });
        } catch (e) {
          if (signal.aborted) return this._end(false, 'Stopped by user', step - 1, 'user');
          this._status('error', e.message);
          return { ok: false, summary: `Model request failed: ${e.message}`, steps: step - 1, stoppedBy: 'error' };
        }
        if (result.label) this.emit('route', { label: result.label });

        const reply = result.response || {};
        const said = typeof reply.content === 'string' ? reply.content : '';
        const calls = Array.isArray(reply.toolCalls) ? reply.toolCalls : [];
        const cutOff = reply.finishReason === 'length';

        // No tool call and nothing to say (or words that stop in the middle): not an answer. Asked again, up to MAX_EMPTY_REPLIES times.
        // An EMPTY reply is not put in the history (a provider refuses an assistant message with no content and no calls on the next
        // request, and the task would die of that); words that were cut off are kept, so the model knows what it already said.
        if (!calls.length && (!said.trim() || cutOff)) {
          if (said.trim()) {
            messages.push({ role: 'assistant', content: said });
            this.emit('message', { role: 'assistant', text: said });
          }
          if (++emptyInARow > MAX_EMPTY_REPLIES) return this._end(false, emptyReplyText(reply.finishReason), step, 'error');
          this._nudge(messages, cutOff ? NUDGE_CUT : NUDGE_EMPTY);
          continue;
        }
        emptyInARow = 0;

        // The provider's own tool_calls go back EXACTLY as they came (not rebuilt from the parsed copy): they can carry data only the
        // provider understands, and some refuse the next request without it - Gemini 3 answers 400 unless tool_calls[i].extra_content.
        // google.thought_signature is sent back. (Only a reader that gave no such copy gets one built here.)
        const sentBack = reply.raw && Array.isArray(reply.raw.tool_calls) ? reply.raw.tool_calls
          : calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) } }));
        messages.push({ role: 'assistant', content: said || null, ...(calls.length ? { tool_calls: sentBack } : {}) });
        if (said.trim()) this.emit('message', { role: 'assistant', text: said });

        // No tool calls = the model is just talking. Treat as a final answer.
        if (!calls.length) return this._end(true, said.trim(), step, 'answer');

        let screen = null;
        for (const call of calls) {
          if (signal.aborted) return this._end(false, 'Stopped by user', step, 'user');

          this._status('acting', call.name);
          let out;
          try { out = await this.executeTool(call.name, call.arguments, { signal }); } catch (e) {
            // executeTool is handed in; one that throws must not end the task - the model is told, as with any other tool error.
            if (signal.aborted) return this._end(false, 'Stopped by user', step, 'user');
            out = { text: `Error: ${(e && e.message) || e}`, error: true };
          }
          if (!out || typeof out !== 'object') out = { text: '' };
          let text = typeof out.text === 'string' ? out.text : (out.text == null ? '' : String(out.text));
          // Arguments that stop in the middle of a long text are what a reply that was cut off looks like: say so, or the model sends the same thing again.
          if (cutOff && call.arguments && typeof call.arguments.__parseError === 'string') text += HINT_CUT_CALL;
          this.emit('tool', { name: call.name, args: call.arguments, result: text, error: !!out.error });

          messages.push({ role: 'tool', tool_call_id: call.id, content: text });
          if (out.image) screen = out.image;       // a later action may change the screen again: only the newest picture is worth sending
          if (out.done) return this._end(true, text.trim() || 'Done.', step, 'finish');
        }
        // Most chat-completions APIs cannot carry an image inside a tool message, so the screenshot is delivered as a user message.
        // It goes AFTER every answer to this step's tool calls: the provider wants the answers directly behind the call that asked
        // (a user message in between is refused by some providers when the model asked for two things at once).
        if (screen) {
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text: 'Current screen:' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${screen.toString('base64')}` } },
            ],
          });
        }
      }
      return this._end(false, `Stopped after ${this.maxSteps} steps without finishing`, this.maxSteps, 'max-steps');
    } finally {
      this.running = false;
      this.abortController = null;
    }
  }

  /**
   * Say something to the model as the user. When the last message is already the user's (the task, or the screenshot) it is added to
   * THAT message: two user messages in a row are refused by providers whose chat format wants the two sides to alternate.
   */
  _nudge(messages, text) {
    const last = messages[messages.length - 1];
    if (last && last.role === 'user' && typeof last.content === 'string') last.content = `${last.content}\n\n${text}`;
    else if (last && last.role === 'user' && Array.isArray(last.content)) last.content = [...last.content, { type: 'text', text }];
    else messages.push({ role: 'user', content: text });
  }

  _end(ok, summary, steps, stoppedBy) {
    this._status(ok ? 'done' : stoppedBy === 'user' ? 'stopped' : 'error', summary);
    return { ok, summary, steps, stoppedBy };
  }

  /**
   * Screenshots are huge. Keep only the newest `keepImages`, replacing older
   * ones with a text stub so the context (and your token bill) stays bounded.
   * And when the text itself has grown past `maxContextChars`, the oldest tool outputs are cut to their first lines (the newest
   * KEEP_RECENT_TOOLS are never touched, nor is the task or anything the model said).
   * Returns a copy; the real history is never mutated.
   */
  _prune(messages) {
    const imageIdx = [];
    messages.forEach((m, i) => { if (Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')) imageIdx.push(i); });
    const drop = new Set(imageIdx.slice(0, Math.max(0, imageIdx.length - this.keepImages)));
    const out = messages.map((m, i) => (drop.has(i) ? { role: m.role, content: '[older screenshot removed to save context]' } : m));

    let total = out.reduce((n, m) => n + textLength(m), 0);
    if (total > this.maxContextChars) {
      const toolIdx = [];
      out.forEach((m, i) => { if (m.role === 'tool') toolIdx.push(i); });
      for (const i of toolIdx.slice(0, Math.max(0, toolIdx.length - KEEP_RECENT_TOOLS))) {
        if (total <= this.maxContextChars) break;
        const text = typeof out[i].content === 'string' ? out[i].content : '';
        if (text.length <= SHORT_KEEP + 80) continue;
        const cut = `${text.slice(0, SHORT_KEEP)}\n[older output shortened to save context: ${text.length - SHORT_KEEP} more characters not shown]`;
        total -= text.length - cut.length;
        out[i] = { ...out[i], content: cut };
      }
    }
    return out;
  }
}

module.exports = { Agent };
