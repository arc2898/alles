#!/bin/sh
# Verify the review bundle without building or installing an image.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

required='README.md
config/bootstrap
config/binary
config/hooks/live/0100-osmiumos-calamares-overlay.hook.chroot
config/hooks/live/0110-osmium-customization.hook.chroot
config/calamares/etc/calamares/settings.conf
sources/debian/forky/InRelease
sources/debian/forky/Sources-main.xz
sources/calamares/upstream/calamares-3.4.3.tar.gz
sources/calamares/upstream/calamares-3.4.3.tar.gz.asc
assets/wallpapers/osmium.xml
MANIFEST.sha256'
printf '%s\n' "$required" | while IFS= read -r path; do
    [ -f "$path" ] || { echo "missing required file: $path" >&2; exit 1; }
done

# Verify the active Debian source metadata signature when the archive keyring
# is available on the reviewing host.
if [ -f /usr/share/keyrings/debian-archive-keyring.gpg ]; then
    gpgv --keyring /usr/share/keyrings/debian-archive-keyring.gpg \
        sources/debian/forky/InRelease >/dev/null 2>&1 || {
            echo "Forky InRelease signature verification failed" >&2
            exit 1
        }
else
    echo "warning: Debian archive keyring unavailable; signature check skipped" >&2
fi

# The original source checksum list is retained as provenance; the active
# bundle-wide manifest covers the review additions and current source files.
[ -f provenance/original-source-SHA256SUMS ]
sha256sum --check MANIFEST.sha256

# Basic structural checks for the review layer.
python3 - <<'PY'
from pathlib import Path
text_suffixes = {'.xml', '.conf', '.txt', '.desktop', '.list', '.sh', '.md', '.svg'}
for root in (Path('assets/wallpapers'), Path('config/osmium-overlay')):
    for path in root.rglob('*'):
        if path.is_file() and path.suffix in text_suffixes and '\u200b' in path.read_text(errors='ignore'):
            raise SystemExit(f'zero-width character found in {path}')
PY
for f in assets/wallpapers/osmium/tahoe-beach-day.png \
         assets/wallpapers/osmium/tahoe-beach-night.png \
         assets/wallpapers/osmium/golden-gate-26625.png \
         assets/plymouth/osmium/logo.png \
         assets/gnome-shell/extensions/ding@rastersoft.com/metadata.json \
         assets/grub/whitesur/icons/osmium.png; do
    [ -s "$f" ] || { echo "missing review asset: $f" >&2; exit 1; }
done

printf '%s\n' "Osmium OS source review bundle verified; no ISO was built."
