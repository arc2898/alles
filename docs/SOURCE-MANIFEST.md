# Source manifest

Verified on 2026-09-24. The machine-readable checksum file is [`../SHA256SUMS`](../SHA256SUMS).

## Debian base

- Release: Debian 13.7 (trixie), current stable
- Release page: <https://www.debian.org/releases/>
- Release details: <https://www.debian.org/releases/trixie/>

Signed source indexes staged under `sources/debian/trixie/`:

- `https://deb.debian.org/debian/dists/trixie/main/source/Sources.xz`
- `https://deb.debian.org/debian/dists/trixie/contrib/source/Sources.xz`
- `https://deb.debian.org/debian/dists/trixie/non-free/source/Sources.xz`
- `https://deb.debian.org/debian/dists/trixie/non-free-firmware/source/Sources.xz`
- `https://deb.debian.org/debian/dists/trixie-updates/main/source/Sources.xz`
- `https://security.debian.org/debian-security/dists/trixie-security/main/source/Sources.xz`

The corresponding Debian `InRelease` metadata is also staged and was verified with the Debian archive keyring.

## Calamares

- Upstream release: v3.4.3, released 2026-09-10
- Release page: <https://codeberg.org/Calamares/calamares/releases/tag/v3.4.3>
- Source archive: <https://codeberg.org/Calamares/calamares/releases/download/v3.4.3/calamares-3.4.3.tar.gz>
- Detached signature: `calamares-3.4.3.tar.gz.asc`
- Published SHA-256: `144cbbf6bdcebfb21685950db4f0777218519df095f62f4aa392f28348110d18`
- Verified signing subkey: `6D0837841C068A233F24127B14B6CC381BC256D6`

Debian packaging references staged:

- Calamares `3.3.14-1` (stable)
- Calamares `3.4.2-1.1` (newer Debian packaging reference)
- `calamares-settings-debian` `13.0.13-1`

## GNOME

- `tasksel` `3.81` — defines `task-gnome-desktop`
- `meta-gnome3` `1:48+2` — provides `gnome-core` and `gnome`

The full GNOME desktop will be installed from Debian's signed binary repositories. The GNOME metapackage source is staged for reference and future derivative packaging.

## Live-image tooling

- `live-build` `1:20250505+deb13u1`
- `live-boot` `1:20250815~deb13u1`
- `live-config` `11.0.5`
- `debian-installer` `20250803+deb13u7` (reference only; OsmiumOS uses Calamares)

## Verification notes

- Debian archive signatures were checked against `/usr/share/keyrings/debian-archive-keyring.gpg`.
- Debian developer source signatures were checked against `/usr/share/keyrings/debian-keyring.pgp`.
- The Calamares release signature was checked against the project-local temporary keyring.
- The `tasksel` source signature was independently checked; `dpkg-source` emits a warning because its signing certificate uses an older SHA-1 certification policy.
- All source archives are retained alongside their extracted trees.

## Active Forky review profile

The installed target uses Debian `forky/sid`, so the review bundle also stages
signed source metadata under `sources/debian/forky/`:

- `InRelease`
- `Sources-main.xz`
- `Sources-contrib.xz`
- `Sources-non-free.xz`
- `Sources-non-free-firmware.xz`

The Forky `InRelease` signature was checked against
`/usr/share/keyrings/debian-archive-keyring.gpg`. The Trixie material above is
kept as a reference profile; it is not the active build suite.

