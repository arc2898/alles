#!/usr/bin/env bash
set -Eeuo pipefail

# Build a minimal Debian 14 (Forky) root filesystem for Osmium OS.
# Run this on a Debian/Ubuntu Linux build host as root.
SUITE="${SUITE:-forky}"
ARCH="${ARCH:-amd64}"
MIRROR="${MIRROR:-https://deb.debian.org/debian}"
TARGET="${TARGET:-$PWD/out/osmium-rootfs}"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root (for example: sudo $0)." >&2
  exit 1
fi
if ! command -v debootstrap >/dev/null 2>&1; then
  echo "Missing debootstrap. Install it with: apt-get install debootstrap" >&2
  exit 1
fi
if [[ -e "$TARGET" ]] && [[ -n "$(find "$TARGET" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
  echo "Target is not empty: $TARGET" >&2
  echo "Choose another TARGET or empty it yourself; this script will not delete existing files." >&2
  exit 1
fi

mkdir -p "$TARGET"
debootstrap --arch="$ARCH" --variant=minbase "$SUITE" "$TARGET" "$MIRROR"

cat <<EOF
Minimal Debian $SUITE ($ARCH) root filesystem created at:
  $TARGET

This is a base root filesystem, not a bootable ISO yet.
Next steps: configure hostname/network/apt, install Osmium OS packages
(GNOME, themes, icons, Calamares), then build and test an installer image.
EOF
