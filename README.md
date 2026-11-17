# ALLES

**ALLES** is a native Linux desktop assistant — an Electron app that sees your screen, controls the mouse and keyboard, runs commands, and edits files on your behalf. It lives as a small auto-hiding "island" on the edge of your screen, showing status, activity, and a prompt box. GNOME is the primary target; KDE Plasma should work too (not yet tried).

Think of it as an AI agent that can *actually use your computer*: it takes screenshots, decides what to click or type, runs shell commands, edits code, and reports back — all while you watch in the island or the full window (Chat, Code, History, Voice).

**This is a work in progress. Read "Status" before relying on anything.**

## Install

```
./install.sh                 # installs for you (no root; it asks for sudo only where needed)
alles                        # start it, or find ALLES in your app menu
./install.sh --uninstall     # remove it again (your settings stay; --purge deletes them too)
```

It copies the app to `~/.local/share/alles`, installs the dependencies (including Electron), puts an `alles` command in
`~/.local/bin`, adds a menu entry, and sets up the keyboard shortcuts **Ctrl+Shift+D** and the **Copilot key**, both of which
open and close the island. Every step has a fallback and says what it did:

| If this is missing or fails | What happens instead |
|---|---|
| Node.js 18+ / npm | Offers to install them with your package manager; otherwise prints the exact command |
| `npm ci` | Tries `npm install`, then the `node_modules` folder next to `install.sh`, then stops and says why |
| `sudo` for Electron's sandbox | The launcher passes `--no-sandbox` (Chromium's sandbox off) and prints the one command that fixes it properly |
| GNOME keyboard settings | KDE's settings, then the exact steps to add the shortcut by hand |
| Wayland | The launcher runs ALLES through XWayland (`--ozone-platform=x11`) so the pill can sit exactly on a screen edge |

Options: `--shortcut '<Super>space'` (another key, GNOME notation), `--no-copilot-key`, `--no-shortcut`, `--autostart`,
`--ydotool` (set up mouse and keyboard control through ydotool, see below), `--no-sudo`, `--prefix DIR`, `--dry-run`
(shows what it would do and changes nothing), `-y` (answer yes to every question). `./install.sh --help` lists them all.

**The Copilot key** sends Left Meta + Left Shift + F23 on Linux (kernel 6.x and laptops that have the key). If pressing it
does nothing, check with `sudo showkey` or `wev` that your laptop sends that combination. **Ctrl+Shift+D** is also Firefox's and
Chrome's "bookmark all tabs": a global shortcut takes it from them. Pick another key with `--shortcut` if that matters.

## The desktop window: Chat, Code, History, Voice

Open **ALLES** from your app menu (it runs `alles --window`), or run `alles --window`. The pill and the keyboard shortcuts work as before;
this is the normal window next to them.

| Page | What it does |
|---|---|
| **Chat** | Talk with the AI, typed or spoken. **Read answers aloud** makes ALLES speak; **Hands-free** makes it listen again by itself after it has spoken. Press **Stop** to end listening, thinking and speaking at once. |
| **Code** | Choose a project folder and tell ALLES what to build or fix. It reads the code, edits files, runs your tests or build, and reports back. Every change is listed with its diff and can be undone. |
| **History** | Every chat, coding session and pill task, grouped by day, searchable (also inside what was said). Open one to read it, continue a chat, rename, save as Markdown, or delete. |
| **Voice & privacy** | What can talk and listen on this computer, in plain words; engine choices; a voice test and a microphone test; the switch for remembering history, and Delete all. |

**Speech, and where your voice goes.**
- *ALLES talking* uses a program already on your computer; nothing is sent anywhere: **piper** (natural voices; needs a voice file), **espeak-ng**, or the desktop's **spd-say**. If none is installed it tries the window's built-in voices. Install `espeak-ng` for a quick start.
- *You talking*: the sound is a 16 kHz recording made in the window, only after you press Talk (or Test), and the microphone is released the moment it ends. Two ways to understand it: **whisper.cpp** on your computer (private; install `whisper-cli` and choose a `ggml-*.bin` model file) or **a transcription provider** you already saved in Settings (any server with OpenAI's `/audio/transcriptions`, e.g. OpenAI, Groq, a local server). The provider option sends your voice over the internet, and the window asks you first.
- The microphone is the only permission the window has, for sound only; the Settings window and the pill still refuse every permission.

**The coding area's rules.**
- ALLES can use only the project folder you chose: `..`, absolute paths outside it and links that lead outside are refused, nothing is written into `.git`, and it will not accept your home folder or a folder holding credentials.
- It has no screen, mouse or keyboard tools here: only list, read, search, write, edit, and run a command in the folder.
- **When ALLES codes by itself** (Code page): *Ask before every change and command* (the default), *Change files by itself, ask before commands*, or *Work by itself*. Even in the last one a command that looks dangerous, and any file that usually holds secrets (`.env`, keys), still asks. The questions are the same ones the pill asks, shown in the window.
- Undo restores a file only if nobody has changed it since. **Commands can change anything, and their effects are not on the undo list.**
- Text found inside files or command output is treated as information, not as instructions (the prompt says so); this reduces, but cannot remove, the risk of a booby-trapped file steering the AI, which is why the default asks first.

**What is saved.** History is kept only on this computer, in `~/.config/alles/history`, readable only by you, with your API keys removed before anything is written. Turn it off in Voice & privacy (it stops saving; it does not delete), or delete everything there. A command-line version is not included (planned for later).

**Packaging.** `npm run dist` builds an AppImage and a .deb with electron-builder (`electron-builder.yml`); it is not run yet.

## Run from a checkout (development)

```
npm install
npm start          # needs a desktop session
npm test           # 1470+ unit and integration tests, no display needed
```

On a Wayland desktop start it in X11 mode (it runs through XWayland, which GNOME and KDE both provide):

```
npm start -- --ozone-platform=x11
```

**If Electron refuses to start** with "The SUID sandbox helper binary was found, but is not configured correctly" (usual
on Ubuntu 24.04), run this once, then start again. (`npm start -- --no-sandbox` also works, but turns Chromium's sandbox
off, so prefer this.) `install.sh` does it for you.

```
sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

Why X11 mode: ALLES parks a 2 px hidden strip at an exact spot on a screen edge. A native Wayland app is not allowed to
choose where its window goes, and on the real GNOME Shell the strip landed in the wrong place. Through XWayland
it lands exactly where asked. ALLES only reports which mode it is in (see the log line `window system:`, and
Settings > About); it cannot switch mode itself, because Chromium decides before any of our code runs. The
`alles` command that `install.sh` puts in place passes this flag for you.

## Using it

| You do | What happens |
|---|---|
| Rest the pointer on the hidden strip | A small pill with status and clock appears |
| Click the pill | The island opens: status, reply, activity log, prompt box, approval questions. The prompt box has the keyboard at once |
| Esc | Closes the island (with a question open, Esc means "no" to it instead) |
| Click anywhere outside | Closes it too - unless a task is running, a question is open, or you have typed something |
| Drag the pill | It follows the pointer and lands on the nearest edge; the spot is remembered |
| Click the gear in the island | Settings opens |
| Settings > About > **Check now** | ALLES tries what it needs, one thing at a time, and says in plain words what works and what to fix (see "Check this computer" below) |
| Ctrl+Shift+D or the Copilot key | Opens the island if closed, closes it if open (and starts ALLES with the island open if it was not running). They run `alles --show`, which `install.sh` binds for you |
| Start ALLES a second time (the same command you started it with) | Does the same toggle, so any shortcut you set up yourself that runs `alles --show` works too |

A first run shows the pill briefly so you can see where it lives. It starts on the bottom edge, because
GNOME's top bar gets in the way of a strip on the top edge (a quick flick up does not reach it). Placement
(edge and where along it) can be changed in Settings > Island. A tray icon exists but is off by default.

**Keyboard shortcuts.** ALLES itself asks for Ctrl+Shift+D and the Copilot key (Super+Shift+F23), which only works where
an app may claim global keys (a plain X11 session). An X11/XWayland app cannot do that under Wayland, so on GNOME `install.sh`
also binds the same keys in GNOME's own keyboard settings (Settings > Keyboard > Shortcuts > Custom, entries "ALLES pill").
The two never both fire: whichever claims the key first gets it. Settings > About shows whether ALLES's own claim worked.

**Settings** has six tabs: Providers (keys, order, a Test button per key and per provider), Island
(placement, clock, tray), Mouse & keyboard (how input is sent, see below), Safety, Key storage, About (facts about this
installation, and **Check this computer**). Providers, in the order tried: NVIDIA, NVIDIA fallback,
Grok (several keys), Gemini (several keys), with failover and key rotation. API keys are never written to
`settings.json` and never sent to a page; they live in the system keyring when there is one, otherwise only in
memory unless you explicitly choose a plain-text file.

**Mouse and keyboard.** On a GNOME Wayland desktop ALLES uses GNOME's own remote-input service (the one remote
desktop uses), so there is **nothing to set up**: no `ydotoold`, no `/dev/uinput` permission. While a task runs GNOME
shows its "screen is being shared" indicator in the top bar, and **pressing Stop there stops ALLES at once**, exactly
like the Stop button on the island. When no task is running the session is closed, so the indicator is gone. If
GNOME's service cannot be used here (an X11 session, PipeWire missing) or the desktop is not GNOME, ALLES uses
`ydotool` instead (that one does need its daemon and device permission: `./install.sh --ydotool` sets them up, and asks about it on desktops that need it). Settings >
Mouse & keyboard shows which one is in use and why, and lets you force one.

- Letters, digits and punctuation are typed key by key on **your** keyboard layout (a table for every layout of
  `xkeyboard-config` is generated by `python3 scripts/gen-layout-data.py`; 35 layouts, including dead-key and
  right-to-left ones, were checked key by key on a real GNOME Shell). Anything the keyboard cannot make (an accent on a
  US keyboard, the rupee sign, emoji, Hebrew, Japanese ...) is **pasted**: ALLES borrows the clipboard for a moment and
  puts your text back. The model is told which characters were pasted.
- The model is sent a screenshot of at most 1280 pixels on its long side, and the pointer lands on the exact pixel it
  pointed at, on any screen scale and with several screens. A point outside the screenshot is refused (the model is told
  and looks again) instead of clicking at the nearest edge.
- **Stop** ends a task at once, even in the middle of a `wait`, a running shell command, or while ALLES is waiting
  for the AI (no other key or provider is tried after Stop). The command is killed together with everything it
  started. A program a command *launches* (for example `firefox &`) is left running, and the model is told so
  instead of waiting for it to end.

**Check this computer** (Settings > About > Check now) is the first thing to press when something does not work. It
tries, one at a time: which desktop this is, whether the island can be placed exactly, a real screenshot, the mouse and
keyboard connection (opened with a move of zero and let go of again, so GNOME's sharing indicator is gone afterwards),
whether an AI provider is ready, and where your keys are kept. Each answer is a short sentence, and a problem says what
to do about it. While a task is running it does not touch the screen or the mouse and keyboard (those two say "not
tried"), so it can never interrupt a task or cancel a Stop. The result is forgotten when you leave About, so an old
"no API key" never shows after you have added one.

**The Test button** sends four small requests with your key and tells you in plain words which one failed and why:
a plain answer, reading a picture, calling a tool, and carrying on after a tool's answer (the second step of every
real task - some providers accept the first tool call and reject the follow-up). The picture is as big as a real
screenshot (1280x720, about 400 KB), because some providers limit the size of a picture or of a request: a provider
that takes a tiny picture but refuses a big one is reported as exactly that, with the provider's own words.

**When an AI answers badly.** Real models do odd things, and none of them should end a task by accident:

- A reply with nothing in it, or one that stops in the middle (a thinking model that ran out of room), is not taken
  as the answer. ALLES asks the AI to carry on, up to twice, and only then ends the task and says why in plain words.
  Every reply may be up to 8192 tokens long (a provider's own default can be much smaller).
- A tool request with no id, the same id twice (or an id used earlier in the task), arguments sent as an object or as
  JSON inside JSON, or arguments cut off in the middle, is repaired or answered with what was wrong ("your reply was
  cut off, split the work into smaller pieces"). It never leaves a conversation that the next request is refused for.
- Thinking that a model writes into its answer (`<think>...</think>`) is left out of what you are shown, and out of
  what is sent back at every step.
- The system prompt tells the model that words with no tool call end the task (models like to say "I will click..."
  and stop).

**Default models** (change them per provider in Settings > Providers; leave the box empty to use these):

| Provider | Address | Model |
|---|---|---|
| NVIDIA | `integrate.api.nvidia.com` | `nvidia/nemotron-3.5-super-vl-120b-a12b` |
| NVIDIA fallback | same | suggests `moonshotai/kimi-k2.6`, so a failure of the first model does not repeat on the second |
| Grok | `api.x.ai` | `grok-4.7` |
| Gemini | `generativelanguage.googleapis.com` (OpenAI-compatible endpoint) | `gemini-3.8-flash` |

These names were checked against each provider's own documentation and model list on 2026-10-18. **No request has
been sent to any of them with a real key yet**, so run the Test button once per key before relying on it.

## Status

**Built, and tested layer by layer:**

- Unit and integration tests (`npm test`, 1270+): the dock state machine, drag, placement, providers and failover,
  key storage, approvals, input and typing, keyboard layouts, screenshots and scaling, the agent loop and its tools
  (including Stop and odd replies from an AI), Settings backend and page logic. The important ones were also checked by breaking the code on
  purpose and seeing that a test fails.
- Real Electron under Xvfb (`scripts/e2e-*.cjs`): app start-up, dock, drag, island, Settings.
- A **real GNOME Shell 46** running headless with its real top bar, XWayland, PipeWire and a virtual pointer and
  keyboard (`scripts/gnome-e2e/`, see its README):
  - `dock-flow.js` (scenarios A-I): first-run welcome, hover reveal, click, island with keyboard, Esc, click
    outside, launching again to toggle, drag to another edge, the top-bar case, the native-Wayland fallback,
    Settings from the gear, the island held open by the mouse, and the desktop maximizing the pill (undone at once).
  - `input-flow.cjs` (A-J, 186 checks): ALLES's own mouse and keyboard control against test windows - clicks, drag,
    scroll, typing, **every printable character on 35 keyboard layouts**, shortcuts, pasting, the idle close, Stop
    on GNOME's indicator, and the screenshot-to-pointer chain at scale 1, 2, 1.25, with two screens and with mixed
    scales.
  - `agent-flow.cjs` (1-6, 88 checks, also run at scale 2 and 1.25): the **whole assistant** doing tasks against a
    scripted stand-in for the AI model: a task from first screenshot to finish, approval questions, provider and key
    failover, Stop in every state, "Check this computer", and an AI that misbehaves (empty or cut-off answers, calls
    with no ids, thinking in the answer). The stand-in is *strict*: like the fussiest real providers it answers a
    request that breaks the rules of the chat format with an error, so a request ALLES should never send fails the test.

**Installer** (`install.sh`, `packaging/alles`): tested in a throwaway home directory with stand-ins for npm, sudo and
gsettings (`test/installer.test.js`: every fallback above, shortcuts that keep your own custom ones, running twice,
uninstall, `--dry-run`). **Never run on a real machine yet.** In particular not verified: the real Electron download,
the sandbox fix on Ubuntu 24.04, GNOME actually firing the shortcut (and the Copilot key on real hardware), the KDE
shortcut (written, but KDE was never tried), and the ydotool setup (udev rule, group, user service).

**The workspace window** (Chat, Code, History, Voice): everything with logic is tested without a display (`test/workspace-*.test.js`,
`history`, `tts`, `stt`, `voice-model`, `code-*`, `chat`, `diff`: window class, request handlers, the preload with hostile input,
the page script run against a pretend browser including a full spoken round trip, and the App wiring). **Never run in real
Electron yet.** Not verified: how the page looks and lays out, the real microphone and its permission prompt, `ScriptProcessor`
capture on your system, the real speech programs (espeak-ng, piper, spd-say flags), whisper.cpp's actual output format, a real
transcription server, the window-voice fallback, a real model driving the coding tools, and `npm run dist`.

**Not verified. Treat as unknown:**

- **Your machine.** Everything above ran on a virtual desktop (a real GNOME Shell with no real screen, mouse or
  keyboard). GNOME's remote-input service is the same code on real hardware, but the first run on your computer is the
  real proof. Two things only a real screen can show: whether `gnome-screenshot` flashes the screen on every step, and
  how a real keyboard with Caps Lock on behaves while ALLES types.
- The `ydotool` path (used on KDE and in X11 sessions). The real `ydotool` client was only tested against a stand-in
  daemon. Upstream says absolute mouse moves need pointer acceleration off, and GNOME's default is adaptive.
- Real model calls. Addresses and model names come from the providers' documentation and model lists (see "Default
  models"), but nothing was ever sent to them with a real key. Four things are known to need care:
  - xAI lists the Chat Completions format ALLES uses as legacy (it still works). A Responses-API adapter is the
    future fix if xAI retires it.
  - Gemini 3 models refuse a follow-up request unless the "thought signature" of their own tool call is sent back.
    ALLES sends the provider's tool calls back untouched (a test pins this), and the Test button's fourth check
    would show the problem.
  - Picture size. Every step sends the newest two screenshots as PNG (1280 px on the long side; usually 150-900 KB
    each). Providers differ on how much they take. NVIDIA's own sample code for some of its hosted vision models (2024)
    says a picture sent inline must be under 180,000 characters of base64 (about 135 KB) and larger ones go through an
    upload service; whether the default model has such a limit is not known. The Test button now sends a
    screenshot-sized picture, so that shows up there. A provider that refuses big pictures is skipped for ten minutes
    and the next one answers (and Settings shows why); the fix would be to send that provider smaller pictures, so
    tell me what the Test button says.
  - Thinking models spend part of the answer budget on thinking; the Test requests leave room for it, and a task
    allows 8192 tokens per reply and asks again when a reply comes back empty or cut off. If a model needs more
    than that, it will say "ran out of room" (see "When an AI answers badly").
- KDE Plasma (screenshots through `spectacle`, input through `ydotool`): not tried at all.
- Real monitors with several scales (virtual ones: scale 1, 2, 1.25, two screens and mixed were exact).
- Where the pointer really is, under XWayland. An X11 app cannot see the pointer while it is over a native Wayland
  window; the desktop only keeps the last spot it saw over an X11 window. If a pill window appears exactly over that
  spot, the pill can believe the pointer is on it (the first-run pill, or an island opened by the agent's news, then
  stays up until you hover it and leave once). Measured on a real GNOME Shell, rare in real use (the spot must fall
  inside the pill); a small GNOME Shell extension that reports the true pointer would remove it.
- Electron versions other than 33. Which window system Electron picks by default was measured on 33 only;
  on other versions ALLES says "not known".
- Pure Wayland sessions with no XWayland at all.

## Tests

```
npm test                                   # everything that needs no display (includes the installer tests, which need bash)
YDOTOOL_BIN=$(command -v ydotool) npm test # also runs 10 tests against your real ydotool 1.x client

xvfb-run -a -s "-screen 0 1920x1080x24" node_modules/.bin/electron scripts/e2e-island.cjs --no-sandbox
                                           # likewise e2e-app, e2e-dock, e2e-drag, e2e-settings

scripts/gnome-e2e/run.sh 1366x768 node scripts/gnome-e2e/dock-flow.js
scripts/gnome-e2e/run.sh 1366x768 node_modules/.bin/electron scripts/gnome-e2e/input-flow.cjs --no-sandbox --disable-gpu --ozone-platform=x11
scripts/gnome-e2e/run.sh 1366x768 node_modules/.bin/electron scripts/gnome-e2e/agent-flow.cjs --no-sandbox --disable-gpu --ozone-platform=x11
                                           # the real GNOME Shell runs (run as root); see scripts/gnome-e2e/README.md
```

## Layout

| Path | What it is |
|---|---|
| `src/main/index.js` | Entry point (`npm start`): single-instance lock, reports the window system |
| `src/main/app.js`, `wiring.js` | Composition root: builds every part and wires them together |
| `src/main/overlay/` | The edge island: `dock.js` (pure state machine), `window.js` (glue to the real window), `drag*.js`, `layout.js` |
| `src/overlay/` | The pill page (HTML, JS, preload, pure model) |
| `src/main/providers/` | Provider router, key rotation, request format, the Test probe |
| `src/main/computer/` | Screenshots (gnome-screenshot, spectacle or grim); mouse and keyboard: `input.js` (the safe front: validation, emergency stop), `mutter-*.js` (GNOME's own remote-input service), `ydotool-backend.js`, `select-backend.js` (which one), `typetext.js` and `keyboard-layout*.js` (what a keyboard can type; the data file is generated) |
| `src/main/agent.js`, `runner.js`, `tools/` | The agent loop and the tools it can call |
| `src/main/doctor.js` | "Check this computer": every check, in plain words, with what to do about a problem |
| `src/main/approvals.js`, `sensitive.js` | Asks before shell commands, file writes and reads of credential files |
| `src/main/keystore.js`, `settings.js`, `settings-ipc.js`, `settings-window.js` | Key storage, settings, the Settings window's backend and window |
| `src/settings/` | The Settings page |
| `src/workspace/` | The window's page (HTML, CSS, script), its tested view-model, voice helpers (WAV, silence detection, what gets read aloud) and its locked-down preload |
| `src/main/workspace-window.js`, `workspace-ipc.js` | The window (microphone-only permission, own session) and every request it may make |
| `src/main/history.js`, `chat.js`, `speech/`, `code/` | History store, the Chat service, text-to-speech and speech-to-text, and the coding area (project walls, tools, undo, diff, service) |
| `install.sh`, `packaging/alles`, `assets/` | The installer and uninstaller, the `alles` command it installs (flags, X11 on Wayland), and the icon |
| `src/main/platform.js` | Reports which window system is running (X11 or Wayland) and whether placement is honoured |
| `test/` | Unit and integration tests |
| `scripts/` | End-to-end scripts: Xvfb ones (`e2e-*.cjs`) and the real-GNOME-Shell harness (`gnome-e2e/`); `gen-layout-data.py` makes the keyboard layout table (`--explain <layout> '<chars>'` shows how one is typed) |
