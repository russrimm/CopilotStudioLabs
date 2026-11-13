/**
 * Level helpers for the guided lab builder.
 *
 * The level chosen at Step 3 of the wizard is the single source of truth for
 * what a lab teaches: topics at that level are listed and generated, and a
 * lower-level topic appears only as a short, labeled prerequisite recap when a
 * selected topic genuinely depends on it. These helpers keep that rule in one
 * place so the recommendation, the planner, and the composer cannot drift.
 */

export const LEVEL_VALUES = [100, 200, 300];

export const LEVEL_LABELS = { 100: "Beginner", 200: "Intermediate", 300: "Advanced" };

/** Minutes a prerequisite recap is estimated to take, however long its full module is. */
export const PREREQ_RECAP_MINUTES = 5;

export function isLevel(value) {
  return LEVEL_VALUES.includes(Number(value));
}

/** "Level 100 (Beginner)" */
export function levelName(level) {
  return `Level ${level} (${LEVEL_LABELS[level] || "Unknown"})`;
}

// The rubric from docs/lab-builder.md, applied to a Learn page's slug and title.
// 300 is checked first so "custom connector" is advanced even though it mentions a tool.
const RUBRIC = [
  [
    300,
    /custom-connector|connector-sdk|\balm\b|solution|pipeline|govern|\bdlp\b|data-loss|security|compliance|purview|\badmin|identity|entra|vnet|virtual-network|private-link|network|enterprise|\bsdk\b|customer-managed|byok|gateway|a2a|agent-to-agent/i,
  ],
  [
    200,
    /\btools?\b|skills?|\bmcp\b|model-context|workflow|memory|hooks?|evaluat|connected-agent|sub-?agent|orchestrat|\bflows?\b|knowledge-|plugin|\bactions?\b|trigger|analytics|monitor/i,
  ],
  [100, /overview|what-is|get-started|quickstart|first-|create-|build-new|test-|publish|instructions|\babout\b/i],
];

/** The level a page's address and title suggest under the docs rubric, or null when nothing in it matches. */
export function classifyByRubric({ url, title } = {}) {
  let slug = "";
  try {
    slug = new URL(String(url)).pathname;
  } catch {
    slug = String(url || "");
  }
  const text = `${slug} ${title || ""}`;
  for (const [level, pattern] of RUBRIC) {
    if (pattern.test(text)) return level;
  }
  return null;
}

/**
 * Resolve the level of a topic discovered on Microsoft Learn.
 *
 * - `declared`: the snapshot carries a valid level, so it is used as is.
 * - `estimated`: no valid level, but the docs rubric classifies the page. The wizard marks it "Estimated level".
 * - `unknown`: nothing classifies it. It is shown only in a collapsed "Level unknown" group and is never recommended.
 *
 * @returns {{level: number|null, basis: "declared"|"estimated"|"unknown"}}
 */
export function resolveTopicLevel(topic) {
  if (isLevel(topic?.level)) return { level: Number(topic.level), basis: "declared" };
  const guess = classifyByRubric({ url: topic?.urls?.[0], title: topic?.title });
  return guess ? { level: guess, basis: "estimated" } : { level: null, basis: "unknown" };
}

/** True when a feature or topic row is taught at `level`. A feature with no level never matches. */
export function atLevel(feature, level) {
  return isLevel(feature?.level) && Number(feature.level) === Number(level);
}
