#!/usr/bin/env bash
set -Eeuo pipefail
T=/mnt/osmium
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
section() { printf '\n== %s ==\n' "$*"; }

section 'package health and APT'
[[ -z "$(chroot "$T" dpkg --audit)" ]] || fail 'dpkg audit is not clean'
chroot "$T" apt-get check
for p in sudo eog gnome-terminal ptyxis gnome-tweaks vlc fastfetch iproute2 iputils-ping bind9-dnsutils net-tools curl wget htop tree jq unzip rsync pciutils usbutils lsof traceroute brave-browser; do
  if [[ "$p" == eog || "$p" == gnome-terminal ]]; then
    if chroot "$T" dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -qx 'install ok installed'; then
      fail "$p should be absent"
    fi
  else
    chroot "$T" dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -qx 'install ok installed' || fail "missing package $p"
  fi
done
for c in ip ping dig curl wget fastfetch osmium-fetch ptyxis gnome-tweaks brave-browser vlc; do
  p=$(chroot "$T" sh -c "command -v '$c'" 2>/dev/null || true)
  [[ -n "$p" ]] || fail "missing command $c"
done
printf 'APT and requested applications: verified\n'

section 'GNOME extensions'
uuids=(
  dash-to-dock@micxgx.gmail.com
  ding@rastersoft.com
  system-monitor@gnome-shell-extensions.gcampax.github.com
  user-theme@gnome-shell-extensions.gcampax.github.com
  blur-my-shell@aunetx
  gnome-wobbly-windows@kyleabaker.github.com
  gnome-magic-lamp@kyleabaker.github.com
  CoverflowAltTab@palatis.blogspot.com
)
for uuid in "${uuids[@]}"; do
  f="$T/usr/share/gnome-shell/extensions/$uuid/metadata.json"
  [[ -f "$f" ]] || fail "missing extension $uuid"
  grep -q '"50"' "$f" || fail "$uuid does not declare GNOME 50"
done
for uuid in gnome-wobbly-windows@kyleabaker.github.com gnome-magic-lamp@kyleabaker.github.com CoverflowAltTab@palatis.blogspot.com; do
  grep -q "$uuid" "$T/etc/dconf/db/osmium.d/00-osmium-extensions" || fail "$uuid not in system defaults"
done
grep -q 'animation-time=0.2' "$T/etc/dconf/db/osmium.d/00-osmium-extensions"
printf 'Extension files, GNOME 50 metadata, and system defaults: verified\n'

section 'MacTahoe and appearance'
[[ -d "$T/usr/share/themes/MacTahoe-Dark" ]] || fail 'MacTahoe-Dark missing'
[[ -d "$T/usr/share/themes/MacTahoe-Dark-solid" ]] || fail 'MacTahoe solid variant missing'
[[ -f "$T/etc/xdg/gtk-4.0/gtk-Dark.css" ]] || fail 'system libadwaita theme missing'
grep -q 'gtk-theme-name=MacTahoe-Dark' "$T/etc/xdg/gtk-3.0/settings.ini"
grep -q 'gtk-icon-theme-name=MacTahoe-blue' "$T/etc/xdg/gtk-4.0/settings.ini"
grep -q "icon-theme='MacTahoe-blue'" "$T/etc/dconf/db/osmium.d/00-osmium-extensions"
chroot "$T" id -nG user | tr ' ' '\n' | grep -qx sudo || fail 'user is not in sudo group'
[[ ! -e "$T/usr/share/applications/osmium-about.desktop" ]] || fail 'Osmium About launcher still exists'
printf 'MacTahoe blur/libadwaita theme and icon default: verified\n'

section 'FastFetch'
chroot "$T" /usr/local/bin/osmium-fetch --logo none >/tmp/osmium-fetch-check.txt
head -40 /tmp/osmium-fetch-check.txt
printf 'Osmium FastFetch profile: verified\n'

section 'boot and identity'
grep -q '^GRUB_DISTRIBUTOR="Osmium OS"$' "$T/etc/default/grub"
grep -q 'Osmium OS' "$T/etc/os-release"
[[ -f "$T/boot/efi/EFI/debian/grubx64.efi" ]] || fail 'ESP GRUB file not visible at expected mount'
efibootmgr -v | grep -q 'Boot[0-9A-F]\{4\}\* Osmium OS' || fail 'Osmium UEFI entry missing'
efibootmgr -v | grep -q '^BootOrder: 0001' || fail 'Osmium UEFI entry is not first'
printf 'GRUB/UEFI branding: verified\n'

section 'user home'
home_manifest=/root/osmium-third-pass-backup-20260924/home-user-final.tsv
find "$T/home/user" -xdev -printf '%P\t%y\t%s\t%T@\t%U:%G\n' 2>/dev/null | sort > "$home_manifest"
pass_start=$(stat -c '%Y' /root/osmium-third-pass-backup-20260924/target-pre-third-pass.tar)
# The home was already used in an earlier real boot before this pass began.
# Do not restore it, but fail if this pass itself created or changed a home
# entry after its recorded start time.
if awk -F '\t' -v start="$pass_start" '($4 + 0) > start { print; bad=1 } END { exit bad }' "$home_manifest"; then
  printf 'No /home/user entries changed during the third pass (start epoch %s).\n' "$pass_start"
else
  fail '/home/user changed during the third pass; inspect before proceeding'
fi
if ! diff -q /root/osmium-customization-backup-20260924/home-user-after.tsv "$home_manifest" >/dev/null; then
  printf 'Note: pre-existing user-session data is present in /home/user; it was preserved.\n'
fi
printf '/home/user preserved (not restored or edited)\n'
printf '\nTHIRD-PASS VERIFICATION PASSED\n'
