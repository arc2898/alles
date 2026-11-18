'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn: nodeSpawn } = require('node:child_process');
const { toScreen } = require('../computer/screen');
const { makeIsSensitive, SENSITIVE_NAME } = require('../sensitive');

/**
 * Tools the model can call. Schemas are OpenAI function-calling format, which
 * NVIDIA / Grok / Gemini's OpenAI-compatible endpoints all accept.
 *
 * COORDINATES: the model only ever sees the DOWNSCALED screenshot, so every
 * x/y it emits is in that space. executeTool() converts to real pixels using
 * the scale from the most recent screenshot.
 */

const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

const TYPE_TEXT_ASCII = 'Type text into the focused control. Plain US-keyboard characters only: letters, digits, punctuation, space, newline (Enter), tab. Curly quotes, dashes and ellipses are converted automatically; any other non-ASCII character (accents, emoji, non-Latin scripts) is rejected and nothing is typed. A newline presses Enter.';
const TYPE_TEXT_UNICODE = 'Type text into the focused control. Letters, digits, punctuation, space and tab are typed key by key; a newline presses Enter. Any other character (accents, the rupee sign, emoji, non-Latin scripts) is entered by pasting it, which borrows the clipboard for a moment and puts it back. Set terminal to true when the focused window is a terminal emulator: pasting there needs Ctrl+Shift+V.';

/**
 * The tools the model is offered. `unicode` says whether the way input is carried out can enter any text (GNOME direct input)
 * or only plain US-keyboard characters (ydotool): the description of type_text must tell the model the truth either way.
 */
function buildToolSchemas({ unicode = false } = {}) {
  return [
    fn('screenshot', 'Capture the screen. Call this first, and again after every action to see the result.'),
    fn('mouse_move', 'Move the mouse pointer to (x, y) in screenshot coordinates.',
      { x: { type: 'number' }, y: { type: 'number' } }, ['x', 'y']),
    fn('mouse_click', 'Move to (x, y) in screenshot coordinates and click.', {
      x: { type: 'number' }, y: { type: 'number' },
      button: { type: 'string', enum: ['left', 'right', 'middle'] },
      double: { type: 'boolean' },
    }, ['x', 'y']),
    fn('mouse_scroll', 'Turn the mouse wheel to scroll a page, list or document. Give x and y (screenshot coordinates) to scroll the thing under that point; leave them out to scroll where the pointer already is. amount is the number of wheel notches (default 5); a notch is about three lines.', {
      x: { type: 'number' }, y: { type: 'number' },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      amount: { type: 'number' },
    }, ['direction']),
    fn('mouse_drag', 'Press the mouse button at (from_x, from_y), move to (to_x, to_y) and let go, all in screenshot coordinates. For sliders, scroll bars, selecting text, resizing or moving windows, and drag and drop.', {
      from_x: { type: 'number' }, from_y: { type: 'number' }, to_x: { type: 'number' }, to_y: { type: 'number' },
      button: { type: 'string', enum: ['left', 'right', 'middle'] },
    }, ['from_x', 'from_y', 'to_x', 'to_y']),
    fn('type_text', unicode ? TYPE_TEXT_UNICODE : TYPE_TEXT_ASCII,
      unicode ? { text: { type: 'string' }, terminal: { type: 'boolean' } } : { text: { type: 'string' } }, ['text']),
    fn('press_keys', 'Press a key combination such as "ctrl+c", "alt+tab", "enter", "super".',
      { keys: { type: 'string' } }, ['keys']),
    fn('run_shell', 'Run a shell command and return its output. Prefer this over clicking when possible.',
      { command: { type: 'string' }, cwd: { type: 'string' } }, ['command']),
    fn('read_file', 'Read a text file.', { path: { type: 'string' } }, ['path']),
    fn('write_file', 'Write a text file (overwrites).', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
    fn('list_dir', 'List a directory.', { path: { type: 'string' } }, ['path']),
    fn('wait', 'Wait for the UI to settle.', { seconds: { type: 'number' } }, ['seconds']),
    fn('finish', 'Call when the task is complete, with a short summary for the user.', { summary: { type: 'string' } }, ['summary']),
  ];
}

const TOOL_SCHEMAS = buildToolSchemas({ unicode: false });

const MAX_OUTPUT = 8000;
const truncate = (s) => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…[truncated ${s.length - MAX_OUTPUT} chars]` : s);

// A yes/no argument that comes as text ("true", "false") must not turn "false" into yes (any non-empty text is truthy in JavaScript).
const flag = (v) => v === true || (typeof v === 'string' && v.trim().toLowerCase() === 'true');

// What the model said (a tool name, arguments that were not JSON) is quoted back to it in an answer, which then stays in the history of
// the whole task: a long one is cut, so one garbled reply cannot fill the context.
const ECHO_MAX = 300;
const echo = (v, n) => { const s = String(v); return s.length <= n ? s : `${s.slice(0, n)}… (${s.length - n} more characters)`; };

const MAX_READ = 1024 * 1024;      // more than this of one file is never needed: the answer is cut at 8000 characters anyway

/** Reads at most MAX_READ bytes of a REGULAR file. A named pipe or a device (/dev/zero) would block the whole app for ever. */
function readRegularFile(abs) {
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error(`${abs} is not a regular file (it is a ${st.isDirectory() ? 'folder' : 'pipe, device or socket'}), so it is not read.`);
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(Math.min(st.size, MAX_READ));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n);
  } finally { fs.closeSync(fd); }
}

/** Expand ~ and resolve relative paths against the home directory. */
function resolvePath(p) {
  if (typeof p !== 'string' || !p) throw new Error('path is required');
  const expanded = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
  return path.resolve(os.homedir(), expanded);
}

const STOPPED_TEXT = 'exit_code: STOPPED\nThe user pressed Stop, so the command was cancelled.';
const MAX_COLLECT = 4 * 1024 * 1024;   // a command that prints more than this is not going to finish usefully
const DRAIN_MS = 400;                   // after the shell itself has ended: how long to wait for the last of what it printed

/**
 * Run a shell command and report what it printed, in the form the model reads: "exit_code: N", then stdout and stderr.
 *
 *  - The command runs in a process group of its own, and the WHOLE group is killed when it must end (Stop, time limit, too much
 *    output): `sh -c "a; b"` has children of its own, and a child left running would carry on working after Stop.
 *  - It is answered when the SHELL has ended, not when everything the shell started has let go of the output. `firefox &` or
 *    `xdg-open url` leaves a program running that holds the output open for as long as it lives: waiting for that would hang the task
 *    until the person closed the program. Such a program is NOT killed (it is what the person asked for); the answer says it is still running.
 *  - `signal`: when it fires (the person pressed Stop) the command is killed and the answer comes back at once.
 *  - The command gets no keyboard: a command that asks for input ends at once instead of waiting for ever.
 */
function runShell(command, cwd, { spawn = nodeSpawn, timeoutMs = 60_000, signal = null, drainMs = DRAIN_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false; let child = null; let timer = null; let grace = null;
    let out = ''; let err = ''; let size = 0; let exitCode = null;
    let timedOut = false; let overflow = false; let leftRunning = false;

    const onAbort = () => { killAll(); settle(STOPPED_TEXT); };
    const killAll = () => {
      try { if (child && child.pid) process.kill(-child.pid, 'SIGKILL'); else if (child && child.kill) child.kill('SIGKILL'); }
      catch { try { if (child && child.kill) child.kill('SIGKILL'); } catch { /* already gone */ } }
    };
    const render = () => {
      const code = timedOut ? 'TIMEOUT' : overflow ? 'OUTPUT-TOO-LONG' : (typeof exitCode === 'number' ? exitCode : -1);
      return [
        `exit_code: ${code}`,
        overflow ? 'The command printed far too much, so it was stopped.' : '',
        out ? `stdout:\n${out}` : '',
        err ? `stderr:\n${err}` : '',
        leftRunning ? 'Note: the command ended, but a program it started is still running in the background.' : '',
      ].filter(Boolean).join('\n');
    };
    const settle = (text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(grace);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(truncate(text === undefined ? render() : text));
      out = ''; err = '';                               // from here on the output of a program left running is only drained
      if (leftRunning && child) { try { child.unref(); child.stdout.unref(); child.stderr.unref(); } catch { /* best effort */ } }
    };

    if (signal && signal.aborted) { settle(STOPPED_TEXT); return; }
    let where;
    try { where = cwd ? resolvePath(cwd) : os.homedir(); } catch (e) { settle(`exit_code: -1\nstderr:\n${e.message}`); return; }
    // Node reports a missing working folder as "spawn /bin/sh ENOENT", which sends the model looking for the wrong thing.
    try { if (!fs.statSync(where).isDirectory()) { settle(`exit_code: -1\nstderr:\nThe working folder ${where} is not a folder.`); return; } }
    catch { settle(`exit_code: -1\nstderr:\nThe working folder ${where} does not exist.`); return; }
    try {
      child = spawn('/bin/sh', ['-c', command], { cwd: where, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { settle(`exit_code: -1\nstderr:\n${e.message}`); return; }
    if (!child || !child.stdout || !child.stderr) { settle('exit_code: -1\nstderr:\nThe shell could not be started.'); return; }

    const take = (isErr) => (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_COLLECT) { overflow = true; killAll(); settle(); return; }
      if (isErr) err += chunk; else out += chunk;
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', take(false)); child.stderr.on('data', take(true));
    child.on('error', (e) => { err += `${e.message}\n`; settle(); });
    child.on('exit', (code) => {
      exitCode = code;
      grace = setTimeout(() => { leftRunning = true; settle(); }, drainMs);
    });
    child.on('close', (code) => { if (exitCode === null) exitCode = code; settle(); });
    timer = setTimeout(() => { timedOut = true; killAll(); settle(); }, timeoutMs);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Build the executor bound to one agent session.
 * deps: { input, screen, approve(action)->Promise<boolean>, state }
 * approve is REQUIRED for run_shell/write_file; if absent they are denied.
 * state.lastShot is updated on every screenshot.
 * The executor it returns is called as executeTool(name, args, { signal }): when `signal` fires (the person pressed Stop) a tool that
 * takes time - wait, run_shell - ends at once instead of running to the end.
 */
function createToolExecutor({ input, screen, approve, state = {}, spawn = nodeSpawn, isSensitivePath = makeIsSensitive() }) {
  // FAIL CLOSED: run_shell / write_file are only allowed if the caller wired up a
  // real approval callback. A forgotten wire-up must deny, never silently allow.
  if (typeof approve !== 'function') approve = async () => false;
  // approve() may answer true/false, or {allow, reason} (the ApprovalBroker's form).
  const ask = async (action) => {
    const v = await approve(action);
    const allow = v === true || (!!v && v.allow === true);
    const reason = v && typeof v === 'object' && v.reason ? String(v.reason) : '';
    return { allow, text: allow ? '' : `DENIED${reason ? `: ${reason}` : ' by the user.'} Do not retry the same action; ask the user what to do instead.` };
  };

  const needScale = () => {
    if (!state.lastShot) throw new Error('Take a screenshot first - coordinates are relative to the latest one');
    return state.lastShot.scale;
  };

  /**
   * A point the model named, in the picture it was shown, as a point on the real screen. A point OUTSIDE the picture is the model
   * misreading it (a wrong guess about the size, a coordinate from an older picture): clicking at the nearest edge instead would hit
   * a scroll bar or a window button it never meant, so it is told, and looks again.
   */
  const place = (x, y, what = '') => {
    const scale = needScale();
    const nx = Number(x); const ny = Number(y);
    if (x === undefined || y === undefined || x === null || y === null || !Number.isFinite(nx) || !Number.isFinite(ny)) throw new Error(`${what}x and y must be numbers`);
    const shot = state.lastShot;
    const w = shot.modelWidth; const h = shot.modelHeight;
    if (w > 0 && h > 0 && (nx < 0 || ny < 0 || nx > w || ny > h)) {
      throw new Error(`${what}(${x}, ${y}) is outside the screenshot, which is ${w}x${h}. Give x from 0 to ${w} and y from 0 to ${h}, as the picture shows them (take a new screenshot if unsure).`);
    }
    return toScreen(nx, ny, scale);
  };

  // The size of the full-resolution picture the coordinates came from, so a way of sending input that works in the screen's
  // own pixels (GNOME direct input) can place the pointer exactly even when the screen is scaled.
  const spaceOpt = () => {
    const shot = state.lastShot;
    return shot && shot.width > 0 && shot.height > 0 ? { space: { width: shot.width, height: shot.height } } : {};
  };

  const handlers = {
    async screenshot() {
      const shot = await screen.capture();
      state.lastShot = shot;
      return { text: `Screenshot ${shot.modelWidth}x${shot.modelHeight}. Coordinates you emit must be in this space.`, image: shot.png };
    },
    async mouse_move({ x, y }) {
      const p = place(x, y);
      await input.moveTo(p.x, p.y, spaceOpt());
      return { text: `Moved to (${x}, ${y})` };
    },
    async mouse_click({ x, y, button = 'left', double = false }) {
      const p = place(x, y);
      const twice = flag(double);
      await input.moveTo(p.x, p.y, spaceOpt());
      await input.click(button, { double: twice });
      return { text: `${twice ? 'Double-' : ''}${button}-clicked (${x}, ${y})` };
    },
    async mouse_scroll({ x, y, direction, amount }) {
      const vec = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[String(direction || '').toLowerCase()];
      if (!vec) throw new Error('direction must be "up", "down", "left" or "right"');
      const given = (v) => v !== undefined && v !== null;
      if (given(x) !== given(y)) throw new Error('Give both x and y to scroll at a point, or neither to scroll where the pointer is');
      const asked = Number(amount);
      const n = Math.min(Math.max(Number.isFinite(asked) && given(amount) ? Math.round(asked) : 5, 1), 50);
      let at = '';
      if (given(x)) {
        const p = place(x, y);
        await input.moveTo(p.x, p.y, spaceOpt());
        at = ` at (${x}, ${y})`;
      }
      await input.scroll(vec[0] * n, vec[1] * n);
      return { text: `Scrolled ${String(direction).toLowerCase()} ${n} notch${n === 1 ? '' : 'es'}${at}` };
    },
    async mouse_drag({ from_x, from_y, to_x, to_y, button = 'left' }) {
      const a = place(from_x, from_y, 'The start ');
      const b = place(to_x, to_y, 'The end ');
      await input.drag(a, b, { button, ...spaceOpt() });
      return { text: `Dragged from (${from_x}, ${from_y}) to (${to_x}, ${to_y})` };
    },
    async type_text({ text, terminal }) {
      if (typeof text !== 'string') throw new Error('type_text needs a "text" string');
      const r = await input.type(text, flag(terminal) ? { terminal: true } : undefined);
      const typed = r && Number.isFinite(r.typed) ? r.typed : text.length;
      const notes = r && Array.isArray(r.notes) && r.notes.length ? ` Note: ${r.notes.join('; ')}.` : '';
      return { text: `Typed ${typed} chars.${notes}` };
    },
    async press_keys({ keys }) { await input.pressCombo(keys); return { text: `Pressed ${keys}` }; },
    async run_shell({ command, cwd }, { signal } = {}) {
      // Refused BEFORE the person is asked: an approval prompt for an empty or garbled command is noise, and what is shown must be what runs.
      if (typeof command !== 'string' || !command.trim()) throw new Error('command is required: give the shell command as text.');
      if (cwd !== undefined && cwd !== null && typeof cwd !== 'string') throw new Error('cwd must be text (a folder path).');
      if (cwd === null) cwd = undefined;
      const v = await ask({ tool: 'run_shell', command, ...(cwd ? { cwd } : {}) });
      if (!v.allow) return { text: v.text };
      return { text: await runShell(command, cwd, { spawn, signal }) };
    },
    async read_file({ path: p }) {
      const abs = resolvePath(p);
      // Prompt-injection guard: credentials and key material are only read if the user says so.
      if (isSensitivePath(abs)) {
        const v = await ask({ tool: 'read_file', path: abs, sensitive: true });
        if (!v.allow) return { text: v.text };
      }
      let real = abs; try { real = fs.realpathSync(abs); } catch { /* does not exist: the read below says so */ }
      if (!isSensitivePath(abs) && (SENSITIVE_NAME.test(path.basename(abs)) || SENSITIVE_NAME.test(path.basename(real)) || isSensitivePath(real))) {
        const v = await ask({ tool: 'read_file', path: abs, sensitive: true });
        if (!v.allow) return { text: v.text };
      }
      const buf = readRegularFile(abs);
      if (buf.includes(0)) return { text: `${abs} looks like a binary file (${buf.length} bytes); not reading it.` };
      return { text: truncate(buf.toString('utf8')) };
    },
    async write_file({ path: p, content }) {
      const abs = resolvePath(p);
      const v = await ask({ tool: 'write_file', path: abs, bytes: Buffer.byteLength(content), preview: String(content).slice(0, 1000) });
      if (!v.allow) return { text: v.text };
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      return { text: `Wrote ${Buffer.byteLength(content)} bytes to ${abs}` };
    },
    async list_dir({ path: p }) {
      const abs = resolvePath(p);
      const rows = fs.readdirSync(abs, { withFileTypes: true }).map((d) => `${d.isDirectory() ? 'd' : '-'} ${d.name}`);
      return { text: truncate(rows.join('\n') || '(empty)') };
    },
    async wait({ seconds }, { signal } = {}) {
      // NOT `Number(seconds) || 1`: that turns an explicit 0 into 1 (0 is falsy).
      const n = Number(seconds);
      const s = Math.min(Math.max(Number.isFinite(n) ? n : 1, 0), 30);
      const t0 = Date.now();
      await new Promise((resolve) => {
        if (signal && signal.aborted) { resolve(); return; }
        const onAbort = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, s * 1000);
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
      });
      if (signal && signal.aborted) return { text: `Stopped after waiting ${Math.round((Date.now() - t0) / 100) / 10}s: the user pressed Stop.` };
      return { text: `Waited ${s}s` };
    },
    async finish({ summary }) {
      // The summary is what the person is shown. A model sometimes leaves it out or sends something that is not text: finishing still finishes.
      const said = typeof summary === 'string' ? summary.trim() : (summary == null ? '' : JSON.stringify(summary));
      return { text: said || 'Done.', done: true };
    },
  };

  return async function executeTool(name, args, { signal = null } = {}) {
    // OWN names only: a model that asks for "constructor" or "toString" must get "Unknown tool", not Object's own function
    // (which "runs", answers with something that has no text, and leaves a tool message the provider refuses).
    const h = typeof name === 'string' && Object.prototype.hasOwnProperty.call(handlers, name) ? handlers[name] : null;
    if (!h) return { text: `Unknown tool "${echo(name, 60)}". Available: ${Object.keys(handlers).join(', ')}`, error: true };
    if (args && typeof args.__parseError === 'string') {
      return { text: `Your arguments were not valid JSON, so nothing was done (you sent: ${echo(args.__parseError, ECHO_MAX)}). Send them again as ONE JSON object.`, error: true };
    }
    try { return await h(args || {}, { signal }); } catch (e) { return { text: `Error: ${e && e.message ? e.message : e}`, error: true }; }
  };
}

module.exports = { TOOL_SCHEMAS, buildToolSchemas, createToolExecutor, resolvePath, runShell };
