/**
 * Lab composer.
 *
 * Turns a plan + Learn MCP grounding + optional LLM enrichment into a lab
 * `index.md` that matches this repo's lab format and passes `validator.js`.
 *
 * Hard rules enforced here (they mirror portal/lib/validator.js):
 *  - single H1, then a pipe metadata table with DIFFICULTY / TIME / PRODUCTS /
 *    TAGS / INDUSTRIES rows
 *  - an Overview heading, an Objectives heading, and `### Step N - ...` headings
 *  - no heading may be left without body content
 *  - the words TODO / FIXME / TBD / XXX must never appear
 */

const PRODUCTS = "Microsoft Copilot Studio, Power Platform, Microsoft 365";

function bullets(items, prefix = "-") {
  return items.map((item) => `${prefix} ${item}`).join("\n");
}

function lowerFirst(text) {
  const value = String(text || "");
  // Leave acronyms and product names capitalised.
  if (/^[A-Z]{2,}/.test(value) || /^[A-Z][a-z]*[A-Z]/.test(value)) return value;
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function sentenceList(items) {
  if (!items.length) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** Trim a Learn excerpt down to a quotable, single-paragraph snippet. */
function condense(text, maxLength = 420) {
  const clean = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[*_>`|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= maxLength) return clean;
  const cut = clean.slice(0, maxLength);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  return `${(lastStop > 120 ? cut.slice(0, lastStop) : cut).trim()}...`;
}

function scrubForbidden(text) {
  // The validator rejects TODO-style markers anywhere in the file, and Learn
  // excerpts occasionally contain them in sample code commentary.
  return String(text)
    .replace(/\bTODO\b/gi, "action item")
    .replace(/\bFIXME\b/gi, "follow-up")
    .replace(/\bTBD\b/gi, "to be confirmed")
    .replace(/\bXXX\b/gi, "placeholder");
}

function metadataTable(plan) {
  const industries = plan.industry ? plan.industry.name : "Cross-industry";
  const tags = plan.tags.slice(0, 8).join(", ");
  return [
    "| | |",
    "|---|---|",
    `| ⭐ **DIFFICULTY** | ${plan.difficulty} |`,
    `| ⏱️ **TIME** | ${plan.duration} |`,
    `| 🧩 **PRODUCTS** | ${PRODUCTS} |`,
    `| 🏷️ **TAGS** | ${tags} |`,
    `| 🏭 **INDUSTRIES** | ${industries} |`,
  ].join("\n");
}

function overviewSection(plan, enrichment) {
  const profile = plan.profile;
  const roleLine = plan.roles.length
    ? ` It is written for ${sentenceList(plan.roles.map((r) => r.name))}.`
    : "";

  const intro =
    enrichment?.overview ||
    `${profile.problem} In this lab you build **${profile.agentName}**, a Microsoft Copilot Studio agent for ${profile.domain}, ending with ${profile.outcome}.`;

  const focus = plan.features.map((f) => `**${f.name}** - ${f.summary}`);

  return [
    "## Overview",
    "",
    scrubForbidden(intro) + roleLine,
    "",
    `You will work through ${plan.features.length} module${plan.features.length === 1 ? "" : "s"}, in order, building on the same agent the whole way. Each module explains what you are configuring and why it matters before you touch the product, so you finish with working software *and* a mental model you can reuse.`,
    "",
    "**What this lab covers**",
    "",
    bullets(focus),
    "",
    plan.roles.length
      ? `**Why this matters to ${sentenceList(plan.roles.map((r) => r.name))}:** ${sentenceList(
          plan.roles.map((r) => (r.emphasis || "").replace(/\.$/, "")).filter(Boolean),
        )}.`
      : `**Business signal to watch:** ${profile.kpi}.`,
  ].join("\n");
}

function objectivesSection(plan) {
  const objectives = plan.features.map((f) => `**${f.name}** — ${scrubForbidden(f.summary)}`);
  return [
    "## Learning Objectives",
    "",
    "By the end of this lab you will be able to configure each of the following in your own environment, and explain to someone else why it is there:",
    "",
    bullets(objectives),
  ].join("\n");
}

function prerequisitesSection(plan) {
  const profile = plan.profile;
  const items = [
    "A Microsoft Copilot Studio environment you can create agents in (a [free trial](https://copilotstudio.microsoft.com/) is enough for everything here).",
    "A Power Platform environment where you are at least an Environment Maker.",
    "A modern browser signed in with the account that owns that environment.",
  ];

  if (plan.features.some((f) => f.category === "knowledge")) {
    items.push(`Access to at least one knowledge source, for example: ${profile.knowledgeSources[0].toLowerCase()}.`);
  }
  if (plan.features.some((f) => f.category === "tools" || f.category === "automation")) {
    items.push("Permission to create connections in Power Platform (the lab uses at least one connector).");
  }
  if (plan.features.some((f) => f.id === "authentication" || f.id === "channel-web-sdk")) {
    items.push("Permission to register an application in Microsoft Entra ID, or an admin who can do it with you.");
  }
  if (plan.features.some((f) => f.id === "dlp-governance" || f.id === "alm-solutions")) {
    items.push("Power Platform admin center access for the governance modules.");
  }

  return [
    "## Prerequisites",
    "",
    bullets(items),
    "",
    "**Scenario data you will need**",
    "",
    bullets(profile.knowledgeSources),
    "",
    "You do not need production data. Sample documents and a handful of test records are enough to make every module work end to end.",
  ].join("\n");
}

function scenarioSection(plan) {
  const profile = plan.profile;
  const roleNotes = plan.roles.filter((r) => r.designNote).map((r) => `**${r.name}:** ${r.designNote}`);

  return [
    "## The Scenario",
    "",
    `You are building **${profile.agentName}** for ${profile.audience}.`,
    "",
    `**The problem.** ${profile.problem}`,
    "",
    `**What good looks like.** By the end of the lab you have ${profile.outcome}.`,
    "",
    "**Questions the finished agent should answer**",
    "",
    bullets(profile.sampleQuestions.map((q) => `"${q}"`)),
    "",
    `**Domain language to keep consistent:** ${profile.terms.join(", ")}.`,
    "",
    `**Measure of success:** ${profile.kpi}.`,
    ...(roleNotes.length ? ["", "**Design notes for your audience**", "", bullets(roleNotes)] : []),
  ].join("\n");
}

function screenshotBlock(shots) {
  const lines = [];
  for (const shot of shots.reused) {
    lines.push("", `![${shot.caption}](assets/${shot.filename})`, "", `*${shot.caption}. ${shot.credit}.*`);
  }
  for (const shot of shots.capture) {
    lines.push(
      "",
      `> 📸 **Capture this screen:** \`assets/${shot.filename}\``,
      ">",
      ...shot.instructions.map((line) => `> - ${line}`),
      ">",
      "> Capture it manually and save it with that filename, or run the repo's capture tool against this lab's manifest:",
      "> `node tools/screenshot-capture/capture.js --manifest=<path-to-this-lab>/shots.json`",
    );
  }
  return lines;
}

function citationBlock(grounding) {
  if (!grounding?.sources?.length) return [];
  return [
    "",
    "**Microsoft Learn references**",
    "",
    bullets(grounding.sources.map((s) => `[${scrubForbidden(s.title || s.url)}](${s.url})`)),
  ];
}

/**
 * The "From the docs" pull quote.
 *
 * It must come from the *best* source, not merely the first long one. Before
 * issue #40 this took the first result whose excerpt cleared 120 characters,
 * which on a "Create an agent" module could quote a Microsoft Fabric page under
 * a Copilot Studio heading — a quote that reads as authoritative precisely
 * because it is well written about the wrong product.
 *
 * `groundFeature` already ranks results by relevance and drops everything below
 * the floor, so the highest-scoring usable excerpt is the honest choice. The
 * sort is defensive: callers and fixtures may pass unranked results, and an
 * unscored result sorts last rather than winning by accident.
 */
function groundedInsight(grounding) {
  const usable = (grounding?.results || []).filter((r) => r.excerpt && r.excerpt.length > 120);
  if (!usable.length) return [];

  const best = [...usable].sort((a, b) => (b.relevance ?? -1) - (a.relevance ?? -1))[0];
  const quote = scrubForbidden(condense(best.excerpt));
  if (!quote) return [];
  const attribution = best.url ? ` — [Microsoft Learn](${best.url})` : "";
  return ["", "> **From the docs:** " + quote + attribution];
}

/**
 * Where this module's steps came from, stated in the lab itself.
 *
 * A learner following a click list deserves to know whether it was read off the
 * current documentation or off a catalog that may have aged. Before issue #37
 * the lab's header claimed every module was "grounded on Microsoft Learn" while
 * the steps were always the catalog's — this line is what makes the claim honest
 * per module.
 */
function stepProvenance(record) {
  if (!record || record.source !== "doc-derived") {
    const why =
      record?.reason === "fetch-failed"
        ? "its documentation page could not be read"
        : record?.reason === "learn-unavailable"
        ? "Microsoft Learn grounding was not used for this build"
        : record?.reason === "no-doc-url"
        ? "no documentation page is on file for it"
        : "no procedure on its documentation page matched this module closely enough";
    return [
      "",
      `*These steps come from this repository's curated catalog, because ${why}. ` +
        `They were accurate when written, but they are not verified against the current product. ` +
        `If a click does not match what you see, trust the Microsoft Learn link in this module.*`,
    ];
  }

  const heading = record.sectionHeading ? scrubForbidden(record.sectionHeading) : "the current documentation";
  const day = record.fetchedAt ? String(record.fetchedAt).slice(0, 10) : null;
  const link = record.url ? `[${heading}](${record.url})` : heading;
  return ["", `*Read from ${link}${day ? ` on ${day}` : ""}.*`];
}

function featureSection(feature, plan, grounding, shots, enrichment, stepsRecord) {
  const profile = plan.profile;
  const applied =
    enrichment?.applied ||
    `Do this for **${profile.agentName}**: ${lowerFirst(feature.summary.replace(/\.$/, ""))}, using the ${profile.domain} content described in **The Scenario** above. Keep the wording consistent with the domain language for this lab (${profile.terms.slice(0, 3).join(", ")}) so answers sound like they came from your team.`;

  // Doc-derived steps when the live page could be read, curated steps otherwise.
  // Both paths are scrubbed: derived steps are untrusted fetched content, and
  // the validator rejects TODO-style markers anywhere in a lab file.
  const source = stepsRecord?.steps?.length ? stepsRecord.steps : feature.steps;
  const steps = source.map((step, index) => `${index + 1}. ${scrubForbidden(step)}`);

  return [
    `### Step ${feature.order} - ${feature.name}`,
    "",
    `*Level ${feature.level} · about ${feature.minutes} minutes*`,
    "",
    `**What you are doing.** ${scrubForbidden(feature.summary)}`,
    "",
    `**Why it matters.** ${scrubForbidden(feature.whyItMatters)}`,
    ...groundedInsight(grounding),
    "",
    "**Concepts before you click**",
    "",
    bullets(feature.concepts.map(scrubForbidden)),
    "",
    "**Do this**",
    ...stepProvenance(stepsRecord),
    "",
    steps.join("\n"),
    "",
    `**In your scenario.** ${scrubForbidden(applied)}`,
    ...screenshotBlock(shots),
    "",
    "**Check your work**",
    "",
    bullets(feature.validation.map((v) => `[ ] ${scrubForbidden(v)}`)),
    ...citationBlock(grounding),
  ].join("\n");
}

function validationSection(plan) {
  const checks = plan.features.flatMap((f) => f.validation.map((v) => `[ ] **${f.name}:** ${scrubForbidden(v)}`));
  const profile = plan.profile;

  return [
    "## Validation / Success Criteria",
    "",
    "Work through every check below before you call the lab done.",
    "",
    bullets(checks),
    "",
    "**End-to-end test**",
    "",
    bullets(profile.sampleQuestions.map((q) => `Ask the published agent "${q}" and confirm the answer is correct, grounded, and cites a source where one applies.`)),
    "",
    "If a check fails, the module that owns it is the place to start debugging. Each module lists the exact setting it changed.",
  ].join("\n");
}

function nextStepsSection(plan) {
  const lines = ["## Where to Go Next", ""];

  if (plan.deferred.length) {
    lines.push(
      "These modules were left out to keep the lab inside its time budget. Add them to a follow-up run:",
      "",
      bullets(plan.deferred.map((d) => `**${d.name}** (${d.minutes} min) - ${d.summary}`)),
      "",
    );
  }

  if (plan.relatedLabs.length) {
    lines.push(
      "Related hands-on labs in this repository go deeper on the same features:",
      "",
      bullets(plan.relatedLabs.map((id) => `\`labs/${id}\``)),
      "",
    );
  }

  lines.push(
    "Extend the scenario itself by adding a second knowledge source, wiring a real system of record, or handing part of the work to a connected agent.",
  );

  return lines.join("\n");
}

function completeSection(plan) {
  return [
    "## Lab Complete",
    "",
    `You built **${plan.profile.agentName}** end to end: ${sentenceList(plan.features.map((f) => f.name))}.`,
    "",
    `More importantly, you can now explain *why* each of those pieces exists, which is what makes the next agent faster to build than this one was.`,
  ].join("\n");
}

function howToUseSection(plan, generation) {
  const grounded = generation.groundedFeatures;
  const derived = generation.docDerivedFeatures ?? 0;
  const total = plan.features.length;
  const provider = generation.llmProvider;
  const plural = total === 1 ? "" : "s";

  const lines = [
    "## How This Lab Was Built",
    "",
    `This lab was generated for your selections rather than written by hand. Citations for ${grounded} of ${total} module${plural} were checked against live Microsoft Learn documentation through the Microsoft Learn MCP server.`,
    "",
    derived === total
      ? `The click-by-click steps in every module were read from the current documentation page for that feature at build time, not copied from a stored list. Each module names the page and the date it was read.`
      : derived > 0
      ? `The click-by-click steps for ${derived} of ${total} module${plural} were read from the current documentation page at build time; the remaining ${total - derived} use this repository's curated steps. Every module says which of the two it used, and when.`
      : `The click-by-click steps come from this repository's curated Copilot Studio feature catalog rather than from a live page — each module says so, and why.`,
    "",
    provider && provider !== "none"
      ? `Narrative for your industry and role was drafted with ${provider} on top of that grounded content. No language model was involved in producing the steps.`
      : "No language model was configured, so the narrative comes from this repository's curated Copilot Studio feature catalog combined with the Microsoft Learn excerpts above. The steps do not depend on a language model either way.",
    "",
    "Product UI changes often. If a step does not match what you see, follow the Microsoft Learn link in that module — that link is the source of truth.",
  ];

  return lines.join("\n");
}

/**
 * Compose the full lab markdown.
 *
 * @param {object} plan planner output
 * @param {Map<string, object>} groundingByFeature featureId -> groundFeature() result
 * @param {Map<string, object>} shotsByFeature featureId -> { reused, capture }
 * @param {object} enrichment { overview?, byFeature?: Map<string, {applied}> }
 * @param {object} generation { groundedFeatures, docDerivedFeatures, llmProvider, generatedAt }
 * @param {Map<string, object>} [stepsByFeature] featureId -> step provenance record
 */
export function composeLab(plan, groundingByFeature, shotsByFeature, enrichment = {}, generation = {}, stepsByFeature = new Map()) {
  const sections = [
    `# ${scrubForbidden(plan.title)}`,
    "",
    `*Build ${plan.profile.agentName} in Microsoft Copilot Studio, one grounded module at a time.*`,
    "",
    metadataTable(plan),
    "",
    "---",
    "",
    overviewSection(plan, enrichment),
    "",
    objectivesSection(plan),
    "",
    prerequisitesSection(plan),
    "",
    scenarioSection(plan),
    "",
    "## Step-by-Step",
    "",
    "Each module below stands on its own, but they are ordered so that every prerequisite is configured before you need it. Work top to bottom.",
    "",
  ];

  for (const feature of plan.features) {
    sections.push(
      featureSection(
        feature,
        plan,
        groundingByFeature.get(feature.id),
        shotsByFeature.get(feature.id) || { reused: [], capture: [] },
        enrichment.byFeature?.get(feature.id),
        stepsByFeature.get(feature.id),
      ),
      "",
    );
  }

  sections.push(
    validationSection(plan),
    "",
    nextStepsSection(plan),
    "",
    completeSection(plan),
    "",
    howToUseSection(plan, generation),
    "",
  );

  return sections.join("\n").replace(/\n{4,}/g, "\n\n\n").trimEnd() + "\n";
}

export { scrubForbidden, condense };
