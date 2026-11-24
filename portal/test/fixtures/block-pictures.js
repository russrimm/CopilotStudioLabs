/**
 * Synthetic screenshots for the tests about pictures that show the wrong screen: gray blocks on white, drawn here, so no real screenshot,
 * name, or tenant is ever used. Each page has a different layout, so the fingerprint tells them apart; the same page drawn twice (or with
 * one tiny block added) is the same page.
 */

import zlib from "node:zlib";

import { pngChunk } from "../../../tools/screenshot-capture/test/fixtures/png.mjs";

/**
 * A 320 by 200 picture of gray blocks on white. The last rows are fixed noise, so the file is as big as a real screenshot.
 * `scale` draws the same layout larger (4 gives 1280 by 800), so a test can tell a thumbnail from the full-size view.
 */
export function blocks(rawShapes, { width: baseWidth = 320, height: baseHeight = 200, scale = 1 } = {}) {
  const width = baseWidth * scale;
  const height = baseHeight * scale;
  const shapes = rawShapes.map(({ x, y, w, h, gray }) => ({ x: x * scale, y: y * scale, w: w * scale, h: h * scale, gray }));
  const pixels = Buffer.alloc(width * height * 3, 0xff);
  const paint = ({ x, y, w, h, gray }) => {
    for (let row = y; row < Math.min(height, y + h); row += 1) for (let col = x; col < Math.min(width, x + w); col += 1) pixels.fill(gray, (row * width + col) * 3, (row * width + col) * 3 + 3);
  };
  shapes.forEach(paint);
  let a = 12345;
  for (let row = height - 16; row < height; row += 1) {
    for (let i = 0; i < width * 3; i += 1) {
      a = (Math.imul(a, 1103515245) + 12345) >>> 0;
      pixels[row * width * 3 + i] = (a >>> 16) & 0xff;
    }
  }
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let row = 0; row < height; row += 1) pixels.copy(raw, row * (1 + width * 3) + 1, row * width * 3, (row + 1) * width * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

export const CHROME = [
  { x: 0, y: 0, w: 320, h: 24, gray: 90 },
  { x: 0, y: 24, w: 60, h: 160, gray: 40 },
];
const CARDS = [
  { x: 80, y: 40, w: 70, h: 50, gray: 200 },
  { x: 160, y: 40, w: 70, h: 50, gray: 200 },
  { x: 240, y: 40, w: 70, h: 50, gray: 200 },
  { x: 80, y: 110, w: 230, h: 60, gray: 225 },
];

/** A start page: three cards in the main area. */
export const homePage = (options) => blocks([...CHROME, ...CARDS], options);
/** The same start page a moment later: one small thing changed (a tiny block). */
export const homePageLater = (options) => blocks([...CHROME, ...CARDS, { x: 100, y: 60, w: 12, h: 8, gray: 120 }], options);
/** A different screen of the same product: the same chrome, a different body. */
export const hubPage = (options) => blocks([...CHROME, { x: 70, y: 36, w: 120, h: 140, gray: 150 }, { x: 200, y: 36, w: 110, h: 60, gray: 235 }, { x: 200, y: 110, w: 110, h: 60, gray: 100 }], options);
/** Another screen of the same product again. */
export const formPage = (options) => blocks([...CHROME, { x: 70, y: 36, w: 240, h: 30, gray: 120 }, { x: 70, y: 80, w: 240, h: 30, gray: 120 }, { x: 70, y: 124, w: 240, h: 30, gray: 120 }], options);
/** A dialog over a dimmed page: one more layout, so four pictures can be told apart by shape alone. */
export const dialogPage = (options) => blocks([...CHROME, { x: 60, y: 24, w: 260, h: 176, gray: 170 }, { x: 100, y: 50, w: 180, h: 110, gray: 245 }, { x: 110, y: 130, w: 60, h: 20, gray: 60 }, { x: 210, y: 130, w: 60, h: 20, gray: 130 }], options);
