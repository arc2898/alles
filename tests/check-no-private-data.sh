#!/bin/sh
# Reject obvious private/host-specific material from the review bundle.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

if find provenance config -type f \( \
    -name 'id_rsa*' -o -name 'id_ed25519*' -o -name '*cookies*' -o \
    -name '*.kdbx' -o -name '*.pem' -o -name '*.key' -o \
    -name 'machine-id' -o -name '*.journal' \) -print -quit | grep -q .; then
    echo 'possible private/host-specific file found' >&2
    exit 1
fi

if grep -RIl --exclude='*.png' --exclude='*.jpg' --exclude='*.jpeg' \
    --exclude='*.xz' --exclude='*.gz' --exclude='*.tar' \
    -E 'OPENSSH PRIVATE KEY|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY' \
    provenance config >/dev/null 2>&1; then
    echo 'private-key marker found' >&2
    exit 1
fi

printf '%s\n' 'No obvious private key or host-runtime data found.'
