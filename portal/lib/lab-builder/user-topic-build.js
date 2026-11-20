/**
 * Turning a Microsoft Learn page into a topic a person adds to their own list.
 *
 * Everything read from Learn is untrusted: the address must be https on learn.microsoft.com, text is stripped of
 * markup and capped, and the page is read through the Learn MCP server, never fetched directly. A page is only
 * added when it sits under a product the builder covers, because the product decides which labs it can join.
 */

import { getProduct, getProducts, DEFAULT_PRODUCT } from "./products.js";
import { MAX_SUMMARY, MAX_TITLE, cleanText, contentHash, normalizeLearnUrl, tidySummary, topicId } from "./topic-sanitize.js";
import { UNCATEGORIZED } from "./topic-snapshot.js";
import { availabilityOf, conceptFor, harnessesFor, levelForUrl, parsePage } from "./topic-discovery.js";

/** The product whose Learn roots contain the address (the longest match wins), or null. */
export function productForUrl(url) {
  const normalized = normalizeLearnUrl(url);
  if (!normalized) return null;
  let best = null;
  for (const product of getProducts()) {
    for (const root of product.learnRoots || []) {
      const base = normalizeLearnUrl(root);
      if (!base) continue;
      if ((normalized === base || normalized.startsWith(`${base}/`)) && (!best || base.length > best.length)) best = { id: product.id, length: base.length };
    }
  }
  return best?.id ?? null;
}

/**
 * The topic for one page, or null when the page has no title to build a card from.
 * @param {{url: string, markdown: string, product: string, now?: number, fallbackTitle?: string}} input
 */
export function buildUserTopic({ url, markdown, product, now = Date.now(), fallbackTitle = "" }) {
  const normalized = normalizeLearnUrl(url);
  const productDef = getProduct(product);
  if (!normalized || !productDef) return null;
  const parsed = parsePage(markdown);
  const title = parsed.title || cleanText(fallbackTitle, MAX_TITLE);
  if (!title) return null;
  const summary = tidySummary(cleanText(parsed.summary || "", MAX_SUMMARY)) || `${title}: see the linked Microsoft Learn article.`;
  const today = new Date(now).toISOString().slice(0, 10);
  const conceptId = product === DEFAULT_PRODUCT ? conceptFor({ url: normalized, title }) : UNCATEGORIZED;
  return {
    id: topicId(normalized),
    title,
    ...(product === DEFAULT_PRODUCT ? {} : { product }),
    summary,
    urls: [normalized],
    harnesses: productDef.hasHarnesses ? harnessesFor({ url: normalized, title: parsed.rawTitle || title }) : [],
    conceptId,
    availability: availabilityOf(parsed.rawTitle, parsed.head),
    status: "new",
    featureIds: [],
    level: levelForUrl(normalized, conceptId),
    firstSeen: today,
    lastSeen: today,
    changedAt: null,
    contentHash: contentHash(String(markdown || `${title}\n${summary}`)),
    userAdded: true,
    addedAt: new Date(now).toISOString(),
  };
}
