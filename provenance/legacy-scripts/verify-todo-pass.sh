#!/usr/bin/env bash
set -Eeuo pipefail
T=/mnt/osmium
B=/root/osmium-todo-backup-20260925
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
section() { printf '\n== %s ==\n' "$*"; }

section 'package and command health'
audit=$(chroot "$T" dpkg --audit)
[[ -z "$audit" ]] || fail 'dpkg audit is not clean'
chroot "$T" apt-get check >/dev/null
# apt may regenerate its binary indexes during the health check; keep the
# finished system clean after the check.
rm -f "$T/var/cache/apt/pkgcache.bin" "$T/var/cache/apt/srcpkgcache.bin"
for p in git gh golang-go; do
  chroot "$T" dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -qx 'install ok installed' || fail "missing package $p"
done
for c in git gh go upm; do
  chroot "$T" sh -c "command -v '$c'" >/dev/null || fail "missing command $c"
done
printf 'git: '; chroot "$T" git --version
printf 'gh: '; chroot "$T" gh --version | head -1
printf 'go: '; chroot "$T" go version
printf 'upm: '; chroot "$T" upm -v
printf 'Package and command health: verified\n'

section 'universal package manager repository'
R="$T/root/universal-package-manager"
[[ -d "$R/.git" ]] || fail 'UPM repository is missing'
[[ "$(chroot "$T" git -C /root/universal-package-manager remote get-url origin)" == 'https://github.com/arc2898/universal-package-manager.git' ]] || fail 'UPM origin is wrong'
repo_status=$(chroot "$T" git -C /root/universal-package-manager status --short)
[[ -z "$repo_status" ]] || fail 'UPM repository has uncommitted changes'
chroot "$T" upm refresh >/dev/null
printf 'UPM repository and non-destructive refresh: verified\n'

section 'Dash2Dock Animated'
D="$T/usr/share/gnome-shell/extensions/dash2dock-lite@icedman.github.com"
[[ -f "$D/metadata.json" && -f "$D/schemas/gschemas.compiled" ]] || fail 'Dash2Dock Animated is incomplete'
grep -q '"name": "Dash2Dock Animated"' "$D/metadata.json" || fail 'wrong extension name'
grep -q '"uuid": "dash2dock-lite@icedman.github.com"' "$D/metadata.json" || fail 'wrong extension UUID'
grep -q '"50"' "$D/metadata.json" || fail 'Dash2Dock Animated does not support GNOME 50'
enabled=$(grep '^enabled-extensions=' "$T/etc/dconf/db/osmium.d/00-osmium-extensions")
grep -q 'dash2dock-lite@icedman.github.com' <<< "$enabled" || fail 'Dash2Dock Animated is not enabled by system defaults'
grep -q 'dash-to-dock@micxgx.gmail.com' <<< "$enabled" && fail 'regular Dash to Dock is still enabled alongside Dash2Dock Animated'
grep -q 'animate-icons=true' "$T/etc/dconf/db/osmium.d/00-osmium-extensions" || fail 'Dash2Dock animation is not enabled'
printf 'Dash2Dock Animated 92 (GNOME 50) and animation defaults: verified\n'

section 'branding and FastFetch'
[[ -f "$T/usr/share/pixmaps/osmium-os-logo.svg" ]] || fail 'OS logo SVG is missing'
grep -q '>OS<' "$T/usr/share/pixmaps/osmium-os-logo.svg" || fail 'OS logo does not contain OS lettering'
[[ -f "$T/usr/share/osmium/fastfetch/osmium-os-logo.txt" ]] || fail 'FastFetch OS logo is missing'
grep -q 'OSMIUM OS' "$T/usr/share/osmium/fastfetch/osmium-os-logo.txt" || fail 'FastFetch logo lacks OSMIUM OS'
fastfetch_out=$(chroot "$T" /usr/local/bin/osmium-fetch 2>&1)
grep -q 'OSMIUM OS' <<< "$fastfetch_out" || fail 'FastFetch output does not match the OS logo'
grep -q 'osmium-os-logo.txt' "$T/usr/share/osmium/fastfetch/osmium.jsonc" || fail 'FastFetch is not using the custom OS logo'
printf 'OS logo and matching FastFetch profile: verified\n'

section 'dock favorites and macOS title-bar layout'
favorites=$(grep '^favorite-apps=' "$T/etc/dconf/db/osmium.d/00-osmium-extensions")
python3 - "$T" "$favorites" <<'PY'
from pathlib import Path
import ast, sys
root = Path(sys.argv[1])
line = sys.argv[2].split('=', 1)[1]
favorites = ast.literal_eval(line)
visible = set()
exclude = {'eog.desktop', 'gnome-terminal.desktop', 'org.gnome.Terminal.desktop', 'nautilus-extension-gnome-terminal.desktop', 'osmium-about.desktop'}
for directory in [root/'usr/share/applications', root/'usr/local/share/applications', root/'var/lib/flatpak/exports/share/applications', root/'var/lib/snapd/desktop/applications']:
    if not directory.is_dir(): continue
    for path in directory.glob('*.desktop'):
        if path.name in exclude: continue
        values = {}
        for line in path.read_text(errors='replace').splitlines():
            if line.startswith('#') or '=' not in line: continue
            key, value = line.split('=', 1); values[key] = value
        if values.get('Type') != 'Application': continue
        if values.get('NoDisplay', 'false').strip().lower() == 'true': continue
        if values.get('Hidden', 'false').strip().lower() == 'true': continue
        visible.add(path.stem)
missing = sorted(visible - set(favorites))
extra = sorted(set(favorites) - visible)
if missing or extra:
    raise SystemExit(f'favorite mismatch; missing={missing}, extra={extra}')
print(f'All {len(visible)} visible application launchers are pinned.')
PY
grep -q "button-layout='close,minimize,maximize:'" "$T/etc/dconf/db/osmium.d/00-osmium-extensions" || fail 'macOS left title-button layout is not configured'
grep -q 'headerbar windowcontrols button.close' "$T/usr/share/themes/MacTahoe-Dark/gtk-4.0/gtk.css" || fail 'MacTahoe GTK4 title-button styling is missing'
grep -q 'button.titlebutton' "$T/usr/share/themes/MacTahoe-Dark/gtk-3.0/gtk.css" || fail 'MacTahoe GTK3 title-button styling is missing'
printf 'Dock favorites and macOS title-bar styling: verified\n'

section 'Big Sur GRUB branding'
grep -q '^GRUB_BACKGROUND="/boot/grub/themes/whitesur/background.jpg"$' "$T/etc/default/grub" || fail 'GRUB_BACKGROUND is not Big Sur image'
grep -q 'background_image "/boot/grub/themes/whitesur/background.jpg"' "$T/boot/grub/grub.cfg" || fail 'generated GRUB config does not use Big Sur image'
! grep -q 'ceratopsian-theme/grub/grub-4x3.png' "$T/boot/grub/grub.cfg" || fail 'old GRUB background reference remains'
identify "$T/boot/grub/themes/whitesur/background.jpg" | grep -q '1920x1080' || fail 'GRUB background has wrong dimensions'
[[ ! -e "$T/usr/share/backgrounds/.osmium-lost" && ! -e "$T/usr/share/themes/.osmium-lost" && ! -e "$T/usr/share/gnome-shell/.osmium-lost" && ! -e "$T/usr/share/icons/.\$lost" ]] || fail 'old quarantined assets remain'
printf 'Big Sur GRUB background and old-asset removal: verified\n'

section 'filesystem cleanup and deferred first-boot service'
[[ ! -d "$T/tmp/osmium-go-cache" && ! -d "$T/tmp/osmium-assets" ]] || fail 'temporary build assets remain'
[[ "$(du -sb "$T/var/cache/apt" | cut -f1)" -lt 2000000 ]] || fail 'APT cache is not clean'
[[ -f "$B/old-visual-assets.tar.gz" ]] || fail 'old visual asset archive is missing'
[[ -L "$T/etc/systemd/system/multi-user.target.wants/osmium-snap-store-install.service" ]] || fail 'Snap Store first-boot helper is not enabled'
printf 'Caches, quarantines, and first-boot helper state: verified\n'

section 'home preservation'
find "$T/home/user" -xdev -printf '%P\t%y\t%s\t%T@\t%U:%G\n' 2>/dev/null | sort > "$B/home-user-final.tsv"
cmp -s "$B/home-user-start.tsv" "$B/home-user-final.tsv" || fail '/home/user changed during todo pass'
printf '/home/user unchanged during todo pass: verified\n'

section 'UEFI identity'
efibootmgr -v | grep -q 'Boot[0-9A-F]\{4\}\* Osmium OS' || fail 'Osmium UEFI entry missing'
efibootmgr -v | grep -q '^BootOrder: 0001' || fail 'Osmium UEFI entry is not first'
efibootmgr -v | grep -q 'Boot0001.*HD(4,GPT,.*grubx64.efi' || fail 'Osmium UEFI entry does not target the ESP'
! efibootmgr -v | grep -q 'Debian 14 GNOME 50' || fail 'stale Debian UEFI label remains'
printf 'Osmium UEFI identity: verified\n'

printf '\nTODO-PASS VERIFICATION PASSED\n'
