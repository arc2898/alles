#!/usr/bin/env bash
# ALLES installer. Installs for the current user (no root needed, except for two optional steps that ask first).
#
#   ./install.sh                 install or update
#   ./install.sh --uninstall     remove it again (your settings are kept; add --purge to delete them too)
#
# What it does, in order. Every step has a fallback, and a step that fails never stops the ones after it
# unless nothing could work without it:
#   1. Node.js 22.12+ and npm       missing -> offers to install them with your package manager, else says how
#   2. copies the app            to ~/.local/share/alles
#   3. npm ci                    fails -> npm install -> node_modules copied from this folder -> stop with the reason
#   4. Electron's sandbox        needs the Chromium helper setuid root -> otherwise installation stops safely
#   5. the `alles` command       ~/.local/bin/alles (starts ALLES, or opens/closes the island if it is running)
#   6. menu entry and icon
#   7. keyboard shortcuts        Ctrl+Shift+D and the Copilot key -> GNOME settings -> KDE settings -> exact manual steps
#   8. start at login            only if you say yes
#   9. ydotool                   only for desktops that need it (not GNOME on Wayland), only if you say yes
#
# Options:  --prefix DIR  --bin-dir DIR  --shortcut KEYS  --no-copilot-key  --no-shortcut  --autostart  --no-autostart
#           --ydotool  --no-ydotool  --no-sudo  -y/--yes  --dry-run  --uninstall  --purge  -h/--help
# KEYS is in GNOME's notation, e.g. '<Control><Shift>d' (the default) or '<Super>space'.

set -u
set -o pipefail

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}
CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}
APP_DIR=${ALLES_HOME:-$DATA_HOME/alles}
BIN_DIR=${ALLES_BIN_DIR:-$HOME/.local/bin}
CONF_FILE=$CONFIG_HOME/alles/launcher.conf
DESKTOP_FILE=$DATA_HOME/applications/alles.desktop
ICON_FILE=$DATA_HOME/icons/hicolor/scalable/apps/alles.svg
AUTOSTART_FILE=$CONFIG_HOME/autostart/alles.desktop
UNIT_FILE=$CONFIG_HOME/systemd/user/ydotool.service

MAIN_KEY='<Control><Shift>d'
COPILOT_KEY='<Super><Shift>F23'      # the Copilot key sends Left Meta + Left Shift + F23
WANT_SHORTCUT=1 WANT_COPILOT=1
AUTOSTART=no YDOTOOL=ask
NO_SUDO=0 YES=0 DRY=0 UNINSTALL=0 PURGE=0
NEED_RELOGIN=0
GS_SCHEMA=org.gnome.settings-daemon.plugins.media-keys
GS_BASE=/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings

# ------------------------------------------------------------------ small helpers

if [ -t 1 ]; then B=$'\033[1m' G=$'\033[32m' Y=$'\033[33m' R=$'\033[31m' N=$'\033[0m'; else B='' G='' Y='' R='' N=''; fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==>%s %s%s%s\n' "$B" "$N" "$B" "$*" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '\n%s✗ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
interactive() { [ -t 0 ] && [ -t 1 ]; }

# run CMD...  -> runs it, or only prints it with --dry-run
run() { if [ "$DRY" = 1 ]; then printf '  would run: %s\n' "$*"; return 0; fi; "$@"; }

# ask "question" -> 0 for yes. --yes answers yes; with no terminal the answer is no.
ask() {
  [ "$YES" = 1 ] && return 0
  interactive || return 1
  local a; read -r -p "  $1 [y/N] " a; case "$a" in y|Y|yes|YES) return 0;; *) return 1;; esac
}

# as_root CMD... -> runs with root rights if it can (already root, passwordless sudo, or sudo with a terminal)
as_root() {
  [ "$DRY" = 1 ] && { printf '  would run as root: %s\n' "$*"; return 0; }
  [ "$NO_SUDO" = 1 ] && return 1
  if [ "$(id -u)" = 0 ]; then "$@"; return $?; fi
  have sudo || return 1
  if sudo -n true 2>/dev/null; then sudo -n "$@"; return $?; fi
  interactive || return 1
  sudo "$@"
}

# Package manager install of the given packages (as root). Returns 1 if there is none or it failed.
pm_install() {
  if   have apt-get; then as_root apt-get install -y "$@"
  elif have dnf;     then as_root dnf install -y "$@"
  elif have pacman;  then as_root pacman -S --noconfirm --needed "$@"
  elif have zypper;  then as_root zypper --non-interactive install "$@"
  else return 1; fi
}

# conf_set KEY VALUE / conf_unset KEY: the little launcher.conf the `alles` command reads
conf_esc() { printf '%s' "$1" | sed -e 's/[\\"$`]/\\&/g'; }   # backslash, ", $ and ` made literal: launcher.conf is sourced as shell
conf_set() {
  [ "$DRY" = 1 ] && { say "  would set $1=\"$2\" in $CONF_FILE"; return 0; }
  mkdir -p "$(dirname "$CONF_FILE")"
  { [ -f "$CONF_FILE" ] && grep -v "^$1=" "$CONF_FILE"; printf '%s="%s"\n' "$1" "$(conf_esc "$2")"; } > "$CONF_FILE.new" && mv "$CONF_FILE.new" "$CONF_FILE"
}
conf_unset() {
  [ "$DRY" = 1 ] && return 0
  [ -f "$CONF_FILE" ] || return 0
  grep -v "^$1=" "$CONF_FILE" > "$CONF_FILE.new"; mv "$CONF_FILE.new" "$CONF_FILE"
  [ -s "$CONF_FILE" ] || rm -f "$CONF_FILE"
}

usage() { sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# ------------------------------------------------------------------ arguments

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix)         APP_DIR=${2:?--prefix needs a folder}; shift;;
    --bin-dir)        BIN_DIR=${2:?--bin-dir needs a folder}; shift;;
    --shortcut)       MAIN_KEY=${2:?--shortcut needs keys, e.g. "<Control><Shift>d"}; shift;;
    --no-copilot-key) WANT_COPILOT=0;;
    --no-shortcut)    WANT_SHORTCUT=0;;
    --autostart)      AUTOSTART=yes;;
    --no-autostart)   AUTOSTART=no;;
    --ydotool)        YDOTOOL=yes;;
    --no-ydotool)     YDOTOOL=no;;
    --no-sudo)        NO_SUDO=1;;
    -y|--yes)         YES=1;;
    --dry-run)        DRY=1;;
    --uninstall)      UNINSTALL=1;;
    --purge)          PURGE=1;;
    -h|--help)        usage; exit 0;;
    *) die "unknown option: $1 (try --help)";;
  esac
  shift
done

# ------------------------------------------------------------------ steps

preflight() {
  [ "$(uname -s)" = Linux ] || die "ALLES is for Linux only."
  if [ "$(id -u)" = 0 ] && [ -z "${ALLES_ALLOW_ROOT:-}" ]; then
    die "Do not run this as root: it installs for one user. Run it as yourself; it asks for sudo only where needed."
  fi
  [ -f "$SRC/package.json" ] && [ -d "$SRC/src" ] || die "Run this from the ALLES folder (package.json and src/ not found next to install.sh)."
  [ "$DRY" = 1 ] && say "(dry run: nothing is changed)"
  return 0
}

node_ok() {
  have node && have npm || return 1
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)' >/dev/null 2>&1
}

ensure_node() {
  step "Node.js and npm"
  if node_ok; then ok "node $(node -v), npm $(npm -v)"; return 0; fi
  [ "$DRY" = 1 ] && { warn "Node.js 22.12+ / npm missing (a real run would offer to install them)"; return 0; }
  warn "Node.js 22.12 or newer and npm are needed (npm downloads Electron)."
  if ask "Install nodejs and npm with your package manager (needs sudo)?"; then
    pm_install nodejs npm && node_ok && { ok "installed node $(node -v)"; return 0; }
    warn "that did not give a usable Node.js 22.12+ (some distributions ship an older one)."
  fi
  die "Install Node.js 22.12+ and npm yourself, then run ./install.sh again. For example:
    Debian/Ubuntu:  use Node.js 22.12+ (Debian stable may be older; https://github.com/nvm-sh/nvm)
    Fedora:         sudo dnf install nodejs npm
    Arch:           sudo pacman -S nodejs npm"
}

copy_app() {
  step "Copying the app to $APP_DIR"
  if [ "$(cd "$APP_DIR" 2>/dev/null && pwd)" = "$SRC" ]; then ok "already there"; return 0; fi
  run mkdir -p "$APP_DIR" || die "cannot create $APP_DIR"
  run rm -rf "$APP_DIR/src" "$APP_DIR/assets" "$APP_DIR/packaging"
  local item
  for item in src assets packaging package.json package-lock.json README.md LICENSE install.sh; do
    [ -e "$SRC/$item" ] && { run cp -a "$SRC/$item" "$APP_DIR/" || die "could not copy $item to $APP_DIR"; }
  done
  ok "copied"
}

install_deps() {
  step "Installing dependencies (this downloads Electron, about 100 MB the first time)"
  [ "$DRY" = 1 ] && { run npm ci; return 0; }
  local flags="--no-audit --no-fund --loglevel=error"
  # shellcheck disable=SC2086
  if ( cd "$APP_DIR" && npm ci $flags ); then ok "npm ci"
  else
    warn "npm ci failed; trying npm install"
    # shellcheck disable=SC2086
    if ( cd "$APP_DIR" && npm install $flags ); then ok "npm install"
    elif [ "$SRC" != "$APP_DIR" ] && [ -x "$SRC/node_modules/electron/dist/electron" ]; then
      warn "no network? using the node_modules next to install.sh"
      rm -rf "$APP_DIR/node_modules" && cp -a "$SRC/node_modules" "$APP_DIR/" || die "could not copy node_modules"
      ok "node_modules copied"
    else
      die "Could not install the dependencies. Check your internet connection (or a proxy: npm config set proxy ...) and run ./install.sh again.
  If you only have a mirror for Electron: ELECTRON_MIRROR=https://your.mirror/ ./install.sh"
    fi
  fi
  [ -d "$APP_DIR/node_modules/dbus-next" ] || die "dbus-next is missing from $APP_DIR/node_modules - run ./install.sh again."
  if [ -x "$APP_DIR/node_modules/electron/dist/electron" ]; then ok "Electron ready"
  elif have electron; then warn "using the Electron found on PATH ($(command -v electron)); this runtime is not validated for ALLES $(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$APP_DIR/package.json" 2>/dev/null | head -n 1)"
  else die "Electron was not installed - run ./install.sh again."; fi
}

fix_sandbox() {
  step "Electron's sandbox"
  local sb="$APP_DIR/node_modules/electron/dist/chrome-sandbox"
  [ -e "$sb" ] || { ok "nothing to fix"; return 0; }
  if [ "$DRY" != 1 ] && [ "$(stat -c '%U:%a' "$sb")" = "root:4755" ]; then ok "already set"; conf_unset_nosandbox; return 0; fi
  if as_root chown root:root "$sb" && as_root chmod 4755 "$sb"; then ok "sandbox helper set up (root, mode 4755)"; conf_unset_nosandbox; return 0; fi
  die "ALLES was not installed: Chromium sandbox setup needs administrator permission. Run this once, then rerun ./install.sh:
    sudo chown root:root '$sb' && sudo chmod 4755 '$sb'
  ALLES will not be launched with --no-sandbox because that disables a core security boundary."
}
conf_unset_nosandbox() {
  [ -f "$CONF_FILE" ] && grep -q '^ALLES_FLAGS="--no-sandbox"$' "$CONF_FILE" && conf_unset ALLES_FLAGS
  return 0
}

install_launcher() {
  step "The alles command"
  run mkdir -p "$BIN_DIR" || die "cannot create $BIN_DIR"
  run install -m 755 "$APP_DIR/packaging/alles" "$BIN_DIR/alles" 2>/dev/null || { [ "$DRY" = 1 ] || die "could not install $BIN_DIR/alles"; }
  if [ "$APP_DIR" != "$DATA_HOME/alles" ]; then conf_set ALLES_HOME "$APP_DIR"; else
    [ -f "$CONF_FILE" ] && grep -q '^ALLES_HOME=' "$CONF_FILE" && conf_unset ALLES_HOME
  fi
  ok "$BIN_DIR/alles"
  case ":$PATH:" in *":$BIN_DIR:"*) ;; *) warn "$BIN_DIR is not on your PATH, so typing 'alles' in a terminal will not find it yet (the menu entry and the shortcuts use the full path and work).";; esac
}

install_desktop_entry() {
  step "Menu entry and icon"
  [ "$DRY" = 1 ] && { say "  would write $DESKTOP_FILE and $ICON_FILE"; return 0; }
  mkdir -p "$(dirname "$DESKTOP_FILE")" "$(dirname "$ICON_FILE")"
  cp "$APP_DIR/assets/alles.svg" "$ICON_FILE" 2>/dev/null || warn "icon not copied"
  cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=ALLES
Comment=Agentic AI desktop assistant
Exec="$BIN_DIR/alles" --window
Icon=alles
Terminal=false
Categories=Utility;
StartupNotify=false
Actions=pill;

[Desktop Action pill]
Name=Open the pill
Exec="$BIN_DIR/alles" --show
EOF
  have update-desktop-database && update-desktop-database "$(dirname "$DESKTOP_FILE")" >/dev/null 2>&1
  have gtk-update-icon-cache && gtk-update-icon-cache -q -t "$DATA_HOME/icons/hicolor" >/dev/null 2>&1
  ok "$DESKTOP_FILE"
}

# --- keyboard shortcuts -------------------------------------------------------

gnome_binding() {   # id name command keys  -> 0 if set
  local id=$1 name=$2 cmd=$3 key=$4 path cur new k
  path="$GS_BASE/$id/"
  cur=$(gsettings get "$GS_SCHEMA" custom-keybindings 2>/dev/null) || return 1
  cur=${cur#@as }
  case "$cur" in
    *"'$path'"*) new=$cur;;
    "[]")        new="['$path']";;
    *)           new="${cur%]}, '$path']";;
  esac
  # warn about another custom shortcut already using these keys (we do not touch it)
  local p other
  for p in $(printf '%s' "$cur" | grep -o "'[^']*'" | tr -d "'"); do
    [ "$p" = "$path" ] && continue
    other=$(gsettings get "$GS_SCHEMA.custom-keybinding:$p" binding 2>/dev/null)
    [ "$other" = "'$key'" ] && warn "$key is already used by another shortcut of yours ($(gsettings get "$GS_SCHEMA.custom-keybinding:$p" name 2>/dev/null)); both will fire or neither will work."
  done
  [ "$new" = "$cur" ] || run gsettings set "$GS_SCHEMA" custom-keybindings "$new" || return 1
  k="$GS_SCHEMA.custom-keybinding:$path"
  run gsettings set "$k" name "$name" && run gsettings set "$k" command "$cmd" && run gsettings set "$k" binding "$key"
}

pretty_keys() {     # '<Control><Shift>d' -> 'Ctrl+Shift+D' (also KDE's notation)
  printf '%s' "$1" | sed -E 's/<(Control|Primary)>/Ctrl+/g; s/<Shift>/Shift+/g; s/<Alt>/Alt+/g; s/<Super>/Meta+/g; s/([a-z])$/\U\1/'
}

kde_binding() {
  local kw reload keys
  kw=$(command -v kwriteconfig6 || command -v kwriteconfig5) || return 1
  keys=$(pretty_keys "$MAIN_KEY")
  [ "$WANT_COPILOT" = 1 ] && keys="$keys"$'\t'"$(pretty_keys "$COPILOT_KEY")"
  run "$kw" --file kglobalshortcutsrc --group alles.desktop --key _launch "$keys,none,ALLES" || return 1
  if have systemctl && systemctl --user restart plasma-kglobalaccel.service >/dev/null 2>&1; then :
  elif have kquitapp5; then kquitapp5 kglobalaccel5 >/dev/null 2>&1; (kglobalaccel5 >/dev/null 2>&1 &)
  fi
  return 0
}

# The command a shortcut runs: starts ALLES with the island open, or toggles it if ALLES is already running.
show_command() { case "$BIN_DIR" in *" "*) echo "\"$BIN_DIR/alles\" --show";; *) echo "$BIN_DIR/alles --show";; esac; }

manual_shortcut_help() {
  say "    Add one yourself in your desktop's keyboard settings (Keyboard > Shortcuts > Custom):"
  say "      command:  $(show_command)"
  say "      keys:     $(pretty_keys "$MAIN_KEY")"
  [ "$WANT_COPILOT" = 1 ] && say "      and a second one with the Copilot key (it sends Shift+Super+F23)"
  say "    That command starts ALLES with the island open, or opens/closes it if ALLES is already running. Where the desktop"
  say "    lets apps claim global keys (a plain X11 session), ALLES also registers Ctrl+Shift+D and the Copilot key by itself."
}

setup_shortcuts() {
  step "Keyboard shortcuts"
  if [ "$WANT_SHORTCUT" = 0 ]; then say "  skipped (--no-shortcut)"; return 0; fi
  local cmd desktop="${XDG_CURRENT_DESKTOP:-}"
  cmd=$(show_command)
  if have gsettings && gsettings get "$GS_SCHEMA" custom-keybindings >/dev/null 2>&1 && [[ "$desktop" != *KDE* ]]; then
    if gnome_binding alles "ALLES pill" "$cmd" "$MAIN_KEY"; then
      ok "$MAIN_KEY opens/closes the pill (GNOME keyboard settings)"
      if [ "$WANT_COPILOT" = 1 ]; then
        if gnome_binding alles-copilot "ALLES pill (Copilot key)" "$cmd" "$COPILOT_KEY"; then ok "the Copilot key does the same ($COPILOT_KEY)"
        else warn "could not set the Copilot key shortcut"; fi
      fi
      return 0
    fi
    warn "GNOME refused the shortcut settings."
  elif [[ "$desktop" == *KDE* ]] && kde_binding; then
    ok "$(pretty_keys "$MAIN_KEY")$([ "$WANT_COPILOT" = 1 ] && echo ' and the Copilot key') set in KDE (not tested on KDE: if they do nothing, log out and in, or add them in System Settings > Shortcuts)"
    return 0
  fi
  warn "Could not set the keyboard shortcut automatically on this desktop (${desktop:-unknown})."
  manual_shortcut_help
}

# --- optional: start at login, ydotool -----------------------------------------

setup_autostart() {
  step "Start at login"
  case "$AUTOSTART" in
    yes) ;;
    no)  say "  no"; return 0;;
    *)   ask "Start ALLES when you log in?" || { say "  no (use --autostart to turn it on later)"; return 0; };;
  esac
  [ "$DRY" = 1 ] && { say "  would write $AUTOSTART_FILE"; return 0; }
  mkdir -p "$(dirname "$AUTOSTART_FILE")"
  cat > "$AUTOSTART_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=ALLES
Exec="$BIN_DIR/alles"
Icon=alles
Terminal=false
X-GNOME-Autostart-enabled=true
EOF
  ok "$AUTOSTART_FILE"
}

needs_ydotool() {   # GNOME on Wayland uses its own remote-input service; everything else uses ydotool
  [[ "${XDG_CURRENT_DESKTOP:-}" == *GNOME* && "${XDG_SESSION_TYPE:-}" == wayland ]] && return 1
  return 0
}

setup_ydotool() {
  step "Mouse and keyboard control (ydotool)"
  case "$YDOTOOL" in
    no)  say "  skipped"; return 0;;
    yes) ;;
    *)   if ! needs_ydotool; then ok "not needed: GNOME on Wayland uses its own remote-input service"; return 0; fi
         say "  On this desktop ALLES controls mouse and keyboard through ydotool, which needs a background service and"
         say "  permission for /dev/uinput (this adds you to the 'input' group; it needs sudo and a re-login afterwards)."
         ask "Set up ydotool now?" || { say "  skipped (run ./install.sh --ydotool later; Settings > About > Check now shows what is missing)"; return 0; };;
  esac
  if ! { have ydotool && have ydotoold; }; then
    pm_install ydotool || { warn "could not install ydotool: install it with your package manager (version 1.x), then run ./install.sh --ydotool"; return 0; }
  fi
  local ydotoold; ydotoold=$(command -v ydotoold) || { warn "ydotoold not found after install"; return 0; }

  if printf 'KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"\n' | as_root tee /etc/udev/rules.d/60-alles-uinput.rules >/dev/null \
     && printf 'uinput\n' | as_root tee /etc/modules-load.d/alles-uinput.conf >/dev/null; then
    as_root modprobe uinput
    as_root udevadm control --reload-rules && as_root udevadm trigger --name-match=uinput
    ok "/dev/uinput is readable by the 'input' group"
  else
    warn "could not write the udev rule (no sudo). Without it ydotool needs root. Fallback: run 'sudo $ydotoold' yourself before using ALLES."
    return 0
  fi
  if ! id -nG | tr ' ' '\n' | grep -qx input; then
    if as_root usermod -aG input "$(id -un)"; then NEED_RELOGIN=1; ok "added $(id -un) to the 'input' group"
    else warn "could not add you to the 'input' group: run  sudo usermod -aG input $(id -un)  and log out and in."; NEED_RELOGIN=1; fi
  fi
  if [ "$DRY" != 1 ]; then
    mkdir -p "$(dirname "$UNIT_FILE")"
    cat > "$UNIT_FILE" <<EOF
# Installed by ALLES (install.sh). Remove with: install.sh --uninstall
[Unit]
Description=ydotool daemon (virtual mouse and keyboard for ALLES)

[Service]
ExecStart=$ydotoold
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
    if have systemctl && systemctl --user daemon-reload && systemctl --user enable --now ydotool.service >/dev/null 2>&1; then ok "ydotool service enabled"
    else warn "could not start the service; start it with: systemctl --user enable --now ydotool"; fi
  fi
}

# ------------------------------------------------------------------ uninstall

uninstall() {
  step "Removing ALLES"
  local p k
  rm -f "$BIN_DIR/alles" "$DESKTOP_FILE" "$ICON_FILE" "$AUTOSTART_FILE"
  if have gsettings && gsettings get "$GS_SCHEMA" custom-keybindings >/dev/null 2>&1; then
    local cur new
    cur=$(gsettings get "$GS_SCHEMA" custom-keybindings); cur=${cur#@as }; new=$cur
    for p in alles alles-copilot; do
      k="$GS_BASE/$p/"
      case "$cur" in *"'$k'"*)
        gsettings reset "$GS_SCHEMA.custom-keybinding:$k" name; gsettings reset "$GS_SCHEMA.custom-keybinding:$k" command; gsettings reset "$GS_SCHEMA.custom-keybinding:$k" binding
        new=$(printf '%s' "$new" | sed "s|, '$k'||; s|'$k', ||; s|'$k'||");;
      esac
    done
    [ "$new" = "[]" ] || [ "$new" = "" ] && new="@as []"
    [ "$new" = "$cur" ] || gsettings set "$GS_SCHEMA" custom-keybindings "$new"
  fi
  if kw=$(command -v kwriteconfig6 || command -v kwriteconfig5); then "$kw" --file kglobalshortcutsrc --group alles.desktop --key _launch --delete 2>/dev/null; fi
  if [ -f "$UNIT_FILE" ] && grep -q 'Installed by ALLES' "$UNIT_FILE"; then
    have systemctl && systemctl --user disable --now ydotool.service >/dev/null 2>&1
    rm -f "$UNIT_FILE"; have systemctl && systemctl --user daemon-reload >/dev/null 2>&1
  fi
  ok "command, menu entry, icon, start-at-login, shortcuts, ydotool service"
  if [ -f "$APP_DIR/package.json" ] && grep -q '"name": "alles"' "$APP_DIR/package.json"; then rm -rf "$APP_DIR"; ok "removed $APP_DIR"
  else warn "$APP_DIR does not look like an ALLES install; left alone"; fi
  if [ "$PURGE" = 1 ]; then rm -rf "$CONFIG_HOME/alles"; ok "deleted your settings ($CONFIG_HOME/alles)"
  else say "  your settings are kept in $CONFIG_HOME/alles (add --purge to delete them). Keys you stored in the system keyring stay there."; fi
  [ -e /etc/udev/rules.d/60-alles-uinput.rules ] && say "  left in place (system files, harmless): /etc/udev/rules.d/60-alles-uinput.rules, /etc/modules-load.d/alles-uinput.conf, and your 'input' group membership."
  say "  If ALLES is running right now, quit it from its tray icon or with: pkill -f 'alles.*electron'"
}

# ------------------------------------------------------------------ main

shortcut_words() {
  if [ "$WANT_SHORTCUT" != 1 ]; then echo "run 'alles' again"; return; fi
  if [ "$WANT_COPILOT" = 1 ]; then echo "$(pretty_keys "$MAIN_KEY") or the Copilot key"; else pretty_keys "$MAIN_KEY"; fi
}

summary() {
  step "Done"
  say "  Start it:      alles        (or find ALLES in your app menu)"
  say "  Open the island: $(shortcut_words) - the persistent pill stays visible at the top of the screen; click it to expand."
  [ "$NEED_RELOGIN" = 1 ] && say "  ${Y}Log out and in once${N}: your new 'input' group membership (for ydotool) only applies to new sessions."
  say "  First thing to do: open Settings (gear in the island), add an API key, press Test, then Settings > About > Check now."
  say "  Remove it again: $APP_DIR/install.sh --uninstall"
}

main() {
  preflight
  if [ "$UNINSTALL" = 1 ]; then uninstall; exit 0; fi
  ensure_node
  copy_app
  install_deps
  fix_sandbox
  install_launcher
  install_desktop_entry
  setup_shortcuts
  setup_autostart
  setup_ydotool
  summary
}

main "$@"
exit $?
