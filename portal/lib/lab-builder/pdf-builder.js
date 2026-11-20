/**
 * Pure-Node Adobe PDF 1.4 (.pdf) builder for generated lab guides and modules.
 *
 * Zero npm packages: uses only Node.js `node:zlib` and `node:buffer` to build a
 * spec-compliant `%PDF-1.4` binary with multi-page US Letter layout, Standard
 * Type1 fonts (`Helvetica`, `Helvetica-Bold`, `Helvetica-Oblique`, `Courier`),
 * safe Unicode-to-WinAnsi normalization, styled headings, numbered steps,
 * checklists, bordered tables, callout boxes, embedded PNG/JPEG images, running
 * headers/footers (`Page X of Y`), and an exact byte-offset `xref` table.
 */

import { deflateSync, inflateSync } from "node:zlib";
import {
  ARCHITECTURE_FENCE_LANG,
  renderArchitectureDocumentMarkdown,
} from "./architecture-overview.js";
import { cleanText, getBrandFont } from "./brand-theme.js";
import { stripEmbeddedHtml } from "./html-fragments.js";
import { isSubStepStart, normalizeSubSteps, subStepLabel, takeSubSteps } from "./sub-steps.js";

const PAGE_WIDTH = 612; // 8.5 in * 72 pt
const PAGE_HEIGHT = 792; // 11.0 in * 72 pt
const MARGIN_X = 50;
const MARGIN_TOP = 58;
const MARGIN_BOTTOM = 54;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2; // 512 pt

const UNICODE_REPLACEMENTS = new Map([
  ["\u2018", "\x91"], // ‘
  ["\u2019", "\x92"], // ’
  ["\u201C", "\x93"], // “
  ["\u201D", "\x94"], // ”
  ["\u2022", "\x95"], // •
  ["\u2013", "\x96"], // –
  ["\u2014", "\x97"], // —
  ["\u2026", "\x85"], // …
  ["\u2122", "\x99"], // ™
  ["\u20AC", "\x80"], // €
  ["\u00A0", " "],
  ["\u2192", "->"],
  ["\u2190", "<-"],
  ["\u2194", "<->"],
  ["\u2610", "[ ]"],
  ["\u2611", "[x]"],
  ["\u2713", "[x]"],
  ["\u2714", "[x]"],
  ["\u2705", "[PASS]"],
  ["\u274C", "[FAIL]"],
  ["\u26A0", "[!]"],
  ["\u2B50", "*"],
  ["\u23F1", ""],
  ["\uFE0F", ""],
]);

const WINANSI_EXTENDED_CODES = new Set([0x80, 0x85, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x99]);

/**
 * Normalize arbitrary UTF-8 Markdown prose to single-byte WinAnsi characters so
 * Type1 PDF text operators never render garbled bytes. Idempotent if called
 * again on already-normalized WinAnsi tokens.
 */
function toWinAnsiString(raw) {
  const input = String(raw ?? "");
  let out = "";
  for (const ch of input) {
    if (UNICODE_REPLACEMENTS.has(ch)) {
      out += UNICODE_REPLACEMENTS.get(ch);
      continue;
    }
    const code = ch.codePointAt(0);
    if (code === 0x09) {
      out += "  ";
    } else if (code >= 0x20 && code <= 0x7e) {
      out += ch;
    } else if ((code >= 0xa0 && code <= 0xff) || WINANSI_EXTENDED_CODES.has(code)) {
      out += String.fromCharCode(code);
    } else if (code > 0xff) {
      // Skip unsupported emoji/pictographs cleanly instead of emitting '?' noise.
      continue;
    }
  }
  return out;
}

/**
 * Escape a WinAnsi string as a PDF literal `(...)` byte string.
 */
function pdfLiteralString(text) {
  const win = toWinAnsiString(text);
  let escaped = "(";
  for (let i = 0; i < win.length; i += 1) {
    const code = win.charCodeAt(i);
    if (code === 0x28) escaped += "\\(";
    else if (code === 0x29) escaped += "\\)";
    else if (code === 0x5c) escaped += "\\\\";
    else if (code < 0x20 || code > 0x7e) {
      escaped += `\\${code.toString(8).padStart(3, "0")}`;
    } else {
      escaped += win[i];
    }
  }
  escaped += ")";
  return escaped;
}

function parseHexRgb(hex, fallback = [0.102, 0.337, 0.78]) {
  const m = String(hex || "").trim().match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!m) return fallback;
  let raw = m[1];
  if (raw.length === 3) raw = `${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`;
  const r = parseInt(raw.slice(0, 2), 16) / 255;
  const g = parseInt(raw.slice(2, 4), 16) / 255;
  const b = parseInt(raw.slice(4, 6), 16) / 255;
  return [Number(r.toFixed(3)), Number(g.toFixed(3)), Number(b.toFixed(3))];
}

function measureCharWidthFactor(ch, fontKey) {
  if (fontKey === "F4") return 0.6; // Monospace Courier
  if ("il.,:;|!I'’`".includes(ch)) return 0.28;
  if ("ftrj()[]{}-".includes(ch)) return 0.36;
  if ("mwMW@%&QGO".includes(ch)) return 0.82;
  if (ch >= "A" && ch <= "Z") return 0.68;
  return fontKey === "F2" ? 0.56 : 0.52;
}

function measureTextPt(text, fontSize, fontKey = "F1") {
  const win = toWinAnsiString(text);
  let sum = 0;
  for (let i = 0; i < win.length; i += 1) {
    sum += measureCharWidthFactor(win[i], fontKey) * fontSize;
  }
  return sum;
}

function parseInlineSegments(rawText, defaultStyle = "regular") {
  const cleanedImages = String(rawText ?? "").replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_m, alt) => `[Figure: ${alt || "screenshot"}]`,
  );

  const tokenRe =
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|`([^`\n]+)`|\*\*([^*]+)\*\*|(?<!\*)\*([^*\n]+)\*(?!\*)/g;
  const segments = [];
  let lastIdx = 0;
  let match;

  const pushPlain = (txt, style, href = null) => {
    const unescaped = txt.replace(/\\([\\`*_[\]<>|~#+-])/g, "$1");
    if (unescaped) segments.push(href ? { text: unescaped, style, href } : { text: unescaped, style });
  };

  while ((match = tokenRe.exec(cleanedImages)) !== null) {
    if (match.index > lastIdx) {
      pushPlain(cleanedImages.slice(lastIdx, match.index), defaultStyle);
    }
    if (match[1] !== undefined && match[2] !== undefined) {
      const label = match[1].replace(/[*_`]/g, "");
      const rawHref = match[2].trim();
      const safeHref = /^https?:\/\/|^mailto:/i.test(rawHref) ? rawHref : null;
      pushPlain(label, defaultStyle, safeHref);
    } else if (match[3] !== undefined) pushPlain(match[3], "code");
    // Emphasis can wrap a link, so its content is parsed as inline Markdown rather than drawn as plain text.
    else if (match[4] !== undefined) segments.push(...parseInlineSegments(match[4], "bold"));
    else if (match[5] !== undefined) segments.push(...parseInlineSegments(match[5], "italic"));
    lastIdx = tokenRe.lastIndex;
  }
  if (lastIdx < cleanedImages.length) {
    pushPlain(cleanedImages.slice(lastIdx), defaultStyle);
  }
  return segments;
}

function fontForStyle(style) {
  if (style === "bold") return "F2";
  if (style === "italic") return "F3";
  if (style === "code") return "F4";
  return "F1";
}

/**
 * Split inline Markdown text on explicit `<br>` / `<br/>` tags while preserving
 * literal `<br>` inside inline backtick code spans or backslash-escaped `\<br>`.
 */
function splitHtmlLineBreaks(rawText) {
  const input = String(rawText ?? "");
  if (!/<br\s*\/?>/i.test(input)) return [input];
  const codeSpans = [];
  const masked = input.replace(/`[^`\n]+`/g, (span) => {
    const token = `\u0000C${codeSpans.length}\u0000`;
    codeSpans.push(span);
    return token;
  });
  return masked
    .split(/(?<!\\)<br\s*\/?>/gi)
    .map((part) => part.replace(/\u0000C(\d+)\u0000/g, (_m, idx) => codeSpans[Number(idx)] ?? "").trim());
}

function wrapInlineMarkdown(rawText, defaultStyle, fontSize, maxWidthPt) {
  const logicalLines = splitHtmlLineBreaks(rawText);
  if (logicalLines.length <= 1) {
    return wrapSegments(parseInlineSegments(rawText, defaultStyle), fontSize, maxWidthPt);
  }
  const allWrapped = [];
  for (const logicalLine of logicalLines) {
    if (!logicalLine) {
      allWrapped.push([]);
      continue;
    }
    const wrapped = wrapSegments(parseInlineSegments(logicalLine, defaultStyle), fontSize, maxWidthPt);
    if (wrapped.length) {
      allWrapped.push(...wrapped);
    } else {
      allWrapped.push([]);
    }
  }
  return allWrapped;
}

/**
 * Word-wrap styled inline segments into lines constrained to `maxWidthPt`.
 */
function wrapSegments(segments, fontSize, maxWidthPt) {
  const tokens = [];
  for (const seg of segments) {
    const fontKey = fontForStyle(seg.style);
    const parts = toWinAnsiString(seg.text).split(/(\s+)/);
    for (const part of parts) {
      if (!part) continue;
      tokens.push({
        text: part,
        style: seg.style,
        fontKey,
        href: seg.href || null,
        isSpace: /^\s+$/.test(part),
      });
    }
  }

  const lines = [];
  let current = [];
  let currentWidth = 0;

  const flush = () => {
    while (current.length && current[current.length - 1].isSpace) current.pop();
    if (current.length) lines.push(current);
    current = [];
    currentWidth = 0;
  };

  for (const tok of tokens) {
    if (!current.length && tok.isSpace) continue;
    const size = tok.style === "code" ? Math.max(8, fontSize - 0.8) : fontSize;
    const width = measureTextPt(tok.text, size, tok.fontKey);

    if (current.length && currentWidth + width > maxWidthPt) {
      flush();
      if (tok.isSpace) continue;
    }

    // Hard-break single ultra-long tokens (such as URLs or identifiers) so they never overflow margins.
    if (width > maxWidthPt && tok.text.length > 8) {
      const approxChars = Math.max(8, Math.floor((maxWidthPt / width) * tok.text.length) - 1);
      let rest = tok.text;
      while (rest.length > 0) {
        const slice = rest.slice(0, approxChars);
        rest = rest.slice(approxChars);
        const sliceW = measureTextPt(slice, size, tok.fontKey);
        if (current.length && currentWidth + sliceW > maxWidthPt) flush();
        current.push({ ...tok, text: slice, size, width: sliceW });
        currentWidth += sliceW;
        if (rest.length > 0) flush();
      }
      continue;
    }

    current.push({ ...tok, size, width });
    currentWidth += width;
  }

  flush();
  return lines.length ? lines : [[{ text: " ", style: "regular", fontKey: "F1", size: fontSize, width: 0 }]];
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decode a JPEG or 8-bit non-interlaced PNG Buffer into a PDF Image XObject descriptor.
 */
function preparePdfImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;

  // JPEG (DCTDecode)
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let pos = 2;
    while (pos + 9 < buf.length) {
      if (buf[pos] !== 0xff) {
        pos += 1;
        continue;
      }
      const marker = buf[pos + 1];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        pos += 2;
        continue;
      }
      if (pos + 4 > buf.length) break;
      const segLen = buf.readUInt16BE(pos + 2);
      if (segLen < 2 || pos + 2 + segLen > buf.length) break;
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        const bits = buf[pos + 4];
        const height = buf.readUInt16BE(pos + 5);
        const width = buf.readUInt16BE(pos + 7);
        const components = buf[pos + 9];
        if (bits === 8 && width > 0 && height > 0 && (components === 1 || components === 3)) {
          return {
            width,
            height,
            colorSpace: components === 1 ? "/DeviceGray" : "/DeviceRGB",
            bitsPerComponent: 8,
            filter: "/DCTDecode",
            streamData: buf,
          };
        }
        return null;
      }
      pos += 2 + segLen;
    }
    return null;
  }

  // PNG (8-bit RGB, RGBA, or Grayscale, non-interlaced)
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    try {
      let offset = 8;
      let width = 0;
      let height = 0;
      let bitDepth = 0;
      let colorType = 0;
      let interlace = 0;
      const idatChunks = [];

      while (offset + 8 <= buf.length) {
        const len = buf.readUInt32BE(offset);
        const type = buf.toString("ascii", offset + 4, offset + 8);
        const dataStart = offset + 8;
        const dataEnd = dataStart + len;
        if (dataEnd + 4 > buf.length) break;

        if (type === "IHDR") {
          width = buf.readUInt32BE(dataStart);
          height = buf.readUInt32BE(dataStart + 4);
          bitDepth = buf[dataStart + 8];
          colorType = buf[dataStart + 9];
          interlace = buf[dataStart + 12];
        } else if (type === "IDAT") {
          idatChunks.push(buf.subarray(dataStart, dataEnd));
        } else if (type === "IEND") {
          break;
        }
        offset = dataEnd + 4;
      }

      if (
        !width ||
        !height ||
        bitDepth !== 8 ||
        interlace !== 0 ||
        ![0, 2, 6].includes(colorType) ||
        !idatChunks.length ||
        width * height > 12_000_000
      ) {
        return null;
      }

      const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
      const stride = width * bpp;
      const inflated = inflateSync(Buffer.concat(idatChunks));
      if (inflated.length < height * (stride + 1)) return null;

      const unfiltered = Buffer.alloc(height * stride);
      for (let y = 0; y < height; y += 1) {
        const srcRow = y * (stride + 1);
        const filterType = inflated[srcRow];
        const dstRow = y * stride;
        const prevRow = (y - 1) * stride;

        for (let x = 0; x < stride; x += 1) {
          const raw = inflated[srcRow + 1 + x];
          const a = x >= bpp ? unfiltered[dstRow + x - bpp] : 0;
          const b = y > 0 ? unfiltered[prevRow + x] : 0;
          const c = x >= bpp && y > 0 ? unfiltered[prevRow + x - bpp] : 0;
          let recon = raw;
          if (filterType === 1) recon = (raw + a) & 0xff;
          else if (filterType === 2) recon = (raw + b) & 0xff;
          else if (filterType === 3) recon = (raw + ((a + b) >> 1)) & 0xff;
          else if (filterType === 4) recon = (raw + paethPredictor(a, b, c)) & 0xff;
          unfiltered[dstRow + x] = recon;
        }
      }

      let pixelData = unfiltered;
      let colorSpace = colorType === 0 ? "/DeviceGray" : "/DeviceRGB";
      if (colorType === 6) {
        // Composite RGBA onto white so PDF renders crisp screenshots without separate SMask objects.
        const rgb = Buffer.alloc(width * height * 3);
        for (let p = 0, j = 0; p < unfiltered.length; p += 4, j += 3) {
          const alpha = unfiltered[p + 3] / 255;
          rgb[j] = Math.round(unfiltered[p] * alpha + 255 * (1 - alpha));
          rgb[j + 1] = Math.round(unfiltered[p + 1] * alpha + 255 * (1 - alpha));
          rgb[j + 2] = Math.round(unfiltered[p + 2] * alpha + 255 * (1 - alpha));
        }
        pixelData = rgb;
        colorSpace = "/DeviceRGB";
      }

      return {
        width,
        height,
        colorSpace,
        bitsPerComponent: 8,
        filter: "/FlateDecode",
        streamData: deflateSync(pixelData, { level: 6 }),
      };
    } catch {
      return null;
    }
  }

  return null;
}

function splitTableCells(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, "|").trim());
}

/**
 * Render a Markdown document into a complete multi-page `%PDF-1.4` Buffer.
 *
 * @param {string} markdown
 * @param {object} [options]
 * @param {string} [options.title]
 * @param {object} [options.branding] `{ companyName, tagline, primaryColor, secondaryColor, font, coverSubtitle, footerText }`
 * @param {(src: string) => Buffer | null} [options.resolveImageBuffer]
 * @returns {Buffer}
 */
export function renderMarkdownToPdfBuffer(markdown, options = {}) {
  const accentRgb = parseHexRgb(options.branding?.primaryColor, [0.102, 0.337, 0.78]);
  const secondaryRgb = options.branding?.secondaryColor ? parseHexRgb(options.branding.secondaryColor, null) : null;
  const useSerifFont = getBrandFont(options.branding?.font).pdf === "serif";
  const footerText = cleanText(options.branding?.footerText);
  const coverSubtitle = cleanText(options.branding?.coverSubtitle);
  const docTitle = String(options.title || "Lab Guide").trim();
  const pages = [];
  const pageAnnots = [];
  const xObjects = new Map(); // cache key -> { name, img }
  let currentOps = [];
  let currentAnnots = [];
  let cursorY = PAGE_HEIGHT - MARGIN_TOP;

  const startNewPage = () => {
    if (currentOps.length) {
      pages.push(currentOps);
      pageAnnots.push(currentAnnots);
    }
    currentOps = [];
    currentAnnots = [];
    cursorY = PAGE_HEIGHT - MARGIN_TOP;
  };

  const ensureSpace = (neededPt) => {
    if (cursorY - neededPt < MARGIN_BOTTOM) {
      startNewPage();
    }
  };

  const drawWrappedLine = (lineTokens, x, baselineY, defaultColor = [0.1, 0.13, 0.18]) => {
    let curX = x;
    for (const tok of lineTokens) {
      if (tok.style === "code" && !tok.isSpace) {
        currentOps.push(
          `q 0.93 0.95 0.97 rg ${(curX - 1.5).toFixed(2)} ${(baselineY - 2.5).toFixed(2)} ${(tok.width + 3).toFixed(
            2,
          )} ${(tok.size + 3.5).toFixed(2)} re f Q`,
        );
      }
      const [r, g, b] = tok.href ? accentRgb : defaultColor;
      currentOps.push(
        `BT /${tok.fontKey} ${tok.size.toFixed(2)} Tf ${r} ${g} ${b} rg ${curX.toFixed(2)} ${baselineY.toFixed(
          2,
        )} Td ${pdfLiteralString(tok.text)} Tj ET`,
      );
      if (tok.href && tok.width > 0) {
        if (!tok.isSpace) {
          currentOps.push(
            `q ${r} ${g} ${b} RG 0.55 w ${curX.toFixed(2)} ${(baselineY - 1.3).toFixed(2)} m ${(
              curX + tok.width
            ).toFixed(2)} ${(baselineY - 1.3).toFixed(2)} l S Q`,
          );
        }
        const prev = currentAnnots[currentAnnots.length - 1];
        if (prev && prev.uri === tok.href && Math.abs(prev.baselineY - baselineY) < 0.5 && Math.abs(prev.x2 - curX) < 3) {
          prev.x2 = curX + tok.width;
        } else if (!tok.isSpace) {
          currentAnnots.push({
            uri: tok.href,
            baselineY,
            x1: curX,
            y1: baselineY - 2,
            x2: curX + tok.width,
            y2: baselineY + tok.size + 1,
          });
        }
      }
      curX += tok.width;
    }
  };

  const emitStyledParagraph = (rawText, opts = {}) => {
    const fontSize = opts.fontSize || 10;
    const lineHeight = opts.lineHeight || fontSize * 1.42;
    const indentLeft = opts.indentLeft || 0;
    const prefix = opts.prefix || "";
    const prefixWidth = prefix ? measureTextPt(prefix, fontSize, "F2") + 4 : 0;
    const availWidth = Math.max(80, CONTENT_WIDTH - indentLeft - prefixWidth - (opts.padRight || 0));
    const wrapped = wrapInlineMarkdown(rawText, opts.style || "regular", fontSize, availWidth);
    const color = opts.color || [0.1, 0.13, 0.18];

    if (opts.spaceBefore) {
      cursorY -= opts.spaceBefore;
    }

    if (opts.callout) {
      const boxHeight = wrapped.length * lineHeight + 10;
      ensureSpace(boxHeight + 6);
      const topY = cursorY;
      currentOps.push(
        `q 0.955 0.97 0.992 rg ${MARGIN_X.toFixed(2)} ${(topY - boxHeight).toFixed(2)} ${CONTENT_WIDTH.toFixed(
          2,
        )} ${boxHeight.toFixed(2)} re f ${accentRgb[0]} ${accentRgb[1]} ${accentRgb[2]} rg ${MARGIN_X.toFixed(2)} ${(
          topY - boxHeight
        ).toFixed(2)} 3.2 ${boxHeight.toFixed(2)} re f Q`,
      );
      cursorY -= 5;
    }

    wrapped.forEach((lineTokens, idx) => {
      ensureSpace(lineHeight + 2);
      const baselineY = cursorY - fontSize;
      if (idx === 0 && prefix) {
        currentOps.push(
          `BT /F2 ${fontSize.toFixed(2)} Tf ${color[0]} ${color[1]} ${color[2]} rg ${(MARGIN_X + indentLeft).toFixed(
            2,
          )} ${baselineY.toFixed(2)} Td ${pdfLiteralString(prefix)} Tj ET`,
        );
      }
      drawWrappedLine(lineTokens, MARGIN_X + indentLeft + prefixWidth, baselineY, color);
      cursorY -= lineHeight;
    });

    if (opts.callout) cursorY -= 5;
    if (opts.underlineColor) {
      const [ur, ug, ub] = opts.underlineColor;
      currentOps.push(
        `q ${ur} ${ug} ${ub} RG 0.8 w ${MARGIN_X.toFixed(2)} ${(cursorY + 2).toFixed(2)} m ${(
          MARGIN_X + CONTENT_WIDTH
        ).toFixed(2)} ${(cursorY + 2).toFixed(2)} l S Q`,
      );
    }
    cursorY -= opts.spaceAfter ?? 5;
  };

  // Opt-in brand logo above the banner (other exports keep the text-only banner).
  if (options.drawLogo && options.branding?.logoBuffer) {
    const logo = preparePdfImage(options.branding.logoBuffer);
    if (logo) {
      const drawH = Math.min(34, logo.height * 0.75, (150 * logo.height) / logo.width);
      const drawW = (drawH * logo.width) / logo.height;
      const entry = { name: `Im${xObjects.size + 1}`, img: logo };
      xObjects.set("__brand-logo__", entry);
      currentOps.push(`q ${drawW.toFixed(2)} 0 0 ${drawH.toFixed(2)} ${MARGIN_X.toFixed(2)} ${(cursorY - drawH).toFixed(2)} cm /${entry.name} Do Q`);
      cursorY -= drawH + 8;
    }
  }

  // Optional branding banner at top of Page 1
  if (options.branding && (options.branding.companyName || options.branding.tagline)) {
    const label = [options.branding.companyName, options.branding.tagline].filter(Boolean).join(" — ");
    emitStyledParagraph(label, {
      fontSize: 10.5,
      style: "bold",
      color: accentRgb,
      underlineColor: secondaryRgb || [0.82, 0.86, 0.92],
      spaceAfter: coverSubtitle ? 4 : 10,
    });
    if (coverSubtitle) {
      emitStyledParagraph(coverSubtitle, {
        fontSize: 9.5,
        style: "italic",
        color: [0.29, 0.33, 0.4],
        spaceAfter: 10,
      });
    }
  }

  const renderMarkdownBlocks = (mdText, nestedOpts = {}) => {
    const lines = String(mdText ?? "").replace(/\r\n/g, "\n").split("\n");
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i += 1;
        continue;
      }

      // Fenced code block
      const fenceMatch = line.match(/^\s*(`{3,}|~{3,})\s*([a-zA-Z0-9_-]*)\s*$/);
      if (fenceMatch) {
        const fence = fenceMatch[1];
        const lang = fenceMatch[2];
        const closeRe = new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`);
        const codeLines = [];
        i += 1;
        while (i < lines.length && !closeRe.test(lines[i])) {
          codeLines.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) i += 1;
        if (String(lang || "").trim().toLowerCase() === ARCHITECTURE_FENCE_LANG) {
          const archMd = renderArchitectureDocumentMarkdown(codeLines.join("\n"));
          if (archMd) {
            renderMarkdownBlocks(archMd, nestedOpts);
            continue;
          }
        }

        const codeSize = 8.5;
        const codeLineH = 11.5;
        const wrappedCode = [];
        const maxChars = Math.floor((CONTENT_WIDTH - 18) / (0.6 * codeSize));
        for (const rawCl of codeLines) {
          const cl = toWinAnsiString(rawCl);
          if (!cl.length) {
            wrappedCode.push("");
            continue;
          }
          for (let pos = 0; pos < cl.length; pos += maxChars) {
            wrappedCode.push(cl.slice(pos, pos + maxChars));
          }
        }

        cursorY -= 3;
        let idx = 0;
        while (idx < wrappedCode.length) {
          ensureSpace(codeLineH + 14);
          const availLines = Math.max(1, Math.floor((cursorY - MARGIN_BOTTOM - 10) / codeLineH));
          const chunk = wrappedCode.slice(idx, idx + availLines);
          const boxH = chunk.length * codeLineH + 10;
          currentOps.push(
            `q 0.965 0.973 0.982 rg 0.82 0.85 0.89 RG 0.6 w ${MARGIN_X.toFixed(2)} ${(cursorY - boxH).toFixed(
              2,
            )} ${CONTENT_WIDTH.toFixed(2)} ${boxH.toFixed(2)} re B Q`,
          );
          cursorY -= 5;
          for (const cl of chunk) {
            const baselineY = cursorY - codeSize;
            currentOps.push(
              `BT /F4 ${codeSize.toFixed(2)} Tf 0.14 0.18 0.24 rg ${(MARGIN_X + 8).toFixed(2)} ${baselineY.toFixed(
                2,
              )} Td ${pdfLiteralString(cl)} Tj ET`,
            );
            cursorY -= codeLineH;
          }
          cursorY -= 9;
          idx += chunk.length;
        }
        continue;
      }

      // Expandable <details> block
      if (/^\s*<details>\s*$/i.test(line)) {
        i += 1;
        let summaryText = "Additional Guidance";
        if (i < lines.length) {
          const sumMatch = lines[i].match(/^\s*<summary>([\s\S]*?)<\/summary>\s*$/i);
          if (sumMatch) {
            summaryText = sumMatch[1].trim();
            i += 1;
          }
        }
        const innerLines = [];
        let depth = 1;
        while (i < lines.length && depth > 0) {
          if (/^\s*<details>\s*$/i.test(lines[i])) depth += 1;
          else if (/^\s*<\/details>\s*$/i.test(lines[i])) {
            depth -= 1;
            if (depth === 0) {
              i += 1;
              break;
            }
          }
          innerLines.push(lines[i]);
          i += 1;
        }
        emitStyledParagraph(summaryText, {
          fontSize: 10,
          style: "bold",
          color: accentRgb,
          callout: true,
          indentLeft: 10,
          padRight: 8,
          spaceBefore: 4,
          spaceAfter: 2,
        });
        renderMarkdownBlocks(innerLines.join("\n"), { callout: true });
        cursorY -= 4;
        continue;
      }

      // Standalone image line `![alt](src)`
      const imgLineMatch = line.trim().match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/);
      if (imgLineMatch) {
        const alt = imgLineMatch[1];
        const src = imgLineMatch[2];
        const imgBuf =
          typeof options.resolveImageBuffer === "function" ? options.resolveImageBuffer(src) : null;
        let xObjEntry = xObjects.get(src);
        if (!xObjEntry && imgBuf) {
          const decoded = preparePdfImage(imgBuf);
          if (decoded) {
            xObjEntry = { name: `Im${xObjects.size + 1}`, img: decoded };
            xObjects.set(src, xObjEntry);
          }
        }
        if (xObjEntry) {
          const maxW = CONTENT_WIDTH * 0.92;
          const maxH = 260;
          const scale = Math.min(maxW / xObjEntry.img.width, maxH / xObjEntry.img.height, 0.75);
          const drawW = Math.max(80, xObjEntry.img.width * scale);
          const drawH = Math.max(40, xObjEntry.img.height * scale);
          ensureSpace(drawH + 18);
          cursorY -= 4;
          const imgX = MARGIN_X;
          const imgBottomY = cursorY - drawH;
          currentOps.push(
            `q ${drawW.toFixed(2)} 0 0 ${drawH.toFixed(2)} ${imgX.toFixed(2)} ${imgBottomY.toFixed(2)} cm /${
              xObjEntry.name
            } Do Q`,
            `q 0.75 0.8 0.86 RG 0.6 w ${imgX.toFixed(2)} ${imgBottomY.toFixed(2)} ${drawW.toFixed(2)} ${drawH.toFixed(
              2,
            )} re S Q`,
          );
          cursorY = imgBottomY - 6;
        } else {
          emitStyledParagraph(`[Figure: ${alt || src}]`, {
            fontSize: 9,
            style: "italic",
            color: [0.35, 0.4, 0.48],
            callout: true,
            indentLeft: 10,
            spaceAfter: 4,
          });
        }
        i += 1;
        continue;
      }

      // ATX Heading
      const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);
      if (headingMatch) {
        const level = Math.min(4, headingMatch[1].length);
        const text = headingMatch[2];
        if (level === 1) {
          ensureSpace(44);
          emitStyledParagraph(text, {
            fontSize: 18,
            lineHeight: 24,
            style: "bold",
            color: accentRgb,
            underlineColor: accentRgb,
            spaceBefore: 4,
            spaceAfter: 10,
          });
        } else if (level === 2) {
          ensureSpace(options.keepHeadingWithNext ? 120 : 34);
          emitStyledParagraph(text, {
            fontSize: 13.5,
            lineHeight: 18.5,
            style: "bold",
            color: accentRgb,
            underlineColor: [0.84, 0.88, 0.93],
            spaceBefore: 10,
            spaceAfter: 6,
          });
        } else if (level === 3) {
          ensureSpace(28);
          emitStyledParagraph(text, {
            fontSize: 11.5,
            lineHeight: 16,
            style: "bold",
            color: [0.12, 0.16, 0.23],
            spaceBefore: 8,
            spaceAfter: 4,
          });
        } else {
          ensureSpace(24);
          emitStyledParagraph(text, {
            fontSize: 10.5,
            lineHeight: 14.5,
            style: "bold",
            color: [0.2, 0.25, 0.33],
            spaceBefore: 6,
            spaceAfter: 3,
          });
        }
        i += 1;
        continue;
      }

      // Horizontal rule
      if (/^\s*(?:[-*_]\s*){3,}\s*$/.test(line)) {
        ensureSpace(14);
        cursorY -= 4;
        currentOps.push(
          `q 0.82 0.86 0.9 RG 0.7 w ${MARGIN_X.toFixed(2)} ${cursorY.toFixed(2)} m ${(MARGIN_X + CONTENT_WIDTH).toFixed(
            2,
          )} ${cursorY.toFixed(2)} l S Q`,
        );
        cursorY -= 8;
        i += 1;
        continue;
      }

      // Pipe table
      if (
        line.includes("|") &&
        i + 1 < lines.length &&
        /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(lines[i + 1])
      ) {
        const headers = splitTableCells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
          rows.push(splitTableCells(lines[i]));
          i += 1;
        }
        const colCount = Math.max(1, headers.length);
        // Opt-in column weights (for example { 5: [6, 40, 14, 26, 14] }); every other table keeps equal columns.
        const weights = options.tableColumnWeights?.[colCount];
        const weightTotal = Array.isArray(weights) && weights.length === colCount ? weights.reduce((a, b) => a + b, 0) : 0;
        const colWidths = weightTotal > 0 ? weights.map((w) => (w / weightTotal) * CONTENT_WIDTH) : Array.from({ length: colCount }, () => CONTENT_WIDTH / colCount);
        const colOffsets = colWidths.map((_w, idx) => colWidths.slice(0, idx).reduce((a, b) => a + b, 0));
        const cellFontSize = colCount >= 5 ? 8.2 : 9;
        const cellLineH = cellFontSize * 1.35;

        const drawTableRow = (cells, isHeader) => {
          const cellLines = headers.map((_h, idx) =>
            wrapInlineMarkdown(
              cells[idx] ?? "",
              isHeader ? "bold" : "regular",
              cellFontSize,
              Math.max(40, colWidths[idx] - 10),
            ),
          );
          const maxLines = Math.max(1, ...cellLines.map((cl) => cl.length));
          const maxLinesPerPage = Math.max(
            10,
            Math.floor((PAGE_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM - 14) / cellLineH),
          );

          for (let offset = 0; offset < maxLines; offset += maxLinesPerPage) {
            const sliceCount = Math.min(maxLinesPerPage, maxLines - offset);
            const rowH = sliceCount * cellLineH + 8;
            const pagesBefore = pages.length;
            ensureSpace(rowH + 4);
            if (options.repeatTableHeader && !isHeader && pages.length !== pagesBefore) drawTableRow(headers, true);
            const topY = cursorY;
            const bottomY = topY - rowH;

            if (isHeader) {
              currentOps.push(
                `q 0.925 0.945 0.98 rg ${MARGIN_X.toFixed(2)} ${bottomY.toFixed(2)} ${CONTENT_WIDTH.toFixed(
                  2,
                )} ${rowH.toFixed(2)} re f Q`,
              );
            }

            currentOps.push(
              `q 0.78 0.82 0.88 RG 0.6 w ${MARGIN_X.toFixed(2)} ${bottomY.toFixed(2)} ${CONTENT_WIDTH.toFixed(
                2,
              )} ${rowH.toFixed(2)} re S Q`,
            );

            for (let c = 0; c < colCount; c += 1) {
              const cellX = MARGIN_X + colOffsets[c];
              if (c > 0) {
                currentOps.push(
                  `q 0.85 0.88 0.92 RG 0.5 w ${cellX.toFixed(2)} ${bottomY.toFixed(2)} m ${cellX.toFixed(
                    2,
                  )} ${topY.toFixed(2)} l S Q`,
                );
              }
              if (options.drawCheckboxCells && !isHeader && String(cells[c] ?? "").trim() === "\u2610") {
                const boxX = cellX + (colWidths[c] - 10) / 2;
                currentOps.push(`q 0.2 0.25 0.33 RG 1 w ${boxX.toFixed(2)} ${(topY - 17).toFixed(2)} 10 10 re S Q`);
                continue;
              }
              const linesInCell = cellLines[c].slice(offset, offset + sliceCount);
              linesInCell.forEach((lt, lIdx) => {
                const baselineY = topY - 4 - cellFontSize - lIdx * cellLineH;
                drawWrappedLine(lt, cellX + 5, baselineY);
              });
            }

            cursorY = bottomY;
          }
        };

        cursorY -= 3;
        drawTableRow(headers, true);
        for (const r of rows) drawTableRow(r, false);
        cursorY -= 7;
        continue;
      }

      // Blockquote
      if (/^\s*>\s?/.test(line)) {
        const quoteLines = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
          i += 1;
        }
        renderMarkdownBlocks(quoteLines.join("\n"), { callout: true });
        continue;
      }

      // Unordered / task list
      if (/^\s*[-*+]\s+/.test(line)) {
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          let itemText = lines[i].replace(/^\s*[-*+]\s+/, "");
          i += 1;
          while (
            i < lines.length &&
            lines[i].trim() &&
            !/^\s*(?:[-*+]|\d+\.)\s+/.test(lines[i]) &&
            !/^(?:#{1,6}\s+|```|~~~|>\s?|<details>|\s*(?:[-*_]\s*){3,})/i.test(lines[i])
          ) {
            itemText += ` ${lines[i].trim()}`;
            i += 1;
          }
          const taskMatch = itemText.match(/^\[([ xX])\]\s+([\s\S]*)$/);
          if (taskMatch) {
            const box = taskMatch[1].toLowerCase() === "x" ? "[x]" : "[ ]";
            emitStyledParagraph(taskMatch[2], {
              fontSize: 9.8,
              indentLeft: nestedOpts.callout ? 14 : 10,
              prefix: box,
              callout: nestedOpts.callout,
              spaceAfter: 3,
            });
          } else {
            emitStyledParagraph(itemText, {
              fontSize: 9.8,
              indentLeft: nestedOpts.callout ? 14 : 10,
              prefix: "\x95",
              callout: nestedOpts.callout,
              spaceAfter: 3,
            });
          }
        }
        cursorY -= 2;
        continue;
      }

      // Ordered list
      if (/^\s*\d+\.\s+/.test(line)) {
        let stepNum = 1;
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          let itemText = lines[i].replace(/^\s*\d+\.\s+/, "");
          i += 1;
          while (
            i < lines.length &&
            lines[i].trim() &&
            !/^\s*(?:[-*+]|\d+\.)\s+/.test(lines[i]) &&
            !/^(?:#{1,6}\s+|```|~~~|>\s?|<details>|\s*(?:[-*_]\s*){3,})/i.test(lines[i]) &&
            !isSubStepStart(lines, i)
          ) {
            itemText += ` ${lines[i].trim()}`;
            i += 1;
          }
          const sub = takeSubSteps(lines, i);
          i = sub.next;
          const stepIndent = nestedOpts.callout ? 14 : 10;
          emitStyledParagraph(itemText, {
            fontSize: 9.8,
            indentLeft: stepIndent,
            prefix: `${stepNum}.`,
            callout: nestedOpts.callout,
            spaceAfter: sub.items.length ? 2 : 4,
          });
          sub.items.forEach((text, subIndex) => {
            emitStyledParagraph(text, {
              fontSize: 9.6,
              indentLeft: stepIndent + 18,
              prefix: `${subStepLabel(subIndex)}.`,
              callout: nestedOpts.callout,
              spaceAfter: subIndex === sub.items.length - 1 && !sub.note ? 4 : 2,
            });
          });
          if (sub.note) {
            emitStyledParagraph(sub.note, {
              fontSize: 9.2,
              indentLeft: stepIndent + 18,
              style: "italic",
              callout: nestedOpts.callout,
              spaceAfter: 4,
            });
          }
          stepNum += 1;
        }
        cursorY -= 3;
        continue;
      }

      // Paragraph
      const paraLines = [line.trim()];
      i += 1;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^(?:#{1,6}\s+|\s*(`{3,}|~{3,})|\s*>\s?|\s*[-*+]\s+|\s*\d+\.\s+|\s*<details>|\s*(?:[-*_]\s*){3,}\s*$)/i.test(
          lines[i],
        ) &&
        !(
          lines[i].includes("|") &&
          i + 1 < lines.length &&
          /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(lines[i + 1])
        )
      ) {
        paraLines.push(lines[i].trim());
        i += 1;
      }
      emitStyledParagraph(paraLines.join(" "), {
        fontSize: 10,
        callout: nestedOpts.callout,
        indentLeft: nestedOpts.callout ? 10 : 0,
        padRight: nestedOpts.callout ? 8 : 0,
        spaceAfter: 6,
      });
    }
  };

  renderMarkdownBlocks(stripEmbeddedHtml(normalizeSubSteps(markdown)));
  if (currentOps.length || !pages.length) {
    pages.push(currentOps);
    pageAnnots.push(currentAnnots);
  }

  // Assemble PDF 1.4 objects
  // 1: Catalog, 2: Info, 3: Pages, 4..7: Fonts F1..F4
  const objects = [];
  const addObject = (body) => {
    objects.push(body);
    return objects.length; // 1-based PDF object id
  };

  addObject(""); // placeholder 1: Catalog
  addObject(""); // placeholder 2: Info
  addObject(""); // placeholder 3: Pages
  const f1Id = addObject(`<< /Type /Font /Subtype /Type1 /BaseFont /${useSerifFont ? "Times-Roman" : "Helvetica"} /Encoding /WinAnsiEncoding >>`);
  const f2Id = addObject(`<< /Type /Font /Subtype /Type1 /BaseFont /${useSerifFont ? "Times-Bold" : "Helvetica-Bold"} /Encoding /WinAnsiEncoding >>`);
  const f3Id = addObject(`<< /Type /Font /Subtype /Type1 /BaseFont /${useSerifFont ? "Times-Italic" : "Helvetica-Oblique"} /Encoding /WinAnsiEncoding >>`);
  const f4Id = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");

  const xObjIds = [];
  for (const { name, img } of xObjects.values()) {
    const dict = `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace ${img.colorSpace} /BitsPerComponent ${img.bitsPerComponent} /Filter ${img.filter} /Length ${img.streamData.length} >>`;
    const id = addObject({ dict, stream: img.streamData });
    xObjIds.push(`/${name} ${id} 0 R`);
  }

  const xObjectDict = xObjIds.length ? ` /XObject << ${xObjIds.join(" ")} >>` : "";
  const resourcesDict = `<< /Font << /F1 ${f1Id} 0 R /F2 ${f2Id} 0 R /F3 ${f3Id} 0 R /F4 ${f4Id} 0 R >>${xObjectDict} >>`;

  const pageIds = [];
  const totalPages = pages.length;
  const headerLabel = docTitle.length > 78 ? `${docTitle.slice(0, 75)}...` : docTitle;

  pages.forEach((ops, idx) => {
    const pageNum = idx + 1;
    const footerLeft =
      typeof options.footerLabel === "string" && options.footerLabel
        ? options.footerLabel
        : [options.branding?.companyName || "Copilot Studio Labs", footerText].filter(Boolean).join("  |  ");
    const footerMaxWidth = CONTENT_WIDTH - 70;
    let footerLabel = footerLeft;
    while (footerLabel.length > 4 && measureTextPt(footerLabel, 8, "F1") > footerMaxWidth) {
      footerLabel = `${footerLabel.slice(0, -4)}...`;
    }
    const footerRule = secondaryRgb || [0.85, 0.88, 0.92];
    const hfOps = [
      // Top thin accent bar (primary), with an optional secondary stripe beneath it
      `q ${accentRgb[0]} ${accentRgb[1]} ${accentRgb[2]} rg 0 ${(PAGE_HEIGHT - 6).toFixed(2)} ${PAGE_WIDTH.toFixed(
        2,
      )} 6 re f Q`,
      secondaryRgb
        ? `q ${secondaryRgb[0]} ${secondaryRgb[1]} ${secondaryRgb[2]} rg 0 ${(PAGE_HEIGHT - 9).toFixed(2)} ${PAGE_WIDTH.toFixed(
            2,
          )} 3 re f Q`
        : "",
      // Running header on pages 2+
      pageNum > 1
        ? `BT /F1 8 Tf 0.45 0.5 0.58 rg ${MARGIN_X.toFixed(2)} ${(PAGE_HEIGHT - 34).toFixed(
            2,
          )} Td ${pdfLiteralString(headerLabel)} Tj ET`
        : "",
      // Footer rule + title + Page X of Y
      `q ${footerRule[0]} ${footerRule[1]} ${footerRule[2]} RG 0.5 w ${MARGIN_X.toFixed(2)} 38 m ${(MARGIN_X + CONTENT_WIDTH).toFixed(2)} 38 l S Q`,
      `BT /F1 8 Tf 0.45 0.5 0.58 rg ${MARGIN_X.toFixed(2)} 25 Td ${pdfLiteralString(footerLabel)} Tj ET`,
      `BT /F1 8 Tf 0.45 0.5 0.58 rg ${(PAGE_WIDTH - MARGIN_X - 58).toFixed(2)} 25 Td ${pdfLiteralString(
        `Page ${pageNum} of ${totalPages}`,
      )} Tj ET`,
    ].filter(Boolean);

    const streamText = [...hfOps, ...ops].join("\n") + "\n";
    const streamBytes = Buffer.from(streamText, "latin1");
    const compressed = deflateSync(streamBytes, { level: 6 });
    const contentId = addObject({
      dict: `<< /Filter /FlateDecode /Length ${compressed.length} >>`,
      stream: compressed,
    });
    const annotsForPage = pageAnnots[idx] || [];
    const annotIds = annotsForPage.map((annot) =>
      addObject(
        `<< /Type /Annot /Subtype /Link /Rect [${annot.x1.toFixed(2)} ${annot.y1.toFixed(2)} ${annot.x2.toFixed(
          2,
        )} ${annot.y2.toFixed(2)}] /Border [0 0 0] /A << /Type /Action /S /URI /URI ${pdfLiteralString(annot.uri)} >> >>`,
      ),
    );
    const annotsEntry = annotIds.length ? ` /Annots [${annotIds.map((id) => `${id} 0 R`).join(" ")}]` : "";
    const pageId = addObject(
      `<< /Type /Page /Parent 3 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources ${resourcesDict} /Contents ${contentId} 0 R${annotsEntry} >>`,
    );
    pageIds.push(pageId);
  });

  objects[0] = "<< /Type /Catalog /Pages 3 0 R >>";
  objects[1] = `<< /Title ${pdfLiteralString(docTitle)} /Creator ${pdfLiteralString(
    options.branding?.companyName || "Copilot Studio Labs Builder",
  )} /Producer (Copilot Studio Labs Pure-Node PDF Builder) >>`;
  objects[2] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`;

  // Serialize binary PDF with exact byte offsets
  const chunks = [];
  let byteOffset = 0;
  const pushBuf = (b) => {
    const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, "latin1");
    chunks.push(buf);
    byteOffset += buf.length;
  };

  pushBuf(Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1"));
  const offsets = [0]; // index 0 is free object 0

  objects.forEach((obj, i) => {
    const id = i + 1;
    offsets.push(byteOffset);
    pushBuf(`${id} 0 obj\n`);
    if (typeof obj === "string") {
      pushBuf(`${obj}\nendobj\n`);
    } else {
      pushBuf(`${obj.dict}\nstream\n`);
      pushBuf(obj.stream);
      pushBuf("\nendstream\nendobj\n");
    }
  });

  const xrefOffset = byteOffset;
  const xrefLines = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`];
  for (let id = 1; id <= objects.length; id += 1) {
    xrefLines.push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  }
  pushBuf(xrefLines.join(""));
  pushBuf(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 2 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );

  return Buffer.concat(chunks);
}

export const buildPdfFromLabMarkdown = renderMarkdownToPdfBuffer;

