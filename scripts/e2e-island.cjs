'use strict';
// END-TO-END for the island's prompt and approval question: the REAL DockWindow, page, preload and
// ApprovalBroker, driven with REAL keyboard and mouse events. Nothing is mocked except the agent itself
// (we play its part by calling broker.request / dw.setStatus). Exits non-zero on any failure.
//   xvfb-run -a electron scripts/e2e-island.cjs --no-sandbox --disable-gpu
const electron = require('electron');
const { app, ipcMain, screen } = electron;
const fs = require('node:fs'); const path = require('node:path');
const { DockWindow, attachPageEvents } = require('../src/main/overlay/window');
const { ApprovalBroker } = require('../src/main/approvals');
const { wireApprovals } = require('../src/main/wiring');
const { CONFIG } = require('../src/main/overlay/dock');
const { installLifecycle } = require('../src/main/lifecycle');
app.disableHardwareAcceleration(); installLifecycle(app);

const SHOTS = process.env.SHOT_DIR || '/tmp/shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
// NEVER `await` a broker promise directly: it may only settle when the 60s timeout fires, which turns a broken
// keyboard path into a slow PASS (a timeout also answers "no"). Wait a bounded time and report what happened.
const within = (p, ms = 1500) => Promise.race([p, sleep(ms).then(() => ({ pending: true }))]);
const check = (name, ok, extra = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`); };

app.whenReady().then(async () => {
  const actions = []; let wiring;
  const broker = new ApprovalBroker({ timeoutMs: 60_000 });
  const dw = new DockWindow({
    electron, getPrefs: () => ({ edge: 'top', along: 0.5 }), isBusy: () => false,
    onAction: (name, payload) => { actions.push([name, payload]); if (name === 'approval-answer') wiring.answer(payload); },
  });
  wiring = wireApprovals({ broker, dock: dw });
  attachPageEvents(ipcMain, dw);
  const win = dw.create(); const wc = win.webContents;
  wc.on('console-message', (_e, l, m) => { if (l >= 2) console.log('  [page error]', m); });
  await new Promise((r) => wc.once('did-finish-load', r)); await sleep(300);

  const q = (js) => wc.executeJavaScript(js);
  const S = (o) => wc.sendInputEvent(o);
  const type = async (text) => { for (const ch of text) { const key = ch === ' ' ? 'Space' : ch; S({ type: 'keyDown', keyCode: key }); S({ type: 'char', keyCode: ch }); S({ type: 'keyUp', keyCode: key }); await sleep(15); } };
  const press = async (key) => { S({ type: 'keyDown', keyCode: key }); if (key === 'Enter') S({ type: 'char', keyCode: '\r' }); S({ type: 'keyUp', keyCode: key }); await sleep(60); };
  const rectOf = (sel) => q(`(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,b:r.bottom,r:r.right}})()`);
  const clickOn = async (sel) => { const r = await rectOf(sel); const x = Math.round(r.x + r.w / 2), y = Math.round(r.y + r.h / 2); S({ type: 'mouseMove', x, y }); S({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); S({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }); await sleep(80); };
  const snap = async (name) => { fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, `island-${name}.png`), (await wc.capturePage()).toPNG()); };
  const state = () => q(`({prompting: document.body.classList.contains('prompting'), approving: document.body.classList.contains('approving'), active: document.activeElement && document.activeElement.id, value: document.getElementById('prompt').value, allowDisabled: document.getElementById('btn-allow').disabled, label: document.getElementById('label').textContent, acts: document.querySelectorAll('#activity li').length})`);
  const bounds = () => win.getBounds();
  const wa = () => screen.getPrimaryDisplay().workArea;

  // ------------------------------------------------------------------ 1. prompt
  dw.click(); await sleep(400);
  let st = await state();
  check('the prompt is visible in the island', st.prompting, JSON.stringify(st));
  check('the prompt has keyboard focus', st.active === 'prompt', `active=${st.active}`);

  await type('open the calculator');
  st = await state();
  check('REAL key events type into the prompt', st.value === 'open the calculator', JSON.stringify(st.value));
  check('typing marks the user as engaged', dw.engaged === true);

  dw.pointerLeave(); await sleep(1000);      // pointer gone for longer than the hide delay (450ms)
  check('the island does NOT hide while the user is typing', dw.dock.phase === 'island', `phase=${dw.dock.phase}`);
  await snap('1-prompt');

  await press('Enter'); await sleep(150);
  check('Enter submits the text to the main process', actions.some(([n, p]) => n === 'submit-task' && p === 'open the calculator'), JSON.stringify(actions));
  st = await state();
  check('...and clears the box', st.value === '', JSON.stringify(st.value));

  // ------------------------------------------------------------------ 2. busy: prompt hides, engaged clears
  dw.setStatus({ state: 'thinking', detail: 'Step 1' }); await sleep(250);
  st = await state();
  check('while the agent works the prompt is hidden', !st.prompting, JSON.stringify(st));
  check('...and "engaged" is cleared (the island may hide again)', dw.engaged === false, `engaged=${dw.engaged}`);
  const before = actions.length;
  await type('x'); await press('Enter');
  check('nothing can be submitted while it works', actions.length === before, `${before} -> ${actions.length}`);

  dw.setStatus({ state: 'acting', detail: 'run_shell' }); await sleep(150);

  // ------------------------------------------------------------------ 3. approval: a rm -rf
  const cmd = 'ls -la ~/Downloads && rm -rf ~/Downloads/old-installers';
  const p1 = broker.request({ tool: 'run_shell', command: cmd, cwd: '/home/u' }); await sleep(400);
  st = await state();
  check('a question appears and the prompt is hidden', st.approving && !st.prompting, JSON.stringify(st));
  check('the pill says it needs approval', /approval/i.test(st.label), st.label);
  check('the command is shown EXACTLY', (await q(`document.getElementById('ap-body').textContent`)) === cmd);
  check('the risk hint is shown', /deletes files/.test(await q(`document.getElementById('ap-risks').textContent`)));
  check('focus is on DENY, never on Allow', st.active === 'btn-deny', `active=${st.active}`);
  check('Allow starts DISABLED', st.allowDisabled === true);
  await snap('2-approval');

  await clickOn('#btn-allow');
  check('a real click on Allow inside the first half-second does NOTHING', broker.pending !== null && !actions.some(([n, p]) => n === 'approval-answer' && p.allow), JSON.stringify(actions.filter(([n]) => n === 'approval-answer')));
  await sleep(700);
  st = await state();
  check('Allow becomes usable after the delay', st.allowDisabled === false);

  st = await state();
  check('(focus trap) after clicking the disabled Allow, focus is back on Deny', st.active === 'btn-deny', `active=${st.active}`);
  await press('Enter'); await sleep(250);
  const r1 = await within(p1);
  check('ENTER with focus on Deny answers NO, promptly, BECAUSE THE USER SAID SO (not a timeout)', r1.allow === false && r1.reason === 'The user said no.', JSON.stringify(r1));
  st = await state();
  check('the question is gone afterwards', !st.approving, JSON.stringify(st));
  check('the pill is not left saying "Needs your approval"', !/approval/i.test(st.label), st.label);

  // ------------------------------------------------------------------ 4. approval answered with a real click
  const p2 = broker.request({ tool: 'run_shell', command: 'echo hello' }); await sleep(800);
  await clickOn('#btn-allow'); await sleep(200);
  { const r = await within(p2); check('a real click on Allow (after the delay) approves', r.allow === true, JSON.stringify(r)); }
  st = await state();
  check('after approving, the pill shows the command running', /running a command/i.test(st.label), st.label);
  check('...and does not log the action twice', st.acts <= 1, `activity rows=${st.acts}`);

  // ------------------------------------------------------------------ 5. a LONG command: nothing may be hidden
  const long = 'echo start; ' + 'harmless-padding '.repeat(120) + '; rm -rf ~/precious';
  const baseH = bounds().height;
  const p3 = broker.request({ tool: 'run_shell', command: long }); await sleep(1000);      // longer than ARM_MS: the delay has passed
  st = await state();
  const bodyInfo = await q(`(()=>{const e=document.getElementById('ap-body');return {len:e.textContent.length, endsWith:e.textContent.endsWith('rm -rf ~/precious'), scrollable:e.scrollHeight>e.clientHeight}})()`);
  check('a ~2000-character command is in the page COMPLETE, including its last words', bodyInfo.len === long.length && bodyInfo.endsWith, JSON.stringify(bodyInfo));
  check('the box is scrollable (the tail is out of sight)', bodyInfo.scrollable, JSON.stringify(bodyInfo));
  const btn = await rectOf('#ap-buttons'); const inner = await q('window.innerHeight');
  check('the Allow / Deny buttons are on screen (the island grew instead of clipping them)', btn.b <= inner, `buttons bottom=${Math.round(btn.b)} window=${inner}`);
  const b = bounds(), w = wa();
  check('the island grew taller', b.height > baseH, `${baseH} -> ${b.height}`);
  check('...and stays inside the work area', b.y >= w.y && b.y + b.height <= w.y + w.height && b.x >= w.x && b.x + b.width <= w.x + w.width, JSON.stringify(b));

  // ---- the SCROLL-TO-END rule
  check('SCROLL RULE: after the delay Allow is STILL disabled, because the tail has not been seen', (await state()).allowDisabled === true);
  check('SCROLL RULE: and the user is told why', /Scroll to the end/.test(await q(`document.getElementById('ap-hint').textContent`)));
  await snap('3-approval-long');
  await clickOn('#btn-allow'); await sleep(200);
  check('SCROLL RULE: a real click on the locked Allow does nothing', (await within(p3, 400)).pending === true && broker.pending !== null);
  // scroll the box with the REAL mouse wheel until it reaches the end
  const bx = await rectOf('#ap-body'); const wx = Math.round(bx.x + bx.w / 2), wy = Math.round(bx.y + bx.h / 2);
  let scrolled = 0;
  for (let i = 0; i < 12 && !(await q(`(()=>{const e=document.getElementById('ap-body');return e.scrollTop+e.clientHeight>=e.scrollHeight-4})()`)); i++) {
    S({ type: 'mouseWheel', x: wx, y: wy, deltaX: 0, deltaY: -240, canScroll: true }); await sleep(80); scrolled++;
  }
  const atEnd = await q(`(()=>{const e=document.getElementById('ap-body');return {top:e.scrollTop, end:e.scrollTop+e.clientHeight>=e.scrollHeight-4}})()`);
  check('(setup) real mouse-wheel events scrolled the box to its end', atEnd.end && atEnd.top > 0, `wheel events=${scrolled} ${JSON.stringify(atEnd)}`);
  check('SCROLL RULE: once the end has been seen, Allow unlocks', (await state()).allowDisabled === false);
  check('SCROLL RULE: and the hint disappears', (await q(`document.getElementById('ap-hint').textContent`)) === '');
  await snap('3b-approval-long-scrolled');
  // scrolling back UP locks it again: the rule is about what is on screen NOW, not a one-way latch
  S({ type: 'mouseWheel', x: wx, y: wy, deltaX: 0, deltaY: 2400, canScroll: true }); await sleep(150);
  check('SCROLL RULE: scrolling back to the top locks Allow again', (await state()).allowDisabled === true);
  for (let i = 0; i < 12; i++) { S({ type: 'mouseWheel', x: wx, y: wy, deltaX: 0, deltaY: -240, canScroll: true }); await sleep(60); }
  await sleep(150);

  await press('Escape'); await sleep(250);
  { const r = await within(p3); check('ESCAPE during a question means NO, by the user (it must not just hide the island)', r.allow === false && r.reason === 'The user said no.', JSON.stringify(r)); }
  check('...and the island is still there', dw.dock.phase === 'island', `phase=${dw.dock.phase}`);
  await sleep(500);
  check('the island shrinks back once the question is gone', bounds().height < b.height, `${b.height} -> ${bounds().height}`);

  // ------------------------------------------------------------------ 6. a question while the island is HIDDEN
  dw.dock.dismiss(); await sleep(250);
  check('(setup) the island is hidden', dw.dock.phase === 'hidden');
  const p4 = broker.request({ tool: 'write_file', path: '/home/u/x.sh', bytes: 30, preview: '#!/bin/sh\necho hi\n' }); await sleep(500);
  check('a question opens the island by itself', dw.dock.phase === 'island', `phase=${dw.dock.phase}`);
  check('a file question shows the path and size', /x\.sh/.test(await q(`document.getElementById('ap-target').textContent`)) && /30 bytes/.test(await q(`document.getElementById('ap-note').textContent`)));
  await snap('4-approval-file');

  // ------------------------------------------------------------------ 7. STOP answers every open question
  broker.cancelAll('Stopped by the user.');
  { const r = await within(p4); check('Stop answers the open question with NO', r.allow === false && r.reason === 'Stopped by the user.', JSON.stringify(r)); }
  await sleep(200);
  check('...and clears it from the screen', !(await state()).approving);

  // ------------------------------------------------------------------ 8. the prompt comes back
  dw.setStatus({ state: 'done', detail: 'All finished.' }); await sleep(500);
  st = await state();
  check('after a task finishes the prompt returns for a follow-up', st.prompting && st.active === 'prompt', JSON.stringify(st));
  await snap('5-done-with-prompt');
  const bb = bounds();
  check('reply + prompt fit: the prompt bar is fully on screen', (await rectOf('#promptbar')).b <= (await q('window.innerHeight')), `island ${bb.width}x${bb.height}`);

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} island end-to-end checks passed`);
  dw.destroy(); app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('E2E crashed:', e); app.exit(2); });
