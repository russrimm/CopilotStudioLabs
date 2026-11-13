/**
 * Concept coverage: for every concept and every harness, does a catalog feature
 * teach it ("variant"), is there a justified "not applicable" reason, or is the
 * cell missing? The matrix feeds docs/lab-builder.md, the catalog validator,
 * and a guard so a concept can never silently have nothing on a harness.
 */

/** @returns {"variant"|"n/a"|"missing"} */
export function coverageStatus(concept, harnessId, byId) {
  if (concept.features.some((id) => byId.get(id)?.harness?.includes(harnessId))) return "variant";
  if (concept.notApplicable?.[harnessId]?.trim()) return "n/a";
  return "missing";
}

/**
 * @param {{concepts: object[], features: object[], harnesses: object[]}} input
 * @returns {{harnesses: string[], rows: {concept: string, name: string, cells: Record<string, {status: string, features: string[], reason?: string}>}[], missing: string[]}}
 */
export function buildCoverageMatrix({ concepts, features, harnesses }) {
  const byId = new Map(features.map((f) => [f.id, f]));
  const ids = harnesses.map((h) => h.id);
  const missing = [];
  const rows = concepts.map((concept) => {
    const cells = {};
    for (const id of ids) {
      const status = coverageStatus(concept, id, byId);
      const cell = { status, features: concept.features.filter((f) => byId.get(f)?.harness?.includes(id)) };
      if (status === "n/a") cell.reason = concept.notApplicable[id];
      if (status === "missing") missing.push(`${concept.id}:${id}`);
      cells[id] = cell;
    }
    return { concept: concept.id, name: concept.name, cells };
  });
  return { harnesses: ids, rows, missing };
}

/** A GitHub-flavored Markdown table of the matrix. */
export function renderCoverageMarkdown(matrix, harnesses) {
  const names = Object.fromEntries(harnesses.map((h) => [h.id, h.name]));
  const head = `| Concept | ${matrix.harnesses.map((id) => names[id] || id).join(" | ")} |`;
  const rule = `| --- | ${matrix.harnesses.map(() => "---").join(" | ")} |`;
  const body = matrix.rows.map((row) => {
    const cells = matrix.harnesses.map((id) => {
      const cell = row.cells[id];
      if (cell.status === "variant") return `variant (${cell.features.length})`;
      if (cell.status === "n/a") return "n/a";
      return "**missing**";
    });
    return `| ${row.name} | ${cells.join(" | ")} |`;
  });
  return [head, rule, ...body].join("\n");
}

/**
 * Problems with coverage. `knownGaps` lists `concept:harness` cells that are
 * still missing; a missing cell not on the list fails, and so does a listed
 * cell that is now covered, so the list can only shrink.
 *
 * @param {{concepts: object[], features: object[], harnesses: object[], knownGaps?: string[]}} input
 */
export function validateCoverage({ concepts, features, harnesses, knownGaps = [] }) {
  if (!harnesses.length) return [];
  const { missing } = buildCoverageMatrix({ concepts, features, harnesses });
  const allowed = new Set(knownGaps);
  const problems = [];
  for (const cell of missing) {
    if (!allowed.has(cell)) {
      const [concept, harness] = cell.split(":");
      problems.push(`coverage ${concept}: no feature and no notApplicable reason for harness "${harness}"`);
    }
  }
  const still = new Set(missing);
  for (const cell of allowed) {
    if (!still.has(cell)) problems.push(`coverage: knownGaps lists ${cell}, which is now covered; remove it`);
  }
  return problems;
}
