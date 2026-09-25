#!/usr/bin/env bash
set -Eeuo pipefail
T=/mnt/osmium
DB="$T/etc/dconf/db/osmium.d/00-osmium-extensions"
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ "$(blkid -s LABEL -o value /dev/sda2 2>/dev/null || true)" == 'osmium-root' ]] || fail 'unexpected target root'
[[ -d "$T/usr/share/themes/MacTahoe-Dark/gtk-3.0" && -d "$T/usr/share/themes/MacTahoe-Dark/gtk-4.0" ]] || fail 'MacTahoe-Dark GTK theme is missing'
[[ -f "$T/usr/share/icons/MacTahoe-dark/index.theme" ]] || fail 'MacTahoe-dark icon theme is missing'
[[ -f "$T/usr/share/icons/MacTahoe/index.theme" ]] || fail 'MacTahoe cursor theme is missing'
[[ -f "$T/usr/share/themes/MacTahoe-Dark/gnome-shell/gnome-shell.css" ]] || fail 'MacTahoe-Dark shell theme is missing'

# Remove all installed GNOME Shell extension packages and the common data package.
chroot "$T" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get purge -y \
  gnome-shell-extension-blur-my-shell \
  gnome-shell-extension-dashtodock \
  gnome-shell-extension-desktop-icons-ng \
  gnome-shell-extension-prefs \
  gnome-shell-extension-system-monitor \
  gnome-shell-extension-user-theme \
  gnome-shell-extensions-common

# Remove any manually installed/unowned extension directories as well.
install -d "$T/usr/share/gnome-shell/extensions"
find "$T/usr/share/gnome-shell/extensions" -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} +
rm -f "$T/usr/share/glib-2.0/schemas/91-osmium-extensions.gschema.override"

# Use the valid MacTahoe roles. MacTahoe-Dark is the GTK/legacy theme;
# MacTahoe-dark is the icon pack; MacTahoe is the cursor theme.
for file in \
  "$T/etc/xdg/gtk-3.0/settings.ini" \
  "$T/etc/xdg/gtk-4.0/settings.ini" \
  "$T/etc/skel/.config/gtk-3.0/settings.ini" \
  "$T/etc/skel/.config/gtk-4.0/settings.ini"; do
  install -d "$(dirname "$file")"
  cat > "$file" <<'EOF'
[Settings]
gtk-theme-name=MacTahoe-Dark
gtk-icon-theme-name=MacTahoe-dark
gtk-cursor-theme-name=MacTahoe
gtk-application-prefer-dark-theme=1
EOF
done

favorites=$(grep '^favorite-apps=' "$DB" 2>/dev/null || printf "favorite-apps=[]")
cat > "$DB" <<EOF
[org/gnome/shell]
enabled-extensions=@as []
disable-user-extensions=true
$favorites

[org/gnome/shell/extensions/user-theme]
name='MacTahoe-Dark'

[org/gnome/desktop/interface]
gtk-theme='MacTahoe-Dark'
icon-theme='MacTahoe-dark'
cursor-theme='MacTahoe'
color-scheme='prefer-dark'

[org/gnome/desktop/background]
picture-uri='file:///usr/share/backgrounds/osmium/macos-27-golden-4480x3088-26625.png'
picture-uri-dark='file:///usr/share/backgrounds/osmium/macos-27-golden-4480x3088-26625.png'
picture-options='zoom'
primary-color='#20242b'
secondary-color='#000000'

[org/gnome/desktop/wm/preferences]
theme='MacTahoe-Dark'
button-layout='close,minimize,maximize:'

[org/gnome/desktop/applications/terminal]
exec='ptyxis'
exec-arg='--'
EOF
chown root:root "$DB"
chmod 0644 "$DB"

# Keep the system GSettings defaults consistent with the repaired settings.
override="$T/usr/share/glib-2.0/schemas/90-osmium.gschema.override"
cat > "$override" <<'EOF'
[org.gnome.desktop.interface]
gtk-theme='MacTahoe-Dark'
icon-theme='MacTahoe-dark'
cursor-theme='MacTahoe'
color-scheme='prefer-dark'

[org.gnome.desktop.background]
picture-uri='file:///usr/share/backgrounds/osmium/macos-27-golden-4480x3088-26625.png'
picture-uri-dark='file:///usr/share/backgrounds/osmium/macos-27-golden-4480x3088-26625.png'
picture-options='zoom'
primary-color='#20242b'
secondary-color='#000000'

[org.gnome.desktop.wm.preferences]
theme='MacTahoe-Dark'
EOF
chown root:root "$override"
chmod 0644 "$override"

# Replace the Debian wallpaper catalog with only the Osmium wallpapers.
cat > "$T/usr/share/backgrounds/osmium.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE wallpapers SYSTEM "gnome-wp-list.dtd">
<wallpapers>
  <wallpaper>
    <name>Osmium OS - macOS 27 Golden Gate - 26625</name>
    <filename>/usr/share/backgrounds/osmium/macos-27-golden-4480x3088-26625.png</filename>
    <options>zoom</options>
    <shade_type>solid</shade_type>
    <pcolor>#20242b</pcolor>
    <scolor>#000000</scolor>
  </wallpaper>
  <wallpaper>
    <name>Osmium OS - macOS 27 Golden Gate - 26626</name>
    <filename>/usr/share/backgrounds/osmium/macos-27-golden-4480x3088-26626.png</filename>
    <options>zoom</options>
    <shade_type>solid</shade_type>
    <pcolor>#20242b</pcolor>
    <scolor>#000000</scolor>
  </wallpaper>
</wallpapers>
EOF
install -m 0644 "$T/usr/share/backgrounds/osmium.xml" "$T/usr/share/gnome-background-properties/osmium.xml"
rm -f "$T/usr/share/gnome-background-properties"/debian-*.xml

# Make Xcursor applications use the same MacTahoe cursor pack.
cat > "$T/usr/share/icons/MacTahoe/cursor.theme" <<'EOF'
[Icon Theme]
Name=MacTahoe
Comment=MacTahoe cursor theme
Inherits=MacTahoe
EOF
chown root:root "$T/usr/share/icons/MacTahoe/cursor.theme"
chmod 0644 "$T/usr/share/icons/MacTahoe/cursor.theme"
chroot "$T" update-alternatives --install /usr/share/icons/default/index.theme x-cursor-theme /usr/share/icons/MacTahoe/cursor.theme 100
chroot "$T" update-alternatives --set x-cursor-theme /usr/share/icons/MacTahoe/cursor.theme

# Rebuild caches/schemas after the theme and catalog changes.
chroot "$T" glib-compile-schemas /usr/share/glib-2.0/schemas
chroot "$T" gtk-update-icon-cache -f -t /usr/share/icons/MacTahoe-dark
chroot "$T" gtk-update-icon-cache -f -t /usr/share/icons/MacTahoe
chroot "$T" dconf update
sync
printf '%s\n' 'MacTahoe roles repaired, Debian wallpaper catalog removed, and all GNOME extensions removed.'
