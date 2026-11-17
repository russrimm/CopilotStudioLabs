/**
 * Pure-Node OOXML Word (.docx) builder for generated lab guides and modules.
 *
 * Zero npm packages: uses only Node.js `node:zlib` and `node:buffer` to build a
 * spec-compliant PKZIP archive containing `[Content_Types].xml`, `_rels/.rels`,
 * `docProps/core.xml`, `docProps/app.xml`, `word/document.xml`,
 * `word/_rels/document.xml.rels`, `word/styles.xml`, `word/numbering.xml`, and
 * embedded `word/media/*` PNG/JPEG images.
 */

import { deflateRawSync } from "node:zlib";
import {
  ARCHITECTURE_FENCE_LANG,
  renderArchitectureDocumentMarkdown,
} from "./architecture-overview.js";
import { LIGHT_SURFACE, cleanText, ensureReadableColor, getBrandFont } from "./brand-theme.js";
import { stripEmbeddedHtml } from "./html-fragments.js";

// Precompute IEEE 802.3 CRC-32 lookup table.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date("2026-01-15T12:00:00Z")) {
  const year = Math.max(1980, date.getUTCFullYear());
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = Math.floor(date.getUTCSeconds() / 2);
  return {
    dosTime: ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f),
    dosDate: (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f),
  };
}

/**
 * Write an array of `{ name, data, store }` entries into a valid PKZIP Buffer.
 */
export function buildZipBuffer(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  const { dosTime, dosDate } = dosDateTime();

  for (const entry of entries) {
    const nameBuf = Buffer.from(String(entry.name).replace(/\\/g, "/"), "utf8");
    const rawBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ""), "utf8");
    const useStore = Boolean(entry.store) || rawBuf.length === 0;
    const compBuf = useStore ? rawBuf : deflateRawSync(rawBuf, { level: 9 });
    const method = useStore ? 0 : 8;
    const crc = crc32(rawBuf);

    // Local file header (30 bytes + filename)
    const lfh = Buffer.alloc(30 + nameBuf.length);
    lfh.writeUInt32LE(0x04034b50, 0); // signature PK\x03\x04
    lfh.writeUInt16LE(20, 4); // version needed 2.0
    lfh.writeUInt16LE(0x0800, 6); // UTF-8 filename bit
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(dosTime, 10);
    lfh.writeUInt16LE(dosDate, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(compBuf.length, 18);
    lfh.writeUInt32LE(rawBuf.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    nameBuf.copy(lfh, 30);

    localChunks.push(lfh, compBuf);

    // Central directory file header (46 bytes + filename)
    const cdh = Buffer.alloc(46 + nameBuf.length);
    cdh.writeUInt32LE(0x02014b50, 0); // signature PK\x01\x02
    cdh.writeUInt16LE(20, 4); // version made by
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(0x0800, 8); // UTF-8 filename bit
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(dosTime, 12);
    cdh.writeUInt16LE(dosDate, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(compBuf.length, 20);
    cdh.writeUInt32LE(rawBuf.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30); // extra len
    cdh.writeUInt16LE(0, 32); // comment len
    cdh.writeUInt16LE(0, 34); // disk start
    cdh.writeUInt16LE(0, 36); // internal attrs
    cdh.writeUInt32LE(0, 38); // external attrs
    cdh.writeUInt32LE(offset, 42); // local header offset
    nameBuf.copy(cdh, 46);

    centralChunks.push(cdh);
    offset += lfh.length + compBuf.length;
  }

  const centralSize = centralChunks.reduce((sum, b) => sum + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // PK\x05\x06
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, ...centralChunks, eocd]);
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeHexColor(hex, fallback = "1A56C7") {
  const m = String(hex || "").trim().match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!m) return fallback;
  const raw = m[1].toUpperCase();
  if (raw.length === 3) {
    return `${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`;
  }
  return raw;
}

/**
 * Inspect PNG or JPEG header bytes to determine pixel dimensions and MIME/ext.
 */
export function inspectImageDimensions(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;

  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf.toString("ascii", 12, 16) === "IHDR"
  ) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (width > 0 && height > 0) {
      return { ext: "png", contentType: "image/png", width, height };
    }
  }

  // JPEG signature: FF D8
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
      // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        const height = buf.readUInt16BE(pos + 5);
        const width = buf.readUInt16BE(pos + 7);
        if (width > 0 && height > 0) {
          return { ext: "jpeg", contentType: "image/jpeg", width, height };
        }
      }
      pos += 2 + segLen;
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
 * Render a Markdown document into a complete Word `.docx` Buffer.
 *
 * @param {string} markdown
 * @param {object} [options]
 * @param {string} [options.title]
 * @param {object} [options.branding] `{ companyName, tagline, primaryColor, secondaryColor, font, coverSubtitle, footerText, logoBuffer }`
 * @param {(src: string) => Buffer | null} [options.resolveImageBuffer]
 * @returns {Buffer}
 */
export function renderMarkdownToDocxBuffer(markdown, options = {}) {
  const accentHex = normalizeHexColor(options.branding?.primaryColor, "1A56C7");
  const secondaryHex = options.branding?.secondaryColor
    ? normalizeHexColor(options.branding.secondaryColor, "")
    : "";
  // Brand-colored text must stay readable on the white page, so heading text uses a darkened variant.
  const secondaryTextHex = secondaryHex
    ? ensureReadableColor(`#${secondaryHex}`, [LIGHT_SURFACE], "#000000", 4.5).slice(1).toUpperCase()
    : "";
  const brandFontName = getBrandFont(options.branding?.font).office || "Segoe UI";
  const footerText = cleanText(options.branding?.footerText);
  const coverSubtitle = cleanText(options.branding?.coverSubtitle);
  const docTitle = String(options.title || "Lab Guide").trim();
  const hyperlinks = [];
  const images = [];
  let orderedListCount = 0;
  let docPrId = 1;

  const registerHyperlink = (url) => {
    const clean = String(url || "").trim();
    if (!/^https?:\/\/|^mailto:/i.test(clean)) return null;
    const rId = `rIdLink${hyperlinks.length + 1}`;
    hyperlinks.push({ rId, target: clean });
    return rId;
  };

  const registerImage = (buf, altText, maxWidthInches = 6.0) => {
    const meta = inspectImageDimensions(buf);
    if (!meta) return null;
    const index = images.length + 1;
    const rId = `rIdImg${index}`;
    const mediaName = `image${index}.${meta.ext === "jpeg" ? "jpg" : meta.ext}`;
    images.push({ rId, mediaName, ext: meta.ext, data: buf });

    // 1 inch = 914400 EMUs; assume 96 DPI when computing natural size, capped to maxWidthInches.
    const naturalWidthIn = meta.width / 96;
    const widthIn = Math.min(maxWidthInches, Math.max(1.2, naturalWidthIn));
    const scale = widthIn / naturalWidthIn;
    const heightIn = Math.min(7.5, Math.max(0.4, (meta.height / 96) * scale));
    const cx = Math.round(widthIn * 914400);
    const cy = Math.round(heightIn * 914400);
    const drawingId = docPrId++;
    const safeAlt = xmlEscape(altText || "Lab illustration");

    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${drawingId}" name="Picture ${drawingId}" descr="${safeAlt}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${drawingId}" name="${xmlEscape(mediaName)}" descr="${safeAlt}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  };

  const makeRun = (text, props = {}) => {
    const cleaned = String(text ?? "").replace(/\\([\\`*_[\]<>|~#+-])/g, "$1");
    if (!cleaned) return "";
    const rPr = [];
    if (props.bold) rPr.push("<w:b/>");
    if (props.italic) rPr.push("<w:i/>");
    if (props.underline) rPr.push('<w:u w:val="single"/>');
    if (props.color) rPr.push(`<w:color w:val="${props.color}"/>`);
    if (props.code) {
      rPr.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>');
      rPr.push('<w:sz w:val="19"/><w:szCs w:val="19"/>');
      rPr.push('<w:shd w:val="clear" w:color="auto" w:fill="EEF1F7"/>');
    } else if (props.sizeHalfPt) {
      rPr.push(`<w:sz w:val="${props.sizeHalfPt}"/><w:szCs w:val="${props.sizeHalfPt}"/>`);
    }
    const rPrXml = rPr.length ? `<w:rPr>${rPr.join("")}</w:rPr>` : "";
    return `<w:r>${rPrXml}<w:t xml:space="preserve">${xmlEscape(cleaned)}</w:t></w:r>`;
  };

  const renderInlineRuns = (rawText, baseProps = {}) => {
    const text = String(rawText ?? "");
    const tokenRe =
      /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|`([^`\n]+)`|(?<!\\)(<br\s*\/?>)|\*\*([^*]+)\*\*|(?<!\*)\*([^*\n]+)\*(?!\*)/gi;
    const out = [];
    let lastIdx = 0;
    let match;

    while ((match = tokenRe.exec(text)) !== null) {
      if (match.index > lastIdx) {
        out.push(makeRun(text.slice(lastIdx, match.index), baseProps));
      }
      if (match[1] !== undefined && match[2] !== undefined) {
        // Image ![alt](src)
        const alt = match[1];
        const src = match[2];
        const imgBuf =
          typeof options.resolveImageBuffer === "function" ? options.resolveImageBuffer(src) : null;
        const drawingXml = imgBuf ? registerImage(imgBuf, alt) : null;
        if (drawingXml) {
          out.push(drawingXml);
        } else {
          out.push(makeRun(`[Figure: ${alt || src}]`, { ...baseProps, italic: true, color: "4A5568" }));
        }
      } else if (match[3] !== undefined && match[4] !== undefined) {
        // Hyperlink [label](href)
        const label = match[3].replace(/[*_`]/g, "");
        const href = match[4];
        const rId = registerHyperlink(href);
        if (rId) {
          out.push(
            `<w:hyperlink r:id="${rId}">${makeRun(label, {
              ...baseProps,
              color: accentHex,
              underline: true,
            })}</w:hyperlink>`,
          );
        } else {
          out.push(makeRun(label, baseProps));
        }
      } else if (match[5] !== undefined) {
        out.push(makeRun(match[5], { ...baseProps, code: true }));
      } else if (match[6] !== undefined) {
        out.push("<w:r><w:br/></w:r>");
      } else if (match[7] !== undefined) {
        // Emphasis can wrap a link, so its content is rendered as inline Markdown rather than as plain text.
        out.push(renderInlineRuns(match[7], { ...baseProps, bold: true }));
      } else if (match[8] !== undefined) {
        out.push(renderInlineRuns(match[8], { ...baseProps, italic: true }));
      }
      lastIdx = tokenRe.lastIndex;
    }

    if (lastIdx < text.length) {
      out.push(makeRun(text.slice(lastIdx), baseProps));
    }

    return out.join("");
  };

  const makeParagraph = (runsXml, pProps = {}) => {
    const pPr = [];
    if (pProps.style) pPr.push(`<w:pStyle w:val="${pProps.style}"/>`);
    if (pProps.numId) {
      pPr.push(`<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${pProps.numId}"/></w:numPr>`);
    }
    if (pProps.callout) {
      pPr.push(
        `<w:pBdr><w:left w:val="single" w:sz="18" w:space="10" w:color="${accentHex}"/></w:pBdr>`,
        '<w:shd w:val="clear" w:color="auto" w:fill="F4F7FC"/>',
        '<w:ind w:left="240" w:right="160"/>',
      );
    }
    if (pProps.codeBlock) {
      pPr.push(
        '<w:pBdr><w:top w:val="single" w:sz="4" w:space="4" w:color="D0D7DE"/><w:left w:val="single" w:sz="4" w:space="8" w:color="D0D7DE"/><w:bottom w:val="single" w:sz="4" w:space="4" w:color="D0D7DE"/><w:right w:val="single" w:sz="4" w:space="8" w:color="D0D7DE"/></w:pBdr>',
        '<w:shd w:val="clear" w:color="auto" w:fill="F6F8FA"/>',
        '<w:spacing w:before="60" w:after="60" w:line="260" w:lineRule="auto"/>',
      );
    } else if (pProps.spacingBefore || pProps.spacingAfter) {
      pPr.push(
        `<w:spacing w:before="${pProps.spacingBefore || 0}" w:after="${pProps.spacingAfter || 120}"/>`,
      );
    }
    if (pProps.bottomRule) {
      pPr.push(`<w:pBdr><w:bottom w:val="single" w:sz="${secondaryHex ? 12 : 6}" w:space="6" w:color="${secondaryHex || "D0D7DE"}"/></w:pBdr>`);
    }
    const pPrXml = pPr.length ? `<w:pPr>${pPr.join("")}</w:pPr>` : "";
    return `<w:p>${pPrXml}${runsXml}</w:p>`;
  };

  const renderBlocks = (mdText, blockOpts = {}) => {
    const lines = String(mdText ?? "").replace(/\r\n/g, "\n").split("\n");
    const blocks = [];
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
            blocks.push(...renderBlocks(archMd, blockOpts));
            continue;
          }
        }
        if (lang) {
          blocks.push(
            makeParagraph(makeRun(`[${lang}]`, { bold: true, color: "57606A", sizeHalfPt: 18 }), {
              spacingBefore: 80,
              spacingAfter: 20,
            }),
          );
        }
        const codeRuns = codeLines
          .map(
            (cl, idx) =>
              `<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>${
                idx > 0 ? "<w:br/>" : ""
              }<w:t xml:space="preserve">${xmlEscape(cl)}</w:t></w:r>`,
          )
          .join("");
        blocks.push(makeParagraph(codeRuns || makeRun(" ", { code: true }), { codeBlock: true }));
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
        blocks.push(
          makeParagraph(renderInlineRuns(summaryText, { bold: true, color: accentHex }), {
            callout: true,
            spacingBefore: 120,
            spacingAfter: 60,
          }),
        );
        blocks.push(...renderBlocks(innerLines.join("\n"), { callout: true }));
        continue;
      }

      // ATX Heading
      const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);
      if (headingMatch) {
        const level = Math.min(4, headingMatch[1].length);
        blocks.push(
          makeParagraph(renderInlineRuns(headingMatch[2]), {
            style: `Heading${level}`,
          }),
        );
        i += 1;
        continue;
      }

      // Horizontal rule
      if (/^\s*(?:[-*_]\s*){3,}\s*$/.test(line)) {
        blocks.push(makeParagraph("", { bottomRule: true, spacingBefore: 80, spacingAfter: 120 }));
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
        const colWidthDxa = Math.floor(9360 / colCount);
        const gridCols = Array.from({ length: colCount }, () => `<w:gridCol w:w="${colWidthDxa}"/>`).join("");
        const headerRowXml = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${headers
          .map(
            (h) =>
              `<w:tc><w:tcPr><w:tcW w:w="${colWidthDxa}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="EEF2FA"/></w:tcPr><w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr>${renderInlineRuns(
                h,
                { bold: true },
              )}</w:p></w:tc>`,
          )
          .join("")}</w:tr>`;
        const bodyRowsXml = rows
          .map(
            (row) =>
              `<w:tr>${headers
                .map(
                  (_h, cIdx) =>
                    `<w:tc><w:tcPr><w:tcW w:w="${colWidthDxa}" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr>${renderInlineRuns(
                      row[cIdx] ?? "",
                    )}</w:p></w:tc>`,
                )
                .join("")}</w:tr>`,
          )
          .join("");
        blocks.push(
          `<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/><w:left w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/><w:bottom w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/><w:right w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/></w:tblBorders><w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${gridCols}</w:tblGrid>${headerRowXml}${bodyRowsXml}</w:tbl>`,
        );
        blocks.push(makeParagraph("", { spacingBefore: 0, spacingAfter: 80 }));
        continue;
      }

      // Blockquote
      if (/^\s*>\s?/.test(line)) {
        const quoteLines = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
          i += 1;
        }
        blocks.push(...renderBlocks(quoteLines.join("\n"), { callout: true }));
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
            const box = taskMatch[1].toLowerCase() === "x" ? "☑ " : "☐ ";
            blocks.push(
              makeParagraph(makeRun(box, { bold: true }) + renderInlineRuns(taskMatch[2]), {
                callout: blockOpts.callout,
                spacingBefore: 30,
                spacingAfter: 60,
              }),
            );
          } else {
            blocks.push(
              makeParagraph(renderInlineRuns(itemText), {
                numId: 1,
                callout: blockOpts.callout,
                spacingBefore: 30,
                spacingAfter: 60,
              }),
            );
          }
        }
        continue;
      }

      // Ordered list (each ordered list gets its own numId starting at 1)
      if (/^\s*\d+\.\s+/.test(line)) {
        orderedListCount += 1;
        const listNumId = 1 + orderedListCount;
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          let itemText = lines[i].replace(/^\s*\d+\.\s+/, "");
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
          blocks.push(
            makeParagraph(renderInlineRuns(itemText), {
              numId: listNumId,
              callout: blockOpts.callout,
              spacingBefore: 40,
              spacingAfter: 80,
            }),
          );
        }
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
      blocks.push(
        makeParagraph(renderInlineRuns(paraLines.join(" ")), {
          callout: blockOpts.callout,
          spacingBefore: 40,
          spacingAfter: 120,
        }),
      );
    }

    return blocks;
  };

  const bodyBlocks = [];
  if (options.branding && (options.branding.companyName || options.branding.tagline || options.branding.logoBuffer)) {
    const brandRuns = [];
    if (options.branding.logoBuffer) {
      const logoXml = registerImage(options.branding.logoBuffer, options.branding.companyName || "Logo", 1.5);
      if (logoXml) brandRuns.push(logoXml, makeRun("  "));
    }
    if (options.branding.companyName) {
      brandRuns.push(makeRun(options.branding.companyName, { bold: true, color: accentHex, sizeHalfPt: 24 }));
    }
    if (options.branding.tagline) {
      brandRuns.push(
        makeRun(options.branding.companyName ? ` — ${options.branding.tagline}` : options.branding.tagline, {
          italic: true,
          color: "4A5568",
          sizeHalfPt: 20,
        }),
      );
    }
    if (brandRuns.length) {
      bodyBlocks.push(makeParagraph(brandRuns.join(""), { bottomRule: true, spacingBefore: 0, spacingAfter: coverSubtitle ? 60 : 180 }));
      if (coverSubtitle) {
        bodyBlocks.push(
          makeParagraph(makeRun(coverSubtitle, { italic: true, color: "4A5568", sizeHalfPt: 20 }), {
            spacingBefore: 0,
            spacingAfter: 180,
          }),
        );
      }
    }
  }

  bodyBlocks.push(...renderBlocks(stripEmbeddedHtml(markdown)));

  const footerRuleColor = secondaryHex || "D0D7DE";
  const footerXml = footerText
    ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:p>
    <w:pPr><w:pBdr><w:top w:val="single" w:sz="6" w:space="6" w:color="${footerRuleColor}"/></w:pBdr><w:tabs><w:tab w:val="right" w:pos="9936"/></w:tabs></w:pPr>
    <w:r><w:rPr><w:color w:val="4A5568"/><w:sz w:val="17"/><w:szCs w:val="17"/></w:rPr><w:t xml:space="preserve">${xmlEscape(footerText)}</w:t></w:r>
    <w:r><w:rPr><w:color w:val="4A5568"/><w:sz w:val="17"/><w:szCs w:val="17"/></w:rPr><w:tab/><w:t xml:space="preserve">Page </w:t></w:r>
    <w:r><w:rPr><w:color w:val="4A5568"/><w:sz w:val="17"/><w:szCs w:val="17"/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r>
    <w:r><w:rPr><w:color w:val="4A5568"/><w:sz w:val="17"/><w:szCs w:val="17"/></w:rPr><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>
    <w:r><w:rPr><w:color w:val="4A5568"/><w:sz w:val="17"/><w:szCs w:val="17"/></w:rPr><w:fldChar w:fldCharType="separate"/></w:r>
    <w:r><w:rPr><w:color w:val="4A5568"/><w:sz w:val="17"/><w:szCs w:val="17"/></w:rPr><w:t>1</w:t></w:r>
    <w:r><w:rPr><w:color w:val="4A5568"/><w:sz w:val="17"/><w:szCs w:val="17"/></w:rPr><w:fldChar w:fldCharType="end"/></w:r>
  </w:p>
</w:ftr>`
    : "";

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
  <w:body>
    ${bodyBlocks.join("\n    ")}
    <w:sectPr>
      ${footerXml ? '<w:footerReference w:type="default" r:id="rIdFooter1"/>' : ""}
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1152" w:right="1152" w:bottom="1152" w:left="1152" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="${xmlEscape(brandFontName)}" w:hAnsi="${xmlEscape(brandFontName)}" w:cs="${xmlEscape(brandFontName)}"/>
        <w:sz w:val="21"/>
        <w:szCs w:val="21"/>
        <w:color w:val="1A202C"/>
        <w:lang w:val="en-US"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:after="120" w:line="276" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:keepNext/><w:spacing w:before="120" w:after="180"/></w:pPr>
    <w:rPr><w:b/><w:color w:val="${accentHex}"/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:keepNext/><w:spacing w:before="260" w:after="120"/><w:pBdr><w:bottom w:val="single" w:sz="${secondaryHex ? 12 : 6}" w:space="4" w:color="${secondaryHex || "E2E8F0"}"/></w:pBdr></w:pPr>
    <w:rPr><w:b/><w:color w:val="${accentHex}"/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/></w:pPr>
    <w:rPr><w:b/><w:color w:val="${secondaryTextHex || "1E293B"}"/><w:sz w:val="25"/><w:szCs w:val="25"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading4">
    <w:name w:val="heading 4"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:keepNext/><w:spacing w:before="160" w:after="60"/></w:pPr>
    <w:rPr><w:b/><w:color w:val="334155"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>
  </w:style>
</w:styles>`;

  const orderedNumsXml = Array.from(
    { length: orderedListCount },
    (_, idx) =>
      `<w:num w:numId="${2 + idx}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`,
  ).join("\n  ");

  const numberingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:multiLevelType w:val="hybridMultilevel"/>
    <w:lvl w:ilvl="0">
      <w:start w:val="1"/>
      <w:numFmt w:val="bullet"/>
      <w:lvlText w:val="•"/>
      <w:lvlJc w:val="left"/>
      <w:pPr><w:ind w:left="540" w:hanging="280"/></w:pPr>
    </w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1">
    <w:multiLevelType w:val="hybridMultilevel"/>
    <w:lvl w:ilvl="0">
      <w:start w:val="1"/>
      <w:numFmt w:val="decimal"/>
      <w:lvlText w:val="%1."/>
      <w:lvlJc w:val="left"/>
      <w:pPr><w:ind w:left="540" w:hanging="280"/></w:pPr>
      <w:rPr><w:b/></w:rPr>
    </w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  ${orderedNumsXml}
</w:numbering>`;

  const docRelsItems = [
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>',
    ...hyperlinks.map(
      (h) =>
        `<Relationship Id="${h.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEscape(
          h.target,
        )}" TargetMode="External"/>`,
    ),
    ...(footerXml
      ? ['<Relationship Id="rIdFooter1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>']
      : []),
    ...images.map(
      (img) =>
        `<Relationship Id="${img.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${xmlEscape(
          img.mediaName,
        )}"/>`,
    ),
  ];

  const docRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${docRelsItems.join("\n  ")}
</Relationships>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>${
    footerXml
      ? '\n  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'
      : ""
  }
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

  const nowIso = new Date().toISOString();
  const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
                   xmlns:dc="http://purl.org/dc/elements/1.1/"
                   xmlns:dcterms="http://purl.org/dc/terms/"
                   xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xmlEscape(docTitle)}</dc:title>
  <dc:creator>${xmlEscape(options.branding?.companyName || "Copilot Studio Labs Builder")}</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF">${nowIso}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${nowIso}</dcterms:modified>
</cp:coreProperties>`;

  const appXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>Copilot Studio Labs Builder</Application>
</Properties>`;

  const zipEntries = [
    { name: "[Content_Types].xml", data: contentTypesXml },
    { name: "_rels/.rels", data: rootRelsXml },
    { name: "docProps/core.xml", data: coreXml },
    { name: "docProps/app.xml", data: appXml },
    { name: "word/document.xml", data: documentXml },
    { name: "word/_rels/document.xml.rels", data: docRelsXml },
    { name: "word/styles.xml", data: stylesXml },
    { name: "word/numbering.xml", data: numberingXml },
    ...(footerXml ? [{ name: "word/footer1.xml", data: footerXml }] : []),
    ...images.map((img) => ({
      name: `word/media/${img.mediaName}`,
      data: img.data,
      store: true,
    })),
  ];

  return buildZipBuffer(zipEntries);
}

export const buildDocxFromLabMarkdown = renderMarkdownToDocxBuffer;

