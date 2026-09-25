#!/usr/bin/env bash
set -Eeuo pipefail
T=/mnt/osmium
install -d "$T/usr/share/osmium/fastfetch" "$T/usr/local/bin" "$T/etc/skel/.config/fastfetch" "$T/usr/share/pixmaps"
install -m 0644 /root/osmium-assets/osmium-fastfetch.jsonc "$T/usr/share/osmium/fastfetch/osmium.jsonc"
install -m 0644 /root/osmium-assets/osmium-os-logo.svg "$T/usr/share/pixmaps/osmium-os-logo.svg"
install -m 0644 /root/osmium-assets/osmium-os-fastfetch-logo.txt "$T/usr/share/osmium/fastfetch/osmium-os-logo.txt"
install -m 0644 /root/osmium-assets/osmium-fastfetch.jsonc "$T/etc/skel/.config/fastfetch/config.jsonc"
install -m 0755 /root/osmium-assets/osmium-fastfetch-wrapper "$T/usr/local/bin/fastfetch"
ln -sfn fastfetch "$T/usr/local/bin/osmium-fetch"
printf 'Osmium FastFetch profile and wrappers installed.\n'
