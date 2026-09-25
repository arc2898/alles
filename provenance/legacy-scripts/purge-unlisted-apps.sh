#!/usr/bin/env bash
set -Eeuo pipefail
T=/mnt/osmium
MODE=${1:---simulate}

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ -d "$T" ]] || fail 'Target is not mounted'

# These are the actual runtime components and requested applications. Keep
# them manual so apt autoremove can never treat them as orphaned.
keep=(
  gdm3 gnome-shell gnome-session gnome-session-bin
  gnome-session-common gnome-shell-common gnome-shell-extensions-common
  gnome-settings-daemon gnome-settings-daemon-common gnome-control-center
  gnome-software gnome-software-common gnome-software-plugin-deb
  gnome-software-plugin-fwupd
  nautilus eog gnome-terminal gnome-text-editor gnome-disk-utility gparted
  flatpak snapd nodejs npm
  gnome-shell-extension-user-theme gnome-shell-extension-blur-my-shell
  gnome-shell-extension-prefs gnome-shell-extension-dashtodock
  gnome-shell-extension-desktop-icons-ng
  gnome-shell-extension-system-monitor
  network-manager network-manager-gnome gnome-remote-desktop
  udisks2 fwupd accountsservice power-profiles-daemon
  hicolor-icon-theme adwaita-icon-theme
  fonts-dejavu fonts-dejavu-core fonts-dejavu-extra fonts-liberation
  fonts-noto-color-emoji fonts-symbola fonts-opensymbol
  xwayland xserver-common x11-xkb-utils x11-xserver-utils x11-common
)
for p in "${keep[@]}"; do
  chroot "$T" apt-mark manual "$p" >/dev/null 2>&1 || true
done

# User-facing packages to remove. The gnome/gnome-core/task entries are
# metapackages only; actual GDM, GNOME Shell, and session packages remain
# protected in keep[] above.
extras=(
  gnome
  gnome-core
  task-gnome-desktop
  firefox-esr
  baobab
  gnome-backgrounds
  gnome-calculator
  gnome-calendar
  gnome-clocks
  gnome-contacts
  gnome-font-viewer
  gnome-maps
  gnome-sound-recorder
  gnome-system-monitor
  gnome-tour
  gnome-tweaks
  gnome-weather
  loupe
  papers
  simple-scan
  totem
  totem-video-thumbnailer
  yelp
  yelp-xsl
)

# Add only installed Evolution/LibreOffice packages. Filtering by dpkg status
# avoids passing config-files-only package names to apt.
while IFS=$'\t' read -r p status; do
  [[ "$status" == 'install ok installed' ]] && extras+=("$p")
done < <(chroot "$T" dpkg-query -W -f='${binary:Package}\t${Status}\n' \
  'libreoffice*' 'evolution*' 2>/dev/null || true)

if [[ "$MODE" == '--simulate' ]]; then
  # Marking these automatic is reversible and is the prerequisite for a
  # constrained autoremove calculation.
  chroot "$T" apt-mark auto "${extras[@]}" >/dev/null 2>&1 || true
  printf '%s\n' '=== AUTOREMOVE SIMULATION ==='
  chroot "$T" apt-get -s autoremove --purge
elif [[ "$MODE" == '--execute' ]]; then
  chroot "$T" apt-mark auto "${extras[@]}" >/dev/null 2>&1 || true
  chroot "$T" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get -y autoremove --purge
  # A second pass catches dependencies orphaned by the first pass.
  chroot "$T" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get -y autoremove --purge
else
  fail 'Use --simulate or --execute'
fi
