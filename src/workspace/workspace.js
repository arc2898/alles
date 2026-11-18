'use strict';

/**
 * The workspace page: Chat, Code, History, Voice & privacy. It runs sandboxed, with no Node, and talks to the app only through
 * window.alles (preload.cjs): invoke(name, payload) and onEvent(cb). Decisions live in workspace-model.js and voice-model.js
 * (tested without a window); this file turns them into elements and wires the buttons.
 *
 * RULES THIS FILE KEEPS (test/workspace-bridge.test.js scans for them):
 *  - text from the model, from files, from commands or from History is only ever put on the page as TEXT (textContent), never as
 *    markup: no innerHTML, no insertAdjacentHTML, no document.write, no eval
 *  - the microphone is opened only after the person presses Talk or Test, and is released (tracks stopped, audio context closed)
 *    as soon as the recording ends, whatever ended it
 *  - nothing here reaches the network; everything goes through window.alles
 */
(function () {
  const M = window.WorkspaceModel; const V = window.VoiceModel; const api = window.alles;

  const $ = (id) => document.getElementById(id);
  function el(tag, { cls, text, attrs } = {}, ...kids) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    if (attrs) for (const k of Object.keys(attrs)) n.setAttribute(k, attrs[k]);
    for (const k of kids) if (k) n.appendChild(k);
    return n;
  }
  const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); };
  const stick = (log) => { log.scrollTop = log.scrollHeight; };

  const S = {
    tab: 'chat', settings: null, speech: null, providers: [],
    chat: { sessionId: null, busy: false },
    voice: { state: 'idle', target: 'chat' },
    code: { project: null, running: false, selected: null, sawFinished: false, filePath: null, fileContent: '', fileHash: '', dirty: false },
    hist: { id: null, meta: null },
    approvals: [],
  };

  // ------------------------------------------------------------------ small helpers

  let toastTimer = null;
  function toast(message, isError) {
    const t = $('toast');
    t.textContent = message; t.className = isError ? 'toast error' : 'toast'; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 7000 : 3500);
  }

  async function call(name, payload) {
    const r = await api.invoke(name, payload);
    return r && typeof r === 'object' ? r : { ok: false, error: 'No answer.' };
  }
  async function callOrToast(name, payload) {
    const r = await call(name, payload);
    if (!r.ok && r.error) toast(r.error, true);
    return r;
  }

  /** A question inside the page instead of window.confirm(). Resolves true only for the destructive button. */
  function confirmBox(text, yesLabel) {
    return new Promise((resolve) => {
      const box = $('confirm'); $('cf-text').textContent = text; $('cf-yes').textContent = yesLabel || 'Delete'; box.hidden = false;
      const done = (v) => { box.hidden = true; $('cf-yes').onclick = null; $('cf-no').onclick = null; resolve(v); };
      $('cf-yes').onclick = () => done(true); $('cf-no').onclick = () => done(false);
      $('cf-no').focus();                                        // the safe button has the focus
    });
  }

  // ------------------------------------------------------------------ tabs

  function buildTabs() {
    const bar = $('tabs');
    for (const t of M.TABS) {
      const b = el('button', { text: t.label, attrs: { role: 'tab', id: `tab-${t.id}`, 'aria-controls': `page-${t.id}`, type: 'button' } });
      b.addEventListener('click', () => showTab(t.id));
      b.addEventListener('keydown', (e) => {
        const i = M.TABS.findIndex((x) => x.id === S.tab);
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); showTab(M.TABS[(i + 1) % M.TABS.length].id, true); }
        else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); showTab(M.TABS[(i + M.TABS.length - 1) % M.TABS.length].id, true); }
      });
      bar.appendChild(b);
    }
  }

  function showTab(id, focus) {
    S.tab = id;
    for (const t of M.TABS) {
      const selected = t.id === id;
      const b = $(`tab-${t.id}`); b.setAttribute('aria-selected', String(selected)); b.tabIndex = selected ? 0 : -1;
      $(`page-${t.id}`).hidden = !selected;
      if (selected && focus) b.focus();
    }
    if (id === 'history') loadHistory();
    if (id === 'voice') renderVoicePage();
  }

  // ------------------------------------------------------------------ chat

  function addMessage(log, row) {
    if (row.role === 'tool') {
      const s = el('div', { cls: row.error ? 'step error' : 'step', text: row.heading || '' });
      if (row.text) s.appendChild(el('span', { cls: 'out', text: row.text.length > 1200 ? `${row.text.slice(0, 1200)}…` : row.text }));
      log.appendChild(s);
    } else if (row.role === 'note') {
      log.appendChild(el('div', { cls: 'note-row', text: row.text }));
    } else {
      log.appendChild(el('div', { cls: `msg ${row.role}${row.error ? ' error' : ''}` }, el('span', { cls: 'who', text: row.who }), document.createTextNode(row.text)));
    }
    stick(log);
  }

  function setChatBusy(busy) {
    S.chat.busy = busy;
    $('chat-send').disabled = busy; $('chat-stop').hidden = !busy;
  }

  async function sendChat(text, spoken) {
    const said = String(text || '').trim();
    if (!said || S.chat.busy) return;
    $('chat-empty').hidden = true;
    addMessage($('chat-log'), { role: 'you', who: 'You', text: said });
    $('chat-input').value = '';
    setChatBusy(true);
    const r = await call('ws:chat-send', { text: said, ...(S.chat.sessionId ? { sessionId: S.chat.sessionId } : {}), spoken: !!spoken });
    setChatBusy(false);
    if (r.sessionId) S.chat.sessionId = r.sessionId;
    if (!r.ok) {
      addMessage($('chat-log'), { role: 'alles', who: 'ALLES', text: r.error || 'No answer.', error: true });
      setVoice('none');
      return;
    }
    addMessage($('chat-log'), { role: 'alles', who: 'ALLES', text: r.reply });
    await afterReply(r.reply);
  }

  async function afterReply(reply) {
    const speak = !!(S.settings && S.settings.speech.speakReplies);
    setVoice('reply');
    if (speak) { await speakText(reply); setVoice('spoken'); }
  }

  function newChat() {
    S.chat.sessionId = null; clear($('chat-log')); $('chat-empty').hidden = false; $('chat-input').focus();
  }

  // ------------------------------------------------------------------ speaking (ALLES talks)

  async function speakText(text) {
    const r = await callOrToast('ws:speak', text.length > 20000 ? text.slice(0, 20000) : text);
    if (!r.ok || r.spoke) return;
    if (r.reason === 'use-browser' && r.words) await speakInBrowser(r.words);
    else if (r.reason === 'no-engine' || r.reason === 'failed') toast(r.error || 'ALLES could not speak. Check Voice & privacy.', true);
  }

  function speakInBrowser(words) {
    return new Promise((resolve) => {
      const synth = window.speechSynthesis;
      if (!synth || typeof window.SpeechSynthesisUtterance !== 'function') { toast('This computer has no built-in voice for ALLES to use. Install espeak-ng (see Voice & privacy).', true); resolve(); return; }
      synth.cancel();
      const parts = V.sentences(words, 200);
      const rate = S.settings ? S.settings.speech.ttsRate : 1;
      let i = 0;
      const next = () => {
        if (i >= parts.length) { resolve(); return; }
        const u = new window.SpeechSynthesisUtterance(parts[i++]); u.rate = rate;
        u.onend = next; u.onerror = () => resolve();
        synth.speak(u);
      };
      next();
    });
  }

  async function stopSpeaking() {
    if (window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch { /* none */ } }
    await call('ws:speak-stop');
  }

  // ------------------------------------------------------------------ listening (you talk)

  function setVoice(event) {
    if (!event) return;
    const handsFree = $('chat-handsfree').checked; const speakReplies = !!(S.settings && S.settings.speech.speakReplies);
    const before = S.voice.state;
    S.voice.state = M.nextVoiceState(before, event, { handsFree, speakReplies });
    renderVoice();
    if (S.voice.state === 'listening' && before !== 'listening') startListening();
  }

  function renderVoice() {
    const st = S.voice.state;
    const status = M.VOICE_STATUS[st] || '';
    const listening = st === 'listening';
    const chatTarget = S.voice.target !== 'code';
    $('voice-status').textContent = chatTarget ? status : '';
    $('code-voice-status').textContent = chatTarget ? '' : status;
    const chatMic = $('chat-mic'); const codeMic = $('code-mic');
    chatMic.setAttribute('aria-pressed', String(listening && chatTarget));
    codeMic.setAttribute('aria-pressed', String(listening && !chatTarget));
    chatMic.textContent = listening && chatTarget ? 'Stop listening' : st === 'speaking' ? 'Interrupt' : 'Talk';
    codeMic.textContent = listening && !chatTarget ? 'Stop listening' : 'Dictate';
    $('mic-meter').hidden = !listening || !chatTarget;
    $('code-mic-meter').hidden = !listening || chatTarget;
  }

  const rec = { stream: null, ctx: null, node: null, chunks: [], rate: 16000, vad: null, onLevel: null, done: null };

  function releaseMic() {
    try { if (rec.node) { rec.node.onaudioprocess = null; rec.node.disconnect(); } } catch { /* already gone */ }
    try { if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop()); } catch { /* already gone */ }
    try { if (rec.ctx && rec.ctx.state !== 'closed') rec.ctx.close(); } catch { /* already gone */ }
    rec.stream = null; rec.ctx = null; rec.node = null;
  }

  /**
   * Record until `finish` is called or the voice detector says the person stopped. Resolves {wav} (a 16 kHz WAV) or {error}.
   * `auto` = stop by itself when the person stops speaking (hands-free and the push-to-talk button both use it); `maxMs` = stop after that long.
   */
  async function record({ auto = true, onLevel = null, maxMs = 0 } = {}) {
    if (rec.stream) return { error: 'The microphone is already in use.' };
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { return { error: e && e.name === 'NotAllowedError' ? 'The microphone is not allowed. Check the system settings for this app.' : 'No microphone was found.' }; }
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const src = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    rec.stream = stream; rec.ctx = ctx; rec.node = node; rec.chunks = []; rec.rate = ctx.sampleRate; rec.vad = V.createVad(); rec.onLevel = onLevel;
    return new Promise((resolve) => {
      let ended = false;
      const end = (result) => {
        if (ended) return; ended = true;
        const chunks = rec.chunks; const rate = rec.rate;
        releaseMic(); rec.done = null; rec.chunks = [];
        if (result.error) { resolve(result); return; }
        let total = 0; for (const c of chunks) total += c.length;
        const all = new Float32Array(total); let at = 0; for (const c of chunks) { all.set(c, at); at += c.length; }
        resolve({ wav: V.encodeWav(V.toInt16(V.downsample(all, rate, V.TARGET_RATE)), V.TARGET_RATE) });
      };
      rec.done = () => end({});
      if (maxMs > 0) setTimeout(() => end({}), maxMs);                       // a fixed-length recording (the microphone test)
      node.onaudioprocess = (e) => {
        const data = new Float32Array(e.inputBuffer.getChannelData(0));       // a copy: the browser reuses its buffer
        rec.chunks.push(data);
        const level = V.rms(data);
        if (rec.onLevel) rec.onLevel(level);
        const ev = rec.vad.push(level, (data.length / rec.rate) * 1000);
        if (auto && ev === 'end') end({});
        else if (auto && ev === 'nospeech') end({ error: 'I did not hear anything.' });
      };
      src.connect(node); node.connect(ctx.destination);                       // the node is silent; it must be connected to run
    });
  }

  function meter(level) {
    const width = `${Math.min(100, Math.round(level * 400))}%`;
    $('mic-level').style.width = width;
    $('code-mic-level').style.width = width;
  }

  async function startListening() {
    const target = S.voice.target;
    await stopSpeaking();                                                     // ALLES is never speaking while the microphone is open
    const out = await record({ auto: true, onLevel: meter });
    meter(0);
    if (S.voice.state !== 'listening') return;                                // stopped by the person meanwhile
    if (out.error) { toast(out.error, out.error !== 'I did not hear anything.'); setVoice('none'); return; }
    setVoice('heard');
    const r = await call('ws:transcribe', { audio: out.wav });
    if (!r.ok) { toast(r.error || 'Could not understand the recording.', true); setVoice('none'); return; }
    setVoice('text');
    if (target === 'code') {
      $('code-input').value = r.text;
      $('code-input').focus();
      setVoice('none');
      toast('Dictation added to the coding task. Review it, then press Run task.');
      return;
    }
    await sendChat(r.text, true);
  }

  async function onMic(target = 'chat') {
    if (S.voice.state === 'speaking') {
      S.voice.target = target === 'code' ? 'code' : 'chat';
      await stopSpeaking(); setVoice('mic'); return;
    }
    if (S.voice.state === 'listening') { if (rec.done) rec.done(); return; }   // the recording ends and is understood
    if (S.voice.state !== 'idle') return;
    S.voice.target = target === 'code' ? 'code' : 'chat';
    if (!S.speech || !S.speech.stt || !S.speech.stt.chosen || S.speech.stt.chosen === 'off') { toast('Listening is not set up yet. Open Voice & privacy.', true); showTab('voice'); return; }
    if (S.speech.stt.sendsAudioAway && !S.micOk) {
      const yes = await confirmBox('Your recording will be sent over the internet to the transcription provider you chose, each time you speak. Continue?', 'Continue');
      if (!yes) return;
      S.micOk = true;
    }
    setVoice('mic');
  }

  async function stopEverything() {
    await call('ws:chat-stop'); await call('ws:transcribe-stop'); await stopSpeaking();
    if (rec.done) rec.done();
    S.voice.state = 'idle'; S.voice.target = 'chat'; renderVoice();
  }

  // ------------------------------------------------------------------ code

  const AUTONOMY_ORDER = ['ask', 'edits', 'full'];

  function renderCodeHeader() {
    const p = S.code.project;
    $('code-project').textContent = p ? `${p.name}  ·  ${p.root}` : 'No project chosen';
    $('code-project').title = p ? p.root : '';
    $('code-empty').hidden = !!p && $('code-log').childNodes.length > 0;
    $('code-run').disabled = !p || S.code.running; $('code-stop').hidden = !S.code.running;
    const sel = $('code-autonomy'); const level = S.settings ? S.settings.code.autonomy : 'ask';
    if (!sel.options.length) for (const k of AUTONOMY_ORDER) { const o = el('option', { text: M.AUTONOMY[k].label }); o.value = k; sel.appendChild(o); }
    sel.value = level; $('code-autonomy-note').textContent = M.autonomyNote(level);
  }

  function renderTree(tree) {
    const ul = $('code-tree'); clear(ul);
    for (const entry of (tree && tree.entries) || []) {
      if (entry.endsWith('/')) { ul.appendChild(el('li', { text: entry })); continue; }
      const b = el('button', { text: entry, attrs: { type: 'button', title: `Open ${entry}` } });
      b.addEventListener('click', () => openCodeFile(entry));
      const li = el('li', {}, b);
      if (S.code.filePath === entry) li.className = 'sel';
      ul.appendChild(li);
    }
    if (tree && tree.truncated) ul.appendChild(el('li', { text: '…' }));
  }

  function renderEditorState() {
    $('code-file-label').textContent = S.code.filePath || 'No file open';
    $('code-file-state').textContent = S.code.filePath ? (S.code.dirty ? 'Unsaved changes' : 'Saved') : 'Choose a file from the project tree';
    $('code-file-state').title = S.code.dirty ? 'Changes not saved to disk' : '';
    $('code-editor-dot').className = S.code.dirty ? 'editor-dot dirty' : 'editor-dot';
    $('code-editor').disabled = !S.code.filePath || S.code.running;
    $('code-save').disabled = !S.code.filePath || !S.code.dirty || S.code.running;
    $('code-reload').disabled = !S.code.filePath || S.code.running;
    $('editor-status').textContent = S.code.filePath ? (S.code.dirty ? 'Unsaved changes — save or reload before leaving this file.' : 'Manual edits are included in Changes and can be undone.') : 'Files are saved only inside the selected project.';
  }

  async function openCodeFile(relativePath) {
    if (S.code.dirty && !(await confirmBox(`Discard unsaved changes to ${S.code.filePath}?`, 'Discard'))) return;
    const r = await callOrToast('ws:code-read', relativePath);
    if (!r.ok) return;
    S.code.filePath = r.path; S.code.fileContent = r.content; S.code.fileHash = r.hash; S.code.dirty = false;
    $('code-editor').value = r.content;
    renderEditorState(); renderTree(await call('ws:code-tree'));
  }

  async function saveCodeFile() {
    if (!S.code.filePath || !S.code.dirty || S.code.running) return;
    const r = await callOrToast('ws:code-write', { path: S.code.filePath, content: $('code-editor').value, hash: S.code.fileHash });
    if (!r.ok) return;
    S.code.fileContent = $('code-editor').value; S.code.fileHash = r.hash; S.code.dirty = false;
    renderEditorState(); renderChanges(r.changes || []);
    toast(`Saved ${S.code.filePath}`);
  }

  async function reloadCodeFile() {
    if (!S.code.filePath) return;
    if (S.code.dirty && !(await confirmBox(`Discard unsaved changes to ${S.code.filePath} and reload from disk?`, 'Discard'))) return;
    const current = S.code.filePath;
    S.code.dirty = false;
    await openCodeFile(current);
  }

  function renderChanges(changes) {
    const ul = $('code-changes'); clear(ul);
    for (const c of changes || []) {
      const b = el('button', { text: M.changeLabel(c), attrs: { type: 'button' } });
      b.addEventListener('click', () => showDiff(c.path));
      const li = el('li', {}, b); if (S.code.selected === c.path) li.className = 'sel';
      ul.appendChild(li);
    }
    $('code-changes-empty').hidden = !!(changes && changes.length);
    $('code-undo-all').hidden = !(changes && changes.length);
    if (S.code.selected && !(changes || []).some((c) => c.path === S.code.selected)) { S.code.selected = null; $('code-diff').hidden = true; }
  }

  async function showDiff(rel) {
    const r = await callOrToast('ws:code-diff', rel);
    if (!r.ok) return;
    S.code.selected = rel;
    const pre = $('code-diff'); clear(pre); pre.hidden = false;
    for (const line of String(r.diff).split('\n')) pre.appendChild(el('span', { cls: M.diffLineClass(line), text: line || ' ' }));
    pre.appendChild(el('button', { cls: 'btn', text: `Undo changes to ${rel}`, attrs: { type: 'button' } }));
    pre.lastChild.addEventListener('click', async () => { const u = await callOrToast('ws:code-revert', rel); if (u.ok) toast('Put back as it was.'); });
    const list = await call('ws:code-tree'); if (list.ok) renderTree(list);
  }

  function addCodeEvent(ev) {
    const log = $('code-log'); $('code-empty').hidden = true;
    if (ev.type === 'tool') addMessage(log, { role: 'tool', heading: M.toolSummary(ev.name, ev.args), text: ev.text, error: ev.error });
    else if (ev.type === 'message') addMessage(log, { role: 'alles', who: 'ALLES', text: ev.text });
    else if (ev.type === 'finished') { S.code.sawFinished = true; addMessage(log, { role: 'alles', who: 'ALLES', text: ev.summary || (ev.ok ? 'Done.' : 'It stopped.'), error: !ev.ok }); }
    else if (ev.type === 'status' && ev.detail && ev.state === 'error') addMessage(log, { role: 'note', text: ev.detail });
  }

  async function openProject(result) {
    if (!result.ok) { toast(result.error, true); return; }
    if (result.opened === false) return;
    S.code.project = result.project; S.code.selected = null; S.code.filePath = null; S.code.fileContent = ''; S.code.fileHash = ''; S.code.dirty = false;
    $('code-editor').value = ''; clear($('code-log')); $('code-diff').hidden = true;
    renderCodeHeader(); renderEditorState(); renderTree(result.tree); renderChanges([]);
  }

  async function runCode() {
    const text = $('code-input').value.trim();
    if (!text || S.code.running || !S.code.project) return;
    S.code.running = true; S.code.sawFinished = false; renderCodeHeader(); renderEditorState();
    $('code-empty').hidden = true;
    addMessage($('code-log'), { role: 'you', who: 'You', text });
    $('code-input').value = '';
    const r = await call('ws:code-submit', text);
    S.code.running = false; renderCodeHeader(); renderEditorState();
    // The result normally arrived as a 'finished' event while it ran; show it from the reply only if that event did not come.
    if (!S.code.sawFinished) addMessage($('code-log'), { role: 'alles', who: 'ALLES', text: (r.ok ? r.summary : r.error) || (r.ok ? 'Done.' : 'It stopped.'), error: !r.ok });
    const tree = await call('ws:code-tree'); if (tree.ok) renderTree(tree);
    if (r.ok && S.settings && S.settings.speech.speakReplies) speakText(r.summary);
  }

  // ------------------------------------------------------------------ questions from ALLES (approvals)

  function renderApproval() {
    const q = S.approvals[0]; const box = $('approval');
    if (!q) { box.hidden = true; return; }
    const v = M.approvalView(q);
    $('ap-title').textContent = v.title;
    $('ap-target').textContent = v.target ? `${v.targetLabel}: ${v.target}` : '';
    const body = $('ap-body'); clear(body);
    if (v.bodyIsDiff) for (const line of v.body.split('\n')) body.appendChild(el('span', { cls: M.diffLineClass(line), text: `${line}\n` }));
    else body.textContent = v.body;
    body.hidden = !v.body;
    const risks = $('ap-risks'); clear(risks); for (const r of v.risks) risks.appendChild(el('li', { text: r }));
    $('ap-allow').textContent = v.allowLabel; $('ap-deny').textContent = v.denyLabel;
    box.hidden = false;
    $('ap-deny').focus();                                                      // the safe button has the focus
  }

  async function answer(allow) {
    const q = S.approvals[0]; if (!q) return;
    S.approvals.shift(); renderApproval();
    await call('ws:approval-answer', { id: q.id, allow });
  }

  // ------------------------------------------------------------------ history

  async function loadHistory() {
    const r = await call('ws:history-list', { query: $('hist-search').value, kind: $('hist-kind').value });
    const list = $('hist-list'); clear(list);
    if (!r.ok) { list.appendChild(el('div', { cls: 'note', text: r.error || 'Could not load history.' })); return; }
    const groups = M.groupSessions(r.sessions);
    if (!groups.length) list.appendChild(el('div', { cls: 'note', text: $('hist-search').value ? 'Nothing found.' : 'Nothing saved yet.' }));
    for (const g of groups) {
      list.appendChild(el('div', { cls: 'hist-group', text: g.label }));
      for (const s of g.items) {
        const b = el('button', { cls: 'hist-item', attrs: { type: 'button', role: 'option', 'aria-selected': String(s.id === S.hist.id) } },
          el('span', { cls: 't', text: s.title || 'Untitled' }), el('span', { cls: 'm', text: `${M.kindLabel(s.kind)} · ${M.timeLabel(s.updatedAt)}${s.preview ? ` · ${s.preview}` : ''}` }));
        b.addEventListener('click', () => openHistory(s.id));
        list.appendChild(b);
      }
    }
  }

  async function openHistory(id) {
    const r = await callOrToast('ws:history-get', id);
    if (!r.ok) return;
    S.hist = { id, meta: r.meta };
    $('hist-empty').hidden = true; $('hist-actions').hidden = false;
    $('hist-continue').hidden = r.meta.kind !== 'chat';
    $('hist-title').textContent = `${r.meta.title}  ·  ${M.kindLabel(r.meta.kind)}${r.meta.project ? `  ·  ${r.meta.project}` : ''}`;
    const body = $('hist-body'); clear(body);
    for (const ev of r.events) addMessage(body, M.eventRow(ev));
    for (const b of $('hist-list').querySelectorAll('.hist-item')) b.setAttribute('aria-selected', 'false');
    body.scrollTop = 0;
  }

  async function continueChat() {
    if (!S.hist.id) return;
    S.chat.sessionId = S.hist.id; clear($('chat-log')); $('chat-empty').hidden = true;
    const r = await call('ws:history-get', S.hist.id);
    if (r.ok) for (const ev of r.events) addMessage($('chat-log'), M.eventRow(ev));
    showTab('chat'); $('chat-input').focus();
  }

  // ------------------------------------------------------------------ voice & privacy page

  async function saveSettings(patch) {
    const r = await callOrToast('ws:update-settings', patch);
    if (r.ok) applyState(r);
    return r;
  }

  function renderVoicePage() {
    if (!S.settings) return;
    const sp = S.settings.speech; const sum = M.speechSummary(S.speech);
    $('voice-talk').textContent = sum.talk; $('voice-listen').textContent = sum.listen; $('voice-privacy').textContent = sum.privacy;
    $('tts-engine').value = sp.ttsEngine; $('tts-voice').value = sp.ttsVoice; $('tts-rate').value = String(sp.ttsRate); $('tts-rate-out').textContent = `${sp.ttsRate}×`; $('tts-piper').value = sp.piperModel;
    $('stt-engine').value = sp.sttEngine; $('stt-model-file').value = sp.whisperModel; $('stt-binary').value = sp.whisperBinary; $('stt-model').value = sp.sttModel; $('stt-lang').value = sp.language;
    const route = $('stt-route'); clear(route);
    const none = el('option', { text: 'None' }); none.value = ''; route.appendChild(none);
    for (const p of S.providers) { const o = el('option', { text: p.label }); o.value = p.id; route.appendChild(o); }
    route.value = sp.sttRoute;
    $('hist-enabled').checked = S.settings.history.enabled;
    const issue = $('hist-issue'); issue.hidden = !S.historyIssue; issue.textContent = S.historyIssue || '';
  }

  function applyState(r) {
    S.settings = r.settings; S.speech = r.speech || S.speech; S.providers = r.providers || S.providers; S.code.project = r.project || S.code.project; S.historyIssue = r.historyIssue || null;
    $('chat-speak').checked = !!S.settings.speech.speakReplies;
    renderCodeHeader(); renderEditorState(); renderVoicePage();
    $('rail-note').textContent = S.speech && S.speech.stt && S.speech.stt.chosen === 'http' ? 'Voice goes to your transcription provider' : '';
  }

  // ------------------------------------------------------------------ wiring

  function wire() {
    $('chat-send').addEventListener('click', () => sendChat($('chat-input').value, false));
    $('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat($('chat-input').value, false); } });
    $('chat-stop').addEventListener('click', stopEverything);
    $('chat-new').addEventListener('click', newChat);
    $('chat-mic').addEventListener('click', onMic);
    $('chat-speak').addEventListener('change', (e) => saveSettings({ speech: { speakReplies: e.target.checked } }));
    $('chat-handsfree').addEventListener('change', () => { if (!$('chat-handsfree').checked && S.voice.state === 'listening' && rec.done) rec.done(); });

    $('code-pick').addEventListener('click', async () => openProject(await call('ws:code-pick')));
    $('code-run').addEventListener('click', runCode);
    $('code-mic').addEventListener('click', () => onMic('code'));
    $('code-editor').addEventListener('input', () => { S.code.dirty = $('code-editor').value !== S.code.fileContent; renderEditorState(); });
    $('code-save').addEventListener('click', saveCodeFile);
    $('code-reload').addEventListener('click', reloadCodeFile);
    document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && S.tab === 'code') { e.preventDefault(); saveCodeFile(); } });
    $('code-stop').addEventListener('click', () => call('ws:code-stop'));
    $('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runCode(); } });
    $('code-autonomy').addEventListener('change', (e) => saveSettings({ code: { autonomy: e.target.value } }));
    $('code-undo-all').addEventListener('click', async () => { if (await confirmBox('Put every changed file back as it was before ALLES touched it?', 'Undo all')) { const r = await call('ws:code-revert-all'); toast(r.ok ? 'Everything is back as it was.' : (r.results || []).filter((x) => !x.ok).map((x) => `${x.path}: ${x.error}`).join(' '), !r.ok); } });

    $('ap-allow').addEventListener('click', () => answer(true));
    $('ap-deny').addEventListener('click', () => answer(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('approval').hidden) answer(false); });

    let searchTimer = null;
    $('hist-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadHistory, 250); });
    $('hist-kind').addEventListener('change', loadHistory);
    $('hist-continue').addEventListener('click', continueChat);
    $('hist-rename').addEventListener('click', () => {
      const t = $('hist-title'); const input = el('input', { attrs: { type: 'text', maxlength: '200', 'aria-label': 'New name' } }); input.value = S.hist.meta.title;
      clear(t); t.appendChild(input); input.focus(); input.select();
      const commit = async () => { const v = input.value.trim(); if (v && v !== S.hist.meta.title) await callOrToast('ws:history-rename', { id: S.hist.id, title: v }); await loadHistory(); await openHistory(S.hist.id); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') openHistory(S.hist.id); });
      input.addEventListener('blur', commit, { once: true });
    });
    $('hist-export').addEventListener('click', async () => { const r = await callOrToast('ws:history-export', S.hist.id); if (r.ok && r.saved) toast(`Saved to ${r.saved}`); });
    $('hist-delete').addEventListener('click', async () => {
      if (!S.hist.id || !(await confirmBox('Delete this conversation from this computer?'))) return;
      const r = await callOrToast('ws:history-delete', S.hist.id);
      if (r.ok) { S.hist = { id: null, meta: null }; $('hist-actions').hidden = true; $('hist-empty').hidden = false; clear($('hist-body')); $('hist-title').textContent = ''; loadHistory(); }
    });

    const setting = (id, section, field, read) => $(id).addEventListener('change', (e) => saveSettings({ [section]: { [field]: read ? read(e.target) : e.target.value } }));
    setting('tts-engine', 'speech', 'ttsEngine'); setting('tts-voice', 'speech', 'ttsVoice'); setting('tts-piper', 'speech', 'piperModel');
    setting('tts-rate', 'speech', 'ttsRate', (t) => Number(t.value));
    $('tts-rate').addEventListener('input', (e) => { $('tts-rate-out').textContent = `${e.target.value}×`; });
    setting('stt-engine', 'speech', 'sttEngine'); setting('stt-model-file', 'speech', 'whisperModel'); setting('stt-binary', 'speech', 'whisperBinary');
    setting('stt-route', 'speech', 'sttRoute'); setting('stt-model', 'speech', 'sttModel'); setting('stt-lang', 'speech', 'language');
    setting('hist-enabled', 'history', 'enabled', (t) => t.checked);
    $('tts-test').addEventListener('click', async () => { await speakText('Hello. This is how ALLES sounds. I can read my answers to you.'); });
    $('mic-test').addEventListener('click', async () => {
      const btn = $('mic-test'); btn.disabled = true; btn.textContent = 'Speak for a moment…'; $('mic-meter').hidden = false;
      let peak = 0;
      const out = await record({ auto: false, maxMs: 4000, onLevel: (l) => { peak = Math.max(peak, l); meter(l); } });
      meter(0); $('mic-meter').hidden = true; btn.disabled = false; btn.textContent = 'Test the microphone';
      if (out.error) { toast(out.error, true); return; }
      toast(peak < 0.01 ? 'The microphone works but heard almost nothing. Check the input volume in the system settings.' : 'The microphone works.');
    });
    $('hist-clear').addEventListener('click', async () => {
      if (!(await confirmBox('Delete every saved conversation and coding session from this computer? This cannot be undone.', 'Delete all'))) return;
      const r = await callOrToast('ws:history-clear'); if (r.ok) { toast(`Deleted ${r.removed} saved conversations.`); S.hist = { id: null, meta: null }; }
    });
  }

  function onEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'code') {
      const p = ev.payload || {};
      if (p.type === 'changes') {
        renderChanges(p.changes);
        if (S.code.filePath && (p.changes || []).some((c) => c.path === S.code.filePath)) {
          if (S.code.dirty) toast(`${S.code.filePath} changed on disk while you have unsaved editor changes. Save or reload deliberately.`, true);
          else openCodeFile(S.code.filePath);
        }
      } else addCodeEvent(p);
    } else if (ev.type === 'approval') { S.approvals.push(ev.question); if (S.approvals.length === 1) renderApproval(); }
    else if (ev.type === 'approval-gone') { S.approvals = S.approvals.filter((q) => q.id !== ev.id); renderApproval(); }
    else if (ev.type === 'settings') { call('ws:state').then((r) => { if (r.ok) applyState(r); }); }
  }

  async function init() {
    buildTabs(); wire(); showTab('chat'); renderVoice(); renderEditorState();
    api.onEvent(onEvent);
    const r = await call('ws:state');
    if (r.ok) {
      applyState(r);
      // reopen the project that was open last time, if it still exists
      const last = r.settings.code.lastProject;
      if (last && !r.project) { const o = await call('ws:code-open', last); if (o.ok) openProject(o); }
      else if (r.project) { const t = await call('ws:code-tree'); renderCodeHeader(); if (t.ok) renderTree(t); }
    } else toast(r.error || 'ALLES could not load its settings.', true);
    $('chat-input').focus();
  }

  init();
}());
