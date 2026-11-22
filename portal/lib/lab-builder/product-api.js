/**
 * Routes for adding a Microsoft product from Microsoft Learn: a picklist of documentation hubs, a search through the
 * Learn MCP server, and add and remove. A product added this way has no curated catalog; its topics come from Learn
 * discovery (refresh it like any product) and from topics added by link, so every lab for it says its content is not
 * reviewed. See user-products.js for what is saved and docs/lab-builder.md for the rules.
 */

import fs from "node:fs";
import path from "node:path";

import { createKeyedMutex } from "../concurrency/keyed-mutex.js";
import { visitorKey } from "../concurrency/visitor.js";
import { connect, fetchDocPage, searchDocs } from "./learn-mcp.js";
import { getBuiltInProducts, getProducts, setCustomProducts } from "./products.js";
import { cleanText, MAX_SUMMARY, MAX_TITLE, normalizeLearnUrl } from "./topic-sanitize.js";
import { parsePage } from "./topic-discovery.js";
import { productIdFor, buildUserProduct, readUserProducts, updateUserProducts, userProductsPath, MAX_USER_PRODUCTS } from "./user-products.js";
import { productPaths } from "./topic-store.js";

const PICKLIST_PATH = new URL("./product-picklist.json", import.meta.url);

// Requests that change the saved list take turns per file; the file lock inside updateUserProducts covers other processes.
const writers = createKeyedMutex();

/** Change the saved list for `file`: `change(current)` returns `{ products }` to save, or a refusal to hand back unchanged. */
function changeSaved(file, change) {
  return writers.run(file, () => {
    const outcome = updateUserProducts(file, change);
    if (outcome.products) setCustomProducts(readUserProducts(file));
    return outcome;
  });
}

/** The reviewed picklist, with every address re-normalized so a bad entry can never reach the wizard. */
export function readPicklist() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PICKLIST_PATH, "utf8"));
    return (parsed.products || [])
      .map((entry) => ({ name: cleanText(String(entry?.name || ""), 80), root: normalizeLearnUrl(String(entry?.root || "")) }))
      .filter((entry) => entry.name && entry.root);
  } catch {
    return [];
  }
}

/** The product whose Learn roots overlap this address (it contains, equals, or sits inside one), or null. */
function overlappingProduct(root, products) {
  for (const product of products) {
    for (const raw of product.learnRoots || []) {
      const other = normalizeLearnUrl(raw);
      if (other && (root === other || root.startsWith(`${other}/`) || other.startsWith(`${root}/`))) return product;
    }
  }
  return null;
}

/** The hub addresses a page could be the start of: each path prefix of its address, shortest first, at most four. */
export function candidateRoots(url) {
  const normalized = normalizeLearnUrl(url);
  if (!normalized) return [];
  const segments = new URL(normalized).pathname.split("/").filter(Boolean);
  const roots = [];
  for (let depth = 1; depth <= Math.min(4, segments.length); depth += 1) roots.push(`https://learn.microsoft.com/${segments.slice(0, depth).join("/")}`);
  return roots;
}

export function registerProductRoutes(app, { getService, createRateLimiter, positiveIntFromEnv, learn = null }) {
  const rate = createRateLimiter({
    windowMs: positiveIntFromEnv(process.env.LAB_BUILDER_USER_PRODUCTS_RATE_WINDOW_MS, 3600000),
    max: positiveIntFromEnv(process.env.LAB_BUILDER_USER_PRODUCTS_RATE_MAX, 30),
  });
  const callerOf = (req) => visitorKey(req);
  const limited = (req, res) => {
    const result = rate(callerOf(req));
    if (result.allowed) return false;
    res.setHeader("Retry-After", String(result.retryAfterSec));
    res.status(429).json({ error: `Too many product searches and additions. Try again in ${result.retryAfterSec}s.` });
    return true;
  };
  const session = async (timeoutMs) => {
    const next = await connect({ timeoutMs });
    if (!next.ok) throw new Error("Microsoft Learn could not be reached.");
    return next;
  };
  const client = learn || {
    search: async (query) => searchDocs(await session(15000), query, { limit: 8 }),
    page: async (url) => fetchDocPage(await session(20000), url),
  };
  const filePath = () => getService().config?.userProductsPath || userProductsPath();
  const saved = () => readUserProducts(filePath());
  const describe = (product) => ({ id: product.id, name: product.name, shortName: product.shortName, summary: product.summary, learnHubUrl: product.learnHubUrl, custom: Boolean(product.custom) });

  /** GET /api/lab-builder/products/picklist: reviewed documentation hubs to add, and the products already added. */
  app.get("/api/lab-builder/products/picklist", (_req, res) => {
    const added = saved();
    const all = getProducts();
    const items = readPicklist().map((entry) => {
      const mine = added.find((product) => product.learnHubUrl === entry.root);
      const overlap = mine ? null : overlappingProduct(entry.root, getBuiltInProducts());
      return { ...entry, addedId: mine?.id ?? null, coveredBy: overlap ? overlap.name : null };
    });
    res.json({ products: items, added: added.map(describe), limit: MAX_USER_PRODUCTS, known: all.length });
  });

  /** POST /api/lab-builder/products/mine/search: search Learn for a product's documentation. */
  app.post("/api/lab-builder/products/mine/search", async (req, res) => {
    if (limited(req, res)) return;
    const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
    if (query.length < 3 || query.length > 200) return res.status(400).json({ error: "Enter 3 to 200 characters to search Microsoft Learn." });
    try {
      const found = await client.search(query);
      const results = [];
      const seen = new Set();
      for (const item of found || []) {
        const url = normalizeLearnUrl(String(item?.url || ""));
        if (!url || seen.has(url)) continue;
        seen.add(url);
        const roots = candidateRoots(url).map((root) => ({ root, coveredBy: overlappingProduct(root, getProducts())?.name || null }));
        results.push({ title: cleanText(String(item?.title || ""), MAX_TITLE) || url, url, roots });
      }
      res.json({ query, results });
    } catch (err) {
      res.status(502).json({ error: `Microsoft Learn could not be searched: ${String(err.message || err).slice(0, 160)}` });
    }
  });

  /** POST /api/lab-builder/products/mine: add a product from a documentation hub address on Microsoft Learn. */
  app.post("/api/lab-builder/products/mine", async (req, res) => {
    if (limited(req, res)) return;
    const root = normalizeLearnUrl(typeof req.body?.root === "string" ? req.body.root.trim() : "");
    if (!root || new URL(root).pathname.split("/").filter(Boolean).length < 1) {
      return res.status(400).json({ error: "Use an https address on learn.microsoft.com that starts at a product's documentation, such as https://learn.microsoft.com/power-automate." });
    }
    const overlap = overlappingProduct(root, getProducts());
    if (overlap) return res.status(409).json({ error: `That documentation is already covered by "${overlap.name}".`, product: describe(overlap) });
    // A cheap early answer before the network call; the same checks run again under the lock, which is the one that counts.
    if (saved().length >= MAX_USER_PRODUCTS) return res.status(400).json({ error: `You can add up to ${MAX_USER_PRODUCTS} products of your own. Remove one first.` });
    let page;
    try {
      page = await client.page(root);
    } catch (err) {
      return res.status(502).json({ error: `Microsoft Learn could not be reached: ${String(err.message || err).slice(0, 160)}` });
    }
    if (!page || page.error || !String(page.markdown || "").trim()) return res.status(404).json({ error: "Microsoft Learn has no readable page at that address." });
    const parsed = parsePage(page.markdown);
    const given = typeof req.body?.name === "string" ? cleanText(req.body.name, 80) : "";
    const name = given || cleanText(String(parsed.title || "").replace(/\s+documentation$/i, ""), 80);
    const product = buildUserProduct({ name, root, summary: `${name} documentation on Microsoft Learn.`, now: Date.now() });
    if (!product) return res.status(422).json({ error: "That page has no title to name the product with. Type a name for it." });
    // The Learn fetch is done. Re-read the file and check the cap and the duplicates inside the lock, so two people adding at
    // once cannot both pass the checks or overwrite each other's product.
    const file = filePath();
    let outcome;
    try {
      outcome = await changeSaved(file, (current) => {
        if (current.length >= MAX_USER_PRODUCTS) return { status: 400, error: `You can add up to ${MAX_USER_PRODUCTS} products of your own. Remove one first.` };
        const known = [...getBuiltInProducts(), ...current];
        const covering = overlappingProduct(root, known);
        if (covering) return { status: 409, error: `That documentation is already covered by "${covering.name}".`, product: describe(covering) };
        if (known.some((existing) => existing.id === product.id || existing.name.toLowerCase() === product.name.toLowerCase())) {
          return { status: 409, error: `A product named "${product.name}" is already in the list. Use a different name.` };
        }
        return { products: [...current, product] };
      });
    } catch (err) {
      return res.status(err?.status === 503 ? 503 : 400).json({ error: err.message });
    }
    if (!outcome.products) return res.status(outcome.status).json({ error: outcome.error, ...(outcome.product ? { product: outcome.product } : {}) });
    res.status(201).json({ added: true, product: describe(product) });
  });

  /** DELETE /api/lab-builder/products/mine/:id: remove a product you added. Labs already built from it are not changed. */
  app.delete("/api/lab-builder/products/mine/:id", async (req, res) => {
    const id = String(req.params.id || "");
    if (!/^custom-[a-z0-9-]{1,40}$/.test(id) || productIdFor(id.replace(/^custom-/, "")) !== id) return res.status(400).json({ error: "That is not a product id." });
    let outcome;
    try {
      outcome = await changeSaved(filePath(), (current) =>
        current.some((product) => product.id === id) ? { products: current.filter((product) => product.id !== id) } : { status: 404, error: "That product is not in your list." },
      );
    } catch (err) {
      return res.status(err?.status === 503 ? 503 : 400).json({ error: err.message });
    }
    if (!outcome.products) return res.status(outcome.status).json({ error: outcome.error });
    // Its cached topic list goes with it.
    try {
      const { cachePath } = productPaths(getService().config, id);
      fs.rmSync(cachePath, { force: true });
    } catch {
      /* a missing cache is fine */
    }
    res.json({ removed: true, id });
  });
}
