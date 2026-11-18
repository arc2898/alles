'use strict';

const { chatCompletion } = require('./openai-compat');
const { solidPng, noisyPng } = require('../util/png');
const { redact } = require('../redact');

/**
 * probeRoute - the Settings "Test" button. Sends tiny requests to ONE route with ONE key:
 *   1. text     : "Reply with the single word OK."
 *   2. vision   : a RED picture as big as a real screenshot (1280x720, a few hundred KB) - "what colour?"   (ALLES must see the screen).
 *                 When that is refused, a tiny 32x32 one is tried too, to tell "takes no pictures" from "takes none THIS big".
 *   3. tools    : "call report_color with blue"              (ALLES acts through tool calls)
 *   4. followup : the tool's answer is sent back, with the model's own tool call exactly as it sent it, and the model must carry on.
 *                 ALLES does this at every step after the first, and it is where some providers break: one wants extra data from
 *                 its earlier reply sent back (Gemini 3's "thought signature"), another refuses the "tool" role.
 * and reports each separately, with a plain-language hint for a failure. A model can be reachable and
 * still be useless to ALLES (no images, no tools), and the raw 400 from the provider says so poorly.
 *
 * Costs a few tokens, so it only ever runs when the user asks. Nothing here is cached or remembered.
 */

/**
 * The most the model may write per check. Generous on purpose: current models often THINK before they answer, and the thinking
 * counts against this limit. At 16 tokens such a model used it all up thinking and sent back an empty answer, which the probe then
 * called "not as asked" - a model that works fine, reported as broken.
 */
const PROBE_TOKENS = 1024;

const RED = solidPng(32, 32, [220, 30, 30]);
const IMAGE_URL = `data:image/png;base64,${RED.toString('base64')}`;

/**
 * A picture as heavy as a real screenshot. The tiny one proves a model can SEE; this one proves the provider takes a picture of the
 * size ALLES sends at every step. Some providers limit the size of a picture or of a whole request, and a model that passes the tiny
 * check can then refuse every real screenshot. Made when first needed (it takes a moment) and kept.
 */
let screenPicture = null;
const screenPng = () => screenPicture || (screenPicture = noisyPng(1280, 720, [220, 30, 30]));
const screenUrl = () => `data:image/png;base64,${screenPng().toString('base64')}`;

const TOOL_PROMPT = 'Call the report_color tool with color set to "blue".';

const REPORT_TOOL = {
  type: 'function',
  function: {
    name: 'report_color',
    description: 'Report a colour name.',
    parameters: { type: 'object', properties: { color: { type: 'string' } }, required: ['color'] },
  },
};

// What a model said, for a hint: an empty answer gets its own wording (it is usually a thinking model out of budget or a refusal).
const said = (r) => ((r.content || '').trim() ? `"${r.content.trim().slice(0, 40)}"` : 'nothing');

const CHECKS = {
  text: {
    request: () => ({ messages: [{ role: 'user', content: 'Reply with the single word OK.' }], maxTokens: PROBE_TOKENS, temperature: 0 }),
    judge: (r) => (/ok/i.test(r.content) ? null : `The model answered, but not as asked (it said ${said(r)}).`),
  },
  vision: {
    request: () => ({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'What single colour fills this image? Answer with one word.' }, { type: 'image_url', image_url: { url: screenUrl() } }] }],
      maxTokens: PROBE_TOKENS, temperature: 0,
    }),
    judge: (r) => (/red/i.test(r.content) ? null : `The model accepted the image but did not identify it (it said ${said(r)}). It may be ignoring images.`),
  },
  // Only tried when the screenshot-sized picture was refused: if this small one is taken, the problem is the SIZE.
  visionSmall: {
    request: () => ({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'What single colour fills this image? Answer with one word.' }, { type: 'image_url', image_url: { url: IMAGE_URL } }] }],
      maxTokens: PROBE_TOKENS, temperature: 0,
    }),
    judge: (r) => (/red/i.test(r.content) ? null : `The model accepted the image but did not identify it (it said ${said(r)}). It may be ignoring images.`),
  },
  tools: {
    request: () => ({ messages: [{ role: 'user', content: TOOL_PROMPT }], tools: [REPORT_TOOL], maxTokens: PROBE_TOKENS, temperature: 0 }),
    judge: (r) => (r.toolCalls && r.toolCalls.some((t) => t.name === 'report_color') ? null : 'The model replied in text instead of calling the tool. It may not support tool calling.'),
  },
  followup: {
    // `prev` is the model's reply to the tools check. Its tool_calls go back EXACTLY as received (agent.js does the same), together with the tool's answer.
    request: (prev) => ({
      messages: [
        { role: 'user', content: TOOL_PROMPT },
        { role: 'assistant', content: prev.content || null, tool_calls: prev.raw.tool_calls },
        { role: 'tool', tool_call_id: prev.toolCalls[0].id, content: 'Reported: blue.' },
      ],
      tools: [REPORT_TOOL], maxTokens: PROBE_TOKENS, temperature: 0,
    }),
    judge: (r) => (((r.content || '').trim() || (r.toolCalls && r.toolCalls.length)) ? null : 'The model said nothing after being given the tool\'s answer.'),
  },
};

/** Plain-language advice for a failed check. */
function hintFor(check, status, message) {
  if (status === 401 || status === 403) return 'The API key was refused. Check that it is correct and has access to this model.';
  if (status === 402) return 'The account is out of credit.';
  if (status === 404) return 'The model or base URL was not found. Check the model name and the base URL.';
  if (status === 429) return 'Rate limited. Wait a moment and test again.';
  if (status === 413) return check === 'vision' ? 'The provider says the picture was too big. ALLES sends a screenshot at every step.' : 'The provider says the request was too big.';
  if (status === 400 || status === 422) {
    if (check === 'vision') return 'This model does not accept images. ALLES needs a vision-capable model to see your screen.';
    if (check === 'tools') return 'This model rejected tool calling. ALLES needs a model that supports tools (function calling).';
    if (check === 'followup') {
      if (/thought.?signature/i.test(message || '')) return 'The provider wants a "thought signature" from its own earlier reply sent back with the tool call. ALLES sends that reply back unchanged, so this should not happen - please report it.';
      return 'The provider rejected the tool\'s answer being sent back to it. ALLES does that at every step, so it cannot use this model.';
    }
    return 'The provider rejected the request. Check the model name.';
  }
  if (status == null) return /timed out|aborted/i.test(message) ? 'The server took too long to answer.' : 'Could not reach the server. Check the base URL and your connection.';
  return 'The provider returned an error.';
}

async function runCheck(name, chat, ctx, timeoutMs, now, prev = null, keep = null) {
  const t0 = now();
  try {
    const r = await chat(CHECKS[name].request(prev), ctx, { timeoutMs });
    if (keep) keep.reply = r;
    const why = CHECKS[name].judge(r);
    return why ? { ok: false, ms: now() - t0, status: null, error: why, hint: why } : { ok: true, ms: now() - t0 };
  } catch (e) {
    const status = e && e.status != null ? e.status : null;
    const error = redact(String((e && e.message) || e).slice(0, 300), [ctx.apiKey]);
    return { ok: false, ms: now() - t0, status, error, hint: hintFor(name, status, error) };
  }
}

/**
 * @param {{route:{model:string,baseUrl:string}, apiKey:string}} o
 * @returns {Promise<{text,vision,tools,followup,usable:boolean,summary:string}>}
 */
async function probeRoute({ route, apiKey, chat = chatCompletion, timeoutMs = 45_000, now = Date.now }) {
  const none = (summary) => ({ text: null, vision: null, tools: null, followup: null, usable: false, summary });
  if (!route || !route.model) return none('Choose a model first.');
  if (!route.baseUrl) return none('Set the base URL first.');
  if (!apiKey) return none('Add an API key first.');

  const ctx = { apiKey, model: route.model, baseUrl: route.baseUrl };
  const text = await runCheck('text', chat, ctx, timeoutMs, now);

  // A refused key, an unknown model, a rate limit or an unreachable server will fail the other checks identically: do not spend them.
  const blocking = !text.ok && (text.status === 401 || text.status === 402 || text.status === 403 || text.status === 404 || text.status === 429 || text.status == null);
  const skipped = { ok: false, skipped: true, hint: 'Not tested because the basic check failed.' };
  let vision = blocking ? skipped : await runCheck('vision', chat, ctx, timeoutMs, now);
  // A refused screenshot-sized picture means either "this model takes no pictures" or "this provider takes none THIS big". The tiny one tells them apart.
  if (!vision.ok && !vision.skipped && (vision.status === 400 || vision.status === 413 || vision.status === 422)) {
    const small = await runCheck('visionSmall', chat, ctx, timeoutMs, now);
    if (small.ok) vision = { ...vision, hint: `The model takes pictures, but refused one the size of a screenshot (about ${Math.round(screenPng().length / 1000)} KB). ALLES sends one at every step, so it cannot use this model through this provider as it is. The provider said: ${vision.error}` };
  }
  const toolsReply = {};
  const tools = blocking ? skipped : await runCheck('tools', chat, ctx, timeoutMs, now, null, toolsReply);

  // The next step needs the model's own tool call to send back. Without one (or without an id to answer it by) there is nothing to test.
  const prev = toolsReply.reply;
  const call = prev && prev.toolCalls && prev.toolCalls[0];
  const cannot = (why) => ({ ok: false, ms: 0, status: null, error: why, hint: why });
  const followup = blocking ? skipped
    : !tools.ok ? { ok: false, skipped: true, hint: 'Not tested because the tool check failed.' }
    : !(prev.raw && Array.isArray(prev.raw.tool_calls) && call) ? cannot('The model\'s tool call came back in a form that cannot be answered.')
    : !call.id ? cannot('The model\'s tool call came back without an id, so its answer cannot be matched to it.')
    : await runCheck('followup', chat, ctx, timeoutMs, now, prev);

  const usable = text.ok && vision.ok && tools.ok && followup.ok;
  let summary;
  if (usable) summary = 'Works: replies, sees images, supports tool calls and carries on after one.';
  else if (!text.ok) summary = text.hint;
  else summary = [!vision.ok && `Images: ${vision.hint}`, !tools.ok && `Tools: ${tools.hint}`, !followup.ok && !followup.skipped && `Next step: ${followup.hint}`].filter(Boolean).join(' ');
  return { text, vision, tools, followup, usable, summary };
}

module.exports = { probeRoute, hintFor, CHECKS, REPORT_TOOL, PROBE_TOKENS };
