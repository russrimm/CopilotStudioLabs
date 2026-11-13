/**
 * Concept coverage: for every concept and every coverage target, does a catalog
 * feature teach it ("variant"), is there a justified "not applicable" reason,
 * or is the cell missing? The matrix feeds docs/lab-builder.md, the catalog
 * validator, and a guard so a concept can never silently have nothing for a
 * target.
 *
 * A target is a harness for a product that has harnesses (Copilot Studio), and
 * the product itself for every other product. A concept lists the products it
 * applies to (`products`, default Copilot Studio) and is judged only on those
 * products' targets, so a concept that only makes sense for one product never
 * owes a cell to the others.
 */

import { DEFAULT_PRODUCT, featureTargets, getProducts, harnessProduct, productName } from "./products.js";

/** @returns {"variant"|"n/a"|"missing"} */
export function coverageStatus(concept, targetId, byId) {
  if (concept.features.some((id) => byId.get(id) && featureTargets(byId.get(id)).includes(targetId))) return "variant";
  if (concept.notApplicable?.[targetId]?.trim()) return "n/a";
  return "missing";
}

/** The products a concept applies to. */
export function conceptProducts(concept) {
  return Array.isArray(concept?.products) && concept.products.length ? concept.products : [DEFAULT_PRODUCT];
}

/**
 * The coverage targets one concept owes a cell: each harness of a listed
 * product that has harnesses, otherwise the listed product itself.
 *
 * @param {object} concept
 * @param {object[]} harnesses harness entries (each may carry a `product`)
 */
export function conceptTargets(concept, harnesses = []) {
  const targets = [];
  for (const productId of conceptProducts(concept)) {
    const own = harnesses.filter((h) => harnessProduct(h) === productId);
    if (own.length) targets.push(...own.map((h) => h.id));
    else targets.push(productId);
  }
  return targets;
}

/** Every target a catalog can be judged on, grouped by product in catalog order, harnesses in the order given. */
export function allTargets({ concepts, harnesses = [] }) {
  const seen = [];
  for (const concept of concepts) {
    for (const id of conceptTargets(concept, harnesses)) if (!seen.includes(id)) seen.push(id);
  }
  const order = getProducts().map((p) => p.id);
  const rank = (id) => {
    const index = order.indexOf(targetProduct(id, harnesses));
    return index === -1 ? order.length : index;
  };
  return seen
    .map((id, position) => ({ id, position }))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.position - b.position)
    .map((entry) => entry.id);
}

/** The product a coverage target belongs to: a harness's own product, or the product id itself. */
export function targetProduct(targetId, harnesses = []) {
  const harness = harnesses.find((h) => h.id === targetId);
  return harness ? harnessProduct(harness) : targetId;
}

/**
 * @param {{concepts: object[], features: object[], harnesses: object[]}} input
 * @returns {{harnesses: string[], targets: string[], rows: {concept: string, name: string, cells: Record<string, {status: string, features: string[], reason?: string}>}[], missing: string[]}}
 */
export function buildCoverageMatrix({ concepts, features, harnesses = [] }) {
  const byId = new Map(features.map((f) => [f.id, f]));
  const targets = allTargets({ concepts, harnesses });
  const missing = [];
  const rows = concepts.map((concept) => {
    const cells = {};
    for (const id of conceptTargets(concept, harnesses)) {
      const status = coverageStatus(concept, id, byId);
      const cell = {
        status,
        features: concept.features.filter((f) => byId.get(f) && featureTargets(byId.get(f)).includes(id)),
      };
      if (status === "n/a") cell.reason = concept.notApplicable[id];
      if (status === "missing") missing.push(`${concept.id}:${id}`);
      cells[id] = cell;
    }
    return { concept: concept.id, name: concept.name, cells };
  });
  // `harnesses` is kept for callers written before products existed: it lists the same targets.
  return { harnesses: targets, targets, rows, missing };
}

/**
 * GitHub-flavored Markdown for the matrix: one table per product, so each
 * product shows only the concepts that apply to it. A product with harnesses
 * has a column per harness; every other product has a single "Coverage" column.
 */
export function renderCoverageMarkdown(matrix, harnesses) {
  const names = Object.fromEntries(harnesses.map((h) => [h.id, h.name]));
  const productIds = [...new Set(matrix.targets.map((id) => targetProduct(id, harnesses)))];
  const sections = productIds.map((productId) => {
    const targets = matrix.targets.filter((id) => targetProduct(id, harnesses) === productId);
    const rows = matrix.rows.filter((row) => targets.some((id) => row.cells[id]));
    const label = (id) => names[id] || "Coverage";
    const head = `| Concept | ${targets.map(label).join(" | ")} |`;
    const rule = `| --- | ${targets.map(() => "---").join(" | ")} |`;
    const body = rows.map((row) => {
      const cells = targets.map((id) => {
        const cell = row.cells[id];
        if (!cell) return "-";
        if (cell.status === "variant") return `variant (${cell.features.length})`;
        if (cell.status === "n/a") return "n/a";
        return "**missing**";
      });
      return `| ${row.name} | ${cells.join(" | ")} |`;
    });
    return [`**${productName(productId)}**`, "", head, rule, ...body].join("\n");
  });
  return sections.join("\n\n");
}

/**
 * Problems with coverage. `knownGaps` lists `concept:target` cells that are
 * still missing; a missing cell not on the list fails, and so does a listed
 * cell that is now covered (or no longer owed), so the list can only shrink.
 *
 * @param {{concepts: object[], features: object[], harnesses: object[], knownGaps?: string[]}} input
 */
export function validateCoverage({ concepts, features, harnesses = [], knownGaps = [] }) {
  const { missing } = buildCoverageMatrix({ concepts, features, harnesses });
  const allowed = new Set(knownGaps);
  const problems = [];
  for (const cell of missing) {
    if (!allowed.has(cell)) {
      const [concept, target] = cell.split(":");
      const kind = harnesses.some((h) => h.id === target) ? "harness" : "product";
      problems.push(`coverage ${concept}: no feature and no notApplicable reason for ${kind} "${target}"`);
    }
  }
  const still = new Set(missing);
  for (const cell of allowed) {
    if (!still.has(cell)) problems.push(`coverage: knownGaps lists ${cell}, which is now covered; remove it`);
  }
  return problems;
}
