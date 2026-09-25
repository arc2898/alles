#!/bin/sh
# Fast, non-destructive review checks.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

[ "$(grep -c '^LB_DISTRIBUTION=' config/bootstrap)" -eq 1 ]
grep -q '^LB_DISTRIBUTION="forky"$' config/bootstrap
grep -q '^LB_DISTRIBUTION_CHROOT="forky"$' config/bootstrap
grep -q 'RELEASE="forky"' config/calamares/usr/share/calamares/helpers/calamares-sources-media
grep -q 'RELEASE="forky"' config/calamares/usr/share/calamares/helpers/calamares-sources-final
grep -q "branding: osmiumos" config/calamares/etc/calamares/settings.conf
grep -q "arcmenu@arcmenu.com" config/osmium-overlay/etc/dconf/db/osmium.d/00-osmium-extensions
grep -q "ding@rastersoft.com" config/osmium-overlay/etc/dconf/db/osmium.d/00-osmium-extensions
! grep -q "apps-menu@" config/osmium-overlay/etc/dconf/db/osmium.d/00-osmium-extensions
! grep -q "GdmSettings" config/osmium-overlay/etc/dconf/db/osmium.d/00-osmium-extensions
! grep -q 'osmium-macos' config/osmium-overlay/etc/dconf/db/osmium.d/00-osmium-extensions

sh -n scripts/build-iso.sh
sh -n scripts/capture-target-environment.sh
sh -n config/hooks/live/0100-osmiumos-calamares-overlay.hook.chroot
sh -n config/hooks/live/0110-osmium-customization.hook.chroot

printf '%s\n' 'Source structure checks passed.'
