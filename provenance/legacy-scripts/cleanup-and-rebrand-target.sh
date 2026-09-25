#!/usr/bin/env bash
set -Eeuo pipefail
T=/mnt/osmium
MODE=${1:---simulate}

# Keep Ptyxis as the one terminal; remove the duplicate GNOME Terminal and EOG.
for p in ptyxis gnome-tweaks vlc fastfetch iproute2 iputils-ping dnsutils net-tools curl wget htop tree jq unzip rsync pciutils usbutils lsof traceroute brave-browser sudo; do
  chroot "$T" apt-mark manual "$p" >/dev/null 2>&1 || true
done
if [[ "$MODE" == '--simulate' ]]; then
  chroot "$T" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get -s purge eog gnome-terminal
  exit 0
fi
chroot "$T" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get -y purge eog gnome-terminal
chroot "$T" apt-get clean

# Remove only the extra Osmium About launcher; keep the OS identity/GRUB branding.
rm -f "$T/usr/share/applications/osmium-about.desktop" "$T/usr/share/pixmaps/osmium-logo.svg"
chroot "$T" update-desktop-database /usr/share/applications 2>/dev/null || true

# Make the GRUB menu identify the distribution as Osmium OS.
if grep -q '^GRUB_DISTRIBUTOR=' "$T/etc/default/grub"; then
  sed -i 's/^GRUB_DISTRIBUTOR=.*/GRUB_DISTRIBUTOR="Osmium OS"/' "$T/etc/default/grub"
else
  printf '\nGRUB_DISTRIBUTOR="Osmium OS"\n' >> "$T/etc/default/grub"
fi
chroot "$T" update-grub

# Ensure the modern terminal is the system default.
mkdir -p "$T/etc/dconf/db/osmium.d"
if ! grep -q '^\[org/gnome/desktop/applications/terminal\]$' "$T/etc/dconf/db/osmium.d/00-osmium-extensions"; then
  cat >> "$T/etc/dconf/db/osmium.d/00-osmium-extensions" <<'EOF'

[org/gnome/desktop/applications/terminal]
exec='ptyxis'
exec-arg='--'
EOF
fi
chroot "$T" dconf update
printf 'EOG/terminal cleanup, launcher removal, and GRUB rebranding completed.\n'
