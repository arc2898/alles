'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Agent } = require('../src/main/agent');

// Scripted fake router: returns queued replies in order and records every request.
function scriptedRouter(replies) {
  const requests = [];
  return {
    requests,
    chat: async (req) => {
      requests.push(JSON.parse(JSON.stringify({ ...req, signal: undefined })));
      const next = replies.shift();
      if (!next) throw new Error('script exhausted');
      if (next instanceof Error) throw next;
      return { label: 'FakeLLM', response: next };
    },
  };
}
// Build a reply the way openai-compat.js does: parsed toolCalls AND raw.tool_calls.
const call = (id, name, args = {}) => ({ id, name, arguments: args });
const reply = (content, calls = []) => ({
  content, toolCalls: calls,
  raw: calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {},
});
const png = Buffer.from('PNGDATA');

function collect(agent) {
  const statuses = [];
  agent.on('status', (s) => statuses.push(s.state));
  return statuses;
}

test('runs tool calls then finishes; returns the summary', async () => {
  const router = scriptedRouter([
    reply('', [call('c1', 'run_shell', { command: 'ls' })]),
    reply('', [call('c2', 'finish', { summary: 'listed files' })]),
  ]);
  const seen = [];
  const executeTool = async (name, args) => { seen.push([name, args]); return name === 'finish' ? { text: args.summary, done: true } : { text: 'a.txt' }; };
  const agent = new Agent({ router, executeTool });
  const statuses = collect(agent);
  const r = await agent.run('list my files');

  assert.deepStrictEqual(r, { ok: true, summary: 'listed files', steps: 2, stoppedBy: 'finish' });
  assert.deepStrictEqual(seen, [['run_shell', { command: 'ls' }], ['finish', { summary: 'listed files' }]]);
  assert.deepStrictEqual(statuses, ['thinking', 'acting', 'thinking', 'acting', 'done']);
});

test('PROTOCOL: every tool message follows an assistant message carrying the SAME tool_call id', async () => {
  const router = scriptedRouter([
    reply('', [call('call_A', 'run_shell', { command: 'x' })]),
    reply('', [call('call_B', 'finish', { summary: 'ok' })]),
  ]);
  const agent = new Agent({ router, executeTool: async (n, a) => (n === 'finish' ? { text: a.summary, done: true } : { text: 'out' }) });
  await agent.run('t');

  const second = router.requests[1].messages;
  const asst = second.find((m) => m.role === 'assistant');
  const tool = second.find((m) => m.role === 'tool');
  assert.strictEqual(asst.tool_calls[0].id, 'call_A');
  assert.strictEqual(tool.tool_call_id, 'call_A');
  assert.ok(second.indexOf(asst) < second.indexOf(tool), 'assistant tool_calls must come before its tool result');
});

test('a plain text reply with no tool calls ends the run as a final answer', async () => {
  const router = scriptedRouter([reply('The answer is 42.')]);
  const agent = new Agent({ router, executeTool: async () => ({ text: '' }) });
  const r = await agent.run('what is the answer');
  assert.deepStrictEqual([r.ok, r.summary, r.stoppedBy], [true, 'The answer is 42.', 'answer']);
});

test('screenshots go to the model as an image_url user message', async () => {
  const router = scriptedRouter([reply('', [call('c1', 'screenshot')]), reply('done')]);
  const agent = new Agent({ router, executeTool: async () => ({ text: 'Screenshot 1280x720', image: png }) });
  await agent.run('look');
  const last = router.requests[1].messages.at(-1);
  assert.strictEqual(last.role, 'user');
  assert.strictEqual(last.content[1].type, 'image_url');
  assert.ok(last.content[1].image_url.url.startsWith('data:image/png;base64,'));
  assert.strictEqual(Buffer.from(last.content[1].image_url.url.split(',')[1], 'base64').toString(), 'PNGDATA');
});

test('PROVIDER DATA GOES BACK UNCHANGED: a tool call\'s extra fields (Gemini 3 thought signature) reach the next request', async () => {
  const withSig = { content: '', toolCalls: [call('c1', 'run_shell', { command: 'ls' })], raw: { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_shell', arguments: '{"command":"ls"}' }, extra_content: { google: { thought_signature: 'SIG-xyz' } } }] } };
  const router = scriptedRouter([withSig, reply('done')]);
  const agent = new Agent({ router, executeTool: async () => ({ text: 'a.txt' }) });
  await agent.run('list files');
  const sent = router.requests[1].messages.find((m) => m.role === 'assistant');
  assert.deepStrictEqual(sent.tool_calls, withSig.raw.tool_calls, 'byte for byte what the provider sent');
  assert.strictEqual(sent.tool_calls[0].extra_content.google.thought_signature, 'SIG-xyz');
});

test('TWO TOOL CALLS AT ONCE: their answers stay together right behind the call, and the screenshot comes after both', async () => {
  const router = scriptedRouter([reply('', [call('c1', 'screenshot'), call('c2', 'run_shell', { command: 'date' })]), reply('done')]);
  const agent = new Agent({ router, executeTool: async (name) => (name === 'screenshot' ? { text: 'Screenshot 1280x720', image: png } : { text: 'Sat' }) });
  await agent.run('look, then check the time');
  const msgs = router.requests[1].messages;
  const at = msgs.findIndex((m) => m.role === 'assistant');
  assert.deepStrictEqual(msgs.slice(at, at + 4).map((m) => m.role), ['assistant', 'tool', 'tool', 'user'], 'no user message between the tool answers');
  assert.deepStrictEqual(msgs.slice(at + 1, at + 3).map((m) => m.tool_call_id), ['c1', 'c2']);
  assert.strictEqual(msgs[at + 3].content[1].type, 'image_url');
});

test('TWO SCREENSHOTS IN ONE STEP: only the newest is sent (the first is already out of date)', async () => {
  const first = Buffer.from('FIRSTPNG'); const second = Buffer.from('SECONDPNG');
  const router = scriptedRouter([reply('', [call('c1', 'screenshot'), call('c2', 'screenshot')]), reply('done')]);
  let n = 0;
  const agent = new Agent({ router, executeTool: async () => ({ text: `shot ${++n}`, image: n === 1 ? first : second }) });
  await agent.run('two looks');
  const images = router.requests[1].messages.filter((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
  assert.strictEqual(images.length, 1);
  assert.strictEqual(Buffer.from(images[0].content[1].image_url.url.split(',')[1], 'base64').toString(), 'SECONDPNG');
});

test('a step with no screenshot sends no image message', async () => {
  const router = scriptedRouter([reply('', [call('c1', 'run_shell', { command: 'ls' })]), reply('done')]);
  const agent = new Agent({ router, executeTool: async () => ({ text: 'a.txt' }) });
  await agent.run('no look');
  assert.ok(!router.requests[1].messages.some((m) => Array.isArray(m.content)));
});

test('CONTEXT: only the newest N screenshots are sent; older ones become a text stub', async () => {
  const replies = [];
  for (let i = 1; i <= 5; i++) replies.push(reply('', [call(`c${i}`, 'screenshot')]));
  replies.push(reply('all done'));
  const router = scriptedRouter(replies);
  const agent = new Agent({ router, executeTool: async () => ({ text: 'shot', image: png }), keepImages: 2 });
  await agent.run('many screenshots');

  const lastReq = router.requests.at(-1).messages;
  const withImage = lastReq.filter((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
  const stubs = lastReq.filter((m) => m.content === '[older screenshot removed to save context]');
  assert.strictEqual(withImage.length, 2);
  assert.strictEqual(stubs.length, 3);
});

test('pruning never mutates the real history (only the copy sent to the model)', async () => {
  const agent = new Agent({ router: {}, executeTool: async () => ({}), keepImages: 1 });
  const img = (n) => ({ role: 'user', content: [{ type: 'text', text: n }, { type: 'image_url', image_url: { url: 'data:x' } }] });
  const history = [img('a'), img('b'), img('c')];
  const pruned = agent._prune(history);
  assert.strictEqual(pruned.filter((m) => Array.isArray(m.content)).length, 1);
  assert.strictEqual(history.filter((m) => Array.isArray(m.content)).length, 3);
});

test('STEP BUDGET: a model that never finishes is cut off', async () => {
  const replies = Array.from({ length: 10 }, (_, i) => reply('', [call(`c${i}`, 'wait', { seconds: 0 })]));
  const agent = new Agent({ router: scriptedRouter(replies), executeTool: async () => ({ text: 'ok' }), maxSteps: 3 });
  const statuses = collect(agent);
  const r = await agent.run('loop forever');
  assert.deepStrictEqual([r.ok, r.steps, r.stoppedBy], [false, 3, 'max-steps']);
  assert.strictEqual(statuses.at(-1), 'error');
});

test('STOP: aborting mid-run stops before the next tool call and reports "stopped"', async () => {
  const replies = [reply('', [call('c1', 'wait'), call('c2', 'wait'), call('c3', 'wait')])];
  let executed = 0;
  let agent;
  agent = new Agent({ router: scriptedRouter(replies), executeTool: async () => { executed++; agent.stop(); return { text: 'ok' }; } });
  const statuses = collect(agent);
  const r = await agent.run('t');
  assert.strictEqual(executed, 1, 'remaining tool calls must NOT run after stop');
  assert.deepStrictEqual([r.ok, r.stoppedBy], [false, 'user']);
  assert.strictEqual(statuses.at(-1), 'stopped');
});

test('STOP: abort while waiting on the model is reported as user-stop, not a model error', async () => {
  let agent;
  const router = { chat: async () => { agent.stop(); throw new Error('aborted'); } };
  agent = new Agent({ router, executeTool: async () => ({ text: '' }) });
  const r = await agent.run('t');
  assert.strictEqual(r.stoppedBy, 'user');
});

test('all providers failing yields a clean error result (no throw) and an error status', async () => {
  const router = scriptedRouter([new Error('All providers failed (nv:503)')]);
  const agent = new Agent({ router, executeTool: async () => ({ text: '' }) });
  const statuses = collect(agent);
  const r = await agent.run('t');
  assert.deepStrictEqual([r.ok, r.stoppedBy], [false, 'error']);
  assert.match(r.summary, /All providers failed/);
  assert.strictEqual(statuses.at(-1), 'error');
});

test('a tool error is fed back to the model so it can recover', async () => {
  const router = scriptedRouter([reply('', [call('c1', 'read_file', { path: '/nope' })]), reply('I could not read it.')]);
  const agent = new Agent({ router, executeTool: async () => ({ text: 'Error: ENOENT', error: true }) });
  const events = [];
  agent.on('tool', (e) => events.push(e));
  const r = await agent.run('t');
  assert.strictEqual(events[0].error, true);
  assert.strictEqual(router.requests[1].messages.find((m) => m.role === 'tool').content, 'Error: ENOENT');
  assert.strictEqual(r.ok, true);
});

test('cannot start a second run while one is active, and can run again after', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const router = { chat: async () => { await gate; return { label: 'x', response: reply('done') }; } };
  const agent = new Agent({ router, executeTool: async () => ({ text: '' }) });
  const first = agent.run('one');
  await assert.rejects(() => agent.run('two'), /already running/);
  release();
  await first;
  assert.strictEqual(agent.running, false);
  const again = new Agent({ router: scriptedRouter([reply('ok')]), executeTool: async () => ({ text: '' }) });
  assert.strictEqual((await again.run('three')).ok, true);
});

test('emits route label so the pill can show which provider answered', async () => {
  const agent = new Agent({ router: scriptedRouter([reply('hi')]), executeTool: async () => ({ text: '' }) });
  const labels = [];
  agent.on('route', (r) => labels.push(r.label));
  await agent.run('t');
  assert.deepStrictEqual(labels, ['FakeLLM']);
});

// ------------------------------------------------------------------ the tool list

test('TOOLS: a list is sent as it is, and the standard list is the default', async () => {
  const { TOOL_SCHEMAS } = require('../src/main/tools');
  const mine = [{ type: 'function', function: { name: 'only_one', description: 'x', parameters: { type: 'object', properties: {}, required: [] } } }];
  const r1 = scriptedRouter([reply('done')]);
  await new Agent({ router: r1, executeTool: async () => ({ text: '' }), tools: mine }).run('t');
  assert.deepStrictEqual(r1.requests[0].tools, mine);
  const r2 = scriptedRouter([reply('done')]);
  await new Agent({ router: r2, executeTool: async () => ({ text: '' }) }).run('t');
  assert.deepStrictEqual(r2.requests[0].tools, JSON.parse(JSON.stringify(TOOL_SCHEMAS)));
});

test('TOOLS: a function is asked again before EVERY request, so the list can change during a task', async () => {
  const router = scriptedRouter([
    reply('', [call('c1', 'run_shell', { command: 'x' })]),
    reply('', [call('c2', 'run_shell', { command: 'y' })]),
    reply('all done'),
  ]);
  let asked = 0;
  const lists = [['one'], ['one', 'two'], ['three']].map((names) => names.map((name) => ({ type: 'function', function: { name, description: 'd', parameters: { type: 'object', properties: {}, required: [] } } })));
  const agent = new Agent({ router, executeTool: async () => ({ text: 'ok' }), tools: () => lists[asked++] });
  await agent.run('t');
  assert.strictEqual(asked, 3, 'once per request, no more');
  assert.deepStrictEqual(router.requests.map((r) => r.tools.map((t) => t.function.name)), [['one'], ['one', 'two'], ['three']]);
});

test('TOOLS: a function that fails, or gives something that is not a list, falls back to the standard list and the task goes on', async () => {
  const { TOOL_SCHEMAS } = require('../src/main/tools');
  const standard = JSON.parse(JSON.stringify(TOOL_SCHEMAS));
  for (const tools of [() => { throw new Error('cannot tell'); }, () => undefined, () => null, () => [], () => 'nope', () => ({})]) {
    const router = scriptedRouter([reply('done')]);
    const r = await new Agent({ router, executeTool: async () => ({ text: '' }), tools }).run('t');
    assert.strictEqual(r.ok, true, 'a broken tool list is not a reason to give up the task');
    assert.deepStrictEqual(router.requests[0].tools, standard);
  }
});

test('STOP: the tool is given a signal that fires when Stop is pressed, so a slow tool can end at once', async () => {
  let seen = null;
  const executeTool = (name, args, opts) => new Promise((resolve) => {
    seen = opts && opts.signal;
    seen.addEventListener('abort', () => resolve({ text: 'cut short' }), { once: true });
  });
  const router = scriptedRouter([reply('', [call('c1', 'wait', { seconds: 20 })])]);
  const agent = new Agent({ router, executeTool });
  const run = agent.run('wait a long time');
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(seen, 'the tool was given a signal');
  assert.strictEqual(seen.aborted, false);
  const t0 = Date.now();
  agent.stop();
  const r = await run;
  assert.ok(Date.now() - t0 < 1000);
  assert.strictEqual(seen.aborted, true);
  assert.deepStrictEqual([r.ok, r.stoppedBy], [false, 'user']);
});

// ---------------------------------------------------------------- a long task must not outgrow the model's context

const toolHistory = (sizes) => {
  const m = [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'THE TASK' }];
  sizes.forEach((n, i) => {
    m.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'run_shell', arguments: '{}' } }] });
    m.push({ role: 'tool', tool_call_id: `c${i}`, content: `OUT${i}:` + 'x'.repeat(n) });
  });
  return m;
};
const lengthOf = (ms) => ms.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
const SHORTENED = /\n\[older output shortened to save context: \d+ more characters not shown\]$/;

test('CONTEXT: tool output past the budget is cut from the OLDEST first; the newest six, the task and the model\'s own words are untouched', () => {
  const agent = new Agent({ router: {}, executeTool: async () => ({}), maxContextChars: 28_000 });
  const history = toolHistory(Array(12).fill(4000));                        // 48 000 characters of tool output: all six old ones have to go (five cuts leave 29 900)
  const pruned = agent._prune(history);
  const was = history.filter((m) => m.role === 'tool');
  const tools = pruned.filter((m) => m.role === 'tool');
  for (const m of tools.slice(0, 6)) { assert.match(m.content, SHORTENED); assert.ok(m.content.length < 500, `${m.content.length}`); }
  tools.slice(-6).forEach((m, k) => assert.strictEqual(m.content, was[6 + k].content, 'the newest six are whole'));
  assert.ok(lengthOf(pruned) <= 28_000, `${lengthOf(pruned)} characters left`);
  assert.strictEqual(pruned[0].content, 'SYSTEM'); assert.strictEqual(pruned[1].content, 'THE TASK');
  assert.deepStrictEqual(pruned.filter((m) => m.role === 'assistant'), history.filter((m) => m.role === 'assistant'));
  assert.deepStrictEqual(tools.map((m) => m.tool_call_id), was.map((m) => m.tool_call_id), 'every answer still belongs to its call');
  assert.match(tools[0].content, /^OUT0:x{290,}/, 'the beginning of each output is kept');
});

test('CONTEXT: under the budget nothing is changed, and the real history is never edited', () => {
  const agent = new Agent({ router: {}, executeTool: async () => ({}), maxContextChars: 30_000 });
  const small = toolHistory(Array(5).fill(1000));
  assert.deepStrictEqual(agent._prune(small), small);
  const big = toolHistory(Array(12).fill(4000));
  const before = JSON.stringify(big);
  agent._prune(big);
  assert.strictEqual(JSON.stringify(big), before);
});

test('CONTEXT: only as much is cut as is needed: the oldest outputs, one by one, until the text fits', () => {
  const agent = new Agent({ router: {}, executeTool: async () => ({}), maxContextChars: 30_000 });
  const pruned = agent._prune(toolHistory(Array(10).fill(4000)));          // 40 100 characters: three cuts (about 3 600 each) bring it under 30 000
  const flags = pruned.filter((m) => m.role === 'tool').map((m) => SHORTENED.test(m.content));
  assert.deepStrictEqual(flags, [true, true, true, false, false, false, false, false, false, false]);
  assert.ok(lengthOf(pruned) <= 30_000);
});

test('CONTEXT: a short output is never "shortened" (nothing to gain)', () => {
  const agent = new Agent({ router: {}, executeTool: async () => ({}), maxContextChars: 1000 });
  const history = toolHistory(Array(10).fill(200));
  assert.deepStrictEqual(agent._prune(history), history);
});

test('CONTEXT: the agent sends the pruned history (the request that goes out is bounded)', async () => {
  const replies = [];
  for (let i = 0; i < 12; i++) replies.push(reply('', [call(`c${i}`, 'run_shell', { command: 'x' })]));
  replies.push(reply('', [call('cf', 'finish', { summary: 'done' })]));
  const router = scriptedRouter(replies);
  const agent = new Agent({ router, maxContextChars: 12_000, executeTool: async (n, a) => (n === 'finish' ? { text: a.summary, done: true } : { text: 'y'.repeat(4000) }) });
  const r = await agent.run('long job');
  assert.strictEqual(r.ok, true);
  const last = router.requests[router.requests.length - 1].messages;
  const tools = last.filter((m) => m.role === 'tool');
  assert.strictEqual(tools.length, 12);
  assert.ok(tools.slice(0, 6).every((m) => SHORTENED.test(m.content)), 'the oldest six were cut');
  assert.ok(tools.slice(-6).every((m) => m.content.length === 4000), 'the newest six are whole');
});

// ---------------------------------------------------------------- empty, cut-off and odd replies
// What real models do: a thinking model uses up all its room thinking and sends back nothing; a long answer stops in the middle; a tool
// call is cut off inside its arguments. None of them may end the task by accident, or leave a history the provider then refuses.

const said = (content, finishReason, calls = []) => ({ ...reply(content, calls), finishReason });
const empty = (finishReason = 'stop') => said('', finishReason);
const finishCall = (id = 'cf') => call(id, 'finish', { summary: 'all done' });
const doTool = async (n, a) => (n === 'finish' ? { text: a.summary, done: true } : { text: 'ok' });
const roles = (messages) => messages.map((m) => m.role);

test('EMPTY REPLY: the model is asked to carry on, the empty reply is NOT put in the history, and the task goes on', async () => {
  const router = scriptedRouter([empty(), reply('', [finishCall()])]);
  const r = await new Agent({ router, executeTool: doTool }).run('open the calculator');
  assert.deepStrictEqual([r.ok, r.summary, r.stoppedBy, r.steps], [true, 'all done', 'finish', 2]);
  const second = router.requests[1].messages;
  assert.deepStrictEqual(roles(second), ['system', 'user'], 'no assistant message with nothing in it, and no second user message right behind the first');
  assert.match(second[1].content, /^open the calculator\n\nYour last reply was empty\. Carry on with the task/);
});

test('EMPTY REPLY after a tool answer: the request is a user message behind the answer', async () => {
  const router = scriptedRouter([reply('', [call('c1', 'run_shell', { command: 'x' })]), empty(), reply('', [finishCall()])]);
  await new Agent({ router, executeTool: doTool }).run('t');
  const third = router.requests[2].messages;
  assert.deepStrictEqual(roles(third), ['system', 'user', 'assistant', 'tool', 'user']);
  assert.match(third.at(-1).content, /^Your last reply was empty/);
});

test('EMPTY REPLY right after a screenshot: it joins the screenshot message (two user messages in a row are refused by some providers)', async () => {
  const router = scriptedRouter([reply('', [call('c1', 'screenshot')]), empty(), reply('', [finishCall()])]);
  const exec = async (n, a) => (n === 'screenshot' ? { text: 'Screenshot 1280x720', image: png } : doTool(n, a));
  await new Agent({ router, executeTool: exec }).run('look');
  const third = router.requests[2].messages;
  assert.deepStrictEqual(roles(third), ['system', 'user', 'assistant', 'tool', 'user']);
  const last = third.at(-1);
  assert.deepStrictEqual(last.content.map((p) => p.type), ['text', 'image_url', 'text']);
  assert.match(last.content[2].text, /^Your last reply was empty/);
});

test('EMPTY REPLY: blank space, a missing or odd content and a malformed reply all count as empty', async () => {
  for (const odd of [said('  \n\t ', 'stop'), { content: null, toolCalls: [], raw: {} }, { content: undefined, toolCalls: undefined }, { content: 5, toolCalls: [] }, {}]) {
    const router = scriptedRouter([odd, reply('', [finishCall()])]);
    const r = await new Agent({ router, executeTool: doTool }).run('t');
    assert.deepStrictEqual([r.ok, r.stoppedBy, r.steps], [true, 'finish', 2], JSON.stringify(odd));
  }
});

test('EMPTY REPLY three times in a row ends the task with a plain explanation that depends on WHY the replies were empty', async () => {
  const cases = [['length', /ran out of room/], ['content_filter', /blocked/], ['stop', /answered with nothing/], ['', /answered with nothing/], ['something_new', /answered with nothing/]];
  for (const [why, pattern] of cases) {
    const router = scriptedRouter([empty(why), empty(why), empty(why), reply('', [finishCall()])]);
    const agent = new Agent({ router, executeTool: doTool });
    const statuses = collect(agent);
    const r = await agent.run('t');
    assert.deepStrictEqual([r.ok, r.stoppedBy, r.steps], [false, 'error', 3], why);
    assert.match(r.summary, pattern, why);
    assert.ok(!/undefined|\[object/.test(r.summary), r.summary);
    assert.strictEqual(router.requests.length, 3, 'a fourth reply is never asked for');
    assert.strictEqual(statuses.at(-1), 'error');
  }
});

test('EMPTY REPLY: only replies IN A ROW count - a good reply in between starts the count again', async () => {
  const router = scriptedRouter([empty(), empty(), reply('', [call('c1', 'wait')]), empty(), empty(), reply('', [call('c2', 'wait')]), empty(), reply('', [finishCall()])]);
  const r = await new Agent({ router, executeTool: doTool }).run('t');
  assert.deepStrictEqual([r.ok, r.stoppedBy, r.steps], [true, 'finish', 8]);
});

test('EMPTY REPLY: each ask uses up a step, so a model that keeps doing it still cannot run past the step budget', async () => {
  const router = scriptedRouter([empty(), empty(), reply('', [call('c1', 'wait')]), empty(), empty()]);
  const r = await new Agent({ router, executeTool: doTool, maxSteps: 4 }).run('t');
  assert.deepStrictEqual([r.ok, r.stoppedBy, r.steps], [false, 'max-steps', 4]);
});

test('CUT OFF: words that stop in the middle are kept in the history, the model is told it was cut off and asked to carry on', async () => {
  const router = scriptedRouter([said('I will first open the', 'length'), reply('', [finishCall()])]);
  const agent = new Agent({ router, executeTool: doTool });
  const heard = []; agent.on('message', (m) => heard.push(m.text));
  const r = await agent.run('t');
  assert.deepStrictEqual([r.ok, r.stoppedBy], [true, 'finish']);
  const second = router.requests[1].messages;
  assert.deepStrictEqual(roles(second), ['system', 'user', 'assistant', 'user']);
  assert.strictEqual(second[2].content, 'I will first open the');
  assert.match(second[3].content, /^Your last reply was cut off because it was too long\. Keep replies short/);
  assert.deepStrictEqual(heard, ['I will first open the']);
});

test('CUT OFF three times in a row: the task ends and says the AI ran out of room - the cut-off words are never handed over as "the answer"', async () => {
  const router = scriptedRouter([said('one', 'length'), said('two', 'length'), said('three', 'length')]);
  const r = await new Agent({ router, executeTool: doTool }).run('t');
  assert.deepStrictEqual([r.ok, r.stoppedBy, r.steps], [false, 'error', 3]);
  assert.match(r.summary, /ran out of room/);
  assert.ok(!/three/.test(r.summary));
});

test('CUT OFF but with a whole tool call in it: the call is carried out as usual (it is the REPLY without a call that is not an answer)', async () => {
  const router = scriptedRouter([said('', 'length', [call('c1', 'run_shell', { command: 'ls' })]), reply('', [finishCall()])]);
  const ran = [];
  const r = await new Agent({ router, executeTool: async (n, a) => { ran.push(n); return doTool(n, a); } }).run('t');
  assert.deepStrictEqual(ran, ['run_shell', 'finish']);
  assert.strictEqual(r.ok, true);
});

test('CUT OFF inside a tool call: the answer to that call says the reply was cut off and nothing was done; a plain parse error does not', async () => {
  const garbled = (id) => call(id, 'write_file', { __parseError: '{"path":"/tmp/x","content":"aaaa' });
  const answer = (finishReason) => new Promise((resolve) => {
    const router = scriptedRouter([said('', finishReason, [garbled('c1')]), reply('', [finishCall()])]);
    new Agent({ router, executeTool: async (n, a) => (n === 'finish' ? { text: a.summary, done: true } : { text: 'Your arguments were not valid JSON, so nothing was done', error: true }) })
      .run('t').then(() => resolve(router.requests[1].messages.find((m) => m.role === 'tool').content));
  });
  const cut = await answer('length');
  assert.match(cut, /^Your arguments were not valid JSON/);
  assert.match(cut, /cut off because it was too long, so this call is incomplete and nothing was done\. Split the work into smaller pieces/);
  assert.ok(!/cut off/.test(await answer('stop')), 'with a normal ending it is just a parse error');
  assert.ok(!/cut off/.test(await answer(undefined)));
});

test('REPLY SIZE: the most a reply may write goes with every request - 8192 unless set', async () => {
  const router = scriptedRouter([reply('', [call('c1', 'wait')]), reply('done')]);
  await new Agent({ router, executeTool: doTool }).run('t');
  assert.deepStrictEqual(router.requests.map((q) => q.maxTokens), [8192, 8192]);
  const other = scriptedRouter([reply('done')]);
  await new Agent({ router: other, executeTool: doTool, maxTokens: 500 }).run('t');
  assert.strictEqual(other.requests[0].maxTokens, 500);
});

test('a tool executor that THROWS does not end the task: the model is told, like any other tool error', async () => {
  const router = scriptedRouter([reply('', [call('c1', 'run_shell', { command: 'x' })]), reply('', [finishCall()])]);
  const agent = new Agent({ router, executeTool: async (n, a) => { if (n === 'finish') return { text: a.summary, done: true }; throw new Error('boom'); } });
  const events = []; agent.on('tool', (e) => events.push(e));
  const r = await agent.run('t');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(router.requests[1].messages.find((m) => m.role === 'tool').content, 'Error: boom');
  assert.strictEqual(events[0].error, true);
});

test('...but a tool that throws BECAUSE Stop was pressed ends the task as stopped, and its "failure" is not reported as a tool error', async () => {
  for (const calls of [[call('c1', 'wait')], [call('c1', 'wait'), call('c2', 'wait')]]) {
    const router = scriptedRouter([reply('', calls)]);
    let agent; let ran = 0;
    agent = new Agent({ router, executeTool: async () => { ran++; agent.stop(); throw new Error('aborted'); } });
    const events = []; agent.on('tool', (e) => events.push(e));
    const r = await agent.run('t');
    assert.deepStrictEqual([r.ok, r.stoppedBy, ran], [false, 'user', 1], `${calls.length} calls`);
    assert.deepStrictEqual(events, [], 'nothing went wrong with the tool: the person stopped it');
    assert.strictEqual(router.requests.length, 1, 'and the model is not asked again');
  }
});

test('a tool answer with no text, or with something that is not text, still goes back to the model as a string', async () => {
  const outs = [undefined, null, { text: 42 }, { text: undefined }, 'just a string'];
  let i = 0;
  const router = scriptedRouter([reply('', outs.map((_o, k) => call(`c${k}`, 'x'))), reply('', [finishCall()])]);
  await new Agent({ router, executeTool: async (n, a) => (n === 'finish' ? { text: a.summary, done: true } : outs[i++]) }).run('t');
  const tools = router.requests[1].messages.filter((m) => m.role === 'tool');
  assert.deepStrictEqual(tools.map((m) => m.content), ['', '', '42', '', '']);
  assert.deepStrictEqual(tools.map((m) => m.tool_call_id), ['c0', 'c1', 'c2', 'c3', 'c4'], 'every call is still answered, in order');
});

test('a reader that gives no copy of the provider\'s tool calls still gets answers that match: the calls are rebuilt from the parsed ones', async () => {
  const router = scriptedRouter([{ content: '', toolCalls: [call('c1', 'run_shell', { command: 'ls' })] }, reply('', [finishCall()])]);
  await new Agent({ router, executeTool: doTool }).run('t');
  const second = router.requests[1].messages;
  const asst = second.find((m) => m.role === 'assistant');
  assert.deepStrictEqual(asst.tool_calls, [{ id: 'c1', type: 'function', function: { name: 'run_shell', arguments: '{"command":"ls"}' } }]);
  assert.strictEqual(second.find((m) => m.role === 'tool').tool_call_id, 'c1');
});

test('finish with nothing to say still ends the task, with "Done."', async () => {
  const router = scriptedRouter([reply('', [call('c1', 'finish', {})])]);
  const r = await new Agent({ router, executeTool: async () => ({ text: '  ', done: true }) }).run('t');
  assert.deepStrictEqual([r.ok, r.summary, r.stoppedBy], [true, 'Done.', 'finish']);
});

test('a plain answer is handed over without the blank space around it', async () => {
  const r = await new Agent({ router: scriptedRouter([reply('\n  The answer is 42.  \n')]), executeTool: doTool }).run('t');
  assert.deepStrictEqual([r.ok, r.summary, r.stoppedBy], [true, 'The answer is 42.', 'answer']);
});
