#!/usr/bin/env bash
set -Eeuo pipefail
T=/mnt/osmium
B=/root/osmium-user-fix-backup-20260925
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
section() { printf '\n== %s ==\n' "$*"; }

section 'target identity and package health'
[[ "$(blkid -s LABEL -o value /dev/sda2)" == osmium-root ]] || fail 'wrong target root'
[[ "$(blkid -s LABEL -o value /dev/sda4)" == OSMIUMESP ]] || fail 'wrong target ESP'
audit=$(chroot "$T" dpkg --audit)
[[ -z "$audit" ]] || fail 'dpkg audit is not clean'
chroot "$T" apt-get check >/dev/null
for p in adwaita-icon-theme hicolor-icon-theme breeze-icon-theme; do
  chroot "$T" dpkg-query -W -f='${Status}' "$p" | grep -qx 'install ok installed' || fail "missing $p"
done
verify=$(chroot "$T" dpkg --verify adwaita-icon-theme hicolor-icon-theme breeze-icon-theme 2>&1 || true)
[[ -z "$verify" ]] || { printf '%s\n' "$verify"; fail 'fallback icon package files are incomplete'; }
printf '%s\n' 'Target and package health: verified'

section 'MacTahoe role settings and assets'
for f in "$T/etc/xdg/gtk-3.0/settings.ini" "$T/etc/xdg/gtk-4.0/settings.ini" "$T/etc/skel/.config/gtk-3.0/settings.ini" "$T/etc/skel/.config/gtk-4.0/settings.ini"; do
  grep -q '^gtk-theme-name=MacTahoe-Dark$' "$f" || fail "MacTahoe-Dark missing in $f"
  grep -q '^gtk-icon-theme-name=MacTahoe-dark$' "$f" || fail "MacTahoe-dark missing in $f"
  grep -q '^gtk-cursor-theme-name=MacTahoe$' "$f" || fail "MacTahoe cursor missing in $f"
done
[[ -f "$T/usr/share/themes/MacTahoe-Dark/gnome-shell/gnome-shell.css" ]] || fail 'MacTahoe shell assets missing'
[[ -f "$T/usr/share/icons/MacTahoe-dark/icon-theme.cache" ]] || fail 'MacTahoe-dark icon cache missing'
[[ -f "$T/usr/share/icons/MacTahoe/icon-theme.cache" ]] || fail 'MacTahoe icon cache missing'
readlink -f "$T/etc/alternatives/x-cursor-theme" | grep -q '/MacTahoe/cursor.theme$' || fail 'Xcursor alternative is not MacTahoe'
for key_value in \
  "gtk-theme='MacTahoe-Dark'" \
  "icon-theme='MacTahoe-dark'" \
  "cursor-theme='MacTahoe'"; do
  key=${key_value%%=*}; value=${key_value#*=}
  got=$(chroot "$T" gsettings get org.gnome.desktop.interface "$key" 2>/dev/null)
  [[ "$got" == "$value" ]] || fail "$key is $got, expected $value"
done
printf '%s\n' 'GTK/legacy: MacTahoe-Dark; icons: MacTahoe-dark; cursor: MacTahoe; shell assets: MacTahoe-Dark'

section 'GNOME extension removal'
[[ -z "$(find "$T/usr/share/gnome-shell/extensions" -mindepth 1 -maxdepth 1 -type d -print -quit 2>/dev/null)" ]] || fail 'extension directory remains'
packages=$(chroot "$T" dpkg-query -W -f='${Package}\t${Status}\n' 'gnome-shell-extension-*' 'gnome-shell-extensions-common' 2>/dev/null || true)
if printf '%s\n' "$packages" | grep -q 'install ok installed'; then
  printf '%s\n' "$packages" | grep 'install ok installed' >&2
  fail 'installed GNOME extension package remains'
fi
residual=$(grep -R --binary-files=without-match -n -E 'blur-my-shell|CoverflowAltTab|dash2dock-lite|gnome-magic-lamp|gnome-wobbly-windows|system-monitor@|ding@rastersoft|user-theme@|dash-to-dock@' "$T/etc" "$T/usr/share/glib-2.0/schemas" 2>/dev/null || true)
[[ -z "$residual" ]] || { printf '%s\n' "$residual"; fail 'stale extension reference remains'; }
enabled=$(chroot "$T" gsettings get org.gnome.shell enabled-extensions 2>/dev/null)
disabled=$(chroot "$T" gsettings get org.gnome.shell disable-user-extensions 2>/dev/null)
[[ "$enabled" == '@as []' ]] || fail "enabled extensions are $enabled"
[[ "$disabled" == true ]] || fail "disable-user-extensions is $disabled"
printf '%s\n' 'All extension packages/directories removed; autoload disabled'

section 'wallpaper catalog and alternatives'
mapfile -t catalog < <(find "$T/usr/share/gnome-background-properties" -maxdepth 1 -type f -printf '%f\n' | sort)
[[ "${#catalog[@]}" -eq 1 && "${catalog[0]}" == osmium.xml ]] || fail "unexpected wallpaper catalog: ${catalog[*]}"
chroot "$T" xmllint --noout /usr/share/gnome-background-properties/osmium.xml /usr/share/backgrounds/osmium.xml
chroot "$T" readlink -f /usr/share/images/desktop-base/desktop-background | grep -q '/backgrounds/osmium/' || fail 'desktop background alternative is not Osmium'
chroot "$T" readlink -f /usr/share/images/desktop-base/desktop-background.xml | grep -q '/backgrounds/osmium.xml' || fail 'background XML alternative is not Osmium'
chroot "$T" readlink -f /usr/share/images/desktop-base/desktop-lockscreen.xml | grep -q '/backgrounds/osmium.xml' || fail 'lockscreen alternative is not Osmium'
printf '%s\n' 'Only Osmium wallpapers are exposed'

section 'GNOME commands and boot'
chroot "$T" gnome-shell --version
chroot "$T" gnome-tweaks --version
chroot "$T" gnome-control-center --version
grep -q '^GRUB_DISTRIBUTOR="Osmium OS"$' "$T/etc/default/grub"
grep -q '^GRUB_BACKGROUND="/boot/grub/themes/whitesur/background.jpg"$' "$T/etc/default/grub"
grep -q 'background_image "/boot/grub/themes/whitesur/background.jpg"' "$T/boot/grub/grub.cfg"
efibootmgr -v | grep -q 'Boot[0-9A-F]\{4\}\* Osmium OS'
efibootmgr -v | grep -q '^BootOrder: 0001'
printf '%s\n' 'GNOME, GRUB, and UEFI: verified'

section 'home preservation'
find "$T/home/user" -xdev -printf '%P\t%y\t%s\t%T@\t%U:%G\n' 2>/dev/null | sort > "$B/home-user-after.tsv"
cmp -s "$B/home-user-before.tsv" "$B/home-user-after.tsv" || fail '/home/user changed'
printf '%s\n' '/home/user unchanged'
printf '\nTHEME/EXTENSION CLEANUP VERIFICATION PASSED\n'
