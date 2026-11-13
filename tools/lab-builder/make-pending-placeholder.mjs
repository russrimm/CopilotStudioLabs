// Writes the neutral "Screenshot pending" placeholder image that generated labs
// use until a real screenshot is captured over it.
//
//   node tools/lab-builder/make-pending-placeholder.mjs
//
// The image is plain black text on white: it shows no product UI, so it can never
// be mistaken for a real capture. It is a 1-bit PNG, a couple of hundred bytes,
// well under the 5 KB bar that tools/screenshot-capture and the feature tour use
// to tell a stub from a real screenshot, so every tool treats it as pending.
// The output is deterministic; regenerate it only if the design changes.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const WIDTH = 960;
const HEIGHT = 540;
const SCALE = 10;
const BORDER = 6;

const GLYPHS = {
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
};

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

export function buildPlaceholder() {
  const pixels = Array.from({ length: HEIGHT }, () => new Uint8Array(WIDTH).fill(1));
  const ink = (x, y) => {
    if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) pixels[y][x] = 0;
  };

  for (let i = 0; i < BORDER; i += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      ink(x, i);
      ink(x, HEIGHT - 1 - i);
    }
    for (let y = 0; y < HEIGHT; y += 1) {
      ink(i, y);
      ink(WIDTH - 1 - i, y);
    }
  }

  const drawLine = (text, top) => {
    const glyphWidth = 6 * SCALE;
    const left = Math.floor((WIDTH - (text.length * glyphWidth - SCALE)) / 2);
    [...text].forEach((letter, index) => {
      GLYPHS[letter].forEach((row, y) => {
        [...row].forEach((cell, x) => {
          if (cell !== "1") return;
          for (let dy = 0; dy < SCALE; dy += 1) {
            for (let dx = 0; dx < SCALE; dx += 1) ink(left + index * glyphWidth + x * SCALE + dx, top + y * SCALE + dy);
          }
        });
      });
    });
  };
  drawLine("SCREENSHOT", 160);
  drawLine("PENDING", 300);

  const rowBytes = Math.ceil(WIDTH / 8);
  const raw = Buffer.alloc((rowBytes + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    const base = y * (rowBytes + 1);
    raw[base] = 0;
    for (let x = 0; x < WIDTH; x += 1) {
      if (pixels[y][x]) raw[base + 1 + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 1; // bit depth
  header[9] = 0; // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../portal/lib/lab-builder/assets/screenshot-pending.png");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const png = buildPlaceholder();
  fs.writeFileSync(target, png);
  console.log(`Wrote ${path.relative(process.cwd(), target)} (${png.length} bytes)`);
}
