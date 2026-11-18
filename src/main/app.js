'use strict';

const path = require('node:path');
const { SettingsStore } = require('./settings');
const { KeyStore } = require('./keystore');
const { ProviderRouter } = require('./providers/router');
const { chatCompletion } = require('./providers/openai-compat');
const { buildRoutes, describeRoutes, resolveRoute } = require('./providers/config');
const { InputController, SafetyGate } = require('./computer/input');
const { createBackend } = require('./computer/select-backend');
const { ScreenCapture, nativeResizer, detectDesktop } = require('./computer/screen');
const { createToolExecutor, buildToolSchemas } = require('./tools');
const { Agent } = require('./agent');
const { TaskRunner } = require('./runner');
const { ApprovalBroker, needsApproval } = require('./approvals');
const { wireApprovals, wireWorkspaceApprovals } = require('./wiring');
const { HistoryStore } = require('./history');
const { Speaker } = require('./speech/tts');
const { Transcriber } = require('./speech/stt');
const { ChatService } = require('./chat');
const { CodeService } = require('./code/service');
const { WorkspaceWindow } = require('./workspace-window');
const { attachWorkspaceIpc } = require('./workspace-ipc');
const { DockWindow, attachPageEvents } = require('./overlay/window');
const { freeEdge } = require('./overlay/dock');
const { TrayController } = require('./tray');
const { SettingsWindow } = require('./settings-window');
const { attachSettingsIpc } = require('./settings-ipc');
const { installLifecycle } = require('./lifecycle');
const { checkComputer } = require('./doctor');
const { NAME, DIR_NAME, SETTINGS_FILE, systemPrompt, desktopName } = require('./identity');

/**
 * App - the composition root. Builds every subsystem from settings and wires them together.
 *
 * NOTHING here talks to Electron APIs directly except through the `electron` object passed in, and every
 * path is injected. That is what makes create() runnable from a test with fakes for both, and it is also
 * what let every piece above be built and proven before this file existed: this file only connects them.
 *
 * WIRING MAP (who calls whom):
 *   runner.on('status')  -> dockWindow.setStatus()          (pill reflects what the agent is doing)
 *   runner.on('finished')-> dockWindow.setStatus() (as summary, if not already terminal); input.close() (GNOME's sharing
 *                           indicator goes away); a mouse/keyboard method chosen mid-task is applied now
 *   input backend        -> onUserStop (the person pressed Stop on GNOME's sharing indicator) -> runner.stop()
 *   approvals            -> wireApprovals() keeps the pill's status honest across a question
 *   dockWindow.onAction  -> 'submit-task' / 'stop-agent' / 'approval-answer' / 'open-settings' / 'quit'
 *   tray actions         -> the SAME four handlers (tray.js already requires this; see MENU_ACTIONS)
 *   settings 'change'    -> live-applied: placement moves the dock, tray toggles, router/tools rebuild
 *   Workspace window     -> workspace-ipc.js (Chat, History, Code, Voice); workspaceWindow.isTrusted() decides who may ask ;
 *                           the coding area asks its questions through the SAME approval broker, shown in that window
 *   Settings window      -> settings-ipc.js (requests) ; settingsWindow.isTrusted() decides who may ask ;
 *                           settings/key changes -> settingsWindow.notifyChanged() so an open page refreshes
 *   global shortcut      -> dockWindow.toggle() (open/close the island from anywhere)
 */
// The keys that open and close the island. Ctrl+Shift+D, and the Copilot key: on Linux that key sends Left Meta + Left Shift + F23.
// An app can only claim a global key on X11 / a plain X session; on a Wayland desktop the installer binds the same keys in the
// desktop's own keyboard settings (they run `alles`, which toggles the running island - see index.js).
const DEFAULT_SHORTCUT = 'Control+Shift+D';
const DEFAULT_EXTRA_SHORTCUTS = ['Super+Shift+F23'];

class App {
  /**
   * @param {object} o
   * @param {object} o.electron   { app, BrowserWindow, Tray, Menu, screen, ipcMain, safeStorage, nativeImage, globalShortcut }
   * @param {string} [o.userDataDir]  overrides electron.app.getPath('userData'), for tests
   * @param {string} [o.shortcut]     accelerator string for the global toggle (the one About shows); default Ctrl+Shift+D
   * @param {string[]} [o.extraShortcuts]  more accelerators that do the same; default the Copilot key (Super+Shift+F23 on Linux)
   * @param {{platform:?string, reason:string, placementHonoured:?boolean, xAvailable:?boolean}} [o.backend]  which window system Electron is running on
   *        (worked out in index.js; only reported to Settings, never acted on here)
   * @param {object} [o.env]  the environment variables that say which desktop and session this is (tests give their own)
   * @param {Function} [o.makeInputBackend]  how the mouse/keyboard backend is built (select-backend.js createBackend; tests give a fake)
   */
  constructor({ electron, userDataDir = null, shortcut = DEFAULT_SHORTCUT, extraShortcuts = DEFAULT_EXTRA_SHORTCUTS, backend = null, env = process.env, makeInputBackend = createBackend }) {
    this.electron = electron;
    this.shortcut = shortcut;
    this.extraShortcuts = extraShortcuts.filter((a) => a && a !== shortcut);
    this._extraRegistered = [];
    this.backend = backend;
    this.env = env;
    this.makeInputBackend = makeInputBackend;
    this._inputPending = false;       // a different mouse/keyboard method was chosen while a task was running
    this.dir = userDataDir || path.join(electron.app.getPath('userData'), DIR_NAME);
    this.lifecycle = installLifecycle(electron.app);
    this.unsubscribePageEvents = null;
    this.unsubscribeSettingsIpc = null;
    this.shortcutRegistered = false;
  }

  /** Build every subsystem. Call once, after electron.app is ready. Calling it twice is a no-op. */
  create() {
    if (this._created) return this;
    this._created = true;
    const { electron, dir } = this;

    this.settings = new SettingsStore(path.join(dir, SETTINGS_FILE));
    this.firstRun = this.settings.firstRun === true;
    this.keyStore = new KeyStore(path.join(dir, 'keys.json'), {
      safeStorage: electron.safeStorage || null,
      getPolicy: () => this.settings.get().security.keyStorage,
    });

    this.desktop = detectDesktop(this.env);
    this.gate = new SafetyGate({
      allowDangerous: this.settings.get().safety.allowDangerousKeys,
      maxActionsPerMinute: this.settings.get().safety.maxActionsPerMinute,
    });
    this.input = new InputController({ gate: this.gate, backend: this._buildInputBackend() });
    this.screen = new ScreenCapture({ resizer: electron.nativeImage ? nativeResizer(electron.nativeImage) : null });      // (a big screen is shrunk for the model)
    this.broker = new ApprovalBroker();

    this.tray = new TrayController({
      electron,
      getIcon: () => this._trayIcon(),
      isBusy: () => this.runner.busy,
      actions: {
        'toggle-island': () => this.dockWindow.toggle(),
        'open-workspace': () => this.openWorkspace(),
        'open-settings': () => this._openSettings(),
        'stop-agent': () => this.runner.stop(),
        quit: () => this.quit(),
      },
    });

    this.dockWindow = new DockWindow({
      electron,
      getPrefs: () => this.settings.get().dock,
      isBusy: () => this.runner.busy,
      onPlacementChange: (p) => this.settings.update({ dock: p }),
      onPlacementMismatch: (m) => console.error('[ALLES] placement not honoured by the compositor:', m),
      onAction: (name, payload) => this._onIslandAction(name, payload),
    });
    // Auto-hide needs a clear edge for its tiny hidden hit strip. Persistent mode has no hot strip, so keep the
    // requested Mac-style top placement below the GNOME panel instead of jumping to the bottom edge.
    if (this.firstRun && this.settings.get().dock.autoHide) this._chooseStartingEdge();
    this.dockWindow.create();
    this.unsubscribePageEvents = attachPageEvents(electron.ipcMain, this.dockWindow);

    this.runner = new TaskRunner({
      createAgent: () => this._createAgent(),
      onStart: () => this.input.resume(),          // releases the emergency stop (and a stop made from GNOME's sharing indicator)
      onStop: () => { this.gate.stop(); this.broker.cancelAll('Stopped by the user.'); },
    });
    for (const ev of ['status', 'finished']) this.runner.on(ev, (p) => this._onRunnerEvent(ev, p));

    this.approvalWiring = wireApprovals({ broker: this.broker, dock: this.dockWindow, dockActive: () => !!(this.runner && this.runner.busy) });
    this._createWorkspace();

    // The Settings window, and the requests it may make. The window object decides WHO is allowed to ask
    // (only its own page); settings-ipc.js refuses everyone else before doing anything.
    this.settingsWindow = new SettingsWindow({ electron });
    this.unsubscribeSettingsIpc = attachSettingsIpc(electron.ipcMain, this, { isTrusted: (event) => this.settingsWindow.isTrusted(event) });
    this.keyStore.on('change', () => this.settingsWindow.notifyChanged());

    this._applyTraySetting(this.settings.get().tray.enabled);
    this.settings.on('change', (next, prev) => this._onSettingsChange(next, prev));
    this._registerShortcut();

    electron.app.on('before-quit', () => this._teardown());
    return this;
  }

  /** A panel or dock on an edge makes the hidden strip there nearly impossible to hit (see dock.js freeEdge). */
  _chooseStartingEdge() {
    try {
      const edge = freeEdge(this.dockWindow.edgeInsets());
      if (edge !== this.settings.get().dock.edge) this.settings.update({ dock: { edge } });
    } catch (e) {
      console.error('[ALLES] could not look at the screen to choose a starting edge:', e.message);     // keep the default
    }
  }

  /**
   * Call once after create(). Auto-hide mode can show a short first-run peek. Persistent mode is already visible
   * from startup, so it does not need a temporary welcome timer.
   */
  welcome(ms = 6000) {
    try { if (this.firstRun && this.dockWindow) this.dockWindow.introduce(ms); }
    catch (e) { console.error('[ALLES] could not show the welcome peek:', e.message); }      // a nicety: never worth stopping for
  }

  /**
   * Open the island right away if it is closed (never closes one). This is what `alles --show` does when ALLES was NOT running yet:
   * the keyboard shortcut runs that command, and a shortcut that only started the app and showed nothing would feel broken.
   * When ALLES is already running the same command arrives as a second launch and toggles instead (index.js).
   */
  showIsland() {
    try {
      if (!this.dockWindow) return;
      const d = this.dockWindow.dock;
      if (d.phase === 'hidden' || (d.phase === 'peek' && !d.autoHide())) this.dockWindow.toggle();
    }
    catch (e) { console.error('[ALLES] could not open the island:', e.message); }
  }

  // ---------------------------------------------------------------- agent construction

  /** A fresh Agent for one task: today's provider config, freshly decrypted keys, current safety settings. */
  /** A router with today's providers and keys: asked for fresh on every task or message, so a key added a moment ago is used. */
  _createRouter() {
    return new ProviderRouter(buildRoutes(this.settings.get().providers.routes, this.keyStore), { openai: chatCompletion });
  }

  _createAgent() {
    const s = this.settings.get();
    const router = this._createRouter();
    const executeTool = createToolExecutor({
      input: this.input,
      screen: this.screen,
      approve: (action) => (needsApproval(action, s.safety) ? this.broker.request(action) : true),
    });
    return new Agent({
      router, executeTool,
      // Asked again before every request: which characters can be entered is only settled once the first mouse or keyboard action
      // has found out whether GNOME's own input works here, and the model must be told what is true at the time it asks.
      tools: () => buildToolSchemas({ unicode: this._inputCanEnterAnyText() }),
      maxSteps: s.agent.maxSteps, keepImages: s.agent.keepImages,
      systemPrompt: systemPrompt({ desktop: desktopName(this.desktop) }),
    });
  }

  _inputCanEnterAnyText() {
    try { return this.input.info().unicode === true; } catch { return false; }
  }

  // ---------------------------------------------------------------- mouse and keyboard

  /** A backend for the method chosen in Settings, wired to this app: the clipboard, and what to do when the person stops it. */
  _buildInputBackend() {
    return this.makeInputBackend({
      mode: this.settings.get().input.backend,
      desktop: this.desktop,
      session: this.env.XDG_SESSION_TYPE || '',
      clipboard: this.electron.clipboard || null,
      // The person pressed Stop on GNOME's "sharing" indicator: that means stop, exactly like the Stop button on the island.
      onUserStop: () => { try { if (this.runner) this.runner.stop(); } catch { /* the stop itself must never throw into the backend */ } },
      log: (m) => console.log(`[${NAME}] ${m}`),
    });
  }

  /** The method was changed in Settings. Not in the middle of a task: a button or key being held must be let go by the OLD method. */
  _applyInputSetting() {
    if (this.runner && this.runner.busy) { this._inputPending = true; return; }
    this._inputPending = false;
    this.input.setBackend(this._buildInputBackend());
  }

  /** A task has ended: nothing is being sent any more, so let go of what the backend holds open, then apply a change made meanwhile. */
  _taskEnded() {
    this.input.close();
    if (this._inputPending) { this._applyInputSetting(); this.settingsWindow.notifyChanged(); }
  }

  // ---------------------------------------------------------------- workspace window (Chat, History, Code, Voice)

  _createWorkspace() {
    const { electron, dir } = this;
    this.history = new HistoryStore({
      dir: path.join(dir, 'history'),
      isEnabled: () => this.settings.get().history.enabled,
      secrets: () => this.settings.get().providers.routes.flatMap((r) => this.keyStore.secrets(r.id)),     // exact keys are removed from anything saved
    });
    this.speaker = new Speaker({ getSettings: () => this.settings.get().speech, env: this.env });
    this.transcriber = new Transcriber({ getSettings: () => this.settings.get().speech, getRoute: (id) => this._routeForSpeech(id), env: this.env });
    this.chat = new ChatService({ createRouter: () => this._createRouter(), history: this.history });
    this.code = new CodeService({
      createRouter: () => this._createRouter(), broker: this.broker, getSettings: () => this.settings.get(), history: this.history,
      canStart: () => !(this.runner && this.runner.busy),
    });
    this.workspace = new WorkspaceWindow({ electron, onClosed: () => this._onWorkspaceClosed() });
    wireWorkspaceApprovals({ broker: this.broker, workspace: this.workspace });
    this.code.on('event', (payload) => this.workspace.send({ type: 'code', payload }));
    this.unsubscribeWorkspaceIpc = attachWorkspaceIpc(electron.ipcMain, {
      settings: this.settings, history: this.history, chat: this.chat, code: this.code, speaker: this.speaker, transcriber: this.transcriber, broker: this.broker,
      describeProviders: () => this.describeProviders(), dialog: electron.dialog, window: this.workspace,
    }, { isTrusted: (event) => this.workspace.isTrusted(event) }).detach;
    // What the pill does is remembered too (kind "task"), so History shows everything ALLES did, not only what was typed in the window.
    this.runner.on('tool', (p) => { if (this._pillSession) this.history.append(this._pillSession, { kind: 'tool', name: p.name, args: p.args, text: p.result, error: p.error }); });
    this.runner.on('finished', (r) => { if (this._pillSession) { this.history.append(this._pillSession, { kind: 'assistant', text: r.summary || (r.ok ? 'Done.' : 'It stopped.'), error: !r.ok }); this._pillSession = null; } });
  }

  /** What the transcription engine needs from a saved provider: its address and keys. Main process only; never sent to a page. */
  _routeForSpeech(id) {
    const r = this.settings.get().providers.routes.find((x) => x.id === id);
    if (!r) return null;
    return { baseUrl: resolveRoute(r).baseUrl, keys: this.keyStore.secrets(r.id) };
  }

  openWorkspace() { return this.workspace.open(); }

  _onWorkspaceClosed() {
    // Closing the window ends what it started: a coding task, a pending answer, anything being said, a recognition in progress.
    try { if (this.code && this.code.busy) this.code.stop(); if (this.chat) this.chat.stop(); if (this.speaker) this.speaker.stop(); if (this.history) this.history.flush(); } catch { /* the window is gone either way */ }
  }

  /**
   * What running `alles` again means (index.js calls this for a second launch, and for the first):
   *   --window  open the workspace window (the menu entry)      anything else  open or close the island (the keyboard shortcuts)
   */
  handleLaunch(argv = []) {
    if (Array.isArray(argv) && argv.includes('--window')) this.openWorkspace();
    else if (this.dockWindow) this.dockWindow.toggle();
  }

  // ---------------------------------------------------------------- runner -> pill

  _onRunnerEvent(kind, payload) {
    if (kind === 'status') this.dockWindow.setStatus(payload);
    else if (kind === 'finished') {
      if (!['done', 'error', 'stopped'].includes(this.dockWindow.lastStatus.state)) {
        // The agent may finish without a final terminal status (e.g. it just answered in text); make sure
        // the pill still lands somewhere final instead of hanging on its last "thinking"/"acting" state.
        this.dockWindow.setStatus({ state: payload.ok ? 'done' : 'error', detail: payload.summary });
      }
      this._taskEnded();
    }
  }

  // ---------------------------------------------------------------- pill -> app

  _onIslandAction(name, payload) {
    switch (name) {
      case 'submit-task':
        if (this.code && this.code.busy) { this.dockWindow.setStatus({ state: 'error', detail: 'ALLES is busy coding in its window. Stop that first, or wait for it.' }); break; }
        if (!this.runner.busy && typeof payload === 'string' && payload.trim()) { this._pillSession = this.history.create({ kind: 'task' }); this.history.append(this._pillSession, { kind: 'user', text: payload.trim() }); }
        this.runner.submit(payload).catch((e) => { if (this._pillSession) { this.history.append(this._pillSession, { kind: 'note', text: e.message, error: true }); } this._pillSession = this.runner.busy ? this._pillSession : null; this.dockWindow.setStatus({ state: 'error', detail: e.message }); });
        break;
      case 'stop-agent': this.runner.stop(); break;
      case 'approval-answer': this.approvalWiring.answer(payload); break;
      case 'open-workspace': this.openWorkspace(); break;
      case 'open-settings': this._openSettings(); break;
      case 'quit': this.quit(); break;
      default: break;
    }
  }

  // ---------------------------------------------------------------- settings window

  _openSettings() { this.settingsWindow.open(); }

  /** What the desktop has taken from each screen edge (a panel, a dock). All zero if the screen cannot be asked. */
  _edgeInsets() {
    try { return this.dockWindow.edgeInsets(); } catch { return { top: 0, bottom: 0, left: 0, right: 0 }; }
  }

  /** Read-only facts for Settings (About, and the hint about edges that have a panel on them). */
  info() {
    const { app } = this.electron;
    const edges = this._edgeInsets();
    const b = this.backend || {};
    return {
      name: NAME,
      version: typeof app.getVersion === 'function' ? String(app.getVersion()) : '',
      desktop: desktopName(this.desktop),
      session: this.env.XDG_SESSION_TYPE || '',
      input: this._inputInfo(),
      shortcut: this.shortcut,
      shortcutRegistered: this.shortcutRegistered,
      dataDir: this.dir,                       // where settings.json and keys.json live (a path, never a secret)
      backend: {                               // which window system Electron is running on, and whether it obeys placement
        platform: typeof b.platform === 'string' ? b.platform : '',
        reason: typeof b.reason === 'string' ? b.reason : '',
        placementHonoured: typeof b.placementHonoured === 'boolean' ? b.placementHonoured : null,
        xAvailable: typeof b.xAvailable === 'boolean' ? b.xAvailable : null,
      },
      edges,                                   // px lost to a panel or dock on each edge of the pill's screen
      freeEdge: freeEdge(edges),               // the edge with least on it: where a first run starts, and what Reset goes back to
    };
  }

  /** Which way of sending input is in use, for Settings. Plain data only. A backend that cannot be asked yields an empty answer. */
  _inputInfo() {
    let i = {};
    try { i = this.input.info() || {}; } catch { i = {}; }
    const text = (v) => (typeof v === 'string' ? v : '');
    const yes = (v) => v === true;
    return {
      mode: this.settings.get().input.backend,       // what the person chose
      name: text(i.name),                            // what is in use now: 'gnome' | 'ydotool'
      label: text(i.label),
      unicode: yes(i.unicode),                       // can it enter any character (not only a US keyboard's)?
      scroll: yes(i.scroll),
      drag: yes(i.drag),
      auto: yes(i.auto),                             // automatic mode: it may switch by itself
      fellBackBecause: typeof i.fellBackBecause === 'string' ? i.fellBackBecause : null,    // why GNOME's own input was given up on
      pending: this._inputPending,                   // a new choice waits for the current task to end
    };
  }

  // ---------------------------------------------------------------- tray + settings live-apply

  _trayIcon() {
    // A 1x1 fully-transparent PNG placeholder until real artwork exists; TrayController.enable() only
    // needs SOMETHING nativeImage-shaped, and its own tests cover failure to construct.
    const { nativeImage } = this.electron;
    return nativeImage.createFromBuffer(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  }

  _applyTraySetting(enabled) { this.tray.setEnabled(enabled); }

  _onSettingsChange(next, prev) {
    if (next.tray.enabled !== prev.tray.enabled) this._applyTraySetting(next.tray.enabled);
    if (JSON.stringify(next.dock) !== JSON.stringify(prev.dock)) this.dockWindow.refreshPlacement();
    if (next.safety.allowDangerousKeys !== prev.safety.allowDangerousKeys) this.gate.allowDangerous = next.safety.allowDangerousKeys;
    if (next.safety.maxActionsPerMinute !== prev.safety.maxActionsPerMinute) this.gate.maxPerMin = next.safety.maxActionsPerMinute;
    if (next.input.backend !== prev.input.backend) this._applyInputSetting();
    // Provider/key changes need no action here: _createAgent() reads settings.get() fresh on every task.
    this.settingsWindow.notifyChanged();          // an open Settings page re-reads (e.g. after the pill was dragged)
  }

  // ---------------------------------------------------------------- global shortcut

  _registerShortcut() {
    const { globalShortcut } = this.electron;
    if (!globalShortcut) return;
    const toggle = () => this.dockWindow.toggle();
    const tryRegister = (accel) => {
      try { return !!globalShortcut.register(accel, toggle); }
      catch (e) { console.error(`[ALLES] could not register the ${accel} shortcut:`, e.message); return false; }
    };
    this.shortcutRegistered = tryRegister(this.shortcut);                       // what About reports
    this._extraRegistered = this.extraShortcuts.filter(tryRegister);            // a taken extra key never affects the main one
  }

  // ---------------------------------------------------------------- provider status (for Settings)

  /** What Settings should show for each provider route: config + any live rejection the router remembers. */
  describeProviders() {
    const s = this.settings.get();
    const router = new ProviderRouter(buildRoutes(s.providers.routes, this.keyStore), { openai: chatCompletion });
    return describeRoutes(s.providers.routes, this.keyStore, router.status());
  }

  // ---------------------------------------------------------------- "check this computer"

  /** See doctor.js. One check at a time: asking again while one is running gets that one's answer. */
  checkComputer() {
    if (this._checking) return this._checking;
    this._checking = checkComputer({
      info: this.info(), screen: this.screen, input: this.input, providers: this.describeProviders(), keyStatus: this.keyStore.status(),
      busy: () => !!(this.runner && this.runner.busy),
    }).finally(() => { this._checking = null; });
    return this._checking;
  }

  // ---------------------------------------------------------------- lifecycle

  _teardown() {
    if (this.unsubscribePageEvents) this.unsubscribePageEvents();
    if (this.unsubscribeSettingsIpc) { this.unsubscribeSettingsIpc(); this.unsubscribeSettingsIpc = null; }
    if (this.unsubscribeWorkspaceIpc) { this.unsubscribeWorkspaceIpc(); this.unsubscribeWorkspaceIpc = null; }
    if (this.code && this.code.busy) this.code.stop();
    if (this.chat) this.chat.stop();
    if (this.speaker) this.speaker.stop();
    if (this.workspace) this.workspace.destroy();
    if (this.history) this.history.flush();
    if (this.settingsWindow) this.settingsWindow.destroy();
    if (this.electron.globalShortcut) {
      if (this.shortcutRegistered) this.electron.globalShortcut.unregister(this.shortcut);
      for (const accel of this._extraRegistered) this.electron.globalShortcut.unregister(accel);
      this._extraRegistered = [];
    }
    if (this.runner && this.runner.busy) this.runner.stop();
    if (this.input) this.input.dispose();          // closes GNOME's sharing session and its connection; never rejects
    if (this.tray) this.tray.disable();
    if (this.dockWindow) this.dockWindow.destroy();
    if (this.settings) this.settings.flush();
  }

  /** The ONLY way the app should exit. */
  quit() { this.lifecycle.quit(); }
}

module.exports = { App };
