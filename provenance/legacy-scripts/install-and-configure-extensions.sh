#!/usr/bin/env bash
set -Eeuo pipefail
T=/mnt/osmium
EXT="$T/usr/share/gnome-shell/extensions"
STAGE=/tmp/opencode

[[ -d "$T" ]] || { echo 'Target is not mounted' >&2; exit 1; }
for z in \
  "$STAGE/gnome-wobbly-windows@kyleabaker.github.com.zip" \
  "$STAGE/gnome-magic-lamp@kyleabaker.github.com.zip" \
  "$STAGE/coverflow-v88.zip"; do
  [[ -s "$z" ]] || { echo "Missing extension bundle: $z" >&2; exit 1; }
done

# Remove and reinstall the requested Dash to Dock package as the animated
# system copy, then install the three GNOME-50-compatible effect extensions
# system-wide (never in /home/user).
chroot "$T" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get purge -y gnome-shell-extension-dashtodock
chroot "$T" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get install -y gnome-shell-extension-dashtodock

install_one() {
  local uuid=$1 zip=$2
  local dir="$EXT/$uuid"
  rm -rf "$dir"
  mkdir -p "$dir"
  unzip -q "$zip" -d "$dir"
  [[ -f "$dir/metadata.json" ]] || { echo "No metadata for $uuid" >&2; exit 1; }
  grep -q '"50"' "$dir/metadata.json" || {
    echo "Extension $uuid does not declare GNOME 50 support" >&2
    exit 1
  }
  if [[ -d "$dir/schemas" ]]; then
    chroot "$T" glib-compile-schemas --strict "/usr/share/gnome-shell/extensions/$uuid/schemas" >/dev/null
  fi
  chown -R root:root "$dir"
}
install_one 'gnome-wobbly-windows@kyleabaker.github.com' "$STAGE/gnome-wobbly-windows@kyleabaker.github.com.zip"
install_one 'gnome-magic-lamp@kyleabaker.github.com' "$STAGE/gnome-magic-lamp@kyleabaker.github.com.zip"
install_one 'CoverflowAltTab@palatis.blogspot.com' "$STAGE/coverflow-v88.zip"

# System-wide defaults. Existing user dconf is intentionally untouched.
cat > "$T/etc/dconf/db/osmium.d/00-osmium-extensions" <<'EOF'
[org/gnome/shell]
enabled-extensions=['dash-to-dock@micxgx.gmail.com','ding@rastersoft.com','system-monitor@gnome-shell-extensions.gcampax.github.com','user-theme@gnome-shell-extensions.gcampax.github.com','blur-my-shell@aunetx','gnome-wobbly-windows@kyleabaker.github.com','gnome-magic-lamp@kyleabaker.github.com','CoverflowAltTab@palatis.blogspot.com']
disable-user-extensions=false

[org/gnome/shell/extensions/dash-to-dock]
animation-time=0.2
autohide=true
dock-fixed=false
extend-height=false
transparency-mode='DEFAULT'

[org/gnome/shell/extensions/user-theme]
name='MacTahoe'

[org/gnome/desktop/interface]
gtk-theme='MacTahoe-Dark'
icon-theme='MacTahoe-blue'
cursor-theme='MacTahoe'
color-scheme='prefer-dark'

[org/gnome/desktop/applications/terminal]
exec='ptyxis'
exec-arg='--'
EOF

cat > "$T/usr/share/glib-2.0/schemas/91-osmium-extensions.gschema.override" <<'EOF'
[org.gnome.shell]
enabled-extensions=['dash-to-dock@micxgx.gmail.com','ding@rastersoft.com','system-monitor@gnome-shell-extensions.gcampax.github.com','user-theme@gnome-shell-extensions.gcampax.github.com','blur-my-shell@aunetx','gnome-wobbly-windows@kyleabaker.github.com','gnome-magic-lamp@kyleabaker.github.com','CoverflowAltTab@palatis.blogspot.com']
disable-user-extensions=false

[org.gnome.shell.extensions.dash-to-dock]
animation-time=0.2
autohide=true
dock-fixed=false
extend-height=false
transparency-mode='DEFAULT'

[org.gnome.shell.extensions.user-theme]
name='MacTahoe'
EOF

# Keep GTK defaults consistent for new sessions and GUI tools.
for base in "$T/etc/xdg/gtk-3.0" "$T/etc/xdg/gtk-4.0" "$T/etc/skel/.config/gtk-3.0" "$T/etc/skel/.config/gtk-4.0"; do
  mkdir -p "$base"
  cat > "$base/settings.ini" <<'EOF'
[Settings]
gtk-theme-name=MacTahoe-Dark
gtk-icon-theme-name=MacTahoe-blue
gtk-cursor-theme-name=MacTahoe
gtk-application-prefer-dark-theme=1
EOF
done
chroot "$T" glib-compile-schemas /usr/share/glib-2.0/schemas
chroot "$T" dconf update
chroot "$T" update-desktop-database /usr/share/applications 2>/dev/null || true

printf 'GNOME extensions installed and system defaults configured.\n'
printf '%s\n' "$EXT"/*/metadata.json | while read -r f; do
  printf '%s: ' "$(basename "$(dirname "$f")")"
  grep -m1 '"shell-version"' "$f" || true
done
