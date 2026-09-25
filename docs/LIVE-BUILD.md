# Live-build notes

The active `config/` profile targets Debian Forky and produces an ISO-hybrid
GNOME live image. The Calamares overlay is copied by
`config/hooks/live/0100-osmiumos-calamares-overlay.hook.chroot`; the curated
desktop layer is copied by
`config/hooks/live/0110-osmium-customization.hook.chroot`.

The build is intentionally gated by `scripts/build-iso.sh`. The script
requires both `OSMIUM_BUILD_ISO=1` and a locally built Calamares package in
`config/archives/`.

Before any build, verify that the live-build package understands the
`forky` suite and that the generated initramfs contains the Osmium Plymouth
theme. Do not use the old Trixie profile accidentally; it is retained only at
`config-trixie-reference/`.
