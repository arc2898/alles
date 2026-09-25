#!/usr/bin/env bash
set -Eeuo pipefail
T=/mnt/osmium
SNAPD_PID=
cleanup() {
  set +e
  if [[ -n "${SNAPD_PID:-}" ]] && kill -0 "$SNAPD_PID" 2>/dev/null; then
    kill "$SNAPD_PID" 2>/dev/null || true
    wait "$SNAPD_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ -x "$T/usr/lib/snapd/snapd" ]] || fail 'Target snapd binary is missing'

# The parent service namespace exposes the host snapd socket under /run.
# Run this script in a nested private mount namespace and replace only the
# target's /run so the target snapd cannot talk to the host daemon.
mount --make-rprivate /
umount -R "$T/run" 2>/dev/null || true
mount -t tmpfs -o mode=755,nosuid,nodev tmpfs "$T/run"
mkdir -p "$T/run/snapd" "$T/run/snapd/lock" "$T/run/systemd" "$T/var/log"

chroot "$T" /usr/lib/snapd/snapd --debug >"$T/var/log/snapd-isolated.log" 2>&1 &
SNAPD_PID=$!
for _ in $(seq 1 60); do
  [[ -S "$T/run/snapd.socket" ]] && break
  kill -0 "$SNAPD_PID" 2>/dev/null || {
    cat "$T/var/log/snapd-isolated.log" >&2
    fail 'Target snapd exited before creating its socket'
  }
  sleep 0.5
done
[[ -S "$T/run/snapd.socket" ]] || {
  cat "$T/var/log/snapd-isolated.log" >&2
  fail 'Timed out waiting for target snapd socket'
}

echo 'Target snapd is isolated and running.'
chroot "$T" snap version

# Seed snapd before changing system configuration. This is required on a
# freshly installed target and is still done against the isolated daemon.
if ! chroot "$T" snap list core >/dev/null 2>&1; then
  chroot "$T" snap install core
fi
# snap-store is a daemon snap; enable the snapd feature explicitly.
chroot "$T" snap set system experimental.user-daemons=true
chroot "$T" snap install snap-store
chroot "$T" snap list
printf 'Snap Store installed in the target system.\n'
