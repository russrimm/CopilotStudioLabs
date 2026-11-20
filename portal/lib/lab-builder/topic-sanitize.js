/**
 * Trust boundary for the Microsoft Learn topic list.
 *
 * Everything the discovery service reads from Microsoft Learn is public
 * internet text. It is data to describe, never instructions to follow, so it
 * passes through here before it is stored, shown, or used to build a lab:
 * URLs must be https on learn.microsoft.com, text is stripped of markup and
 * control characters, and every field has a length cap.
 */

import { createHash } from "node:crypto";

export const LEARN_HOST = "learn.microsoft.com";
export const DOCS_PREFIX = "/microsoft-copilot-studio/";

export const MAX_TITLE = 160;
export const MAX_SUMMARY = 320;

const LOCALE = /^\/[a-z]{2}-[a-z]{2}(?=\/)/i;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
const HAS_CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;

/**
 * Learn pages that still use the earlier name for the Microsoft Copilot
 * harness are accepted when matching, but the old name is never output.
 */
export function normalizeTerminology(text) {
  return String(text ?? "")
    .replace(/GitHub Copilot harness/gi, "Microsoft Copilot harness")
    .replace(/github-copilot-harness/gi, "microsoft-copilot-harness");
}

/** Slug form of the old harness name, used only to match a renamed Learn page to a catalog page. */
export function matchKey(url) {
  return String(url ?? "").toLowerCase().replace(/github-copilot/g, "microsoft-copilot");
}

/**
 * Reduce one piece of fetched text to a short, single-line, markup-free string.
 * Markdown links and images keep their visible text, HTML tags are removed, and
 * the result is truncated rather than rejected so a long paragraph cannot sink a topic.
 */
export function cleanText(value, max = MAX_SUMMARY) {
  if (typeof value !== "string") return "";
  let text = value
    .replace(CONTROL, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/[`*_~>#|]+/g, " ")
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  text = normalizeTerminology(text);
  return shortenText(text, max);
}

/**
 * Shorten `text` to at most `max` characters without cutting a sentence or a word in half: at the last
 * sentence end that fits when there is one (no mark added), otherwise at a word end followed by an ellipsis.
 */
export function shortenText(text, max) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  const head = value.slice(0, max);
  const floor = Math.min(60, Math.floor(max / 2));
  const ends = [...head.matchAll(/[.!?](?=\s|$)/g)].map((m) => m.index + 1).filter((index) => index >= floor);
  if (ends.length) return head.slice(0, ends[ends.length - 1]).trim();
  const space = head.lastIndexOf(" ");
  const body = space > max * 0.5 ? head.slice(0, space) : head.slice(0, max - 1);
  return `${body.replace(/[\s,;:(-]+$/, "")}\u2026`;
}

/**
 * Repair a summary an earlier build cut off in the middle of a word (it ends with an ellipsis): keep the
 * complete sentences before the cut, or the whole words before it when there is no sentence end.
 */
export function tidySummary(text) {
  const value = String(text ?? "").trim();
  if (!/(?:\u2026|\.\.\.)$/.test(value)) return value;
  const body = value.replace(/\s*(?:\u2026|\.\.\.)$/, "").trim();
  const ends = [...body.matchAll(/[.!?](?=\s|$)/g)].map((m) => m.index + 1).filter((index) => index >= 40);
  if (ends.length) return body.slice(0, ends[ends.length - 1]).trim();
  const space = body.lastIndexOf(" ");
  return space > 20 ? `${body.slice(0, space).replace(/[\s,;:(-]+$/, "")}\u2026` : "";
}

/**
 * Canonical form of a Microsoft Learn documentation URL, or null when the URL
 * is not one the builder may follow: https only, learn.microsoft.com only, no
 * credentials or port, no locale, query, or fragment, no trailing slash.
 */
export function normalizeLearnUrl(raw, base) {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 600 || HAS_CONTROL.test(raw)) return null;
  let url;
  try {
    url = new URL(raw.trim(), base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== LEARN_HOST) return null;
  if (url.username || url.password || url.port) return null;
  let path = url.pathname.replace(LOCALE, "").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  if (!path || path.includes("..")) return null;
  path = path.toLowerCase();
  return `https://${LEARN_HOST}${path}`;
}

/** True for a normalized URL inside the Copilot Studio documentation set. */
export function isCopilotStudioDoc(url) {
  return typeof url === "string" && url.startsWith(`https://${LEARN_HOST}${DOCS_PREFIX}`);
}

/** True for a normalized URL that is one of a product's Microsoft Learn roots or sits beneath one. */
export function isProductDoc(url, roots) {
  if (typeof url !== "string") return false;
  return (roots || []).some((root) => {
    const base = String(root).replace(/\/+$/, "");
    return url === base || url.startsWith(`${base}/`);
  });
}

/** Stable topic id derived from the Learn URL: `learn-` plus the path under the docs set. */
export function topicId(url) {
  const path = new URL(url).pathname;
  const tail = path.startsWith(DOCS_PREFIX) ? path.slice(DOCS_PREFIX.length) : path.slice(1);
  const slug = matchKey(tail)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const id = `learn-${slug}`;
  if (id.length <= 80) return id;
  return `${id.slice(0, 72).replace(/-+$/, "")}-${shortHash(url).slice(0, 6)}`;
}

export function shortHash(text) {
  return createHash("sha256").update(String(text)).digest("hex").slice(0, 16);
}

/** Hash of page content that ignores whitespace and image cache-busting parameters. */
export function contentHash(markdown) {
  const normalized = String(markdown ?? "")
    .replace(/\?branch=[\w.-]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return shortHash(normalized);
}
