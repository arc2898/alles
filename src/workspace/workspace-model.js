'use strict';

/**
 * Workspace view-model. PURE: no DOM, no Electron. The page script (workspace.js) turns these answers into elements; the tests
 * run this file directly, so the decisions (how a coding step is worded, what a diff line is, which state the voice conversation
 * moves to) are proven without opening a window. Works as a CommonJS module and as a plain <script> (same pattern as
 * settings-model.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WorkspaceModel = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  const TABS = [
    { id: 'chat', label: 'Chat' },
    { id: 'code', label: 'Code' },
    { id: 'history', label: 'History' },
    { id: 'voice', label: 'Voice & privacy' },
  ];
  const KIND_LABEL = { chat: 'Chat', task: 'Pill task', code: 'Code' };
  const kindLabel = (k) => KIND_LABEL[k] || 'Chat';

  const oneLine = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length <= n ? t : `${t.slice(0, n - 1)}…`; };

  // ---------------------------------------------------------------- history list

  const DAY = 86_400_000;
  const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

  /** "Today" / "Yesterday" / "Earlier this week" / "Older" for a time, as the person's calendar sees it. */
  function dayGroup(at, now = Date.now()) {
    const today = startOfDay(now);
    if (at >= today) return 'Today';
    if (at >= today - DAY) return 'Yesterday';
    if (at >= today - 6 * DAY) return 'Earlier this week';
    return 'Older';
  }

  /** Sessions (newest first) as [{label, items}] in the order Today, Yesterday, Earlier this week, Older. Empty groups are left out. */
  function groupSessions(sessions, now = Date.now()) {
    const order = ['Today', 'Yesterday', 'Earlier this week', 'Older'];
    const by = new Map(order.map((o) => [o, []]));
    for (const s of sessions) by.get(dayGroup(s.updatedAt, now)).push(s);
    return order.filter((o) => by.get(o).length).map((o) => ({ label: o, items: by.get(o) }));
  }

  function timeLabel(at, now = Date.now()) {
    if (!at) return '';
    const d = new Date(at); const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (at >= startOfDay(now)) return hm;
    return `${d.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]}, ${hm}`;
  }

  // ---------------------------------------------------------------- transcripts

  function parseArgs(args) {
    if (args && typeof args === 'object') return args;
    try { const v = JSON.parse(String(args)); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
  }

  /** One short line for a tool step: "Edited src/a.js", "Ran: npm test". */
  function toolSummary(name, args) {
    const a = parseArgs(args);
    const where = typeof a.path === 'string' ? a.path : '';
    switch (name) {
      case 'read_file': return `Read ${where || 'a file'}`;
      case 'list_files': return `Listed ${where && where !== '.' ? where : 'the project'}`;
      case 'search': return `Searched for "${oneLine(a.text, 40)}"`;
      case 'write_file': return `Wrote ${where || 'a file'}`;
      case 'edit_file': return `Edited ${where || 'a file'}`;
      case 'run_command': return `Ran: ${oneLine(a.command, 80)}`;
      case 'run_shell': return `Ran: ${oneLine(a.command, 80)}`;
      default: return String(name || 'step');
    }
  }

  /** A saved event as a row: who spoke, a heading (for a step), the text. */
  function eventRow(ev) {
    const text = String(ev && ev.text != null ? ev.text : '');
    if (!ev || ev.kind === 'user') return { role: 'you', who: 'You', text };
    if (ev.kind === 'assistant') return { role: 'alles', who: 'ALLES', text, error: !!ev.error };
    if (ev.kind === 'tool') return { role: 'tool', who: '', heading: toolSummary(ev.name, ev.args), text, error: !!ev.error };
    return { role: 'note', who: '', text, error: !!ev.error };
  }

  // ---------------------------------------------------------------- code page

  function diffLineClass(line) {
    const s = String(line);
    if (s.startsWith('@@')) return 'hunk';
    if (s.startsWith('+')) return 'add';
    if (s.startsWith('-')) return 'del';
    return 'ctx';
  }

  const AUTONOMY = {
    ask: { label: 'Ask before every change and command', note: 'ALLES shows you each file change and each command and waits for your yes. Safest; slowest.' },
    edits: { label: 'Change files by itself, ask before commands', note: 'File changes inside the project happen at once (you can undo them). Every command still asks.' },
    full: { label: 'Work by itself', note: 'File changes happen automatically. Shell commands still ask while Safety → Ask before running shell commands is enabled (the default). Known dangerous commands always ask. Commands can change things outside the undo list.' },
  };
  const autonomyNote = (level) => (AUTONOMY[level] || AUTONOMY.ask).note;

  function changeLabel(c) {
    const tag = c.status === 'added' ? 'new' : c.status === 'deleted' ? 'deleted' : 'changed';
    return `${c.path}  (${tag}${c.status === 'added' ? `, +${c.added}` : `, +${c.added} -${c.removed}`})`;
  }

  // ---------------------------------------------------------------- questions (approvals)

  /** What the question card shows. `q` is what the approval broker made (approvals.js describeAction + id). */
  function approvalView(q) {
    const kind = q && q.kind;
    return {
      id: q && q.id,
      title: (q && q.title) || 'Allow this?',
      target: q && q.target ? String(q.target) : '',
      targetLabel: kind === 'command' ? 'In folder' : kind === 'file' ? 'File' : kind === 'read' ? 'File' : '',
      body: q && q.body ? String(q.body) : '',
      bodyIsDiff: kind === 'file' && /^@@ /.test(String(q.body || '')),
      risks: Array.isArray(q && q.risks) ? q.risks.map(String) : [],
      truncated: !!(q && q.truncated),
      allowLabel: kind === 'command' ? 'Run it' : kind === 'file' ? 'Write it' : 'Allow',
      denyLabel: 'Don\'t',
    };
  }

  // ---------------------------------------------------------------- voice

  /**
   * The voice conversation as a small state machine. States: idle, listening, transcribing, thinking, speaking.
   * Events: mic (the person pressed the microphone), heard (the recording ended), text (recognised words came back), none (nothing was
   * recognised or an error), reply (ALLES answered), spoken (it finished talking or was told not to), stop.
   * handsFree: after ALLES has spoken, listen again by itself.
   */
  function nextVoiceState(state, event, { handsFree = false, speakReplies = false } = {}) {
    switch (state) {
      case 'idle': return event === 'mic' ? 'listening' : 'idle';
      case 'listening': return event === 'heard' ? 'transcribing' : event === 'mic' || event === 'stop' || event === 'none' ? 'idle' : 'listening';
      case 'transcribing': return event === 'text' ? 'thinking' : event === 'none' || event === 'stop' ? 'idle' : 'transcribing';
      case 'thinking':
        if (event === 'reply') return speakReplies ? 'speaking' : (handsFree ? 'listening' : 'idle');
        return event === 'none' || event === 'stop' ? 'idle' : 'thinking';
      case 'speaking': return event === 'spoken' ? (handsFree ? 'listening' : 'idle') : event === 'stop' || event === 'mic' ? 'idle' : 'speaking';
      default: return 'idle';
    }
  }

  const VOICE_STATUS = {
    idle: '', listening: 'Listening… speak now', transcribing: 'Understanding what you said…', thinking: 'ALLES is thinking…', speaking: 'ALLES is speaking… (press the microphone to interrupt)',
  };

  /** Plain sentences about what can talk and listen right now, from ws:state's `speech`. */
  function speechSummary(speech) {
    const tts = speech && speech.tts; const stt = speech && speech.stt;
    const out = { talk: '', listen: '', listenOk: false, talkOk: false, privacy: '' };
    if (tts) {
      if (tts.chosen === 'off') out.talk = 'Reading aloud is switched off.';
      else if (tts.chosen === 'browser') out.talk = 'ALLES will use the voices built into this window. If you hear nothing, install espeak-ng or speech-dispatcher.';
      else if (tts.chosen) { out.talk = `ALLES speaks with ${tts.chosen}.`; out.talkOk = true; }
      else out.talk = 'The speech engine you chose is not available on this computer.';
    }
    if (stt) {
      if (stt.chosen === 'off') out.listen = 'Listening is switched off.';
      else if (stt.chosen === 'whisper-cli') { out.listen = 'Listening uses whisper.cpp on this computer.'; out.listenOk = true; out.privacy = 'Your voice stays on this computer.'; }
      else if (stt.chosen === 'http') { out.listen = 'Listening sends your recording to the transcription provider you chose.'; out.listenOk = true; out.privacy = 'Your voice is sent over the internet to that provider only while you speak to ALLES.'; }
      else out.listen = `Listening is not set up yet. Private option: install whisper.cpp and choose a model file (${stt.whisper ? stt.whisper.problem : 'not found'}). Or choose a provider that offers transcription (${stt.http ? stt.http.problem : 'none chosen'}).`;
    }
    return out;
  }

  return { TABS, kindLabel, dayGroup, groupSessions, timeLabel, toolSummary, eventRow, diffLineClass, AUTONOMY, autonomyNote, changeLabel, approvalView, nextVoiceState, VOICE_STATUS, speechSummary, oneLine };
}));
