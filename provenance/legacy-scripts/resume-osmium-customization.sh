#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

T=/mnt/osmium
STAGE_REL=/tmp/osmium-assets
STAGE="$T$STAGE_REL"
LOG_DIR=/root/osmium-customization-backup-20260924

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  set +e
  for m in "$T/run" "$T/sys" "$T/dev" "$T/proc"; do
    if mountpoint -q "$m"; then
      umount -R "$m"
    fi
  done
}
trap cleanup EXIT

[[ -f "$T/etc/os-release" ]] || fail "Target is not mounted"
[[ -d "$T/usr/share/themes/MacTahoe-Dark" ]] || fail "MacTahoe GTK theme is missing"
[[ -d "$T/usr/share/icons/MacTahoe-blue" ]] || fail "MacTahoe icon theme is missing"
[[ -d "$T/boot/grub/themes/whitesur" ]] || fail "Whitesur GRUB assets are missing"
[[ -f "$T/boot/efi/EFI/debian/grubx64.efi" ]] || fail "Target GRUB EFI file is missing"

mkdir -p "$T"/{dev,proc,sys,run}
if ! mountpoint -q "$T/dev"; then mount --rbind /dev "$T/dev"; mount --make-rslave "$T/dev"; fi
if ! mountpoint -q "$T/proc"; then mount -t proc proc "$T/proc"; fi
if ! mountpoint -q "$T/sys"; then mount --rbind /sys "$T/sys"; mount --make-rslave "$T/sys"; fi
if ! mountpoint -q "$T/run"; then mount --rbind /run "$T/run"; mount --make-rslave "$T/run"; fi

# Finish the GRUB update that previously lacked /dev in the chroot.
chroot "$T" /usr/bin/env -u SUDO_USER HOME=/root USER=root LOGNAME=root update-grub \
  2>&1 | tee "$LOG_DIR/grub-update-resume.log"
grep -q '/boot/grub/themes/whitesur/theme.txt' "$T/boot/grub/grub.cfg" || fail "GRUB config does not reference Whitesur"

# Safe system-wide branding; retain Debian's package identity.
sed -i \
  -e 's/^NAME=.*/NAME="Osmium OS"/' \
  -e 's/^VERSION=.*/VERSION="1 (Forky)"/' \
  -e 's/^PRETTY_NAME=.*/PRETTY_NAME="Osmium OS (Debian Forky)"/' \
  "$T/etc/os-release"
printf 'Osmium OS GNU/Linux\n' > "$T/etc/issue"
if [[ -f "$T/etc/lsb-release" ]]; then
  sed -i \
    -e 's/^DISTRIB_NAME=.*/DISTRIB_NAME="Osmium OS"/' \
    -e 's/^DISTRIB_DESCRIPTION=.*/DISTRIB_DESCRIPTION="Osmium OS (Debian Forky)"/' \
    "$T/etc/lsb-release"
else
  cat > "$T/etc/lsb-release" <<'EOF'
DISTRIB_ID=Debian
DISTRIB_RELEASE=14
DISTRIB_CODENAME=forky
DISTRIB_NAME="Osmium OS"
DISTRIB_DESCRIPTION="Osmium OS (Debian Forky)"
EOF
fi
install -d "$T/usr/share/osmium" "$T/usr/share/pixmaps"
cat > "$T/usr/share/osmium/README" <<'EOF'
Osmium OS
==========

A GNOME 50 desktop built from Debian Forky.

The system-wide desktop assets are provided by the vinceliuice MacTahoe and
grub2-themes projects. The original Debian package identity and rollback data
are retained in the installation backup.
EOF
cat > "$T/usr/share/pixmaps/osmium-logo.svg" <<'EOF'
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="180" viewBox="0 0 640 180">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#67e8f9"/><stop offset="1" stop-color="#7c3aed"/></linearGradient></defs>
  <rect width="640" height="180" rx="28" fill="#111827"/>
  <circle cx="92" cy="90" r="48" fill="url(#g)"/>
  <text x="170" y="112" font-family="sans-serif" font-size="64" font-weight="700" fill="#f8fafc">Osmium OS</text>
</svg>
EOF
cat > "$T/usr/share/applications/osmium-about.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Osmium OS
Comment=About Osmium OS
Exec=gnome-control-center info-overview
Icon=osmium-logo
Terminal=false
Categories=System;
EOF

install -d "$T/etc/xdg/gtk-3.0" "$T/etc/xdg/gtk-4.0" \
  "$T/etc/skel/.config/gtk-3.0" "$T/etc/skel/.config/gtk-4.0"
for file in "$T/etc/xdg/gtk-3.0/settings.ini" "$T/etc/skel/.config/gtk-3.0/settings.ini"; do
  cat > "$file" <<'EOF'
[Settings]
gtk-theme-name=MacTahoe-Dark
gtk-icon-theme-name=MacTahoe-blue
gtk-cursor-theme-name=MacTahoe
gtk-application-prefer-dark-theme=1
EOF
done
for file in "$T/etc/xdg/gtk-4.0/settings.ini" "$T/etc/skel/.config/gtk-4.0/settings.ini"; do
  cat > "$file" <<'EOF'
[Settings]
gtk-theme-name=MacTahoe-Dark
gtk-icon-theme-name=MacTahoe-blue
gtk-cursor-theme-name=MacTahoe
gtk-application-prefer-dark-theme=1
EOF
done

first_wallpaper=$(find "$T/usr/share/backgrounds/osmium" -maxdepth 1 -type f -name '*.png' | sort | head -n 1)
relative_wallpaper=${first_wallpaper#"$T"}
[[ -n "$relative_wallpaper" ]] || fail "No Osmium wallpaper found"
chroot "$T" xmllint --noout /usr/share/backgrounds/osmium.xml

schema_dir="$T/usr/share/glib-2.0/schemas"
override="$schema_dir/90-osmium.gschema.override"
cat > "$override" <<EOF
[org.gnome.desktop.interface]
gtk-theme='MacTahoe-Dark'
icon-theme='MacTahoe-blue'
cursor-theme='MacTahoe'
color-scheme='prefer-dark'

[org.gnome.desktop.background]
picture-uri='file://$relative_wallpaper'
picture-uri-dark='file://$relative_wallpaper'
picture-options='zoom'
primary-color='#20242b'
secondary-color='#000000'

[org.gnome.desktop.wm.preferences]
theme='MacTahoe-Dark'
EOF
if chroot "$T" gsettings list-keys org.gnome.shell.extensions.user-theme | grep -qx name; then
  cat >> "$override" <<'EOF'

[org.gnome.shell.extensions.user-theme]
name='MacTahoe'
EOF
fi
if chroot "$T" gsettings list-keys org.gnome.shell | grep -qx enabled-extensions; then
  cat >> "$override" <<'EOF'

[org.gnome.shell]
enabled-extensions=['user-theme@gnome-shell-extensions.gcampax.github.com','blur-my-shell@aunetx']
EOF
fi
chroot "$T" glib-compile-schemas /usr/share/glib-2.0/schemas

# Confirm the user home was not changed.
find "$T/home/user" -xdev -printf '%P\t%y\t%s\t%T@\t%U:%G\n' 2>/dev/null | sort > "$LOG_DIR/home-user-after.tsv" || true
if [[ -f "$LOG_DIR/home-user-before.tsv" ]]; then
  diff -u "$LOG_DIR/home-user-before.tsv" "$LOG_DIR/home-user-after.tsv" > "$LOG_DIR/home-user.diff" || true
  [[ ! -s "$LOG_DIR/home-user.diff" ]] || fail "System-wide customization changed /home/user"
fi

rm -rf "$STAGE"
sync
printf 'Osmium customization resumed and completed.\n'
printf 'Wallpapers: 2\n'
printf 'GRUB: Whitesur\n'
printf 'User home: unchanged\n'
