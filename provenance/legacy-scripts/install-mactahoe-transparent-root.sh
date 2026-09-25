#!/usr/bin/env bash
set -Eeuo pipefail
T=/mnt/osmium
STAGE_REL=/tmp/osmium-assets/MacTahoe-gtk-theme-root
STAGE="$T$STAGE_REL"
cleanup() { set +e; rm -rf "$STAGE"; }
trap cleanup EXIT
rm -rf "$STAGE"
mkdir -p "$T/tmp/osmium-assets"
cp -a /root/osmium-assets/MacTahoe-gtk-theme-root "$STAGE"
chmod 755 "$STAGE/install.sh"
chroot "$T" /usr/bin/env -u SUDO_USER HOME=/root USER=root LOGNAME=root \
  "$STAGE_REL/install.sh" -l -b --dest /usr/share/themes --name MacTahoe --silent-mode
# The upstream helper installs this optional GUI; it is not part of the OS.
rm -f "$T/usr/local/bin/gnome-theme-switcher" \
      "$T/usr/share/applications/org.gnome.GTK4ThemeSwitcher.desktop"
chroot "$T" glib-compile-schemas /usr/share/glib-2.0/schemas
chroot "$T" dconf update
chroot "$T" gtk-update-icon-cache -f -t /usr/share/icons/MacTahoe-blue >/dev/null 2>&1 || true
printf 'MacTahoe root-safe transparent/blur theme installation completed.\n'
