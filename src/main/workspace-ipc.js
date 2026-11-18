'use strict';
const fs = require('node:fs');
const { speakable } = require('../workspace/voice-model');
const { ID_RE, KINDS } = require('./history');
const { TTS_ENGINES, STT_ENGINES, CODE_AUTONOMY } = require('./settings');

/**
 * Workspace IPC - the main-side half of the workspace window (Chat, History, Code, Voice).
 *
 * Same rules as settings-ipc.js: every call is a named request/response; every handler validates its own input again (the preload is
 * only the first gate); every request is checked for WHO is asking before anything runs (`isTrusted` is required, so it cannot be
 * forgotten); and no secret ever travels to the page (it is told which providers exist, never their keys or even their addresses).
 *
 * `ctx` holds the app's parts, so this file has no Electron and no globals and the tests run it with fakes:
 *   settings, history, chat, code, speaker, transcriber, broker, describeProviders(), dialog { showOpenDialog, showSaveDialog }, window
 */

const ok = (data = {}) => ({ ok: true, ...data });
const fail = (error) => ({ ok: false, error: String(error) });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max, min = 0) => (typeof v === 'string' && v.length <= max && v.length >= min ? v : null);

const PATCH_FIELDS = {
  history: ['enabled'],
  speech: ['speakReplies', 'ttsEngine', 'ttsVoice', 'ttsRate', 'piperModel', 'sttEngine', 'whisperBinary', 'whisperModel', 'sttRoute', 'sttModel', 'language'],
  code: ['autonomy', 'maxSteps'],
};

function attachWorkspaceIpc(ipcMain, ctx, { isTrusted } = {}) {
  if (typeof isTrusted !== 'function') throw new TypeError('attachWorkspaceIpc needs isTrusted(event): it will not serve history, files and the microphone to unchecked callers.');
  const trusted = (event) => { try { return isTrusted(event) === true; } catch { return false; } };
  const { settings, history, chat, code, speaker, transcriber, broker } = ctx;
  let listening = null;                                       // AbortController of the recognition in progress

  const stateOf = () => {
    const s = settings.get();
    return {
      settings: { history: s.history, speech: s.speech, code: s.code },
      speech: { tts: speaker.detect(), stt: transcriber.detect() },
      providers: (ctx.describeProviders() || []).map((p) => ({ id: p.id, label: p.label })),
      project: code.info, historyIssue: history.loadIssue || null,
    };
  };

  const handlers = {
    'ws:state': () => ok(stateOf()),

    'ws:update-settings': (p) => {
      if (!isObj(p)) return fail('That request was not valid.');
      const patch = {};
      for (const section of Object.keys(PATCH_FIELDS)) {
        if (!isObj(p[section])) continue;
        for (const f of PATCH_FIELDS[section]) if (Object.prototype.hasOwnProperty.call(p[section], f)) (patch[section] || (patch[section] = {}))[f] = p[section][f];
      }
      if (!Object.keys(patch).length) return fail('Nothing to change.');
      settings.update(patch);
      return ok(stateOf());
    },

    // ---- chat
    'ws:chat-send': async (p) => {
      if (!isObj(p)) return fail('That request was not valid.');
      if (p.sessionId != null && !(typeof p.sessionId === 'string' && ID_RE.test(p.sessionId))) return fail('That request was not valid.');
      return chat.send({ sessionId: p.sessionId || null, text: p.text, spoken: p.spoken === true });
    },
    'ws:chat-stop': () => ok({ stopped: chat.stop() }),

    // ---- history
    'ws:history-list': (p) => {
      const q = isObj(p) ? p : {};
      return ok({ sessions: history.list({ query: typeof q.query === 'string' ? q.query.slice(0, 200) : '', kind: KINDS.includes(q.kind) ? q.kind : '' }) });
    },
    'ws:history-get': (id) => { const g = typeof id === 'string' ? history.get(id) : null; return g ? ok(g) : fail('That conversation was not found.'); },
    'ws:history-rename': (p) => (isObj(p) && history.rename(p.id, p.title) ? ok() : fail('Could not rename it.')),
    'ws:history-delete': (id) => { if (typeof id === 'string' && history.remove(id)) { chat.forget(id); return ok(); } return fail('That conversation was not found.'); },
    'ws:history-clear': () => { const n = history.clear(); chat.convos.clear(); return ok({ removed: n }); },
    'ws:history-export': async (id) => {
      const md = typeof id === 'string' ? history.exportMarkdown(id) : null;
      if (md === null) return fail('That conversation was not found.');
      const meta = history.get(id).meta;
      const pick = await ctx.dialog.showSaveDialog(ctx.window.win, { title: 'Save conversation', defaultPath: `${meta.title.replace(/[^\w .-]+/g, '_').slice(0, 60) || 'conversation'}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] });
      if (!pick || pick.canceled || !pick.filePath) return ok({ saved: null });
      try { fs.writeFileSync(pick.filePath, md, { mode: 0o600 }); } catch (e) { return fail(`Could not save: ${e.message}`); }
      return ok({ saved: pick.filePath });
    },

    // ---- code
    'ws:code-pick': async () => {
      const last = settings.get().code.lastProject;
      const pick = await ctx.dialog.showOpenDialog(ctx.window.win, { title: 'Choose the project folder', properties: ['openDirectory'], ...(last ? { defaultPath: last } : {}) });
      if (!pick || pick.canceled || !pick.filePaths || !pick.filePaths[0]) return ok({ opened: false });
      return handlers['ws:code-open'](pick.filePaths[0]);
    },
    'ws:code-open': (root) => {
      const r = typeof root === 'string' ? code.open(root) : fail('Choose a folder.');
      if (r.ok) settings.update({ code: { lastProject: r.project.root } });
      return r;
    },
    'ws:code-submit': (text) => (typeof text === 'string' ? code.submit(text) : fail('Write what you want done.')).then((r) => (r.ok === true ? { ok: true, summary: r.summary } : { ok: false, error: r.summary })),
    'ws:code-stop': () => { code.stop(); return ok(); },
    'ws:code-tree': () => ok(code.tree()),
    'ws:code-read': (rel) => (typeof rel === 'string' ? code.readFile(rel) : fail('Choose a file.')),
    'ws:code-write': (p) => (isObj(p) && typeof p.path === 'string' && typeof p.content === 'string' && typeof p.hash === 'string' ? code.writeFile(p.path, p.content, p.hash) : fail('That file save request was not valid.')),
    'ws:code-diff': (rel) => { const d = typeof rel === 'string' ? code.diff(rel) : null; return d === null ? fail('That file was not changed by ALLES.') : ok({ diff: d }); },
    'ws:code-revert': (rel) => (typeof rel === 'string' ? code.revert(rel) : fail('That request was not valid.')),
    'ws:code-revert-all': () => code.revertAll(),

    // ---- questions (the same ApprovalBroker the pill uses)
    'ws:approval-answer': (p) => (isObj(p) && broker.respond(p.id, p.allow) ? ok() : fail('That question is no longer open.')),

    // ---- speech
    'ws:speak': async (text) => {
      const words = speakable(typeof text === 'string' ? text : '');
      if (!words) return ok({ spoke: false, reason: 'empty' });
      const r = await speaker.speak(words);
      if (r.ok) return ok({ spoke: true, engine: r.engine });
      // 'use-browser' tells the page to use its own speechSynthesis, with the same cleaned words
      return ok({ spoke: false, reason: r.reason, words: r.reason === 'use-browser' ? words : undefined, error: r.error });
    },
    'ws:speak-stop': () => { speaker.stop(); return ok(); },
    'ws:transcribe': async (p) => {
      if (!isObj(p) || !p.audio) return fail('No recording was received.');
      if (listening) return fail('Already listening to a recording.');
      const ctl = new AbortController(); listening = ctl;
      try {
        const bytes = p.audio instanceof ArrayBuffer ? new Uint8Array(p.audio) : p.audio;
        const r = await transcriber.transcribe(bytes, { signal: ctl.signal });
        return r.ok ? ok({ text: r.text, engine: r.engine }) : fail(r.error);
      } finally { listening = null; }
    },
    'ws:transcribe-stop': () => { if (listening) listening.abort(); return ok(); },
  };

  for (const name of Object.keys(handlers)) {
    ipcMain.handle(name, async (event, payload) => {
      if (!trusted(event)) return fail('Not allowed.');
      try { return await handlers[name](payload); } catch (e) { return fail((e && e.message) || e); }
    });
  }
  return { names: Object.keys(handlers), detach: () => { for (const name of Object.keys(handlers)) ipcMain.removeHandler(name); } };
}

module.exports = { attachWorkspaceIpc, TTS_ENGINES, STT_ENGINES, CODE_AUTONOMY };
