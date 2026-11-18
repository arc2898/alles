'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { loadPreload } = require('./helpers/preload-vm');
const { fakeElectron } = require('./helpers/fake-electron');
const { App } = require('../src/main/app');
const Model = require('../src/settings/settings-model');
const { tmpDir } = require('./helpers/tmp');
const { fakeComputer } = require('./helpers/fake-computer');

/**
 * The Settings window is three pieces written in three places: the PAGE (settings.js) asks for things, the PRELOAD
 * (preload.cjs) decides what may pass, and MAIN (settings-ipc.js) answers. Each piece has its own tests. This file
 * tests the SEAMS between them, so they cannot drift apart without a test failing:
 *
 *   1. all three know exactly the same list of actions (no action the page uses but the preload refuses; nothing
 *      allowed that nobody uses - an unused way in is a risk with no benefit);
 *   2. everything the page really sends goes through the REAL preload unchanged and is answered by the REAL handlers;
 *   3. the page's own files stay safe to run: no way to turn text into markup, no network, no outside files, a strict
 *      Content-Security-Policy, and every element it looks up really exists.
 *
 * The page itself runs for real (in Electron) in scripts/e2e-settings.cjs; this file is the fast, always-run guard.
 */

const DIR = path.join(__dirname, '../src/settings');
const PRELOAD = path.join(DIR, 'preload.cjs');
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');
const unique = (list) => [...new Set(list)].sort();
const found = (text, re) => unique([...text.matchAll(re)].map((m) => m[1]));
const missingFrom = (a, b) => a.filter((x) => !b.includes(x));

/**
 * Source with its comments removed and its strings kept, so a comment that merely MENTIONS innerHTML does not fail a
 * scan, while a string or a call that really uses it does. If the scanner ever loses its place (a regex literal with a
 * quote in it, say) it says so loudly instead of silently scanning the wrong thing.
 */
function withoutComments(src, what) {
  let out = ''; let i = 0; const n = src.length;
  while (i < n) {
    const c = src[i]; const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      assert.notStrictEqual(end, -1, `${what}: a comment is never closed`);
      i = end + 2; out += ' '; continue;
    }
    if (c === '\'' || c === '"' || c === '`') {
      out += c; i++;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
        assert.ok(c === '`' || src[i] !== '\n', `${what}: the scanner lost its place in a string near: ${src.slice(Math.max(0, i - 50), i)}`);
        out += src[i]; i++;
      }
      assert.ok(i < n, `${what}: a string is never closed`);
      out += c; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

// ---------------------------------------------------------------- the scanner itself (so a scan can never pass for the wrong reason)

test('the comment remover drops comments, keeps strings (even ones that look like comments), and complains when lost', () => {
  const src = [
    'a = 1; // el.innerHTML = x',
    '/* eval(x) \n spans lines */ b = "http://not-a-comment.example"; c = \'it\\\'s\'; d = `t ${1} // still text`;',
  ].join('\n');
  const out = withoutComments(src, 'sample');
  assert.ok(!out.includes('innerHTML') && !out.includes('eval'), 'comments must go');
  assert.ok(out.includes('"http://not-a-comment.example"'), 'a // inside a string is not a comment');
  assert.ok(out.includes('`t ${1} // still text`'), 'a // inside a template is not a comment');
  assert.ok(out.includes("'it\\'s'"), 'an escaped quote does not end a string');
  assert.throws(() => withoutComments('x = "never closed\ny = 2', 'sample'), /lost its place/);
  assert.throws(() => withoutComments('x = 1; /* never closed', 'sample'), /never closed/);
});

// What the page's own script must never contain. Every rule carries an example it MUST catch, so a typo in a pattern
// cannot turn a rule into one that never fires.
const BANNED = [
  { why: 'innerHTML', re: /\binnerHTML\b/, example: 'el.innerHTML = x' },
  { why: 'outerHTML', re: /\bouterHTML\b/, example: 'el.outerHTML = x' },
  { why: 'insertAdjacentHTML', re: /\binsertAdjacentHTML\b/, example: 'el.insertAdjacentHTML("beforeend", x)' },
  { why: 'document.write', re: /\bdocument\s*\.\s*write(ln)?\b/, example: 'document.write(x)' },
  { why: 'srcdoc', re: /\bsrcdoc\b/, example: 'frame.srcdoc = x' },
  { why: 'createContextualFragment', re: /\bcreateContextualFragment\b/, example: 'range.createContextualFragment(x)' },
  { why: 'DOMParser', re: /\bDOMParser\b/, example: 'new DOMParser()' },
  { why: 'eval', re: /\beval\s*\(/, example: 'eval(x)' },
  { why: 'the Function constructor', re: /\bnew\s+Function\b|\bFunction\s*\(/, example: 'new Function(x)' },
  { why: 'a timer given text to run', re: /\bset(Timeout|Interval)\s*\(\s*['"`]/, example: 'setTimeout("go()", 5)' },
  { why: 'an inline style attribute', re: /setAttribute\s*\(\s*['"]style['"]/i, example: "el.setAttribute('style', 'x')" },
  { why: 'the network', re: /\bfetch\s*\(|\b(XMLHttpRequest|WebSocket|EventSource)\b|\bsendBeacon\b/, example: 'fetch(url)' },
  { why: 'opening windows or navigating', re: /\bwindow\s*\.\s*open\s*\(|\blocation\s*(\.|=)|\.href\s*=/, example: 'location.href = u' },
  { why: 'browser storage', re: /\b(localStorage|sessionStorage|indexedDB)\b|\bdocument\s*\.\s*cookie\b/, example: 'localStorage.setItem(a, b)' },
  { why: 'sending messages out of the page', re: /\bpostMessage\b|\bBroadcastChannel\b|\bSharedWorker\b|\bnew\s+Worker\b/, example: 'frame.postMessage(x)' },
  { why: 'loading code at run time', re: /\bimport\s*\(|^\s*(import|export)\s/m, example: 'import("x")' },
  { why: 'Node access', re: /\brequire\s*\(|\bprocess\s*\.|\bmodule\b|\bexports\b|\bBuffer\b/, example: 'require("fs")' },
];

test('every rule in the page scan really fires on the thing it is meant to catch', () => {
  for (const rule of BANNED) assert.ok(rule.re.test(rule.example), `the rule for ${rule.why} does not match its own example`);
});

// ---------------------------------------------------------------- 1. the same list of actions everywhere

const live = [];                                   // anything still running after a test (even a failed one) is stopped
test.afterEach(() => { while (live.length) { try { live.pop()._teardown(); } catch { /* it was already torn down */ } } });

function rig() {
  const dir = tmpDir('alles-bridge-');
  const { electron, internals } = fakeElectron();
  const computer = fakeComputer();                 // never the real screenshot tool or a real sharing session
  const app = new App({ electron, userDataDir: dir, makeInputBackend: computer.makeInputBackend });
  live.push(app);
  app.create();
  computer.install(app);
  const sender = app.settingsWindow.open().webContents;
  // The page's whole way out, in one process: page -> the REAL preload.cjs -> ipc -> the REAL handlers -> the REAL app.
  const pre = loadPreload(PRELOAD, { reply: (channel, payload) => internals.invoke(channel, payload, sender) });
  return { app, electron, internals, sender, pre, dir, computer };
}
async function withRig(fn) {
  const r = rig();
  try { return await fn(r); } finally { r.app._teardown(); fs.rmSync(r.dir, { recursive: true, force: true }); }
}

const pageCode = () => withoutComments(read('settings.js'), 'settings.js');
const pageChannels = () => found(pageCode(), /\bapi\(\s*'(settings:[a-z-]+)'/g);
function preloadChannels() {
  const src = withoutComments(read('preload.cjs'), 'preload.cjs');
  const start = src.indexOf('const REQUESTS = {');
  assert.ok(start > 0, 'could not find the REQUESTS table in preload.cjs');
  const table = src.slice(start, src.indexOf('\n};', start));
  return found(table, /^\s*'(settings:[a-z-]+)'\s*:/gm);
}

test('the page, the preload and main all know exactly the same list of actions', async () => {
  await withRig(({ internals }) => {
    const main = unique(internals.handledChannels().filter((c) => c.startsWith('settings:')));
    const page = pageChannels();
    const pre = preloadChannels();
    assert.ok(main.length >= 12 && page.length === main.length && pre.length === main.length, `scan found main=${main.length} page=${page.length} preload=${pre.length}`);
    assert.deepStrictEqual(missingFrom(page, pre), [], 'the page asks for actions the preload would refuse');
    assert.deepStrictEqual(missingFrom(pre, page), [], 'the preload allows actions the page never uses - remove them (an unused way in is all risk)');
    assert.deepStrictEqual(missingFrom(main, pre), [], 'main answers actions the preload would never let through');
    assert.deepStrictEqual(missingFrom(pre, main), [], 'the preload allows actions main does not answer');
    assert.deepStrictEqual(missingFrom(main, page), [], 'main answers actions the page never asks for');
  });
});

test('the "something changed" nudge: the name main sends is the name the preload listens for, and it carries nothing', async () => {
  await withRig(({ app, internals, pre }) => {
    const win = app.settingsWindow.open();
    let calls = 0; let args = null;
    pre.api.onChanged((...a) => { calls++; args = a; });
    app.settingsWindow.notifyChanged();
    const sent = internals.sentToRenderer.filter((m) => m.win === win);
    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual(Object.keys(pre.listeners), [sent[0].channel], 'the preload listens for exactly the channel main sends on');
    pre.emit(sent[0].channel, sent[0].payload);
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(args, [], 'the page callback receives no data');
  });
});

// ---------------------------------------------------------------- 2. what the page really sends, end to end

// Every settings change the page can make by path (patch('dock.edge', v) and numberRow's path). The test below fails
// if the page starts using a path that has no sample here, or if a sample here is no longer used by the page.
const PATCH_SAMPLES = {
  'dock.edge': 'left', 'dock.along': 0.25, 'dock.autoHide': true, 'dock.hour12': true,
  'tray.enabled': true, 'input.backend': 'gnome',
  'safety.requireApprovalForShell': false, 'safety.requireApprovalForFileWrites': false, 'safety.allowDangerousKeys': true,
  'safety.maxActionsPerMinute': 77, 'agent.maxSteps': 33, 'agent.keepImages': 2,
};

test('the settings changes the page can make are exactly the ones this file has samples for', () => {
  const code = pageCode();
  const used = unique([
    ...found(code, /\bpatch\(\s*'([a-z]+\.[A-Za-z0-9]+)'/g),
    ...found(code, /\bpath:\s*'([a-z]+\.[A-Za-z0-9]+)'/g),
  ]);
  assert.deepStrictEqual(missingFrom(used, Object.keys(PATCH_SAMPLES)), [], 'the page changes a setting this file has no sample for - add one');
  assert.deepStrictEqual(missingFrom(Object.keys(PATCH_SAMPLES), used), [], 'a sample here is for a setting the page no longer changes - remove it');
  // Two further, whole-object changes: "Reset to top centre" and the plain-text key storage switch. A third means a new kind of change.
  assert.strictEqual((code.match(/\bpatchMany\(\s*\{/g) || []).length, 1, 'a new whole-object settings change was added to the page - add a sample for it below');
  assert.strictEqual((code.match(/api\(\s*'settings:update'\s*,\s*\{/g) || []).length, 1, 'a new settings:update call was added to the page - add a sample for it below');
});

function fakeProvider() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{}');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}/v1` })));
}

test('everything the page sends goes through the REAL preload unchanged and is answered by the REAL handlers', async () => {
  const provider = await fakeProvider();
  try {
    await withRig(async ({ app, electron, pre }) => {
      // Send like the page does, and check the preload handed main exactly what was sent (a cleaner that quietly
      // dropped or changed a legitimate field would make a setting that "saves" but does nothing).
      const call = async (name, payload) => {
        const before = pre.invoked.length;
        const res = await pre.api.invoke(name, payload);
        const forwarded = pre.invoked.slice(before);
        assert.deepStrictEqual(forwarded, [payload === undefined ? [name] : [name, JSON.parse(JSON.stringify(payload))]], `${name}: the preload changed or dropped what the page sent`);
        return res;
      };
      const SECRET = 'custom-BRIDGETESTKEY0123456789';

      // read
      const got = await call('settings:get');
      assert.strictEqual(got.ok, true);
      assert.strictEqual(got.info.name, 'ALLES');
      assert.ok(got.settings.dock && got.keyStorage.mode, 'settings and key storage come back');
      assert.strictEqual((await call('settings:load-issue')).ok, true);
      const before = await call('settings:describe-providers');
      assert.strictEqual(before.ok, true);

      // add a provider, fill it in, give it a key
      const added = await call('settings:add-route', 'custom');
      assert.strictEqual(added.ok, true);
      const id = added.id;
      assert.strictEqual((await call('settings:update-route', { id, label: 'Bridge test', model: 'bridge-model', baseUrl: provider.base, enabled: true })).ok, true);
      const key = await call('settings:add-key', { routeId: id, key: SECRET });
      assert.strictEqual(key.ok, true);
      assert.ok(!JSON.stringify(key).includes(SECRET), 'the key must not come back');

      const described = await call('settings:describe-providers');
      const route = described.routes.find((r) => r.id === id);
      assert.ok(route, 'the new provider is listed');
      assert.strictEqual(route.model, 'bridge-model');
      assert.strictEqual(route.keys.length, 1);
      assert.ok(!JSON.stringify(described).includes(SECRET), 'a listing never shows a key');

      // test it (the fake provider refuses every key: what matters is that the request arrives and is answered)
      const tested = await call('settings:test-route', { routeId: id });
      assert.strictEqual(tested.ok, true);
      assert.strictEqual(tested.result.usable, false);
      const testedKey = await call('settings:test-route', { routeId: id, keyId: key.id });
      assert.strictEqual(testedKey.ok, true);
      assert.ok(provider.seen.length >= 2 && provider.seen.every((s) => s.authorization === `Bearer ${SECRET}`), 'the provider got the typed key, once per call, and nothing else did');
      assert.ok(!JSON.stringify([tested, testedKey]).includes(SECRET), 'a test result never shows a key');

      // "Check this computer" (no payload; what comes back is what the page turns into its list)
      const checked = await call('settings:check-computer');
      assert.strictEqual(checked.ok, true);
      const view = Model.computerCheckView(checked);
      assert.deepStrictEqual(view.rows.map((r) => r.id), ['desktop', 'window', 'screenshot', 'input', 'providers', 'keys']);
      assert.ok(view.rows.every((r) => r.title && r.detail), 'every row has a title and something to say');
      assert.ok(view.headline.length > 0);
      assert.ok(!JSON.stringify(checked).includes(SECRET), 'a check never shows a key');

      // order
      const ids = described.routes.map((r) => r.id);
      const reordered = Model.moveId(ids, id, -1);
      assert.notDeepStrictEqual(reordered, ids, 'the sample must really move something');
      assert.strictEqual((await call('settings:reorder-routes', reordered)).ok, true);
      assert.deepStrictEqual(app.settings.get().providers.routes.map((r) => r.id), reordered);

      // every settings change the page can make
      for (const [pathName, value] of Object.entries(PATCH_SAMPLES)) {
        const patch = Model.patchFor(pathName, value);
        assert.strictEqual((await call('settings:update', patch)).ok, true, pathName);
        const [section, field] = pathName.split('.');
        assert.deepStrictEqual(app.settings.get()[section][field], value, `${pathName} was sent but not saved`);
      }
      const reset = { dock: { edge: 'top', along: 0.5, display: null } };         // "Reset to top centre"
      assert.strictEqual((await call('settings:update', reset)).ok, true);
      assert.deepStrictEqual({ edge: app.settings.get().dock.edge, along: app.settings.get().dock.along, display: app.settings.get().dock.display }, { edge: 'top', along: 0.5, display: null });

      // remove again
      assert.strictEqual((await call('settings:remove-key', { routeId: id, keyId: key.id })).ok, true);
      assert.strictEqual((await call('settings:remove-route', id)).ok, true);
      assert.ok(!(await call('settings:describe-providers')).routes.some((r) => r.id === id), 'the provider is gone');

      // key storage (the plain-text switch, which only matters when this computer has no system keyring), and saving
      // keys that were only in memory
      electron.safeStorage._setAvailable(false);
      assert.strictEqual((await call('settings:update', { security: { keyStorage: 'file' } })).ok, true);
      assert.strictEqual((await call('settings:get')).keyStorage.mode, 'file');
      assert.strictEqual((await call('settings:update', { security: { keyStorage: 'session' } })).ok, true);
      assert.strictEqual((await call('settings:get')).keyStorage.mode, 'session');
      const migrated = await call('settings:migrate-session-keys');
      assert.strictEqual(migrated.ok, true);
      assert.strictEqual(typeof migrated.migrated, 'number');
    });
  } finally { provider.server.close(); }
});

test('through the whole chain, a request the page should never make is refused before main hears of it', async () => {
  await withRig(async ({ pre, app }) => {
    const sentBefore = pre.invoked.length;
    const settingsBefore = JSON.stringify(app.settings.get());
    const refusals = [
      pre.api.invoke('settings:list-keys', 'grok'),                                   // an action that no longer exists
      pre.api.invoke('settings:update', { providers: { routes: [] } }),                // providers have their own actions
      pre.api.invoke('settings:update', { dock: { edge: 'diagonal' } }),
      pre.api.invoke('settings:add-key', { routeId: 'grok', key: '' }),
      pre.api.invoke('settings:remove-key', { routeId: 'grok', keyId: '../../etc' }),
      pre.api.invoke('pill:event', 'cancel'),
    ];
    for (const res of await Promise.all(refusals)) assert.strictEqual(res.ok, false);
    assert.strictEqual(pre.invoked.length, sentBefore, 'nothing of that may reach main');
    assert.strictEqual(JSON.stringify(app.settings.get()), settingsBefore);
  });
});

// ---------------------------------------------------------------- 3. the page's own files

test('settings.js: no way to turn text into markup or code, no network, no storage, no navigation, no Node', () => {
  const code = pageCode();
  assert.ok(code.length > 5000, 'the scan must be reading the real page script');
  for (const rule of BANNED) assert.ok(!rule.re.test(code), `settings.js uses ${rule.why}`);
});

test('settings-model.js (also loaded by the page): no markup, code, network, storage or Node', () => {
  const code = withoutComments(read('settings-model.js'), 'settings-model.js');
  assert.ok(code.length > 3000, 'the scan must be reading the real model script');
  // It is a UMD file, so it may mention `module`/`exports` to export itself - but never require() or process.
  for (const rule of BANNED.filter((r) => r.why !== 'Node access')) assert.ok(!rule.re.test(code), `settings-model.js uses ${rule.why}`);
  assert.ok(!/\brequire\s*\(|\bprocess\s*\.|\bBuffer\b/.test(code), 'settings-model.js must run in a page with no Node');
});

test('settings.js reaches ALLES only through window.alles.invoke / onChanged, and touches no other window property', () => {
  const code = pageCode();
  assert.strictEqual((code.match(/window\.alles\b/g) || []).length, 1, 'the bridge is read once, into one variable');
  assert.deepStrictEqual(found(code, /\bbridge\.([A-Za-z_]+)/g), ['invoke', 'onChanged']);
  assert.deepStrictEqual(found(code, /\bwindow\.([A-Za-z_]+)/g), ['SettingsModel', 'addEventListener', 'alles']);
  assert.deepStrictEqual(found(code, /\bipcRenderer\b|\belectron\b/g), []);
});

test('settings.html: a strict Content-Security-Policy, only our own two scripts and one stylesheet, nothing inline, nothing external', () => {
  const html = read('settings.html');
  const tag = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/i);
  assert.ok(tag, 'the page must carry a Content-Security-Policy');
  const policy = {};
  for (const part of tag[1].split(';').map((s) => s.trim()).filter(Boolean)) { const [name, ...values] = part.split(/\s+/); policy[name] = values; }
  assert.deepStrictEqual(policy, {
    'default-src': ["'none'"], 'script-src': ["'self'"], 'style-src': ["'self'"], 'img-src': ['data:'], 'base-uri': ["'none'"], 'form-action': ["'none'"],
  });
  assert.ok(!/unsafe-|\*|https?:|blob:|filesystem:|ws:/i.test(tag[1]), 'no loosening, no wildcard, no outside source');

  // scripts: each one a plain file next to the page, nothing inline
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.deepStrictEqual(scripts.map((m) => (m[1].match(/\bsrc="([^"]*)"/) || [])[1]), ['settings-model.js', 'settings.js'], 'the scripts, in load order (the model first)');
  for (const m of scripts) assert.strictEqual(m[2].trim(), '', 'an inline script would be blocked by the policy - and has no place here');
  assert.strictEqual((html.match(/<script\b/gi) || []).length, scripts.length);

  // nothing else that can load, run or submit
  for (const [what, re] of [
    ['an inline <style>', /<style\b/i], ['a style="" attribute', /\sstyle\s*=/i], ['an event-handler attribute', /\son[a-z]+\s*=/i],
    ['a frame, object or embed', /<(iframe|frame|object|embed|applet)\b/i], ['a form', /<form\b/i], ['a <base>', /<base\b/i],
    ['a javascript: address', /javascript:/i], ['a refresh/redirect', /http-equiv="?refresh/i], ['an image tag', /<img\b/i],
  ]) assert.ok(!re.test(html), `settings.html has ${what}`);

  // every file it names is a plain neighbour that exists; no address leaves the folder
  const named = [...html.matchAll(/\b(?:src|href|action|data|poster|srcset)\s*=\s*"([^"]*)"/gi)].map((m) => m[1]);
  assert.deepStrictEqual(unique(named), ['settings-model.js', 'settings.css', 'settings.js']);
  for (const f of named) { assert.match(f, /^[A-Za-z0-9._-]+$/, `${f} is not a plain file name`); assert.ok(fs.existsSync(path.join(DIR, f)), `${f} is named by the page but does not exist`); }
  assert.ok(!/https?:\/\/|\/\/[a-z]/i.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'no outside address anywhere in the page');
});

test('settings.css: no imports, no outside files, only inline pictures, nothing that runs code', () => {
  const css = read('settings.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(css.length > 3000, 'the scan must be reading the real stylesheet');
  assert.ok(!/@import|@font-face|@charset\s+"[^"]*"\s*;\s*@import/i.test(css), 'no @import and no downloaded fonts');
  for (const m of css.matchAll(/url\(\s*([^)]*)\)/gi)) assert.match(m[1].trim().replace(/^['"]/, ''), /^data:image\//i, `url(${m[1]}) must be an inline picture`);
  assert.ok(!/expression\s*\(|behavior\s*:|-moz-binding|javascript:|https?:\/\//i.test(css));
});

test('every element the page looks up by id really exists in settings.html, and ids are not repeated', () => {
  const html = read('settings.html');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.strictEqual(new Set(ids).size, ids.length, `repeated ids: ${ids}`);
  const wanted = found(pageCode(), /\$\(\s*'([^']+)'\s*\)/g);
  assert.ok(wanted.length >= 3, 'the scan must find the lookups');
  assert.deepStrictEqual(missingFrom(wanted, ids), [], 'the page looks up an element the HTML does not have');
});

test('the page folder holds exactly the files the window and the tests know about', () => {
  assert.deepStrictEqual(fs.readdirSync(DIR).sort(), ['preload.cjs', 'settings-model.js', 'settings.css', 'settings.html', 'settings.js']);
});
