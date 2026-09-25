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
chroot "$T" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get -f install -y
chroot "$T" dpkg --configure -a
chroot "$T" /usr/bin/npm install --global pnpm
chroot "$T" /usr/bin/flatpak remote-add --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
chroot "$T" /usr/bin/flatpak install -y flathub com.mattjakeman.ExtensionManager io.github.realmazharhussain.GdmSettings
if chroot "$T" /usr/bin/snap list snap-store >/dev/null 2>&1; then
  printf 'Snap Store already installed.\n'
elif ! chroot "$T" /usr/bin/snap install snap-store; then
  printf 'WARNING: Snap Store needs snapd running after first boot.\n' >&2
fi
printf 'Requested application installation completed.\n'
