'use strict';

/**
 * Settings view-model. PURE: no DOM, no Electron. The page script (settings.js) turns these answers into
 * elements; tests exercise this file directly, so the decisions ("is this provider ready?", "what does this
 * test result mean?", "is that a valid key?") are proven without opening a window.
 *
 * Works both as a CommonJS module (tests) and as a plain <script> (renderer), because the renderer is
 * sandboxed and cannot use require(). Same pattern as overlay/pill-model.js.
 *
 * Several constants here mirror a rule that is ALSO enforced in the main process (the key format, the
 * numeric limits, the provider kinds). The main process is the authority; the copies exist so the page can
 * say "no" immediately and in plain words. test/settings-model.test.js compares each copy with its source so
 * they cannot drift apart unnoticed.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SettingsModel = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  // ------------------------------------------------------------------ island placement

  const EDGES = ['top', 'bottom', 'left', 'right'];
  const EDGE_LABELS = { top: 'Top', bottom: 'Bottom', left: 'Left', right: 'Right' };
  const ALONG = { start: 0, center: 0.5, end: 1 };

  const clamp01 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0.5);

  /** 'start' | 'center' | 'end' when `along` is (almost exactly) one of them, else 'custom' (the user dragged it). */
  function alongChoice(along) {
    // Only a real number counts: Number(null) is 0 and Number('') is 0, which would read as "start".
    if (typeof along !== 'number' || !Number.isFinite(along)) return 'custom';
    for (const [name, v] of Object.entries(ALONG)) if (Math.abs(along - v) < 0.01) return name;
    return 'custom';
  }

  /** Words for the three alignments. On a side edge "start" is the top of the screen, not the left. */
  function alongChoiceLabels(edge) {
    return edge === 'left' || edge === 'right'
      ? { start: 'Top', center: 'Middle', end: 'Bottom' }
      : { start: 'Left', center: 'Center', end: 'Right' };
  }

  // Size of the little pill in the placement diagram, as a percentage of the diagram.
  const PILL_W = 26;
  const PILL_H = 9;
  const PILL_MARGIN = 4;

  /**
   * Where to draw the pill in the placement diagram, as percentages of the diagram's width/height.
   * An unknown edge is drawn as 'top', matching what the dock itself does with a bad value.
   */
  function pillSpot(edge, along) {
    const a = clamp01(along);
    const side = edge === 'left' || edge === 'right';
    if (side) {
      return {
        left: edge === 'left' ? PILL_MARGIN : 100 - PILL_W - PILL_MARGIN,
        top: PILL_MARGIN + a * (100 - PILL_H - 2 * PILL_MARGIN),
        width: PILL_W, height: PILL_H,
      };
    }
    return {
      left: PILL_MARGIN + a * (100 - PILL_W - 2 * PILL_MARGIN),
      top: edge === 'bottom' ? 100 - PILL_H - PILL_MARGIN : PILL_MARGIN,
      width: PILL_W, height: PILL_H,
    };
  }

  /**
   * A heads-up when the chosen edge has a panel or dock on it. `info.edges` is how many px the desktop has taken from each
   * edge; `info.freeEdge` is the edge with least on it. A panel between the pointer and the screen border makes the hidden
   * strip a thin line the pointer flies past, so say so - and point at a clearer edge, but only one that really is clearer.
   */
  function edgeNote(edge, info) {
    const i = info && typeof info === 'object' ? info : {};
    const insets = i.edges && typeof i.edges === 'object' ? i.edges : {};
    const here = Number(insets[edge]);
    if (!(Number.isFinite(here) && here > 0)) return '';
    const free = EDGES.includes(i.freeEdge) && !(Number(insets[i.freeEdge]) >= here) ? i.freeEdge : '';       // an edge with as much on it (this one included) is no help
    return `Your desktop has a bar or dock on the ${edge} edge, so the pill's hidden spot sits right next to it and is hard to reach with the pointer.${free ? ` The ${free} edge is clear.` : ''}`;
  }

  /** What "Reset" puts the pill back to: the clearest edge, centred. Falls back to the top edge when that is not known. */
  function resetPlacement(info) {
    const edge = info && EDGES.includes(info.freeEdge) ? info.freeEdge : 'top';
    return { edge, along: ALONG.center, label: `Reset to ${edge} ${alongChoiceLabels(edge).center.toLowerCase()}` };
  }

  // ------------------------------------------------------------------ mouse and keyboard

  /** What the "Method" control offers. Must list exactly settings.js INPUT_BACKENDS, in the same order (a test enforces it). */
  const INPUT_CHOICES = [
    ['auto', 'Automatic'],
    ['gnome', 'GNOME'],
    ['ydotool', 'ydotool'],
  ];

  const INPUT_NOTES = {
    auto: "On GNOME, ALLES uses GNOME's own remote-input service, which needs nothing installed, and switches to ydotool if that does not work on this computer. On any other desktop it uses ydotool.",
    gnome: "Only GNOME's own remote-input service (GNOME on Wayland). Nothing to install. If it does not work, ALLES says why instead of switching to something else.",
    ydotool: 'Only ydotool. It works on any desktop, but the ydotoold program has to be running and your user needs permission to use /dev/uinput.',
  };

  /** One sentence on what a choice means. A choice nobody knows reads as Automatic, which is what the app does with it too. */
  function inputNote(mode) {
    return typeof mode === 'string' && Object.prototype.hasOwnProperty.call(INPUT_NOTES, mode) ? INPUT_NOTES[mode] : INPUT_NOTES.auto;
  }

  /** The reason GNOME's own input was given up on, to go inside brackets: as it was said (names keep their capitals), without a full stop at the end. */
  function reasonText(why) {
    return str(why).trim().replace(/[.\s]+$/, '');
  }

  /**
   * What is in use right now, from app.info().input.
   * @returns {{using: string, problem: string, lines: string[]}}  `using` is empty when nobody knows; `problem` is set when
   *          automatic mode had to give up on GNOME's own input; `lines` are the plain facts worth showing under it.
   */
  function inputStatus(info) {
    const i = info && typeof info === 'object' && info.input && typeof info.input === 'object' ? info.input : {};
    const using = str(i.label);
    if (!using) return { using: '', problem: '', lines: [] };
    const lines = [];
    let problem = '';
    if (str(i.fellBackBecause)) {
      const why = reasonText(i.fellBackBecause);
      problem = `GNOME's own input did not work here${why ? ` (${why})` : ''}, so ALLES switched to ydotool. Restart ALLES to try GNOME's own input again.`;
    }
    lines.push(i.unicode === true
      ? 'It can enter any character, including accents, symbols and other scripts. What the keyboard cannot type is pasted, which borrows the clipboard for a moment.'
      : 'It types what a US keyboard can: letters, digits and punctuation. Accents, emoji and other scripts cannot be entered.');
    if (i.name === 'gnome') lines.push('While ALLES is sending input, GNOME shows a screen-sharing indicator. Pressing its Stop button stops ALLES at once.');
    if (i.pending === true) lines.push('The method you chose starts when the current task ends.');
    return { using, problem, lines };
  }

  /** One line for the About page: which way input is sent. Empty when not known. */
  function inputText(info) {
    const i = info && typeof info === 'object' && info.input && typeof info.input === 'object' ? info.input : {};
    const label = str(i.label);
    if (!label) return '';
    return str(i.fellBackBecause) ? `${label}. GNOME's own input did not work here.` : label;
  }

  // ------------------------------------------------------------------ providers

  const MAX_ROUTES = 12;     // must equal settings.js MAX_ROUTES (a test enforces it)

  /** What the "Add provider" buttons offer. Must list exactly settings.js KINDS (a test enforces it). */
  const ADD_CHOICES = [
    { kind: 'nvidia', label: 'NVIDIA' },
    { kind: 'grok', label: 'Grok' },
    { kind: 'gemini', label: 'Gemini' },
    { kind: 'custom', label: 'Other (OpenAI-compatible)' },
  ];

  /** `ids` with `id` moved one place up (delta < 0) or down (delta > 0). A copy; unknown ids and the ends do nothing. */
  function moveId(ids, id, delta) {
    const out = Array.isArray(ids) ? ids.slice() : [];
    const i = out.indexOf(id);
    if (i < 0 || !delta) return out;
    const j = i + (delta < 0 ? -1 : 1);
    if (j < 0 || j >= out.length) return out;
    [out[i], out[j]] = [out[j], out[i]];
    return out;
  }

  const str = (v) => (typeof v === 'string' ? v : '');

  /**
   * What the model / address inputs should contain, and what to show greyed-out when they are empty.
   * An empty saved value means "use the suggestion for this kind of provider", so the suggestion is shown
   * as a placeholder instead of being copied in as if the user had typed it.
   */
  function routeFields(route) {
    const r = route || {};
    return {
      labelValue: str(r.label),
      modelValue: r.modelIsDefault ? '' : str(r.model),
      modelPlaceholder: r.modelIsDefault ? str(r.model) : 'Model name',
      urlValue: r.urlIsDefault ? '' : str(r.baseUrl),
      urlPlaceholder: r.urlIsDefault ? str(r.baseUrl) : 'https://host/v1',
    };
  }

  /** The suggested model and address are best guesses that were never checked against the live service. Say so. */
  function unverifiedNote(route) {
    return route && route.defaultsUnverified
      ? 'The suggested model and address are best guesses and have not been checked against the live service. Use Test to find out.'
      : '';
  }

  /**
   * The one-line state of a provider. `tone` picks the colour: ready, off, attention (not finished setting up),
   * problem (it should work but does not).
   * @param {{enabled:boolean, problem:?string, problemKind?:?string}} route  one entry of describe-providers
   */
  function routeStatus(route) {
    const r = route || {};
    if (r.enabled !== true) return { tone: 'off', text: 'Turned off' };
    if (r.problem) return { tone: r.problemKind === 'setup' ? 'attention' : 'problem', text: String(r.problem) };
    return { tone: 'ready', text: 'Ready' };
  }

  // ------------------------------------------------------------------ keys

  const KEY_RE = /^[\x21-\x7E]{8,512}$/;   // must stay identical to keystore.js (a test enforces it)

  /** Validate what the user pasted before it is sent anywhere. */
  function checkKeyInput(text) {
    const t = typeof text === 'string' ? text.trim() : '';
    if (!t) return { ok: false, error: 'Paste your API key first.' };
    if (!KEY_RE.test(t)) return { ok: false, error: 'That does not look like an API key. Keys are 8 to 512 visible characters with no spaces or line breaks.' };
    return { ok: true, key: t };
  }

  /** One row of the key list: the hint and any tags worth showing. Never contains a secret. */
  function keyView(k) {
    const key = k || {};
    const tags = [];
    if (key.persisted === false) tags.push('memory only');
    if (key.readable === false) tags.push("can't be decrypted");
    return { id: str(key.id), hint: str(key.hint) || '****', tags };
  }

  /** How many saved keys exist only in memory (and will be gone after a restart). */
  function memoryOnlyKeyCount(routes) {
    let n = 0;
    for (const r of Array.isArray(routes) ? routes : []) for (const k of (r && r.keys) || []) if (k && k.persisted === false) n++;
    return n;
  }

  /** How many saved keys are written to disk (as opposed to held in memory). */
  function persistedKeyCount(routes) {
    let n = 0;
    for (const r of Array.isArray(routes) ? routes : []) for (const k of (r && r.keys) || []) if (k && k.persisted === true) n++;
    return n;
  }

  /** Where the keys live, and whether the plain-text opt-in applies. */
  function keyStorageView(status, policy) {
    const s = status || {};
    const mode = ['keyring', 'file', 'session'].includes(s.mode) ? s.mode : 'session';
    return {
      mode,
      title: { keyring: 'Encrypted with your system keyring', file: 'Saved as plain text', session: 'Kept in memory only' }[mode],
      summary: str(s.summary),
      warn: mode === 'file',
      showOptIn: mode !== 'keyring',        // with a real keyring the opt-in has no effect, so do not offer it
      optInChecked: policy === 'file',
    };
  }

  // ------------------------------------------------------------------ about

  const SESSION_NAMES = { wayland: 'Wayland', x11: 'X11' };

  /** "GNOME on Wayland". Either part is left out when it is not known. */
  function desktopText(info) {
    const i = info || {};
    const desk = str(i.desktop);
    const sess = SESSION_NAMES[str(i.session).toLowerCase()] || str(i.session);
    if (desk && sess) return `${desk} on ${sess}`;
    return desk || sess || 'Unknown';
  }

  /**
   * Which window system ALLES runs on, and whether that matters. On X11 (also through XWayland) the pill goes exactly
   * where it is put. On native Wayland the desktop decides where windows go, so the pill may drift off its edge: say so.
   * Empty when nobody knows (then there is nothing true to say).
   */
  function backendText(info) {
    const i = info || {};
    const b = i.backend && typeof i.backend === 'object' ? i.backend : {};
    const onWayland = str(i.session).toLowerCase() === 'wayland';
    if (b.placementHonoured === true) {
      return onWayland ? 'X11 mode, through XWayland. The pill sits exactly where you put it.' : 'X11. The pill sits exactly where you put it.';
    }
    if (b.placementHonoured === false) {
      const noX = b.xAvailable === false;
      const why = noX
        ? 'This desktop offers no X11 layer (XWayland), so ALLES runs as a native Wayland app.'
        : 'ALLES is running as a native Wayland app.';
      const fix = noX ? '' : ' Start ALLES with --ozone-platform=x11 to use X11 mode.';
      return `${why} Wayland desktops decide where windows go, so the pill may not stay on the screen edge.${fix}`;
    }
    return '';
  }

  /** What to tell the person about the global shortcut, truthfully: it may simply not work on their desktop. */
  function shortcutText(info) {
    const i = info || {};
    const accel = str(i.shortcut).replace(/\bControl\b/g, 'Ctrl') || 'The shortcut';
    if (i.shortcutRegistered === true) return `${accel} opens and closes the island.`;
    return `${accel} is not available on this desktop, because some desktops do not let apps claim global shortcuts. Use the pill on the screen edge instead. Starting ALLES a second time also toggles the island, so a shortcut you set up in your desktop's keyboard settings that launches ALLES will work.`;
  }

  // ------------------------------------------------------------------ test button

  const CHECK_LABELS = { text: 'Replies to text', vision: 'Understands images', tools: 'Can use tools', followup: 'Carries on after a tool call' };
  const CHECK_KEYS = ['text', 'vision', 'tools', 'followup'];

  /**
   * Turn probeRoute()'s result into rows. state: ok | fail | skipped | unknown.
   * A provider is only "usable" when ALL four pass: ALLES must read the screen (images), act (tools), and keep going after each action.
   */
  function testView(result) {
    const r = result && typeof result === 'object' ? result : {};
    const checks = CHECK_KEYS.map((key) => {
      const c = r[key];
      const label = CHECK_LABELS[key];
      if (!c || typeof c !== 'object') return { key, label, state: 'unknown', detail: '' };
      if (c.skipped) return { key, label, state: 'skipped', detail: str(c.hint) || 'Not tested.' };
      if (c.ok) return { key, label, state: 'ok', detail: Number.isFinite(c.ms) ? `${(c.ms / 1000).toFixed(1)} s` : '' };
      return { key, label, state: 'fail', detail: str(c.hint) || str(c.error) || 'Failed.' };
    });
    const usable = r.usable === true;
    const summary = str(r.summary);
    // The rows already say what went wrong, so the closing line must not repeat them: it says what the result MEANS.
    let verdict = summary;
    if (!usable && checks.some((c) => c.state !== 'unknown')) verdict = 'ALLES needs all four checks to pass before it can use this provider.';
    return { usable, summary, verdict, checks };
  }

  // ------------------------------------------------------------------ "Check this computer"

  const DOCTOR_STATES = ['ok', 'warn', 'problem', 'skipped'];
  const DOCTOR_WORDS = { ok: 'Fine', warn: 'Worth a look', problem: 'Needs fixing', skipped: 'Not tried' };
  const DOCTOR_HEADLINES = {
    problem: 'Something needs fixing before ALLES can do its job.',
    warn: 'ALLES should work. Some things are worth a look.',
    ok: 'Everything that could be tried works.',
  };

  /**
   * Turn the answer to 'settings:check-computer' ({ checks: [{ id, title, state, detail, fix }], summary: { text } }) into rows.
   * The page never trusts the shape: a missing or odd piece becomes a plain row and never an exception that blanks the page.
   * A state nobody knows shows as "worth a look" - hiding it would be worse than one harmless extra remark - and an answer with
   * no rows at all is a problem, never a green "everything works".
   * @returns {{ rows: {id:string,title:string,state:string,word:string,detail:string,fix:string}[], tone: 'ok'|'warn'|'problem', headline: string }}
   */
  function computerCheckView(result) {
    const r = result && typeof result === 'object' ? result : {};
    const rows = (Array.isArray(r.checks) ? r.checks : []).filter((c) => c && typeof c === 'object' && !Array.isArray(c)).map((c, i) => {
      const state = DOCTOR_STATES.includes(c.state) ? c.state : 'warn';
      return { id: str(c.id) || `check-${i + 1}`, title: str(c.title) || 'Check', state, word: DOCTOR_WORDS[state], detail: str(c.detail), fix: str(c.fix) };
    });
    if (!rows.length) return { rows, tone: 'problem', headline: 'The check gave no answer. Close Settings and open it again.' };
    const tone = rows.some((c) => c.state === 'problem') ? 'problem' : rows.some((c) => c.state === 'warn') ? 'warn' : 'ok';
    const said = r.summary && typeof r.summary === 'object' ? str(r.summary.text).trim() : '';
    return { rows, tone, headline: said || DOCTOR_HEADLINES[tone] };
  }

  // ------------------------------------------------------------------ safety + numbers

  // Bounds of the numeric settings; a test compares them with what settings.js actually clamps to.
  const LIMITS = {
    maxActionsPerMinute: { lo: 1, hi: 1000 },
    maxSteps: { lo: 1, hi: 200 },
    keepImages: { lo: 0, hi: 10 },
  };

  /** Reminders shown for as long as a protection is switched off. */
  function safetyWarnings(settings) {
    const s = (settings && settings.safety) || {};
    const out = [];
    if (s.requireApprovalForShell === false) out.push({ id: 'shell', text: 'Shell commands will run without asking you first.' });
    if (s.requireApprovalForFileWrites === false) out.push({ id: 'files', text: 'Files can be written without asking you first.' });
    if (s.allowDangerousKeys === true) out.push({ id: 'keys', text: 'Key combinations that can end your session are allowed: Ctrl+Alt+Delete, Ctrl+Alt+Backspace, switching to a text console (Ctrl+Alt+F1 to F6), Alt+SysRq and locking the screen (Super+L).' });
    return out;
  }

  /** "42" -> 42, clamped into [lo, hi]. Anything that is not a plain whole number -> null (leave the setting alone). */
  function parseIntInput(text, lo, hi) {
    const s = String(text == null ? '' : text).trim();
    if (!/^\d{1,6}$/.test(s)) return null;
    return Math.min(Math.max(Number(s), lo), hi);
  }

  /** {section: {key: value}} for a "section.key" path, or null for anything that is not exactly two safe names. */
  function patchFor(path, value) {
    const parts = String(path).split('.');
    const bad = (p) => !p || p === '__proto__' || p === 'constructor' || p === 'prototype';
    if (parts.length !== 2 || parts.some(bad)) return null;
    return { [parts[0]]: { [parts[1]]: value } };
  }

  return {
    EDGES, EDGE_LABELS, ALONG, ADD_CHOICES, MAX_ROUTES, CHECK_LABELS, LIMITS, INPUT_CHOICES,
    alongChoice, alongChoiceLabels, pillSpot, edgeNote, resetPlacement,
    inputNote, inputStatus, inputText,
    moveId, routeFields, unverifiedNote, routeStatus,
    checkKeyInput, keyView, memoryOnlyKeyCount, persistedKeyCount, keyStorageView,
    desktopText, backendText, shortcutText,
    testView, computerCheckView, DOCTOR_WORDS, safetyWarnings, parseIntInput, patchFor,
    KEY_RE_SOURCE: KEY_RE.source,
  };
}));
