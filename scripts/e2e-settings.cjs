'use strict';
// END-TO-END: the Settings window, for real. The real App, the real Electron, the real settings page, driven the way a
// person drives it (typing into fields, clicking buttons), with a small local server standing in for an AI provider.
//   xvfb-run -a -s "-screen 0 1920x1080x24" node_modules/electron/dist/electron scripts/e2e-settings.cjs --no-sandbox --disable-gpu
// Optional: SHOT_DIR=/some/dir saves a picture of every section (dark and light). Exits non-zero on any failure.
const electron = require('electron');
const { app, BrowserWindow, nativeTheme } = electron;
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const { App } = require('../src/main/app');

app.disableHardwareAcceleration();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`); };
const SHOTS = process.env.SHOT_DIR || '';

const watchdog = setTimeout(() => { console.error('E2E watchdog: took too long'); app.exit(3); }, 120_000);

async function waitFor(what, fn, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}`);
    await sleep(40);
  }
}

// ---- a stand-in AI provider -------------------------------------------------------------------------------------
const hits = [];
let rejectImages = false;
function startFakeProvider() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let j = {}; try { j = JSON.parse(body); } catch { /* ignore */ }
      hits.push({ auth: req.headers.authorization, model: j.model });
      const hasImage = Array.isArray(j.messages && j.messages[0] && j.messages[0].content);
      if (hasImage && rejectImages) { res.statusCode = 400; res.end('{"error":"images unsupported"}'); return; }
      let message = { role: 'assistant', content: 'OK' };
      if (j.tools) message = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'report_color', arguments: '{"color":"blue"}' } }] };
      else if (hasImage) message = { role: 'assistant', content: 'Red' };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alles-e2e-settings-'));
  const provider = await startFakeProvider();
  const providerUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  const built = new App({ electron, userDataDir: dir, backend: { platform: 'x11', reason: 'electron-default', placementHonoured: true, xAvailable: true } });
  built.create();
  await sleep(300);

  // ---- A. open the way a person does: the gear button on the island (real page -> real preload -> real main) -----
  const before = BrowserWindow.getAllWindows().length;
  await built.dockWindow.win.webContents.executeJavaScript("window.pill.send('open-settings')");
  await waitFor('the Settings window to open', () => BrowserWindow.getAllWindows().length === before + 1);
  const win = built.settingsWindow.win;
  const wc = win.webContents;
  const page = (js) => wc.executeJavaScript(js);
  const consoleErrors = [];
  wc.on('console-message', (_e, level, message) => { if (level >= 2) consoleErrors.push(message); });
  wc.on('render-process-gone', (_e, d) => consoleErrors.push(`render process gone: ${d.reason}`));
  await waitFor('the page to finish loading', () => !wc.isLoading());
  await waitFor('the provider list to appear', () => page("document.querySelectorAll('.route').length"));

  check('the island\'s gear button opens exactly one Settings window', BrowserWindow.getAllWindows().length === before + 1);
  check('the window title is "ALLES Settings"', win.getTitle() === 'ALLES Settings', win.getTitle());

  // ---- B. the page is healthy ---------------------------------------------------------------------------------------
  const bodyColour = await page('getComputedStyle(document.body).backgroundColor');
  check('the stylesheet loaded under the page\'s own security policy', bodyColour === 'rgb(15, 19, 27)' || bodyColour === 'rgb(243, 245, 249)', bodyColour);
  check('the model and page scripts both ran', await page("typeof window.SettingsModel === 'object' && !!document.querySelector('.rail .nav-item')"));
  check('the four default providers are listed, in order', JSON.stringify(await page("[...document.querySelectorAll('.route .card-title')].map(e => e.textContent.replace(/^Provider \\d+: /, ''))")) === JSON.stringify(['NVIDIA', 'NVIDIA (fallback)', 'Grok', 'Gemini']));
  check('the first provider that needs a key is already open', await page("document.querySelector('.route[data-open=\"true\"] [data-fk=\"route:nvidia-primary:newkey\"]') !== null"));
  check('no errors in the page console so far', consoleErrors.length === 0, consoleErrors.join(' | '));

  // ---- C. the window is locked down -----------------------------------------------------------------------------------
  await page("location.href = 'https://example.com/'");
  await sleep(400);
  check('the page cannot navigate away', wc.getURL().startsWith('file://') && wc.getURL().endsWith('settings.html'), wc.getURL());
  check('the page cannot open another window', (await page("window.open('https://example.com/') === null")) === true && BrowserWindow.getAllWindows().length === before + 1);
  await page("(() => { const s = document.createElement('script'); s.textContent = 'window.__inline = 1'; document.head.appendChild(s); })()");
  await sleep(100);
  check('an inline script cannot run (the policy blocks it)', (await page('window.__inline')) === undefined);
  check('the page has no Node: no require, no process', (await page("[typeof require, typeof process, typeof module].join()")) === 'undefined,undefined,undefined');
  check('the page was given only invoke and onChanged', (await page("Object.keys(window.alles).sort().join()")) === 'invoke,onChanged');
  consoleErrors.length = 0;                        // the blocked-script notice above is expected

  // ---- D. adding a key --------------------------------------------------------------------------------------------------
  const KEY = 'nvapi-E2ETESTKEY0123456789abcdef';
  const typeInto = (fk, value) => page(`(() => { const el = document.querySelector('[data-fk="${fk}"]'); el.focus(); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const click = (selector, text) => page(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(selector)})]; const el = els.find((e) => ${text === undefined ? 'true' : `e.textContent.trim() === ${JSON.stringify(text)}`}); if (!el) return false; el.click(); return true; })()`);

  await typeInto('route:nvidia-primary:newkey', 'too short');
  await click('[data-fk="route:nvidia-primary:addkey"]');
  check('a key that is obviously wrong is refused on the page, with a reason', await page("document.querySelector('.card-body [role=alert]:not([hidden])') !== null && document.querySelector('.card-body [role=alert]:not([hidden])').textContent.includes('does not look like an API key')"));
  check('...and nothing was stored', built.keyStore.list('nvidia-primary').length === 0);

  await typeInto('route:nvidia-primary:newkey', KEY);
  await click('[data-fk="route:nvidia-primary:addkey"]');
  await waitFor('the key to be stored', () => built.keyStore.list('nvidia-primary').length === 1);
  await waitFor('the key row to appear', () => page("document.querySelector('.key-row') !== null"));
  const hint = await page("document.querySelector('.key-hint').textContent");
  check('the key was stored through the real key store', built.keyStore.secrets('nvidia-primary')[0] === KEY, `mode ${built.keyStore.mode()}`);
  check('the page shows only a short hint for it', hint === 'nvap…def', hint);
  const html = await page('document.documentElement.outerHTML + document.body.innerText');
  check('the full key is nowhere in the page', !html.includes(KEY) && !html.includes('E2ETESTKEY'));
  check('the key box was emptied after adding', (await page("document.querySelector('[data-fk=\"route:nvidia-primary:newkey\"]').value")) === '');
  check('the provider is no longer waiting for a key', await waitFor('status change', async () => (await page("document.querySelector('.route .chip').textContent")) !== 'Add an API key.'));

  // ---- E. typing a model and address, then Test, against the stand-in provider --------------------------------------------
  await typeInto('route:nvidia-primary:model', 'test-model');
  await typeInto('route:nvidia-primary:baseUrl', providerUrl);
  await waitFor('model and address to be saved', () => { const r = built.settings.get().providers.routes[0]; return r.model === 'test-model' && r.baseUrl === providerUrl; });
  check('the model and address typed on the page were saved', true);
  await click('[data-fk="route:nvidia-primary:testall"]');
  await waitFor('the test verdict', () => page("document.querySelector('.verdict') !== null"), 15000);
  check('Test passes all four checks against a provider that behaves', (await page("document.querySelectorAll('.check[data-state=\"ok\"]').length")) === 4 && (await page("document.querySelector('.verdict').dataset.usable")) === 'true', await page("document.querySelector('.verdict').textContent"));
  check('the provider received the key exactly as typed, and the typed model', hits.length === 4 && hits.every((h) => h.auth === `Bearer ${KEY}` && h.model === 'test-model'), JSON.stringify(hits.map((h) => h.model)));
  check('the status of the provider now reads Ready', (await page("document.querySelector('.route').dataset.tone")) === 'ready');
  await shot('providers-open', { scroll: true });

  rejectImages = true; hits.length = 0;
  await click('[data-fk="route:nvidia-primary:testall"]');
  await waitFor('the second verdict', async () => (await page("document.querySelector('.verdict') && document.querySelector('.verdict').dataset.usable")) === 'false', 15000);
  const failText = await page("document.querySelector('.check[data-state=\"fail\"]') ? document.querySelector('.check[data-state=\"fail\"]').textContent : ''");
  check('a text-only model is reported as such, in plain words', /does not accept images/.test(failText), failText);
  await shot('providers-test-fail', { scroll: true });
  rejectImages = false;

  // a refused address says why and keeps what was typed
  await typeInto('route:nvidia-primary:baseUrl', 'ftp://nope.example/v1');
  await waitFor('the refusal notice', () => page("document.querySelector('.form-grid .field-note[data-tone=\"problem\"]') !== null"));
  check('an address the app refuses is explained, and what was typed stays so the typo can be fixed', (await page("document.querySelector('.form-grid .field-note[data-tone=\"problem\"]').textContent")).includes('https://') && (await page("document.querySelector('[data-fk=\"route:nvidia-primary:baseUrl\"]').value")) === 'ftp://nope.example/v1');
  check('...and the address that was working is still the saved one', built.settings.get().providers.routes[0].baseUrl === providerUrl, built.settings.get().providers.routes[0].baseUrl);
  await typeInto('route:nvidia-primary:baseUrl', providerUrl);
  await waitFor('the notice to clear', async () => !(await page("document.querySelector('.form-grid .field-note[data-tone=\"problem\"]') !== null")));
  check('fixing it clears the notice', true);

  // ---- F. nothing a provider name says can become markup -------------------------------------------------------------------
  const EVIL = '<img src=x onerror="window.__pwned=1"><b>bold</b>';
  await typeInto('route:nvidia-primary:label', EVIL);
  await waitFor('the label to be saved', () => built.settings.get().providers.routes[0].label.startsWith('<img'));
  await sleep(200);
  check('a provider named with HTML is shown as plain text', (await page("document.querySelector('.card-title').textContent")).includes('<img src=x') && (await page("document.querySelectorAll('img, b').length")) === 0);
  check('...and nothing in it ran', (await page('window.__pwned')) === undefined);
  await typeInto('route:nvidia-primary:label', 'NVIDIA');

  // ---- G. order, off, add, remove ----------------------------------------------------------------------------------------------
  await click('[data-fk="route:nvidia-primary:down"]');
  await waitFor('the order to change', () => built.settings.get().providers.routes[0].id === 'nvidia-fallback');
  await sleep(150);
  check('the move-down arrow reorders providers, and the numbers follow', JSON.stringify(await page("[...document.querySelectorAll('.bead')].map(e => e.textContent)")) === JSON.stringify(['1', '2', '3', '4']) && (await page("document.querySelectorAll('.route')[1].querySelector('.card-title').textContent")).endsWith('NVIDIA'));
  await click('[data-fk="route:nvidia-primary:up"]');
  await waitFor('the order to change back', () => built.settings.get().providers.routes[0].id === 'nvidia-primary');

  await page("document.querySelector('[data-fk=\"route:grok:enabled\"]').click()");
  await waitFor('Grok to be turned off', () => built.settings.get().providers.routes.find((r) => r.id === 'grok').enabled === false);
  await sleep(150);
  check('turning a provider off shows "Turned off"', (await page("[...document.querySelectorAll('.route')].find(r => r.querySelector('.card-title').textContent.endsWith('Grok')).querySelector('.chip').textContent")) === 'Turned off');

  await click('.add-provider .btn', '+ Other (OpenAI-compatible)');
  await waitFor('a custom provider to be added', () => built.settings.get().providers.routes.some((r) => r.kind === 'custom'));
  await waitFor('its card to open', () => page("document.querySelector('.route[data-open=\"true\"] [data-fk^=\"route:custom\"]') !== null"));
  check('adding a provider opens its card, ready for a key', true);
  await click('[data-fk="route:custom:rm"]');
  await waitFor('the confirmation', () => page("document.querySelector('.confirm-text') !== null"));
  check('removing asks first', (await page("document.querySelector('.confirm-text').textContent")).startsWith('Remove'));
  await click('[data-fk="route:custom:rm-no"]');
  await sleep(120);
  check('"Keep" keeps it', built.settings.get().providers.routes.some((r) => r.kind === 'custom'));
  await click('[data-fk="route:custom:rm"]');
  await waitFor('the confirmation again', () => page("document.querySelector('[data-fk=\"route:custom:rm-yes\"]') !== null"));
  await click('[data-fk="route:custom:rm-yes"]');
  await waitFor('the provider to go', () => !built.settings.get().providers.routes.some((r) => r.kind === 'custom'));
  check('confirming removes it', true);

  await shot('providers');

  // ---- H. the island section, including a change that happens elsewhere ------------------------------------------------------
  await click('.nav-item', 'Island');
  await waitFor('the Island section', () => page("document.querySelector('#h-island') !== null"));
  await click('.seg-item', 'Left');
  await waitFor('the edge to change', () => built.settings.get().dock.edge === 'left');
  await sleep(500);
  const bounds = built.dockWindow.win.getBounds();
  check('picking an edge moves the real pill window to it', bounds.x < 100, JSON.stringify(bounds));
  check('on a side edge the position buttons say Top, Middle, Bottom', JSON.stringify(await page("[...document.querySelectorAll('[aria-label=\"Position along the edge\"] .seg-item')].map(e => e.textContent)")) === JSON.stringify(['Top', 'Middle', 'Bottom']));
  await click('[aria-label="Position along the edge"] .seg-item', 'Bottom');
  await waitFor('the position to change', () => built.settings.get().dock.along === 1);
  built.settings.update({ dock: { along: 0.37 } });                      // as if the pill had just been dragged
  await waitFor('the page to notice by itself', () => page("[...document.querySelectorAll('.fine')].some(e => e.textContent.includes('dragged the pill'))"), 3000);
  check('a drag done on the pill shows up on the open page by itself', true);
  await click('.btn', 'Reset to top center');
  await waitFor('the reset', () => { const d = built.settings.get().dock; return d.edge === 'top' && d.along === 0.5; });
  check('"Reset to top center" does exactly that (this desktop has nothing on the top edge, so top is the free edge)', true);
  await click('.seg-item', '12-hour');
  await waitFor('12-hour', () => built.settings.get().dock.hour12 === true);
  check('the clock setting is saved', true);
  await page("document.querySelector('[data-fk=\"tray\"]').click()");
  await waitFor('the tray setting', () => built.settings.get().tray.enabled === true);
  check('the tray switch turns the real tray on and off', built.tray.enabled === true);
  await page("document.querySelector('[data-fk=\"tray\"]').click()");
  await waitFor('tray off', () => built.settings.get().tray.enabled === false);
  await shot('island');

  // ---- H2. mouse and keyboard ------------------------------------------------------------------------------------------------------------
  await click('.nav-item', 'Mouse & keyboard');
  await waitFor('the Mouse & keyboard section', () => page("document.querySelector('#h-input') !== null"));
  const radio = (v) => page(`document.querySelector('[data-fk="input-mode:${v}"]').getAttribute('aria-checked')`);
  const inUse = () => page("document.querySelector('[data-role=\"input-status\"]').textContent + ' ' + [...document.querySelectorAll('.fine')].map((e) => e.textContent).join(' ')");
  check('three methods are offered, and Automatic is the one chosen at first', (await page("document.querySelectorAll('[data-fk^=\"input-mode:\"]').length")) === 3 && (await radio('auto')) === 'true');
  check('the page says which method is in use, and what it can type', (await inUse()).includes('ydotool (virtual keyboard and mouse)') && (await inUse()).includes('US keyboard'), (await inUse()).slice(0, 160));
  await click('[data-fk="input-mode:gnome"]');
  await waitFor('GNOME saved', () => built.settings.get().input.backend === 'gnome');
  check('choosing GNOME is saved and the running app switches to it at once', built.input.info().name === 'gnome');
  await waitFor('the status to follow', async () => (await inUse()).includes('GNOME direct input (no setup needed)'));
  check('the page then mentions the sharing indicator and that it can enter any character', (await inUse()).includes('screen-sharing indicator') && (await inUse()).includes('any character'), (await inUse()).slice(0, 200));
  check('...and only that choice is marked', (await radio('gnome')) === 'true' && (await radio('auto')) === 'false' && (await radio('ydotool')) === 'false');
  await shot('input');
  await click('[data-fk="input-mode:ydotool"]');
  await waitFor('ydotool saved', () => built.settings.get().input.backend === 'ydotool');
  check('choosing ydotool switches back', built.input.info().name === 'ydotool');
  await click('[data-fk="input-mode:auto"]');
  await waitFor('automatic saved', () => built.settings.get().input.backend === 'auto');
  check('Automatic can be chosen again', (await radio('auto')) === 'true');

  // ---- I. safety ------------------------------------------------------------------------------------------------------------------------
  await click('.nav-item', 'Safety');
  await waitFor('the Safety section', () => page("document.querySelector('#h-safety') !== null"));
  check('with every protection on, there is no warning', (await page("document.querySelectorAll('.banner').length")) === 0);
  await page("document.querySelector('[data-fk=\"safety-shell\"]').click()");
  await waitFor('shell approval off', () => built.settings.get().safety.requireApprovalForShell === false);
  await waitFor('the warning', () => page("document.querySelector('.banner') !== null"));
  check('switching a protection off saves it and shows a warning that stays', (await page("document.querySelector('.banner').textContent")).includes('Shell commands will run without asking'));
  check('...and the live safety gate setting follows', built.gate.allowDangerous === false);
  await page("document.querySelector('[data-fk=\"safety-shell\"]').click()");
  await typeInto('limit-rate', '5000');
  await waitFor('the rate limit', () => built.settings.get().safety.maxActionsPerMinute === 1000);
  check('a number above the limit is brought back to the limit', (await page("document.querySelector('[data-fk=\"limit-rate\"]').value")) === '1000');
  await typeInto('limit-steps', 'lots');
  await sleep(250);
  check('a word where a number belongs changes nothing', built.settings.get().agent.maxSteps === 40 && (await page("document.querySelector('[data-fk=\"limit-steps\"]').value")) === '40');
  await page("document.querySelector('[data-fk=\"safety-keys\"]').click()");
  await waitFor('dangerous keys allowed', () => built.gate.allowDangerous === true);
  check('allowing dangerous keys reaches the real safety gate at once', true);
  await waitFor('its warning', () => page("document.querySelector('.banner') !== null && document.querySelector('.banner').textContent.includes('Ctrl+Alt+Delete')"));
  await shot('safety');
  await page("document.querySelector('[data-fk=\"safety-keys\"]').click()");
  await waitFor('dangerous keys blocked again', () => built.gate.allowDangerous === false);

  // ---- J. key storage ---------------------------------------------------------------------------------------------------------------------------
  await click('.nav-item', 'Key storage');
  await waitFor('the Key storage section', () => page("document.querySelector('#h-storage') !== null"));
  const mode = built.keyStore.mode();
  check('the section says where keys really are', (await page("document.querySelector('.row-title').textContent")) === { keyring: 'Encrypted with your system keyring', session: 'Kept in memory only', file: 'Saved as plain text' }[mode], mode);
  if (mode === 'session') {
    await page("document.querySelector('[data-fk=\"plain\"]').click()");
    await waitFor('the confirmation', () => page("document.querySelector('[data-fk=\"plain-yes\"]') !== null"));
    check('plain-text storage asks before it turns on, and nothing changed yet', built.settings.get().security.keyStorage === 'session');
    await click('[data-fk="plain-yes"]');
    await waitFor('file storage on', () => built.settings.get().security.keyStorage === 'file');
    await waitFor('the save-now button', () => page("document.querySelector('[data-fk=\"save-memory-keys\"]') !== null"));
    check('plain-text storage shows a standing warning', (await page("document.querySelector('.banner').textContent")).includes('plain text'));
    await click('[data-fk="save-memory-keys"]');
    await waitFor('keys written', () => fs.existsSync(path.join(dir, 'keys.json')));
    const stat = fs.statSync(path.join(dir, 'keys.json'));
    check('"Save them now" writes the key file, readable by this user only', (stat.mode & 0o777) === 0o600, (stat.mode & 0o777).toString(8));
    await shot('storage');
    await click('[data-fk="plain"]');
  } else {
    check('with a real keyring there is no plain-text option to switch on', (await page("document.querySelector('[data-fk=\"plain\"]')")) === null);
    await shot('storage');
  }

  // ---- K. about -------------------------------------------------------------------------------------------------------------------------------------
  await click('.nav-item', 'About');
  await waitFor('the About section', () => page("document.querySelector('#h-about') !== null"));
  const about = await page("document.querySelector('.facts').textContent");
  check('About names the app, the desktop, the shortcut and the data folder', about.includes('ALLES') && about.includes('Shortcut') && about.includes(dir), about.slice(0, 120));
  check('About says which way the mouse and keyboard are driven', about.includes('Mouse and keyboard'), about.slice(0, 300));
  check('About says which window system ALLES runs on, in plain words', about.includes('Window system') && about.includes('The pill sits exactly where you put it'), about.slice(-200));
  await shot('about');

  // ---- K2. "Check this computer" (About) -----------------------------------------------------------------------------------------------------------------
  // The screenshot tool and the mouse/keyboard connection are stand-ins: this script must not photograph or drive the real desktop.
  const realParts = { screen: built.screen, input: built.input };
  const looked = { shots: 0, resumes: 0, moves: 0, closes: 0 };
  let screenFails = null;
  built.screen = { capture: async () => { looked.shots++; await sleep(500); if (screenFails) throw new Error(screenFails); return { width: 1366, height: 768, modelWidth: 1280, modelHeight: 720 }; } };
  built.input = { resume() { looked.resumes++; }, async moveBy() { looked.moves++; }, close() { looked.closes++; }, info: () => ({ name: 'gnome', label: "GNOME's own input", unicode: true }) };
  const doctorButton = "document.querySelector('[data-fk=\"doctor:run\"]')";
  const doctorRows = () => page("[...document.querySelectorAll('.doctor-list .check')].map((li) => ({ state: li.dataset.state, icon: li.querySelector('.check-icon').textContent, word: li.querySelector('.sr-only').textContent, title: li.querySelector('.check-title').textContent, text: li.textContent, fix: (li.querySelector('.check-fix') || {}).textContent || '' }))");
  const verdictOf = () => page("(() => { const v = document.querySelector('.doctor-result .verdict'); return v ? { text: v.textContent, tone: v.dataset.tone } : null; })()");
  const ICONS = { ok: '✓', warn: '!', problem: '✕', skipped: '–' };
  const iconsMatch = (rows) => rows.every((r) => r.icon === ICONS[r.state]);
  // Is the first element matching `selector` drawn in the page's own colour `variable` (--ready, --attention, --problem, --muted)?
  const colourIs = (selector, variable) => page(`(() => { const probe = document.createElement('span'); probe.style.color = 'var(${variable})'; document.body.append(probe); const want = getComputedStyle(probe).color; probe.remove(); const el = document.querySelector(${JSON.stringify(selector)}); return !!el && getComputedStyle(el).color === want; })()`);

  let asks = 0; const realCheck = built.checkComputer.bind(built);          // how often the page really asks main for a check
  built.checkComputer = () => { asks++; return realCheck(); };
  check('About offers "Check this computer", with nothing shown yet', (await page(`${doctorButton}.textContent`)) === 'Check now' && (await page("document.querySelector('.doctor-result') === null")) === true);
  await page(`${doctorButton}.focus()`);
  await click('[data-fk="doctor:run"]');
  await waitFor('the check to start', async () => (await page(`${doctorButton}.textContent`)) === 'Checking…');
  check('while it runs the button says so and is marked unavailable, yet keeps the keyboard focus', (await page(`${doctorButton}.getAttribute('aria-disabled') === 'true' && !${doctorButton}.disabled && document.activeElement === ${doctorButton}`)) === true);
  await click('[data-fk="doctor:run"]');                                    // pressed again while it runs
  await waitFor('the result', () => page("document.querySelector('.doctor-result') !== null"), 8000);
  check('pressing it again while it ran did not even ask for a second check', looked.shots === 1 && asks === 1, `${looked.shots} screenshots, ${asks} requests`);
  const rows1 = await doctorRows();
  check('the six checks are listed in order', JSON.stringify(rows1.map((r) => r.title)) === JSON.stringify(['Desktop', 'Island placement', 'Screenshots', 'Mouse and keyboard', 'AI providers', 'Saving keys']), rows1.map((r) => r.title).join(', '));
  check('every row carries one of the four states', rows1.every((r) => ['ok', 'warn', 'problem', 'skipped'].includes(r.state)), rows1.map((r) => r.state).join(','));
  check('the screenshot row is fine and says how big the screen is', rows1[2].state === 'ok' && rows1[2].text.includes('1366x768'), rows1[2].text);
  check('the mouse and keyboard row is fine and names the method', rows1[3].state === 'ok' && rows1[3].text.includes("GNOME's own input is ready"), rows1[3].text);
  check('each row starts with a spoken word for its state (for screen readers)', rows1.every((r) => /^(Fine|Worth a look|Needs fixing|Not tried): $/.test(r.word)), rows1.map((r) => r.word).join('|'));
  check('the check opened the connection with one harmless move and let go of it again', looked.resumes === 1 && looked.moves === 1 && looked.closes === 1, JSON.stringify(looked));
  check('the headline says what the result means', ((await verdictOf()) || {}).text.length > 10, JSON.stringify(await verdictOf()));
  check('the button now offers a second look, and the keyboard focus is still on it', (await page(`${doctorButton}.textContent === 'Check again' && document.activeElement === ${doctorButton}`)) === true);
  check('each state has its own symbol: tick, exclamation mark, cross, dash', iconsMatch(rows1), rows1.map((r) => `${r.state}${r.icon}`).join(' '));
  check('a row worth a look is drawn in the attention colour, a fine one in the ready colour', (await colourIs('.doctor-list .check[data-state="warn"] .check-icon', '--attention')) && (await colourIs('.doctor-list .check[data-state="ok"] .check-icon', '--ready')));
  check('the headline takes the colour of the worst row', (await colourIs('.doctor-result .verdict', '--attention')) === true && ((await verdictOf()) || {}).tone === 'warn');
  await shot('about-check');

  // on a GNOME Wayland desktop that is in order, the answer is a plain "ready"
  const realDesktop = { desktop: built.desktop, env: built.env };
  built.desktop = 'gnome'; built.env = { XDG_CURRENT_DESKTOP: 'GNOME', XDG_SESSION_TYPE: 'wayland' };
  await click('[data-fk="doctor:run"]');
  await waitFor('the all-clear', async () => ((await verdictOf()) || {}).tone === 'ok', 8000);
  const rowsOk = await doctorRows();
  check('on GNOME Wayland in order: six fine rows, the desktop named, and "Everything is ready."', rowsOk.length === 6 && rowsOk.every((r) => r.state === 'ok') && rowsOk[0].text.includes('GNOME on Wayland') && (await verdictOf()).text === 'Everything is ready.', JSON.stringify(rowsOk.map((r) => r.state)));
  check('...and the headline is drawn in the ready colour', (await colourIs('.doctor-result .verdict', '--ready')) === true);
  built.desktop = realDesktop.desktop; built.env = realDesktop.env;

  // a failure is shown as a row that needs fixing, in plain words - and text from a tool is only ever text
  screenFails = 'gnome-screenshot crashed <img src=x onerror="window.__pwned=1"> and <b>bold</b>';
  await click('[data-fk="doctor:run"]');
  await waitFor('the second result', async () => (await doctorRows()).some((r) => r.state === 'problem'), 8000);
  const rows2 = await doctorRows();
  const bad = rows2.find((r) => r.title === 'Screenshots');
  check('a screenshot tool that fails is a row that needs fixing, with the reason', bad.state === 'problem' && bad.word === 'Needs fixing: ' && bad.text.includes('The screenshot failed: gnome-screenshot crashed'), bad.text);
  check('the headline turns to a problem', ((await verdictOf()) || {}).tone === 'problem' && /fixing/.test((await verdictOf()).text), JSON.stringify(await verdictOf()));
  check('what a tool says is shown as plain text: no element was made from it, nothing ran', (await page("document.querySelectorAll('.doctor-list img, .doctor-list b').length === 0 && window.__pwned === undefined")) === true && bad.text.includes('<img src=x'));
  check('a problem is drawn in the problem colour (the row\'s symbol and the headline), with a cross', (await colourIs('.doctor-list .check[data-state="problem"] .check-icon', '--problem')) && (await colourIs('.doctor-result .verdict', '--problem')) && iconsMatch(rows2), JSON.stringify(rows2.map((r) => r.icon)));
  check('a row that can be fixed says what to do about it', bad.fix.startsWith('What to do: Is the screen locked?'), bad.fix);
  await shot('about-check-problem');

  // the check itself breaking is said plainly, with no half-drawn list
  screenFails = null;
  built.checkComputer = async () => { throw new Error('the check itself broke'); };
  await click('[data-fk="doctor:run"]');
  await waitFor('the error line', async () => ((await verdictOf()) || {}).text === 'the check itself broke' || (await page("(document.querySelector('.doctor > .verdict') || {}).textContent === 'the check itself broke'")), 8000);
  check('a check that breaks is shown as one problem line, and the old list is gone', (await page("(document.querySelector('.doctor > .verdict') || {}).dataset.tone === 'problem' && document.querySelector('.doctor-list') === null")) === true);
  delete built.checkComputer;

  // a task is running: the screen and the connection are left alone, and the page says why
  let releaseTask; const heldTask = new Promise((r) => { releaseTask = r; });
  built._createAgent = () => ({ on() {}, stop() {}, run: () => heldTask });
  const taskDone = new Promise((r) => built.runner.once('finished', r));
  built.runner.submit('a task that waits');
  const shotsBefore = looked.shots; const resumesBefore = looked.resumes; const movesBefore = looked.moves;
  await click('[data-fk="doctor:run"]');
  await waitFor('the third result', async () => (await doctorRows()).some((r) => r.state === 'skipped'), 8000);
  const rows3 = await doctorRows();
  check('during a task the screenshot and the mouse and keyboard are "not tried", and it says a task is running', rows3.filter((r) => r.state === 'skipped').map((r) => r.title).join() === 'Screenshots,Mouse and keyboard' && rows3[2].word === 'Not tried: ' && rows3[2].text.includes('A task is running'), rows3[2].text);
  check('...and neither the screen nor the connection was touched', looked.shots === shotsBefore && looked.resumes === resumesBefore && looked.moves === movesBefore);
  check('"not tried" has a dash and the quiet colour', iconsMatch(rows3) && (await colourIs('.doctor-list .check[data-state="skipped"] .check-icon', '--muted')) === true);
  releaseTask({ ok: true, summary: 'done', steps: 1, stoppedBy: 'finish' });
  await taskDone;
  check('(after the check) the last result is still there', (await doctorRows()).length > 0);
  await click('.nav-item', 'About');
  check('pressing the tab you are already on does not wipe the result', (await doctorRows()).length > 0);
  await click('.nav-item', 'Providers');
  await click('.nav-item', 'About');
  check('leaving About and coming back shows no old result: a check is a snapshot of one moment', (await page("document.querySelector('.doctor-result') === null")) === true && (await page(`${doctorButton}.textContent`)) === 'Check now');

  // leaving About while a check runs: the answer that arrives later is dropped, not shown on the next visit
  built.screen = { capture: async () => { looked.shots++; await sleep(500); return { width: 1366, height: 768, modelWidth: 1280, modelHeight: 720 }; } };
  await click('[data-fk="doctor:run"]');
  await waitFor('the check to start', async () => (await page(`${doctorButton}.textContent`)) === 'Checking…');
  await click('.nav-item', 'Providers');
  await sleep(900);                                                          // the slow screenshot finishes while the person is elsewhere
  await click('.nav-item', 'About');
  check('an answer that arrives after the person left About is not shown when they return', (await page("document.querySelector('.doctor-result') === null")) === true && (await page(`${doctorButton}.textContent`)) === 'Check now');
  // ...and when they come back BEFORE it arrives, the late answer of the old check must not turn up either
  await click('[data-fk="doctor:run"]');
  await waitFor('the check to start', async () => (await page(`${doctorButton}.textContent`)) === 'Checking…');
  await click('.nav-item', 'Providers');
  await click('.nav-item', 'About');
  await sleep(900);                                                          // the old check's answer arrives now
  check('a late answer is not shown after the person has been away and come back', (await page("document.querySelector('.doctor-result') === null")) === true && (await page(`${doctorButton}.textContent`)) === 'Check now');
  built.screen = realParts.screen; built.input = realParts.input;

  // ---- L. nobody else can use it ----------------------------------------------------------------------------------------------------------------------------
  const rawPreload = path.join(dir, 'raw-preload.cjs');
  fs.writeFileSync(rawPreload, "const { contextBridge, ipcRenderer } = require('electron'); contextBridge.exposeInMainWorld('raw', { invoke: (c, p) => ipcRenderer.invoke(c, p) });");
  const stranger = new BrowserWindow({ show: false, webPreferences: { preload: rawPreload, contextIsolation: true, sandbox: true } });
  await stranger.loadURL('data:text/html,<p>another page in the same app</p>');
  const askedGet = await stranger.webContents.executeJavaScript("window.raw.invoke('settings:get')");
  const askedKey = await stranger.webContents.executeJavaScript("window.raw.invoke('settings:add-key', { routeId: 'grok', key: 'xai-STRANGERKEY0000001' })");
  check('another window in the same app is refused, even though it can call ipc directly', askedGet.ok === false && askedGet.error === 'Not allowed.' && askedKey.ok === false);
  check('...and no key was added by it', built.keyStore.list('grok').length === 0);
  stranger.destroy();

  // ---- M. light theme, then close and reopen --------------------------------------------------------------------------------------------------------------------
  nativeTheme.themeSource = 'light';
  await sleep(300);
  await click('.nav-item', 'Providers');
  await waitFor('Providers again', () => page("document.querySelector('#h-providers') !== null"));
  check('the light theme applies', (await page("getComputedStyle(document.body).backgroundColor")) === 'rgb(243, 245, 249)');
  await shot('providers-light');
  await click('.nav-item', 'Island');
  await sleep(300);
  await shot('island-light');
  win.setSize(640, 760);
  await sleep(300);
  await click('.nav-item', 'Providers');
  await shot('providers-narrow');
  win.setSize(940, 700);
  nativeTheme.themeSource = 'dark';
  await sleep(300);
  await shot('providers-dark');
  await click('.nav-item', 'Safety');
  await shot('safety-dark');
  nativeTheme.themeSource = 'system';

  check('no errors appeared in the page console during the whole run', consoleErrors.length === 0, consoleErrors.join(' | '));

  built.settingsWindow.close();
  await sleep(200);
  check('closing Settings does not quit the app', !built.dockWindow.win.isDestroyed() && BrowserWindow.getAllWindows().length === 1);
  await built.dockWindow.win.webContents.executeJavaScript("window.pill.send('open-settings')");
  await waitFor('Settings to open again', () => BrowserWindow.getAllWindows().length === 2);
  const win2 = built.settingsWindow.win;
  await waitFor('the second window to load', () => !win2.webContents.isLoading());
  await waitFor('the list again', () => win2.webContents.executeJavaScript("document.querySelectorAll('.route').length"));
  check('Settings opens again after being closed, and shows what was saved', (await win2.webContents.executeJavaScript("document.querySelector('.card-title').textContent")).includes('NVIDIA'));

  built._teardown();
  await sleep(200);
  let handlersReleased = false;
  try { electron.ipcMain.handle('settings:get', () => 1); electron.ipcMain.removeHandler('settings:get'); handlersReleased = true; } catch { /* a second handler would throw: they were not released */ }
  check('after teardown the Settings window is gone and its request handlers are released', built.settingsWindow.win === null && handlersReleased);

  provider.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} real-Electron Settings checks passed`);
  clearTimeout(watchdog);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort; app.exit() skips process 'exit' handlers */ }
  app.exit(failed ? 1 : 0);

  // ---- helpers that need `win` -----------------------------------------------------------------------------------------------------------------------------------
  async function shot(name, { scroll = false } = {}) {
    if (!SHOTS) return;
    if (scroll) await page("document.getElementById('main').scrollTop = 99999");
    await sleep(450);
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.writeFileSync(path.join(SHOTS, `settings-${name}.png`), (await wc.capturePage()).toPNG());
  }
}).catch((e) => { console.error('E2E crashed:', e.stack); app.exit(2); });
