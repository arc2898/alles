#!/usr/bin/env bash
set -Eeuo pipefail
T=/mnt/osmium
ICON_LOST="$T/usr/share/icons/.\$lost"
THEME_LOST="$T/usr/share/themes/.osmium-lost"
BG_LOST="$T/usr/share/backgrounds/.osmium-lost"
SHELL_LOST="$T/usr/share/gnome-shell/.osmium-lost"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ -d "$T/usr/share/themes/MacTahoe-Dark" ]] || fail 'MacTahoe themes are missing'
[[ -d "$T/usr/share/icons/MacTahoe-blue" ]] || fail 'MacTahoe icons are missing'
[[ -d "$T/usr/share/backgrounds/osmium" ]] || fail 'Osmium wallpapers are missing'
mkdir -p "$ICON_LOST" "$THEME_LOST" "$BG_LOST" "$SHELL_LOST"

# MacTahoe explicitly inherits hicolor,breeze; retain those fallback directories.
for d in "$T/usr/share/icons"/*; do
  [[ -d "$d" ]] || continue
  name=${d##*/}
  case "$name" in
    MacTahoe*|hicolor|breeze) continue ;;
  esac
  [[ ! -e "$ICON_LOST/$name" ]] || fail "Icon destination already exists: $name"
  mv "$d" "$ICON_LOST/"
done

# Keep only MacTahoe theme directories in the active GTK theme path.
for d in "$T/usr/share/themes"/*; do
  [[ -d "$d" ]] || continue
  name=${d##*/}
  case "$name" in MacTahoe*) continue ;; esac
  [[ ! -e "$THEME_LOST/$name" ]] || fail "Theme destination already exists: $name"
  mv "$d" "$THEME_LOST/"
done

# Keep the Osmium wallpaper collection active; quarantine old background sets.
for d in "$T/usr/share/backgrounds"/*; do
  [[ -d "$d" ]] || continue
  name=${d##*/}
  [[ "$name" == osmium ]] && continue
  [[ ! -e "$BG_LOST/$name" ]] || fail "Wallpaper destination already exists: $name"
  mv "$d" "$BG_LOST/"
done

# The active GDM resource must remain; quarantine only the old backup resource.
if [[ -f "$T/usr/share/gnome-shell/gnome-shell-theme.gresource.bak" ]]; then
  mv "$T/usr/share/gnome-shell/gnome-shell-theme.gresource.bak" "$SHELL_LOST/"
fi

# Rebuild caches for the retained icon themes.
for d in "$T/usr/share/icons"/MacTahoe* "$T/usr/share/icons/hicolor"; do
  [[ -d "$d" ]] || continue
  gtk-update-icon-cache -f -t "$d" >/dev/null 2>&1 || true
done

sync
printf 'Old visual assets moved out of active paths.\n'
printf 'Icons: %s\n' "$ICON_LOST"
printf 'Themes: %s\n' "$THEME_LOST"
printf 'Wallpapers: %s\n' "$BG_LOST"
printf 'Required hicolor/breeze fallback retained.\n'
