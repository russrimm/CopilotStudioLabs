/**
 * Third-party (vendor) documentation — the builder's non-MCP grounding path.
 *
 * The Microsoft Learn MCP server only returns Microsoft content. Some Copilot
 * Studio features are defined by someone else's specification — the Model
 * Context Protocol, the A2A protocol, OpenAPI — and a lab about them is only
 * well grounded if it cites that specification too (issue #39). This module
 * reads those pages directly over HTTPS.
 *
 * Everything fetched here is untrusted input from the public internet, so the
 * rules are strict and none of them is optional:
 *
 *   - **Allowlist only.** A URL is fetched only when its host is listed in the
 *     catalog's `vendorHosts`. Matching is exact: no wildcards, no subdomains.
 *   - **HTTPS only**, default port, no credentials in the URL.
 *   - **Redirects are followed by hand** (`redirect: "manual"`), a bounded
 *     number of times, and every hop is checked against the same rules. A page
 *     on an allowlisted host that redirects anywhere else is refused, not read.
 *   - **Bounded.** One timeout covers the whole redirect chain and the body, and
 *     the body is read as a stream and abandoned past a size cap.
 *   - **Text only.** Only `text/html` and `text/plain` responses are accepted.
 *     HTML is reduced to plain text with `sanitize-html` configured to allow no
 *     tags at all, and to discard the *contents* of script, style, and similar
 *     elements rather than keep their text. Angle brackets are then removed, so
 *     nothing that could be read as markup reaches the lab.
 *   - **Never executed, never rendered as HTML.** A quoted excerpt goes through
 *     the same `condense()` + `scrubForbidden()` path as Microsoft Learn
 *     excerpts, and is only ever written into Markdown as quoted prose.
 *
 * `fetchImpl` is injectable so tests can exercise every one of those rules
 * without a network.
 */

import sanitizeHtml from "sanitize-html";

import { getCatalog } from "./catalog.js";
import { condense, scrubForbidden } from "./composer.js";

/** Whole-fetch budget, redirects and body included. A human is waiting. */
export const DEFAULT_TIMEOUT_MS = Number(process.env.LAB_BUILDER_VENDOR_TIMEOUT_MS || 10000);

/** Specification pages run to several hundred KB of HTML; anything past this is not a doc page. */
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export const MAX_REDIRECTS = 5;

export const DEFAULT_CONCURRENCY = 4;

const USER_AGENT = "copilot-studio-lab-builder/1.0 (+vendor-docs)";
const ACCEPTED_TYPES = new Set(["text/html", "text/plain"]);
const CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Whether vendor pages are read at all.
 *
 * On by default. The opt-out exists for the same reasons as
 * `LAB_BUILDER_LINK_CHECK=off`: hermetic tests and air-gapped builds. Setting it
 * is an explicit choice, so it is a warning and never a blocker, and the lab
 * says its vendor links were not read.
 */
export function vendorDocsEnabled(env = process.env) {
  return String(env.LAB_BUILDER_VENDOR_DOCS || "").toLowerCase() !== "off";
}

/** The catalog's vendor allowlist, lower-cased. The only hosts this module will contact. */
export function allowedVendorHosts() {
  return new Set((getCatalog().vendorHosts || []).map((entry) => String(entry?.host || "").toLowerCase()).filter(Boolean));
}

/**
 * Why a URL may not be fetched, or null when it may.
 *
 * The same check guards the first request and every redirect hop.
 */
export function vendorUrlProblem(value, allowedHosts) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return "it is not a valid URL";
  }
  if (url.protocol !== "https:") return `it uses ${url.protocol.replace(/:$/, "")}, and only https is fetched`;
  if (url.username || url.password) return "it carries credentials";
  if (url.port && url.port !== "443") return `it uses port ${url.port}`;
  const host = url.hostname.toLowerCase();
  if (!allowedHosts?.has(host)) return `${host} is not on the vendor allowlist`;
  return null;
}

// Block-level boundaries become line breaks before tags are stripped, so a page
// keeps its paragraphs even when its source hard-wraps them. This pre-pass only
// rewrites whitespace; sanitize-html below is what removes the markup.
const BLOCK_BOUNDARY =
  /<\/?(?:p|div|section|article|main|h[1-6]|li|ul|ol|dl|dt|dd|tr|td|th|table|pre|blockquote|br|hr|figcaption)\b[^>]*>/gi;

// Elements whose *text* is discarded, not just their tags: executable or
// styling content, form controls, embedded documents, code samples, and page
// chrome that is never the documentation itself.
const DISCARDED_CONTENT = [
  "script",
  "style",
  "noscript",
  "template",
  "pre",
  "textarea",
  "option",
  "select",
  "button",
  "svg",
  "math",
  "iframe",
  "object",
  "embed",
  "canvas",
  "head",
  "title",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
];

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text) {
  return String(text || "").replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]+);/gi, (entity, body) => {
    if (body[0] === "#") {
      const point = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return point >= 32 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : " ";
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? " ";
  });
}

/** One line of fetched text, reduced to inert prose. */
function inertLine(line) {
  return (
    decodeEntities(line)
      // Nothing shaped like markup survives, even text that only became `<` after decoding.
      .replace(/[<>]/g, " ")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** The part of a page that holds the documentation, when the page marks it. */
function contentRegion(html) {
  for (const tag of ["main", "article"]) {
    const match = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*)</${tag}>`, "i"));
    if (match && match[1].length > 200) return match[1];
  }
  return html;
}

/**
 * Reduce an HTML page to plain text, one block per line.
 *
 * `allowedTags: []` means no element survives; `nonTextTags` means the text
 * inside script, style, and page chrome is dropped too rather than kept.
 */
export function htmlToText(html) {
  const region = contentRegion(String(html || "")).replace(/\s+/g, " ");
  const stripped = sanitizeHtml(region.replace(BLOCK_BOUNDARY, (tag) => `${tag}\n`), {
    allowedTags: [],
    allowedAttributes: {},
    nonTextTags: DISCARDED_CONTENT,
  });
  return stripped
    .split(/\n/)
    .map(inertLine)
    .filter(Boolean)
    .join("\n");
}

/** Reduce a text/plain page to the same one-paragraph-per-line shape. */
export function plainTextToText(text) {
  return String(text || "")
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => inertLine(paragraph.replace(/\r?\n/g, " ")))
    .filter(Boolean)
    .join("\n");
}

// Page furniture that clears the length test but is not documentation.
const BOILERPLATE =
  /\b(?:cookies?|enable javascript|javascript is (?:required|disabled)|sign (?:in|up) to|subscribe|newsletter|all rights reserved|privacy (?:policy|statement)|terms of (?:use|service))\b/i;

/**
 * The first paragraph that reads like documentation prose, quoted the same way
 * as a Microsoft Learn excerpt. Null when the page has none — a client-rendered
 * page, say — which is not a failure: the page was read, it just has nothing
 * quotable in its served HTML.
 */
export function pickExcerpt(text) {
  for (const paragraph of String(text || "").split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (paragraph.length < 120 || words.length < 15 || !/[.!?]/.test(paragraph)) continue;
    const letters = (paragraph.match(/[\p{L}\s]/gu) || []).length;
    if (letters / paragraph.length < 0.75) continue;
    if (BOILERPLATE.test(paragraph)) continue;
    const quote = scrubForbidden(condense(paragraph));
    if (quote) return quote;
  }
  return null;
}

function mediaType(header) {
  return String(header || "").split(";")[0].trim().toLowerCase();
}

async function discardBody(res) {
  try {
    await res.body?.cancel();
  } catch {
    /* the body is being thrown away either way */
  }
}

class PolicyRefusal extends Error {}

async function readCapped(res, maxBytes) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new PolicyRefusal(`the response is larger than the ${maxBytes}-byte limit`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(body);
}

function abortError(reason = "Operation cancelled") {
  return new DOMException(String(reason), "AbortError");
}

/**
 * Build a single-page reader.
 *
 * Only successful reads are cached (per reader, for 15 minutes). A failure is
 * never cached, so choosing `retry` on the blocker really does try again.
 *
 * Always resolves, except on caller cancellation. The returned record says what
 * happened; `errorKind` separates what a retry might fix (`network`, `timeout`,
 * `http`) from what it cannot (`policy`, meaning this module refused the page).
 */
export function createVendorFetcher({
  allowedHosts,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  maxRedirects = MAX_REDIRECTS,
} = {}) {
  const hosts = new Set([...(allowedHosts || allowedVendorHosts())].map((host) => String(host).toLowerCase()));
  const cache = new Map();

  return async function fetchVendorDoc(url, { signal } = {}) {
    if (signal?.aborted) throw abortError(signal.reason);

    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.record;

    const redirects = [];
    const failure = (errorKind, error, extra = {}) => ({
      url,
      status: "failed",
      finalUrl: redirects.at(-1) || url,
      redirects,
      httpStatus: null,
      contentType: null,
      fetchedAt: null,
      textLength: 0,
      excerpt: null,
      errorKind,
      error,
      ...extra,
    });

    const refused = vendorUrlProblem(url, hosts);
    if (refused) return failure("policy", `Refused to read ${url}: ${refused}.`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
    const cancel = () => controller.abort(signal.reason || "Operation cancelled");
    signal?.addEventListener("abort", cancel, { once: true });

    try {
      let current = url;
      for (let hop = 0; ; hop += 1) {
        const res = await fetchImpl(current, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: { "user-agent": USER_AGENT, accept: "text/html, text/plain;q=0.9" },
        });

        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location");
          await discardBody(res);
          if (!location) return failure("http", `HTTP ${res.status} from ${current} named no redirect target.`, { httpStatus: res.status });
          if (hop >= maxRedirects) return failure("policy", `Refused to follow more than ${maxRedirects} redirects from ${url}.`);

          let next;
          try {
            next = new URL(location, current).href;
          } catch {
            return failure("policy", `Refused a malformed redirect from ${current}.`);
          }
          const problem = vendorUrlProblem(next, hosts);
          if (problem) return failure("policy", `Refused a redirect from ${current} to ${next}: ${problem}.`);
          redirects.push(next);
          current = next;
          continue;
        }

        if (!res.ok) {
          await discardBody(res);
          return failure("http", `${current} returned HTTP ${res.status}.`, { httpStatus: res.status });
        }

        const type = mediaType(res.headers.get("content-type"));
        if (!ACCEPTED_TYPES.has(type)) {
          await discardBody(res);
          return failure("policy", `Refused ${current}: its content type is ${type || "missing"}, not text/html or text/plain.`, {
            httpStatus: res.status,
          });
        }

        const declared = Number(res.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > maxBytes) {
          await discardBody(res);
          return failure("policy", `Refused ${current}: the response is larger than the ${maxBytes}-byte limit.`, {
            httpStatus: res.status,
          });
        }

        const body = await readCapped(res, maxBytes);
        const text = type === "text/html" ? htmlToText(body) : plainTextToText(body);
        const record = {
          url,
          status: "read",
          finalUrl: current,
          redirects,
          httpStatus: res.status,
          contentType: type,
          fetchedAt: new Date().toISOString(),
          textLength: text.length,
          excerpt: pickExcerpt(text),
          errorKind: null,
          error: null,
        };
        cache.set(url, { at: Date.now(), record });
        return record;
      }
    } catch (err) {
      if (signal?.aborted) throw abortError(signal.reason);
      if (err instanceof PolicyRefusal) return failure("policy", `Refused ${url}: ${err.message}.`);
      if (controller.signal.aborted) return failure("timeout", `${url} did not respond within ${timeoutMs}ms.`);
      return failure("network", `${url} could not be reached: ${err?.cause?.code || err?.message || err}.`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  };
}

let defaultFetcher = null;

/** The process-wide reader, bound to the catalog allowlist, so its cache survives a resumed build. */
export function defaultVendorFetcher() {
  defaultFetcher ??= createVendorFetcher();
  return defaultFetcher;
}

async function mapLimit(items, limit, fn, signal) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      if (signal?.aborted) throw abortError(signal.reason);
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function describe(source) {
  return {
    vendor: source.vendor,
    title: source.title,
    url: source.url,
    stability: source.stability,
  };
}

/**
 * Vendor source records for a plan without reading anything — used when
 * grounding or vendor reading was switched off on purpose.
 *
 * @returns {Map<string, Array>} featureId -> records
 */
export function skippedVendorSources(features, reason) {
  const out = new Map();
  for (const feature of features || []) {
    const sources = feature.thirdPartySources || [];
    if (!sources.length) continue;
    out.set(
      feature.id,
      sources.map((source) => ({
        ...describe(source),
        fetch: { status: "skipped", reason, fetchedAt: null, finalUrl: null, httpStatus: null, error: null, errorKind: null },
        excerpt: null,
      })),
    );
  }
  return out;
}

/**
 * Read every vendor source a plan cites, once per URL.
 *
 * @returns {Promise<Map<string, Array>>} featureId -> records, in catalog order
 */
export async function readVendorSources(features, { fetchVendorDoc, concurrency = DEFAULT_CONCURRENCY, signal, onProgress } = {}) {
  const read = fetchVendorDoc || defaultVendorFetcher();
  const urls = [...new Set((features || []).flatMap((f) => (f.thirdPartySources || []).map((s) => s.url)))];

  const pages = new Map();
  const fetched = await mapLimit(
    urls,
    concurrency,
    async (url) => {
      onProgress?.({ stage: "vendor", message: `Reading vendor documentation: ${url}` });
      return [url, await read(url, { signal })];
    },
    signal,
  );
  for (const [url, page] of fetched) pages.set(url, page);

  const out = new Map();
  for (const feature of features || []) {
    const sources = feature.thirdPartySources || [];
    if (!sources.length) continue;
    out.set(
      feature.id,
      sources.map((source) => {
        const page = pages.get(source.url);
        return {
          ...describe(source),
          fetch: {
            status: page.status,
            reason: null,
            fetchedAt: page.fetchedAt,
            finalUrl: page.finalUrl,
            httpStatus: page.httpStatus,
            contentType: page.contentType,
            textLength: page.textLength,
            error: page.error,
            errorKind: page.errorKind,
          },
          excerpt: page.excerpt,
        };
      }),
    );
  }
  return out;
}
