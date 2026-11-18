'use strict';
/**
 * ALLES 0.3.0 audit: one test per CONFIRMED bug. Each asserts the CORRECT behaviour, so every test
 * here FAILS on 0.3.0 and should pass once the bug is fixed.
 *
 * Drop into alles/test/ and run:   node --test test/audit-regressions.test.js
 * Or anywhere:                      ALLES_DIR=/path/to/alles node --test audit-regressions.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

const ROOT = process.env.ALLES_DIR || path.join(__dirname, '..');
const req = (p) => require(path.join(ROOT, 'src/main', p));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ---------------------------------------------------------------------------------------------------------
describe('coding sandbox (src/main/code)', () => {
  const { Project } = req('code/project');
  const { createCodeExecutor, ChangeTracker } = req('code/tools');

  function setup(autonomy = 'full') {
    const home = tmp('alles-home-');
    const root = path.join(home, 'proj');
    fs.mkdirSync(path.join(root, '.git/hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello\nworld\n');
    const asked = [];
    const exec = createCodeExecutor({
      project: new Project(root, { home }), tracker: new ChangeTracker(),
      approve: async (a) => { asked.push(a); return true; },
      getAutonomy: () => autonomy, requireApprovalForShell: () => false,
    });
    return { root, exec, asked };
  }

  test('BUG-1: a symlink inside the project must not be a way into .git (hook = code execution)', async () => {
    const { root, exec } = setup();
    fs.symlinkSync('.git', path.join(root, 'gitlink'));
    const r = await exec('write_file', { path: 'gitlink/hooks/pre-commit', content: '#!/bin/sh\necho pwned\n' });
    assert.ok(r.error || /not allowed/i.test(r.text), `write went through: ${r.text}`);
    assert.ok(!fs.existsSync(path.join(root, '.git/hooks/pre-commit')), 'a git hook was planted through the link');
  });

  test('BUG-2a: reading .env through a symlink with another name must still ask', async () => {
    const { root, exec, asked } = setup();
    fs.symlinkSync('.env', path.join(root, 'notes.txt'));
    await exec('read_file', { path: 'notes.txt' });
    assert.ok(asked.some((a) => a.tool === 'read_file' && a.sensitive), 'no sensitive-read question was asked');
  });

  test('BUG-2b: overwriting .env through a symlink with another name must still ask', async () => {
    const { root, exec, asked } = setup('full');
    fs.symlinkSync('.env', path.join(root, 'notes.txt'));
    await exec('write_file', { path: 'notes.txt', content: 'X=1' });
    assert.ok(asked.some((a) => a.tool === 'write_file' && a.sensitive), '.env was overwritten without a question');
  });

  test('BUG-3: end_line: null (models send null for "not given") must mean "to the end"', async () => {
    const { exec } = setup();
    const r = await exec('read_file', { path: 'a.txt', end_line: null });
    assert.ok(!r.error, r.text);
    assert.match(r.text, /world/);
  });

  test('BUG-4: timeout_seconds: null must mean the default (120 s), not 1 second', async () => {
    const { exec } = setup();
    const r = await exec('run_command', { command: 'sleep 2; echo done', timeout_seconds: null });
    assert.doesNotMatch(r.text, /TIMEOUT/);
    assert.match(r.text, /done/);
  });

  test('BUG-4b: a negative timeout_seconds is not a 1 second limit either', async () => {
    const { exec } = setup();
    const r = await exec('run_command', { command: 'sleep 2; echo done', timeout_seconds: -5 });
    assert.doesNotMatch(r.text, /TIMEOUT/);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('main tools (src/main/tools)', () => {
  const { createToolExecutor } = req('tools');

  test('BUG-5: run_shell with no/empty/non-string command must be refused BEFORE the person is asked', async () => {
    const asked = [];
    const ex = createToolExecutor({ input: {}, screen: {}, approve: async (a) => { asked.push(a); return true; } });
    for (const args of [{}, { command: '' }, { command: '   ' }, { command: null }, { command: { a: 1 } }]) {
      asked.length = 0;
      const r = await ex('run_shell', args);
      assert.strictEqual(asked.length, 0, `the person was shown an approval prompt for ${JSON.stringify(args)}`);
      assert.ok(r.error, `${JSON.stringify(args)} should be an error, got: ${r.text}`);
    }
  });

  test('BUG-6: a cwd that does not exist must be reported as such, not as "spawn /bin/sh ENOENT"', async () => {
    const ex = createToolExecutor({ input: {}, screen: {}, approve: async () => true });
    const r = await ex('run_shell', { command: 'echo hi', cwd: '/nonexistent/dir' });
    assert.doesNotMatch(r.text, /spawn \/bin\/sh ENOENT/);
    assert.match(r.text, /nonexistent|does not exist|no such/i);
  });

  test('BUG-7: read_file on a named pipe must not freeze the whole app (readFileSync blocks the event loop)', () => {
    const dir = tmp('alles-fifo-');
    const fifo = path.join(dir, 'pipe');
    assert.strictEqual(spawnSync('mkfifo', [fifo]).status, 0);
    const script = `const {createToolExecutor}=require(${JSON.stringify(path.join(ROOT, 'src/main/tools'))});
      createToolExecutor({input:{},screen:{},approve:async()=>true})('read_file',{path:${JSON.stringify(fifo)}}).then(r=>console.log(r.text))`;
    const r = spawnSync(process.execPath, ['-e', script], { timeout: 4000 });
    assert.notStrictEqual(r.error && r.error.code, 'ETIMEDOUT', 'read_file blocked forever on a FIFO');
  });

  test('BUG-8: read_file refuses special files (/dev/zero) instead of hanging', () => {
    const script = `const {createToolExecutor}=require(${JSON.stringify(path.join(ROOT, 'src/main/tools'))});
      createToolExecutor({input:{},screen:{},approve:async()=>true})('read_file',{path:'/dev/zero'}).then(r=>console.log(r.text.slice(0,80)))`;
    const r = spawnSync(process.execPath, ['--max-old-space-size=256', '-e', script], { timeout: 6000 });
    assert.notStrictEqual(r.error && r.error.code, 'ETIMEDOUT', 'read_file hung on /dev/zero');
  });

  test('BUG-9: secret-looking file NAMES outside ~/.ssh (.env, *.pem, id_rsa copies) ask like the coding area does', async () => {
    const dir = tmp('alles-sens-');
    const asked = [];
    const ex = createToolExecutor({ input: {}, screen: {}, approve: async (a) => { asked.push(a); return true; } });
    for (const name of ['.env', 'server.pem', 'id_rsa', 'credentials.json']) {
      const f = path.join(dir, name); fs.writeFileSync(f, 'top secret');
      asked.length = 0;
      await ex('read_file', { path: f });
      assert.ok(asked.length > 0, `${name} was read with no question`);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('secrets', () => {
  const { redact } = req('redact');
  const shapes = {
    'GitHub token': 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'AWS access key id': 'AKIAIOSFODNN7EXAMPLE',
    'Groq': 'gsk_abcdefghijklmnopqrstuvwxyz123456',
    'Hugging Face': 'hf_abcdefghijklmnopqrstuvwxyz',
    'Slack': 'xoxb-1234567890-abcdefghij',
    'Cerebras': 'csk-abcdefghijklmnop',
    'GitLab': 'glpat-abcdefghijklmnopqrst',
    'short Bearer token': 'Authorization: Bearer abc123',
  };
  for (const [label, text] of Object.entries(shapes)) {
    test(`BUG-10: redact() masks a ${label}`, () => assert.notStrictEqual(redact(text), text));
  }

  test('BUG-11: history redacts titles and project paths too (the file header says text is cleaned)', () => {
    const { HistoryStore } = req('history');
    const S = 'SUPERSECRETKEY123';
    const dir = path.join(tmp('alles-hist-'), 'h');
    const h = new HistoryStore({ dir, secrets: () => [S] });
    const id = h.create({ kind: 'chat', title: `t ${S}`, project: `/home/u/${S}` });
    h.rename(id, `renamed ${S}`);
    h.flush();
    const raw = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    assert.ok(!raw.includes(S), 'the key reached the disk');
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('providers', () => {
  test('BUG-12: a 307/308 redirect must not re-POST the conversation to another origin', async () => {
    const { chatCompletion } = req('providers/openai-compat');
    const seen = [];
    const evil = http.createServer((rq, rs) => { let b = ''; rq.on('data', (d) => { b += d; }); rq.on('end', () => { seen.push(b); rs.setHeader('content-type', 'application/json'); rs.end(JSON.stringify({ choices: [{ message: { content: 'from-evil' }, finish_reason: 'stop' }] })); }); });
    await new Promise((r) => evil.listen(0, '127.0.0.1', r));
    const front = http.createServer((rq, rs) => { rq.resume(); rq.on('end', () => { rs.statusCode = 307; rs.setHeader('location', `http://localhost:${evil.address().port}/x`); rs.end(); }); });
    await new Promise((r) => front.listen(0, '127.0.0.1', r));
    try {
      await chatCompletion({ messages: [{ role: 'user', content: 'PRIVATE-PROMPT' }] }, { apiKey: 'k'.repeat(20), model: 'm', baseUrl: `http://127.0.0.1:${front.address().port}/v1` }).catch(() => {});
      assert.strictEqual(seen.length, 0, 'the private prompt was re-sent to a different origin and its answer was accepted');
    } finally { front.close(); evil.close(); }
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('install.sh / launcher', () => {
  const sh = (cmd, env = {}) => spawnSync('bash', ['-c', cmd], { env: { ...process.env, ...env }, encoding: 'utf8' });

  test('BUG-13: conf_set must quote values: a --prefix with " $ or ` is shell-injected into launcher.conf', () => {
    const home = tmp('alles-conf-');
    const marker = path.join(home, 'PWNED');
    const r = sh(`set -u; source <(sed -n '/^conf_set()/,/^}/p' "${ROOT}/install.sh"); DRY=0; CONF_FILE="$HOME/c/launcher.conf";
      conf_set ALLES_HOME '/tmp/x"; touch "${marker}"; echo "'; sh -c '. "$HOME/c/launcher.conf"'`, { HOME: home });
    assert.ok(!fs.existsSync(marker), `launcher.conf executed injected code. stderr: ${r.stderr}`);
  });

  test('BUG-14: the launcher refuses every flag that turns the Chromium sandbox off, not just "--no-sandbox"', () => {
    const home = tmp('alles-launch-');
    fs.mkdirSync(path.join(home, '.config/alles'), { recursive: true });
    for (const flag of ['--disable-setuid-sandbox', '--disable-gpu-sandbox', '--no-sandbox=1', '--disable-seccomp-filter-sandbox']) {
      fs.writeFileSync(path.join(home, '.config/alles/launcher.conf'), `ALLES_FLAGS="${flag}"\n`);
      const r = spawnSync('sh', [path.join(ROOT, 'packaging/alles')], { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: '' }, encoding: 'utf8' });
      assert.match(r.stderr, /refus/i, `${flag} got past the guard`);
    }
  });

  test('BUG-15: install.sh does not hard-code a version number that is not the real one', () => {
    const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    const hard = [...fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8').matchAll(/ALLES (\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    assert.ok(hard.every((x) => x === v), `stale version in install.sh: ${hard}`);
  });
});
