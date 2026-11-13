/**
 * Step validation: check each lab step's claims against current Microsoft Learn
 * content. See docs/step-validation.md.
 */

import { discoverLabs, getLabContent, isValidLabId } from "../labs.js";
import { createJobStore } from "./jobs.js";
import { createLearnClient } from "./learn-client.js";
import { validateLabs } from "./runner.js";

export { extractClaims } from "./claims.js";
export { RULES, evaluateClaim, buildEvidence } from "./matcher.js";
export { STATUSES, STATUS_LABELS, toMarkdown, buildReport } from "./report.js";
export { extractLearnLinks, validateLabSteps, validateLabs } from "./runner.js";
export { parseLabSteps } from "./steps.js";
export { createLearnClient } from "./learn-client.js";
export { createJobStore, JobConflictError } from "./jobs.js";

/** Lab inputs for the portal's labs/ folder. Throws { code: "not-found" | "invalid" } for bad ids. */
export function loadPortalLabs(labIds) {
  const available = new Map(discoverLabs().filter((lab) => lab.available).map((lab) => [lab.id, lab]));
  const ids = labIds?.length ? labIds : [...available.keys()];
  return ids.map((id) => {
    if (!isValidLabId(id)) throw Object.assign(new Error(`Invalid lab id: ${id}`), { code: "invalid" });
    const meta = available.get(id);
    const markdown = meta ? getLabContent(id) : null;
    if (!meta || markdown == null) throw Object.assign(new Error(`Lab not found: ${id}`), { code: "not-found" });
    return { labId: id, title: meta.title, products: String(meta.products || "").split(",").map((p) => p.trim()).filter(Boolean), markdown };
  });
}

/** Service used by the portal routes. Injectable for tests. */
export function createStepValidationService({
  store = createJobStore(),
  createLearn = createLearnClient,
  loadLabs = loadPortalLabs,
} = {}) {
  return {
    start(labIds) {
      const labs = loadLabs(labIds);
      const job = store.start({
        labTotal: labs.length,
        run: ({ onProgress, signal }) => validateLabs(labs, { learn: createLearn({ signal }), onProgress, signal }),
      });
      return store.snapshot(job, { includeLabs: false });
    },
    get: (id) => store.snapshot(store.get(id)),
    cancel: (id) => store.cancel(id),
    active: () => store.active()?.id || null,
  };
}
