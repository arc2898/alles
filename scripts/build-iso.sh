#!/bin/sh
# Deliberately gated ISO build entry point.
# This script is included for review only; it does not build an ISO by default.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

if [ "${OSMIUM_BUILD_ISO:-0}" != "1" ]; then
    cat >&2 <<'EOF'
ISO build refused.

Review the source and pass the explicit gate only after the Calamares package,
VM boot test, installer test, and release checks are approved:

    OSMIUM_BUILD_ISO=1 ./scripts/build-iso.sh
EOF
    exit 2
fi

for cmd in lb debootstrap xorriso; do
    command -v "$cmd" >/dev/null 2>&1 || {
        echo "missing build command: $cmd" >&2
        exit 1
    }
done

if [ ! -f config/archives/calamares_*.deb ]; then
    echo "No locally built Calamares package is staged in config/archives/." >&2
    echo "Build and test Calamares before enabling the ISO gate." >&2
    exit 1
fi

mkdir -p build
exec lb build
