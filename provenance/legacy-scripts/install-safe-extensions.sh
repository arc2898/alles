#!/usr/bin/env bash
set -Eeuo pipefail
T=/mnt/osmium
cleanup() { set +e; rm -f "$T/usr/sbin/policy-rc.d"; }
trap cleanup EXIT
cat > "$T/usr/sbin/policy-rc.d" <<'EOF'
#!/bin/sh
exit 101
EOF
chmod 755 "$T/usr/sbin/policy-rc.d"
chroot "$T" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get -y install \
  gnome-shell-extension-dashtodock \
  gnome-shell-extension-desktop-icons-ng \
  gnome-shell-extension-system-monitor
chroot "$T" glib-compile-schemas /usr/share/glib-2.0/schemas
printf 'GNOME 50-compatible extensions installed.\n'
