import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { DEFAULTS, generate, readJson } from "../lib/build.mjs";

// features.json holds the Copilot Studio features, which are the ones the tour lists.
export const catalog = readJson(DEFAULTS.catalog);
export const overlay = readJson(DEFAULTS.overlay);

export function tmpDir(prefix = "feature-tour-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(zlib.crc32(body) >>> 0, 8 + data.length);
  return out;
}

// A valid, deliberately incompressible PNG that clears the 5 KB "real
// screenshot" threshold. It is a test fixture only and never written to the repo.
export function makePng(width = 120, height = 80) {
  const rows = [];
  let seed = 12345;
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let i = 1; i < row.length; i += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      row[i] = seed >> 16;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function build(screenshotsDir = tmpDir(), cat = catalog, ov = overlay) {
  return generate({ catalog: cat, overlay: ov, screenshotsDir });
}

export function stripUrls(text) {
  return text.replace(/https?:\/\/[^\s"'<>)]+/g, "");
}
