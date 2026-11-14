/**
 * Multi-page standalone HTML renderer for generated labs.
 *
 * Zero npm dependencies so `tools/lab-builder/build.mjs` runs offline in bare
 * Node 24 before `npm ci`. Callers in the Express portal may pass
 * `options.renderMarkdown` (such as `renderLabMarkdown`) when desired.
 */

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
    return stash(`<a href="${escapeHtml(safeHref)}">${renderedLabel}</a>`);
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
    .split("|")
    .map((cell) => cell.trim());
}

/**
 * Lightweight, zero-dependency Markdown-to-HTML renderer covering every
 * construct produced by `composer.js` while escaping untrusted HTML.
 */
export function renderLabMarkdownFallback(markdown) {
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
      if (lang === "mermaid") {
        out.push(`<div class="mermaid">${escapeHtml(codeLines.join("\n"))}</div>`);
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
        `<details><summary>${renderInlineMarkdown(summaryText || "Details")}</summary>\n${renderLabMarkdownFallback(innerLines.join("\n"))}\n</details>`,
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
      out.push(`<blockquote>${renderLabMarkdownFallback(quoteLines.join("\n"))}</blockquote>`);
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
            return `<li class="task-list-item"><input class="task-list-item-checkbox" type="checkbox" disabled${checked} /> ${renderInlineMarkdown(taskMatch[2])}</li>`;
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
        items.push(itemText);
      }
      out.push(`<ol>${items.map((it) => `<li>${renderInlineMarkdown(it)}</li>`).join("")}</ol>`);
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
export function renderStandaloneLabHtml(markdown, options = {}) {
  const renderMd = typeof options.renderMarkdown === "function" ? options.renderMarkdown : renderLabMarkdownFallback;
  let bodyHtml = renderMd(String(markdown ?? ""));
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

  const branding = options.branding && typeof options.branding === "object" ? options.branding : null;
  const accentColor =
    branding?.primaryColor && /^#[0-9a-f]{3,8}$/i.test(branding.primaryColor)
      ? branding.primaryColor
      : "#1a56c7";

  const brandingHeader =
    branding && (branding.companyName || branding.tagline || branding.logoUrl)
      ? `<div class="lab-brand-banner">
          ${branding.logoUrl ? `<img class="lab-brand-logo" src="${escapeHtml(branding.logoUrl)}" alt="${escapeHtml(branding.companyName || "Organization")} logo" />` : ""}
          <div class="lab-brand-text">
            ${branding.companyName ? `<strong>${escapeHtml(branding.companyName)}</strong>` : ""}
            ${branding.tagline ? `<span>${escapeHtml(branding.tagline)}</span>` : ""}
          </div>
        </div>`
      : "";

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
      --text: #1a1d27;
      --text-muted: #526077;
      --accent: ${accentColor};
      --accent-contrast: #ffffff;
      --code-bg: #f1f5f9;
      --success-bg: #e6f6f0;
      --success-border: #a7f3d0;
      --success-text: #0b6e4f;
      color-scheme: light;
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        --bg: #0f1117;
        --surface: #181c26;
        --surface-muted: #1f2533;
        --border: #2c3447;
        --text: #e6eaf2;
        --text-muted: #9ba6bc;
        --code-bg: #111520;
        --success-bg: #102a22;
        --success-border: #1f6f54;
        --success-text: #6ee7b7;
        color-scheme: dark;
      }
    }
    :root[data-theme="dark"] {
      --bg: #0f1117;
      --surface: #181c26;
      --surface-muted: #1f2533;
      --border: #2c3447;
      --text: #e6eaf2;
      --text-muted: #9ba6bc;
      --code-bg: #111520;
      --success-bg: #102a22;
      --success-border: #1f6f54;
      --success-text: #6ee7b7;
      color-scheme: dark;
    }
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
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
    .lab-article h1 { font-size: 28px; line-height: 1.25; margin: 0 0 16px; border-bottom: 2px solid var(--border); padding-bottom: 12px; }
    .lab-article h2 { font-size: 21px; line-height: 1.3; margin: 24px 0 12px; }
    .lab-article .lab-page > h2:first-child { margin-top: 0; }
    .lab-article h3 { font-size: 17px; margin: 20px 0 8px; }
    .lab-article p { margin: 10px 0; }
    .lab-article ul, .lab-article ol { padding-left: 24px; margin: 10px 0; }
    .lab-article li { margin: 5px 0; }
    .lab-article a { color: var(--accent); }
    .lab-article code {
      background: var(--code-bg);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.9em;
    }
    .lab-article pre {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px 16px;
      overflow-x: auto;
      font-size: 13px;
      line-height: 1.55;
    }
    .lab-article pre code { background: none; padding: 0; }
    .lab-article blockquote {
      margin: 14px 0;
      padding: 12px 16px;
      border: 1px solid var(--border);
      background: var(--surface-muted);
      border-radius: 8px;
    }
    .lab-article table {
      width: 100%;
      border-collapse: collapse;
      margin: 14px 0;
      font-size: 14px;
    }
    .lab-article th, .lab-article td {
      border: 1px solid var(--border);
      padding: 8px 12px;
      text-align: left;
    }
    .lab-article th {
      background: var(--surface-muted);
      font-weight: 600;
    }
    .lab-article img {
      max-width: 100%;
      height: auto;
      border-radius: 8px;
      border: 1px solid var(--border);
      margin: 10px 0;
    }
    .lab-article details {
      margin: 14px 0;
      padding: 10px 14px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface-muted);
    }
    .lab-article summary {
      cursor: pointer;
      font-weight: 600;
    }
    @media print {
      body { background: #ffffff !important; color: #111111 !important; }
      .lab-shell { max-width: 100%; padding: 0; }
      .lab-pagination-controls { display: none !important; }
      .lab-article { border: none; padding: 0; }
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

    <main id="lab-article" class="lab-article lab-paged-mode">
${pagesHtml}
    </main>

    <nav class="lab-pagination-controls lab-pagination-bottom" aria-label="Lab page footer navigation"${pages.length <= 1 ? ' style="display:none"' : ""}>
      <button type="button" id="lab-prev-btn" data-nav="prev" class="lab-page-btn" disabled>← Previous</button>
      <span id="lab-bottom-status" class="lab-pagination-status">Page 1 of ${pages.length}</span>
      <button type="button" id="lab-next-btn" data-nav="next" class="lab-page-btn lab-page-btn-primary"${pages.length <= 1 ? ' style="display:none"' : ""}>${nextInitialLabel}</button>
      <span id="lab-complete-badge" class="lab-complete-badge"${pages.length > 1 ? " hidden" : ""}>✓ Final page reached</span>
    </nav>
  </div>

  <script>
    (function () {
      const article = document.getElementById("lab-article");
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
