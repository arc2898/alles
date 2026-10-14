#!/usr/bin/env bash
set -Eeuo pipefail

# Apply Osmium OS identity and root-shell branding to a prepared root filesystem.
# Run on the build host as root; this does not enable remote or graphical root login.
ROOTFS="${ROOTFS:-$PWD/out/osmium-rootfs}"
OS_VERSION="${OS_VERSION:-0.1.0}"
CODENAME="${CODENAME:-forky}"
HOSTNAME_VALUE="${HOSTNAME_VALUE:-osmium}"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root (for example: sudo $0)." >&2
  exit 1
fi
if [[ ! -x "$ROOTFS/bin/sh" || ! -d "$ROOTFS/etc" ]]; then
  echo "Debian root filesystem not found at: $ROOTFS" >&2
  echo "Run scripts/bootstrap-rootfs.sh first or set ROOTFS=/path/to/rootfs." >&2
  exit 1
fi

install -d "$ROOTFS/etc" "$ROOTFS/etc/profile.d" "$ROOTFS/root"
printf '%s\n' "$HOSTNAME_VALUE" > "$ROOTFS/etc/hostname"
cat > "$ROOTFS/etc/hosts" <<EOF
127.0.0.1 localhost
127.0.1.1 $HOSTNAME_VALUE
::1 localhost ip6-localhost ip6-loopback
EOF

cat > "$ROOTFS/etc/os-release" <<EOF
NAME="Osmium"
PRETTY_NAME="Osmium $OS_VERSION (Debian $CODENAME)"
VERSION_ID="$OS_VERSION"
VERSION="$OS_VERSION ($CODENAME)"
VERSION_CODENAME="$CODENAME"
ID=osmium
ID_LIKE=debian
HOME_URL="https://github.com/arc2898/Osmiumos"
SUPPORT_URL="https://github.com/arc2898/Osmiumos/issues"
BUG_REPORT_URL="https://github.com/arc2898/Osmiumos/issues"
EOF

cat > "$ROOTFS/etc/issue" <<'EOF'
Osmium \\n \\l

EOF
cat > "$ROOTFS/etc/issue.net" <<'EOF'
Osmium
EOF
cat > "$ROOTFS/etc/motd" <<EOF
Welcome to Osmium $OS_VERSION
A Debian-based desktop operating system.
EOF

cat > "$ROOTFS/etc/profile.d/osmium-branding.sh" <<'EOF'
# Osmium shell identity
export OS_NAME="Osmium"
EOF
chmod 0644 "$ROOTFS/etc/profile.d/osmium-branding.sh"

# Give root's interactive Bash session an Osmium prompt without overwriting
# the rest of a user's existing root .bashrc.
ROOT_BASHRC="$ROOTFS/root/.bashrc"
touch "$ROOT_BASHRC"
if ! grep -q 'OSMIUM_ROOT_PROMPT' "$ROOT_BASHRC"; then
  cat >> "$ROOT_BASHRC" <<'EOF'

# OSMIUM_ROOT_PROMPT
if [ "$EUID" -eq 0 ]; then
  PS1='\[\e[1;36m\]osmium\[\e[0m\] \[\e[1;31m\]#\[\e[0m\] '
fi
EOF
fi

echo "Applied Osmium identity to: $ROOTFS"
echo "Hostname: $HOSTNAME_VALUE | Version: $OS_VERSION | Codename: $CODENAME"
echo "Root shell prompt branded; root auto-login has NOT been enabled."
