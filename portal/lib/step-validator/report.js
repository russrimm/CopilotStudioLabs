/**
 * Report model for step validation.
 *
 * The shape is deliberately method-agnostic. Each step carries a `checks` map
 * keyed by validation method; phase 1 fills `checks.docs` (Microsoft Learn
 * text), and `checks.live` is reserved for phase 2 (running the step in Copilot
 * Studio with browser automation) so live results can be added without changing
 * any consumer. A step's top-level `status` is derived from the checks that ran.
 *
 *   report { schemaVersion, generatedAt, methods, source, summary, labs[] }
 *   lab    { labId, title, status, stepSource, steps[], counts, coverage, notes[] }
 *   step   { id, number, title, group, line, status, counts, checks:{docs, live} }
 *   claim  { id, kind, term, confidence, line, context, status, rule, explanation, evidence[] }
 */

export const SCHEMA_VERSION = 1;

export const STATUSES = Object.freeze(["verified", "unverified", "stale", "unable", "no-claims", "no-steps"]);

const PRECEDENCE = ["stale", "unable", "unverified", "verified"];

export const STATUS_LABELS = Object.freeze({
  verified: "Verified",
  unverified: "Unverified",
  stale: "Likely stale",
  unable: "Unable to verify",
  "no-claims": "Nothing to check",
  "no-steps": "No steps found",
});

export function emptyCounts() {
  return { verified: 0, unverified: 0, stale: 0, unable: 0 };
}

/** Worst status wins: stale > unable > unverified > verified. */
export function rollup(statuses) {
  const list = statuses.filter((s) => PRECEDENCE.includes(s));
  for (const status of PRECEDENCE) if (list.includes(status)) return status;
  return null;
}

export function countClaims(claims) {
  const counts = emptyCounts();
  for (const claim of claims) if (claim.status in counts) counts[claim.status] += 1;
  return counts;
}

/**
 * Status for one step from its claims. Low-confidence claims (a bold word with no
 * UI context) never turn a verified step unverified on their own.
 */
export function stepStatus(claims) {
  if (!claims.length) return "no-claims";
  const high = claims.filter((c) => c.confidence === "high");
  if (claims.some((c) => c.status === "stale")) return "stale";
  if (claims.every((c) => c.status === "unable")) return "unable";
  if (high.some((c) => c.status === "unable")) return "unable";
  if (high.some((c) => c.status === "unverified")) return "unverified";
  if (claims.some((c) => c.status === "verified")) return "verified";
  return claims.some((c) => c.status === "unable") ? "unable" : "unverified";
}

/** Fold the status of every method that ran on a step. Methods that did not run are ignored. */
export function combineChecks(checks) {
  const ran = Object.values(checks)
    .map((check) => check?.status)
    .filter((status) => status && status !== "not-run");
  if (!ran.length) return "no-claims";
  return rollup(ran) || ran[0];
}

export function labStatus(steps, hasSteps) {
  if (!hasSteps) return "no-steps";
  const status = rollup(steps.map((s) => s.status));
  return status || "no-claims";
}

export function summarizeLab(lab) {
  const counts = emptyCounts();
  let claims = 0;
  for (const step of lab.steps) {
    for (const key of Object.keys(counts)) counts[key] += step.counts?.[key] || 0;
  }
  claims = counts.verified + counts.unverified + counts.stale + counts.unable;
  const stepCounts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const step of lab.steps) stepCounts[step.status] += 1;
  return {
    ...lab,
    counts,
    stepCounts,
    coverage: { claims, verified: counts.verified, ratio: claims ? Number((counts.verified / claims).toFixed(3)) : null },
  };
}

export function summarizeReport(labs) {
  const labCounts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  const claimCounts = emptyCounts();
  let steps = 0;
  for (const lab of labs) {
    labCounts[lab.status] += 1;
    steps += lab.steps.length;
    for (const key of Object.keys(claimCounts)) claimCounts[key] += lab.counts?.[key] || 0;
  }
  const claims = claimCounts.verified + claimCounts.unverified + claimCounts.stale + claimCounts.unable;
  return {
    labs: labs.length,
    steps,
    claims,
    labStatus: labCounts,
    claimStatus: claimCounts,
    coverage: claims ? Number((claimCounts.verified / claims).toFixed(3)) : null,
  };
}

export function buildReport({ labs, source, generatedAt = new Date().toISOString(), canceled = false }) {
  const summarized = labs.map(summarizeLab);
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    methods: ["docs"],
    canceled,
    source,
    summary: summarizeReport(summarized),
    labs: summarized,
  };
}

const mdEscape = (text) => String(text ?? "").replace(/[\\`*_{}[\]<>|]/g, (c) => `\\${c}`).replace(/\s+/g, " ");

/** Markdown for CI logs and issues. All Learn-derived text is escaped. */
export function toMarkdown(report, { onlyFindings = false } = {}) {
  const lines = [];
  const s = report.summary;
  lines.push("# Lab step validation (Microsoft Learn)", "");
  lines.push(`Generated ${report.generatedAt}. Method: documentation check against Microsoft Learn (live execution is not run).`, "");
  lines.push(
    `**${s.labs} labs, ${s.steps} steps, ${s.claims} claims:** ${s.claimStatus.verified} verified, ${s.claimStatus.unverified} unverified, ${s.claimStatus.stale} likely stale, ${s.claimStatus.unable} unable to verify.`,
    "",
  );
  if (report.canceled) lines.push("> The run was canceled; results are partial.", "");
  for (const lab of report.labs) {
    if (onlyFindings && !["stale", "unable"].includes(lab.status)) continue;
    lines.push(`## ${mdEscape(lab.title)} (${lab.labId}) — ${STATUS_LABELS[lab.status]}`, "");
    for (const note of lab.notes || []) lines.push(`- Note: ${mdEscape(note)}`);
    for (const step of lab.steps) {
      if (onlyFindings && !["stale", "unable"].includes(step.status)) continue;
      lines.push(`### ${mdEscape(step.title)} — ${STATUS_LABELS[step.status]}`, "");
      const docs = step.checks?.docs;
      for (const claim of docs?.claims || []) {
        if (onlyFindings && claim.status === "verified") continue;
        lines.push(`- **${STATUS_LABELS[claim.status]}** (${claim.kind}, rule \`${claim.rule}\`): ${mdEscape(claim.term)} — ${mdEscape(claim.explanation)}`);
        for (const ev of (claim.evidence || []).slice(0, 1)) {
          lines.push(`  - ${mdEscape(ev.title)}: ${ev.url}`, `  - > ${mdEscape(ev.excerpt)}`);
        }
      }
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}
