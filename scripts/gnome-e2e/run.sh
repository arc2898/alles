#!/bin/sh
# Run a command inside a REAL GNOME Shell with nobody logged in: headless, with a virtual monitor, XWayland and the
# real top bar - plus a tiny "probe" extension so a test can ask the Shell where windows really are.
#
#   scripts/gnome-e2e/run.sh 1366x768 node scripts/gnome-e2e/dock-flow.js
#
# Needs (Debian/Ubuntu names): gnome-shell, xwayland, python3-dbusmock, util-linux (unshare), dbus-daemon, and `npm install`
# for dbus-next. It starts a pretend system bus with a pretend login service, because GNOME Shell refuses to start
# without one, and it must run as root (it hides /run/systemd from the Shell so the real login service is not used).
# This is for testing ALLES, not part of ALLES.
set -u
# Some machines set NODE_OPTIONS (for example --use-openssl-ca, for Node's network access through a proxy). Electron prints an error line
# for an option it does not support, and the tests count an error line in the app's log as the app's own. They need no network.
unset NODE_OPTIONS
HERE=$(cd "$(dirname "$0")" && pwd)

if [ "${1:-}" = "--inner" ]; then
  # ---- inside the private mount namespace and the private session bus ------------------------------------------
  shift; MON="$1"; shift
  gq() { gdbus call --session --dest org.alles.Probe --object-path /org/alles/Probe --method org.alles.Probe.Eval "$1" 2>/dev/null | sed -e "s/^('//" -e "s/',)\$//"; }
  gsettings set org.gnome.shell enabled-extensions "['probe@alles']"
  gsettings set org.gnome.shell disable-user-extensions false
  gsettings set org.gnome.shell welcome-dialog-last-shown-version '99.0'
  # Settings are kept between runs (the user's dconf file), so a run that was cut short could leave a test keyboard layout or a screen-scale
  # switch behind. Every run starts from the plain defaults: a US keyboard and whole-number scales only.
  gsettings reset-recursively org.gnome.desktop.input-sources
  gsettings reset org.gnome.mutter experimental-features
  # A real GNOME session always has PipeWire running, and the Shell needs it for anything that streams the screen (which is how an
  # absolute pointer position is given through the remote-desktop interface). Start one in our private runtime folder when installed.
  PW=""
  if command -v pipewire >/dev/null 2>&1; then pipewire >> "$ALLES_GS_WORK/pipewire.log" 2>&1 & PW=$!; sleep 0.5; fi
  # MON is one size ("1366x768") or several side by side ("1366x768,800x600": one virtual monitor each, left to right).
  VM=""; for m in $(echo "$MON" | tr ',' ' '); do VM="$VM --virtual-monitor $m"; done
  XDG_DATA_HOME="$ALLES_GS_WORK/data" gnome-shell --wayland --headless $VM >> "$ALLES_GS_WORK/gnome-shell.log" 2>&1 &
  GS=$!
  i=0; while [ $i -lt 100 ]; do [ -S "$XDG_RUNTIME_DIR/wayland-0" ] && break; sleep 0.2; i=$((i+1)); done
  # the probe answering means the Shell has finished starting
  i=0; while [ $i -lt 120 ]; do [ "$(gq '1+1')" = "2" ] && break; sleep 0.3; i=$((i+1)); done
  # GNOME 40+ starts on the Overview after login (a real person presses Esc or opens an app): leave it, so the desktop shows.
  # It can come up a second or two AFTER the Shell first answers, so one look is not enough (it once covered the screen edges for a
  # whole test run, and the pointer tests then "failed"): keep closing it until it has stayed closed for 4 seconds in a row.
  i=0; calm=0
  while [ $i -lt 80 ] && [ $calm -lt 8 ]; do
    if [ "$(gq 'Main.overview.visible')" = "false" ]; then calm=$((calm+1)); else calm=0; gq 'Main.overview.hide()' >/dev/null; fi
    sleep 0.5; i=$((i+1))
  done
  sleep 1
  if ! kill -0 $GS 2>/dev/null; then echo "GNOME Shell died while starting; its log: $ALLES_GS_WORK/gnome-shell.log"; tail -n 20 "$ALLES_GS_WORK/gnome-shell.log" | cut -c1-200; exit 7; fi
  export WAYLAND_DISPLAY=wayland-0 DISPLAY=:0 XDG_SESSION_TYPE=wayland
  # GNOME Shell starts XWayland with an access cookie. A real session hands it to every app; we hand it to the test.
  XA=$(ls -t "$XDG_RUNTIME_DIR"/.mutter-Xwaylandauth.* 2>/dev/null | head -n 1); [ -n "$XA" ] && export XAUTHORITY="$XA"
  "$@"
  RC=$?
  # Ask the Shell to quit, twice, then make it: after a screenshot it has been seen to ignore the first request, and `wait` would hang for ever.
  stop() { kill "$1" 2>/dev/null || return 0; n=0; while kill -0 "$1" 2>/dev/null && [ $n -lt 25 ]; do sleep 0.2; n=$((n+1)); done
           kill "$1" 2>/dev/null; n=0; while kill -0 "$1" 2>/dev/null && [ $n -lt 25 ]; do sleep 0.2; n=$((n+1)); done
           kill -9 "$1" 2>/dev/null; wait "$1" 2>/dev/null; }
  stop $GS
  if [ -n "$PW" ]; then stop $PW; fi
  exit $RC
fi

# ---- outer: a pretend system bus + login service, then re-run this script inside a private session ---------------
MON="${1:?usage: run.sh WIDTHxHEIGHT command [args...]}"; shift
PYTHON="${PYTHON:-/usr/bin/python3}"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/alles-gnome-XXXXXX")
export ALLES_GS_WORK="$WORK"
export XDG_RUNTIME_DIR="$WORK/run"; mkdir -p "$XDG_RUNTIME_DIR"; chmod 700 "$XDG_RUNTIME_DIR"
mkdir -p "$WORK/data/gnome-shell/extensions"; cp -r "$HERE/probe-extension/probe@alles" "$WORK/data/gnome-shell/extensions/"
unset DISPLAY WAYLAND_DISPLAY
ADDR="unix:abstract=alles-gs-sysbus-$$"
SYSPID=$(dbus-daemon --config-file=/usr/share/dbus-1/session.conf --address="$ADDR" --fork --print-pid)
export DBUS_SYSTEM_BUS_ADDRESS="$ADDR"
"$PYTHON" -m dbusmock --system -t logind > "$WORK/dbusmock.log" 2>&1 &
MOCK=$!
sleep 1
unshare -m sh -c 'mount -t tmpfs tmpfs /run/systemd; exec dbus-run-session -- "$0" --inner "$@"' "$HERE/run.sh" "$MON" "$@"
RC=$?
kill $MOCK 2>/dev/null; kill $SYSPID 2>/dev/null
if [ "${ALLES_E2E_KEEP:-}" = "1" ]; then echo "kept: $WORK"; else rm -rf "$WORK"; fi
exit $RC
