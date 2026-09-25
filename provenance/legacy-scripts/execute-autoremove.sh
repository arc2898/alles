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
for pass in 1 2 3; do
  printf '=== AUTOREMOVE PASS %s ===\n' "$pass"
  chroot "$T" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get -y autoremove --purge
  chroot "$T" dpkg --audit
 done
chroot "$T" apt-get clean
printf 'Autoremove and package-cache cleanup completed.\n'
