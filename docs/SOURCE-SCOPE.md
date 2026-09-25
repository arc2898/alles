# Source scope and licensing

Osmium OS is a derivative distribution specification. Debian and GNOME are
collections of source packages rather than one upstream source repository.
This bundle therefore contains:

1. Signed Debian source indexes for the active Forky suite.
2. The source archives and extracted references needed for the live-image
   tooling, GNOME metapackages, Calamares packaging, and the installer.
3. Source trees for the third-party desktop customizations.
4. A reproducible overlay and target snapshot for the current installation.

It does **not** claim to redistribute every Debian source archive. Binary
packages are intended to come from the configured signed Debian repositories
unless a local Calamares package is built in a later, explicitly approved
stage.

The macOS-derived wallpaper binaries are retained as user-provided review
assets. Their redistribution rights must be checked separately before any
public ISO or repository publication. Third-party licenses and copyright
files remain in their respective source trees.
