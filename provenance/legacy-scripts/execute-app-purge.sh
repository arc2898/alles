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
chroot "$T" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get -y purge \
  firefox-esr evolution libreoffice-core \
  gnome-backgrounds gnome-calculator gnome-calendar gnome-clocks \
  gnome-contacts gnome-font-viewer gnome-maps gnome-sound-recorder \
  gnome-system-monitor gnome-tour gnome-tweaks gnome-weather \
  loupe papers simple-scan totem-video-thumbnailer yelp yelp-xsl
printf 'Explicit unlisted application purge completed.\n'
