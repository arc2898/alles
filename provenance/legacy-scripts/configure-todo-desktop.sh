#!/usr/bin/env bash
set -Eeuo pipefail
T=/mnt/osmium
DB="$T/etc/dconf/db/osmium.d/00-osmium-extensions"
UUID=dash2dock-lite@icedman.github.com
mkdir -p "$T/etc/dconf/db/osmium.d" "$T/usr/share/pixmaps"
install -m 0644 /root/osmium-assets/osmium-os-logo.svg "$T/usr/share/pixmaps/osmium-os-logo.svg"
install -m 0644 /root/osmium-assets/osmium-os-logo.svg "$T/usr/share/pixmaps/osmium-logo.svg"

# Keep Dash2Dock Animated as the active dock.  The separately packaged
# Dash to Dock files remain available for rollback, but are not enabled at the
# same time because both extensions own the dock area.
mapfile -t visible_apps < <(python3 - "$T" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])
paths = [
    root / 'usr/share/applications',
    root / 'usr/local/share/applications',
    root / 'var/lib/flatpak/exports/share/applications',
    root / 'var/lib/snapd/desktop/applications',
]
exclude = {
    'eog.desktop', 'gnome-terminal.desktop', 'org.gnome.Terminal.desktop',
    'nautilus-extension-gnome-terminal.desktop', 'osmium-about.desktop',
}
ids = set()
for directory in paths:
    if not directory.is_dir():
        continue
    for path in sorted(directory.glob('*.desktop')):
        if path.name in exclude:
            continue
        values = {}
        try:
            for line in path.read_text(errors='replace').splitlines():
                if line.startswith('#') or '=' not in line:
                    continue
                key, value = line.split('=', 1)
                values[key] = value
        except OSError:
            continue
        if values.get('Type') != 'Application':
            continue
        if values.get('NoDisplay', 'false').strip().lower() == 'true':
            continue
        if values.get('Hidden', 'false').strip().lower() == 'true':
            continue
        ids.add(path.stem)
for value in sorted(ids):
    print(value)
PY
)
[[ ${#visible_apps[@]} -gt 0 ]] || { echo 'No visible application launchers found' >&2; exit 1; }
python3 - "$DB" "$UUID" "${visible_apps[@]}" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
uuid = sys.argv[2]
apps = sys.argv[3:]
extensions = [
    uuid,
    'ding@rastersoft.com',
    'system-monitor@gnome-shell-extensions.gcampax.github.com',
    'user-theme@gnome-shell-extensions.gcampax.github.com',
    'blur-my-shell@aunetx',
    'gnome-wobbly-windows@kyleabaker.github.com',
    'gnome-magic-lamp@kyleabaker.github.com',
    'CoverflowAltTab@palatis.blogspot.com',
]
def dconf_list(values):
    return '[' + ','.join("'" + v.replace("'", "\\'") + "'" for v in values) + ']'
text = f'''[org/gnome/shell]
enabled-extensions={dconf_list(extensions)}
disable-user-extensions=false
favorite-apps={dconf_list(apps)}

[org/gnome/shell/extensions/dash2dock-lite]
animate-icons=true
animate-icons-unmute=true
shrink-icons=true
autohide-dash=false
open-app-animation=true
lamp-app-animation=true
dock-padding=0.5
icon-spacing=0.5
border-radius=12.0
border-thickness=0

# Retain the prior Dash to Dock settings for rollback, but do not enable it.
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

[org/gnome/desktop/wm/preferences]
theme='MacTahoe-Dark'
button-layout='close,minimize,maximize:'

[org/gnome/desktop/applications/terminal]
exec='ptyxis'
exec-arg='--'
'''
path.write_text(text)
PY
chown root:root "$DB"
chmod 0644 "$DB"
chroot "$T" glib-compile-schemas /usr/share/glib-2.0/schemas
chroot "$T" dconf update
printf 'Configured Dash2Dock Animated, macOS title-button layout, and %s visible app favorites.\n' "${#visible_apps[@]}"
printf 'Favorites: %s\n' "${visible_apps[*]}"
