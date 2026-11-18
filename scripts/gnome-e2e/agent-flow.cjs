'use strict';
/**
 * The WHOLE of ALLES, from the outside, inside a REAL GNOME Shell:
 *
 *   scripts/gnome-e2e/run.sh 1366x768 node_modules/.bin/electron scripts/gnome-e2e/agent-flow.cjs --no-sandbox --disable-gpu --ozone-platform=x11
 *
 * What is REAL here: the App (settings, key store, provider routes, router, agent, tools, approvals, the island), GNOME's own remote-input
 * service, the real screenshot tool, the real clipboard, and real HTTP. What is SCRIPTED is only the AI model: a small server (fake-model.js)
 * that speaks the dialect NVIDIA, Grok and Gemini speak. It is sent the real screenshots and "looks" at them like a very simple vision model
 * (it finds the text box and the pad of a little test window by their colours), then answers with tool calls for ALLES to carry out.
 * What arrives is read back from the test window's title (target-window.js); the test never looks inside ALLES to see whether it worked.
 *
 * ALLES_E2E_ONLY=1,3    runs only those scenarios:
 *   1 a task from the first screenshot to finish: click, type (with characters the keyboard cannot make), shortcut, drag, scroll
 *   2 approvals: a shell command and a file write ask the person first (yes, and no)
 *   3 providers and keys: the second provider takes over, the second key takes over, everything failing is reported plainly
 *   4 stopping: the Stop button, and Stop on GNOME's sharing indicator in the top bar; the next task works again
 *   5 "Check this computer" (the Settings button): the real screenshot tool and GNOME's own input are tried and let go of again, a missing
 *     key is a problem with a fix, it leaves a running task alone, and it still works after Stop was pressed on the sharing indicator
 *   6 a badly-behaved AI: answers with nothing or is cut off, calls with no ids or the same id, arguments as an object or cut in half,
 *     thinking written into the answer, Stop while a second key is waiting. Real AIs do all of these; the task must carry on or end
 *     plainly, and never leave a conversation the next request is refused for
 *
 * The scripted AI is STRICT in every scenario: it answers a request that breaks the rules of the chat format with a 400 (see
 * fake-model.js), so a request ALLES should never send fails the scenario it happens in, and each scenario also checks `model.violations`.
 * ALLES_E2E_SCALES=2    give the screens this scale first (see input-flow.cjs)
 * ALLES_E2E_MINUTES=10  how long the whole run may take before it is abandoned
 */
const electron = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sleep, waitFor, makeChecks, connectShell } = require('./lib');
const { applyScales, scalesFromEnv } = require('./display');
const { makeTargets } = require('./targets');
const { findColor } = require('./picture');
const { startFakeModel, imagesOf } = require('./fake-model');
const { App } = require('../../src/main/app');
const { pngSize } = require('../../src/main/computer/screen');

const { app: electronApp, clipboard } = electron;
electronApp.disableHardwareAcceleration();
const ROOT = path.resolve(__dirname, '../..');
const ONLY = (process.env.ALLES_E2E_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const on = (n) => !ONLY.length || ONLY.includes(String(n));
const { check, note, summary } = makeChecks();
const { scales: SCALES, scale: SCALE } = scalesFromEnv();

const KEY = 'fake-key-0123456789abcdef';
const UNICODE_TEXT = 'Café ₹500 naïve';                       // "Café ₹500 naïve": the keyboard cannot make these, ALLES pastes them
const PAD = [0x33, 0x55, 0x66];                                              // the colours of the test window (target-window.js)
const BOX = [0xff, 0xf7, 0xd6];

const tmpDirs = [];
const mk = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };

async function main() {
  const shell = await connectShell();
  const ok = (v) => !!v;
  const ensureDesktop = async () => { for (let k = 0; k < 20 && (await shell.eval('Main.overview.visible')) === 'true'; k++) { await shell.eval('Main.overview.hide()'); await sleep(300); } };
  await ensureDesktop();
  if (SCALES.length) {
    const got = await applyScales(SCALES);
    note(`the screens were given scales ${got.map((g) => `${g.scale}${g.scale !== g.wanted ? ` (${g.wanted} asked; ${g.mode} allows ${g.supported.join('/')})` : ''}`).join(', ')}`);
    check('the screens have the scale that was asked for (a small screen allows only scale 1: use a bigger one, e.g. 2732x1536 for scale 2, 1600x1000 for 1.25)', got.every((g) => Math.abs(g.scale - g.wanted) < 1e-6), got.map((g) => `${g.scale} of ${g.wanted}`).join(', '));
    await ensureDesktop();
  }
  const targets = makeTargets({ shell, note, root: ROOT });

  // ---------------------------------------------------------------- the model, and ALLES itself

  let script = async () => ({ status: 500, body: 'no script for this scenario' });
  const model = await startFakeModel((ctx) => script(ctx));
  const dir = mk('alles-agent-e2e-');
  const env = { ...process.env, XDG_CURRENT_DESKTOP: 'GNOME', XDG_SESSION_TYPE: 'wayland' };
  const alles = new App({ electron, userDataDir: dir, env, shortcut: 'Control+Alt+Space', backend: { platform: 'x11', reason: 'e2e', placementHonoured: true, xAvailable: true } });
  alles.create();

  const toolLog = []; const states = []; const routeLabels = [];
  alles.runner.on('tool', (t) => toolLog.push(t));
  alles.runner.on('status', (s) => states.push(s.state));
  alles.runner.on('route', (r) => routeLabels.push(r.label));
  const route = (id, label, prefix) => ({ id, kind: 'custom', label, model: 'scripted-1', baseUrl: `${model.url}${prefix}`, enabled: true });
  /** Use these provider routes, each with these keys (the key store lives in memory here: there is no keyring on this desktop). */
  const useRoutes = (routes, keys) => {
    for (const r of alles.settings.get().providers.routes) for (const k of alles.keyStore.list(r.id)) alles.keyStore.remove(r.id, k.id);
    alles.settings.update({ providers: { routes } });
    for (const r of routes) for (const k of (keys[r.id] || [KEY])) alles.keyStore.add(r.id, k);
  };
  const runTask = async (text) => {
    toolLog.length = 0; states.length = 0; routeLabels.length = 0;
    const t0 = Date.now();
    const result = await alles.runner.submit(text);
    return { result, ms: Date.now() - t0 };
  };
  const reset = () => model.reset();
  const sharing = async () => Number(await shell.eval('Main.panel.statusArea.screenSharing._handles.size'));
  const stage = async () => { const [w, h] = (await shell.eval('global.stage.width + "x" + global.stage.height')).split('x').map(Number); return { w, h }; };

  /** What the screenshot shows of one colour inside the test window, in the picture the model was sent. Throws (the script fails) when it is not there. */
  async function look(ctx, id, colour, what) {
    const png = ctx.lastImage();
    if (!png) throw new Error('the model was sent no picture');
    const t = await targets.wanted(id);
    const { w: stageW } = await stage();
    const k = pngSize(png).width / (stageW * SCALE);                        // the model's picture is smaller than the desktop's own
    const rect = { x: t.frame.x * SCALE * k, y: t.frame.y * SCALE * k, w: t.frame.w * SCALE * k, h: t.frame.h * SCALE * k };
    const hit = findColor(png, colour, { tol: 4, rect });
    if (!hit.n) throw new Error(`the model cannot find the ${what} in its picture`);
    return { ...hit, k, state: t };
  }
  /** Where a point of the model's picture is in the test window's page, worked out from where the pad is (the pad's page position is known). */
  const pageOf = (pad, mx, my) => ({ x: pad.state.pad[0] + (mx - pad.x0) / (SCALE * pad.k), y: pad.state.pad[1] + (my - pad.y0) / (SCALE * pad.k) });
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const lastTool = (ctx, i = 1) => { const m = ctx.messages.filter((x) => x.role === 'tool'); return m.length >= i ? String(m[m.length - i].content) : ''; };

  // ================================================================ 1. one task, from the first screenshot to the finish
  if (on(1)) {
    const t = await targets.openTarget({ id: '1', x: 100, y: 120 });
    useRoutes([route('custom', 'Scripted model', '/a/v1')], {});
    reset();
    clipboard.writeText('KEEP ME');
    const memo = {};
    script = async (ctx) => {
      switch (ctx.n) {
        case 1: return { calls: [{ name: 'screenshot', args: {} }] };
        case 2: { const box = await look(ctx, '1', BOX, 'text box'); return { calls: [{ name: 'mouse_click', args: { x: Math.round(box.cx), y: Math.round(box.cy) } }] }; }
        case 3: return { calls: [{ name: 'type_text', args: { text: UNICODE_TEXT } }] };
        case 4: memo.afterFirstText = (await stateAfter(t, (n) => n.text === UNICODE_TEXT, 4000)) || (await t.state()); return { calls: [{ name: 'press_keys', args: { keys: 'ctrl+a' } }] };
        case 5: return { calls: [{ name: 'type_text', args: { text: 'second try' } }] };
        case 6: return { calls: [{ name: 'screenshot', args: {} }] };
        case 7: {
          const pad = await look(ctx, '1', PAD, 'pad'); memo.pad = pad;
          const from = { x: Math.round(pad.x0 + pad.w * 0.3), y: Math.round(pad.y0 + pad.h * 0.3) };
          const to = { x: Math.round(pad.x0 + pad.w * 0.7), y: Math.round(pad.y0 + pad.h * 0.7) };
          memo.from = pageOf(pad, from.x, from.y); memo.to = pageOf(pad, to.x, to.y);
          return { calls: [{ name: 'mouse_drag', args: { from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y } }] };
        }
        case 8: {
          const pad = memo.pad;
          memo.sharingMidTask = await sharing();
          return { calls: [{ name: 'mouse_scroll', args: { x: Math.round(pad.cx), y: Math.round(pad.cy), direction: 'down', amount: 3 } }] };
        }
        case 9: return { calls: [{ name: 'screenshot', args: {} }] };
        case 10: return { calls: [{ name: 'finish', args: { summary: 'Typed, dragged and scrolled.' } }] };
        default: return { status: 500, body: 'too many requests' };
      }
    };
    const { result, ms } = await runTask('Put some text in the test window\'s text box, drag across its grey pad and scroll it.');
    note(`1. the task took ${(ms / 1000).toFixed(1)} s for ${result.steps} steps`);
    check('1. the task finishes by itself, when the model calls finish', result.ok && result.stoppedBy === 'finish' && result.summary === 'Typed, dragged and scrolled.', JSON.stringify(result));
    check('1. ...in ten model requests (one per step)', model.requests.length === 10 && result.steps === 10, `${model.requests.length} requests, ${result.steps} steps`);
    check('1. no tool reported an error', toolLog.every((x) => !x.error), toolLog.filter((x) => x.error).map((x) => `${x.name}: ${x.result}`).join(' | '));
    check('1. every tool told the model what it did', /^Screenshot \d+x\d+/.test(toolLog[0].result) && /left-clicked/.test(toolLog[1].result) && /^Typed \d+ chars/.test(toolLog[2].result) && /Pressed ctrl\+a/.test(toolLog[3].result) && /Dragged from/.test(toolLog.find((x) => x.name === 'mouse_drag').result) && /Scrolled down 3 notches/.test(toolLog.find((x) => x.name === 'mouse_scroll').result), toolLog.map((x) => x.result).join(' | '));

    const first = model.requests[0].body;
    const names = first.tools.map((x) => x.function.name);
    check('1. the model was offered every tool, including scrolling and dragging', ['screenshot', 'mouse_move', 'mouse_click', 'mouse_scroll', 'mouse_drag', 'type_text', 'press_keys', 'run_shell', 'read_file', 'write_file', 'list_dir', 'wait', 'finish'].every((n) => names.includes(n)), names.join(', '));
    check('1. ...and told that type_text can enter any character (GNOME direct input pastes what the keyboard cannot make)', /pasting/.test(first.tools.find((x) => x.function.name === 'type_text').function.description));
    check('1. the system prompt names the assistant and the desktop', /ALLES/.test(first.messages[0].content) && /GNOME/.test(first.messages[0].content));
    check('1. every request carried the provider key (and only that)', model.requests.every((r) => r.key === KEY));
    const lastBody = model.requests[model.requests.length - 1].body;
    const pics = lastBody.messages.filter((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')).length;
    const stubs = lastBody.messages.filter((m) => typeof m.content === 'string' && m.content.startsWith('[older screenshot removed')).length;
    check('1. only the newest two screenshots are sent again; the first was replaced by a note', pics === 2 && stubs === 1, `${pics} pictures, ${stubs} notes`);
    const sentSize = pngSize(imagesOf(model.requests[1].body.messages)[0]);
    check('1. the picture sent to the model is no bigger than 1280 pixels on its long side', Math.max(sentSize.width, sentSize.height) <= 1280 && Math.max(sentSize.width, sentSize.height) >= 1000, `${sentSize.width}x${sentSize.height}`);

    const end = await t.state();
    check('1. the first text, with characters the keyboard cannot make, arrived exactly', memo.afterFirstText && memo.afterFirstText.text === UNICODE_TEXT, memo.afterFirstText ? JSON.stringify(memo.afterFirstText.text) : 'no state');
    check('1. Ctrl+A then typing replaced it', end.text === 'second try', JSON.stringify(end.text));
    check('1. the clipboard holds what it held before the task', clipboard.readText() === 'KEEP ME', JSON.stringify(clipboard.readText()));
    check('1. two presses and two releases reached the window (the click, the start of the drag)', end.c === 2 && end.u === 2, `${end.c} presses, ${end.u} releases`);
    check('1. the drag started where the model pointed (in the window\'s own page)', end.last && memo.from && near(end.last[0], memo.from.x, 3) && near(end.last[1], memo.from.y, 3), end.last && memo.from ? `aimed at ${Math.round(memo.from.x)},${Math.round(memo.from.y)}; the window saw ${end.last[0]},${end.last[1]}` : 'no data');
    check('1. ...moved with the button held, and let go where the model pointed', end.moves > 0 && end.lastUp && memo.to && near(end.lastUp[0], memo.to.x, 3) && near(end.lastUp[1], memo.to.y, 3), end.lastUp && memo.to ? `${end.moves} moves; aimed at ${Math.round(memo.to.x)},${Math.round(memo.to.y)}; it came up at ${end.lastUp[0]},${end.lastUp[1]}` : 'no data');
    check('1. three wheel notches down are 360 pixels', end.ws && end.ws[0] === 0 && end.ws[1] === 360, end.ws ? `moved ${end.ws[0]},${end.ws[1]}` : 'no data');
    check('1. the island went through thinking and acting and ended on done', states.includes('thinking') && states.includes('acting') && alles.dockWindow.lastStatus.state === 'done', `${[...new Set(states)].join(',')}; the pill says ${alles.dockWindow.lastStatus.state}`);
    check('1. GNOME\'s sharing indicator was on while ALLES held the mouse and keyboard...', memo.sharingMidTask >= 1, `${memo.sharingMidTask} sessions`);
    const gone = await waitFor(async () => (await sharing()) === 0, { timeout: 5000, interval: 200 });
    check('1. ...and went away when the task ended', ok(gone), `${await sharing()} sessions still open`);
    const settingsText = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
    const keysFile = path.join(dir, 'keys.json');
    check('1. the provider key is in neither settings.json nor a keys file', !settingsText.includes(KEY) && (!fs.existsSync(keysFile) || !fs.readFileSync(keysFile, 'utf8').includes(KEY)));
    await targets.closeAll();
  }

  // ================================================================ 2. approvals
  if (on(2)) {
    useRoutes([route('custom', 'Scripted model', '/a/v1')], {});
    const denied = path.join(dir, 'denied.txt');
    const answer = (q, allow) => alles._onIslandAction('approval-answer', { id: q.id, allow });
    const ask = () => new Promise((resolve) => alles.broker.once('request', resolve));

    reset();
    let seen = '';
    script = async (ctx) => {
      if (ctx.n === 1) return { calls: [{ name: 'run_shell', args: { command: 'echo hello-from-alles' } }] };
      seen = lastTool(ctx);
      return { calls: [{ name: 'finish', args: { summary: 'ran it' } }] };
    };
    let asked = ask();
    let pending = runTask('Say hello from the shell.');
    let q = await Promise.race([asked, sleep(15000).then(() => null)]);
    check('2. a shell command asks the person first: the question shows the whole command', ok(q) && q.title === 'Run this shell command?' && q.body === 'echo hello-from-alles', q ? `${q.title} / ${q.body}` : 'no question came');
    check('2. ...the pill says it is waiting, and the question is on the island', ok(q) && alles.dockWindow.lastStatus.state === 'waiting', alles.dockWindow.lastStatus.state);
    if (q) answer(q, true);
    let r = await pending;
    check('2. after yes the command ran, and the model was given its output', r.result.ok && /exit_code: 0/.test(seen) && /hello-from-alles/.test(seen), seen.slice(0, 120));
    check('2. the pill no longer says it is waiting', alles.dockWindow.lastStatus.state === 'done', alles.dockWindow.lastStatus.state);

    reset();
    seen = '';
    script = async (ctx) => {
      if (ctx.n === 1) return { calls: [{ name: 'write_file', args: { path: denied, content: 'secret plans' } }] };
      seen = lastTool(ctx);
      return { calls: [{ name: 'finish', args: { summary: 'did not write it' } }] };
    };
    asked = ask();
    pending = runTask('Write a file.');
    q = await Promise.race([asked, sleep(15000).then(() => null)]);
    check('2. writing a file asks first, and says which file', ok(q) && q.title === 'Write this file?' && q.target === denied, q ? `${q.title} / ${q.target}` : 'no question came');
    if (q) answer(q, false);
    r = await pending;
    check('2. after no the file was NOT written, and the model was told not to retry', r.result.ok && !fs.existsSync(denied) && /DENIED/.test(seen) && /Do not retry/.test(seen), seen.slice(0, 160));

    reset();
    script = async (ctx) => (ctx.n === 1 ? { calls: [{ name: 'run_shell', args: { command: 'echo never' } }] } : { calls: [{ name: 'finish', args: { summary: 'stopped' } }] });
    asked = ask();
    pending = runTask('A command nobody answers.');
    q = await Promise.race([asked, sleep(15000).then(() => null)]);
    alles._onIslandAction('stop-agent');
    r = await Promise.race([pending, sleep(8000).then(() => null)]);
    check('2. Stop while a question is open answers it with no and ends the task', ok(r) && !r.result.ok && r.result.stoppedBy === 'user' && alles.broker.depth === 0, r ? JSON.stringify(r.result) : 'the task did not end');
  }

  // ================================================================ 3. providers and keys
  if (on(3)) {
    const finishNow = { calls: [{ name: 'finish', args: { summary: 'done' } }] };

    // 3a. the first provider is down: the second one takes over, and the person is told which one answered
    useRoutes([route('first', 'First provider', '/p/v1'), route('second', 'Second provider', '/b/v1')], { first: [KEY], second: ['second-key-0123456789'] });
    reset();
    script = async (ctx) => (ctx.path === '/p/v1' ? { status: 500, body: 'the first provider is down' } : finishNow);
    let { result } = await runTask('Anything.');
    check('3. when the first provider is down the second one answers', result.ok && routeLabels.includes('Second provider'), `${JSON.stringify(result)}; routes: ${routeLabels.join(',')}`);
    check('3. ...each provider was asked with ITS OWN key', model.requests.length === 2 && model.requests[0].path === '/p/v1' && model.requests[0].key === KEY && model.requests[1].path === '/b/v1' && model.requests[1].key === 'second-key-0123456789', model.requests.map((x) => `${x.path}:${x.key.slice(0, 6)}`).join(' '));

    // 3b. one provider with two keys: the first is refused, the second is used
    const BAD = 'bad-key-0123456789abcdef'; const GOOD = 'good-key-0123456789abcdef';
    useRoutes([route('only', 'Only provider', '/a/v1')], { only: [BAD, GOOD] });
    reset();
    script = async (ctx) => (ctx.key === BAD ? { status: 401, body: 'invalid key' } : finishNow);
    ({ result } = await runTask('Anything.'));
    check('3. a refused key is skipped: the next key of the same provider answers', result.ok && model.requests.map((x) => x.key).join(',') === `${BAD},${GOOD}`, `${JSON.stringify(result)}; keys tried: ${model.requests.map((x) => x.key.slice(0, 4)).join(',')}`);

    // 3c. everything fails: one plain message, and no key in it
    useRoutes([route('first', 'First provider', '/p/v1'), route('second', 'Second provider', '/b/v1')], { first: [KEY], second: ['second-key-0123456789'] });
    reset();
    script = async (ctx) => ({ status: 503, body: `overloaded (your key was ${ctx.key})` });      // a provider that echoes the key it was sent
    ({ result } = await runTask('Anything.'));
    check('3. when every provider fails the task ends with one plain message', !result.ok && result.stoppedBy === 'error' && /Model request failed/.test(result.summary) && alles.dockWindow.lastStatus.state === 'error', `${JSON.stringify(result)}; the pill says ${alles.dockWindow.lastStatus.state}`);
    check('3. ...and the message does not contain a key', !result.summary.includes(KEY) && !result.summary.includes('second-key-0123456789') && !JSON.stringify(alles.dockWindow.lastStatus).includes(KEY), result.summary.slice(0, 200));

    // 3d. the model just answers in words: that is the final answer
    useRoutes([route('custom', 'Scripted model', '/a/v1')], {});
    reset();
    script = async () => ({ text: 'There is nothing to do.' });
    ({ result } = await runTask('Anything.'));
    check('3. a plain answer without tool calls ends the task with that answer', result.ok && result.stoppedBy === 'answer' && result.summary === 'There is nothing to do.', JSON.stringify(result));
  }

  // ================================================================ 4. stopping
  if (on(4)) {
    useRoutes([route('custom', 'Scripted model', '/a/v1')], {});
    const t = await targets.openTarget({ id: '1', x: 100, y: 120 });

    // 4a. the Stop button while the model is still thinking: the request is dropped and the task ends at once
    reset();
    const abortedBefore = model.aborted;
    script = async () => ({ delayMs: 20000, calls: [{ name: 'finish', args: { summary: 'too late' } }] });
    let pending = runTask('Something slow.');
    await sleep(1500);
    const t0 = Date.now();
    alles._onIslandAction('stop-agent');
    let r = await Promise.race([pending, sleep(8000).then(() => null)]);
    check('4. Stop while the model is thinking ends the task within a moment', ok(r) && !r.result.ok && r.result.stoppedBy === 'user' && Date.now() - t0 < 3000, r ? `${JSON.stringify(r.result)} after ${Date.now() - t0} ms` : 'the task did not end');
    const dropped = await waitFor(() => model.aborted > abortedBefore, { timeout: 3000, interval: 50 });       // (the model's side hears the hang-up a moment later)
    check('4. ...the pill says stopped, and the request to the model was dropped', alles.dockWindow.lastStatus.state === 'stopped' && ok(dropped), `${alles.dockWindow.lastStatus.state}; dropped ${model.aborted - abortedBefore}`);

    // 4b. Stop on GNOME's sharing indicator in the top bar, while ALLES waits for something on screen
    reset();
    script = async (ctx) => {
      if (ctx.n === 1) return { calls: [{ name: 'screenshot', args: {} }] };
      if (ctx.n === 2) { const pad = await look(ctx, '1', PAD, 'pad'); return { calls: [{ name: 'mouse_click', args: { x: Math.round(pad.cx), y: Math.round(pad.cy) } }] }; }
      if (ctx.n === 3) return { calls: [{ name: 'wait', args: { seconds: 25 } }] };
      return { calls: [{ name: 'finish', args: { summary: 'carried on after the stop' } }] };
    };
    pending = runTask('Click the pad, then wait.');
    const open = await waitFor(async () => (await sharing()) >= 1 && model.requests.length >= 3, { timeout: 40000, interval: 200 });
    check('4. the sharing indicator is on while ALLES waits', ok(open), `${await sharing()} sessions; ${model.requests.length} requests`);
    await sleep(500);
    const t1 = Date.now();
    await shell.eval('Main.panel.statusArea.screenSharing._stopSharing()');
    r = await Promise.race([pending, sleep(12000).then(() => null)]);
    check('4. Stop on the sharing indicator ends the task within a moment, even in the middle of a wait', ok(r) && !r.result.ok && r.result.stoppedBy === 'user' && Date.now() - t1 < 4000, r ? `${JSON.stringify(r.result)} after ${Date.now() - t1} ms` : 'the task did not end');
    check('4. ...the pill says stopped', alles.dockWindow.lastStatus.state === 'stopped', alles.dockWindow.lastStatus.state);

    // 4c. Stop in the middle of a shell command: the command is killed too (not just left running), and the question is not asked again
    reset();
    const SLEEP = `28.${process.pid % 1000}7`;
    const running = () => fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).filter((d) => { try { const a = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0'); return a[0].endsWith('sleep') && a[1] === SLEEP; } catch { return false; } }).length;
    script = async (ctx) => (ctx.n === 1 ? { calls: [{ name: 'run_shell', args: { command: `echo begun; sleep ${SLEEP}; echo late` } }] } : { calls: [{ name: 'finish', args: { summary: 'not reached' } }] });
    const asked = new Promise((resolve) => alles.broker.once('request', resolve));
    pending = runTask('Run a slow command.');
    const q = await Promise.race([asked, sleep(15000).then(() => null)]);
    if (q) alles._onIslandAction('approval-answer', { id: q.id, allow: true });
    const started = await waitFor(() => running() >= 1, { timeout: 10000, interval: 100 });
    check('4. the slow command is running (the person said yes)', ok(started), `${running()} running`);
    const t2 = Date.now();
    alles._onIslandAction('stop-agent');
    r = await Promise.race([pending, sleep(8000).then(() => null)]);
    check('4. Stop in the middle of a shell command ends the task within a moment', ok(r) && !r.result.ok && r.result.stoppedBy === 'user' && Date.now() - t2 < 3000, r ? `${JSON.stringify(r.result)} after ${Date.now() - t2} ms` : 'the task did not end');
    const killed = await waitFor(() => running() === 0, { timeout: 3000, interval: 100 });
    check('4. ...and the command itself is gone, not left running in the background', ok(killed), `${running()} still running`);
    check('4. ...the model was not asked anything more after Stop', model.requests.length === 1, `${model.requests.length} requests`);

    // 4d. the next task works again: a person who pressed Stop wants ALLES to be usable afterwards
    reset();
    script = async (ctx) => {
      if (ctx.n === 1) return { calls: [{ name: 'screenshot', args: {} }] };
      if (ctx.n === 2) { const pad = await look(ctx, '1', PAD, 'pad'); return { calls: [{ name: 'mouse_click', args: { x: Math.round(pad.cx), y: Math.round(pad.cy) } }] }; }
      return { calls: [{ name: 'finish', args: { summary: 'carried on after the stop' } }] };
    };
    const mid = await t.state();
    ({ result: r } = await runTask('Click the pad once more.'));
    const after = await stateAfter(t, (n) => n.c === mid.c + 1 && n.u === mid.u + 1);
    check('4. after Stop the next task works: the click lands', r.ok && ok(after), JSON.stringify(r));
    await targets.closeAll();
  }

  // ================================================================ 5. "Check this computer"
  if (on(5)) {
    const pointer = async () => shell.eval('global.get_pointer().slice(0, 2).join(",")');
    const rowsOf = (res) => Object.fromEntries(res.checks.map((c) => [c.id, c]));

    // 5a. a healthy desktop: the real screenshot tool, GNOME's own input, one provider that has a key
    useRoutes([route('custom', 'Scripted model', '/a/v1')], {});
    reset();
    const pointerBefore = await pointer();
    const logged = []; const realLog = console.log;                              // what ALLES says it is doing, to see that the check really opens the session
    console.log = (...a) => { logged.push(a.join(' ')); realLog(...a); };
    let res;
    try { res = await alles.checkComputer(); } finally { console.log = realLog; }
    let by = rowsOf(res);
    check('5. the check really opened GNOME\'s input session (it did not just claim the input works)', logged.some((l) => /GNOME input session open/.test(l)), logged.slice(-3).join(' | ') || 'nothing was logged');
    check('5. the check lists its six rows, in order', res.checks.map((c) => c.id).join() === 'desktop,window,screenshot,input,providers,keys', res.checks.map((c) => c.id).join());
    check('5. it names the desktop: GNOME on Wayland', by.desktop.state === 'ok' && /GNOME on Wayland/.test(by.desktop.detail), JSON.stringify(by.desktop));
    const size = /The screen is (\d+)x(\d+) pixels/.exec(by.screenshot.detail);
    const st = await stage();
    note(`5. the desktop is ${st.w}x${st.h} (logical); the first screen's scale is ${await shell.eval('global.display.get_monitor_scale(0)')}; the test asked for ${SCALE}`);
    // The Shell counts its stage in physical pixels at a whole-number scale (2732 wide on a 2732x1536 screen at scale 2) and in logical ones
    // at a fractional scale (1280 wide on a 1600x1000 screen at 1.25): the screenshot must be the real screen either way.
    const sameAsStage = (got, stageV) => Math.abs(got - stageV) <= 1 || Math.abs(got - stageV * SCALE) <= 1;
    check('5. the real screenshot tool works, and the size it reports is the real size of the screen', by.screenshot.state === 'ok' && !!size && sameAsStage(Number(size[1]), st.w) && sameAsStage(Number(size[2]), st.h), `${by.screenshot.detail} (the stage is ${st.w}x${st.h}, the scale ${SCALE})`);
    check('5. GNOME\'s own input opens ("ready", no setup)', by.input.state === 'ok' && /GNOME direct input.* is ready/.test(by.input.detail), JSON.stringify(by.input));
    check('5. the check moved nothing: the pointer is exactly where it was', (await pointer()) === pointerBefore, `${pointerBefore} -> ${await pointer()}`);
    check('5. the providers row sees the provider that has a key', by.providers.state === 'ok' && /Scripted model is ready/.test(by.providers.detail), JSON.stringify(by.providers));
    check('5. nothing needs fixing and nothing was skipped (a key kept only in memory is the one remark this desktop may get)', res.summary.problems === 0 && res.summary.skipped === 0 && ['ok', 'warn'].includes(by.keys.state), JSON.stringify(res.summary));
    const let5 = await waitFor(async () => (await sharing()) === 0, { timeout: 5000, interval: 200 });
    check('5. the check let go of the connection: GNOME\'s sharing indicator is gone again', ok(let5), `${await sharing()} sessions still open`);
    check('5. the check never asked the AI model anything', model.requests.length === 0, `${model.requests.length} requests`);

    // 5b. no API key: said plainly, with what to do - and the rest is still reported as fine
    useRoutes([route('custom', 'Scripted model', '/a/v1')], { custom: [] });
    const noKey = await alles.checkComputer();
    by = rowsOf(noKey);
    check('5. with no API key the providers row is a problem, and says where to fix it', by.providers.state === 'problem' && /Settings > Providers/.test(by.providers.fix) && noKey.summary.problems === 1, JSON.stringify(by.providers));
    check('5. ...while the screen and the connection are still reported as working', by.screenshot.state === 'ok' && by.input.state === 'ok');

    // 5c. a task is running: the check leaves the screen and the connection alone, and says so
    useRoutes([route('custom', 'Scripted model', '/a/v1')], {});
    reset();
    script = async () => ({ delayMs: 20000, calls: [{ name: 'finish', args: { summary: 'too late' } }] });
    const slow = runTask('Something slow.');
    await sleep(1500);
    const sessionsBefore = await sharing();
    by = rowsOf(await alles.checkComputer());
    check('5. while a task is running, the screenshot and the mouse and keyboard are "not tried", and it says a task is running', by.screenshot.state === 'skipped' && by.input.state === 'skipped' && /A task is running/.test(by.input.detail), JSON.stringify([by.screenshot.state, by.input.state]));
    check('5. ...the task was not disturbed: still thinking, and the check opened no session of its own', states[states.length - 1] === 'thinking' && (await sharing()) === sessionsBefore && alles.runner.busy === true, `${states.join(',')}; ${await sharing()} sessions (${sessionsBefore} before)`);
    alles._onIslandAction('stop-agent');
    const slowEnd = await Promise.race([slow, sleep(8000).then(() => null)]);
    check('5. ...and Stop still ends that task', ok(slowEnd) && slowEnd.result.stoppedBy === 'user', slowEnd ? JSON.stringify(slowEnd.result) : 'the task did not end');

    // 5d. after Stop was pressed on GNOME's sharing indicator, the check works again (it releases that Stop first)
    const t5 = await targets.openTarget({ id: '1', x: 100, y: 120 });
    reset();
    script = async (ctx) => {
      if (ctx.n === 1) return { calls: [{ name: 'screenshot', args: {} }] };
      if (ctx.n === 2) { const pad = await look(ctx, '1', PAD, 'pad'); return { calls: [{ name: 'mouse_click', args: { x: Math.round(pad.cx), y: Math.round(pad.cy) } }] }; }
      if (ctx.n === 3) return { calls: [{ name: 'wait', args: { seconds: 25 } }] };
      return { calls: [{ name: 'finish', args: { summary: 'not reached' } }] };
    };
    const held = runTask('Click the pad, then wait.');
    const waiting = await waitFor(async () => (await sharing()) >= 1 && model.requests.length >= 3, { timeout: 40000, interval: 200 });
    await sleep(500);
    await shell.eval('Main.panel.statusArea.screenSharing._stopSharing()');
    const heldEnd = await Promise.race([held, sleep(12000).then(() => null)]);
    check('5. (set-up) Stop on the sharing indicator ended the task', ok(waiting) && ok(heldEnd) && heldEnd.result.stoppedBy === 'user', heldEnd ? JSON.stringify(heldEnd.result) : 'the task did not end');
    by = rowsOf(await alles.checkComputer());
    check('5. after that Stop the check still finds the mouse and keyboard working: it released the old Stop', by.input.state === 'ok', JSON.stringify(by.input));
    const let5d = await waitFor(async () => (await sharing()) === 0, { timeout: 5000, interval: 200 });
    check('5. ...and let go of the connection again', ok(let5d), `${await sharing()} sessions still open`);
    void t5;
    await targets.closeAll();
  }

  // ================================================================ 6. a badly-behaved AI
  if (on(6)) {
    const t = await targets.openTarget({ id: '1', x: 100, y: 120 });
    const KEY2 = 'second-key-0123456789abcdef';
    useRoutes([route('custom', 'Scripted model', '/a/v1')], {});
    const clickPad = async (ctx, extra = {}) => { const pad = await look(ctx, '1', PAD, 'pad'); return { name: 'mouse_click', args: { x: Math.round(pad.cx), y: Math.round(pad.cy) }, ...extra }; };
    const askedIds = (body) => body.messages.filter((m) => m.role === 'assistant' && m.tool_calls).flatMap((m) => m.tool_calls.map((c) => c.id));
    const answeredIds = (body) => body.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
    const noViolations = (label) => check(`6. ${label}: the strict AI never received a request that breaks the rules of the chat format`, model.violations.length === 0, model.violations.map((v) => `request ${v.n}: ${v.problems.join('; ')}`).join(' | '));
    let result;

    // 6a. a thinking AI runs out of room and says nothing; after that its calls come with no ids and the arguments as an object
    reset();
    const before = await t.state();
    script = async (ctx) => {
      switch (ctx.n) {
        case 1: return { text: '', finishReason: 'length' };
        case 2: return { calls: [{ name: 'screenshot', args: {}, id: null }] };
        case 3: return { calls: [await clickPad(ctx, { id: null, argsAsObject: true })] };
        default: return { calls: [{ name: 'finish', args: { summary: 'recovered' } }] };
      }
    };
    ({ result } = await runTask('Click the pad once.'));
    check('6. an empty answer (the AI ran out of room) does not end the task: it is asked again and carries on to the end', result.ok && result.stoppedBy === 'finish' && result.summary === 'recovered' && model.requests.length === 4, `${JSON.stringify(result)}; ${model.requests.length} requests`);
    const again = model.requests[1] ? model.requests[1].body.messages : [];
    check('6. ...the empty answer was not put back into the conversation; the request to carry on is part of the task message', again.map((m) => m.role).join() === 'system,user' && /cut off because it was too long/.test(String(again[1] && again[1].content)), again.map((m) => m.role).join());
    check('6. ...every request said how much the AI may write (8192 tokens)', model.requests.length > 0 && model.requests.every((r) => r.body.max_tokens === 8192), model.requests.map((r) => r.body.max_tokens).join());
    const last = model.requests[3] ? model.requests[3].body : { messages: [] };
    check('6. calls that came with no id were given ids, and each is answered by its own', askedIds(last).length === 2 && new Set(askedIds(last)).size === 2 && askedIds(last).join() === answeredIds(last).join(), `asked ${askedIds(last).join()}, answered ${answeredIds(last).join()}`);
    const landed = await stateAfter(t, (n) => n.c === before.c + 1 && n.u === before.u + 1);
    check('6. ...and the arguments sent as an object (not as text) were understood: the click landed', ok(landed), JSON.stringify(await t.state()));
    noViolations('6a');

    // 6b. an answer that stops in the middle of a call's arguments: nothing is done, the AI is told why, and it tries again
    reset();
    const mid = await t.state(); const memo = {};
    script = async (ctx) => {
      switch (ctx.n) {
        case 1: return { calls: [{ name: 'screenshot', args: {} }] };
        case 2: return { calls: [{ name: 'mouse_click', args: '{"x": 12' }], finishReason: 'length' };
        case 3: memo.told = lastTool(ctx); memo.clicksAfterCut = (await t.state()).c; return { calls: [await clickPad(ctx)] };
        default: return { calls: [{ name: 'finish', args: { summary: 'retried' } }] };
      }
    };
    ({ result } = await runTask('Click the pad once.'));
    check('6. a call cut off in the middle of its arguments is NOT carried out: nothing was clicked', memo.clicksAfterCut === mid.c, `${memo.clicksAfterCut} presses (${mid.c} before)`);
    check('6. ...the AI is told its reply was cut off, so the call is incomplete and nothing was done', /not valid JSON/.test(memo.told || '') && /cut off because it was too long/.test(memo.told || '') && /nothing was done/.test(memo.told || ''), (memo.told || '').slice(0, 200));
    const retried = await stateAfter(t, (n) => n.c === mid.c + 1 && n.u === mid.u + 1);
    check('6. ...and when it sends the click again the task goes on and finishes', result.ok && result.summary === 'retried' && ok(retried), `${JSON.stringify(result)}; ${JSON.stringify(await t.state())}`);
    noViolations('6b');

    // 6c. an AI that keeps answering with nothing: the task ends in plain words - and the next task is not held up by it
    reset();
    script = async () => ({ text: '', finishReason: 'length' });
    ({ result } = await runTask('Never answered.'));
    check('6. an AI that answers with nothing three times in a row ends the task with a plain explanation (and is not asked a fourth time)', !result.ok && result.stoppedBy === 'error' && /ran out of room/.test(result.summary) && model.requests.length === 3 && alles.dockWindow.lastStatus.state === 'error', `${JSON.stringify(result)}; ${model.requests.length} requests; the pill says ${alles.dockWindow.lastStatus.state}`);
    check('6. ...the message is words only: no key, no "undefined"', !result.summary.includes(KEY) && !/undefined|\[object|null/.test(result.summary), result.summary);
    noViolations('6c');
    reset();
    script = async () => ({ calls: [{ name: 'finish', args: { summary: 'fine again' } }] });
    ({ result } = await runTask('Anything.'));
    check('6. the next task starts at once and works', result.ok && result.summary === 'fine again' && alles.dockWindow.lastStatus.state === 'done', JSON.stringify(result));

    // 6d. Stop while the AI is thinking, with a SECOND KEY waiting: Stop ends it at once and no second request is sent
    // (the second key used to be tried with the person's Stop already pressed: the task then waited for THAT answer, and it cost tokens)
    useRoutes([route('custom', 'Scripted model', '/a/v1')], { custom: [KEY, KEY2] });
    reset();
    script = async () => ({ delayMs: 20000, calls: [{ name: 'finish', args: { summary: 'too late' } }] });
    const slow = runTask('Something slow.');
    await sleep(1500);
    const tStop = Date.now();
    alles._onIslandAction('stop-agent');
    const slowEnd = await Promise.race([slow, sleep(8000).then(() => null)]);
    check('6. Stop with a second key waiting ends the task within a moment', ok(slowEnd) && slowEnd.result.stoppedBy === 'user' && Date.now() - tStop < 3000, slowEnd ? `${JSON.stringify(slowEnd.result)} after ${Date.now() - tStop} ms` : 'the task did not end');
    await sleep(1500);
    check('6. ...and the second key was NEVER used: only the one request went out', model.requests.length === 1 && model.requests[0].key === KEY, `${model.requests.length} requests; keys ${model.requests.map((r) => r.key.slice(0, 6)).join(',')}`);
    reset();
    script = async () => ({ calls: [{ name: 'finish', args: { summary: 'right after stop' } }] });
    ({ result } = await runTask('Straight away.'));
    check('6. the next task, right after that Stop, works', result.ok && result.summary === 'right after stop', JSON.stringify(result));
    useRoutes([route('custom', 'Scripted model', '/a/v1')], {});

    // 6e. thinking written into the answer is not shown as the answer; content as a list of parts is read; a refusal is shown
    const answers = [
      ['6. thinking a model writes into its answer is left out of what the person is shown', { text: '<think>The user wants nothing done. I should say so.</think>\n\nNothing to do here.' }, 'Nothing to do here.'],
      ['6. an answer sent as a list of parts is read as one text', { message: { role: 'assistant', content: [{ type: 'text', text: 'Parts ' }, { type: 'text', text: 'answer.' }] } }, 'Parts answer.'],
      ['6. a refusal with no other content is shown as the answer', { message: { role: 'assistant', content: null, refusal: 'I cannot help with that.' } }, 'I cannot help with that.'],
    ];
    for (const [what, reply, expected] of answers) {
      reset();
      script = async () => reply;
      ({ result } = await runTask('Anything.'));
      check(what, result.ok && result.stoppedBy === 'answer' && result.summary === expected, JSON.stringify(result));
    }
    noViolations('6e');

    // 6f. three calls that all carry the same id, one of them for a tool that does not exist (and is named like a property every object has)
    reset();
    script = async (ctx) => (ctx.n === 1
      ? { calls: [{ name: 'wait', args: { seconds: 0 }, id: 'dup' }, { name: 'constructor', args: {}, id: 'dup' }, { name: 'wait', args: { seconds: 0 }, id: 'dup' }] }
      : { calls: [{ name: 'finish', args: { summary: 'answered all three' } }] });
    ({ result } = await runTask('Three things at once.'));
    const second = model.requests[1] ? model.requests[1].body : { messages: [] };
    check('6. three calls with the same id are each answered, by an id of their own', result.ok && askedIds(second).join() === 'dup,dup-2,dup-3' && answeredIds(second).join() === 'dup,dup-2,dup-3', `asked ${askedIds(second).join()}, answered ${answeredIds(second).join()}; ${JSON.stringify(result)}`);
    check('6. ...a tool called "constructor" is an unknown tool, not something that runs', /^Unknown tool "constructor"/.test(String((second.messages.filter((m) => m.role === 'tool')[1] || {}).content)), String((second.messages.filter((m) => m.role === 'tool')[1] || {}).content));
    noViolations('6f');

    // 6g. an AI that reuses the SAME ids in every reply (some servers number their calls from zero each time): no id is ever used twice in a conversation
    reset();
    script = async (ctx) => (ctx.n < 4 ? { calls: [{ name: 'wait', args: { seconds: 0 }, id: 'call_0' }] } : { calls: [{ name: 'finish', args: { summary: 'ids stayed apart' } }] });
    ({ result } = await runTask('Wait three times.'));
    const final = model.requests[model.requests.length - 1] ? model.requests[model.requests.length - 1].body : { messages: [] };
    check('6. an AI that sends the same id in every reply: every call in the conversation still has an id of its own, and its own answer', result.ok && askedIds(final).length === 3 && new Set(askedIds(final)).size === 3 && askedIds(final).join() === answeredIds(final).join(), `asked ${askedIds(final).join()}, answered ${answeredIds(final).join()}`);
    noViolations('6g');
    await targets.closeAll();
  }

  // ================================================================ end
  async function stateAfter(t, pred, timeout = 5000) { return waitFor(async () => { const n = await t.state(); return n && pred(n) ? n : null; }, { timeout, interval: 100 }); }
  await targets.closeAll();
  alles._teardown();
  await model.close();
  shell.close();
  return summary();
}

electronApp.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.error('E2E watchdog: took too long'); electronApp.exit(3); }, Number(process.env.ALLES_E2E_MINUTES || 10) * 60_000);
  let good = false;
  try { good = await main(); } catch (e) { console.error('E2E crashed:', e && e.stack ? e.stack : e); }
  clearTimeout(watchdog);
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  electronApp.exit(good ? 0 : 1);
});
