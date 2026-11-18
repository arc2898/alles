'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { fakeElectron } = require('./helpers/fake-electron');
const { App } = require('../src/main/app');
const { tmpDir } = require('./helpers/tmp');

/**
 * The workspace window inside the REAL App (only electron is faked): that its requests are served to its own page and nobody else's,
 * that questions from the coding area appear in that window and not on the pill, that launching with --window opens it, that the pill's
 * tasks are remembered in History, and that quitting leaves nothing running. Each part has its own tests; this file is for the seams.
 */
const live = [];
test.afterEach(() => { while (live.length) { try { live.pop()._teardown(); } catch { /* already down */ } } });

function makeApp() {
  const dir = tmpDir('alles-wsapp-');
  const { electron, internals } = fakeElectron();
  const app = new App({ electron, userDataDir: dir });
  live.push(app);
  app.create();
  return { app, electron, internals, dir };
}
const wsChannels = (internals) => internals.handledChannels().filter((c) => c.startsWith('ws:'));
const scripted = (replies) => { let i = 0; return { chat: async () => { const r = replies[Math.min(i++, replies.length - 1)]; return { response: { content: r.say || null, toolCalls: r.calls || [], finishReason: 'stop' }, label: 'fake' }; } }; };

test('every workspace channel is registered, and EVERY one refuses the pill\'s page, the Settings page and strangers', async () => {
  const { app, internals } = makeApp();
  const channels = wsChannels(internals);
  assert.ok(channels.length >= 20, `only ${channels.length} channels`);
  app.openSettings = undefined;
  const settingsWin = app.settingsWindow.open();
  const strangers = { 'the pill page': app.dockWindow.win.webContents, 'the Settings page': settingsWin.webContents, 'an unknown renderer': { id: 99 }, 'no sender': undefined, 'null sender': null };
  const before = JSON.stringify(app.settings.get());
  for (const channel of channels) for (const [who, sender] of Object.entries(strangers)) {
    assert.deepStrictEqual(await internals.invoke(channel, {}, sender), { ok: false, error: 'Not allowed.' }, `${channel} answered ${who}`);
  }
  assert.strictEqual(JSON.stringify(app.settings.get()), before, 'a refused request changes nothing');
  assert.deepStrictEqual(app.history.list(), []);
});

test('the real workspace page IS served', async () => {
  const { app, internals } = makeApp();
  const win = app.openWorkspace();
  const r = await internals.invoke('ws:state', undefined, win.webContents);
  assert.strictEqual(r.ok, true);
  assert.ok(r.settings.speech && r.settings.code && r.settings.history);
  assert.ok(Array.isArray(r.providers) && r.providers.every((p) => Object.keys(p).sort().join() === 'id,label'), 'providers by id and label only');
  assert.ok(!JSON.stringify(r).includes('baseUrl') && !JSON.stringify(r).includes('keys'));
});

test('launching: --window opens the workspace window, a plain relaunch (and --show) toggles the island', async () => {
  const { app, internals } = makeApp();
  assert.strictEqual(app.workspace.isOpen, false);
  app.handleLaunch(['electron', '/app', '--window']);
  assert.strictEqual(app.workspace.isOpen, true);
  assert.strictEqual(internals.windows.length, 2, 'the pill and the workspace');
  app.handleLaunch(['electron', '/app', '--window']);
  assert.strictEqual(internals.windows.length, 2, 'asking again reuses the window');
  const before = app.dockWindow.dock.phase;
  app.handleLaunch(['electron', '/app', '--show']);
  assert.notStrictEqual(app.dockWindow.dock.phase, before, 'the island toggled');
  app.handleLaunch(undefined);                    // never throws on odd input
});

test('a question from the coding area appears in the workspace window, NOT on the pill, and answering it lets the work go on', async () => {
  const { app, internals } = makeApp();
  const win = app.openWorkspace();
  const sent = []; win.webContents.send = (ch, p) => sent.push([ch, p]);
  const home = fs.realpathSync(tmpDir('alles-wsapp-home-')); const root = path.join(home, 'proj'); fs.mkdirSync(root);
  const { Project } = require('../src/main/code/tools');
  app.code.makeProject = (r) => new Project(r, { home });
  app.settings.update({ code: { autonomy: 'ask' } });
  app._createRouter = () => scripted([{ calls: [{ id: 'c1', name: 'write_file', arguments: { path: 'a.txt', content: 'hello' } }] }, { calls: [{ id: 'c2', name: 'finish', arguments: { summary: 'wrote it' } }] }]);
  assert.strictEqual((await internals.invoke('ws:code-open', root, win.webContents)).ok, true);
  const pillShown = []; const realShow = app.dockWindow.showApproval.bind(app.dockWindow); app.dockWindow.showApproval = (q) => { pillShown.push(q); realShow(q); };
  const done = internals.invoke('ws:code-submit', 'write a.txt', win.webContents);
  await new Promise((r) => setTimeout(r, 30));
  const q = sent.map((s) => s[1]).find((p) => p && p.type === 'approval');
  assert.ok(q, 'the workspace window was asked');
  assert.strictEqual(q.question.tool, 'write_file'); assert.strictEqual(pillShown.length, 0, 'the pill was not');
  assert.notStrictEqual(app.dockWindow.lastStatus.state, 'waiting', 'the pill does not claim to need approval');
  assert.deepStrictEqual(await internals.invoke('ws:approval-answer', { id: q.question.id, allow: true }, win.webContents), { ok: true });
  const out = await done;
  assert.deepStrictEqual([out.ok, out.summary], [true, 'wrote it']);
  assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'hello');
  assert.ok(sent.some((s) => s[1] && s[1].type === 'approval-gone' && s[1].id === q.question.id), 'the card is withdrawn');
  assert.ok(sent.some((s) => s[1] && s[1].type === 'code' && s[1].payload.type === 'finished'));
  assert.strictEqual(app.settings.get().code.lastProject, fs.realpathSync(root), 'the folder is remembered');
});

test('a question from the PILL\'s own task still goes to the pill', async () => {
  const { app } = makeApp();
  app.runner.running = true;                         // a pill task is in progress
  const shown = []; app.dockWindow.showApproval = (q) => shown.push(q);
  app.broker.request({ tool: 'run_shell', command: 'ls', cwd: '/x' });
  assert.strictEqual(shown.length, 1);
  app.runner.running = false; app.broker.cancelAll('test');
});

test('the coding area cannot start while the pill is working, and the pill cannot start while coding is', async () => {
  const { app } = makeApp();
  const home = fs.realpathSync(tmpDir('alles-wsapp-home-')); const root = path.join(home, 'p'); fs.mkdirSync(root);
  const { Project } = require('../src/main/code/tools');
  app.code.makeProject = (r) => new Project(r, { home });
  app.code.open(root);
  app.runner.running = true;
  assert.match((await app.code.submit('go')).summary, /busy with a task from the pill/);
  app.runner.running = false;
  app.code.runner.running = true;                    // coding in progress
  const statuses = []; const real = app.dockWindow.setStatus.bind(app.dockWindow); app.dockWindow.setStatus = (s) => { statuses.push(s); real(s); };
  app._onIslandAction('submit-task', 'do something');
  assert.ok(statuses.some((s) => s.state === 'error' && /busy coding/.test(s.detail)));
  assert.strictEqual(app.runner.busy, false, 'the pill task was not started');
  app.code.runner.running = false;
});

test('the pill\'s tasks are remembered in History (kind "task"): what was asked, the steps, and the result', async () => {
  const { app } = makeApp();
  app._createAgent = () => { const { EventEmitter } = require('node:events'); const a = new EventEmitter(); a.run = async () => { a.emit('tool', { name: 'click', args: { x: 1, y: 2 }, result: 'clicked', error: false }); return { ok: true, summary: 'Opened the file.', steps: 1 }; }; a.stop = () => {}; return a; };
  app._onIslandAction('submit-task', 'open my notes');
  await new Promise((r) => setTimeout(r, 30));
  const [s] = app.history.list();
  assert.strictEqual(s.kind, 'task');
  const ev = app.history.get(s.id).events;
  assert.deepStrictEqual(ev.map((e) => e.kind + (e.name ? `:${e.name}` : '')), ['user', 'tool:click', 'assistant']);
  assert.strictEqual(ev[2].text, 'Opened the file.');
  // a refused (empty) request is not saved
  app._onIslandAction('submit-task', '   ');
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(app.history.list().length, 1);
});

test('with history off, pill tasks and chats are not saved; keys held by the app never reach a saved file', async () => {
  const { app, dir } = makeApp();
  app.keyStore.add('nvidia-primary', 'nvapi-SUPERSECRETKEYVALUE1234');
  const id = app.history.create({ title: 'k' });
  app.history.append(id, { kind: 'assistant', text: 'the key is nvapi-SUPERSECRETKEYVALUE1234' });
  app.history.flush();
  const files = fs.readdirSync(path.join(dir, 'history'));
  for (const f of files) assert.ok(!fs.readFileSync(path.join(dir, 'history', f), 'utf8').includes('SUPERSECRETKEYVALUE'), f);
  app.settings.update({ history: { enabled: false } });
  const before = app.history.list().length;
  app._createAgent = () => { const { EventEmitter } = require('node:events'); const a = new EventEmitter(); a.run = async () => ({ ok: true, summary: 'x', steps: 0 }); a.stop = () => {}; return a; };
  app._onIslandAction('submit-task', 'anything');
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(app.history.list().length, before);
});

test('closing the workspace window stops its coding task and its speech; quitting tears everything down without throwing', async () => {
  const { app, internals } = makeApp();
  const win = app.openWorkspace();
  let codeStopped = 0; let spoke = 0;
  app.code.stop = () => { codeStopped++; }; Object.defineProperty(app.code, 'busy', { get: () => true });
  app.speaker.stop = () => { spoke++; };
  win.destroy();
  assert.strictEqual(codeStopped, 1); assert.ok(spoke >= 1);
  assert.doesNotThrow(() => app._teardown());
  assert.ok(wsChannels(internals).length === 0, 'its channels are removed');
});
