'use strict';
const { chatPrompt } = require('./identity');

/**
 * ChatService - the Chat page: a conversation with the model, written or spoken, no tools. It remembers the conversation while
 * the app runs (and in History if the person allows), so an old chat opened from History can be carried on.
 *
 * One answer is awaited at a time; stop() drops the request. Context is bounded: the oldest messages fall away first, so a very
 * long chat never makes the provider refuse the request.
 */

const MAX_MESSAGES = 60;
const MAX_CHARS = 80_000;
const MAX_INPUT = 8000;

class ChatService {
  /**
   * @param {object} o
   * @param {()=>{chat:Function}} o.createRouter
   * @param {import('./history').HistoryStore} o.history
   */
  constructor({ createRouter, history, now = () => new Date() }) {
    this.createRouter = createRouter; this.history = history; this.now = now;
    this.convos = new Map(); this.abort = null; this.busy = false;
  }

  /** The messages of a conversation, from memory or (for an old chat) rebuilt from History. */
  _messages(id) {
    if (this.convos.has(id)) return this.convos.get(id);
    const got = this.history.get(id);
    const msgs = got ? got.events.filter((e) => (e.kind === 'user' || e.kind === 'assistant') && e.text).map((e) => ({ role: e.kind, content: e.text })) : [];
    this.convos.set(id, msgs);
    return msgs;
  }

  _trim(msgs) {
    let out = msgs.slice(-MAX_MESSAGES);
    let total = out.reduce((n, m) => n + m.content.length, 0);
    while (total > MAX_CHARS && out.length > 1) { total -= out[0].content.length; out = out.slice(1); }
    while (out.length && out[0].role !== 'user') out = out.slice(1);       // the provider wants the conversation to begin with the person
    return out;
  }

  /**
   * @param {{sessionId?:string|null, text:string, spoken?:boolean}} o
   * @returns {Promise<{ok:true, sessionId:string, reply:string} | {ok:false, error:string, sessionId?:string}>}
   */
  async send({ sessionId = null, text, spoken = false }) {
    const said = typeof text === 'string' ? text.trim() : '';
    if (!said) return { ok: false, error: 'Write or say something first.' };
    if (said.length > MAX_INPUT) return { ok: false, error: `That message is ${said.length} characters; the limit is ${MAX_INPUT}.` };
    if (this.busy) return { ok: false, error: 'ALLES is still answering. Wait, or press Stop.' };
    this.busy = true;
    const ctl = new AbortController(); this.abort = ctl;
    const id = sessionId || this.history.create({ kind: 'chat' });
    try {
      const msgs = this._messages(id);
      msgs.push({ role: 'user', content: said });
      this.history.append(id, { kind: 'user', text: said });
      let result;
      try {
        result = await this.createRouter().chat({
          messages: [{ role: 'system', content: chatPrompt({ now: this.now(), spoken }) }, ...this._trim(msgs)],
          maxTokens: 4096, signal: ctl.signal,
        });
      } catch (e) {
        msgs.pop();                                         // the question got no answer: it is not part of the conversation
        if (ctl.signal.aborted) { this.history.append(id, { kind: 'note', text: 'Stopped.' }); return { ok: false, error: 'Stopped.', sessionId: id }; }
        this.history.append(id, { kind: 'note', text: `No answer: ${e.message}`, error: true });
        return { ok: false, error: e.message, sessionId: id };
      }
      const reply = result && result.response && typeof result.response.content === 'string' ? result.response.content.trim() : '';
      if (!reply) { msgs.pop(); return { ok: false, error: 'The AI answered with nothing. Try again.', sessionId: id }; }
      msgs.push({ role: 'assistant', content: reply });
      this.history.append(id, { kind: 'assistant', text: reply });
      return { ok: true, sessionId: id, reply };
    } finally { this.busy = false; this.abort = null; }
  }

  stop() { if (this.abort) { this.abort.abort(); return true; } return false; }

  /** Forget the in-memory copy of a conversation (it was deleted from History). */
  forget(id) { this.convos.delete(id); }
}

module.exports = { ChatService, MAX_INPUT, MAX_MESSAGES };
