# ISO build gates

Do not build or publish an ISO until all of these gates are satisfied.

1. Review the source scope, included assets, and licensing status.
2. Confirm the active Forky suite and a compatible live-build version.
3. Build Calamares v3.4.3 from `sources/calamares/upstream/` and place the
   tested `.deb` in `config/archives/`.
4. Run `./scripts/verify-sources.sh` and `tests/validate-source.sh`.
5. Build a test ISO in a disposable workspace.
6. Boot the ISO in a VM and test live-session boot, GDM, network, sound,
   suspend/resume where applicable, and the installer launcher.
7. Run Calamares in a VM only; test partition, UEFI, bootloader, user creation,
   and post-install branding.
8. Test the installed target in a VM before any physical-disk install.
9. Only then explicitly enable `OSMIUM_BUILD_ISO=1`.

The current bundle intentionally stops before gates 3–9.
