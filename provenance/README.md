# Provenance and scope

This is a reviewable source/build specification for the customized Osmium OS
installation. It is not a byte-for-byte dump of `/home/user` and it is not yet
an approved ISO build.

## Included

- Debian source metadata for the active Forky suite and the original Trixie
  reference profile.
- Calamares v3.4.3 upstream source, signature, Debian packaging references, and
  the Osmium installer overlay.
- live-build configuration and hooks.
- Pinned MacTahoe, grub2-themes, and Universal Package Manager source trees.
- Exact installed copies of the custom themes, icons, extensions, Plymouth
  theme, GRUB assets, wallpapers, and selected system configuration.
- A target package manifest and runtime-tool lock notes.

## Deliberately excluded

- Browser profiles, cookies, passwords, SSH/GPG keys, tokens, certificates,
  network credentials, machine IDs, journals, and UEFI identifiers.
- Full `/home/user`, package caches, temporary files, and the separate data
  partitions.
- Unreviewed third-party binaries without a pinned source or package record.

The `provenance/target-snapshot/` directory is intentionally small and
machine-auditable. It is evidence for reproducing the customization, not a
license to redistribute private user data.
