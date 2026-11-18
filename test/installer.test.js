'use strict';
/**
 * install.sh and the `alles` launcher, run for real in a throwaway home directory.
 *
 * npm, sudo and gsettings are stand-ins (small shell scripts put first on PATH), so nothing is downloaded and nothing
 * outside the temp folder is touched: the fake npm "installs" a fake Electron, the fake sudo only records what it was
 * asked to run, and the fake gsettings keeps its settings in a file (and prints them the way the real one does).
 * What these tests pin: every fallback the installer promises, that the shortcut settings keep a person's own custom
 * shortcuts, that running twice changes nothing, and that uninstalling takes out exactly what was put in.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HAVE_BASH = spawnSync('bash', ['-c', 'true']).status === 0;
const skip = HAVE_BASH ? false : 'bash is not available';
const SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys';
const BASE = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings';

const write = (file, text, mode = 0o755) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, { mode }); };

/** A fresh fake machine. opts.gsettings=false leaves gsettings out; opts.keep seeds the person's own custom shortcuts. */
function machine(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alles-inst-'));
  const home = path.join(dir, 'home'); const stubs = path.join(dir, 'stubs'); const state = path.join(dir, 'state');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(state, { recursive: true });

  write(path.join(stubs, 'npm'), `#!/bin/sh
case "$1" in
  -v|--version) echo 10.0.0; exit 0;;
  ci)      [ "\${FAKE_NPM_CI:-ok}" = fail ] && { echo "npm ci: no network" >&2; exit 1; } ;;
  install) [ "\${FAKE_NPM_INSTALL:-ok}" = fail ] && { echo "npm install: no network" >&2; exit 1; } ;;
esac
echo "$1" >> "$STUB_STATE/npm.log"
mkdir -p node_modules/electron/dist node_modules/dbus-next
printf '#!/bin/sh\\necho "$@" > "$STUB_STATE/electron-args"\\n' > node_modules/electron/dist/electron
chmod 755 node_modules/electron/dist/electron
: > node_modules/electron/dist/chrome-sandbox
`);
  // `id` is a stand-in too, so these tests behave the same whether the suite runs as a normal user or as root (a container)
  write(path.join(stubs, 'id'), `#!/bin/sh
case "$1" in -u) echo "\${FAKE_UID:-1000}";; -un) echo tester;; -nG) echo "tester \${FAKE_GROUPS:-users}";; *) exec /usr/bin/id "$@";; esac
`);
  write(path.join(stubs, 'sudo'), `#!/bin/sh
[ "$1" = -n ] && shift
[ "$1" = true ] && exit 0
echo "$@" >> "$STUB_STATE/sudo.log"
[ "\${FAKE_SUDO:-ok}" = fail ] && exit 1
exit 0
`);
  if (opts.gsettings !== false) {
    write(path.join(stubs, 'gsettings'), `#!/bin/sh
f() { printf '%s' "$STUB_STATE/gs-$(printf '%s %s' "$1" "$2" | tr -c 'A-Za-z0-9' _)"; }
case "$1" in
  get) file=$(f "$2" "$3")
       if [ -f "$file" ]; then if [ "$3" = custom-keybindings ]; then cat "$file"; else printf "'%s'\\n" "$(cat "$file")"; fi
       elif [ "$3" = custom-keybindings ]; then echo "@as []"; elif [ "$2" = "${SCHEMA}" ]; then exit 1; else echo "''"; fi;;
  set) printf '%s' "$4" > "$(f "$2" "$3")"; echo "$2 $3 $4" >> "$STUB_STATE/gsettings.log";;
  reset) rm -f "$(f "$2" "$3")";;
esac
`);
  }
  const gsGet = (schema, key) => { const p = path.join(state, 'gs-' + `${schema} ${key}`.replace(/[^A-Za-z0-9]/g, '_')); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; };
  if (opts.keep) fs.writeFileSync(path.join(state, 'gs-' + `${SCHEMA} custom-keybindings`.replace(/[^A-Za-z0-9]/g, '_')), opts.keep);

  const env = {
    PATH: `${stubs}:/opt/nvm/versions/node/v22.16.0/bin:/usr/local/bin:/usr/bin:/bin`, HOME: home, STUB_STATE: state,
    XDG_CURRENT_DESKTOP: 'GNOME', XDG_SESSION_TYPE: 'wayland', LANG: 'C',
    ...(opts.env || {}),
  };
  const install = (...args) => spawnSync('bash', [path.join(ROOT, 'install.sh'), ...args], { env, encoding: 'utf8', cwd: dir });
  const read = (rel) => fs.readFileSync(path.join(home, rel), 'utf8');
  const exists = (rel) => fs.existsSync(path.join(home, rel));
  const log = (name) => { const p = path.join(state, name); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; };
  return { dir, home, state, env, install, read, exists, log, gsGet, app: path.join(home, '.local/share/alles'), bin: path.join(home, '.local/bin/alles'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a normal install on GNOME: app, command, menu entry, and both shortcuts', { skip }, () => {
  const m = machine();
  try {
    const r = m.install('--no-autostart');
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    for (const f of ['package.json', 'src/main/index.js', 'assets/alles.svg', 'install.sh', 'node_modules/electron/dist/electron']) assert.ok(fs.existsSync(path.join(m.app, f)), `${f} is installed`);
    assert.ok(!fs.existsSync(path.join(m.app, 'test')) && !fs.existsSync(path.join(m.app, 'scripts')), 'tests and dev scripts are not copied');
    assert.ok(fs.statSync(m.bin).mode & 0o111, 'the alles command is executable');
    
    assert.ok(m.exists('.local/share/icons/hicolor/scalable/apps/alles.svg'));

    const list = m.gsGet(SCHEMA, 'custom-keybindings');
    assert.ok(list.includes(`'${BASE}/alles/'`) && list.includes(`'${BASE}/alles-copilot/'`), list);
    assert.strictEqual(m.gsGet(`${SCHEMA}.custom-keybinding:${BASE}/alles/`, 'binding'), '<Control><Shift>d');
    assert.strictEqual(m.gsGet(`${SCHEMA}.custom-keybinding:${BASE}/alles-copilot/`, 'binding'), '<Super><Shift>F23');
    assert.strictEqual(m.gsGet(`${SCHEMA}.custom-keybinding:${BASE}/alles/`, 'command'), `${m.bin} --show`, 'the shortcut starts ALLES with the island open');
    const desktop = m.read('.local/share/applications/alles.desktop');
    assert.match(desktop, /^Exec="[^"]+\/alles" --window$/m, 'the menu entry opens the workspace window');
    assert.match(desktop, /\[Desktop Action pill\]\nName=Open the pill\nExec="[^"]+\/alles" --show$/m, 'and offers the pill as an action');
    assert.match(m.log('sudo.log'), /chown root:root .*chrome-sandbox/);
    assert.match(m.log('sudo.log'), /chmod 4755 .*chrome-sandbox/);
    assert.ok(!m.exists('.config/alles/launcher.conf'), 'with a working sandbox the launcher needs no special flags');
    assert.ok(!m.exists('.config/autostart/alles.desktop'));
  } finally { m.cleanup(); }
});

test('a person\'s own custom shortcuts are kept, and a second run changes nothing', { skip }, () => {
  const mine = `['/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/']`;
  const m = machine({ keep: mine });
  try {
    assert.strictEqual(m.install('--no-autostart').status, 0);
    const once = m.gsGet(SCHEMA, 'custom-keybindings');
    assert.ok(once.startsWith(`['${BASE}/custom0/', `), `their shortcut stays first: ${once}`);
    assert.strictEqual((once.match(/'/g) || []).length, 6, 'three entries, nothing doubled');
    assert.strictEqual(m.install('--no-autostart').status, 0);
    assert.strictEqual(m.gsGet(SCHEMA, 'custom-keybindings'), once, 'installing again leaves the list exactly as it was');
  } finally { m.cleanup(); }
});

test('a shortcut already used by one of the person\'s own is reported, not overwritten', { skip }, () => {
  const mine = `['${BASE}/custom0/']`;
  const m = machine({ keep: mine });
  try {
    fs.writeFileSync(path.join(m.state, 'gs-' + `${SCHEMA}.custom-keybinding:${BASE}/custom0/ binding`.replace(/[^A-Za-z0-9]/g, '_')), '<Control><Shift>d');
    const r = m.install('--no-autostart');
    assert.strictEqual(r.status, 0);
    assert.match(r.stderr, /already used by another shortcut/);
    assert.strictEqual(m.gsGet(`${SCHEMA}.custom-keybinding:${BASE}/custom0/`, 'binding'), '<Control><Shift>d', 'theirs is untouched');
  } finally { m.cleanup(); }
});

test('--shortcut and --no-copilot-key are honoured', { skip }, () => {
  const m = machine();
  try {
    assert.strictEqual(m.install('--no-autostart', '--shortcut', '<Super>space', '--no-copilot-key').status, 0);
    assert.strictEqual(m.gsGet(`${SCHEMA}.custom-keybinding:${BASE}/alles/`, 'binding'), '<Super>space');
    assert.strictEqual(m.gsGet(`${SCHEMA}.custom-keybinding:${BASE}/alles-copilot/`, 'binding'), null);
    assert.ok(!m.gsGet(SCHEMA, 'custom-keybindings').includes('alles-copilot'));
  } finally { m.cleanup(); }
});

test('fallback: npm ci fails, npm install is used', { skip }, () => {
  const m = machine({ env: { FAKE_NPM_CI: 'fail' } });
  try {
    const r = m.install('--no-autostart');
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /npm ci failed; trying npm install/);
    assert.strictEqual(m.log('npm.log').trim(), 'install');
  } finally { m.cleanup(); }
});

test('fallback: no network at all, but this folder already has node_modules, so those are used', { skip }, () => {
  const m = machine({ env: { FAKE_NPM_CI: 'fail', FAKE_NPM_INSTALL: 'fail' } });
  const copy = path.join(m.dir, 'checkout');
  try {
    fs.mkdirSync(copy);
    for (const f of ['src', 'assets', 'packaging', 'package.json', 'package-lock.json', 'install.sh']) fs.cpSync(path.join(ROOT, f), path.join(copy, f), { recursive: true });
    write(path.join(copy, 'node_modules/electron/dist/electron'), '#!/bin/sh\n');
    fs.mkdirSync(path.join(copy, 'node_modules/dbus-next'), { recursive: true });
    const r = spawnSync('bash', [path.join(copy, 'install.sh'), '--no-autostart'], { env: m.env, encoding: 'utf8', cwd: m.dir });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /using the node_modules next to install\.sh/);
    assert.ok(fs.existsSync(path.join(m.app, 'node_modules/electron/dist/electron')));
  } finally { m.cleanup(); }
});

test('fallback: nothing works for the dependencies, so it stops and says why (and does not claim success)', { skip }, () => {
  const m = machine({ env: { FAKE_NPM_CI: 'fail', FAKE_NPM_INSTALL: 'fail' } });
  try {
    const r = m.install('--no-autostart');
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /Could not install the dependencies/);
    assert.ok(!m.exists('.local/bin/alles'), 'no half-installed command is left behind');
  } finally { m.cleanup(); }
});

test('sandbox setup requires administrator permission instead of disabling Chromium sandboxing', { skip }, () => {
  const m = machine();
  try {
    const r = m.install('--no-autostart', '--no-sudo');
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /Chromium sandbox setup needs administrator permission/);
    assert.match(r.stderr, /sudo chown root:root/);
    assert.strictEqual(m.log('sudo.log'), '', 'sudo was never called with --no-sudo');
    assert.ok(!m.exists('.local/bin/alles'), 'a launcher is not installed without a working sandbox');
    assert.ok(!m.exists('.config/alles/launcher.conf'), 'the installer does not write --no-sandbox');
  } finally { m.cleanup(); }
});

test('sandbox setup failure from sudo stops installation and leaves no --no-sandbox fallback', { skip }, () => {
  const m = machine({ env: { FAKE_SUDO: 'fail' } });
  try {
    const r = m.install('--no-autostart');
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /Chromium sandbox setup needs administrator permission/);
    assert.ok(!m.exists('.local/bin/alles'));
    assert.ok(!m.exists('.config/alles/launcher.conf'));
  } finally { m.cleanup(); }
});

test('fallback: a desktop with no usable shortcut settings gets the exact manual steps, and the install still succeeds', { skip }, () => {
  const m = machine({ gsettings: false, env: { XDG_CURRENT_DESKTOP: 'XFCE' } });
  try {
    const r = m.install('--no-autostart');
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /Could not set the keyboard shortcut automatically/);
    assert.ok(r.stdout.includes(`command:  ${m.bin} --show`));
    assert.match(r.stdout, /keys:\s+Ctrl\+Shift\+D/);
    assert.match(r.stdout, /Copilot key/);
    assert.ok(m.exists('.local/bin/alles'));
  } finally { m.cleanup(); }
});

test('KDE: the shortcut is written for the desktop entry, in KDE\'s key names', { skip }, () => {
  const m = machine({ gsettings: false, env: { XDG_CURRENT_DESKTOP: 'KDE' } });
  try {
    write(path.join(m.dir, 'stubs/kwriteconfig6'), '#!/bin/sh\necho "$@" >> "$STUB_STATE/kwrite.log"\n');
    const r = m.install('--no-autostart');
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const line = m.log('kwrite.log');
    assert.match(line, /--file kglobalshortcutsrc --group alles\.desktop --key _launch Ctrl\+Shift\+D\tMeta\+Shift\+F23,none,ALLES/);
  } finally { m.cleanup(); }
});

test('--no-shortcut leaves the keyboard settings alone', { skip }, () => {
  const m = machine();
  try {
    assert.strictEqual(m.install('--no-autostart', '--no-shortcut').status, 0);
    assert.strictEqual(m.log('gsettings.log'), '');
  } finally { m.cleanup(); }
});

test('--autostart writes the login entry; the default release configuration leaves GNOME autostart off', { skip }, () => {
  const m = machine();
  try {
    assert.strictEqual(m.install().status, 0);
    assert.ok(!m.exists('.config/autostart/alles.desktop'), 'autostart is not enabled by default');
    assert.match(fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8'), /AUTOSTART=no/, 'source installer also defaults to no autostart');
    assert.strictEqual(m.install('--autostart').status, 0);
    assert.match(m.read('.config/autostart/alles.desktop'), /^Exec="[^"]+\/alles"$/m, 'logging in starts it quietly, without opening the island');
  } finally { m.cleanup(); }
});

test('Node.js missing: says exactly what to do instead of failing in the middle', { skip }, () => {
  const m = machine();
  try {
    // a PATH with only the stubs and the few tools the script itself needs - no node, no npm
    const tools = path.join(m.dir, 'tools'); fs.mkdirSync(tools);
    for (const t of ['bash', 'sh', 'uname', 'dirname', 'cat', 'sed', 'grep', 'tr', 'mkdir', 'rm', 'cp', 'stat', 'install', 'mv', 'tee']) {
      const p = spawnSync('bash', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim(); if (p) fs.symlinkSync(p, path.join(tools, t));
    }
    fs.rmSync(path.join(m.dir, 'stubs/npm'));
    const r = spawnSync(path.join(tools, 'bash'), [path.join(ROOT, 'install.sh'), '--no-autostart'], { env: { ...m.env, PATH: `${m.dir}/stubs:${tools}` }, encoding: 'utf8', cwd: m.dir });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /Install Node\.js 22\.12\+ and npm yourself/);
    assert.match(r.stderr, /Node.js 22\.12\+/);
    assert.ok(!m.exists('.local/bin/alles'));
  } finally { m.cleanup(); }
});

test('--dry-run changes nothing at all', { skip }, () => {
  const m = machine();
  try {
    const r = m.install('--dry-run', '--autostart');
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /would run/);
    assert.deepStrictEqual(fs.readdirSync(m.home), [], 'the home directory is still empty');
    assert.strictEqual(m.log('gsettings.log'), '');
    assert.strictEqual(m.log('sudo.log'), '');
  } finally { m.cleanup(); }
});

test('refuses to run as root unless told otherwise (it installs for one user)', { skip }, () => {
  const m = machine({ env: { FAKE_UID: '0' } });
  try {
    const r = m.install('--no-autostart');
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /Do not run this as root/);
  } finally { m.cleanup(); }
});

test('uninstall removes what was installed, keeps the settings, keeps the person\'s own shortcuts; --purge deletes the settings', { skip }, () => {
  const mine = `['${BASE}/custom0/']`;
  const m = machine({ keep: mine });
  try {
    assert.strictEqual(m.install('--autostart').status, 0);
    write(path.join(m.home, '.config/alles/alles/settings.json'), '{}\n', 0o644);
    const r = spawnSync('bash', [path.join(m.app, 'install.sh'), '--uninstall'], { env: m.env, encoding: 'utf8', cwd: m.dir });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    for (const f of ['.local/bin/alles', '.local/share/applications/alles.desktop', '.local/share/icons/hicolor/scalable/apps/alles.svg', '.config/autostart/alles.desktop']) assert.ok(!m.exists(f), `${f} is gone`);
    assert.ok(!fs.existsSync(m.app), 'the app folder is gone');
    assert.strictEqual(m.gsGet(SCHEMA, 'custom-keybindings'), mine, 'only the person\'s own shortcut is left in the list');
    assert.ok(m.exists('.config/alles/alles/settings.json'), 'settings are kept');
    assert.strictEqual(m.install('--no-autostart').status, 0);
    const purge = spawnSync('bash', [path.join(m.app, 'install.sh'), '--uninstall', '--purge'], { env: m.env, encoding: 'utf8', cwd: m.dir });
    assert.strictEqual(purge.status, 0, purge.stdout + purge.stderr);
    assert.ok(!m.exists('.config/alles'), '--purge deletes the settings');
  } finally { m.cleanup(); }
});

test('uninstall leaves a folder that is not ALLES alone', { skip }, () => {
  const m = machine();
  try {
    const other = path.join(m.dir, 'precious'); write(path.join(other, 'package.json'), '{"name":"something-else"}\n', 0o644);
    const r = spawnSync('bash', [path.join(ROOT, 'install.sh'), '--uninstall', '--prefix', other], { env: m.env, encoding: 'utf8', cwd: m.dir });
    assert.strictEqual(r.status, 0);
    assert.ok(fs.existsSync(path.join(other, 'package.json')));
  } finally { m.cleanup(); }
});

// ---------------------------------------------------------------- the `alles` command

function launcher(env) {
  const m = machine({ env });
  const run = (args = [], extra = {}) => {
    try { fs.unlinkSync(path.join(m.state, 'electron-args')); } catch { /* none yet */ }
    const r = spawnSync('sh', [path.join(ROOT, 'packaging/alles'), ...args], { env: { ...m.env, ...extra }, encoding: 'utf8', cwd: m.dir });
    return { ...r, args: m.log('electron-args').trim() };
  };
  return { m, run };
}
function withElectron(m) {   // a checkout-style app with a fake Electron, as the launcher finds it
  const app = path.join(m.dir, 'app'); fs.mkdirSync(app);
  write(path.join(app, 'package.json'), '{"name":"alles"}\n', 0o644); fs.mkdirSync(path.join(app, 'src'));
  write(path.join(app, 'node_modules/electron/dist/electron'), '#!/bin/sh\necho "$@" > "$STUB_STATE/electron-args"\n');
  return app;
}

test('launcher: on Wayland with XWayland it asks for X11 and passes the app folder', { skip }, () => {
  const { m, run } = launcher();
  try {
    const app = withElectron(m);
    const r = run([], { ALLES_HOME: app, WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.args, `--ozone-platform=x11 ${app}`);
  } finally { m.cleanup(); }
});

test('launcher: no extra flags on a plain X11 session; the person\'s own --ozone-platform wins; ALLES_NO_X11 turns it off', { skip }, () => {
  const { m, run } = launcher();
  try {
    const app = withElectron(m);
    assert.strictEqual(run([], { ALLES_HOME: app, DISPLAY: ':0', WAYLAND_DISPLAY: '' }).args, app);
    assert.strictEqual(run(['--ozone-platform=wayland'], { ALLES_HOME: app, WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }).args, `${app} --ozone-platform=wayland`);
    assert.strictEqual(run([], { ALLES_HOME: app, WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0', ALLES_NO_X11: '1' }).args, app);
  } finally { m.cleanup(); }
});

test('launcher: flags and ALLES_HOME come from launcher.conf, and a missing Electron is a clear error', { skip }, () => {
  const { m, run } = launcher();
  try {
    const app = withElectron(m);
    write(path.join(m.home, '.config/alles/launcher.conf'), `ALLES_HOME="${app}"\nALLES_FLAGS="--no-sandbox"\n`, 0o644);
    const unsafe = run([], { DISPLAY: ':0', WAYLAND_DISPLAY: '' });
    assert.notStrictEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /refusing --no-sandbox/);
    write(path.join(m.home, '.config/alles/launcher.conf'), `ALLES_HOME="${app}"\n`, 0o644);
    fs.rmSync(path.join(app, 'node_modules'), { recursive: true });
    const r = run([], { DISPLAY: ':0' });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /Electron was not found/);
  } finally { m.cleanup(); }
});
