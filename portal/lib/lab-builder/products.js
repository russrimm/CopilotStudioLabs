/**
 * Products: the solution areas the Microsoft AI Training Generator builds labs for.
 *
 * A product sits above the harness. Copilot Studio is the only product with
 * harnesses today, so a harness is optional everywhere: it is chosen, tagged,
 * compared, and validated only for a product that has them. A feature with no
 * `product` field is a Copilot Studio feature, which keeps older catalogs and
 * saved selections working unchanged.
 *
 * `products.json` holds the metadata. This module loads and validates it.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRODUCTS_PATH = path.join(__dirname, "products.json");

export const DEFAULT_PRODUCT = "copilot-studio";
export const PRODUCT_LEVELS = [100, 200, 300];
export const GENERATOR_NAME = "Microsoft AI Training Generator";

const LEARN_HOST = "learn.microsoft.com";
const SLUG = /^[a-z][a-z0-9-]*$/;
// Emoji are not allowed in product labels: the wizard shows text badges, so meaning never rests on a glyph.
const EMOJI = /\p{Extended_Pictographic}/u;

let cached = null;

export function getProducts() {
  if (!cached) {
    const raw = JSON.parse(fs.readFileSync(PRODUCTS_PATH, "utf8"));
    cached = [...(raw.products || [])].sort((a, b) => a.order - b.order);
  }
  return cached;
}

export function getProduct(id) {
  return getProducts().find((p) => p.id === id) || null;
}

export function productName(id) {
  return getProduct(id)?.name || id;
}

/** The product a feature belongs to. A feature without the field is a Copilot Studio feature. */
export function productOf(feature) {
  return feature?.product || DEFAULT_PRODUCT;
}

export function productHasHarnesses(id) {
  return Boolean(getProduct(id)?.hasHarnesses);
}

/** The harness a harness-tagged catalog entry belongs to. A harness with no product is a Copilot Studio harness. */
export function harnessProduct(harness) {
  return harness?.product || DEFAULT_PRODUCT;
}

/**
 * The coverage "targets" a feature teaches: its harness tags when it has any,
 * otherwise its product. A concept's coverage is judged per target, so
 * Copilot Studio is judged per harness and every other product as a whole.
 */
export function featureTargets(feature) {
  return Array.isArray(feature?.harness) && feature.harness.length ? feature.harness : [productOf(feature)];
}

/** The product most of a plan's own (non-recap) modules belong to; ties go to the earlier product in catalog order. */
export function primaryProduct(plan) {
  const order = getProducts().map((p) => p.id);
  const counts = new Map();
  for (const f of plan.features || []) {
    if (f.prerequisite) continue;
    counts.set(productOf(f), (counts.get(productOf(f)) || 0) + 1);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]));
  return ranked[0]?.[0] || plan.products?.[0] || DEFAULT_PRODUCT;
}

/** "Microsoft Copilot Studio", "A and B", "A, B, and C". */
export function joinNames(names) {
  const list = names.filter(Boolean);
  if (list.length <= 2) return list.join(" and ");
  return `${list.slice(0, -1).join(", ")}, and ${list[list.length - 1]}`;
}

/** The products' full names for prose, in catalog order. */
export function productsPhrase(ids) {
  const wanted = new Set(ids);
  return joinNames(getProducts().filter((p) => wanted.has(p.id)).map((p) => p.name));
}

function httpsLearn(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && url.hostname === LEARN_HOST && !url.username && !url.password && !url.port;
  } catch {
    return false;
  }
}

/**
 * Problems with the product definitions and with every feature's product, as
 * human-readable strings.
 *
 * @param {{products: object[], features: object[], harnesses?: object[]}} input
 */
export function validateProducts({ products, features, harnesses = [] }) {
  const problems = [];
  const ids = new Set();
  const byId = new Map(products.map((p) => [p.id, p]));
  const harnessIds = new Set(harnesses.map((h) => h.id));

  if (!products.length) problems.push("products: at least one product is required");
  products.forEach((p, position) => {
    const label = `product ${p?.id || `#${position}`}`;
    if (typeof p?.id !== "string" || !SLUG.test(p.id)) {
      problems.push(`${label}: id must be a lower-case slug`);
      return;
    }
    if (ids.has(p.id)) problems.push(`${label}: duplicate product id`);
    ids.add(p.id);
    if (harnessIds.has(p.id)) problems.push(`${label}: id collides with a harness id`);
    for (const field of ["name", "shortName", "summary", "agentNoun"]) {
      if (typeof p[field] !== "string" || !p[field].trim()) problems.push(`${label}: needs a ${field}`);
      else if (EMOJI.test(p[field])) problems.push(`${label}: ${field} must be plain text without emoji`);
    }
    if (!Number.isFinite(p.order)) problems.push(`${label}: needs a numeric order`);
    if (!httpsLearn(p.learnHubUrl)) problems.push(`${label}: learnHubUrl must be an https URL on ${LEARN_HOST}`);
    if (!Array.isArray(p.learnRoots) || !p.learnRoots.length || !p.learnRoots.every(httpsLearn)) {
      problems.push(`${label}: learnRoots must list at least one https URL on ${LEARN_HOST}`);
    }
    if (!Array.isArray(p.levels) || !p.levels.length || p.levels.some((level) => !PRODUCT_LEVELS.includes(level))) {
      problems.push(`${label}: levels must be a non-empty subset of ${PRODUCT_LEVELS.join(", ")}`);
    }
    if (typeof p.hasHarnesses !== "boolean") problems.push(`${label}: hasHarnesses must be true or false`);
    if (!Array.isArray(p.labPrerequisites) || !p.labPrerequisites.length || p.labPrerequisites.some((t) => typeof t !== "string" || !t.trim())) {
      problems.push(`${label}: labPrerequisites must list at least one non-empty string`);
    }
    if (typeof p.licenseNote !== "string" || !p.licenseNote.trim()) problems.push(`${label}: needs a licenseNote`);
  });

  for (const harness of harnesses) {
    const owner = byId.get(harnessProduct(harness));
    if (!owner) problems.push(`harness ${harness.id}: unknown product "${harnessProduct(harness)}"`);
    else if (!owner.hasHarnesses) problems.push(`harness ${harness.id}: product ${owner.id} does not declare hasHarnesses`);
  }
  for (const p of products) {
    if (p.hasHarnesses && !harnesses.some((h) => harnessProduct(h) === p.id)) {
      problems.push(`product ${p.id}: hasHarnesses is true but no harness belongs to it`);
    }
  }

  const counts = new Map();
  for (const f of features) {
    const id = productOf(f);
    const product = byId.get(id);
    if (!product) {
      problems.push(`${f.id}: unknown product "${id}"`);
      continue;
    }
    counts.set(id, (counts.get(id) || 0) + 1);
    if (!product.levels?.includes(f.level)) problems.push(`${f.id}: level ${f.level} is not in ${id} levels (${(product.levels || []).join(", ")})`);
    if (!product.hasHarnesses && Array.isArray(f.harness) && f.harness.length) {
      problems.push(`${f.id}: ${id} has no harnesses, so the feature must not carry a harness tag`);
    }
    for (const prereq of f.prereqs || []) {
      const required = features.find((other) => other.id === prereq);
      if (required && productOf(required) !== id) problems.push(`${f.id}: prerequisite ${prereq} belongs to another product (${productOf(required)})`);
    }
  }
  for (const p of products) {
    if (!counts.get(p.id)) problems.push(`product ${p.id}: has no catalog features`);
    else if (p.levels) {
      for (const level of p.levels) {
        if (!features.some((f) => productOf(f) === p.id && f.level === level)) {
          problems.push(`product ${p.id}: lists level ${level} but has no feature at that level; remove it from levels`);
        }
      }
    }
  }
  return problems;
}
