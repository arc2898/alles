#!/usr/bin/env bash
# Reproducible release entry point. Run on a network-enabled Linux build host.
# The generated .deb and AppImage bundle Electron + production dependencies;
# end users do NOT need Node.js or npm installed.
set -Eeuo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

fail() { printf 'ALLES release build: %s\n' "$*" >&2; exit 1; }
command -v node >/dev/null 2>&1 || fail 'Node.js 22.12+ is required on the build machine.'
command -v npm >/dev/null 2>&1 || fail 'npm is required only on the build machine.'
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)' || fail "Node.js 22.12+ required; found $(node -v)."

printf '\n[1/4] Installing exact locked dependencies (build machine only)\n'
npm ci
printf '\n[2/4] Running regression suite\n'
npm test
printf '\n[3/4] Checking source and launcher syntax\n'
while IFS= read -r -d '' file; do node --check "$file"; done < <(find src -type f \( -name '*.js' -o -name '*.cjs' \) -print0)
bash -n install.sh
sh -n packaging/alles
printf '\n[4/4] Packaging Debian .deb and AppImage (Electron runtime is bundled)\n'
npm run dist
shopt -s nullglob
DEBS=(dist/*.deb)
APPIMAGES=(dist/*.AppImage)
((${#DEBS[@]} > 0)) || fail 'electron-builder did not produce a .deb.'
((${#APPIMAGES[@]} > 0)) || fail 'electron-builder did not produce an AppImage.'
printf '\nRelease files:\n'
printf '  %s\n' "${DEBS[@]}" "${APPIMAGES[@]}"
printf '\nTarget installation does not use npm:\n'
printf '  sudo apt install ./%s\n' "$(basename "${DEBS[0]}")"
printf '  chmod +x %s && ./%s\n' "$(basename "${APPIMAGES[0]}")" "$(basename "${APPIMAGES[0]}")"
