'use strict';
const zlib = require('node:zlib');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function crc32(buf) {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { let c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A valid w x h truecolor PNG filled with one colour. Used by the provider probe (a known-colour test image). */
function solidPng(w, h, [r, g, b]) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}
/**
 * A valid w x h truecolor PNG that is ONE colour with a little noise on it (one sample in seven is one step off). A flat colour
 * compresses to almost nothing, and a real screenshot does not: this is about as heavy as one (1280x720 comes out near 400 KB).
 * The noise is made by a fixed formula, so the same call always gives the same bytes. Used to test that a provider takes a picture
 * of the size ALLES really sends.
 */
function noisyPng(w, h, [r, g, b], seed = 1) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const base = [r, g, b];
  let s = seed >>> 0;
  const next = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 24; };       // 0..255 (the high bits are the good ones)
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w * 3; x++) {
      const n = next();
      const v = base[x % 3] + (n < 218 ? 0 : (n & 1 ? 1 : -1));
      row[1 + x] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    rows.push(row);
  }
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
module.exports = { solidPng, noisyPng };
