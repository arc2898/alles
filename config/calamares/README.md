# Osmium OS Calamares overlay

This directory is an overlay for Calamares v3.4.3, not a fork.

- `etc/calamares/` contains the installer sequence, module configuration, and
  Osmium OS branding.
- `usr/lib/calamares/modules/` contains the small set of Debian-derived
  process-module descriptors used by the sequence.
- `usr/share/calamares/helpers/` contains the corresponding helper programs.
- `usr/bin/osmiumos-installer` is the live-session launcher.
- `usr/share/applications/` contains the GNOME application entry.

The active build profile is Debian Forky (`forky/sid`). The source metadata
for the active suite is staged under `sources/debian/forky/`; the original
Trixie live-build profile is retained under `config-trixie-reference/` for
comparison only.
