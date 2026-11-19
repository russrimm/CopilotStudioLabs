// Builds synthetic PNGs for the placeholder-detection tests. No dependencies.
//
// The two placeholder families mirror the layouts of the scripts that write them:
//   lightPlaceholder  scripts/make_placeholders.py            (blue header bar, thin frame, centered glyph)
//   bandedMock        scripts/generate-lab4-screenshots.py    (header bar, second bar, flat body, footer bar)
// realFlatPage is a near-uniform page that is a real screenshot: it must never be called a placeholder.

import zlib from "node:zlib";

import { pngChunk } from "./png.mjs";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** An 8-bit RGB PNG whose pixels come from `pixel(x, y) -> [r, g, b]`. */
export function encodePng(width, height, pixel, { chunksBeforeData = [] } = {}) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  let at = 0;
  for (let y = 0; y < height; y += 1) {
    raw[at] = 0;
    at += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
      at += 3;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([PNG_MAGIC, pngChunk("IHDR", ihdr), ...chunksBeforeData, pngChunk("IDAT", zlib.deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

/** A tEXt chunk, for stamping or mislabeling an image. */
export function textChunk(keyword, value) {
  return pngChunk("tEXt", Buffer.concat([Buffer.from(keyword, "latin1"), Buffer.from([0]), Buffer.from(value, "latin1")]));
}

const inRect = (x, y, [x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
const onOutline = (x, y, [x0, y0, x1, y1], w) => inRect(x, y, [x0, y0, x1, y1]) && !inRect(x, y, [x0 + w, y0 + w, x1 - w, y1 - w]);

/** The blue-header placeholder. `frame: false` or a white `bar` makes it a look-alike that is not one. */
export function lightPlaceholder({ width = 1200, height = 675, body = [241, 245, 249], bar = [79, 143, 247], frameColor = [148, 163, 184], frame = true, text = [51, 65, 85], chunksBeforeData = [] } = {}) {
  const inset = 6;
  const barBottom = Math.round(height * 0.104);
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2) - 40;
  return encodePng(
    width,
    height,
    (x, y) => {
      if (inRect(x, y, [inset, inset, width - 1 - inset, barBottom])) {
        return inRect(x, y, [28, 26, 360, 48]) && (x + y) % 3 === 0 ? [255, 255, 255] : bar;
      }
      if (frame && onOutline(x, y, [inset, inset, width - 1 - inset, height - 1 - inset], 3)) return frameColor;
      if (onOutline(x, y, [cx - 90, cy - 55, cx + 90, cy + 55], 5)) return [100, 116, 139];
      if (inRect(x, y, [cx - 330, cy + 90, cx + 330, cy + 118]) && (x + y) % 4 === 0) return text;
      if (inRect(x, y, [cx - 260, cy + 135, cx + 260, cy + 155]) && (x * 3 + y) % 5 === 0) return [100, 116, 139];
      return body;
    },
    { chunksBeforeData },
  );
}

/** The dark "reference" mock-up: header bar, second bar, flat body with a panel outline, footer bar in the header color. */
export function bandedMock({ width = 1200, height = 700, header = [20, 22, 28], second = [35, 39, 50], body = [25, 28, 36], footer = null, footerHeight = 40, outline = [55, 62, 80] } = {}) {
  const footerColor = footer || header;
  return encodePng(width, height, (x, y) => {
    if (y < 48) return inRect(x, y, [16, 14, 190, 26]) && (x + y) % 3 === 0 ? [79, 143, 247] : header;
    if (y <= 92) return y === 92 ? outline : second;
    if (y >= height - footerHeight) return inRect(x, y, [16, height - 28, 220, height - 16]) && (x + y) % 3 === 0 ? [139, 143, 168] : footerColor;
    if (onOutline(x, y, [30, 120, width - 31, height - 51], 1)) return outline;
    if (inRect(x, y, [50, 170, 400, 182]) && (x + y) % 3 === 0) return [228, 230, 240];
    return body;
  });
}

/** A near-uniform real page: white header, pale body, a narrow rail, and a few lines of text. Not a placeholder. */
export function realFlatPage({ width = 1200, height = 675, header = [255, 255, 255], body = [250, 249, 248], rail = [243, 242, 241] } = {}) {
  return encodePng(width, height, (x, y) => {
    if (y < Math.round(height * 0.09)) return inRect(x, y, [20, 20, 200, 36]) && (x + y) % 3 === 0 ? [32, 31, 30] : header;
    if (x < 56) return rail;
    if (inRect(x, y, [90, 140, 700, 152]) && (x + y) % 3 === 0) return [50, 49, 48];
    if (inRect(x, y, [90, 200, 520, 212]) && (x + y) % 4 === 0) return [96, 94, 92];
    return body;
  });
}
