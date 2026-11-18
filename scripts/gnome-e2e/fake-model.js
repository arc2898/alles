'use strict';
/**
 * A scripted stand-in for an AI provider: an HTTP server that speaks the OpenAI chat-completions dialect ALLES uses, and answers
 * with whatever the test's script says. ALLES talks to it over real HTTP exactly as it would to NVIDIA, Grok or Gemini, so the
 * whole path - provider settings, key store, router, agent, tools - is the real one; only the "intelligence" is a script.
 *
 *   const model = await startFakeModel(async (ctx) => reply);
 *   model.url          'http://127.0.0.1:PORT' - routes use `${model.url}/a/v1` and `${model.url}/b/v1` (any prefix: the path is told to the script)
 *   model.requests     every request seen: { path, key, body, at }
 *   model.aborted      how many requests ALLES hung up on before they were answered (the Stop button drops the request)
 *   model.violations   the requests that broke the rules of the chat format (see protocolProblems), as { path, n, problems: [text] }.
 *                      The model is STRICT: it answers such a request with an HTTP 400, as the fussiest real providers do, so a task
 *                      that sends one fails visibly; pass { strict: false } to startFakeModel to only record them.
 *   model.reset()      forget the requests and violations and start every path's numbering (ctx.n) from 1 again: call it between tasks
 *   await model.close()
 *
 * The script is called once per request with ctx = { n, path, key, body, messages, tools, lastImage() }:
 *   n            this request's number among those on the same path, from 1
 *   lastImage()  the newest picture ALLES sent (a Buffer holding a PNG), or null
 * and returns one of:
 *   { calls: [{ name, args }], content? }   the model asks for tools. A call may also have:
 *                                             id: null (no id at all) or id: 'x' (that id, so two calls can share one),
 *                                             argsAsObject: true (the arguments are sent as a JSON object instead of as a string of JSON)
 *                                           and args may be a string, which is sent as it is (cut-off or broken JSON, say)
 *   { text }                                the model just answers
 *   { finishReason }                        with any of the above: why the model says it stopped ('length' = it ran out of room)
 *   { message }                             with any of the above: send exactly this as the reply's message (parts as content, a
 *                                           refusal, reasoning_content ...) instead of one built from calls and text
 *   { status, body?, headers? }             an HTTP error (429, 500 ...)
 *   any of the above plus { delayMs }       wait first; if ALLES hangs up meanwhile the reply is dropped (and `aborted` is counted)
 */
const http = require('node:http');

function imagesOf(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) {
      const url = part && part.type === 'image_url' && part.image_url && part.image_url.url;
      const hit = typeof url === 'string' && /^data:image\/png;base64,(.+)$/.exec(url);
      if (hit) out.push(Buffer.from(hit[1], 'base64'));
    }
  }
  return out;
}

const blank = (c) => c == null || (typeof c === 'string' && !c.trim()) || (Array.isArray(c) && !c.length);

/**
 * The rules of the chat format that the fussiest providers enforce and the easy-going ones let slide - a request that breaks one
 * is a request a real provider may answer with a 400, which ends the task. Returns the broken rules in words ([] when there are none).
 *   - an assistant message says something or asks for tools (never neither), and never comes right after another assistant message
 *   - every tool call has its own id, a type "function", a name, and arguments that are a string holding a JSON object
 *   - the answers to a message's tool calls come right behind it, one for each call, by the call's id, and nothing else in between
 *   - a tool answer is text; a user message never comes right after another user message
 *   - the conversation ends with something to answer (a user message or a tool answer)
 */
function protocolProblems(messages) {
  const bad = [];
  if (!Array.isArray(messages) || !messages.length) return ['there are no messages'];
  let waitingFor = null;                                   // ids of the calls whose answers are still due
  const at = (i) => `message ${i} (${messages[i] && messages[i].role})`;
  messages.forEach((m, i) => {
    const prev = messages[i - 1];
    if (!m || typeof m !== 'object') { bad.push(`${at(i)} is not an object`); return; }
    if (waitingFor && waitingFor.size && m.role !== 'tool') { bad.push(`${at(i)} comes before the tool calls ${[...waitingFor].join(', ')} were answered`); waitingFor = null; }
    if (m.role === 'assistant') {
      const hasCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
      if (m.tool_calls !== undefined && !hasCalls) bad.push(`${at(i)} has tool_calls that are not a non-empty list`);
      if (!hasCalls && blank(m.content)) bad.push(`${at(i)} says nothing and asks for nothing`);
      if (prev && prev.role === 'assistant') bad.push(`${at(i)} comes right after another assistant message`);
      if (hasCalls) {
        const ids = new Set();
        m.tool_calls.forEach((c, k) => {
          const who = `${at(i)} tool call ${k}`;
          if (!c || typeof c !== 'object') { bad.push(`${who} is not an object`); return; }
          if (typeof c.id !== 'string' || !c.id) bad.push(`${who} has no id`);
          else if (ids.has(c.id)) bad.push(`${who} repeats the id ${c.id}`);
          else ids.add(c.id);
          if (c.type !== 'function') bad.push(`${who} has type ${JSON.stringify(c.type)}, not "function"`);
          const f = c.function;
          if (!f || typeof f.name !== 'string' || !f.name) bad.push(`${who} has no function name`);
          let parsed;
          try { parsed = typeof (f && f.arguments) === 'string' ? JSON.parse(f.arguments) : undefined; } catch { parsed = undefined; }
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) bad.push(`${who} has arguments that are not a string holding a JSON object`);
        });
        waitingFor = ids;
      }
    } else if (m.role === 'tool') {
      if (!waitingFor || !waitingFor.has(m.tool_call_id)) bad.push(`${at(i)} answers ${JSON.stringify(m.tool_call_id)}, which no tool call before it asked for (or was already answered)`);
      else waitingFor.delete(m.tool_call_id);
      if (typeof m.content !== 'string') bad.push(`${at(i)} has content that is not text`);
    } else if (m.role === 'user') {
      if (prev && prev.role === 'user') bad.push(`${at(i)} comes right after another user message`);
      if (blank(m.content)) bad.push(`${at(i)} is empty`);
    }
  });
  if (waitingFor && waitingFor.size) bad.push(`the tool calls ${[...waitingFor].join(', ')} were never answered`);
  const last = messages[messages.length - 1];
  if (last && last.role !== 'user' && last.role !== 'tool') bad.push(`the conversation ends with a ${last.role} message: there is nothing to answer`);
  return bad;
}

async function startFakeModel(script, { strict = true } = {}) {
  const requests = [];
  const violations = [];
  const counts = new Map();
  let aborted = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let hungUp = false;
      res.on('close', () => { if (!res.writableEnded) { hungUp = true; aborted++; } });
      const path = req.url.split('?')[0];
      if (req.method !== 'POST' || !path.endsWith('/chat/completions')) { res.writeHead(404); res.end('not found'); return; }
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400); res.end('bad json'); return; }
      const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const prefix = path.slice(0, -'/chat/completions'.length);
      const n = (counts.get(prefix) || 0) + 1; counts.set(prefix, n);
      requests.push({ path: prefix, key, body, at: Date.now() });
      const ctx = { n, path: prefix, key, body, messages: body.messages || [], tools: body.tools || [], lastImage: () => imagesOf(body.messages).pop() || null };
      const problems = protocolProblems(ctx.messages);
      if (problems.length) {
        violations.push({ path: prefix, n, problems });
        if (strict) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: `Invalid request: ${problems.join('; ')}` } })); return; }
      }
      let reply;
      try { reply = await script(ctx); } catch (e) { reply = { status: 500, body: `the test's script failed: ${e && e.stack ? e.stack : e}` }; }
      if (!reply) reply = { status: 500, body: 'the test script had no answer for this request' };
      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      if (hungUp) return;
      if (reply.status) { res.writeHead(reply.status, { 'content-type': 'text/plain', ...(reply.headers || {}) }); res.end(String(reply.body || 'error')); return; }
      const calls = (reply.calls || []).map((c, i) => {
        const out = { id: `call_${prefix.replace(/\W/g, '')}_${n}_${i}`, type: 'function', function: { name: c.name, arguments: typeof c.args === 'string' ? c.args : c.argsAsObject ? (c.args || {}) : JSON.stringify(c.args || {}) } };
        if (c.id === null) delete out.id; else if (c.id !== undefined) out.id = c.id;
        return out;
      });
      const message = reply.message || { role: 'assistant', content: reply.text !== undefined ? reply.text : (reply.content || null), ...(calls.length ? { tool_calls: calls } : {}) };
      const finishReason = reply.finishReason !== undefined ? reply.finishReason : (calls.length ? 'tool_calls' : 'stop');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `chatcmpl-${n}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, message, finish_reason: finishReason }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    get aborted() { return aborted; },
    violations,
    reset() { requests.length = 0; violations.length = 0; counts.clear(); },
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections && server.closeAllConnections(); }),
  };
}

module.exports = { startFakeModel, imagesOf, protocolProblems };
