/**
 * Trusted HTML fragments embedded in generated Markdown.
 *
 * Markdown ends an HTML block at the first blank (or whitespace-only) line, and
 * any continuation line indented four or more spaces then becomes an indented
 * code block, so a pretty-printed template leaks its own markup to learners as
 * a visible code block. Every generator that embeds HTML in Markdown (today the
 * brand banner) must therefore:
 *
 *   1. build the fragment with `compactHtml()` (left-aligned, no blank lines), and
 *   2. wrap it with `embedHtmlBlock()` so renderers can recognize it.
 *
 * The markers are HTML comments, so they stay invisible on GitHub and in editor
 * previews. They only control whitespace and are never a trust signal: every
 * renderer still passes the output through its sanitizer, and the DOCX, PDF, and
 * PPTX builders drop the fragments with `stripEmbeddedHtml()`.
 *
 * Dependency-free so `tools/lab-builder/build.mjs` keeps working in bare Node.
 */

export const HTML_BLOCK_BEGIN = "<!-- lab-html:begin -->";
export const HTML_BLOCK_END = "<!-- lab-html:end -->";

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
// Banners written before the markers existed: an indented template with a blank line inside.
const LEGACY_BANNER_START_RE = /^<div class="lab-branding-banner"/;
const LEGACY_BANNER_MAX_LINES = 60;

/** Trim every line and drop blank ones so the fragment is one Markdown-safe HTML block. */
export function compactHtml(html) {
  return String(html ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

/** A compact fragment wrapped in the begin and end markers, or "" when there is nothing to embed. */
export function embedHtmlBlock(html) {
  const body = compactHtml(html);
  return body ? `${HTML_BLOCK_BEGIN}\n${body}\n${HTML_BLOCK_END}` : "";
}

function countMatches(text, re) {
  return (text.match(re) || []).length;
}

/** Index of the line that closes the legacy banner's outer div, or -1 when it does not close. */
function findLegacyBannerEnd(lines, start) {
  let depth = 0;
  const limit = Math.min(lines.length, start + LEGACY_BANNER_MAX_LINES);
  for (let i = start; i < limit; i += 1) {
    depth += countMatches(lines[i], /<div\b/gi) - countMatches(lines[i], /<\/div>/gi);
    if (depth <= 0) return i;
  }
  return -1;
}

/**
 * Make every embedded HTML fragment safe for a Markdown parser, or remove it.
 *
 * Marker-delimited fragments (and the legacy banner shape) are collapsed into a
 * compact block surrounded by blank lines, and the markers are dropped. With
 * `strip: true` the fragments are removed instead, for outputs that cannot show
 * HTML. Fenced code is left untouched so documentation can quote the markers.
 */
export function normalizeEmbeddedHtml(markdown, { strip = false } = {}) {
  const text = String(markdown ?? "");
  if (!text.includes(HTML_BLOCK_BEGIN) && !text.includes("lab-branding-banner")) return text;

  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let fence = null;
  const emit = (bodyLines) => {
    if (strip) return;
    const body = compactHtml(bodyLines.join("\n"));
    if (body) out.push("", body, "");
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fenceMatch = line.match(FENCE_RE);
    if (fence) {
      out.push(line);
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      out.push(line);
      continue;
    }

    if (line.trim() === HTML_BLOCK_BEGIN) {
      const end = lines.findIndex((candidate, index) => index > i && candidate.trim() === HTML_BLOCK_END);
      if (end < 0) continue;
      emit(lines.slice(i + 1, end));
      i = end;
      continue;
    }

    if (LEGACY_BANNER_START_RE.test(line)) {
      const end = findLegacyBannerEnd(lines, i);
      if (end >= 0) {
        emit(lines.slice(i, end + 1));
        i = end;
        continue;
      }
    }

    out.push(line);
  }
  return out.join("\n");
}

/** Remove embedded HTML fragments for outputs that cannot render HTML (DOCX, PDF, PPTX, plain text). */
export function stripEmbeddedHtml(markdown) {
  return normalizeEmbeddedHtml(markdown, { strip: true });
}
