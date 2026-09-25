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

# USB tethering is IPv4 in this environment; make APT deterministic.
cat > "$T/etc/apt/apt.conf.d/80osmium-network" <<'EOF'
Acquire::Retries "3";
Acquire::ForceIPv4 "true";
EOF

chroot "$T" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get -f install -y
chroot "$T" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get install -y \
  sudo gnome-tweaks vlc fastfetch \
  iproute2 iputils-ping dnsutils net-tools curl wget htop tree jq unzip rsync \
  pciutils usbutils lsof traceroute

install -d "$T/etc/apt/keyrings"
install -m 0644 /tmp/opencode/brave-key.gpg "$T/etc/apt/keyrings/brave-browser-archive-keyring.gpg"
cat > "$T/etc/apt/sources.list.d/brave-browser-release.list" <<'EOF'
deb [arch=amd64 signed-by=/etc/apt/keyrings/brave-browser-archive-keyring.gpg] https://brave-browser-apt-release.s3.brave.com/ stable main
EOF
chroot "$T" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 update
chroot "$T" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get install -y brave-browser
chroot "$T" apt-get clean
printf 'Standard tools, GNOME Tweaks, VLC, and Brave installed.\n'
