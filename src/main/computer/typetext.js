'use strict';

/**
 * prepareTypeText - decide EXACTLY what text may be handed to `ydotool type`.
 *
 * WHY THIS EXISTS (all three verified against the real ydotool 1.x client, commit 708e96f):
 *
 *  1. OUT-OF-BOUNDS READ. The client does `ascii2keycode_map[c]` where `c` is a plain
 *     (signed) `char` and the table has 128 entries. Any byte >= 0x80 - i.e. every
 *     non-ASCII character - indexes BEFORE the table and presses whatever key code
 *     happens to be in memory there. Observed: garbage codes (27936, 55182, ...) and
 *     stray SHIFT presses for "é" and "日本". So non-ASCII must never reach it.
 *
 *  2. Typographic characters are extremely common in model output (curly quotes, em
 *     dashes, ellipses, non-breaking spaces) and have unambiguous ASCII equivalents,
 *     so they are converted - and the conversion is REPORTED, never silent.
 *
 *  3. Anything else that cannot be typed is REJECTED with a message that names the
 *     characters, instead of being silently dropped. A model that is told what failed
 *     can pick another route (write_file, run_shell); one that is not will assume it
 *     typed the whole string.
 *
 * This is a pure function: no I/O, fully unit-tested, including a fuzz test that
 * asserts the output is ALWAYS inside the allowed set or an error is reported.
 */

// Characters with an unambiguous plain-ASCII equivalent.
const SUBSTITUTIONS = new Map([
  ['\u2018', "'"], ['\u2019', "'"], ['\u201A', "'"], ['\u201B', "'"], ['\u2032', "'"],   // curly single quotes, prime
  ['\u201C', '"'], ['\u201D', '"'], ['\u201E', '"'], ['\u201F', '"'], ['\u2033', '"'],   // curly double quotes, double prime
  ['\u2010', '-'], ['\u2011', '-'], ['\u2012', '-'], ['\u2013', '-'], ['\u2014', '-'],   // hyphen variants, en/em dash
  ['\u2015', '-'], ['\u2212', '-'],                                                       // horizontal bar, minus sign
  ['\u2026', '...'],                                                                      // ellipsis
  ['\u00A0', ' '], ['\u2002', ' '], ['\u2003', ' '], ['\u2009', ' '], ['\u202F', ' '],   // non-breaking / en / em / thin / narrow spaces
]);

// Invisible characters: removing them changes nothing the user can see.
const INVISIBLE = new Set(['\u200B', '\u2060', '\uFEFF']);   // zero-width space, word joiner, BOM

const MAX_LISTED = 5;

const isAllowed = (ch) => {
  const c = ch.codePointAt(0);
  return (c >= 0x20 && c <= 0x7e) || c === 0x0a || c === 0x09;   // printable ASCII, LF, TAB
};

const hex = (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

/** Show a character readably: control characters by name, everything else quoted. */
function show(ch) {
  const c = ch.codePointAt(0);
  if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return `control character ${hex(ch)}`;
  return `"${ch}" (${hex(ch)})`;
}

/**
 * @param {string} input
 * @returns {{
 *   text: string,                                   // safe to pass to ydotool (all chars allowed)
 *   replaced: {from:string,to:string,count:number}[],
 *   removed: number,                                // invisible characters dropped
 *   rejected: {ch:string,count:number}[],           // characters that cannot be typed (text is then unusable)
 *   notes: string[],                                // human-readable summary of what was changed
 * }}
 */
function prepareTypeText(input) {
  const src = String(input == null ? '' : input).replace(/\r\n?/g, '\n');   // CRLF and lone CR -> LF

  let out = '';
  let removed = 0;
  const replaced = new Map();
  const rejected = new Map();

  // for..of walks CODE POINTS, so an emoji is one character, not two surrogate halves.
  for (const ch of src) {
    if (isAllowed(ch)) { out += ch; continue; }
    if (INVISIBLE.has(ch)) { removed++; continue; }
    if (SUBSTITUTIONS.has(ch)) {
      const to = SUBSTITUTIONS.get(ch);
      out += to;
      const e = replaced.get(ch) || { from: ch, to, count: 0 };
      e.count++; replaced.set(ch, e);
      continue;
    }
    const r = rejected.get(ch) || { ch, count: 0 };
    r.count++; rejected.set(ch, r);
  }

  const notes = [];
  if (replaced.size) {
    const total = [...replaced.values()].reduce((n, e) => n + e.count, 0);
    const list = [...replaced.values()].slice(0, MAX_LISTED).map((e) => `${e.from} -> ${e.to}`).join(', ');
    notes.push(`converted ${total} typographic character(s) to plain equivalents (${list}${replaced.size > MAX_LISTED ? ', ...' : ''})`);
  }
  if (removed) notes.push(`removed ${removed} invisible character(s)`);

  return { text: out, replaced: [...replaced.values()], removed, rejected: [...rejected.values()], notes };
}

/** One clear, actionable sentence for the model (and the user) when text cannot be typed. */
function describeRejection(rejected) {
  const shown = rejected.slice(0, MAX_LISTED).map((r) => show(r.ch)).join(', ');
  const more = rejected.length > MAX_LISTED ? ` and ${rejected.length - MAX_LISTED} more` : '';
  return `Cannot type ${rejected.length} kind(s) of character with the keyboard tool: ${shown}${more}. `
    + 'The keyboard tool sends plain US-keyboard keys only (letters, digits, punctuation, space, Enter, Tab). '
    + 'Nothing was typed. Rewrite the text without those characters, or put the content in a file with write_file, or use run_shell.';
}

/**
 * prepareUnicodeText - the same question for a backend that can enter ANY text (GNOME direct input: what the keyboard cannot type
 * is pasted). Nothing is converted and nothing is removed - not even zero-width characters, because emoji sequences and several
 * scripts depend on them. Only what cannot be text at all is refused: control characters (except newline and tab) and lone
 * surrogates (broken UTF-16, which could not be pasted back as the same characters).
 *
 * Same result shape as prepareTypeText, so the caller treats both alike.
 */
function prepareUnicodeText(input) {
  const src = String(input == null ? '' : input).replace(/\r\n?/g, '\n');
  let out = '';
  const rejected = new Map();
  for (const ch of src) {
    const c = ch.codePointAt(0);
    const control = (c < 0x20 && c !== 0x0a && c !== 0x09) || (c >= 0x7f && c <= 0x9f);
    const brokenSurrogate = c >= 0xd800 && c <= 0xdfff;       // a half of a pair, on its own
    if (control || brokenSurrogate) {
      const r = rejected.get(ch) || { ch, count: 0 };
      r.count++; rejected.set(ch, r);
      continue;
    }
    out += ch;
  }
  return { text: out, replaced: [], removed: 0, rejected: [...rejected.values()], notes: [] };
}

function describeUnicodeRejection(rejected) {
  const shown = rejected.slice(0, MAX_LISTED).map((r) => (r.ch.codePointAt(0) >= 0xd800 && r.ch.codePointAt(0) <= 0xdfff ? `broken character ${hex(r.ch)}` : show(r.ch))).join(', ');
  const more = rejected.length > MAX_LISTED ? ` and ${rejected.length - MAX_LISTED} more` : '';
  return `Cannot enter ${rejected.length} kind(s) of character: ${shown}${more}. They are control characters, not text. Nothing was typed. Remove them and try again.`;
}

module.exports = { prepareTypeText, describeRejection, prepareUnicodeText, describeUnicodeRejection, SUBSTITUTIONS, INVISIBLE, isAllowed };
