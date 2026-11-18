'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { TaskRunner, RunnerError, MAX_TASK_CHARS } = require('../src/main/runner');
const { Agent } = require('../src/main/agent');

// ---- fakes
const call = (id, name, args = {}) => ({ id, name, arguments: args });
const reply = (content, calls = []) => ({ content, toolCalls: calls, raw: calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {} });
const scripted = (replies) => ({ requests: [], chat: async function (req) { this.requests.push(JSON.parse(JSON.stringify({ ...req, signal: undefined }))); const n = replies.shift(); if (!n) throw new Error('script exhausted'); if (n instanceof Error) throw n; return { label: 'Fake', response: n }; } });

/** A controllable fake agent, to hold a run open and finish it on demand. */
function gatedAgent() {
  const a = new EventEmitter(); let release; const gate = new Promise((r) => { release = r; });
  a.stopped = 0; a.tasks = [];
  a.run = async (task) => { a.tasks.push(task); a.emit('status', { state: 'thinking', detail: 'Step 1' }); const v = await gate; return v; };
  a.stop = () => { a.stopped++; };
  a.finish = (v = { ok: true, summary: 'done', steps: 1, stoppedBy: 'finish' }) => release(v);
  return a;
}
const make = (createAgent, o = {}) => new TaskRunner({ createAgent, ...o });
const events = (r, names) => { const seen = []; for (const n of names) r.on(n, (p) => seen.push([n, p])); return seen; };
const tick = () => new Promise((r) => setImmediate(r));

// ---- happy path with the REAL agent
test('runs a task through the real Agent and forwards every event', async () => {
  const router = scripted([reply('', [call('c1', 'run_shell', { command: 'ls' })]), reply('', [call('c2', 'finish', { summary: 'listed' })])]);
  const agent = () => new Agent({ router, executeTool: async (n, a) => (n === 'finish' ? { text: a.summary, done: true } : { text: 'a.txt' }) });
  const r = make(agent); const seen = events(r, ['status', 'tool', 'route', 'finished']);
  const res = await r.submit('list my files');
  assert.deepStrictEqual([res.ok, res.summary, res.stoppedBy], [true, 'listed', 'finish']);
  const kinds = seen.map(([k]) => k);
  assert.ok(['status', 'tool', 'route', 'finished'].every((k) => kinds.includes(k)), kinds.join());
  assert.strictEqual(seen.at(-1)[0], 'finished');
  assert.strictEqual(r.busy, false);
});

test('the task text is trimmed before it reaches the agent', async () => {
  const a = gatedAgent(); const r = make(() => a);
  const p = r.submit('   open the calculator \n'); a.finish(); await p;
  assert.strictEqual(a.tasks[0], 'open the calculator');
});

// ---- one at a time
test('BUSY: a second task is refused while one runs, and accepted after it ends', async () => {
  const a = gatedAgent(); let made = 0; const r = make(() => { made++; return made === 1 ? a : gatedAgent(); });
  const first = r.submit('one');
  await assert.rejects(() => r.submit('two'), (e) => e instanceof RunnerError && e.code === 'busy' && /already working/.test(e.message));
  assert.strictEqual(r.busy, true); assert.strictEqual(made, 1, 'the refused task never built an agent');
  a.finish(); await first;
  assert.strictEqual(r.busy, false);
  const b = gatedAgent(); const r2 = make(() => b); const p = r2.submit('again'); b.finish(); await p;
});

test('RACE: two submits in the SAME tick - exactly one runs', async () => {
  const agents = []; const r = make(() => { const a = gatedAgent(); agents.push(a); return a; });
  const results = await Promise.allSettled([r.submit('A'), r.submit('B'), r.submit('C')].map((p, i) => { if (i === 0) setImmediate(() => agents[0].finish()); return p; }));
  assert.strictEqual(agents.length, 1, 'only one agent may ever be created');
  assert.deepStrictEqual(results.map((x) => x.status), ['fulfilled', 'rejected', 'rejected']);
});

// ---- validation
test('VALIDATION: empty, blank, non-string and oversized tasks are refused without building an agent', async () => {
  let made = 0; const r = make(() => { made++; return gatedAgent(); });
  for (const bad of ['', '   ', '\n\t', null, undefined, 42, {}, []]) await assert.rejects(() => r.submit(bad), (e) => e.code === 'empty', JSON.stringify(bad));
  await assert.rejects(() => r.submit('x'.repeat(MAX_TASK_CHARS + 1)), (e) => e.code === 'too-long' && new RegExp(String(MAX_TASK_CHARS + 1)).test(e.message));
  assert.strictEqual(made, 0); assert.strictEqual(r.busy, false);
});

test('a task of exactly the limit is accepted', async () => {
  const a = gatedAgent(); const r = make(() => a); const p = r.submit('x'.repeat(MAX_TASK_CHARS)); a.finish(); assert.strictEqual((await p).ok, true);
});

// ---- failures must not wedge the UI
test('STUCK-PILL GUARD: an agent that THROWS yields an error result, an error status, and frees the runner', async () => {
  const a = new EventEmitter(); a.run = async () => { a.emit('status', { state: 'thinking', detail: 'Step 1' }); throw new Error('kaboom'); }; a.stop = () => {};
  const r = make(() => a); const seen = events(r, ['status', 'finished']);
  const res = await r.submit('x');
  assert.deepStrictEqual([res.ok, res.stoppedBy], [false, 'error']); assert.match(res.summary, /kaboom/);
  assert.deepStrictEqual(seen.filter(([k]) => k === 'status').at(-1)[1].state, 'error', 'the LAST status the pill sees is an error, not "thinking"');
  assert.strictEqual(r.busy, false);
  const b = gatedAgent(); const r2 = make(() => b); const p = r2.submit('next'); b.finish(); await p;
});

test('a failure while BUILDING the agent (e.g. bad provider config) is handled the same way', async () => {
  const r = make(() => { throw new Error('no provider configured'); }); const seen = events(r, ['status']);
  const res = await r.submit('x');
  assert.strictEqual(res.ok, false); assert.match(res.summary, /no provider configured/);
  assert.strictEqual(seen.at(-1)[1].state, 'error'); assert.strictEqual(r.busy, false);
});

test('a failing onStart hook does not leave the runner stuck busy', async () => {
  const r = make(() => gatedAgent(), { onStart: () => { throw new Error('gate broken'); } });
  const res = await r.submit('x'); assert.strictEqual(res.ok, false); assert.strictEqual(r.busy, false);
});

// ---- stop
test('STOP: stops the agent AND runs the emergency hook, and reports it did', async () => {
  const a = gatedAgent(); let hooks = 0; const r = make(() => a, { onStop: () => { hooks++; } });
  const p = r.submit('x'); await tick();
  assert.strictEqual(r.stop(), true);
  assert.deepStrictEqual([a.stopped, hooks], [1, 1]);
  a.finish({ ok: false, summary: 'Stopped by user', steps: 1, stoppedBy: 'user' }); await p;
});

test('STOP with nothing running is a harmless false (no hook, no throw)', () => {
  let hooks = 0; const r = make(() => gatedAgent(), { onStop: () => { hooks++; } });
  assert.strictEqual(r.stop(), false); assert.strictEqual(hooks, 0);
});

test('STOP still runs the emergency hook even if the agent\'s own stop() throws', async () => {
  const a = gatedAgent(); a.stop = () => { throw new Error('agent stop failed'); }; let hooks = 0; const r = make(() => a, { onStop: () => { hooks++; } });
  const p = r.submit('x'); await tick();
  assert.throws(() => r.stop(), /agent stop failed/); assert.strictEqual(hooks, 1, 'input must be locked out regardless');
  a.finish(); await p;
});

test('onStart runs before EVERY task (this is where the emergency stop is cleared)', async () => {
  const order = []; const r = make(() => { const a = gatedAgent(); const run = a.run; a.run = async (t) => { order.push('run'); return run(t); }; setImmediate(() => a.finish()); return a; }, { onStart: () => order.push('start') });
  await r.submit('1'); await r.submit('2');
  assert.deepStrictEqual(order, ['start', 'run', 'start', 'run']);
});

test('busy is already false when "finished" is emitted (listeners may start the next task)', async () => {
  const a = gatedAgent(); const r = make(() => a); let busyAtFinish = null;
  r.on('finished', () => { busyAtFinish = r.busy; });
  const p = r.submit('x'); a.finish(); await p;
  assert.strictEqual(busyAtFinish, false);
});

// ---- continuity
test('CONTEXT: a follow-up soon after a successful task carries that task and its outcome', async () => {
  let t = 1000; const seen = []; const mk = () => { const a = gatedAgent(); a.tasks = seen; setImmediate(() => a.finish({ ok: true, summary: 'Saved report.pdf to Documents', steps: 2, stoppedBy: 'finish' })); return a; };
  const r = make(mk, { now: () => t });
  await r.submit('export the report'); t += 60_000; await r.submit('now email it');
  assert.strictEqual(seen[0], 'export the report', 'the first task has no context');
  assert.match(seen[1], /Earlier you were asked: "export the report" and you reported: "Saved report\.pdf to Documents"/);
  assert.match(seen[1], /New request: now email it$/);
});

test('CONTEXT: expires after the window, and a FAILED task adds none', async () => {
  let t = 0; const seen = []; let n = 0; const mk = () => { const a = gatedAgent(); a.tasks = seen; n++; setImmediate(() => a.finish(n === 2 ? { ok: false, summary: 'failed', steps: 1, stoppedBy: 'error' } : { ok: true, summary: 'ok-' + n, steps: 1, stoppedBy: 'finish' })); return a; };
  const r = make(mk, { now: () => t, contextWindowMs: 10 * 60_000 });
  await r.submit('A'); t = 5 * 60_000; await r.submit('B');           // B sees A; B fails
  assert.match(seen[1], /Earlier you were asked: "A"/);
  t = 5 * 60_000 + 60_000; await r.submit('C');                      // C: the last SUCCESS is still A (5 min ago)...
  assert.match(seen[2], /Earlier you were asked: "A"/, 'B failed, so the context is still A');
  t = 60 * 60_000; await r.submit('D');
  assert.strictEqual(seen[3], 'D', 'an hour later there is no context');
});

test('CONTEXT is clipped so a huge summary cannot balloon the next request', async () => {
  const seen = []; let n = 0; const mk = () => { const a = gatedAgent(); a.tasks = seen; n++; setImmediate(() => a.finish({ ok: true, summary: 's'.repeat(5000), steps: 1, stoppedBy: 'finish' })); return a; };
  const r = make(mk); await r.submit('A'); await r.submit('B');
  assert.ok(seen[1].length < 1200, `follow-up grew to ${seen[1].length} chars`);
  assert.match(seen[1], /…/);
});

test('maxTaskChars lets another runner (the coding area) take longer requests, and a negative window turns the "earlier you were asked" hint off', async () => {
  const { TaskRunner } = require('../src/main/runner');
  const { EventEmitter } = require('node:events');
  const seen = [];
  const mk = () => { const a = new EventEmitter(); a.run = async (t) => { seen.push(t); return { ok: true, summary: 'done', steps: 1 }; }; a.stop = () => {}; return a; };
  const r = new TaskRunner({ createAgent: mk, maxTaskChars: 10, contextWindowMs: -1 });
  await assert.rejects(() => r.submit('x'.repeat(11)), /limit is 10/);
  await r.submit('first'); await r.submit('second');
  assert.deepStrictEqual(seen, ['first', 'second'], 'no hint about the earlier task was added');
  const long = new TaskRunner({ createAgent: mk, maxTaskChars: 20000 });
  assert.strictEqual((await long.submit('y'.repeat(9000))).ok, true);
});
