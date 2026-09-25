#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

T=/mnt/osmium
ASSET_ROOT=/root/osmium-assets
STAGE_REL=/tmp/osmium-assets
STAGE="$T$STAGE_REL"
LOG_DIR=/root/osmium-customization-backup-20260924
TARGET_LABEL=osmium-root
ESP_LABEL=OSMIUMESP

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ -f "$T/etc/os-release" ]] || fail "Target root is not mounted"
[[ "$(blkid -s LABEL -o value /dev/sdb2)" == "$TARGET_LABEL" ]] || fail "sdb2 identity changed"
[[ "$(blkid -s LABEL -o value /dev/sdb4)" == "$ESP_LABEL" ]] || fail "sdb4 identity changed"
[[ -f "$LOG_DIR/target-desktop-before.tar" ]] || fail "Rollback snapshot is missing"
[[ -x "$ASSET_ROOT/MacTahoe-gtk-theme/install.sh" ]] || fail "MacTahoe GTK repository is missing"
[[ -x "$ASSET_ROOT/MacTahoe-icon-theme/install.sh" ]] || fail "MacTahoe icon repository is missing"
[[ -x "$ASSET_ROOT/grub2-themes/install.sh" ]] || fail "GRUB theme repository is missing"

for c in sassc glib-compile-resources xmllint convert magick gtk-update-icon-cache; do
  chroot "$T" sh -c "command -v $c" >/dev/null || fail "Target dependency is missing: $c"
done

rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -a "$ASSET_ROOT/MacTahoe-gtk-theme" "$STAGE/"
cp -a "$ASSET_ROOT/MacTahoe-icon-theme" "$STAGE/"
cp -a "$ASSET_ROOT/grub2-themes" "$STAGE/"
cp -a "$ASSET_ROOT/install-libadwaita-root.sh" "$STAGE/"
chmod 755 "$STAGE"/*/install.sh "$STAGE/install-libadwaita-root.sh"

# Record the untouched user home before system-wide customization.
find "$T/home/user" -xdev -printf '%P\t%y\t%s\t%T@\t%U:%G\n' 2>/dev/null | sort > "$LOG_DIR/home-user-before.tsv" || true

mapfile -t WALLPAPER_FILES < <(find "$ASSET_ROOT/wallpapers" -maxdepth 1 -type f -name '*.png' | sort)
[[ "${#WALLPAPER_FILES[@]}" -ge 1 ]] || fail "No downloaded wallpapers found"
for wallpaper in "${WALLPAPER_FILES[@]}"; do
  dimensions=$(identify -format '%wx%h' "$wallpaper")
  [[ "$dimensions" == 4480x3088 ]] || fail "Wallpaper is not maximum quality 4480x3088: $wallpaper ($dimensions)"
done

install -d "$T/usr/share/backgrounds/osmium"
rm -f "$T/usr/share/backgrounds/osmium"/*
cp -a "${WALLPAPER_FILES[@]}" "$T/usr/share/backgrounds/osmium/"
{
  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<wallpaper>'
  for wallpaper in "${WALLPAPER_FILES[@]}"; do
    name=${wallpaper##*/}
    printf '  <wallpaper><name>Osmium OS — macOS 27 Golden Gate — %s</name><filename>/usr/share/backgrounds/osmium/%s</filename><options>zoom</options><shade_type>solid</shade_type><pcolor>#20242b</pcolor><scolor>#000000</scolor></wallpaper>\n' "$name" "$name"
  done
  printf '%s\n' '</wallpaper>'
} > "$T/usr/share/backgrounds/osmium.xml"

# Install MacTahoe icons and cursors system-wide.
chroot "$T" /usr/bin/env -u SUDO_USER HOME=/root USER=root LOGNAME=root \
  "$STAGE_REL/MacTahoe-icon-theme/install.sh" --theme blue --bold \
  2>&1 | tee "$LOG_DIR/mactahoe-icons.log"

# Run the requested command inside the target root. The upstream script
# intentionally skips its user-scoped -l branch under UID 0; the root
# wrapper below applies the same libadwaita output system-wide.
chroot "$T" /usr/bin/env -u SUDO_USER HOME=/root USER=root LOGNAME=root \
  "$STAGE_REL/MacTahoe-gtk-theme/install.sh" -l -b --dest /usr/share/themes --name MacTahoe --silent-mode \
  2>&1 | tee "$LOG_DIR/mactahoe-gtk.log"
chroot "$T" /usr/bin/env -u SUDO_USER HOME=/root USER=root LOGNAME=root \
  "$STAGE_REL/install-libadwaita-root.sh" \
  2>&1 | tee "$LOG_DIR/mactahoe-libadwaita.log"

# Apply the system-wide GDM/GNOME Shell theme with one of the downloaded images.
first_wallpaper=$(find "$T/usr/share/backgrounds/osmium" -maxdepth 1 -type f -name '*.png' | sort | head -n 1)
relative_wallpaper=${first_wallpaper#"$T"}
chroot "$T" /usr/bin/env -u SUDO_USER HOME=/root USER=root LOGNAME=root \
  "$STAGE_REL/MacTahoe-gtk-theme/tweaks.sh" -g -b "$relative_wallpaper" -nd -nb \
  2>&1 | tee "$LOG_DIR/mactahoe-gdm.log"

# Install the Whitesur GRUB theme from vinceliuice/grub2-themes.
chroot "$T" /usr/bin/env -u SUDO_USER HOME=/root USER=root LOGNAME=root \
  "$STAGE_REL/grub2-themes/install.sh" -t whitesur -i whitesur -s 1080p -b \
  2>&1 | tee "$LOG_DIR/grub-whitesur.log"

# Safe system-wide branding; keep Debian's package identity intact.
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

# System-wide GTK defaults; no files under /home/user are changed.
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

# Set system GSettings defaults. Existing per-user values remain untouched.
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

# Ensure the installed GRUB config points at the Whitesur theme.
grep -q 'GRUB_THEME=.*/boot/grub/themes/whitesur/theme.txt' "$T/etc/default/grub" || fail "Whitesur GRUB theme was not configured"
grep -q '/boot/grub/themes/whitesur/theme.txt' "$T/boot/grub/grub.cfg" || fail "GRUB config does not reference Whitesur"

# Confirm the user home was not changed by the system-wide installers.
find "$T/home/user" -xdev -printf '%P\t%y\t%s\t%T@\t%U:%G\n' 2>/dev/null | sort > "$LOG_DIR/home-user-after.tsv" || true
diff -u "$LOG_DIR/home-user-before.tsv" "$LOG_DIR/home-user-after.tsv" > "$LOG_DIR/home-user.diff" || true
[[ ! -s "$LOG_DIR/home-user.diff" ]] || fail "System-wide customization changed /home/user"

rm -rf "$STAGE"
sync
printf 'Osmium customization completed.\n'
printf 'Wallpapers: %s\n' "${#WALLPAPER_FILES[@]}"
printf 'GRUB: Whitesur\n'
printf 'User home: unchanged\n'
