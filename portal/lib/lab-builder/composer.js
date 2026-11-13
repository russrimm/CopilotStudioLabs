/**
 * Lab composer.
 *
 * Turns a plan + Learn MCP grounding + optional LLM enrichment into a lab
 * `index.md` that matches this repo's lab format and passes `validator.js`.
 *
 * Hard rules enforced here (they mirror portal/lib/validator.js, and CI also
 * runs `validate_labs.py --lab-dir` over an offline build):
 *  - exactly one H1 (the title); every section heading is H2 or deeper, and
 *    levels never skip
 *  - a pipe metadata table with a `Field | Details` header and DIFFICULTY /
 *    TIME / PRODUCTS / TAGS / INDUSTRIES rows
 *  - an Overview heading, an Objectives heading, and `### Step N - ...` headings
 *  - no heading may be left without body content
 *  - link text names its destination; a bare URL is never the link text
 *  - the words TODO / FIXME / TBD / XXX must never appear
 */

const CS_PRODUCTS = "Microsoft Copilot Studio, Power Platform, Microsoft 365";

import { getHarnesses } from "./catalog.js";
import { DEFAULT_PRODUCT, getProduct, joinNames, productName, productsPhrase } from "./products.js";
import { getConcepts } from "./concepts.js";
import { buildDifferenceBlocks } from "./differences.js";
import { levelName } from "./levels.js";
import {
  cleanupSection,
  expectedResultBlock,
  furtherLearningBlock,
  glossarySection,
  knowledgeCheckBlock,
  licensingBlock,
  sampleInputBlock,
  troubleshootingBlock,
} from "./teaching.js";

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

/**
 * Escape the characters that give text structure in Markdown (emphasis, links,
 * inline HTML, tables, code). Applied to caller-supplied title, agent name, and
 * audience so they render as the plain text the user typed.
 */
export function escapeMarkdown(text) {
  return String(text).replace(/[\\`*_[\]<>|~]/g, "\\$&");
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

/**
 * The at-a-glance freshness stamp.
 *
 * A generated lab is a point-in-time artifact: its citations were harvested from
 * a live search on one particular day and confirmed to resolve on that day.
 * Someone opening it six months later needs to know that from the top of the
 * page, not from a manifest they will never open — which is half of issue #41.
 *
 * The wording tracks what actually happened. When link checking was switched off
 * the row says so instead of quoting a date, because a freshness date that was
 * never earned is worse than none at all. For the same reason the row only names
 * the Learn host when the build actually opened a Learn session — `--no-learn`
 * reaches both branches below, and claiming the lab was generated against
 * learn.microsoft.com there would contradict the body of the lab.
 *
 * The signal is `learnConnected`, not the grounded-module count: a build can read
 * Learn pages to derive steps and still end up with no module whose citations
 * cleared the relevance floor.
 */
function freshnessRow(generation) {
  const check = generation.linkCheck;
  const day = (check?.verifiedAt || generation.generatedAt || "").slice(0, 10);
  if (!day) return null;

  let host = "Microsoft Learn";
  try {
    host = new URL(generation.endpoint).host;
  } catch {
    /* keep the human-readable fallback */
  }

  const readLearn = generation.learnConnected !== false;

  if (!check?.enabled || !check?.verifiedAt) {
    return readLearn
      ? `| 🔗 **VERIFIED** | Not link-checked — generated ${day} against ${host} |`
      : `| 🔗 **VERIFIED** | Not link-checked — generated ${day} without reading Microsoft Learn |`;
  }
  return readLearn
    ? `| 🔗 **VERIFIED** | ${check.checked} link(s) confirmed to resolve on ${day}, grounded against ${host} |`
    : `| 🔗 **VERIFIED** | ${check.checked} link(s) confirmed to resolve on ${day}; Microsoft Learn was not read for this build |`;
}

/** The PRODUCTS row: the Copilot Studio row as it always was, with any other product the lab covers added. */
function productsRow(plan) {
  const ids = plan.products?.length ? plan.products : [DEFAULT_PRODUCT];
  const others = ids.filter((id) => id !== DEFAULT_PRODUCT).map((id) => productName(id));
  return ids.includes(DEFAULT_PRODUCT) ? [CS_PRODUCTS, ...others].join(", ") : others.join(", ");
}

/** Short product names for prose: "Copilot Studio", "Copilot Studio and SharePoint AI". */
function shortProducts(plan) {
  const ids = plan.products?.length ? plan.products : [DEFAULT_PRODUCT];
  return joinNames(ids.map((id) => getProduct(id)?.shortName || id));
}

const isCopilotStudioOnly = (plan) => !plan.products?.length || plan.products.every((id) => id === DEFAULT_PRODUCT);

function metadataTable(plan, generation = {}) {
  const industries = plan.industry ? plan.industry.name : "Cross-industry";
  const tags = plan.tags.slice(0, 8).join(", ");
  return [
    "| Field | Details |",
    "|---|---|",
    `| ⭐ **DIFFICULTY** | ${plan.difficulty} |`,
    `| 🎚️ **LEVEL** | ${levelName(plan.level)} |`,
    `| ⏱️ **TIME** | About ${plan.duration} (estimate, not a limit) |`,
    `| 🧩 **PRODUCTS** | ${productsRow(plan)} |`,
    `| 🏷️ **TAGS** | ${tags} |`,
    `| 🏭 **INDUSTRIES** | ${industries} |`,
    freshnessRow(generation),
  ]
    .filter(Boolean)
    .join("\n");
}

function overviewSection(plan, enrichment) {
  const profile = plan.profile;
  const roleLine = plan.roles.length
    ? ` It is written for ${sentenceList(plan.roles.map((r) => r.name))}.`
    : "";

  const intro =
    enrichment?.overview ||
    `${profile.problem} In this lab you build **${escapeMarkdown(profile.agentName)}**, ${
      isCopilotStudioOnly(plan) ? "a Microsoft Copilot Studio agent" : `a solution with ${productsPhrase(plan.products)}`
    } for ${profile.domain}, ending with ${profile.outcome}.`;

  const focus = plan.features.filter((f) => !f.prerequisite).map((f) => `**${f.name}** - ${f.summary}`);
  const recaps = plan.features.filter((f) => f.prerequisite);
  const moduleCount = plan.features.length - recaps.length;

  return [
    "## Overview",
    "",
    scrubForbidden(intro) + roleLine,
    "",
    `You will work through ${moduleCount} ${levelName(plan.level)} module${moduleCount === 1 ? "" : "s"}, in order, building on the same agent the whole way. Each module explains what you are configuring and why it matters before you touch the product, so you finish with working software *and* a mental model you can reuse.`,
    ...(recaps.length
      ? [
          "",
          `This lab also opens with ${recaps.length} short **prerequisite recap${recaps.length === 1 ? "" : "s"}** from lower levels (${sentenceList(
            recaps.map((f) => f.name),
          )}), because the ${levelName(plan.level)} modules build on them. A recap is a refresher, not new ${levelName(plan.level)} content: skip it if you already know the topic.`,
        ]
      : []),
    "",
    `**What this ${levelName(plan.level)} lab covers**`,
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
  const objectives = plan.features
    .filter((f) => !f.prerequisite)
    .map((f) => `**Step ${f.order} - ${f.name}:** ${scrubForbidden(f.summary)}`);
  return [
    "## Learning Objectives",
    "",
    "By the end of this lab you will be able to do each of the following in your own environment, and explain to someone else why it matters. Each objective names the step that teaches it:",
    "",
    bullets(objectives),
  ].join("\n");
}

function timeEstimateSection(plan) {
  const estimate = plan.estimate;
  const rows = plan.features.map((f) =>
    f.prerequisite
      ? `| ${f.order} | Recap: ${escapeMarkdown(f.name)} | ${f.level} (prerequisite recap) | about ${f.minutes} min |`
      : `| ${f.order} | ${escapeMarkdown(f.name)} | ${f.level} | about ${f.minutes} min |`,
  );
  const lines = [
    "## Time Estimate",
    "",
    `Plan for about **${estimate.duration}** in total. These are estimates to help you schedule, not limits: work at your own pace, and take the time each module needs to be done well.`,
    "",
    "| Step | Module | Level | Estimated time |",
    "|---|---|---|---|",
    ...rows,
    `| | **Total** | | **about ${estimate.duration}** |`,
  ];
  if (estimate.suggestedParts.length > 1) {
    lines.push(
      "",
      `This is a long lab. If you would rather run it as ${estimate.suggestedParts.length} shorter sessions, these are natural stopping points, and every module stays in the lab:`,
      "",
      bullets(
        estimate.suggestedParts.map((part) => {
          const first = plan.features.find((f) => f.id === part.ids[0]);
          const last = plan.features.find((f) => f.id === part.ids[part.ids.length - 1]);
          const span = first === last ? `Step ${first.order}` : `Steps ${first.order} to ${last.order}`;
          return `**Part ${part.part}** (${span}): about ${part.duration}`;
        }),
      ),
    );
  }
  return lines.join("\n");
}

function prerequisitesSection(plan) {
  const profile = plan.profile;
  const ids = plan.products?.length ? plan.products : [DEFAULT_PRODUCT];
  const items = [];
  if (ids.includes(DEFAULT_PRODUCT)) {
    items.push(
      "A Microsoft Copilot Studio environment you can create agents in (a [free trial](https://copilotstudio.microsoft.com/) is enough for everything here).",
      "A Power Platform environment where you are at least an Environment Maker.",
    );
  }
  for (const id of ids.filter((pid) => pid !== DEFAULT_PRODUCT)) items.push(...(getProduct(id)?.labPrerequisites || []));
  items.push("A modern browser signed in with the account that owns that environment.");

  if (plan.features.some((f) => f.category === "knowledge")) {
    items.push(`Access to at least one knowledge source, for example: ${lowerFirst(profile.knowledgeSources[0])}.`);
  }
  if (plan.features.some((f) => ["tools", "automation", "integrations"].includes(f.category))) {
    items.push("Permission to create connections in Power Platform (the lab uses at least one connector).");
  }
  const has = (id) => plan.features.some((f) => f.id === id);
  if (plan.features.some((f) => f.category === "integrations" && f.id !== "onprem-data-gateway" && f.id !== "vnet-private-connectivity")) {
    items.push("A sandbox or developer account for each external system the lab connects to, with credentials you are allowed to use for testing.");
  }
  if (has("onprem-data-gateway")) {
    items.push("A Windows machine on the same network as your data source, where you are allowed to install the on-premises data gateway.");
  }
  if (has("vnet-private-connectivity")) {
    items.push("An Azure subscription where you can create virtual networks and delegate subnets, and a Managed Environment in Power Platform.");
  }
  if (plan.features.some((f) => f.id === "authentication" || f.id === "channel-web-sdk")) {
    items.push("Permission to register an application in Microsoft Entra ID, or an admin who can do it with you.");
  }
  if (has("entra-agent-identities")) {
    items.push("Access to the Microsoft Entra admin center with permission to view agent identities.");
  }
  if (plan.features.some((f) => ["dlp-governance", "alm-solutions", "agent-inventory", "vnet-private-connectivity"].includes(f.id))) {
    items.push("Power Platform admin center access for the administration modules in this lab.");
  }

  if (plan.assumedPrereqs?.length) {
    items.push(
      `You have already completed these topics, which this lab builds on but does not teach: ${plan.assumedPrereqs
        .map((a) => `${escapeMarkdown(a.name)} (needed by ${a.neededBy.map(escapeMarkdown).join(", ")})`)
        .join("; ")}.`,
    );
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
    ...licensingBlock(plan, TEACH),
  ].join("\n");
}

function scenarioSection(plan) {
  const profile = plan.profile;
  const roleNotes = plan.roles.filter((r) => r.designNote).map((r) => `**${r.name}:** ${r.designNote}`);

  return [
    "## The Scenario",
    "",
    `You are building **${escapeMarkdown(profile.agentName)}** for ${escapeMarkdown(profile.audience)}.`,
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

/** Alt text goes inside `![...]`, so keep brackets and line breaks out of it. */
function altText(text) {
  return scrubForbidden(String(text)).replace(/[\r\n]+/g, " ").replace(/\[/g, "(").replace(/]/g, ")").trim();
}

/**
 * Figures for one module: the image, specific alt text that says what it shows
 * and why it matters, and a numbered caption. A slot not yet captured holds the
 * neutral "Screenshot pending" placeholder at its final filename, so the lab
 * stays valid and accessible now and needs no edit when the real image lands.
 * Capture instructions are for authors and live in shots.json and SHOTLIST.md,
 * not here.
 */
function screenshotBlock(shots) {
  const lines = [];
  for (const shot of shots.reused) {
    lines.push(
      "",
      `![${altText(shot.alt)}](assets/${shot.filename})`,
      "",
      `*Figure ${shot.figure}. ${scrubForbidden(shot.caption)}. ${shot.credit}.*`,
    );
  }
  for (const shot of shots.capture) {
    lines.push(
      "",
      `![${altText(shot.alt)}](assets/${shot.filename})`,
      "",
      `*Figure ${shot.figure}. ${scrubForbidden(shot.caption)}.*`,
    );
  }
  return lines;
}

/**
 * Link text for a citation.
 *
 * Curated catalog links carry no page title, so their `title` is the bare URL,
 * and a URL read aloud tells a screen-reader user nothing about where the link
 * goes (`validate_labs.py` rejects it under `accessible-markdown`). Name the page
 * after the last segment of its path instead.
 */
function citationLabel(source) {
  const title = String(source.title || "").trim();
  if (title && title !== source.url && !/^https?:\/\//i.test(title)) return scrubForbidden(title);

  let slug = "";
  try {
    const path = new URL(source.url).pathname.replace(/\/+$/, "");
    slug = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
  } catch {
    /* an unparseable URL still gets a readable label below */
  }
  const words = slug.replace(/\.[a-z]+$/i, "").replace(/[-_]+/g, " ").trim();
  return scrubForbidden(
    words ? `Microsoft Learn: ${words.charAt(0).toUpperCase()}${words.slice(1)}` : "Microsoft Learn page",
  );
}

function citationBlock(grounding) {
  if (!grounding?.sources?.length) return [];
  return [
    "",
    "**Microsoft Learn references**",
    "",
    bullets(grounding.sources.map((s) => `[${citationLabel(s)}](${s.url})`)),
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

/** Catalog text as Markdown link text: scrubbed, and unable to close the link early. */
function vendorLabel(source) {
  const title = scrubForbidden(String(source?.title || "").replace(/[[\]]/g, "").trim());
  return title || `${scrubForbidden(String(source?.vendor || "Vendor").replace(/[[\]]/g, ""))} documentation`;
}

/** A URL that cannot end a Markdown link target early. */
function markdownUrl(url) {
  return String(url).replace(/[()\s]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/**
 * Documentation from outside Microsoft Learn (issue #39).
 *
 * Deliberately a block of its own, never folded into the Microsoft Learn list:
 * a learner should always be able to tell Microsoft's documentation from a
 * vendor's. Each line names the vendor, links the page by its title, and
 * carries the catalog's stability note, plus a marker when the page was not
 * read during this build.
 *
 * The optional quote is attributed to the vendor, never to Microsoft Learn, and
 * goes through the same `condense()` + `scrubForbidden()` path as the Learn
 * pull quote. Its text is untrusted and was already reduced to inert prose by
 * `vendor-docs.js`.
 */
function vendorBlock(records) {
  const shown = (records || []).filter((record) => record.inLab !== false);
  if (!shown.length) return [];

  const lines = shown.map((record) => {
    const status =
      record.fetch?.status === "read"
        ? record.linkCheck?.verdict === "unverifiable"
          ? " *(read during this build; the site turned away the automated link check)*"
          : ""
        : record.fetch?.status === "skipped"
        ? " *(not read during this build)*"
        : " *(could not be read during this build, so it is unverified)*";
    return `**${scrubForbidden(record.vendor)}:** [${vendorLabel(record)}](${markdownUrl(record.url)}) — ${scrubForbidden(
      record.stability,
    )}${status}`;
  });

  const quoted = shown.find((record) => record.fetch?.status === "read" && record.excerpt);
  const quote = quoted ? scrubForbidden(condense(quoted.excerpt)) : "";

  return [
    "",
    "**Vendor documentation**",
    "",
    bullets(lines),
    ...(quote
      ? [
          "",
          `> **From the ${scrubForbidden(quoted.vendor)} documentation:** ${quote} — [${vendorLabel(quoted)}](${markdownUrl(quoted.url)})`,
        ]
      : []),
  ];
}

/**
 * The catalog's own freshness claim for a module, as a clause.
 *
 * Curated steps are a hand-checked snapshot: issue #42 requires every catalog
 * feature to record the day its steps were last compared against a named
 * documentation page. A learner following those steps is owed that date,
 * because it is the only thing that tells a month-old check from a two-year-old
 * one. The link text names the feature rather than repeating the URL, so it
 * stays meaningful when read out of context.
 */
function catalogVerification(feature) {
  const day = feature?.lastVerified;
  if (!day) return null;
  const url = feature.verifiedAgainst;
  const page = url ? `[the ${scrubForbidden(feature.name)} documentation](${url})` : "its documentation page";
  return `They were last verified by hand on ${day} against ${page}, not against the product as it is today.`;
}

/**
 * Where this module's steps came from, stated in the lab itself.
 *
 * A learner following a click list deserves to know whether it was read off the
 * current documentation or off a catalog that may have aged. Before issue #37
 * the lab's header claimed every module was "grounded on Microsoft Learn" while
 * the steps were always the catalog's — this line is what makes the claim honest
 * per module. Since issue #42 the catalog branch also says when those steps were
 * last checked, and against which page.
 */
function stepProvenance(record, feature) {
  if (record?.source === "llm-verified") {
    const heading = record.sectionHeading ? scrubForbidden(record.sectionHeading) : "the current documentation";
    const day = record.fetchedAt ? String(record.fetchedAt).slice(0, 10) : null;
    const link = record.url ? `[${heading}](${record.url})` : heading;
    const others = (record.sources || []).filter((url) => url !== record.url).length;
    const model = record.synthesis?.model || "a language model";
    return [
      "",
      `*Written by ${model} from ${link}${others ? ` and ${others} other documentation page${others === 1 ? "" : "s"}` : ""}` +
        `${day ? ` on ${day}` : ""}. Each step was kept only after a check against those pages: every bolded label is one ` +
        `the documentation bolds, and every step is tied to a word-for-word quote, recorded in \`manifest.json\`.*`,
    ];
  }

  if (!record || record.source !== "doc-derived") {
    if (feature?.learnTopic) {
      return [
        "",
        "*[Unverified] This topic is new on Microsoft Learn and is not in this repository's reviewed catalog, so it has no curated steps. " +
          "The text above comes from its Learn article summary, and no procedure could be read from the article during this build. " +
          "Follow the Microsoft Learn link in this module and trust it over anything written here.*",
      ];
    }
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
        `${catalogVerification(feature) || "They were accurate when written, but they are not verified against the current product."} ` +
        `If a click does not match what you see, trust the Microsoft Learn link in this module.*`,
    ];
  }

  const heading = record.sectionHeading ? scrubForbidden(record.sectionHeading) : "the current documentation";
  const day = record.fetchedAt ? String(record.fetchedAt).slice(0, 10) : null;
  const link = record.url ? `[${heading}](${record.url})` : heading;
  return ["", `*Read from ${link}${day ? ` on ${day}` : ""}.*`];
}

const TEACH = { scrub: scrubForbidden, esc: escapeMarkdown, lowerFirst, bullets, label: citationLabel };

/** A prerequisite recap: the lower-level topic a selected topic builds on, kept short and clearly labeled. */
function recapSection(feature, plan, grounding, stepsRecord, vendorRecords) {
  const source = stepsRecord?.steps?.length ? stepsRecord.steps : feature.steps;
  const steps = source.map((step, index) => `${index + 1}. ${scrubForbidden(step)}`);
  return [
    `### Step ${feature.order} - Recap: ${feature.name}`,
    "",
    `*Prerequisite recap from Level ${feature.level} · about ${feature.minutes} minutes. This is a refresher for a lower-level topic that the ${levelName(plan.level)} modules build on. Skip it if you already know it.*`,
    "",
    `**What you are doing.** ${scrubForbidden(feature.summary)}`,
    ...groundedInsight(grounding),
    "",
    "**Do this**",
    ...stepProvenance(stepsRecord, feature),
    "",
    steps.join("\n"),
    "",
    "**Check your work**",
    "",
    bullets(feature.validation.map((v) => `[ ] ${scrubForbidden(v)}`)),
    ...citationBlock(grounding),
    ...vendorBlock(vendorRecords),
  ].join("\n");
}

function featureSection(feature, plan, grounding, shots, enrichment, stepsRecord, vendorRecords, differenceLines = []) {
  if (feature.prerequisite) return recapSection(feature, plan, grounding, stepsRecord, vendorRecords);
  const profile = plan.profile;
  const applied =
    enrichment?.applied ||
    `Do this for **${escapeMarkdown(profile.agentName)}**: ${lowerFirst(feature.summary.replace(/\.$/, ""))}, using the ${profile.domain} content described in **The Scenario** above. Keep the wording consistent with the domain language for this lab (${profile.terms.slice(0, 3).join(", ")}) so answers sound like they came from your team.`;

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
    ...stepProvenance(stepsRecord, feature),
    "",
    steps.join("\n"),
    ...expectedResultBlock(feature, shots, TEACH),
    "",
    `**In your scenario.** ${scrubForbidden(applied)}`,
    ...sampleInputBlock(feature, plan, feature.order - 1, TEACH),
    ...screenshotBlock(shots),
    ...differenceLines,
    "",
    "**Check your work**",
    "",
    bullets(feature.validation.map((v) => `[ ] ${scrubForbidden(v)}`)),
    ...troubleshootingBlock(feature, TEACH),
    ...knowledgeCheckBlock(feature, plan, TEACH),
    ...citationBlock(grounding),
    ...vendorBlock(vendorRecords),
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

function nextStepsSection(plan, groundingByFeature) {
  const lines = ["## Where to Go Next", ""];

  if (plan.deferred.length) {
    lines.push(
      "These modules were taken out of this lab during the build. Add them to a follow-up run:",
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

  lines.push(...furtherLearningBlock(plan, groundingByFeature, TEACH));

  lines.push(
    "Extend the scenario itself by adding a second knowledge source, wiring a real system of record, or handing part of the work to a connected agent.",
  );

  return lines.join("\n");
}

function completeSection(plan) {
  return [
    "## Lab Complete",
    "",
    `You built **${escapeMarkdown(plan.profile.agentName)}** end to end: ${sentenceList(plan.features.filter((f) => !f.prerequisite).map((f) => f.name))}.`,
    "",
    `More importantly, you can now explain *why* each of those pieces exists, which is what makes the next agent faster to build than this one was.`,
  ].join("\n");
}

/**
 * The "Steps." paragraph when a model wrote some of them.
 *
 * The default builder's promise is that no model writes a step. Opting in to
 * synthesis breaks that promise for the modules it covers, so the lab has to
 * say which modules, and what check replaced the promise.
 */
function synthesizedStepsParagraph({ synthesized, derived, total, provider, dated }) {
  const plural = (n) => (n === 1 ? "" : "s");
  const model = provider && provider !== "none" ? provider : "a language model";
  const curated = total - synthesized - derived;
  return [
    `**Steps.** The click-by-click steps in ${synthesized} of ${total} module${plural(total)} were written by ${model} from that feature's current documentation at build time, and kept only because every step passed a mechanical check against the pages it was written from: each is tied to a word-for-word quote, each bolded label is one the documentation bolds, and each typed value uses only words from the scenario or the page.`,
    derived > 0 ? `${derived} more were read directly off the documentation page, with no model involved.` : "",
    curated > 0
      ? `The other ${curated} use this repository's curated steps, and each of those modules says why${dated ? " and when its steps were last verified by hand" : ""}.`
      : "",
    "Every module names which of these it used.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The "Narrative." paragraph. The wording is unchanged from before step
 * synthesis existed whenever no model wrote a step, so existing labs read the
 * same; it only changes to name the modules whose steps a model did write.
 */
function narrativeParagraph({ provider, grounded, synthesized, total, plural, generation }) {
  const drafted = provider && provider !== "none";
  const stepModel = generation.synthesisModel || provider;
  const steps =
    synthesized > 0
      ? `${drafted && stepModel === provider ? "The same model" : stepModel} wrote the steps in ${synthesized} of ${total} module${plural}, under the check described above; no model wrote the steps in the others.`
      : drafted
      ? "No language model wrote any of the steps."
      : "No language model writes the steps either way.";

  if (drafted) {
    return `**Narrative.** The overview and the per-module "In your scenario" passages were drafted with ${provider} on top of that grounded content. ${steps}`;
  }
  const why = generation.llmAvailable ? "The model-written narrative was not used for this build" : "No language model was configured";
  const source = grounded > 0 ? "this repository's curated feature catalog combined with the Microsoft Learn excerpts above" : "this repository's curated feature catalog";
  return `**Narrative.** ${why}, so the overview and the per-module "In your scenario" passages come from ${source}. ${steps}`;
}

/**
 * The "Vendor documentation." paragraph. Only present when a module cites a
 * page outside Microsoft Learn, and worded from what the build actually did:
 * read, failed, or deliberately skipped.
 */
function vendorParagraph(vendor, plan) {
  if (!vendor?.requested) return null;
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const inLab = vendor.inLab ?? vendor.requested;
  const removed = vendor.removedByLinkCheck || 0;
  const removedNote = removed
    ? ` ${plural(removed, "vendor link")} from the catalog ${removed === 1 ? "was" : "were"} left out, because the vendor's site reported ${
        removed === 1 ? "that page" : "those pages"
      } gone when the links were checked.`
    : "";

  if (!inLab) {
    return `**Vendor documentation.** The feature catalog lists documentation published outside Microsoft Learn for this lab, but none of it is cited.${removedNote}`;
  }

  const who = sentenceList((vendor.vendors || []).map((name) => scrubForbidden(name)));
  const lead = `**Vendor documentation.** ${plural(vendor.modules, "module")} also ${
    vendor.modules === 1 ? "cites" : "cite"
  } documentation published outside Microsoft Learn${who ? `, from ${who}` : ""}. Those links come from this repository's feature catalog, which records how stable each page is.`;

  if (!vendor.read && !vendor.failed) {
    return `${lead} They were not read for this build (${scrubForbidden(vendor.skippedBecause || "vendor reads were switched off")}), so each one is marked as unverified where it appears.${removedNote}`;
  }

  const day = (vendor.fetchedAt || "").slice(0, 10);
  return [
    lead,
    `The builder reads a vendor page only from a host on the catalog's allowlist, over HTTPS, re-checking every redirect against the same list.`,
    `${vendor.read} of ${plural(inLab, "vendor page")} cited here ${vendor.read === 1 ? "was" : "were"} read${day ? ` on ${day}` : ""}` +
      (vendor.failed ? `; ${vendor.failed} could not be read and ${vendor.failed === 1 ? "is" : "are"} marked as unverified where ${vendor.failed === 1 ? "it appears" : "they appear"}.` : ".") +
      removedNote,
    `Vendor pages are treated as untrusted: nothing from them is run, and a quoted line is stripped of markup and filtered the same way as a Microsoft Learn excerpt.`,
    `Where a vendor page and Microsoft Learn disagree about ${shortProducts(plan)} itself, follow Microsoft Learn.`,
  ].join(" ");
}

function howToUseSection(plan, generation) {
  const grounded = generation.groundedFeatures;
  const derived = generation.docDerivedFeatures ?? 0;
  const synthesized = generation.synthesizedFeatures ?? 0;
  const total = plan.features.length;
  const provider = generation.llmProvider;
  const plural = total === 1 ? "" : "s";
  // Every catalog feature carries a verification date once validateCatalog()
  // passes; this guards the wording for a plan built from anything else.
  const dated = plan.features.every((f) => f.lastVerified);
  const check = generation.linkCheck;
  const verifiedDay = (check?.verifiedAt || "").slice(0, 10);
  const generatedDay = (generation.generatedAt || "").slice(0, 10);

  let endpoint = generation.endpoint || "the Microsoft Learn MCP server";
  try {
    endpoint = new URL(generation.endpoint).host;
  } catch {
    /* keep whatever was supplied */
  }

  const lines = [
    "## How This Lab Was Built",
    "",
    `This lab was generated for your selections rather than written by hand. It draws on live Microsoft Learn documentation where it can and on this repository's curated ${shortProducts(plan)} feature catalog where it cannot, and the two age differently — so here is which is which.`,
    "",
    (grounded > 0
      ? `**Citations.** The Microsoft Learn references in ${grounded} of ${total} module${plural} were found by searching the Microsoft Learn MCP server at build time and then scored for relevance, so a page about a different Microsoft product is dropped rather than quoted under a ${shortProducts(plan)} heading.${
          grounded < total ? ` The other ${total - grounded} rely on this repository's curated documentation links instead.` : ""
        }`
      : `**Citations.** No module's references came from a live search on this build. Every link below is a curated documentation link from this repository's feature catalog.`) +
      " " +
      (check?.enabled && check?.verifiedAt
        ? `Every link this lab embeds was then requested once, on ${verifiedDay}, to confirm it still resolves: ${check.checked} checked, ${check.broken} removed for returning an error, ${check.unreachable} kept but unreachable from the machine that built this${
            check.unverifiable ? `, ${check.unverifiable} kept because a vendor site turned the automated check away` : ""
          }.`
        : `Link checking was switched off for this build, so no link below has been confirmed to resolve. Treat every reference as unverified.`),
    "",
    ...(vendorParagraph(generation.vendorDocs, plan) ? [vendorParagraph(generation.vendorDocs, plan), ""] : []),
    synthesized > 0
      ? synthesizedStepsParagraph({ synthesized, derived, total, provider: generation.synthesisModel || provider, dated })
      : derived === total
      ? `**Steps.** The click-by-click steps in every module were read from that feature's current documentation page at build time, not copied from a stored list. Each module names the page it came from and the date it was read.`
      : derived > 0
      ? `**Steps.** The click-by-click steps in ${derived} of ${total} module${plural} were read from that feature's current documentation page at build time. The other ${total - derived} use this repository's curated steps, because no procedure on the page matched the module closely enough to trust. Every module names which of the two it used; the ones read from a page also name that page and the date${
          dated ? ", and the curated ones name the date their steps were last verified by hand and the page they were checked against" : ""
        }.`
      : `**Steps.** No module's steps could be read from a live documentation page on this build, so every module uses this repository's curated steps. ${
          dated
            ? "Each one says so, and why, and names the date its steps were last verified by hand and the page they were checked against. None of them was checked against the product when this lab was built."
            : "Each one says so, and why. They were accurate when written, but they are not verified against the current product."
        }`,
    "",
    narrativeParagraph({ provider, grounded, synthesized, total, plural, generation }),
    "",
    // Issue #41's second half. Generated labs live outside `labs/`, are
    // git-ignored, and are therefore never seen by the monthly accuracy audit
    // that re-checks the hand-written labs. Rather than imply a recurring check
    // that does not exist, the lab states its own shelf life and points at the
    // action that actually fixes staleness: build it again, which costs a minute.
    `**This lab is a point-in-time artifact.** ${
      generation.learnConnected !== false
        ? `It was generated on ${generatedDay || "the date shown above"} and grounded against ${endpoint} as that documentation stood that day.`
        : `It was generated on ${generatedDay || "the date shown above"} from this repository's catalog as it stood that day, without reading Microsoft Learn.`
    } It is not part of the monthly accuracy audit that re-checks this repository's hand-written labs, and nothing will re-verify it in place. If you are reading this well after the date above, regenerate it rather than trusting it — the builder will pick up whatever Microsoft has changed since.`,
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
 * @param {Map<string, Array>} [vendorByFeature] featureId -> vendor source records
 */
export function composeLab(
  plan,
  groundingByFeature,
  shotsByFeature,
  enrichment = {},
  generation = {},
  stepsByFeature = new Map(),
  vendorByFeature = new Map(),
) {
  const differences = buildDifferenceBlocks({ ...plan, features: plan.features.filter((f) => !f.prerequisite) }, {
    harnesses: getHarnesses(),
    clean: (text) => escapeMarkdown(scrubForbidden(text)),
    concepts: getConcepts(),
  });
  const harnessLabel = getHarnesses().find((h) => h.id === plan.harness)?.name;
  const differencesNote = differences.byFeature.size
    ? [
        `This lab is written for the ${harnessLabel || "selected harness"}. Where the same idea works differently on another harness, an expandable **How this differs** note follows the steps: it explains the equivalent steps, terminology, availability, and limits, with sources. Open it only when you need it.`,
        "",
      ]
    : [];

  const sections = [
    `# ${escapeMarkdown(scrubForbidden(plan.title))}`,
    "",
    `*Build ${escapeMarkdown(plan.profile.agentName)} ${isCopilotStudioOnly(plan) ? "in Microsoft Copilot Studio" : `with ${productsPhrase(plan.products)}`}, one grounded module at a time.*`,
    "",
    metadataTable(plan, generation),
    "",
    "---",
    "",
    overviewSection(plan, enrichment),
    "",
    objectivesSection(plan),
    "",
    timeEstimateSection(plan),
    "",
    prerequisitesSection(plan),
    "",
    scenarioSection(plan),
    "",
    "## Step-by-Step",
    "",
    `Each module below stands on its own, but they are ordered so that every prerequisite is configured before you need it. Work top to bottom.${
      plan.features.some((f) => f.prerequisite) ? ` Steps labeled **Recap** are short refreshers of lower-level topics, not ${levelName(plan.level)} content.` : ""
    }`,
    "",
    ...differencesNote,
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
        vendorByFeature.get(feature.id),
        differences.byFeature.get(feature.id),
      ),
      "",
    );
  }

  sections.push(
    validationSection(plan),
    "",
    cleanupSection(plan, TEACH),
    "",
    glossarySection(plan, TEACH),
    "",
    nextStepsSection(plan, groundingByFeature),
    "",
    completeSection(plan),
    "",
    howToUseSection(plan, generation),
    "",
  );

  return sections.join("\n").replace(/\n{4,}/g, "\n\n\n").trimEnd() + "\n";
}

export { scrubForbidden, condense };
