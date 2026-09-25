# Upstream source manifest

These trees are retained as source inputs for the Osmium OS desktop layer.
The embedded Git metadata, when present, is the authoritative commit record.

| Component | Local source | Recorded revision | Purpose |
|---|---|---|---|
| MacTahoe GTK theme | `mactahoe-gtk-theme/` | `f19899811eff6d127afc38c4fa4981b220cb2ea2` | GTK/Shell theme and theme build/install tooling |
| MacTahoe icon theme | `mactahoe-icon-theme/` | `839848b9a8a38a92a6936e30c4abe35cc6f2546d` | MacTahoe-dark/light icons and cursors |
| grub2-themes | `grub2-themes/` | `4c5a77125b93f833edc9bf7b14a899faa8ac79c6` | Whitesur GRUB theme source/assets |
| Universal Package Manager | `universal-package-manager/` | `0e8f11f8546ca9e93cce395d4aaf0203e2eeb657` | Optional package-management helper |
| Calamares | `../sources/calamares/upstream/calamares-3.4.3.tar.gz` | v3.4.3 release | Installer source; signature is staged beside the archive |

The exact installed copies of the themes, icons, extensions, Plymouth theme,
GRUB assets, and wallpapers are under `../assets/`. They are included so the
current environment can be reviewed without requiring a package build.
