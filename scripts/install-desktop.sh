#!/usr/bin/env bash
set -Eeuo pipefail

# Install the GNOME 50.2 desktop and GDM3 from a consistent Debian snapshot.
# Run as root on the build host. ROOTFS defaults to the bootstrap script output.
ROOTFS="${ROOTFS:-$PWD/out/osmium-rootfs}"
SNAPSHOT="${SNAPSHOT:-20260615T000000Z}"
GNOME_SHELL_VERSION="${GNOME_SHELL_VERSION:-50.2-3}"
GDM3_VERSION="${GDM3_VERSION:-50.2-1}"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root (for example: sudo $0)." >&2
  exit 1
fi
if [[ ! -x "$ROOTFS/bin/sh" ]]; then
  echo "Debian root filesystem not found at: $ROOTFS" >&2
  echo "Run scripts/bootstrap-rootfs.sh first, or set ROOTFS=/path/to/rootfs." >&2
  exit 1
fi

# Use a dated snapshot only for this installation, so dependencies resolve
# against the same archive state instead of mixing with newer Forky packages.
SOURCE_LIST="$ROOTFS/tmp/osmium-snapshot.list"
cat > "$SOURCE_LIST" <<EOF
deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/$SNAPSHOT/ forky main
EOF

cleanup() {
  rm -f "$SOURCE_LIST"
}
trap cleanup EXIT

chroot "$ROOTFS" apt-get \
  -o Dir::Etc::sourcelist=/tmp/osmium-snapshot.list \
  -o Dir::Etc::sourceparts=- \
  -o APT::Get::List-Cleanup=0 \
  update

# Install the requested versions explicitly. If either version is absent from
# the chosen snapshot, apt fails rather than silently installing another GNOME.
chroot "$ROOTFS" env DEBIAN_FRONTEND=noninteractive apt-get install -y \
  -o Dir::Etc::sourcelist=/tmp/osmium-snapshot.list \
  -o Dir::Etc::sourceparts=- \
  -o APT::Get::List-Cleanup=0 \
  "gnome-shell=$GNOME_SHELL_VERSION" \
  "gdm3=$GDM3_VERSION" \
  gnome-session gnome-control-center gnome-terminal network-manager

# Prefer GDM for the graphical login screen.
chroot "$ROOTFS" bash -c 'printf "gdm3 shared/default-x-display-manager select gdm3\n" | debconf-set-selections'
chroot "$ROOTFS" bash -c 'if command -v systemctl >/dev/null 2>&1; then systemctl enable gdm3; fi' || true

echo "Installed GNOME Shell $GNOME_SHELL_VERSION and GDM3 $GDM3_VERSION in:"
echo "  $ROOTFS"
echo "This adds the desktop to the root filesystem; ISO creation is a separate step."
