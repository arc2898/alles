'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { checkComputer, withTimeout } = require('../src/main/doctor');

// ---------------------------------------------------------------- fakes

const GNOME = { desktop: 'GNOME', session: 'wayland', backend: { placementHonoured: true } };
const screenOk = { capture: async () => ({ width: 1366, height: 768, modelWidth: 1280, modelHeight: 720 }) };
function inputFake({ fail = null, info = { name: 'gnome', label: "GNOME's own input", unicode: true }, hang = false } = {}) {
  const calls = [];
  return {
    calls,
    resume() { calls.push('resume'); },
    moveBy(dx, dy) { calls.push(['moveBy', dx, dy]); if (hang) return new Promise(() => {}); return fail ? Promise.reject(fail) : Promise.resolve(); },
    info() { calls.push('info'); return info; },
    close() { calls.push('close'); },
  };
}
const READY = [{ id: 'nvidia', label: 'NVIDIA', enabled: true, ready: true, problem: null, keys: [{ id: 'a', persisted: true }] }];
const KEYRING = { mode: 'keyring' };
const states = (r) => Object.fromEntries(r.checks.map((c) => [c.id, c.state]));
const byId = (r, id) => r.checks.find((c) => c.id === id);
const all = (o = {}) => checkComputer({ info: GNOME, screen: screenOk, input: inputFake(), providers: READY, keyStatus: KEYRING, ...o });

// ---------------------------------------------------------------- the healthy case

test('a healthy GNOME desktop: every check is ok, in a fixed order, with plain words', async () => {
  const r = await all();
  assert.deepStrictEqual(r.checks.map((c) => c.id), ['desktop', 'window', 'screenshot', 'input', 'providers', 'keys']);
  assert.deepStrictEqual(Object.values(states(r)), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
  assert.deepStrictEqual(r.summary, { problems: 0, warnings: 0, skipped: 0, text: 'Everything is ready.' });
  assert.match(byId(r, 'desktop').detail, /GNOME on Wayland/);
  assert.match(byId(r, 'screenshot').detail, /1366x768 pixels; the AI model is sent a smaller copy, 1280x720/);
  assert.match(byId(r, 'input').detail, /GNOME's own input is ready\. While ALLES works, GNOME shows a screen-sharing indicator.*Stop/);
  assert.match(byId(r, 'providers').detail, /NVIDIA is ready/);
});

test('every check has the same shape: id, title, a known state, and text', async () => {
  const r = await all({ screen: { capture: async () => { throw new Error('nope'); } }, providers: [] });
  for (const c of r.checks) {
    assert.deepStrictEqual(Object.keys(c).sort(), ['detail', 'fix', 'id', 'state', 'title']);
    assert.ok(['ok', 'warn', 'problem', 'skipped'].includes(c.state), c.state);
    assert.ok(typeof c.title === 'string' && c.title && typeof c.detail === 'string' && c.detail && typeof c.fix === 'string');
  }
});

test('it never throws, even with nothing at all to look at', async () => {
  const r = await checkComputer({});
  assert.ok(Array.isArray(r.checks) && r.checks.length === 6);
  assert.strictEqual(byId(r, 'screenshot').state, 'problem');
  assert.strictEqual(byId(r, 'input').state, 'problem');
  assert.strictEqual(byId(r, 'providers').state, 'problem');
});

// ---------------------------------------------------------------- screenshots

test('a missing screenshot tool: a problem that says what to install', async () => {
  const msg = 'No screenshot tool found for GNOME. Install gnome-screenshot  (Ubuntu/Debian: sudo apt install gnome-screenshot; Fedora: sudo dnf install gnome-screenshot).';
  const r = await all({ screen: { capture: async () => { throw new Error(msg); } } });
  const c = byId(r, 'screenshot');
  assert.strictEqual(c.state, 'problem');
  assert.strictEqual(c.detail, msg.replace(/\s+/g, ' '), 'the message already says what to do: it is shown as it is (extra spaces closed up)');
  assert.match(r.summary.text, /^1 thing needs fixing/);
});

test('a screenshot that fails for another reason says why, and suggests the screen lock', async () => {
  const r = await all({ screen: { capture: async () => { throw new Error('gnome-screenshot exited OK but produced no file (is the screen locked?)'); } } });
  const c = byId(r, 'screenshot');
  assert.strictEqual(c.state, 'problem');
  assert.match(c.detail, /^The screenshot failed: gnome-screenshot exited OK but produced no file/);
  assert.match(c.fix, /screen locked/);
});

test('a screenshot tool that hangs is reported after the time limit, not waited for', async () => {
  const t0 = Date.now();
  const r = await all({ screen: { capture: () => new Promise(() => {}) }, limits: { screenshotMs: 60 } });
  assert.ok(Date.now() - t0 < 2000);
  assert.strictEqual(byId(r, 'screenshot').state, 'problem');
  assert.match(byId(r, 'screenshot').detail, /did not answer within 0 seconds|did not answer within \d+ seconds/);
});

test('a picture of no size is not "working"', async () => {
  const r = await all({ screen: { capture: async () => ({ width: 0, height: 0 }) } });
  assert.strictEqual(byId(r, 'screenshot').state, 'problem');
});

test('when the screen is small enough to send as it is, no "smaller copy" is mentioned', async () => {
  const r = await all({ screen: { capture: async () => ({ width: 1280, height: 720, modelWidth: 1280, modelHeight: 720 }) } });
  assert.doesNotMatch(byId(r, 'screenshot').detail, /smaller copy/);
});

// ---------------------------------------------------------------- mouse and keyboard

test('mouse and keyboard: it opens the connection with a move of nothing, reads what is in use, then lets go', async () => {
  const input = inputFake();
  await all({ input });
  assert.deepStrictEqual(input.calls, ['resume', ['moveBy', 0, 0], 'info', 'close']);
});

test('mouse and keyboard: a failure is a problem with the reason; for ydotool it says how to start its service', async () => {
  const r = await all({ input: inputFake({ fail: new Error('ydotool failed: failed to connect socket /run/user/1000/.ydotool_socket'), info: { name: 'ydotool', label: 'ydotool (virtual keyboard and mouse)', unicode: false } }) });
  const c = byId(r, 'input');
  assert.strictEqual(c.state, 'problem');
  assert.match(c.detail, /^ALLES could not send input: ydotool failed: failed to connect socket/);
  assert.match(c.fix, /ydotoold/);
});

test('mouse and keyboard: a failure of GNOME\'s own input points at the other method', async () => {
  const r = await all({ input: inputFake({ fail: new Error('GNOME input is not available: PipeWire is not running'), info: { name: 'gnome', unicode: true } }) });
  assert.strictEqual(byId(r, 'input').state, 'problem');
  assert.match(byId(r, 'input').fix, /Settings > Mouse & keyboard/);
});

test('mouse and keyboard: automatic mode that had to fall back to ydotool is a warning that says why', async () => {
  const r = await all({ input: inputFake({ info: { name: 'ydotool', label: 'ydotool (virtual keyboard and mouse)', unicode: false, fellBackBecause: 'PipeWire is not running' } }) });
  const c = byId(r, 'input');
  assert.strictEqual(c.state, 'warn');
  assert.match(c.detail, /ydotool .* is in use, because GNOME's own input did not work here \(PipeWire is not running\)/);
});

test('mouse and keyboard: ydotool that works but types only a US keyboard is a warning about that', async () => {
  const r = await all({ input: inputFake({ info: { name: 'ydotool', label: 'ydotool (virtual keyboard and mouse)', unicode: false } }) });
  assert.strictEqual(byId(r, 'input').state, 'warn');
  assert.match(byId(r, 'input').detail, /only what a US keyboard can/);
});

test('mouse and keyboard: a service that hangs is reported after the time limit', async () => {
  const t0 = Date.now();
  const r = await all({ input: inputFake({ hang: true }), limits: { inputMs: 60 } });
  assert.ok(Date.now() - t0 < 2000);
  assert.strictEqual(byId(r, 'input').state, 'problem');
  assert.match(byId(r, 'input').detail, /did not answer within/);
});

test('mouse and keyboard: after the check the connection is let go (so the "sharing" indicator is gone), even after a failure', async () => {
  const input = inputFake({ fail: new Error('boom') });
  await all({ input });
  assert.ok(input.calls.includes('close'));
});

// ---------------------------------------------------------------- a task is running

test('while a task is running the screen and the input are NOT touched, and it says why', async () => {
  const input = inputFake();
  let shots = 0;
  const r = await all({ input, busy: true, screen: { capture: async () => { shots++; return { width: 1, height: 1 }; } } });
  assert.strictEqual(shots, 0);
  assert.deepStrictEqual(input.calls, []);
  assert.strictEqual(byId(r, 'screenshot').state, 'skipped');
  assert.strictEqual(byId(r, 'input').state, 'skipped');
  assert.match(byId(r, 'input').detail, /A task is running/);
  assert.deepStrictEqual(r.summary, { problems: 0, warnings: 0, skipped: 2, text: 'Everything that could be tried works.' });
});

test('a task that starts DURING the check keeps its connection: the check does not close it', async () => {
  const input = inputFake();
  let busy = false;
  input.moveBy = async () => { busy = true; };                                // the task starts while the check is opening the connection
  await all({ input, busy: () => busy });
  assert.ok(!input.calls.includes('close'));
});

test('a task that starts while the SCREENSHOT is being taken: the input is not tried at all (it would release a Stop)', async () => {
  const input = inputFake();
  let busy = false;
  const screen = { capture: async () => { busy = true; return { width: 1366, height: 768 }; } };      // the task starts during the screenshot
  const r = await all({ input, screen, busy: () => busy });
  assert.strictEqual(byId(r, 'screenshot').state, 'ok');
  assert.strictEqual(byId(r, 'input').state, 'skipped');
  assert.match(byId(r, 'input').detail, /A task is running/);
  assert.deepStrictEqual(input.calls, [], 'not even resume(): a Stop pressed during that task must stay pressed');
  assert.strictEqual(r.summary.skipped, 1);
});

test('a busy() that throws counts as busy (the safe answer)', async () => {
  const input = inputFake();
  const r = await all({ input, busy: () => { throw new Error('x'); } });
  assert.strictEqual(byId(r, 'screenshot').state, 'skipped');
  assert.deepStrictEqual(input.calls, []);
});

// ---------------------------------------------------------------- providers and keys

test('providers: none switched on, none ready, some ready', async () => {
  assert.strictEqual(byId(await all({ providers: [] }), 'providers').state, 'problem');
  assert.match(byId(await all({ providers: [{ label: 'NVIDIA', enabled: false }] }), 'providers').detail, /No AI provider is switched on/);

  const none = await all({ providers: [{ id: 'nvidia', label: 'NVIDIA', enabled: true, ready: false, problem: 'Add an API key.', keys: [] }] });
  assert.strictEqual(byId(none, 'providers').state, 'problem');
  assert.match(byId(none, 'providers').detail, /No AI provider is ready\. NVIDIA: Add an API key\./);
  assert.match(byId(none, 'providers').fix, /add an API key/);

  const some = await all({ providers: [...READY, { id: 'grok', label: 'Grok', enabled: true, ready: false, problem: 'Add an API key.', keys: [] }, { id: 'old', label: 'Old', enabled: false, ready: false }] });
  assert.strictEqual(byId(some, 'providers').state, 'ok');
  assert.match(byId(some, 'providers').detail, /^NVIDIA is ready; 1 more is not \(Grok: Add an API key\.\)\.$/);
});

test('keys: kept in memory only is a warning with the count; keyring is fine; a plain file is a warning', async () => {
  const mem = [{ id: 'nvidia', label: 'NVIDIA', enabled: true, ready: true, keys: [{ id: 'a', persisted: false }, { id: 'b', persisted: false }] }];
  const a = await all({ providers: mem, keyStatus: { mode: 'session' } });
  assert.strictEqual(byId(a, 'keys').state, 'warn');
  assert.match(byId(a, 'keys').detail, /Your 2 API keys are kept in memory only/);
  const one = await all({ providers: [{ ...mem[0], keys: [mem[0].keys[0]] }], keyStatus: { mode: 'session' } });
  assert.match(byId(one, 'keys').detail, /Your API key is kept in memory only, so ALLES will ask for it again/);
  assert.strictEqual(byId(await all({ keyStatus: { mode: 'keyring' } }), 'keys').state, 'ok');
  assert.strictEqual(byId(await all({ keyStatus: { mode: 'file' } }), 'keys').state, 'warn');
  assert.strictEqual(byId(await all({ providers: [], keyStatus: { mode: 'session' } }), 'keys').state, 'ok', 'no keys, nothing to lose');
});

// ---------------------------------------------------------------- the desktop and the island

test('desktop: GNOME on X11, KDE, and an unknown desktop are warnings; GNOME on Wayland is fine', async () => {
  assert.strictEqual(byId(await all({ info: { ...GNOME, session: 'x11' } }), 'desktop').state, 'warn');
  assert.match(byId(await all({ info: { ...GNOME, session: 'x11' } }), 'desktop').detail, /ydotool/);
  const kde = byId(await all({ info: { desktop: 'KDE Plasma', session: 'wayland', backend: { placementHonoured: true } } }), 'desktop');
  assert.strictEqual(kde.state, 'warn');
  assert.match(kde.detail, /KDE Plasma on Wayland\. KDE should work .* not been tried on a real KDE desktop/);
  assert.strictEqual(byId(await all({ info: { desktop: 'Linux', session: '' } }), 'desktop').state, 'warn');
  assert.strictEqual(byId(await all({ info: GNOME }), 'desktop').state, 'ok');
});

test('island placement: honoured is fine, not honoured says how to fix it, unknown is a warning', async () => {
  assert.strictEqual(byId(await all({ info: { ...GNOME, backend: { placementHonoured: true } } }), 'window').state, 'ok');
  const no = byId(await all({ info: { ...GNOME, backend: { placementHonoured: false } } }), 'window');
  assert.strictEqual(no.state, 'warn');
  assert.match(no.detail, /runs as a native Wayland app/);
  assert.match(no.fix, /--ozone-platform=x11/);
  const unknown = byId(await all({ info: { ...GNOME, backend: {} } }), 'window');
  assert.strictEqual(unknown.state, 'warn');
  assert.match(unknown.detail, /could not find out whether the island can be placed exactly/);
  assert.doesNotMatch(unknown.detail, /native Wayland/);
});

// ---------------------------------------------------------------- robustness

test('a check that throws is a problem with the reason; the other checks still run', async () => {
  const info = { get desktop() { throw new Error('boom'); }, session: 'wayland', backend: { placementHonoured: true } };
  const r = await all({ info });
  assert.strictEqual(byId(r, 'desktop').state, 'problem');
  assert.match(byId(r, 'desktop').detail, /^This check failed: boom/);
  assert.strictEqual(byId(r, 'screenshot').state, 'ok');
});

test('a very long error message is cut, and line breaks are flattened (it is shown in one place on a page)', async () => {
  const r = await all({ screen: { capture: async () => { throw new Error(`first line\nsecond line ${'x'.repeat(2000)}`); } } });
  const d = byId(r, 'screenshot').detail;
  assert.ok(d.length < 400, `${d.length}`);
  assert.doesNotMatch(d, /\n/);
});

test('summary wording: one problem, several problems, only warnings', async () => {
  const one = await all({ providers: [] });
  assert.match(one.summary.text, /^1 thing needs fixing before ALLES can do its job\.$/);
  const two = await all({ providers: [], screen: { capture: async () => { throw new Error('x'); } } });
  assert.match(two.summary.text, /^2 things need fixing/);
  const inputOnly = await all({ input: inputFake({ fail: new Error('x') }) });
  assert.deepStrictEqual([inputOnly.summary.problems, inputOnly.summary.text], [1, '1 thing needs fixing before ALLES can do its job.']);
  const warn = await all({ info: { ...GNOME, backend: { placementHonoured: false } } });
  assert.deepStrictEqual([warn.summary.problems, warn.summary.warnings], [0, 1]);
  assert.match(warn.summary.text, /^ALLES should work\. 1 thing is worth a look\.$/);
});

test('withTimeout: passes the answer through, rejects when late, and leaves no timer behind', async () => {
  assert.strictEqual(await withTimeout(Promise.resolve(7), 1000, 'x'), 7);
  await assert.rejects(withTimeout(new Promise(() => {}), 30, 'The tool'), /The tool did not answer within/);
  await assert.rejects(withTimeout(Promise.reject(new Error('inner')), 1000, 'x'), /inner/);
});
