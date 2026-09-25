#!/usr/bin/env bash
set -Eeuo pipefail
T=/mnt/osmium
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
section() { printf '\n== %s ==\n' "$*"; }

section 'package health'
audit=$(chroot "$T" dpkg --audit)
[[ -z "$audit" ]] || { printf '%s\n' "$audit"; fail 'dpkg audit is not clean'; }
chroot "$T" apt-get check
printf 'dpkg audit: clean\n'

section 'requested commands'
for c in gnome-control-center gnome-software eog nautilus gnome-terminal \
  gnome-text-editor gnome-disks gparted flatpak snap node npm pnpm \
  gnome-extensions-app; do
  path=$(chroot "$T" sh -c "command -v '$c'" 2>/dev/null || true)
  [[ -n "$path" ]] || fail "missing command: $c"
  printf '%-28s %s\n' "$c" "$path"
done
printf 'node %s\n' "$(chroot "$T" node --version)"
printf 'npm %s\n' "$(chroot "$T" npm --version)"
printf 'pnpm %s\n' "$(chroot "$T" pnpm --version)"

section 'requested packages and GNOME runtime'
for p in gdm3 gnome-shell gnome-session gnome-control-center gnome-software \
  nautilus eog gnome-terminal gnome-text-editor gnome-disk-utility gparted \
  flatpak snapd nodejs npm \
  gnome-shell-extension-dashtodock \
  gnome-shell-extension-desktop-icons-ng \
  gnome-shell-extension-system-monitor \
  gnome-shell-extension-user-theme \
  gnome-shell-extension-blur-my-shell; do
  chroot "$T" dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -qx 'install ok installed' \
    || fail "missing installed package: $p"
done
for p in firefox-esr evolution libreoffice-core gnome-backgrounds \
  gnome-calculator gnome-calendar gnome-clocks gnome-contacts \
  gnome-maps gnome-system-monitor gnome-tour gnome-tweaks gnome-weather \
  loupe papers simple-scan yelp; do
  if chroot "$T" dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -qx 'install ok installed'; then
    fail "unlisted package still installed: $p"
  fi
done
printf 'GNOME runtime and requested package set: verified\n'

section 'extensions and system-wide defaults'
for uuid in \
  dash-to-dock@micxgx.gmail.com \
  ding@rastersoft.com \
  system-monitor@gnome-shell-extensions.gcampax.github.com \
  user-theme@gnome-shell-extensions.gcampax.github.com \
  blur-my-shell@aunetx; do
  [[ -f "$T/usr/share/gnome-shell/extensions/$uuid/metadata.json" ]] \
    || fail "missing extension: $uuid"
done
grep -q 'dash-to-dock@micxgx.gmail.com' "$T/etc/dconf/db/osmium.d/00-osmium-extensions"
grep -q 'ding@rastersoft.com' "$T/etc/dconf/db/osmium.d/00-osmium-extensions"
grep -q 'system-monitor@gnome-shell-extensions.gcampax.github.com' "$T/etc/dconf/db/osmium.d/00-osmium-extensions"
grep -q 'user-theme@gnome-shell-extensions.gcampax.github.com' "$T/etc/dconf/db/osmium.d/00-osmium-extensions"
grep -q 'blur-my-shell@aunetx' "$T/etc/dconf/db/osmium.d/00-osmium-extensions"
grep -q 'animation-time=0.2' "$T/etc/dconf/db/osmium.d/00-osmium-extensions"
printf 'Extension files and system-wide defaults: verified\n'

section 'GNOME/Flatpak applications'
chroot "$T" flatpak remotes --columns=name,url
apps=$(chroot "$T" flatpak list --app --columns=application 2>/dev/null || true)
printf '%s\n' "$apps"
grep -qx 'com.mattjakeman.ExtensionManager' <<<"$apps" || fail 'Extension Manager Flatpak missing'
grep -qx 'io.github.realmazharhussain.GdmSettings' <<<"$apps" || fail 'GDM Settings Flatpak missing'

section 'MacTahoe assets'
[[ -d "$T/usr/share/themes/MacTahoe-Dark" ]] || fail 'MacTahoe GTK theme missing'
[[ -d "$T/usr/share/icons/MacTahoe-blue" ]] || fail 'MacTahoe icon theme missing'
[[ -d "$T/usr/share/icons/hicolor" ]] || fail 'required hicolor fallback missing'
[[ -d "$T/usr/share/icons/.\$lost" ]] || fail 'requested icons/.$lost quarantine missing'
[[ -d "$T/usr/share/backgrounds/osmium" ]] || fail 'Osmium wallpaper directory missing'
[[ -f "$T/usr/share/gnome-shell/gnome-shell-theme.gresource" ]] || fail 'GDM shell resource missing'
[[ ! -e "$T/usr/share/gnome-shell/gnome-shell-theme.gresource.bak" ]] || fail 'old shell resource backup is still active'
mapfile -t active_themes < <(find "$T/usr/share/themes" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%f\n' | sort)
((${#active_themes[@]} > 0)) || fail 'no active GTK themes'
for t in "${active_themes[@]}"; do [[ "$t" == MacTahoe* ]] || fail "old active GTK theme: $t"; done
mapfile -t active_icons < <(find "$T/usr/share/icons" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%f\n' | sort)
for i in "${active_icons[@]}"; do
  case "$i" in MacTahoe*|hicolor|breeze) ;; *) fail "old active icon theme: $i";; esac
done
mapfile -t active_backgrounds < <(find "$T/usr/share/backgrounds" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%f\n' | sort)
for b in "${active_backgrounds[@]}"; do [[ "$b" == osmium ]] || fail "old active wallpaper directory: $b"; done
wallpapers=$(find "$T/usr/share/backgrounds/osmium" -maxdepth 1 -type f -name '*.png' | wc -l)
[[ "$wallpapers" -eq 2 ]] || fail "expected 2 Osmium wallpapers, found $wallpapers"
chroot "$T" xmllint --noout /usr/share/backgrounds/osmium.xml
printf 'Active themes: %s\n' "${active_themes[*]}"
printf 'Active icons: %s\n' "${active_icons[*]}"
printf 'Active wallpapers: osmium (%s files)\n' "$wallpapers"
printf 'Quarantine: /usr/share/icons/.$lost\n'

section 'branding, GDM, and bootloader files'
grep -q '^NAME="Osmium OS"' "$T/etc/os-release"
grep -q 'GRUB_THEME=.*/boot/grub/themes/whitesur/theme.txt' "$T/etc/default/grub"
grep -q '/boot/grub/themes/whitesur/theme.txt' "$T/boot/grub/grub.cfg"
[[ -f "$T/boot/efi/EFI/debian/grubx64.efi" ]] || fail 'GRUB EFI file missing'
grep -q 'MacTahoe-Dark' "$T/etc/xdg/gtk-3.0/settings.ini"
grep -q 'MacTahoe-blue' "$T/etc/xdg/gtk-4.0/settings.ini"
printf 'Branding, MacTahoe GTK settings, Whitesur GRUB, and EFI file: verified\n'

section 'Snap Store'
[[ -x "$T/usr/local/sbin/osmium-install-snap-store" ]] || fail 'Snap Store first-boot helper missing'
grep -q 'snap install core' "$T/usr/local/sbin/osmium-install-snap-store"
grep -q 'snap set core experimental.user-daemons=true' "$T/usr/local/sbin/osmium-install-snap-store"
grep -q 'snap install snap-store' "$T/usr/local/sbin/osmium-install-snap-store"
[[ -f "$T/etc/systemd/system/osmium-snap-store-install.service" ]] || fail 'Snap Store first-boot unit missing'
if compgen -G "$T/var/lib/snapd/snaps/snap-store_*.snap" >/dev/null; then
  printf 'Snap Store snap file present.\n'
else
  printf 'PENDING: Snap Store snap file not present; the enabled first-boot helper will install it after reboot.\n'
fi

printf '\nFINAL TARGET VERIFICATION PASSED (except any explicitly marked pending item).\n'
