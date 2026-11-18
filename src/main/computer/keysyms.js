'use strict';

/**
 * Keysyms: the numbers a desktop uses for "the letter a", "the key Enter" ... independent of where the key sits on a keyboard.
 *
 * WHY: GNOME's remote-input service takes either a KEY CODE (a place on the keyboard: "the key left of S") or a KEYSYM
 * (what the key should produce: "a"). Measured on a real GNOME Shell 46: with a German layout the place-based "Z" key
 * produces "y", with a French one "w" - but a keysym "z" produces "z" on every layout that has one. So text, and the letter
 * or punctuation key of a shortcut, goes by keysym; keys that are the same on every keyboard (Enter, Tab, arrows, F-keys,
 * Ctrl, Shift ...) go by code.
 */

// The keys of the main block that carry a character, by the names in keymap.js, and the keysym of the character they make
// WITHOUT Shift (a shortcut like Ctrl+Shift+T names the plain key and holds Shift itself).
const CHARACTER_KEYS = {
  space: 0x20, minus: 0x2d, equal: 0x3d, leftbrace: 0x5b, rightbrace: 0x5d, semicolon: 0x3b,
  apostrophe: 0x27, grave: 0x60, backslash: 0x5c, comma: 0x2c, dot: 0x2e, slash: 0x2f,
};

/** The keysym of a key NAME (as keymap.js spells it) when that key is a letter, digit or punctuation key; else null. */
function keysymForKey(canon) {
  if (typeof canon !== 'string') return null;
  if (/^[a-z]$/.test(canon) || /^[0-9]$/.test(canon)) return canon.charCodeAt(0);
  return Object.prototype.hasOwnProperty.call(CHARACTER_KEYS, canon) ? CHARACTER_KEYS[canon] : null;
}

/** Printable ASCII: the characters every Latin keyboard layout can make. For these the keysym IS the character code. */
const isPlainAscii = (ch) => { const c = ch.codePointAt(0); return c >= 0x20 && c <= 0x7e; };

module.exports = { CHARACTER_KEYS, keysymForKey, isPlainAscii };
