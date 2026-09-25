#!/usr/bin/env bash
set -Eeuo pipefail
T=/mnt/osmium
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ -d "$T" ]] || fail 'Target root is not mounted'

# Keep a copy of the system-wide settings files before adding extension defaults.
mkdir -p "$T/usr/share/osmium/.settings-backup"
cp -a "$T/usr/share/glib-2.0/schemas/90-osmium.gschema.override" \
  "$T/usr/share/osmium/.settings-backup/90-osmium.gschema.override.before-extensions" 2>/dev/null || true
if [[ -f "$T/etc/dconf/profile/user" ]]; then
  cp -a "$T/etc/dconf/profile/user" \
    "$T/usr/share/osmium/.settings-backup/dconf-profile-user.before-extensions"
fi

cat > "$T/usr/share/glib-2.0/schemas/91-osmium-extensions.gschema.override" <<'EOF'
[org.gnome.shell]
enabled-extensions=['dash-to-dock@micxgx.gmail.com','ding@rastersoft.com','system-monitor@gnome-shell-extensions.gcampax.github.com','user-theme@gnome-shell-extensions.gcampax.github.com','blur-my-shell@aunetx']
disable-user-extensions=false

[org.gnome.shell.extensions.dash-to-dock]
animation-time=0.2
autohide=true
dock-fixed=false
extend-height=false
transparency-mode='DEFAULT'
EOF

mkdir -p "$T/etc/dconf/db/osmium.d"
cat > "$T/etc/dconf/db/osmium.d/00-osmium-extensions" <<'EOF'
[org/gnome/shell]
enabled-extensions=['dash-to-dock@micxgx.gmail.com','ding@rastersoft.com','system-monitor@gnome-shell-extensions.gcampax.github.com','user-theme@gnome-shell-extensions.gcampax.github.com','blur-my-shell@aunetx']
disable-user-extensions=false

[org/gnome/shell/extensions/dash-to-dock]
animation-time=0.2
autohide=true
dock-fixed=false
extend-height=false
transparency-mode='DEFAULT'
EOF
cat > "$T/etc/dconf/profile/user" <<'EOF'
user
system-db:osmium
EOF

chroot "$T" glib-compile-schemas /usr/share/glib-2.0/schemas
chroot "$T" dconf update
printf 'System-wide GNOME extension defaults configured.\n'
printf 'Extensions: Dash to Dock (animated), DING, System Monitor, Blur My Shell, User Themes\n'
printf 'No files under /home/user were modified.\n'
