#!/usr/bin/env python3
"""
Generates src/main/computer/keyboard-layout-data.js: for every keyboard layout (and variant) xkeyboard-config knows, which printable
ASCII characters GNOME's remote-input service can NOT type for us by keysym.

WHY: GNOME's remote-input service types a character by looking its keysym up in the active layout. What it then does is simple, and
that simplicity is what goes wrong (all of it measured on a real GNOME Shell 46, see scripts/gnome-e2e/input-flow.cjs, scenario F):

  1. It takes the FIRST key (lowest keycode) that has the keysym on ANY level - not the best one. On a British keyboard "<" is
     Shift+comma, but the Z key carries it too, on its fourth level (Shift+AltGr), and Z comes first.
  2. It can press only three levels: none, Shift, and AltGr (ISO_Level3_Shift). A keysym found on a higher level is sent as the bare
     key: "<" types "z", a quote types a dead accent, "^" types "6".
  3. A keysym that is not on any key types nothing (dead keys are not the plain character: German has no plain ^ or `).
  4. A key whose keycode is above 255 (the odd media and "currency" keys some layouts put a character on, such as the dollar sign in
     the Russian layout) cannot be seen by X11 applications at all, whatever the level: the character never arrives there.

So "can this layout make this character" is not "does the layout have it". This script replays the service's choice with libxkbcommon
(the library the desktop itself uses): for every character it finds that first key and level, presses the modifiers the service would
press, asks libxkbcommon what the key then produces, and only calls the character typeable when that is the character itself.
Everything else is pasted from the clipboard by ALLES, which is slower but always right.

Run it on a machine with xkb-data and libxkbcommon installed (every GNOME desktop has both):   python3 scripts/gen-layout-data.py
        python3 scripts/gen-layout-data.py --explain gb '<>^'      shows the key, the level and the result for those characters
The generated file is checked in, so users never need any of this. Layout ids it does not list fall back to a cautious guess made
from the layout's name (keyboard-layout.js).
"""
import ctypes
import ctypes.util
import os
import subprocess
import sys

XKB = os.environ.get('XKB_ROOT', '/usr/share/X11/xkb')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'main', 'computer', 'keyboard-layout-data.js')

MAX_X11_KEYCODE = 255                 # X11 has room for keycodes 8..255 only
SHIFT_L = 0xFFE1
LEVEL3 = 0xFE03                       # ISO_Level3_Shift: the AltGr of most layouts
ALL = [chr(c) for c in range(0x20, 0x7F)]
WANTED = {ord(c) for c in ALL} | {SHIFT_L, LEVEL3}

if os.path.isdir(XKB):
    os.environ.setdefault('XKB_CONFIG_ROOT', XKB)
lib = ctypes.CDLL(ctypes.util.find_library('xkbcommon') or 'libxkbcommon.so.0')
c_void_p, c_uint32, c_int, c_char_p = ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_char_p


class RuleNames(ctypes.Structure):
    _fields_ = [('rules', c_char_p), ('model', c_char_p), ('layout', c_char_p), ('variant', c_char_p), ('options', c_char_p)]


def sig(name, restype, *argtypes):
    f = getattr(lib, name)
    f.restype = restype
    f.argtypes = list(argtypes)
    return f


context_new = sig('xkb_context_new', c_void_p, c_int)
keymap_new = sig('xkb_keymap_new_from_names', c_void_p, c_void_p, ctypes.POINTER(RuleNames), c_int)
keymap_unref = sig('xkb_keymap_unref', None, c_void_p)
min_key = sig('xkb_keymap_min_keycode', c_uint32, c_void_p)
max_key = sig('xkb_keymap_max_keycode', c_uint32, c_void_p)
num_levels = sig('xkb_keymap_num_levels_for_key', c_uint32, c_void_p, c_uint32, c_uint32)
syms_by_level = sig('xkb_keymap_key_get_syms_by_level', c_int, c_void_p, c_uint32, c_uint32, c_uint32, ctypes.POINTER(ctypes.POINTER(c_uint32)))
state_new = sig('xkb_state_new', c_void_p, c_void_p)
state_unref = sig('xkb_state_unref', None, c_void_p)
state_update_key = sig('xkb_state_update_key', c_int, c_void_p, c_uint32, c_int)
state_one_sym = sig('xkb_state_key_get_one_sym', c_uint32, c_void_p, c_uint32)

CTX = context_new(0)


def compile_layout(layout_id):
    layout, _, variant = layout_id.partition('+')
    names = RuleNames(b'evdev', b'pc105', layout.encode(), variant.encode() if variant else None, None)
    return keymap_new(CTX, ctypes.byref(names), 0)


def first_places(km):
    """
    For every wanted keysym: (keycode, level) of the first key, in keycode order, that has it on any level of the first group.
    Also returns how many keys carry any symbol at all (a keymap that compiled to nothing sensible must not be recorded).
    """
    first = {}
    keys = 0
    ptr = ctypes.POINTER(c_uint32)()
    for kc in range(min_key(km), max_key(km) + 1):
        has_any = False
        for level in range(num_levels(km, kc, 0)):
            n = syms_by_level(km, kc, 0, level, ctypes.byref(ptr))
            for i in range(n):
                sym = ptr[i]
                has_any = True
                if sym in WANTED and sym not in first:
                    first[sym] = (kc, level)
        keys += has_any
    return first, keys


def produced(km, first, ch):
    """What the service ends up typing for `ch`: (keycode, level, keysym produced, level handled?) or None when no key has it."""
    sym = ord(ch)
    if sym not in first:
        return None
    kc, level = first[sym]
    if kc > MAX_X11_KEYCODE:
        return kc, level, 0, False                 # sent, but an X11 application never hears of such a key
    st = state_new(km)
    try:
        handled = True
        if level == 1:
            if SHIFT_L in first:
                state_update_key(st, first[SHIFT_L][0], 1)
            else:
                handled = False
        elif level == 2:
            if LEVEL3 in first:
                state_update_key(st, first[LEVEL3][0], 1)
            else:
                handled = False
        elif level > 2:
            handled = False                      # the service has no modifier for level 4 and up: it presses the bare key
        got = state_one_sym(st, kc)
    finally:
        state_unref(st)
    return kc, level, got, handled


def typeable(km):
    """The printable ASCII characters the service really types on this keymap, and how many character keys it has."""
    first, keys = first_places(km)
    have = set()
    for ch in ALL:
        r = produced(km, first, ch)
        if r is not None and r[2] == ord(ch):
            have.add(ch)
    return have, keys


def read_rules():
    section = ''
    layouts, variants = [], []
    with open(os.path.join(XKB, 'rules', 'evdev.lst'), encoding='utf-8') as f:
        for line in f:
            line = line.rstrip('\n')
            if line.startswith('!'):
                section = line[1:].strip().split()[0]
                continue
            parts = line.split()
            if section == 'layout' and parts:
                layouts.append(parts[0])
            elif section == 'variant' and len(parts) >= 2 and parts[1].endswith(':'):
                variants.append((parts[1][:-1], parts[0]))      # (layout, variant): "  nodeadkeys   de: German (no dead keys)"

    return layouts, variants


def explain(layout_id, chars):
    km = compile_layout(layout_id)
    if not km:
        print(f'{layout_id}: does not compile here')
        return
    first, _ = first_places(km)
    for ch in chars:
        r = produced(km, first, ch)
        if r is None:
            print(f'{ch!r}: no key has it -> types nothing')
        else:
            kc, level, got, handled = r
            names = {SHIFT_L: 'Shift_L', LEVEL3: 'ISO_Level3_Shift'}
            why = '' if handled else (' (X11 applications cannot see a key above 255)' if kc > MAX_X11_KEYCODE else ' (the service cannot press that level)')
            print(f'{ch!r}: first on key {kc} (evdev {kc - 8}), level {level}{why} -> keysym {got:#x}{" = OK" if got == ord(ch) else " = WRONG"}')
    keymap_unref(km)


def version(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        return 'unknown'


def js(s):
    out = ['"']
    for ch in s:
        out.append({'"': '\\"', '\\': '\\\\'}.get(ch, ch))
    out.append('"')
    return ''.join(out)


def main():
    layouts, variants = read_rules()
    ids = layouts + [f'{l}+{v}' for l, v in variants]
    missing, complete, failed = {}, [], []
    for n, layout_id in enumerate(ids, 1):
        km = compile_layout(layout_id)
        if not km:
            failed.append(layout_id)
            continue
        have, keys_with_symbols = typeable(km)
        keymap_unref(km)
        if keys_with_symbols < 30:
            failed.append(layout_id)               # nothing sensible was compiled: do not record a wrong answer
            continue
        miss = ''.join(c for c in ALL if c not in have)
        if miss:
            missing[layout_id] = miss
        else:
            complete.append(layout_id)
        if n % 200 == 0:
            print(f'  {n}/{len(ids)}', file=sys.stderr)
    xkb_data = version(['dpkg-query', '-W', '-f=${Version}', 'xkb-data'])
    xkbc = version(['dpkg-query', '-W', '-f=${Version}', 'libxkbcommon0'])
    keys = sorted(missing)
    complete.sort()
    body = '\n'.join(f'    {js(k)}: {js(missing[k])},' for k in keys)
    lines, cur = [], '   '
    for c in complete:
        piece = f' {js(c)},'
        if len(cur) + len(piece) > 120:
            lines.append(cur)
            cur = '   '
        cur += piece
    if cur.strip():
        lines.append(cur)
    complete_body = '\n'.join(lines)
    failed_note = f', or one that would not compile here: {", ".join(failed)}' if failed else ''
    text = f"""'use strict';

// GENERATED by scripts/gen-layout-data.py from xkb-data {xkb_data} and libxkbcommon {xkbc} - do not edit by hand.
//
// What GNOME's remote-input service can really TYPE on each keyboard layout (ids as GNOME names them: "us", "de", "de+nodeadkeys", "in+eng").
// That is less than "what the layout has": the service takes the first key that carries a character on any level and can only press the
// levels none, Shift and AltGr, so a character that lives on Shift+AltGr, or behind a dead key, comes out as another key or as nothing.
// The script replays that choice; the real GNOME Shell test (scripts/gnome-e2e/input-flow.cjs, scenario F) checks the answers.
//   MISSING   layouts that cannot type every printable ASCII character: id -> the characters they cannot type (ALLES pastes these)
//   COMPLETE  layouts that can type all of them
// A layout in neither list was not checked (a variant newer than this table{failed_note}); keyboard-layout.js then guesses from its name.
// {len(ids) - len(failed)} layouts and variants checked: {len(complete)} complete, {len(keys)} with gaps.
module.exports = {{
  VERSION: {js(xkb_data)},
  MISSING: {{
{body}
  }},
  COMPLETE: [
{complete_body}
  ],
}};
"""
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(text)
    shown = ', '.join(failed[:12]) + (', ...' if len(failed) > 12 else '')
    print(f'wrote {os.path.normpath(OUT)}: {len(keys)} of {len(ids)} layouts listed; {len(failed)} failed' + (f' ({shown})' if failed else ''), file=sys.stderr)


if __name__ == '__main__':
    if len(sys.argv) >= 2 and sys.argv[1] == '--explain':
        explain(sys.argv[2], sys.argv[3])
    else:
        main()
