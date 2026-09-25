# Curated live-session overlay

This directory contains only system-wide, non-secret defaults intended for a
live-build chroot. The companion hook
`config/hooks/live/0110-osmium-customization.hook.chroot` copies it and the
reviewed assets from `assets/` into the image.

Included defaults:

- GNOME system dconf database/profile;
- MacTahoe role names and wallpaper defaults;
- ArcMenu icon and GNOME Shell extension enablement;
- zsh skeleton and FastFetch wrapper;
- Osmium pixmaps and the corrected wallpaper XML;
- selected system branding files.

Browser data, user credentials, machine IDs, and private dconf state are not
part of this overlay.
