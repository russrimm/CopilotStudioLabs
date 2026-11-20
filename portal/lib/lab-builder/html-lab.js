/**
 * Multi-page standalone HTML renderer for generated labs.
 *
 * Zero npm dependencies so `tools/lab-builder/build.mjs` runs offline in bare
 * Node 24 before `npm ci`. Callers in the Express portal may pass
 * `options.renderMarkdown` (such as `renderLabMarkdown`) when desired.
 */

import {
  ARCHITECTURE_FENCE_LANG,
  renderArchitectureOverviewHtml,
} from "./architecture-overview.js";
import { enhanceInteractiveLabHtml } from "./interactive-elements.js";
import { ensureReadableColor, getBrandFont, normalizeHexColor6 } from "./brand-theme.js";
import { stripEmbeddedHtml } from "./html-fragments.js";
import { isSubStepStart, normalizeSubSteps, takeSubSteps } from "./sub-steps.js";
import { PENDING_SHOT_CSS, replacePendingPictures } from "./pending-shot-card.js";
import { META_TABLE_CSS, tidyMetaTable } from "./meta-table.js";

const ASSET_SRC_RE = /\bsrc="assets\/([A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|gif|svg|webp))"/gi;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeHref(rawHref) {
  const href = String(rawHref || "").trim();
  if (!href) return null;
  if (href.startsWith("#")) return href;
  if (/^(?:https?:|mailto:|tel:)/i.test(href)) return href;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("//")) return href;
  return null;
}

function sanitizeImgSrc(rawSrc) {
  const src = String(rawSrc || "").trim();
  if (!src) return null;
  if (/^https?:\/\//i.test(src)) return src;
  if (/^assets\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|gif|svg|webp)$/i.test(src)) return src;
  return null;
}

function renderInlineMarkdown(rawText) {
  const placeholders = [];
  const stash = (fragment) => {
    const key = `\u0000P${placeholders.length}\u0000`;
    placeholders.push(fragment);
    return key;
  };

  let text = String(rawText ?? "");

  // Inline code spans first so inner punctuation is never parsed as markup.
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => stash(`<code>${escapeHtml(code)}</code>`));

  // Unescape backslash-escaped punctuation in plain text before escaping HTML.
  text = text.replace(/\\([\\`*_[\]<>|~#+-])/g, (_m, ch) => stash(escapeHtml(ch)));

  // Explicit inline line breaks (<br> / <br/>) inside Markdown cells and list items.
  text = text.replace(/<br\s*\/?>/gi, () => stash("<br>"));

  // Images: ![alt](src)
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, alt, src) => {
    const safeSrc = sanitizeImgSrc(src);
    if (!safeSrc) return escapeHtml(alt);
    return stash(`<img src="${escapeHtml(safeSrc)}" alt="${escapeHtml(alt)}" />`);
  });

  // Links: [label](href)
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, label, href) => {
    const safeHref = sanitizeHref(href);
    const renderedLabel = renderInlineMarkdown(label);
    if (!safeHref) return stash(renderedLabel);
    const externalAttrs = /^https?:\/\//i.test(safeHref)
      ? ' target="_blank" rel="noopener noreferrer"'
      : "";
    return stash(`<a href="${escapeHtml(safeHref)}"${externalAttrs}>${renderedLabel}</a>`);
  });

  text = escapeHtml(text);
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");

  return text.replace(/\u0000P(\d+)\u0000/g, (_m, idx) => placeholders[Number(idx)] ?? "");
}

function splitTableCells(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, "|").trim());
}

/** A step's lettered sub-steps as a nested ordered list, plus the "more choices" note when there is one. */
function renderSubStepsHtml(sub) {
  if (!sub?.items?.length) return "";
  const list = sub.items.map((text) => `<li>${renderInlineMarkdown(text)}</li>`).join("");
  const note = sub.note ? `<p class="lab-substeps-note">${escapeHtml(sub.note)}</p>` : "";
  return `<ol type="a" class="lab-substeps">${list}</ol>${note}`;
}

/**
 * Lightweight, zero-dependency Markdown-to-HTML renderer covering every
 * construct produced by `composer.js` while escaping untrusted HTML.
 */
function renderLabMarkdownFallbackBlocks(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
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
      const normalizedLang = String(lang || "").trim().toLowerCase();
      if (normalizedLang === "mermaid") {
        out.push(`<div class="mermaid">${escapeHtml(codeLines.join("\n"))}</div>`);
      } else if (normalizedLang === ARCHITECTURE_FENCE_LANG) {
        out.push(renderArchitectureOverviewHtml(codeLines.join("\n")));
      } else {
        const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
        out.push(`<pre><code${cls}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      }
      continue;
    }

    // Expandable <details><summary>...</summary>...</details> block from differences.js
    if (/^\s*<details>\s*$/i.test(line)) {
      const innerLines = [];
      i += 1;
      let summaryText = "";
      if (i < lines.length) {
        const sumMatch = lines[i].match(/^\s*<summary>([\s\S]*?)<\/summary>\s*$/i);
        if (sumMatch) {
          summaryText = sumMatch[1].trim();
          i += 1;
        }
      }
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
      out.push(
        `<details><summary>${renderInlineMarkdown(summaryText || "Details")}</summary>\n${renderLabMarkdownFallbackBlocks(innerLines.join("\n"))}\n</details>`,
      );
      continue;
    }

    // ATX Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      out.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // Horizontal rule
    if (/^\s*(?:[-*_]\s*){3,}\s*$/.test(line)) {
      out.push("<hr />");
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
      const headHtml = `<thead><tr>${headers.map((h) => `<th>${renderInlineMarkdown(h)}</th>`).join("")}</tr></thead>`;
      const bodyHtml = rows.length
        ? `<tbody>${rows
            .map((r) => `<tr>${headers.map((_h, idx) => `<td>${renderInlineMarkdown(r[idx] ?? "")}</td>`).join("")}</tr>`)
            .join("")}</tbody>`
        : "";
      out.push(`<table>${headHtml}${bodyHtml}</table>`);
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${renderLabMarkdownFallbackBlocks(quoteLines.join("\n"))}</blockquote>`);
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
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
        items.push(itemText);
      }
      const hasTask = items.some((it) => /^\[[ xX]\]\s+/.test(it));
      const liHtml = items
        .map((it) => {
          const taskMatch = it.match(/^\[([ xX])\]\s+([\s\S]*)$/);
          if (taskMatch) {
            const checked = taskMatch[1].toLowerCase() === "x" ? " checked" : "";
            return `<li class="task-list-item"><input class="task-list-item-checkbox" type="checkbox"${checked} /> ${renderInlineMarkdown(taskMatch[2])}</li>`;
          }
          return `<li>${renderInlineMarkdown(it)}</li>`;
        })
        .join("");
      out.push(`<ul${hasTask ? ' class="contains-task-list"' : ""}>${liHtml}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      const subs = [];
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
        items.push(itemText);
        subs.push(sub);
      }
      out.push(`<ol>${items.map((it, n) => `<li>${renderInlineMarkdown(it)}${renderSubStepsHtml(subs[n])}</li>`).join("")}</ol>`);
      continue;
    }

    // Paragraph
    const paraLines = [line.trim()];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(?:#{1,6}\s+|\s*(`{3,}|~{3,})|\s*>\s?|\s*[-*+]\s+|\s*\d+\.\s+|\s*<details>|\s*(?:[-*_]\s*){3,}\s*$)/i.test(lines[i]) &&
      !(
        lines[i].includes("|") &&
        i + 1 < lines.length &&
        /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(lines[i + 1])
      )
    ) {
      paraLines.push(lines[i].trim());
      i += 1;
    }
    out.push(`<p>${renderInlineMarkdown(paraLines.join(" "))}</p>`);
  }

  return out.join("\n");
}

/**
 * The fallback has no sanitizer, so trusted HTML fragments (the Markdown brand banner) are
 * removed instead of rendered; the standalone page draws its own brand header from
 * `options.branding`.
 */
export function renderLabMarkdownFallback(markdown) {
  return enhanceInteractiveLabHtml(renderLabMarkdownFallbackBlocks(stripEmbeddedHtml(normalizeSubSteps(markdown))));
}

function decodeBasicEntities(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(html) {
  return decodeBasicEntities(String(html || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function slugifyHeading(text, seen) {
  const base = stripTags(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section";
  const count = seen.get(base) || 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

/**
 * Add deterministic `id` attributes to rendered `<h1>`–`<h4>` tags after
 * sanitization so internal `#anchor` links and chapter jumpers have targets.
 */
export function addHeadingIds(html) {
  const seen = new Map();
  return String(html || "").replace(/<(h[1-4])(\b[^>]*)>([\s\S]*?)<\/\1>/gi, (full, tag, attrs, inner) => {
    if (/\bid="/i.test(attrs)) return full;
    const id = slugifyHeading(inner, seen);
    return `<${tag}${attrs} id="${escapeHtml(id)}">${inner}</${tag}>`;
  });
}

function cleanPageChunk(chunk) {
  return String(chunk || "")
    .replace(/(?:\s*<hr\s*\/?>\s*)+$/i, "")
    .trim();
}

function extractFirstHeadingText(html, tag = "h1") {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = String(html || "").match(re);
  return match ? stripTags(match[1]) : "";
}

/**
 * Partition sanitized lab HTML into logical, bite-sized pages.
 *
 * Page 1 combines the `<h1>` title, metadata table, and the first `<h2>`
 * section (typically Overview). Every subsequent `<h2>` section becomes its
 * own dedicated page. Falls back to `<h3>` boundaries if fewer than two `<h2>`
 * sections exist, or a single page when the document has no multi-section
 * headings.
 *
 * @param {string} html
 * @returns {Array<{ index: number, number: number, title: string, html: string }>}
 */
export function splitLabHtmlIntoPages(html) {
  const withIds = addHeadingIds(html);
  const findHeadings = (tag) => {
    const matches = [];
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
    let m;
    while ((m = re.exec(withIds)) !== null) {
      matches.push({ start: m.index, title: stripTags(m[1]) || "Section" });
    }
    return matches;
  };

  let splits = findHeadings("h2");
  if (splits.length < 2) {
    const h3Splits = findHeadings("h3");
    if (h3Splits.length >= 2) splits = h3Splits;
  }

  if (splits.length < 2) {
    const fallbackTitle = splits[0]?.title || extractFirstHeadingText(withIds, "h1") || "Overview";
    return [
      {
        index: 0,
        number: 1,
        title: fallbackTitle,
        html: cleanPageChunk(withIds),
      },
    ];
  }

  const pages = [];
  for (let i = 0; i < splits.length; i += 1) {
    const chunkStart = i === 0 ? 0 : splits[i].start;
    const chunkEnd = i + 1 < splits.length ? splits[i + 1].start : withIds.length;
    const chunkHtml = cleanPageChunk(withIds.slice(chunkStart, chunkEnd));
    if (!chunkHtml) continue;
    pages.push({
      index: pages.length,
      number: pages.length + 1,
      title: splits[i].title,
      html: chunkHtml,
    });
  }

  return pages.length
    ? pages
    : [{ index: 0, number: 1, title: "Overview", html: cleanPageChunk(withIds) }];
}

function extractMarkdownTitle(markdown) {
  const match = String(markdown || "").match(/^#\s+(.+?)\s*$/m);
  return match ? match[1].trim() : "";
}

/**
 * Render a complete standalone HTML5 document with interactive Previous/Next
 * pagination, chapter selector, single-page view toggle, theme toggle, and
 * print rules that reveal all pages for PDF saving.
 *
 * @param {string} markdown
 * @param {object} [options]
 * @param {string} [options.title]
 * @param {string} [options.labId]
 * @param {object} [options.branding]
 * @param {(assetName: string) => string | null} [options.resolveImageSrc]
 * @returns {string}
 */
function parseHexRgb(hex) {
  const raw = String(hex || "").trim().replace(/^#/, "");
  if (/^[0-9a-f]{3,4}$/i.test(raw)) {
    return [0, 1, 2].map((i) => parseInt(raw[i] + raw[i], 16));
  }
  if (/^[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(raw)) {
    return [0, 2, 4].map((i) => parseInt(raw.slice(i, i + 2), 16));
  }
  return null;
}

function rgbToHex([r, g, b]) {
  return (
    "#" +
    [r, g, b]
      .map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0"))
      .join("")
  );
}

function relativeLuminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatioRgb(rgbA, rgbB) {
  const l1 = relativeLuminance(rgbA);
  const l2 = relativeLuminance(rgbB);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function ensureContrastHex(fgHex, bgHexList, targetHex, minRatio = 4.6) {
  const startRgb = parseHexRgb(fgHex);
  const targetRgb = parseHexRgb(targetHex);
  const bgRgbs = bgHexList.map(parseHexRgb).filter(Boolean);
  if (!startRgb || !targetRgb || !bgRgbs.length) return fgHex;
  const passesAll = (candidate) => bgRgbs.every((bg) => contrastRatioRgb(candidate, bg) >= minRatio);
  if (passesAll(startRgb)) return rgbToHex(startRgb);
  let low = 0;
  let high = 1;
  let best = targetRgb;
  for (let step = 0; step < 18; step += 1) {
    const mid = (low + high) / 2;
    const blended = startRgb.map((c, idx) => c + (targetRgb[idx] - c) * mid);
    if (passesAll(blended)) {
      best = blended;
      high = mid;
    } else {
      low = mid;
    }
  }
  return rgbToHex(best);
}

function pickButtonPair(rawHex, fallbackBg, fallbackFg) {
  const rgb = parseHexRgb(rawHex);
  if (!rgb) return { bg: fallbackBg, fg: fallbackFg };
  const white = [255, 255, 255];
  const nearBlack = [11, 14, 20];
  const whiteRatio = contrastRatioRgb(rgb, white);
  const darkRatio = contrastRatioRgb(rgb, nearBlack);
  if (whiteRatio >= 4.5 && whiteRatio >= darkRatio) {
    return { bg: rgbToHex(rgb), fg: "#ffffff" };
  }
  if (darkRatio >= 4.5) {
    return { bg: rgbToHex(rgb), fg: "#0b0e14" };
  }
  const adjustedBg = ensureContrastHex(rgbToHex(rgb), ["#ffffff"], "#0b0e14", 4.6);
  return { bg: adjustedBg, fg: "#ffffff" };
}

export function renderStandaloneLabHtml(markdown, options = {}) {
  const renderMd = typeof options.renderMarkdown === "function" ? options.renderMarkdown : renderLabMarkdownFallback;
  let bodyHtml = tidyMetaTable(enhanceInteractiveLabHtml(renderMd(String(markdown ?? ""))));
  // A picture that has not been captured yet becomes a "Screenshot to add" card instead of a placeholder image.
  if (typeof options.pendingShotFor === "function") {
    bodyHtml = replacePendingPictures(bodyHtml, options.pendingShotFor);
  }
  if (typeof options.resolveImageSrc === "function") {
    bodyHtml = bodyHtml.replace(ASSET_SRC_RE, (full, assetName) => {
      const resolved = options.resolveImageSrc(assetName);
      return resolved ? `src="${escapeHtml(resolved)}"` : full;
    });
  }

  const pages = splitLabHtmlIntoPages(bodyHtml);
  const rawTitle =
    options.title ||
    extractFirstHeadingText(bodyHtml, "h1") ||
    extractMarkdownTitle(markdown) ||
    options.labId ||
    "Custom Lab";
  const safeTitle = escapeHtml(rawTitle);
  const storageScope =
    String(options.labId || rawTitle)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "standalone-lab";

  const branding = options.branding && typeof options.branding === "object" ? options.branding : null;
  const customBrandHex =
    branding?.primaryColor && /^#[0-9a-f]{3,8}$/i.test(branding.primaryColor)
      ? branding.primaryColor
      : null;

  const lightButton = customBrandHex
    ? pickButtonPair(customBrandHex, "#1a56c7", "#ffffff")
    : { bg: "#1a56c7", fg: "#ffffff" };
  const darkButton = customBrandHex
    ? pickButtonPair(customBrandHex, "#4f8ff7", "#0b0e14")
    : { bg: "#4f8ff7", fg: "#0b0e14" };
  const lightLinkColor = customBrandHex
    ? ensureContrastHex(customBrandHex, ["#ffffff", "#f8fafc", "#f1f5f9"], "#123f9a", 4.6)
    : "#1a56c7";
  const darkLinkColor = customBrandHex
    ? ensureContrastHex(customBrandHex, ["#181c26", "#1f2533", "#111520"], "#93c5fd", 4.6)
    : "#6ba1ff";

  const brandingHeader =
    branding && (branding.companyName || branding.tagline || branding.logoUrl)
      ? `<div class="lab-brand-banner">
          ${branding.logoUrl ? `<img class="lab-brand-logo" src="${escapeHtml(branding.logoUrl)}" alt="${escapeHtml(branding.companyName || "Organization")} logo" />` : ""}
          <div class="lab-brand-text">
            ${branding.companyName ? `<strong>${escapeHtml(branding.companyName)}</strong>` : ""}
            ${branding.tagline ? `<span>${escapeHtml(branding.tagline)}</span>` : ""}
            ${branding.coverSubtitle ? `<span class="lab-brand-subtitle">${escapeHtml(branding.coverSubtitle)}</span>` : ""}
          </div>
        </div>`
      : "";
  const brandFooterText = branding?.footerText ? String(branding.footerText) : "";
  const brandingFooter = brandFooterText
    ? `<footer class="lab-brand-footer"><p>${escapeHtml(brandFooterText)}</p></footer>`
    : "";

  // Secondary color is decorative, but keep it visible (3:1) on both the light and dark surfaces.
  const secondaryHex = normalizeHexColor6(branding?.secondaryColor);
  const lightSecondary = secondaryHex
    ? ensureReadableColor(secondaryHex, ["#ffffff", "#f8fafc"], "#123f9a", 3)
    : null;
  const darkSecondary = secondaryHex
    ? ensureReadableColor(secondaryHex, ["#181c26", "#1f2533"], "#93c5fd", 3)
    : null;
  const brandFontCss = getBrandFont(branding?.font).css;
  const lightSecondaryVar = lightSecondary ? `\n      --brand-secondary: ${lightSecondary};` : "";
  const darkSecondaryVar = darkSecondary ? `\n      --brand-secondary: ${darkSecondary};` : "";
  const bodyFontStack =
    brandFontCss || '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

  const pageOptionsHtml = pages
    .map(
      (page) =>
        `<option value="${page.index}">${page.number}. ${escapeHtml(page.title)}</option>`,
    )
    .join("");

  const pagesHtml = pages
    .map(
      (page) =>
        `<section class="lab-page${page.index === 0 ? " active" : ""}" id="lab-page-${page.number}" data-page-index="${page.index}" data-page-title="${escapeHtml(page.title)}" aria-label="Page ${page.number} of ${pages.length}: ${escapeHtml(page.title)}">
${page.html}
</section>`,
    )
    .join("\n");

  const nextInitialLabel =
    pages.length > 1 ? `Next: ${escapeHtml(pages[1].title)} →` : "Next →";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    :root {
      --bg: #f4f6fb;
      --surface: #ffffff;
      --surface-muted: #f8fafc;
      --border: #dce2ef;
      --border-strong: #5b6b8c;
      --text: #1a1d27;
      --text-muted: #526077;
      --accent: ${lightButton.bg};
      --accent-contrast: ${lightButton.fg};
      --link: ${lightLinkColor};${lightSecondaryVar}
      --code-bg: #f1f5f9;
      --code-border: #d5dce9;
      --success-bg: #e6f6f0;
      --success-border: #0d7a58;
      --success-text: #0b6e4f;
      --warn-bg: #fef3c7;
      --warn-border: #b45309;
      --warn-text: #78350f;
      --callout-bg: #edf3fe;
      --callout-border: #1d5bd6;
      --callout-text: #162447;
      --checked-card-bg: #e8effc;
      --arch-bg: #f6f8fc;
      --arch-header-bg: #edf2fb;
      --arch-lane-bg: #ffffff;
      --arch-card-bg: #f8fafd;
      --arch-rail-bg: #f1f5fb;
      --arch-border: #64748b;
      --arch-card-border: #6e7f99;
      --arch-connector: #4b5e7a;
      --arch-text: #0f172a;
      --arch-muted: #334155;
      --arch-eyebrow: #1546a6;
      --arch-pill-bg: #ffffff;
      --arch-pill-border: #64748b;
      --arch-pill-text: #1e293b;
      --arch-pill-product-bg: #e8f0fe;
      --arch-pill-product-border: #2563eb;
      --arch-pill-product-text: #123c94;
      --arch-step-bg: #e8f0fe;
      --arch-step-border: #2563eb;
      --arch-step-text: #123c94;
      --arch-recap-bg: #f1ecff;
      --arch-recap-border: #6d28d9;
      --arch-recap-text: #4c1d95;
      --arch-flow-bg: #eef2fa;
      --arch-flow-border: #5b6b88;
      --arch-flow-text: #1e293b;
      --arch-exp-accent: #0f4cbd;
      --arch-exp-soft: #e6f0ff;
      --arch-core-accent: #5b21b6;
      --arch-core-soft: #f1ebff;
      --arch-ground-accent: #0b6b50;
      --arch-ground-soft: #e3f7f0;
      --arch-gov-accent: #8a4b08;
      --arch-gov-soft: #fef3df;
      --arch-outcome-bg: #e6f6f0;
      --arch-outcome-border: #0d7a58;
      --arch-outcome-label: #08583f;
      --arch-outcome-text: #0b2e23;
      color-scheme: light;
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        --bg: #0f1117;
        --surface: #181c26;
        --surface-muted: #1f2533;
        --border: #2c3447;
        --border-strong: #6b7394;
        --text: #e6eaf2;
        --text-muted: #9ba6bc;
        --accent: ${darkButton.bg};
        --accent-contrast: ${darkButton.fg};
        --link: ${darkLinkColor};${darkSecondaryVar}
        --code-bg: #111520;
        --code-border: #2c3447;
        --success-bg: #102a22;
        --success-border: #3dd6a3;
        --success-text: #6ee7b7;
        --warn-bg: #332611;
        --warn-border: #d99b26;
        --warn-text: #fde68a;
        --callout-bg: #182238;
        --callout-border: #5b9bff;
        --callout-text: #dce6fa;
        --checked-card-bg: #151e2d;
        --arch-bg: #131826;
        --arch-header-bg: #192033;
        --arch-lane-bg: #171d2e;
        --arch-card-bg: #1f273d;
        --arch-rail-bg: #161c2d;
        --arch-border: #6d7ea8;
        --arch-card-border: #7688b4;
        --arch-connector: #7d92c4;
        --arch-text: #edf2ff;
        --arch-muted: #b8c4e0;
        --arch-eyebrow: #8cb8ff;
        --arch-pill-bg: #232d47;
        --arch-pill-border: #7388ba;
        --arch-pill-text: #dbe7ff;
        --arch-pill-product-bg: #1a3158;
        --arch-pill-product-border: #6ea8fe;
        --arch-pill-product-text: #d8e9ff;
        --arch-step-bg: #183561;
        --arch-step-border: #6da7ff;
        --arch-step-text: #e0edff;
        --arch-recap-bg: #2b2448;
        --arch-recap-border: #a992ff;
        --arch-recap-text: #ebe4ff;
        --arch-flow-bg: #1e2740;
        --arch-flow-border: #798ec2;
        --arch-flow-text: #d6e2ff;
        --arch-exp-accent: #67b7ff;
        --arch-exp-soft: #182e4d;
        --arch-core-accent: #b7a2ff;
        --arch-core-soft: #27214a;
        --arch-ground-accent: #4adeb5;
        --arch-ground-soft: #13352f;
        --arch-gov-accent: #fbbf24;
        --arch-gov-soft: #362912;
        --arch-outcome-bg: #102c24;
        --arch-outcome-border: #3dd6a3;
        --arch-outcome-label: #7ef2c8;
        --arch-outcome-text: #ecfdf5;
        color-scheme: dark;
      }
    }
    :root[data-theme="dark"] {
      --bg: #0f1117;
      --surface: #181c26;
      --surface-muted: #1f2533;
      --border: #2c3447;
      --border-strong: #6b7394;
      --text: #e6eaf2;
      --text-muted: #9ba6bc;
      --accent: ${darkButton.bg};
      --accent-contrast: ${darkButton.fg};
      --link: ${darkLinkColor};${darkSecondaryVar}
      --code-bg: #111520;
      --code-border: #2c3447;
      --success-bg: #102a22;
      --success-border: #3dd6a3;
      --success-text: #6ee7b7;
      --warn-bg: #332611;
      --warn-border: #d99b26;
      --warn-text: #fde68a;
      --callout-bg: #182238;
      --callout-border: #5b9bff;
      --callout-text: #dce6fa;
      --checked-card-bg: #151e2d;
      --arch-bg: #131826;
      --arch-header-bg: #192033;
      --arch-lane-bg: #171d2e;
      --arch-card-bg: #1f273d;
      --arch-rail-bg: #161c2d;
      --arch-border: #6d7ea8;
      --arch-card-border: #7688b4;
      --arch-connector: #7d92c4;
      --arch-text: #edf2ff;
      --arch-muted: #b8c4e0;
      --arch-eyebrow: #8cb8ff;
      --arch-pill-bg: #232d47;
      --arch-pill-border: #7388ba;
      --arch-pill-text: #dbe7ff;
      --arch-pill-product-bg: #1a3158;
      --arch-pill-product-border: #6ea8fe;
      --arch-pill-product-text: #d8e9ff;
      --arch-step-bg: #183561;
      --arch-step-border: #6da7ff;
      --arch-step-text: #e0edff;
      --arch-recap-bg: #2b2448;
      --arch-recap-border: #a992ff;
      --arch-recap-text: #ebe4ff;
      --arch-flow-bg: #1e2740;
      --arch-flow-border: #798ec2;
      --arch-flow-text: #d6e2ff;
      --arch-exp-accent: #67b7ff;
      --arch-exp-soft: #182e4d;
      --arch-core-accent: #b7a2ff;
      --arch-core-soft: #27214a;
      --arch-ground-accent: #4adeb5;
      --arch-ground-soft: #13352f;
      --arch-gov-accent: #fbbf24;
      --arch-gov-soft: #362912;
      --arch-outcome-bg: #102c24;
      --arch-outcome-border: #3dd6a3;
      --arch-outcome-label: #7ef2c8;
      --arch-outcome-text: #ecfdf5;
      color-scheme: dark;
    }
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ${bodyFontStack};
      background: var(--bg);
      color: var(--text);
      line-height: 1.68;
    }
    .lab-shell {
      max-width: 960px;
      margin: 0 auto;
      padding: 24px 20px 56px;
    }
    .lab-brand-banner {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 12px 18px;
      margin-bottom: 14px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
    }
    .lab-brand-logo {
      max-height: 36px;
      max-width: 140px;
      object-fit: contain;
    }
    .lab-brand-text {
      display: flex;
      flex-direction: column;
      font-size: 13px;
    }
    .lab-brand-text span { color: var(--text-muted); }
    .lab-brand-text .lab-brand-subtitle { font-style: italic; }
    .lab-brand-banner { border-bottom: 3px solid var(--brand-secondary, var(--border)); }
    .lab-brand-footer {
      margin-top: 18px;
      padding-top: 12px;
      border-top: 2px solid var(--brand-secondary, var(--border));
      color: var(--text-muted);
      font-size: 13px;
    }
    .lab-brand-footer p { margin: 0; }
    .lab-pagination-controls {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px 16px;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.04);
    }
    .lab-pagination-top {
      position: sticky;
      top: 10px;
      z-index: 20;
      margin-bottom: 18px;
    }
    .lab-pagination-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }
    .lab-pagination-status {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
    }
    .lab-pagination-nav-group {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .lab-page-select {
      background: var(--surface-muted);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 13px;
      max-width: min(320px, 65vw);
    }
    .lab-page-btn {
      background: var(--surface-muted);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 7px 13px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .lab-page-btn:hover:not(:disabled) {
      border-color: var(--accent);
    }
    .lab-page-btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .lab-page-btn-primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--accent-contrast);
    }
    .lab-pagination-progress {
      height: 5px;
      margin-top: 10px;
      border-radius: 999px;
      background: var(--surface-muted);
      overflow: hidden;
    }
    .lab-pagination-progress-fill {
      width: 100%;
      height: 100%;
      border-radius: 999px;
      background: var(--accent);
      transform-origin: left center;
      transition: transform 0.2s ease;
    }
    .lab-article {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 28px 34px;
    }
    @media (max-width: 640px) {
      .lab-article { padding: 20px 18px; }
    }
    .lab-paged-mode .lab-page:not(.active) {
      display: none;
    }
    .lab-all-pages-mode .lab-page + .lab-page {
      margin-top: 32px;
      padding-top: 24px;
      border-top: 1px solid var(--border);
    }
    .lab-pagination-bottom {
      margin-top: 18px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .lab-complete-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      font-weight: 600;
      padding: 7px 14px;
      border-radius: 999px;
      background: var(--success-bg);
      border: 1px solid var(--success-border);
      color: var(--success-text);
    }
    .lab-article h1 { font-size: 28px; line-height: 1.25; margin: 0 0 18px; border-bottom: 2px solid var(--border); padding-bottom: 12px; color: var(--text); }
    .lab-article h2 { font-size: 21px; line-height: 1.3; margin: 32px 0 14px; padding-top: 18px; border-top: 1px solid var(--border); color: var(--text); }
    .lab-article .lab-page > h2:first-child,
    .lab-article h1 + h2 { margin-top: 0; padding-top: 0; border-top: 0; }
    .lab-article h3 { font-size: 17.5px; line-height: 1.35; margin: 28px 0 10px; padding-top: 18px; border-top: 1px solid var(--border); color: var(--text); }
    .lab-article h2 + h3,
    .lab-article .lab-page > h3:first-child { margin-top: 12px; padding-top: 0; border-top: 0; }
    .lab-article h4, .lab-article h5 { margin: 18px 0 8px; line-height: 1.35; color: var(--text); }
    .lab-article p { margin: 0 0 14px; line-height: 1.72; max-width: 78ch; }
    .lab-article ul, .lab-article ol { padding-left: 26px; margin: 8px 0 16px; }
    .lab-article li { margin: 0 0 8px; line-height: 1.68; max-width: 76ch; }
    .lab-article li:last-child { margin-bottom: 0; }
    .lab-article li > ul,
    .lab-article li > ol { margin: 6px 0 6px; }
    .lab-article ol > li { padding-left: 4px; margin-bottom: 10px; }
    .lab-article ol > li::marker { font-weight: 700; color: var(--link); }
    .lab-article ol.lab-substeps { margin: 6px 0 2px; padding-left: 22px; list-style-type: lower-alpha; }
    .lab-article ol.lab-substeps > li { margin: 0 0 4px; line-height: 1.6; break-inside: avoid; }
    .lab-article ol.lab-substeps > li::marker { font-weight: 600; }
    .lab-article .lab-substeps-note { margin: 2px 0 0; font-size: 0.92em; color: var(--text-muted); }
    .lab-article li > p,
    .lab-article td > p:last-child,
    .lab-article th > p:last-child,
    .lab-article blockquote > p:last-child,
    .lab-article details > :last-child { margin-bottom: 0; }
    .lab-article blockquote > p + p,
    .lab-article details > p + p { margin-top: 10px; }
    .lab-article .lab-module-meta {
      display: inline-block;
      margin: 0 0 16px;
      padding: 4px 12px;
      border-radius: 999px;
      background: var(--surface-muted);
      border: 1px solid var(--border-strong);
      color: var(--text-muted);
      font-size: 13px;
      line-height: 1.4;
      max-width: none;
    }
    .lab-article .lab-module-meta em { font-style: normal; font-weight: 600; }
    .lab-article .lab-subhead {
      margin: 22px 0 10px;
      padding-bottom: 5px;
      border-bottom: 1px solid var(--border);
      font-size: 14.5px;
      letter-spacing: 0.01em;
      color: var(--text);
      max-width: none;
    }
    .lab-article .lab-scenario-callout {
      margin: 16px 0;
      padding: 12px 16px;
      border-radius: 8px;
      border: 1px solid var(--callout-border);
      background: var(--callout-bg);
      color: var(--callout-text);
      max-width: none;
    }
    .lab-article hr { border: 0; border-top: 1px solid var(--border); margin: 26px 0; }
    .lab-article a { color: var(--link); text-decoration: underline; text-underline-offset: 2px; }
    .lab-article code {
      background: var(--code-bg);
      color: var(--text);
      border: 1px solid var(--code-border);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.9em;
    }
    .lab-article pre {
      background: var(--code-bg);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px 16px;
      overflow-x: auto;
      font-size: 13px;
      line-height: 1.55;
      margin: 14px 0 18px;
    }
    .lab-article pre code { background: none; border: 0; padding: 0; }
    .lab-article blockquote {
      margin: 16px 0;
      padding: 12px 16px;
      border: 1px solid var(--border-strong);
      background: var(--surface-muted);
      color: var(--text);
      border-radius: 8px;
    }
    .lab-article table {
      width: 100%;
      border-collapse: collapse;
      margin: 14px 0 20px;
      font-size: 14px;
    }
    .lab-article th, .lab-article td {
      border: 1px solid var(--border);
      padding: 9px 12px;
      text-align: left;
      vertical-align: top;
      color: var(--text);
    }
    .lab-article th {
      background: var(--surface-muted);
      font-weight: 600;
    }
    .lab-article img {
      max-width: 100%;
      height: auto;
      border-radius: 8px;
      border: 1px solid var(--border-strong);
      margin: 10px 0 6px;
    }
    ${PENDING_SHOT_CSS}
    ${META_TABLE_CSS}
    .lab-article details {
      margin: 16px 0;
      padding: 12px 16px;
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      background: var(--surface-muted);
      color: var(--text);
    }
    .lab-article details[open] > summary {
      margin-bottom: 10px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 8px;
    }
    .lab-article summary {
      cursor: pointer;
      font-weight: 600;
      color: var(--text);
    }
    .lab-article summary:focus-visible,
    .lab-page-btn:focus-visible,
    .lab-page-select:focus-visible,
    .lab-article .task-list-item-checkbox:focus-visible,
    .lab-article .lab-quiz-radio:focus-visible,
    .lab-article .lab-quiz-btn:focus-visible {
      outline: 3px solid var(--link);
      outline-offset: 2px;
    }
    .lab-article ul.contains-task-list {
      list-style: none;
      padding-left: 0;
      margin: 10px 0 18px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .lab-article li.task-list-item {
      list-style: none;
      margin: 0;
      padding: 0;
      max-width: none;
    }
    .lab-article .task-list-label {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 10px 14px;
      border-radius: 8px;
      border: 1px solid var(--border-strong);
      background: var(--surface-muted);
      color: var(--text);
      cursor: pointer;
      line-height: 1.55;
    }
    .lab-article .task-list-label:hover { border-color: var(--accent); }
    .lab-article .task-list-item-checkbox {
      width: 18px;
      height: 18px;
      margin: 3px 0 0;
      flex-shrink: 0;
      accent-color: var(--accent);
      cursor: pointer;
    }
    .lab-article li.task-list-item.is-checked .task-list-label {
      background: var(--success-bg);
      border-color: var(--success-border);
    }
    .lab-article li.task-list-item.is-checked .task-list-item-text {
      text-decoration: line-through;
      text-decoration-thickness: 1.5px;
    }
    .lab-article .lab-quiz {
      margin: 22px 0 20px;
      padding: 18px 20px;
      border-radius: 12px;
      border: 1px solid var(--border-strong);
      background: var(--surface-muted);
      color: var(--text);
    }
    .lab-article .lab-quiz-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      padding-bottom: 12px;
      margin-bottom: 14px;
      border-bottom: 1px solid var(--border);
    }
    .lab-article .lab-quiz-eyebrow {
      display: inline-block;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--link);
    }
    .lab-article .lab-quiz-title {
      margin: 2px 0 0;
      font-size: 16px;
      line-height: 1.35;
      max-width: none;
    }
    .lab-article .lab-quiz-intro {
      margin: 4px 0 0;
      font-size: 13.5px;
      color: var(--text-muted);
      max-width: none;
    }
    .lab-article .lab-quiz-score {
      display: inline-flex;
      align-items: center;
      padding: 4px 12px;
      border-radius: 999px;
      font-size: 12.5px;
      font-weight: 700;
      background: var(--callout-bg);
      border: 1px solid var(--callout-border);
      color: var(--callout-text);
    }
    .lab-article .lab-quiz-score.is-complete {
      background: var(--success-bg);
      border-color: var(--success-border);
      color: var(--success-text);
    }
    .lab-article .lab-quiz-question {
      margin: 0 0 16px;
      padding: 14px 16px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--surface);
      min-width: 0;
    }
    .lab-article .lab-quiz-legend {
      padding: 0 4px;
      font-size: 14.5px;
      line-height: 1.5;
      color: var(--text);
      font-weight: 500;
    }
    .lab-article .lab-quiz-options {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 10px;
    }
    .lab-article .lab-quiz-option {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid var(--border-strong);
      background: var(--surface-muted);
      color: var(--text);
      cursor: pointer;
      line-height: 1.5;
    }
    .lab-article .lab-quiz-option:hover { border-color: var(--accent); }
    .lab-article .lab-quiz-option.is-selected {
      border-color: var(--accent);
      background: var(--checked-card-bg);
    }
    .lab-article .lab-quiz-option.is-correct-choice {
      border-color: var(--success-border);
      background: var(--success-bg);
    }
    .lab-article .lab-quiz-option.is-wrong-choice {
      border-color: var(--warn-border);
      background: var(--warn-bg);
    }
    .lab-article .lab-quiz-radio {
      width: 17px;
      height: 17px;
      margin-top: 3px;
      flex-shrink: 0;
      accent-color: var(--accent);
      cursor: pointer;
    }
    .lab-article .lab-quiz-option-letter {
      font-weight: 700;
      color: var(--link);
      flex-shrink: 0;
    }
    .lab-article .lab-quiz-actions,
    .lab-article .lab-quiz-footer {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 12px;
    }
    .lab-article .lab-quiz-btn {
      padding: 6px 14px;
      border-radius: 6px;
      border: 1px solid var(--border-strong);
      background: var(--surface);
      color: var(--text);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    .lab-article .lab-quiz-btn:hover { border-color: var(--accent); }
    .lab-article .lab-quiz-btn-primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--accent-contrast);
    }
    .lab-article .lab-quiz-status {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
    }
    .lab-article .lab-quiz-question.is-correct .lab-quiz-status { color: var(--success-text); }
    .lab-article .lab-quiz-question.is-incorrect .lab-quiz-status { color: var(--warn-text); }
    .lab-article .lab-quiz-explanation {
      margin-top: 12px;
      padding: 12px 14px;
      border-radius: 8px;
      border: 1px solid var(--callout-border);
      background: var(--callout-bg);
      color: var(--callout-text);
      font-size: 14px;
      line-height: 1.6;
    }
    .lab-article .lab-quiz-explanation[hidden] { display: none; }
    .lab-article .lab-quiz-explanation p { max-width: none; }
    .lab-article .lab-quiz-learn-ref {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--border);
      font-size: 13.5px;
    }
    .lab-article .mermaid {
      margin: 18px 0;
      padding: 14px 16px;
      background: var(--code-bg);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow-x: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
      white-space: pre;
      text-align: left;
    }
    .lab-article .shot-pending { color: var(--text); }
    .lab-article .lab-branding-tagline { color: var(--text-muted); }
    .lab-article .tag {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      background: var(--surface-muted);
      border: 1px solid var(--border);
      color: var(--link);
    }
    .lab-arch {
      margin: 18px 0 22px;
      background: var(--arch-bg);
      color: var(--arch-text);
      border: 1px solid var(--arch-border);
      border-radius: 12px;
      overflow: hidden;
    }
    .lab-arch-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 14px;
      flex-wrap: wrap;
      padding: 14px 18px;
      background: var(--arch-header-bg);
      border-bottom: 1px solid var(--arch-border);
    }
    .lab-arch-title-block {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 220px;
      flex: 1 1 280px;
    }
    .lab-arch-eyebrow,
    .lab-arch-kicker,
    .lab-arch-outcome-kicker {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: var(--arch-eyebrow);
    }
    .lab-arch-eyebrow-svg { width: 14px; height: 14px; flex-shrink: 0; }
    .lab-arch-title { font-size: 18px; font-weight: 700; line-height: 1.25; color: var(--arch-text); }
    .lab-arch-subtitle { font-size: 12.5px; line-height: 1.45; color: var(--arch-muted); }
    .lab-arch-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      justify-content: flex-end;
    }
    .lab-arch-pill {
      display: inline-flex;
      align-items: center;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 11.5px;
      font-weight: 600;
      line-height: 1.35;
      background: var(--arch-pill-bg);
      border: 1px solid var(--arch-pill-border);
      color: var(--arch-pill-text);
    }
    .lab-arch-pill-product {
      background: var(--arch-pill-product-bg);
      border-color: var(--arch-pill-product-border);
      color: var(--arch-pill-product-text);
    }
    .lab-arch-pill-modules {
      background: var(--arch-step-bg);
      border-color: var(--arch-step-border);
      color: var(--arch-step-text);
    }
    .lab-arch-flow {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto minmax(0, 1.15fr) auto minmax(0, 1fr);
      gap: 10px;
      align-items: stretch;
      padding: 16px 18px 12px;
    }
    @media (max-width: 880px) {
      .lab-arch-flow { grid-template-columns: minmax(0, 1fr); gap: 8px; }
    }
    .lab-arch-lane {
      --arch-stage-accent: var(--arch-core-accent);
      --arch-stage-soft: var(--arch-core-soft);
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 12px 13px;
      border-radius: 10px;
      background: var(--arch-lane-bg);
      border: 1px solid var(--arch-border);
      min-width: 0;
    }
    .lab-arch-lane-cyan {
      --arch-stage-accent: var(--arch-exp-accent);
      --arch-stage-soft: var(--arch-exp-soft);
    }
    .lab-arch-lane-blue {
      --arch-stage-accent: var(--arch-core-accent);
      --arch-stage-soft: var(--arch-core-soft);
    }
    .lab-arch-lane-indigo,
    .lab-arch-lane-emerald {
      --arch-stage-accent: var(--arch-ground-accent);
      --arch-stage-soft: var(--arch-ground-soft);
    }
    .lab-arch-lane-head {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--arch-border);
    }
    .lab-arch-lane-title-row { display: flex; align-items: center; gap: 7px; min-width: 0; }
    .lab-arch-stage-num {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 24px;
      height: 22px;
      padding: 0 6px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 700;
      background: var(--arch-stage-soft);
      color: var(--arch-stage-accent);
      border: 1px solid var(--arch-stage-accent);
      flex-shrink: 0;
    }
    .lab-arch-lane-icon { display: inline-flex; align-items: center; color: var(--arch-stage-accent); flex-shrink: 0; }
    .lab-arch-lane-title { font-size: 13px; font-weight: 700; line-height: 1.3; color: var(--arch-text); }
    .lab-arch-lane-sub { font-size: 11.5px; line-height: 1.38; color: var(--arch-muted); }
    .lab-article .lab-arch-cards,
    .lab-arch .lab-arch-cards,
    .lab-article .lab-arch-guardrails,
    .lab-arch .lab-arch-guardrails {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .lab-article .lab-arch-cards,
    .lab-arch .lab-arch-cards {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .lab-article .lab-arch-guardrails,
    .lab-arch .lab-arch-guardrails {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 9px;
      margin-top: 8px;
    }
    .lab-article .lab-arch-card,
    .lab-arch .lab-arch-card,
    .lab-article .lab-arch-guardrail,
    .lab-arch .lab-arch-guardrail {
      list-style: none;
      margin: 0;
      padding: 10px 11px;
      border-radius: 8px;
      background: var(--arch-card-bg);
      border: 1px solid var(--arch-card-border);
      display: flex;
      flex-direction: column;
      gap: 5px;
      min-width: 0;
    }
    .lab-arch-card-primary {
      background: var(--arch-stage-soft);
      border-color: var(--arch-stage-accent);
    }
    .lab-arch-card-head,
    .lab-arch-guardrail-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .lab-arch-card-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      border-radius: 6px;
      background: var(--arch-stage-soft);
      color: var(--arch-stage-accent);
      border: 1px solid var(--arch-stage-accent);
      flex-shrink: 0;
    }
    .lab-arch-svg { width: 15px; height: 15px; display: block; }
    .lab-arch-card-title,
    .lab-arch-guardrail-title { font-size: 12.5px; font-weight: 700; line-height: 1.3; color: var(--arch-text); word-break: break-word; }
    .lab-arch-card-role,
    .lab-arch-guardrail-detail { font-size: 11.5px; line-height: 1.45; color: var(--arch-muted); }
    .lab-arch-badges { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 2px; }
    .lab-arch-chip {
      display: inline-flex;
      align-items: center;
      padding: 1px 7px;
      border-radius: 999px;
      font-size: 10.5px;
      font-weight: 700;
      line-height: 1.4;
      letter-spacing: 0.01em;
    }
    .lab-arch-chip-step {
      background: var(--arch-step-bg);
      border: 1px solid var(--arch-step-border);
      color: var(--arch-step-text);
    }
    .lab-arch-chip-recap {
      background: var(--arch-recap-bg);
      border: 1px solid var(--arch-recap-border);
      color: var(--arch-recap-text);
    }
    .lab-arch-connector {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
      width: 88px;
      padding: 6px 2px;
      text-align: center;
      color: var(--arch-connector);
    }
    .lab-arch-connector-line { width: 2px; height: 16px; background: var(--arch-connector); border-radius: 999px; }
    .lab-arch-connector-badge {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: 6px 7px;
      border-radius: 8px;
      background: var(--arch-flow-bg);
      border: 1px solid var(--arch-flow-border);
      color: var(--arch-flow-text);
    }
    .lab-arch-arrow-svg { width: 16px; height: 16px; display: block; }
    .lab-arch-connector-text {
      font-size: 10.5px;
      font-weight: 600;
      line-height: 1.25;
      color: var(--arch-flow-text);
    }
    @media (max-width: 880px) {
      .lab-arch-connector { flex-direction: row; width: 100%; padding: 2px 0; }
      .lab-arch-connector-line { width: 24px; height: 2px; }
      .lab-arch-connector-badge { flex-direction: row; padding: 4px 10px; }
      .lab-arch-arrow-svg { transform: rotate(90deg); }
    }
    .lab-arch-rail-bridge {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 0 18px 10px;
    }
    .lab-arch-rail-line { flex: 1 1 auto; height: 1px; background: var(--arch-border); }
    .lab-arch-rail-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      background: var(--arch-flow-bg);
      border: 1px solid var(--arch-flow-border);
      color: var(--arch-flow-text);
    }
    .lab-arch-foundation {
      --arch-stage-accent: var(--arch-gov-accent);
      --arch-stage-soft: var(--arch-gov-soft);
      display: grid;
      grid-template-columns: minmax(0, 1.85fr) minmax(240px, 1fr);
      gap: 12px;
      padding: 13px 18px 16px;
      background: var(--arch-rail-bg);
      border-top: 1px solid var(--arch-border);
    }
    @media (max-width: 820px) {
      .lab-arch-foundation { grid-template-columns: minmax(0, 1fr); }
    }
    .lab-arch-guardrails-section { min-width: 0; }
    .lab-arch-kicker { color: var(--arch-gov-accent); }
    .lab-arch-outcome {
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 6px;
      padding: 12px 14px;
      border-radius: 10px;
      background: var(--arch-outcome-bg);
      border: 1px solid var(--arch-outcome-border);
      color: var(--arch-outcome-text);
    }
    .lab-arch-outcome-kicker { color: var(--arch-outcome-label); }
    .lab-arch-outcome-kpi { font-size: 13px; font-weight: 700; line-height: 1.4; color: var(--arch-outcome-text); }
    .lab-arch-outcome-boundary { font-size: 11.5px; line-height: 1.4; color: var(--arch-outcome-label); }
    .lab-arch-fallback { margin: 14px 0; }
    @media print {
      body { background: #ffffff !important; color: #111111 !important; }
      .lab-shell { max-width: 100%; padding: 0; }
      .lab-pagination-controls { display: none !important; }
      .lab-brand-banner { background: #ffffff !important; color: #111111 !important; border-color: #cccccc !important; }
      .lab-brand-text span { color: #333333 !important; }
      .lab-brand-footer { color: #333333 !important; border-color: #cccccc !important; }
      .lab-article { background: #ffffff !important; color: #111111 !important; border: none; padding: 0; }
      .lab-article h1,
      .lab-article h2,
      .lab-article h3,
      .lab-article h4,
      .lab-article h5,
      .lab-article p,
      .lab-article li,
      .lab-article th,
      .lab-article td,
      .lab-article code,
      .lab-article pre,
      .lab-article blockquote,
      .lab-article details,
      .lab-article summary,
      .lab-article .shot-pending { color: #111111 !important; }
      .lab-article a { color: #0b3d91 !important; }
      .lab-article th,
      .lab-article td { background: #ffffff !important; border: 1px solid #bbbbbb !important; }
      .lab-article code,
      .lab-article pre,
      .lab-article .mermaid { background: #f6f8fa !important; border-color: #d0d7de !important; }
      .lab-article pre code { background: transparent !important; border: 0 !important; }
      .lab-article blockquote,
      .lab-article details,
      .lab-article .lab-module-meta,
      .lab-article .lab-scenario-callout,
      .lab-article .task-list-label,
      .lab-article .lab-quiz,
      .lab-article .lab-quiz-question,
      .lab-article .lab-quiz-option,
      .lab-article .lab-quiz-explanation { background: #f8f9fa !important; border-color: #bbbbbb !important; color: #111111 !important; }
      .lab-article .lab-quiz-actions,
      .lab-article .lab-quiz-footer,
      .lab-article .lab-quiz-score { display: none !important; }
      .lab-article .lab-quiz-explanation[hidden] { display: block !important; }
      .lab-article .lab-arch,
      .lab-arch {
        --arch-bg: #ffffff;
        --arch-header-bg: #f6f8fa;
        --arch-lane-bg: #ffffff;
        --arch-card-bg: #ffffff;
        --arch-rail-bg: #f8fafc;
        --arch-border: #64748b;
        --arch-card-border: #94a3b8;
        --arch-connector: #334155;
        --arch-text: #111111;
        --arch-muted: #334155;
        --arch-eyebrow: #0b3d91;
        --arch-pill-bg: #ffffff;
        --arch-pill-border: #64748b;
        --arch-pill-text: #111111;
        --arch-pill-product-bg: #eef4ff;
        --arch-pill-product-border: #1d4ed8;
        --arch-pill-product-text: #0b3d91;
        --arch-step-bg: #eef4ff;
        --arch-step-border: #1d4ed8;
        --arch-step-text: #0b3d91;
        --arch-recap-bg: #f5f0ff;
        --arch-recap-border: #5b21b6;
        --arch-recap-text: #3b0764;
        --arch-flow-bg: #f8fafc;
        --arch-flow-border: #64748b;
        --arch-flow-text: #111111;
        --arch-exp-accent: #0b3d91;
        --arch-exp-soft: #eef4ff;
        --arch-core-accent: #4c1d95;
        --arch-core-soft: #f5f0ff;
        --arch-ground-accent: #065f46;
        --arch-ground-soft: #ecfdf5;
        --arch-gov-accent: #78350f;
        --arch-gov-soft: #fffbeb;
        --arch-outcome-bg: #f0fdf4;
        --arch-outcome-border: #065f46;
        --arch-outcome-label: #065f46;
        --arch-outcome-text: #111111;
        background: #ffffff !important;
        page-break-inside: avoid !important;
        break-inside: avoid !important;
      }
      .lab-page { display: block !important; }
      .lab-page + .lab-page { margin-top: 24px; padding-top: 16px; border-top: 1px solid #cccccc; }
    }
  </style>
</head>
<body>
  <div class="lab-shell">
    ${brandingHeader}
    <nav class="lab-pagination-controls lab-pagination-top" aria-label="Lab page navigation"${pages.length <= 1 ? ' style="display:none"' : ""}>
      <div class="lab-pagination-row">
        <span id="lab-page-indicator" class="lab-pagination-status" role="status" aria-live="polite">Page 1 of ${pages.length}</span>
        <div class="lab-pagination-nav-group">
          <select id="lab-page-select" class="lab-page-select" aria-label="Jump to lab page">
            ${pageOptionsHtml}
          </select>
          <button type="button" id="lab-top-prev" data-nav="prev" class="lab-page-btn" disabled>← Previous</button>
          <button type="button" id="lab-top-next" data-nav="next" class="lab-page-btn lab-page-btn-primary"${pages.length <= 1 ? " disabled" : ""}>Next →</button>
          <button type="button" id="lab-view-all-btn" class="lab-page-btn" aria-pressed="false">Show all pages</button>
          <button type="button" id="lab-theme-btn" class="lab-page-btn" aria-label="Toggle color theme">Theme</button>
        </div>
      </div>
      <div class="lab-pagination-progress" aria-hidden="true">
        <div id="lab-progress-fill" class="lab-pagination-progress-fill" style="transform: scaleX(${(1 / pages.length).toFixed(4)})"></div>
      </div>
    </nav>

    <main id="lab-article" class="lab-article lab-paged-mode" data-lab-scope="${escapeHtml(storageScope)}">
${pagesHtml}
    </main>

    <nav class="lab-pagination-controls lab-pagination-bottom" aria-label="Lab page footer navigation"${pages.length <= 1 ? ' style="display:none"' : ""}>
      <button type="button" id="lab-prev-btn" data-nav="prev" class="lab-page-btn" disabled>← Previous</button>
      <span id="lab-bottom-status" class="lab-pagination-status">Page 1 of ${pages.length}</span>
      <button type="button" id="lab-next-btn" data-nav="next" class="lab-page-btn lab-page-btn-primary"${pages.length <= 1 ? ' style="display:none"' : ""}>${nextInitialLabel}</button>
      <span id="lab-complete-badge" class="lab-complete-badge"${pages.length > 1 ? " hidden" : ""}>✓ Final page reached</span>
    </nav>
    ${brandingFooter}
  </div>

  <script>
    (function () {
      const article = document.getElementById("lab-article");
      if (!article) return;

      const scope = article.getAttribute("data-lab-scope") || "standalone-lab";
      const taskStorageKey = "csl-lab-tasks:" + scope;
      const quizStorageKey = "csl-lab-quizzes:" + scope;

      function readStoredJson(key) {
        try {
          const raw = window.localStorage ? window.localStorage.getItem(key) : null;
          const parsed = raw ? JSON.parse(raw) : null;
          return parsed && typeof parsed === "object" ? parsed : {};
        } catch (_err) {
          return {};
        }
      }

      function writeStoredJson(key, value) {
        try {
          if (window.localStorage) window.localStorage.setItem(key, JSON.stringify(value));
        } catch (_err) {
          /* storage unavailable */
        }
      }

      const savedTasks = readStoredJson(taskStorageKey);
      function syncCheckboxRow(checkbox) {
        checkbox.disabled = false;
        checkbox.removeAttribute("disabled");
        const li = checkbox.closest ? checkbox.closest(".task-list-item") : null;
        const label = checkbox.closest ? checkbox.closest(".task-list-label") : null;
        if (li) li.classList.toggle("is-checked", Boolean(checkbox.checked));
        if (label) label.classList.toggle("is-checked", Boolean(checkbox.checked));
      }

      Array.from(article.querySelectorAll("input.task-list-item-checkbox")).forEach(function (checkbox) {
        const key = checkbox.getAttribute("data-task-key");
        if (key && Object.prototype.hasOwnProperty.call(savedTasks, key)) {
          checkbox.checked = Boolean(savedTasks[key]);
        }
        syncCheckboxRow(checkbox);
      });

      const savedQuizzes = readStoredJson(quizStorageKey);

      function syncOptionSelection(fieldset) {
        Array.from(fieldset.querySelectorAll(".lab-quiz-option")).forEach(function (optLabel) {
          const radio = optLabel.querySelector("input.lab-quiz-radio");
          optLabel.classList.toggle("is-selected", Boolean(radio && radio.checked));
        });
      }

      function clearQuestionGrade(fieldset) {
        fieldset.removeAttribute("data-quiz-state");
        fieldset.classList.remove("is-correct", "is-incorrect");
        Array.from(fieldset.querySelectorAll(".lab-quiz-option")).forEach(function (optLabel) {
          optLabel.classList.remove("is-correct", "is-incorrect");
        });
        const statusEl = fieldset.querySelector("[data-quiz-status]");
        if (statusEl) statusEl.textContent = "";
        const explanationEl = fieldset.querySelector("[data-quiz-explanation]");
        if (explanationEl) explanationEl.hidden = true;
      }

      function gradeQuestion(fieldset) {
        const correct = (fieldset.getAttribute("data-correct") || "").toUpperCase();
        const checkedRadio = fieldset.querySelector("input.lab-quiz-radio:checked");
        const statusEl = fieldset.querySelector("[data-quiz-status]");
        const explanationEl = fieldset.querySelector("[data-quiz-explanation]");
        Array.from(fieldset.querySelectorAll(".lab-quiz-option")).forEach(function (optLabel) {
          optLabel.classList.remove("is-correct", "is-incorrect");
        });
        if (!checkedRadio) {
          fieldset.removeAttribute("data-quiz-state");
          fieldset.classList.remove("is-correct", "is-incorrect");
          if (statusEl) statusEl.textContent = "Select an answer choice (A–D) first.";
          if (explanationEl) explanationEl.hidden = true;
          return false;
        }
        const chosen = (checkedRadio.value || "").toUpperCase();
        const isRight = Boolean(correct) && chosen === correct;
        fieldset.setAttribute("data-quiz-state", isRight ? "correct" : "incorrect");
        fieldset.classList.toggle("is-correct", isRight);
        fieldset.classList.toggle("is-incorrect", !isRight);
        Array.from(fieldset.querySelectorAll(".lab-quiz-option")).forEach(function (optLabel) {
          const letter = (optLabel.getAttribute("data-option-letter") || "").toUpperCase();
          if (letter === correct) optLabel.classList.add("is-correct");
          else if (letter === chosen && !isRight) optLabel.classList.add("is-incorrect");
        });
        if (statusEl) {
          statusEl.textContent = isRight
            ? "Correct — Option " + chosen + "."
            : "Not quite — Option " + chosen + " is not right. Review the explanation and Microsoft Learn reference below, or try again.";
        }
        if (explanationEl) explanationEl.hidden = false;
        return isRight;
      }

      function updateQuizScore(quizSection) {
        const fieldsets = Array.from(quizSection.querySelectorAll(".lab-quiz-question"));
        const rightCount = fieldsets.filter(function (fs) {
          return fs.getAttribute("data-quiz-state") === "correct";
        }).length;
        const scoreEl = quizSection.querySelector("[data-quiz-score]");
        if (scoreEl) scoreEl.textContent = rightCount + " / " + fieldsets.length + " correct";
      }

      function persistQuiz(quizSection) {
        const quizId = quizSection.getAttribute("data-quiz-id");
        if (!quizId) return;
        const state = { answers: {}, checked: {} };
        Array.from(quizSection.querySelectorAll(".lab-quiz-question")).forEach(function (fs, idx) {
          const checkedRadio = fs.querySelector("input.lab-quiz-radio:checked");
          if (checkedRadio) state.answers[String(idx)] = checkedRadio.value;
          if (fs.getAttribute("data-quiz-state")) state.checked[String(idx)] = true;
        });
        savedQuizzes[quizId] = state;
        writeStoredJson(quizStorageKey, savedQuizzes);
      }

      Array.from(article.querySelectorAll(".lab-quiz")).forEach(function (quizSection) {
        const quizId = quizSection.getAttribute("data-quiz-id");
        const stored = quizId && savedQuizzes[quizId] ? savedQuizzes[quizId] : null;
        if (stored && stored.answers) {
          Array.from(quizSection.querySelectorAll(".lab-quiz-question")).forEach(function (fs, idx) {
            const val = stored.answers[String(idx)];
            if (val) {
              const targetRadio = fs.querySelector('input.lab-quiz-radio[value="' + val + '"]');
              if (targetRadio) targetRadio.checked = true;
            }
            syncOptionSelection(fs);
            if (stored.checked && stored.checked[String(idx)]) gradeQuestion(fs);
          });
        }
        updateQuizScore(quizSection);
      });

      article.addEventListener("change", function (event) {
        const target = event.target;
        if (!target) return;
        if (target.classList && target.classList.contains("task-list-item-checkbox")) {
          syncCheckboxRow(target);
          const key = target.getAttribute("data-task-key");
          if (key) {
            if (target.checked) savedTasks[key] = true;
            else delete savedTasks[key];
            writeStoredJson(taskStorageKey, savedTasks);
          }
          return;
        }
        if (target.classList && target.classList.contains("lab-quiz-radio")) {
          const fs = target.closest ? target.closest(".lab-quiz-question") : null;
          const quizSection = target.closest ? target.closest(".lab-quiz") : null;
          if (fs) {
            clearQuestionGrade(fs);
            syncOptionSelection(fs);
          }
          if (quizSection) {
            updateQuizScore(quizSection);
            persistQuiz(quizSection);
          }
        }
      });

      article.addEventListener("click", function (event) {
        const btn = event.target && event.target.closest ? event.target.closest("button.lab-quiz-btn") : null;
        if (!btn) return;
        const quizSection = btn.closest(".lab-quiz");
        if (!quizSection) return;
        if (btn.hasAttribute("data-quiz-check-one")) {
          const fs = btn.closest(".lab-quiz-question");
          if (fs) gradeQuestion(fs);
          updateQuizScore(quizSection);
          persistQuiz(quizSection);
        } else if (btn.hasAttribute("data-quiz-check-all")) {
          Array.from(quizSection.querySelectorAll(".lab-quiz-question")).forEach(gradeQuestion);
          updateQuizScore(quizSection);
          persistQuiz(quizSection);
        } else if (btn.hasAttribute("data-quiz-reset")) {
          Array.from(quizSection.querySelectorAll(".lab-quiz-question")).forEach(function (fs) {
            Array.from(fs.querySelectorAll("input.lab-quiz-radio")).forEach(function (r) {
              r.checked = false;
            });
            clearQuestionGrade(fs);
            syncOptionSelection(fs);
          });
          updateQuizScore(quizSection);
          const quizId = quizSection.getAttribute("data-quiz-id");
          if (quizId) {
            delete savedQuizzes[quizId];
            writeStoredJson(quizStorageKey, savedQuizzes);
          }
        }
      });

      const pages = Array.from(article.querySelectorAll(".lab-page"));
      if (pages.length <= 1) return;

      const indicator = document.getElementById("lab-page-indicator");
      const bottomStatus = document.getElementById("lab-bottom-status");
      const select = document.getElementById("lab-page-select");
      const progressFill = document.getElementById("lab-progress-fill");
      const topPrev = document.getElementById("lab-top-prev");
      const topNext = document.getElementById("lab-top-next");
      const prevBtn = document.getElementById("lab-prev-btn");
      const nextBtn = document.getElementById("lab-next-btn");
      const completeBadge = document.getElementById("lab-complete-badge");
      const viewAllBtn = document.getElementById("lab-view-all-btn");
      const themeBtn = document.getElementById("lab-theme-btn");

      let currentIndex = 0;
      let showAll = false;

      function syncControls(scrollToTop) {
        pages.forEach((page, idx) => {
          page.classList.toggle("active", showAll || idx === currentIndex);
        });
        article.classList.toggle("lab-paged-mode", !showAll);
        article.classList.toggle("lab-all-pages-mode", showAll);

        if (select) {
          select.value = String(currentIndex);
          select.disabled = showAll;
        }
        const label = showAll
          ? "Showing all " + pages.length + " pages"
          : "Page " + (currentIndex + 1) + " of " + pages.length + " — " + (pages[currentIndex].getAttribute("data-page-title") || "");
        if (indicator) indicator.textContent = label;
        if (bottomStatus) {
          bottomStatus.textContent = showAll
            ? "All " + pages.length + " pages shown"
            : "Page " + (currentIndex + 1) + " of " + pages.length;
        }
        if (progressFill) {
          const ratio = showAll ? 1 : (currentIndex + 1) / pages.length;
          progressFill.style.transform = "scaleX(" + ratio.toFixed(4) + ")";
        }

        const atStart = showAll || currentIndex <= 0;
        const atEnd = showAll || currentIndex >= pages.length - 1;
        if (topPrev) topPrev.disabled = atStart;
        if (prevBtn) prevBtn.disabled = atStart;
        if (topNext) topNext.disabled = atEnd;

        if (nextBtn) {
          if (showAll || currentIndex >= pages.length - 1) {
            nextBtn.style.display = "none";
          } else {
            const nextTitle = pages[currentIndex + 1].getAttribute("data-page-title") || "Next section";
            nextBtn.style.display = "inline-flex";
            nextBtn.textContent = "Next: " + nextTitle + " →";
          }
        }
        if (completeBadge) {
          completeBadge.hidden = showAll || currentIndex < pages.length - 1;
        }
        if (viewAllBtn) {
          viewAllBtn.setAttribute("aria-pressed", String(showAll));
          viewAllBtn.textContent = showAll ? "Paged view" : "Show all pages";
        }

        if (scrollToTop && !showAll) {
          const prefersReduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          window.scrollTo({ top: 0, behavior: prefersReduced ? "auto" : "smooth" });
        }
      }

      function goToPage(index, scrollToTop) {
        const clamped = Math.max(0, Math.min(pages.length - 1, Number(index) || 0));
        currentIndex = clamped;
        if (showAll) showAll = false;
        syncControls(scrollToTop);
      }

      if (topPrev) topPrev.addEventListener("click", function () { goToPage(currentIndex - 1, true); });
      if (prevBtn) prevBtn.addEventListener("click", function () { goToPage(currentIndex - 1, true); });
      if (topNext) topNext.addEventListener("click", function () { goToPage(currentIndex + 1, true); });
      if (nextBtn) nextBtn.addEventListener("click", function () { goToPage(currentIndex + 1, true); });
      if (select) {
        select.addEventListener("change", function () {
          goToPage(Number(select.value), true);
        });
      }
      if (viewAllBtn) {
        viewAllBtn.addEventListener("click", function () {
          showAll = !showAll;
          syncControls(false);
        });
      }
      if (themeBtn) {
        themeBtn.addEventListener("click", function () {
          const root = document.documentElement;
          const darkNow =
            root.getAttribute("data-theme") === "dark" ||
            (!root.getAttribute("data-theme") && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
          root.setAttribute("data-theme", darkNow ? "light" : "dark");
        });
      }

      document.addEventListener("keydown", function (event) {
        if (showAll || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const tag = (event.target && event.target.tagName) ? event.target.tagName.toLowerCase() : "";
        if (tag === "input" || tag === "textarea" || tag === "select" || (event.target && event.target.isContentEditable)) return;
        if (event.key === "ArrowRight" && currentIndex < pages.length - 1) {
          event.preventDefault();
          goToPage(currentIndex + 1, true);
        } else if (event.key === "ArrowLeft" && currentIndex > 0) {
          event.preventDefault();
          goToPage(currentIndex - 1, true);
        }
      });

      article.addEventListener("click", function (event) {
        const anchor = event.target.closest ? event.target.closest('a[href^="#"]') : null;
        if (!anchor) return;
        const rawHash = anchor.getAttribute("href");
        if (!rawHash || rawHash === "#") return;
        const target = document.getElementById(rawHash.slice(1));
        if (!target) return;
        const ownerPage = target.closest(".lab-page");
        if (ownerPage && !showAll) {
          const idx = pages.indexOf(ownerPage);
          if (idx >= 0 && idx !== currentIndex) {
            event.preventDefault();
            goToPage(idx, false);
            target.scrollIntoView({ behavior: "smooth", block: "start" });
          }
        }
      });

      syncControls(false);
    })();
  </script>
</body>
</html>
`;
}

export const renderLabHtmlDocument = renderStandaloneLabHtml;
