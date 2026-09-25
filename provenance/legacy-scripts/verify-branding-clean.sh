#!/usr/bin/env bash
set -Eeuo pipefail
T=/mnt/osmium
B=/root/osmium-branding-backup-20260925
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
section() { printf '\n== %s ==\n' "$*"; }

section 'target identity and package health'
[[ "$(blkid -s LABEL -o value /dev/sda2)" == osmium-root ]] || fail 'wrong target root'
[[ "$(blkid -s LABEL -o value /dev/sda4)" == OSMIUMESP ]] || fail 'wrong target ESP'
audit=$(chroot "$T" dpkg --audit)
[[ -z "$audit" ]] || fail 'dpkg audit is not clean'
chroot "$T" apt-get check >/dev/null
chroot "$T" apt-get -s autoremove --purge | grep -q '0 upgraded, 0 newly installed, 0 to remove' || fail 'orphaned packages remain'
# APT regenerates its binary indexes during the checks above; drop them again.
rm -f "$T/var/cache/apt/pkgcache.bin" "$T/var/cache/apt/srcpkgcache.bin"
for p in adwaita-icon-theme hicolor-icon-theme breeze-icon-theme; do
  chroot "$T" dpkg-query -W -f='${Status}' "$p" | grep -qx 'install ok installed' || fail "missing $p"
done
verify=$(chroot "$T" dpkg --verify adwaita-icon-theme hicolor-icon-theme breeze-icon-theme 2>&1 || true)
[[ -z "$verify" ]] || { printf '%s\n' "$verify"; fail 'fallback icon files incomplete'; }
printf '%s\n' 'Target and packages: verified'

section 'MacTahoe roles and caches'
for f in "$T/etc/xdg/gtk-3.0/settings.ini" "$T/etc/xdg/gtk-4.0/settings.ini"; do
  grep -q '^gtk-theme-name=MacTahoe-Dark$' "$f" || fail "GTK role wrong in $f"
  grep -q '^gtk-icon-theme-name=MacTahoe-dark$' "$f" || fail "icon role wrong in $f"
  grep -q '^gtk-cursor-theme-name=MacTahoe$' "$f" || fail "cursor role wrong in $f"
done
[[ -f "$T/usr/share/themes/MacTahoe-Dark/gnome-shell/gnome-shell.css" ]] || fail 'shell assets missing'
[[ -f "$T/usr/share/icons/MacTahoe-dark/icon-theme.cache" ]] || fail 'MacTahoe-dark cache missing'
readlink -f "$T/etc/alternatives/x-cursor-theme" | grep -q '/MacTahoe/cursor.theme$' || fail 'Xcursor is not MacTahoe'
printf '%s\n' 'GTK MacTahoe-Dark / icons MacTahoe-dark / cursor MacTahoe: verified'

section 'extensions removed and disabled'
[[ -z "$(find "$T/usr/share/gnome-shell/extensions" -mindepth 1 -maxdepth 1 -type d -print -quit 2>/dev/null)" ]] || fail 'extension dir remains'
pkgs=$(chroot "$T" dpkg-query -W -f='${Package}\t${Status}\n' 'gnome-shell-extension-*' 'gnome-shell-extensions-common' 2>/dev/null || true)
if printf '%s\n' "$pkgs" | grep -q 'install ok installed'; then printf '%s\n' "$pkgs" | grep 'install ok installed' >&2; fail 'extension package remains'; fi
[[ "$(chroot "$T" gsettings get org.gnome.shell enabled-extensions 2>/dev/null)" == '@as []' ]] || fail 'extensions enabled'
[[ "$(chroot "$T" gsettings get org.gnome.shell disable-user-extensions 2>/dev/null)" == true ]] || fail 'user extensions not disabled'
printf '%s\n' 'Extensions: removed and disabled'

section 'Osmium vendor logos and GDM login logo'
V="$T/usr/share/osmium/vendor-logos"
for f in logo.svg logo-text.svg logo-64.png logo-128.png logo-256.png logo-text-64.png logo-text-128.png logo-text-256.png; do
  [[ -f "$V/$f" ]] || fail "missing vendor logo $f"
done
chroot "$T" update-alternatives --query vendor-logos | grep -q '^Value: /usr/share/osmium/vendor-logos$' || fail 'vendor-logos alternative is not Osmium'
logo=$(chroot "$T" readlink -f /usr/share/images/vendor-logos/logo-text-version-64.png)
[[ "$logo" == '/usr/share/osmium/vendor-logos/logo-text-64.png' ]] || fail "GDM logo resolves to $logo"
chroot "$T" magick /usr/share/osmium/vendor-logos/logo-text-64.png -format '%wx%h' info: | grep -q '256x64' || fail 'GDM logo has wrong size'
! chroot "$T" readlink -f /usr/share/images/vendor-logos/logo-text-version-64.png | grep -q 'debian-logos' || fail 'GDM logo still Debian'
printf '%s\n' 'GDM login logo is Osmium (256x64, no Debian): verified'

section 'GDM background is Osmium wallpaper'
chroot "$T" gresource extract /usr/share/gnome-shell/gnome-shell-theme.gresource /org/gnome/shell/theme/background.png > /tmp/opencode/gdm-bg-verify.png 2>/dev/null
[[ "$(sha256sum /tmp/opencode/gdm-bg-verify.png | cut -d' ' -f1)" == "$(sha256sum "$T/usr/share/backgrounds/osmium/macos-27-golden-4480x3088-26625.png" | cut -d' ' -f1)" ]] || fail 'GDM background is not the Osmium wallpaper'
rm -f /tmp/opencode/gdm-bg-verify.png
printf '%s\n' 'GDM background matches Osmium wallpaper: verified'

section 'FastFetch branding'
grep -q '"type": "file"' "$T/usr/share/osmium/fastfetch/osmium.jsonc" || fail 'fastfetch logo type is not file'
[[ -f "$T/usr/share/osmium/fastfetch/osmium-os-logo.txt" ]] || fail 'fastfetch logo file missing'
out=$(chroot "$T" /usr/local/bin/osmium-fetch 2>&1)
if grep -q 'JsonConfig Error' <<< "$out"; then printf '%s\n' "$out" >&2; fail 'fastfetch config error'; fi
grep -q 'O S M I U M   O S' <<< "$out" || fail 'fastfetch output lacks OSMIUM OS badge'
grep -q 'OS: Osmium OS' <<< "$out" || fail 'fastfetch OS line wrong'
printf '%s\n' 'FastFetch badge and profile: verified'

section 'wallpapers and GRUB/UEFI'
mapfile -t catalog < <(find "$T/usr/share/gnome-background-properties" -maxdepth 1 -type f -printf '%f\n' | sort)
[[ "${#catalog[@]}" -eq 1 && "${catalog[0]}" == osmium.xml ]] || fail "wallpaper catalog: ${catalog[*]}"
grep -q '^GRUB_DISTRIBUTOR="Osmium OS"$' "$T/etc/default/grub"
grep -q 'background_image "/boot/grub/themes/whitesur/background.jpg"' "$T/boot/grub/grub.cfg"
efibootmgr -v | grep -q 'Boot[0-9A-F]\{4\}\* Osmium OS'
efibootmgr -v | grep -q '^BootOrder: 0001'
! efibootmgr -v | grep -q 'Debian 14 GNOME 50' || fail 'stale Debian UEFI label'
printf '%s\n' 'Wallpapers, GRUB, UEFI: verified'

section 'fresh-system cleanliness'
# Verification itself (magick/fontconfig as root) recreates these; drop them last.
rm -rf "$T/root/.npm" "$T/root/.cache"
[[ "$(du -sb "$T/var/cache/apt" | cut -f1)" -lt 2000000 ]] || fail 'APT cache not clean'
[[ ! -e "$T/root/.npm" && ! -e "$T/root/.cache" ]] || fail 'root caches remain'
[[ -z "$(find "$T/tmp" -mindepth 1 -maxdepth 1 ! -name '.font-unix' ! -name '.ICE-unix' ! -name '.XIM-unix' ! -name '.X11-unix' -print -quit 2>/dev/null)" ]] || fail 'stray tmp files remain'
printf '%s\n' 'Caches and tmp: clean'

section 'home preservation'
find "$T/home/user" -xdev -printf '%P\t%y\t%s\t%T@\t%U:%G\n' 2>/dev/null | sort > "$B/home-user-after.tsv"
cmp -s "$B/home-user-before.tsv" "$B/home-user-after.tsv" || fail '/home/user changed'
printf '%s\n' '/home/user unchanged'
printf '\nBRANDING AND CLEAN VERIFICATION PASSED\n'
