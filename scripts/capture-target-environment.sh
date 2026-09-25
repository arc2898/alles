#!/bin/sh
# Capture the non-secret, system-wide customization snapshot used by this
# source review. It never copies the complete home directory or data disks.
set -eu

OUT=${1:-"$(pwd)/target-snapshot"}
ROOT_UUID=480aedeb-f29a-4a01-8880-f75e7aee3127
ESP_UUID=C187-71CE

root_src=$(blkid -t LABEL=osmium-root -o device)
esp_src=$(blkid -t LABEL=OSMIUMESP -o device)
[ "$(blkid -s UUID -o value "$root_src")" = "$ROOT_UUID" ] || {
    echo "unexpected osmium-root UUID" >&2; exit 1; }
[ "$(blkid -s UUID -o value "$esp_src")" = "$ESP_UUID" ] || {
    echo "unexpected OSMIUMESP UUID" >&2; exit 1; }

T=/mnt/osmium
created_mount=0
if ! mountpoint -q "$T"; then
    mkdir -p "$T"
    mount -t ext4 -o ro "$root_src" "$T"
    created_mount=1
fi
cleanup() {
    if [ "$created_mount" -eq 1 ]; then umount "$T" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

mkdir -p "$OUT"
copy_one() {
    src=$1
    dst=$2
    if [ -e "$T/$src" ]; then
        mkdir -p "$OUT/$(dirname "$dst")"
        cp -a "$T/$src" "$OUT/$dst"
    fi
}

copy_one etc/os-release etc/os-release
copy_one etc/debian_version etc/debian_version
copy_one etc/default/grub etc/default/grub
copy_one etc/plymouth/plymouthd.conf etc/plymouth/plymouthd.conf
copy_one etc/dconf/profile/user etc/dconf/profile/user
copy_one etc/dconf/db/osmium.d/00-osmium-extensions etc/dconf/db/osmium.d/00-osmium-extensions
copy_one etc/skel/.zshrc etc/skel/.zshrc
copy_one etc/skel/.config etc/skel/.config
copy_one home/user/.zshrc home/user/.zshrc
copy_one home/user/.face home/user/.face
copy_one var/lib/AccountsService/users/user var/lib/AccountsService/users/user
copy_one var/lib/AccountsService/icons/user var/lib/AccountsService/icons/user
copy_one usr/local/bin/fastfetch usr/local/bin/fastfetch
copy_one usr/local/sbin/osmium-extensions usr/local/sbin/osmium-extensions
copy_one usr/share/gnome-background-properties/osmium.xml usr/share/gnome-background-properties/osmium.xml
copy_one usr/share/pixmaps/osmium-logo.svg usr/share/pixmaps/osmium-logo.svg
copy_one usr/share/pixmaps/osmium-os-mark.png usr/share/pixmaps/osmium-os-mark.png

mkdir -p "$OUT/locks"
chroot "$T" dpkg-query -W -f='${binary:Package}\t${Version}\n' 2>/dev/null |
    sort > "$OUT/locks/target-dpkg-packages.tsv"

printf 'Captured non-secret target snapshot in %s\n' "$OUT"
