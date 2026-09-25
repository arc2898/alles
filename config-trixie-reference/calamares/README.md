# OsmiumOS Calamares overlay

This directory is an overlay, not a fork of Calamares.

- `etc/calamares/` contains the installer sequence, module configuration, and OsmiumOS branding.
- `usr/lib/calamares/modules/` contains Debian-derived process modules used by the Debian Calamares settings.
- `usr/share/calamares/helpers/` contains the corresponding helper programs.
- `usr/bin/osmiumos-installer` is the live-session launcher.
- `usr/share/applications/` contains the GNOME application entry.

The live-build hook at `config/hooks/live/0100-osmiumos-calamares-overlay.hook.chroot` copies this tree into the image chroot after package installation.

The Debian source references remain untouched under `sources/calamares/`. Changes specific to OsmiumOS belong here.
