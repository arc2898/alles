'use strict';

const { ProviderError } = require('./router');
const { redact } = require('../redact');

/**
 * Default endpoints and models. They were CHECKED against each vendor's public documentation and model list on 2026-10-18,
 * but NEVER CALLED: the build sandbox blocks all three vendors, so no request was ever sent. They are suggestions the user can
 * change, and Settings has a Test button (providers/probe.js) that checks text, image input, tool calling and a second step
 * after a tool call for real. What the check of 2026-10-18 found (model lists change - look again before trusting this):
 *
 *   NVIDIA  GET https://integrate.api.nvidia.com/v1/models lists nvidia/nemotron-3.5-super-vl-120b-a12b: a vision-language model
 *           (text, images and video in; reasoning, coding and tool use; its model card benchmarks OSWorld-Verified, a computer-use
 *           test). That is the default. moonshotai/kimi-k2.6 (natively multimodal, tool calling, 256K context) is the suggested
 *           model for the fallback route (see config.js). The old default meta/llama-3.2-90b-vision-instruct is still listed, but
 *           NVIDIA's NIM page on function calling for vision models names other models only, so it is not a good agent model.
 *   xAI     docs.x.ai examples use grok-4.7 (plain "grok-4" no longer appears; the older Grok 4 ids were retired on 2026-05-15 and
 *           now redirect to grok-4.3). Chat Completions, which ALLES speaks, is documented there as a legacy endpoint ("limited
 *           updates"; new features come to the Responses API first). It still works; if it is ever switched off, a Responses
 *           adapter is the fix.
 *   Google  ai.google.dev: the OpenAI-compatibility examples (text, images, function calling) use gemini-3.8-flash. gemini-2.5-*
 *           is "still served" but, the docs say, only to users who already used it; they recommend 3.x for new projects. Gemini 3
 *           models attach a "thought signature" to each tool call (tool_calls[i].extra_content.google.thought_signature) and answer
 *           400 if it is not sent back with the next request. agent.js sends the provider's own tool_calls back unchanged, which
 *           carries it (a test pins this).
 *
 * ALLES sends screenshots and calls tools, so the model must accept images AND support function calling - a vision model.
 */
const PRESETS = {
  nvidia: {
    label: 'NVIDIA',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    model: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
  },
  grok: {
    label: 'Grok (xAI)',
    baseUrl: 'https://api.x.ai/v1',
    model: 'grok-4.7',
  },
  gemini: {
    label: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3.8-flash',
  },
  custom: { label: 'Custom (OpenAI-compatible)', baseUrl: '', model: '' },
};

function parseRetryAfter(headers) {
  const v = headers.get('retry-after');
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.min(secs, 3600) * 1000;
  const when = Date.parse(v);
  return Number.isFinite(when) ? Math.min(Math.max(0, when - Date.now()), 3600_000) : null;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The text of an assistant message: a string, or (some providers) a list of parts. Anything else is no text. */
function contentText(c) {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((p) => {
    if (typeof p === 'string') return p;
    return isPlainObject(p) && (p.type === undefined || p.type === 'text') && typeof p.text === 'string' ? p.text : '';
  }).join('');
}

/**
 * Some reasoning models write their thinking INTO the message, ahead of the answer, between <think> and </think> (a server without a
 * "reasoning parser" does this; some even leave the opening tag out, because the prompt already opened it). It is not part of the
 * answer: shown to the person it looks like a bug, and kept in the history it fills the context a little more at every step.
 * What is taken out: a block at the very start, or everything up to the first </think> when the opening tag is missing altogether. A
 * message that ends while the model is still thinking has no answer in it at all. An answer that merely MENTIONS the tag somewhere
 * inside it (an <think> that is not at the start) is left exactly as it is.
 */
function withoutThinking(text) {
  const opens = (t) => /^\s*<think>/i.test(t);
  if (!opens(text) && /<think>/i.test(text)) return text;         // the tag is being talked about, not used
  let t = text;
  for (;;) {
    const close = t.search(/<\/think>/i);
    if (close === -1) return opens(t) ? '' : t;
    t = t.slice(close + '</think>'.length).trim();
    if (!opens(t)) return t;
  }
}

/**
 * What a model sent as a tool call's arguments, as { args, text }:
 *   args  an object. A string is JSON; some servers send an object already, a few send JSON inside a JSON string. Anything that
 *         cannot be read as an object becomes { __parseError: <what was sent> }, which the tools answer with "not valid JSON".
 *   text  the same arguments as valid JSON text, for sending the call back to the provider ('{}' when they were unreadable: a
 *         provider that parses the history refuses the next request over a broken one).
 */
function readArguments(raw) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) return { args: {}, text: '{}' };
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return { args: { __parseError: raw }, text: '{}' }; }
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return { args: { __parseError: raw }, text: '{}' }; } }
  }
  if (!isPlainObject(v)) return { args: { __parseError: typeof raw === 'string' ? raw : String(raw) }, text: '{}' };
  return { args: v, text: typeof raw === 'string' && isPlainObject(JSON.parse(raw)) ? raw : JSON.stringify(v) };
}

/** Every tool call id already in a conversation (the calls the model made, and the answers given to them). */
function idsIn(messages) {
  const ids = new Set();
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!isPlainObject(m)) continue;
    if (typeof m.tool_call_id === 'string') ids.add(m.tool_call_id);
    for (const c of Array.isArray(m.tool_calls) ? m.tool_calls : []) if (isPlainObject(c) && typeof c.id === 'string') ids.add(c.id);
  }
  return ids;
}

/**
 * The tool calls of a reply, made safe to answer. Real providers send some odd things, and one of them breaks the NEXT request, which
 * the whole task then dies on: a call with no id (or the same id twice) cannot be answered by a tool message, and a call that is not
 * a call at all (no function name) has nothing to run. So: entries that are not calls are dropped, every call gets an id of its own
 * - one that is not already used in the conversation either (`taken`: some servers number their calls from 0 in every reply) - and
 * the calls that go back to the provider carry valid JSON arguments. Everything else the provider sent with a call (Gemini 3's
 * thought signature, for one) is kept exactly.
 * @param {unknown} list      the reply's tool_calls
 * @param {Set<string>} [taken] ids already used earlier in the conversation
 * @returns {{ calls: {id:string,name:string,arguments:object}[], raw: object[] }}
 */
function readToolCalls(list, taken = new Set()) {
  const calls = []; const raw = []; const used = new Set(taken);
  let seq = 0;
  const fresh = () => { let id; do { id = `call_${++seq}`; } while (used.has(id)); return id; };
  for (const tc of Array.isArray(list) ? list : []) {
    const fn = isPlainObject(tc) && isPlainObject(tc.function) ? tc.function : null;
    if (!fn || typeof fn.name !== 'string' || !fn.name) continue;
    let id = typeof tc.id === 'string' && tc.id ? tc.id : fresh();
    for (let n = 2; used.has(id); n++) id = `${typeof tc.id === 'string' && tc.id ? tc.id : 'call'}-${n}`;
    used.add(id);
    const { args, text } = readArguments(fn.arguments);
    calls.push({ id, name: fn.name, arguments: args });
    raw.push({ ...tc, id, type: typeof tc.type === 'string' && tc.type ? tc.type : 'function', function: { ...fn, arguments: text } });
  }
  return { calls, raw };
}

/**
 * One OpenAI-compatible chat completion.
 * request: { messages, tools?, temperature?, maxTokens?, signal? }
 * ctx:     { apiKey, model, baseUrl }
 * returns: { content (always a string), toolCalls: [{id,name,arguments(object)}], finishReason ('stop', 'tool_calls', 'length' ... or ''),
 *            usage, raw (the provider's message, with `tool_calls` as readToolCalls() made them, and none at all when there are none) }
 */
async function chatCompletion(request, ctx, { fetchImpl = fetch, timeoutMs = 120_000 } = {}) {
  if (!ctx.baseUrl) throw new ProviderError('No base URL configured for this route', { status: 400 });
  if (!ctx.model) throw new ProviderError('No model configured for this route', { status: 400 });

  const url = `${ctx.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model: ctx.model,
    messages: request.messages,
    temperature: request.temperature ?? 0.2,
    stream: false,
  };
  if (request.maxTokens) body.max_tokens = request.maxTokens;
  if (request.tools && request.tools.length) {
    body.tools = request.tools;
    body.tool_choice = 'auto';
  }

  // One time limit for the WHOLE exchange, the reading of the answer included: a server that sends its headers and then goes quiet
  // must not hold the task for ever. Stop (request.signal) ends it at once, in either part.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const onStop = () => ac.abort();
  if (request.signal) {
    if (request.signal.aborted) ac.abort(); else request.signal.addEventListener('abort', onStop, { once: true });
  }
  const gone = () => new ProviderError('Network error: timed out or aborted');

  const send = async (payload) => {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.apiKey}` },
        body: JSON.stringify(payload),
        signal: ac.signal,
        redirect: 'error',     // a redirect would re-send the whole conversation (screenshots included) to another origin
      });
    } catch (e) {
      // network / DNS / timeout: no HTTP status -> classified as retryable 'server'
      throw new ProviderError(`Network error: ${e.name === 'AbortError' ? 'timed out or aborted' : e.message}`, { cause: e });
    }
    let whole = '';
    if (!res.ok) { try { whole = await res.text(); } catch { /* the status alone is still an answer */ } }
    return { res, whole, detail: redact(whole.slice(0, 300), [ctx.apiKey]) };
  };

  let json;
  try {
    let { res, whole, detail } = await send(body);
    // OpenAI's newer models refuse "max_tokens" and ask for "max_completion_tokens" instead. One more try with the other name
    // (everything else about the request is the same), so that a route like that is not written off as rejecting ALLES.
    if (!res.ok && res.status === 400 && body.max_tokens && /max_completion_tokens/i.test(whole.slice(0, 2000))) {
      const { max_tokens: n, ...rest } = body;
      ({ res, whole, detail } = await send({ ...rest, max_completion_tokens: n }));
    }
    if (!res.ok) {
      throw new ProviderError(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`, { status: res.status, retryAfterMs: parseRetryAfter(res.headers) });
    }
    try { json = await res.json(); } catch (e) {
      throw ac.signal.aborted ? gone() : new ProviderError('Provider returned invalid JSON', { cause: e });
    }
  } finally {
    clearTimeout(timer);
    if (request.signal) request.signal.removeEventListener('abort', onStop);
  }

  const choice = json && json.choices && json.choices[0];
  const msg = choice && choice.message;
  if (!msg || typeof msg !== 'object') throw new ProviderError('Provider response had no choices[0].message');

  const { calls, raw: rawCalls } = readToolCalls(msg.tool_calls, idsIn(request.messages));
  const message = { ...msg };
  delete message.tool_calls;
  if (rawCalls.length) message.tool_calls = rawCalls;                    // an empty list is refused by strict providers when sent back

  const refusal = typeof msg.refusal === 'string' ? msg.refusal : '';     // OpenAI-style models say "no" here, with no content
  return {
    content: withoutThinking(contentText(msg.content)) || refusal,
    toolCalls: calls,
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : '',
    usage: json.usage || null,
    raw: message,
  };
}

module.exports = { chatCompletion, PRESETS, parseRetryAfter };
