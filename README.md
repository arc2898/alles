# Osmiumos
Osmium is a Linux based Operating System based on Debain 14
this OS for mac theme users and using Gnome 50
using custom Gnome extensions themes icons and cursor
trying to make it best and close look to Mac OS mixture
-----
# Osmium OS — source review bundle

This directory is a reviewable source/build specification for the customized
Osmium OS live image. **No ISO has been built.**

## Active profile

- **Base:** Debian Forky (`forky/sid`), matching the installed target
- **Architecture:** `amd64` first
- **Desktop:** full GNOME 50.5
- **Installer:** Calamares v3.4.3 source, with the Osmium overlay in
  `config/calamares/`
- **Image tooling:** Debian live-build/live-boot/live-config
- **Build mode:** Calamares from the live session; Debian Installer remains
  reference-only
- **Build state:** source/config/assets staged; ISO build intentionally gated

The earlier Trixie profile is preserved in `config-trixie-reference/` and the
signed Trixie source metadata remains under `sources/debian/trixie/` for
comparison. The active Forky source metadata is under `sources/debian/forky/`.

## Important directories

- `config/` — live-build configuration, package lists, hooks, and Calamares
  overlay.
- `sources/` — staged Debian, GNOME, and Calamares source material.
- `upstream/` — pinned MacTahoe, grub2-themes, and UPM source trees.
- `assets/` — exact installed themes, icons, extensions, wallpapers, Plymouth,
  GRUB, and runtime branding assets.
- `provenance/target-snapshot/` — small, non-secret evidence copied from the
  installed target.
- `locks/` — target package inventory and runtime provenance.
- `docs/` — scope, current-environment notes, and build gates.
- `scripts/` — verification and explicitly gated future build helpers.

## Safety and build gates

This is a source review, not a disk image. It excludes browser data, keys,
passwords, cookies, machine IDs, logs, UEFI identifiers, caches, and the
separate data partitions. Do not run Calamares against a real disk until the
image has passed VM tests.

The current environment is suitable as a **live-session customization
reference**, but it is not yet certified as an ISO build. In particular:

- the active live-build package version must be checked against Forky;
- the locally built Calamares package is not present yet;
- the exact GDM gresource build step is not yet captured;
- external applications such as Brave and Ghostty need explicit package
  provenance/repository policy;
- the current target wallpaper XML had a malformed invisible character and
  stale paths; the review overlay contains the corrected catalog, but the
  target itself was not changed while making this bundle.

Read `docs/CURRENT-ENVIRONMENT.md` and `docs/SOURCE-SCOPE.md` before building.

## Verify the staged source

```sh
cd /path/to/OsmiumOS-Source
./scripts/verify-sources.sh
```

The verification command checks source checksums and the review-bundle
manifest. It does not build or install anything.

## Future ISO build

`scripts/build-iso.sh`
is guarded and refuses to run unless explicitly
enabled. Do not enable it until the source review is accepted and the Calamares
package/VM test plan is confirmed.
