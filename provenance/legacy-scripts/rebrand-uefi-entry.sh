#!/usr/bin/env bash
set -Eeuo pipefail

BACKUP=/root/osmium-third-pass-backup-20260924/efibootmgr-before.txt
DEVICE=/dev/sdb
PARTITION=4
LOADER='\EFI\debian\grubx64.efi'
LABEL='Osmium OS'

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ -b "$DEVICE" ]] || fail "$DEVICE is unavailable"
[[ -b "${DEVICE}${PARTITION}" ]] || fail "${DEVICE}${PARTITION} is unavailable"
command -v efibootmgr >/dev/null || fail 'efibootmgr is unavailable'

efibootmgr -v > "$BACKUP"

existing_ids() {
  efibootmgr -v | awk -v label="$LABEL" \
    '$0 ~ ("^Boot[0-9A-F][0-9A-F][0-9A-F][0-9A-F]\\* " label "([ \\t]|$)") { print substr($1, 5, 4) }'
}

entry_line() {
  local id=$1
  efibootmgr -v | awk -v id="$id" '$1 == ("Boot" id "*") { print; exit }'
}

valid_entry() {
  local id=$1 line
  line=$(entry_line "$id")
  [[ -n "$line" ]] || return 1
  [[ "$line" == *"HD(${PARTITION},GPT,"* ]] || return 1
  [[ "$line" == *'grubx64.efi'* ]] || return 1
  [[ "$line" != *'grubx64.efi0009'* ]]
}

mapfile -t old_osmium_ids < <(existing_ids)
new_id=
for id in "${old_osmium_ids[@]}"; do
  if valid_entry "$id"; then
    new_id=$id
    break
  fi
done

if [[ -z "$new_id" ]]; then
  # Remove only stale/malformed entries bearing our label.  The old Debian
  # label remains untouched until the replacement has been verified.
  for id in "${old_osmium_ids[@]}"; do
    efibootmgr -b "$id" -B || true
  done
  efibootmgr -c --index=0 -L "$LABEL" -d "$DEVICE" -p "$PARTITION" -l "$LOADER"
  new_id=$(existing_ids | head -n 1)
fi

[[ -n "$new_id" ]] || fail 'efibootmgr did not create an Osmium OS entry'
valid_entry "$new_id" || fail 'the new Osmium OS entry does not use the full ESP path'

old_id=$(efibootmgr -v | awk \
  '$0 ~ /^Boot[0-9A-F][0-9A-F][0-9A-F][0-9A-F]\* Debian 14 GNOME 50([ \t]|$)/ { print substr($1, 5, 4); exit }')
if [[ -n "$old_id" && "$old_id" != "$new_id" ]]; then
  efibootmgr -b "$old_id" -B
fi

order=$(efibootmgr -v | sed -n 's/^BootOrder: //p' | head -n 1)
new_order=$new_id
if [[ -n "$order" ]]; then
  IFS=',' read -r -a order_ids <<< "$order"
  for id in "${order_ids[@]}"; do
    [[ -n "$id" ]] || continue
    [[ "$id" == "$new_id" ]] && continue
    [[ -n "$old_id" && "$id" == "$old_id" ]] && continue
    new_order+=",$id"
  done
fi
efibootmgr -o "$new_order"
efibootmgr -n "$new_id"

final=$(efibootmgr -v)
grep -Eq '^BootOrder: '"$new_id"'(,|$)' <<< "$final" || fail 'Osmium OS is not first in BootOrder'
grep -q '^BootNext: '"$new_id"'$' <<< "$final" || fail 'BootNext does not point to Osmium OS'
grep -q 'Boot[0-9A-F][0-9A-F][0-9A-F][0-9A-F]\* Osmium OS' <<< "$final" || fail 'Osmium OS label is missing'
if grep -q 'Debian 14 GNOME 50' <<< "$final"; then
  fail 'stale Debian 14 GNOME 50 UEFI label remains'
fi

printf 'UEFI Osmium OS entry created or reused, verified, and ordered first.\n'
printf 'Boot entry: %s\n' "$new_id"
printf 'BootOrder: %s\n' "$new_order"
