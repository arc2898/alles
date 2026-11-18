'use strict';
/**
 * Looking at a screenshot the way a (very simple) vision model would: where is something of a known colour?
 * Runs under Electron (it uses nativeImage to read the PNG). Tests only.
 */
const { nativeImage } = require('electron');

/**
 * The bounding box of every pixel within `tol` of `rgb`, optionally only inside `rect` ({x, y, w, h} in the picture's pixels).
 * Returns { width, height } of the picture, and when something of that colour is there: x0, y0, x1, y1 (inclusive), w, h, cx, cy (the middle), n (pixels).
 */
function findColor(png, rgb, { tol = 3, rect = null } = {}) {
  const img = nativeImage.createFromBuffer(png);
  const { width, height } = img.getSize();
  const bmp = img.toBitmap();                                                      // blue, green, red, alpha for every pixel
  const xa = Math.max(0, Math.floor(rect ? rect.x : 0));
  const ya = Math.max(0, Math.floor(rect ? rect.y : 0));
  const xb = Math.min(width, Math.ceil(rect ? rect.x + rect.w : width));
  const yb = Math.min(height, Math.ceil(rect ? rect.y + rect.h : height));
  let x0 = 1e9; let y0 = 1e9; let x1 = -1; let y1 = -1; let n = 0;
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      const o = (y * width + x) * 4;
      if (Math.abs(bmp[o + 2] - rgb[0]) <= tol && Math.abs(bmp[o + 1] - rgb[1]) <= tol && Math.abs(bmp[o] - rgb[2]) <= tol) {
        n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (!n) return { width, height, n: 0 };
  return { width, height, n, x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

module.exports = { findColor };
