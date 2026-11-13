/**
 * Reads the feature catalog from disk.
 *
 * `features.json` holds the Copilot Studio features and the catalog-wide
 * lists (harnesses, vendor hosts). Every other product keeps its own file in
 * the `catalog/` directory next to it, `catalog/<product-id>.json`:
 *
 *   { "product": "sharepoint-ai", "categories": [...], "features": [...] }
 *
 * Giving each product its own file means a person adding SharePoint topics
 * and a person adding Foundry topics never edit the same file. Everything
 * that reads the catalog (the portal, the CLI, the accuracy checks, and the
 * feature tour) goes through this module, so they all see the merged result.
 * A catalog with no `catalog/` directory beside it (a test fixture, for
 * example) is read as-is.
 */

import fs from "node:fs";
import path from "node:path";

export const PRODUCT_CATALOG_DIR = "catalog";

/** Parse the product catalog files that sit beside `catalogPath`, sorted by file name. */
export function readProductCatalogs(catalogPath) {
  const dir = path.join(path.dirname(catalogPath), PRODUCT_CATALOG_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      const expected = name.replace(/\.json$/, "");
      if (parsed.product !== expected) {
        throw new Error(`${PRODUCT_CATALOG_DIR}/${name}: "product" must be "${expected}" to match the file name.`);
      }
      return parsed;
    });
}

/**
 * The whole catalog: `features.json` plus every product catalog file. Each
 * product's features are stamped with their product, so a feature cannot
 * claim a product other than the file it lives in.
 */
export function readCatalogFile(catalogPath) {
  const raw = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const extras = readProductCatalogs(catalogPath);
  if (!extras.length) return raw;
  const categories = [...(raw.categories || [])];
  const features = [...(raw.features || [])];
  for (const extra of extras) {
    for (const category of extra.categories || []) categories.push({ ...category, products: [extra.product] });
    for (const feature of extra.features || []) features.push({ ...feature, product: extra.product });
  }
  return { ...raw, categories, features };
}
