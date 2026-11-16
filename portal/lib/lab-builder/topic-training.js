/**
 * Topic training content synthesizer for PowerPoint (.pptx) slide decks.
 *
 * Transforms each lab module from a thin click-by-click lab overview into a
 * substantive instructor- and learner-ready training module covering:
 *   1. Learning objectives & capability framing
 *   2. Core mental model, architecture & how the capability works (full catalog
 *      concepts + Microsoft Learn documentation takeaways)
 *   3. When to use it, design best practices, domain scenario application &
 *      cross-harness / edition surface comparisons
 *   4. Governance, licensing, DLP/ACP policies, environment settings, RBAC
 *      roles & production guardrails (derived from `admin-prereqs.js`)
 *   5. Configuration quick-reference tables & copy-ready prompts/payloads
 *   6. Common pitfalls & `Symptom -> Resolution` troubleshooting diagnostics
 *   7. Curated Microsoft Learn deep-dive takeaways & study review prompts
 *
 * Pure Node.js with zero external npm dependencies. Works both at generation
 * time (`buildModuleTrainingDigest` persisted on `manifest.modules[i]`) and
 * on demand (`resolveTopicTrainingDigest`) so legacy labs and standalone topic
 * renders receive full training content automatically.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildAdminPrerequisites } from "./admin-prereqs.js";
import { getCategories, getFeature, getFeatures, getHarnesses, LEVELS } from "./catalog.js";
import { getConceptForFeature } from "./concepts.js";
import { getDifference } from "./differences.js";
import {
  DEFAULT_PRODUCT,
  getProduct,
  productHasHarnesses,
  productName,
  productOf,
} from "./products.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEARN_SNAPSHOT_PATH = path.join(__dirname, "learn-topics.snapshot.json");

export const TRAINING_DIGEST_VERSION = 1;

const CAUTION_RE =
  /\b(?:can't|cannot|can not|must|requires?|required|only|unavailable|isn't|aren't|not available|don't|doesn't|won't|might not|may not|limits?|quotas?|blocked|never|preview)\b/i;

const BEST_PRACTICE_RE =
  /\b(?:recommend(?:ed)?|best practice|prefer|should|keep|clear|specific|start with|always|avoid|scope|design|separate|modular|concise|descriptive|structured|validate|test)\b/i;

const AVAILABILITY_TEXT = {
  supported: "Supported",
  ga: "Generally available (GA)",
  preview: "Preview — validate tenant & regional availability before production rollout",
  planned: "Planned",
  "not-supported": "Not supported",
  retired: "Retired",
  unknown: "Verify current support on Microsoft Learn",
};

const CATEGORY_LIFECYCLE = {
  foundations: [
    "1. Environment & Identity Scope — Select target environment, solution container, and maker permissions.",
    "2. Agent / Capability Definition — Author clear purpose, instructions, terminology, and boundaries.",
    "3. Orchestrator Assembly — Platform binds instructions, model settings, knowledge, and tools.",
    "4. Interactive Verification — Exercise representative prompts and confirm deterministic behavior.",
  ],
  knowledge: [
    "1. Source Registration — Bind SharePoint, Dataverse, files, websites, or enterprise connectors with descriptive routing hints.",
    "2. Query Selection & Retrieval — Orchestrator rewrites user intent and queries relevant knowledge sources at runtime.",
    "3. Security Trimming & Grounding — Source ACLs and user identity filter retrieved passages before synthesis.",
    "4. Cited Response Generation — Model grounds its answer strictly in retrieved chunks and emits inline citations.",
  ],
  tools: [
    "1. Tool Contract & Auth — Register connector, REST/OpenAPI, prompt tool, flow, or MCP server with explicit input/output schema and authentication.",
    "2. Intent & Slot Filling — Generative orchestrator matches user goal to tool description and collects required parameters.",
    "3. Policy & Execution — DLP data groups, endpoint rules, and user/maker credentials govern outbound execution.",
    "4. Structured Output Handling — Returned payload is formatted into grounded prose or Adaptive Cards.",
  ],
  "topics-flow": [
    "1. Trigger & Routing — Phrase triggers, events, or generative orchestration route conversation into a deterministic topic.",
    "2. Dialog & Variable State — Question nodes, entities, conditions, and Power Fx expressions manage turn-by-turn state.",
    "3. Action & Connector Calls — Topic invokes flows, connectors, or Adaptive Cards with typed variables.",
    "4. Resolution & Handoff — Conversation completes, branches, or escalates cleanly with preserved context.",
  ],
  subagents: [
    "1. Domain Decomposition — Partition responsibilities across specialist child, connected, or A2A agents.",
    "2. Routing Metadata — Clear descriptions and contracts tell the parent orchestrator when to delegate.",
    "3. Context & Identity Handoff — Parent passes scoped inputs while honoring environment and authentication boundaries.",
    "4. Synthesized Outcome — Subagent response returns to the parent conversation for unified user delivery.",
  ],
  autonomous: [
    "1. Event Trigger Binding — Configure schedule, Dataverse, mailbox, SharePoint, or connector event trigger.",
    "2. Maker / Agent Identity — Assign explicit run-as credentials, Entra Agent Identity, and least-privilege scopes.",
    "3. Unattended Reasoning Loop — Agent evaluates payload against instructions, invokes tools, and enforces guardrails.",
    "4. Audit & Exception Telemetry — Inspect run transcripts, tool calls, and retry/escalation paths.",
  ],
  analytics: [
    "1. Test Set & Criteria — Assemble representative prompts, multi-turn scenarios, and expected quality/safety rubrics.",
    "2. Automated Evaluation Run — Execute test cases against target agent/model build prior to promotion.",
    "3. Score & Regression Analysis — Inspect groundedness, completeness, latency, and failure transcripts.",
    "4. Iterative Tuning Gate — Refine instructions, knowledge descriptions, or tool schemas until quality thresholds pass.",
  ],
  governance: [
    "1. Inventory & Classification — Identify agents, connectors, sensitivity labels, and data exposure surfaces.",
    "2. Policy Authoring — Configure Power Platform DLP, Agent Control Plane (ACP), Managed Environments, and Purview controls.",
    "3. Identity & Access Enforcement — Enforce Entra SSO, Conditional Access, and least-privilege maker/admin RBAC.",
    "4. Continuous Monitoring — Review audit logs, oversharing reports, and lifecycle compliance.",
  ],
  channels: [
    "1. Pre-Publish Validation — Confirm authentication mode, DLP compliance, and test-pane readiness.",
    "2. Release Snapshot — Publish the agent so live channels receive the latest verified configuration.",
    "3. Channel Binding — Enable Teams, Microsoft 365 Copilot, web/Direct Line, SharePoint, or voice endpoints.",
    "4. End-User Access & Telemetry — Govern app distribution, security group scoping, and live session analytics.",
  ],
  advanced: [
    "1. Architecture & Packaging — Structure assets inside ALM solutions, source control, or enterprise network boundaries.",
    "2. Pro-Dev / Platform Integration — Wire VS Code authoring, SDKs, reasoning models, Computer Use, or VNet policies.",
    "3. Security & Capacity Controls — Validate RBAC, private connectivity, credit consumption, and rate limits.",
    "4. Production Readiness — Promote through dev/test/prod pipelines with automated validation.",
  ],
};

let cachedLearnSnapshot = null;

function loadLearnSnapshotTopics() {
  if (cachedLearnSnapshot) return cachedLearnSnapshot;
  try {
    if (fs.existsSync(LEARN_SNAPSHOT_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(LEARN_SNAPSHOT_PATH, "utf8"));
      cachedLearnSnapshot = Array.isArray(parsed?.topics) ? parsed.topics : [];
      return cachedLearnSnapshot;
    }
  } catch {
    /* optional snapshot enrichment */
  }
  cachedLearnSnapshot = [];
  return cachedLearnSnapshot;
}

function cleanWhitespace(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function normalizeTitleKey(text) {
  return cleanWhitespace(text)
    .toLowerCase()
    .replace(/^(?:prerequisite\s+)?(?:step|recap)\s+\d+\s*(?:—|–|-|:)\s*/i, "")
    .replace(/^recap:\s*/i, "")
    .replace(/\s*\(recap\)\s*$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function stripMarkdownPlain(text) {
  return cleanWhitespace(text)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#+\s+/gm, "");
}

function ensurePeriod(text) {
  const clean = cleanWhitespace(text);
  if (!clean) return "";
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
}

function canonicalLearnUrlKey(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    const pathname = parsed.pathname
      .replace(/^\/[a-z]{2}-[a-z]{2}(?=\/)/i, "")
      .replace(/\/+$/, "")
      .toLowerCase();
    return `${parsed.hostname.toLowerCase()}${pathname}`;
  } catch {
    return String(rawUrl || "").trim().toLowerCase();
  }
}

function cleanLearnExcerpt(rawExcerpt) {
  if (!rawExcerpt) return "";
  const cleaned = String(rawExcerpt)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length >= 25 &&
        !line.startsWith("|") &&
        !/^(?:in this article|applies to|table of contents|feedback|next steps|related content|prerequisites?):?$/i.test(
          line
        ) &&
        !/^https?:\/\//i.test(line)
    )
    .join(" ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#*_`>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  const sentences = cleaned.match(/[^.!?]+[.!?]+/g) || [cleaned];
  const out = [];
  let total = 0;
  for (const s of sentences) {
    const trimmed = s.trim();
    if (trimmed.length < 20) continue;
    if (total + trimmed.length > 440 && out.length > 0) break;
    out.push(trimmed);
    total += trimmed.length + 1;
    if (out.length >= 3) break;
  }
  return out.join(" ").trim();
}

function dedupeStrings(items, minLen = 8) {
  const seen = new Set();
  const out = [];
  for (const raw of items || []) {
    const text = cleanWhitespace(raw);
    if (!text || text.length < minLen) continue;
    const key = stripMarkdownPlain(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .slice(0, 140);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

/**
 * Resolve a catalog or learned topic feature from `featureId`, module metadata,
 * or topic title.
 */
export function resolveTopicFeature(hints = {}, parsedTopic = null) {
  const harness = hints.harness || null;
  const candidateId =
    hints.featureId ||
    hints.id ||
    hints.module?.id ||
    hints.trainingDigest?.featureId ||
    null;

  if (candidateId) {
    const direct = getFeature(candidateId, { harness }) || getFeature(candidateId);
    if (direct) return direct;
  }

  const rawTitle =
    hints.topicTitle ||
    hints.module?.name ||
    parsedTopic?.meta?.topicTitle ||
    "";
  const targetKey = normalizeTitleKey(rawTitle);
  if (!targetKey) return null;

  const features = getFeatures();
  const exact = features.find((f) => normalizeTitleKey(f.name) === targetKey);
  if (exact) return exact;

  // Partial title match when standalone Markdown customized or shortened the heading
  const partial = features.find((f) => {
    const fKey = normalizeTitleKey(f.name);
    return (
      fKey.length >= 8 &&
      targetKey.length >= 8 &&
      (targetKey.includes(fKey) || fKey.includes(targetKey))
    );
  });
  return partial || null;
}

function lookupSnapshotLearnNotes(feature, referenceUrls = []) {
  const snapshotTopics = loadLearnSnapshotTopics();
  if (!snapshotTopics.length) return [];

  const wantedUrlKeys = new Set(
    [
      ...(feature?.docUrls || []),
      ...(feature?.verifiedAgainst ? [feature.verifiedAgainst] : []),
      ...referenceUrls,
    ]
      .filter(Boolean)
      .map(canonicalLearnUrlKey)
  );

  const notes = [];
  for (const entry of snapshotTopics) {
    const matchesFeature =
      feature?.id &&
      Array.isArray(entry.featureIds) &&
      entry.featureIds.includes(feature.id);
    const matchesUrl =
      Array.isArray(entry.urls) &&
      entry.urls.some((u) => wantedUrlKeys.has(canonicalLearnUrlKey(u)));
    if (!matchesFeature && !matchesUrl) continue;

    const summary = cleanWhitespace(entry.summary || "").replace(/…$/, "").trim();
    if (!summary || summary.length < 32 || /:\s*$/.test(summary)) continue;
    const url = entry.urls?.[0] || "";
    const title = cleanWhitespace(entry.title || "Microsoft Learn");
    notes.push({
      title,
      url,
      summary: ensurePeriod(summary),
    });
  }
  return notes.slice(0, 4);
}

function buildCategoryArchitectureFlow(feature, productObj) {
  const cat = feature?.category || "";
  if (CATEGORY_LIFECYCLE[cat]) {
    return CATEGORY_LIFECYCLE[cat];
  }
  const prodId = productObj?.id || productOf(feature);
  if (prodId === "ai-foundry") {
    return [
      "1. Hub, Project & RBAC — Scope Azure subscription, Foundry project connections, and least-privilege developer roles.",
      "2. Model / Agent Configuration — Select deployment SKU, system instructions, structured schemas, and grounded indexes.",
      "3. Safety & Evaluation Gate — Run groundedness, quality, and risk/safety evaluations against representative datasets.",
      "4. Operational Deployment — Monitor TPM quota, tracing telemetry, and production endpoint governance.",
    ];
  }
  if (prodId === "sharepoint-ai") {
    return [
      "1. Site & Library Readiness — Organize authoritative SharePoint libraries, metadata columns, and permissions.",
      "2. Scoped Grounding / Policy — Configure SharePoint agent sources, starter prompts, or SAM governance rules.",
      "3. Security-Trimmed Access — Enforce signed-in Microsoft 365 user permissions and sensitivity labels at query time.",
      "4. Adoption & Lifecycle Review — Validate citations in SharePoint/Teams and monitor oversharing or staleness.",
    ];
  }
  if (prodId === "power-platform-ai-hub") {
    return [
      "1. Prompt & Variable Contract — Define clear instructions, dynamic input variables, and Dataverse grounding.",
      "2. Model & Output Format — Select model tier and enforce structured JSON or deterministic text output.",
      "3. Flow / App Integration — Bind the AI Builder prompt or model inside Power Automate or Power Apps.",
      "4. Credit & Accuracy Governance — Test representative records and monitor AI Builder capacity consumption.",
    ];
  }
  return CATEGORY_LIFECYCLE.foundations;
}

function buildSurfaceComparisons(feature, labHarness = null) {
  const notes = [];
  const rows = [];

  if (feature?.harnessNote) {
    notes.push(ensurePeriod(feature.harnessNote));
  }

  if (!feature?.id) return { notes, rows };
  const prodId = productOf(feature);
  if (!productHasHarnesses(prodId)) return { notes, rows };

  const concept = getConceptForFeature(feature.id);
  if (!concept) return { notes, rows };
  const diffRecord = getDifference(concept.id);
  if (!diffRecord?.harnesses) return { notes, rows };

  const harnesses = getHarnesses();
  for (const [hId, info] of Object.entries(diffRecord.harnesses)) {
    const hName = harnesses.find((h) => h.id === hId)?.name || hId;
    const avail = AVAILABILITY_TEXT[info.availability] || info.availability || "Supported";
    const where = info.where ? ` (${info.where})` : "";
    const limitText = Array.isArray(info.limits) && info.limits.length
      ? ` Key limit: ${ensurePeriod(info.limits[0])}`
      : "";
    rows.push([
      labHarness && hId === labHarness ? `${hName} (This Lab)` : hName,
      `${info.term || concept.name} — ${avail}`,
      `${ensurePeriod(info.summary || "")}${where ? ` Where: ${info.where}.` : ""}${limitText}`.trim(),
    ]);
  }

  if (diffRecord.uncertainNote) {
    notes.push(`Documentation note: ${ensurePeriod(diffRecord.uncertainNote)}`);
  }

  return {
    conceptTitle: diffRecord.title || concept.name,
    notes,
    rows,
  };
}

function buildTopicGovernance(feature, { harness = null, sharepointSite = null } = {}) {
  if (!feature) {
    return {
      availabilityBadge: "Verify tenant settings",
      availabilityGuidance:
        "Confirm environment permissions, connector DLP classifications, and channel policies in a non-production environment before rollout.",
      rows: [],
      guardrails: [],
    };
  }

  const prodId = productOf(feature);
  const availRaw = String(feature.availability || "ga").toLowerCase();
  const availabilityBadge =
    availRaw === "preview"
      ? "Preview Capability"
      : availRaw === "retired"
        ? "Retired / Legacy"
        : "Generally Available (GA)";
  const availabilityGuidance =
    availRaw === "preview"
      ? "Preview capabilities are subject to supplemental terms, regional rollout schedules, and admin opt-in toggles; validate thoroughly in a sandbox before enabling for business users."
      : "Supported for production deployments when environment DLP policies, licensing, and RBAC prerequisites below are satisfied.";

  let prereqs = null;
  try {
    prereqs = buildAdminPrerequisites({
      features: [{ ...feature, order: 1 }],
      products: [prodId],
      harness: harness || (Array.isArray(feature.harness) && feature.harness[0]) || null,
      sharepointSite: sharepointSite || undefined,
    });
  } catch {
    prereqs = null;
  }

  const rows = [];
  if (prereqs) {
    for (const c of prereqs.connectors || []) {
      const endpointHint =
        Array.isArray(c.endpoints) && c.endpoints.length
          ? ` Endpoints: ${c.endpoints.slice(0, 2).join(", ")}.`
          : "";
      rows.push([
        `Connector (${c.dataGroup || "Business"})`,
        c.name,
        `${ensurePeriod(c.details)}${endpointHint} Admin path: ${c.adminPath}.`,
      ]);
    }
    for (const d of prereqs.dlpAndAcp || []) {
      rows.push([
        `Governance (${d.status || "Required"})`,
        d.title,
        `${ensurePeriod(d.details)} Admin path: ${d.adminPath}.`,
      ]);
    }
    for (const e of prereqs.environmentSettings || []) {
      rows.push([
        `Environment (${e.status || "Required"})`,
        e.title,
        `${ensurePeriod(e.details)} Admin path: ${e.adminPath}.`,
      ]);
    }
    for (const t of prereqs.tenantAndCloud || []) {
      rows.push([
        `Tenant / RBAC (${t.status || "Required"})`,
        t.title,
        `${ensurePeriod(t.details)} Admin path: ${t.adminPath}.`,
      ]);
    }
  }

  const guardrails = [];
  if (availRaw === "preview") {
    guardrails.push(
      "**Preview readiness:** Confirm the preview feature toggle is enabled in your target region and environment before scheduling live workshops or production cutover."
    );
  }
  for (const c of feature.concepts || []) {
    if (CAUTION_RE.test(c)) {
      guardrails.push(ensurePeriod(c));
    }
  }
  if (feature.prereqs?.length) {
    const prereqNames = feature.prereqs
      .map((id) => getFeature(id)?.name || id)
      .filter(Boolean);
    if (prereqNames.length) {
      guardrails.push(
        `**Curriculum dependencies:** Complete or verify ${prereqNames.join(", ")} before configuring ${feature.name}.`
      );
    }
  }

  return {
    availabilityBadge,
    availabilityGuidance,
    rows: rows.slice(0, 8),
    guardrails: dedupeStrings(guardrails),
  };
}

function buildConfigReferenceRows(feature, parsedTopic, productLabel, agentName) {
  const rows = [];
  const targetAgent = agentName || parsedTopic?.meta?.agentName || "Target solution";
  const category = feature?.category || "";
  const catObj = getCategories().find((c) => c.id === category);

  rows.push([
    "Capability / Area",
    feature?.name || parsedTopic?.meta?.topicTitle || "Lab Topic",
    `${productLabel}${catObj?.name ? ` — ${catObj.name}` : ""}`,
  ]);

  rows.push([
    "Target Workload",
    targetAgent,
    ensurePeriod(
      feature?.summary ||
        parsedTopic?.whatYouAreDoing?.[0] ||
        `Configure and verify ${parsedTopic?.meta?.topicTitle || "this capability"}`
    ),
  ]);

  if (parsedTopic?.sharepointSite) {
    rows.push([
      "SharePoint Grounding Scope",
      stripMarkdownPlain(parsedTopic.sharepointSite),
      "Use an HTTPS SharePoint site or library URL without file-level query strings; signed-in user ACLs apply at runtime.",
    ]);
  }

  if (Array.isArray(feature?.prereqs) && feature.prereqs.length > 0) {
    const names = feature.prereqs.map((id) => getFeature(id)?.name || id).join(", ");
    rows.push([
      "Required Foundation",
      names,
      "Must be configured in the same target environment prior to testing this capability.",
    ]);
  }

  const validations = [
    ...(feature?.validation || []),
    ...(parsedTopic?.checkYourWork || []).map((item) => item.text),
  ].filter(Boolean);
  if (validations[0]) {
    rows.push([
      "Primary Readiness Check",
      "Expected runtime state",
      ensurePeriod(stripMarkdownPlain(validations[0])),
    ]);
  }
  if (validations[1]) {
    rows.push([
      "Secondary Verification",
      "Quality & behavior check",
      ensurePeriod(stripMarkdownPlain(validations[1])),
    ]);
  }

  return rows;
}

/**
 * Build a compact, JSON-serializable `trainingDigest` for `manifest.modules[i]`
 * during `generateLab`.
 */
export function buildModuleTrainingDigest({
  feature,
  plan,
  grounding,
  stepsRecord,
  vendorSources = [],
  appliedNarrative = "",
} = {}) {
  if (!feature) return null;

  const prodId = productOf(feature);
  const prodObj = getProduct(prodId);
  const prodLabel = productName(prodId);
  const concept = getConceptForFeature(feature.id);
  const levelObj = LEVELS.find((l) => Number(l.level) === Number(feature.level));
  const harness = plan?.harness || null;

  const learnTakeaways = [];
  for (const r of (grounding?.results || []).slice(0, 4)) {
    const excerpt = cleanLearnExcerpt(r.excerpt);
    if (!excerpt) continue;
    learnTakeaways.push({
      title: cleanWhitespace(r.title || "Microsoft Learn"),
      url: r.url || "",
      summary: excerpt,
    });
  }
  if (learnTakeaways.length < 3) {
    for (const snap of lookupSnapshotLearnNotes(feature, (grounding?.sources || []).map((s) => s.url))) {
      if (learnTakeaways.some((t) => canonicalLearnUrlKey(t.url) === canonicalLearnUrlKey(snap.url))) {
        continue;
      }
      learnTakeaways.push(snap);
      if (learnTakeaways.length >= 4) break;
    }
  }

  const vendorTakeaways = (vendorSources || [])
    .filter((v) => v?.inLab !== false && v?.excerpt)
    .slice(0, 2)
    .map((v) => ({
      title: `${v.vendor}: ${v.title}`,
      url: v.url || "",
      summary: cleanLearnExcerpt(v.excerpt) || ensurePeriod(v.excerpt),
    }));

  const governance = buildTopicGovernance(feature, {
    harness,
    sharepointSite: plan?.sharepointSite || null,
  });

  const surfaceComparisons = buildSurfaceComparisons(feature, harness);

  return {
    version: TRAINING_DIGEST_VERSION,
    featureId: feature.id,
    productId: prodId,
    productLabel: prodLabel,
    category: feature.category || null,
    level: feature.level || null,
    levelLabel: levelObj ? `Level ${levelObj.level} (${levelObj.label})` : null,
    availability: feature.availability || "ga",
    conceptName: concept?.name || null,
    conceptSummary: concept?.summary || null,
    summary: feature.summary || "",
    whyItMatters: feature.whyItMatters || "",
    appliedScenario: cleanWhitespace(appliedNarrative || ""),
    concepts: [...(feature.concepts || [])],
    expectedResults: [...(feature.expectedResults || [])],
    validation: [...(feature.validation || [])],
    troubleshooting: (feature.troubleshooting || []).map((t) => ({
      symptom: t.symptom,
      fix: t.fix,
    })),
    docHeadings: Array.isArray(stepsRecord?.pageHeadings)
      ? stepsRecord.pageHeadings.slice(0, 6)
      : [],
    learnTakeaways,
    vendorTakeaways,
    architectureFlow: buildCategoryArchitectureFlow(feature, prodObj),
    surfaceComparisons,
    governance,
  };
}

/**
 * Resolve and synthesize a complete topic training model for `pptx-builder.js`,
 * merging any persisted `trainingDigest`, catalog/concept/difference/admin
 * metadata, Learn snapshot takeaways, and parsed Markdown content.
 */
export function resolveTopicTrainingDigest(parsedTopic, hints = {}) {
  const persisted = hints.trainingDigest || hints.module?.trainingDigest || null;
  const feature = resolveTopicFeature(hints, parsedTopic);
  const harness =
    hints.harness ||
    hints.manifest?.request?.harness ||
    hints.manifest?.differences?.labHarness ||
    null;

  const prodId =
    persisted?.productId ||
    (feature ? productOf(feature) : null) ||
    hints.manifest?.product ||
    DEFAULT_PRODUCT;
  const prodObj = getProduct(prodId);
  const productLabel =
    parsedTopic?.meta?.products ||
    persisted?.productLabel ||
    (feature ? productName(prodId) : "Microsoft Copilot Studio");

  const concept = feature ? getConceptForFeature(feature.id) : null;
  const topicTitle = parsedTopic?.meta?.topicTitle || feature?.name || "Lab Topic";
  const agentName =
    parsedTopic?.meta?.agentName ||
    hints.agentName ||
    hints.manifest?.options?.agentName ||
    hints.manifest?.request?.agentName ||
    "your solution";

  const capabilitySummary = ensurePeriod(
    persisted?.summary ||
      feature?.summary ||
      parsedTopic?.whatYouAreDoing?.[0] ||
      `Configure and validate ${topicTitle} in ${productLabel}`
  );

  const whyItMatters = ensurePeriod(
    parsedTopic?.whyItMatters ||
      persisted?.whyItMatters ||
      feature?.whyItMatters ||
      concept?.summary ||
      `${topicTitle} provides a repeatable, governed capability for ${agentName}`
  );

  const conceptSummary =
    persisted?.conceptSummary ||
    concept?.summary ||
    (prodObj?.summary ? ensurePeriod(prodObj.summary) : "");
  const conceptName = persisted?.conceptName || concept?.name || "";

  // Partition conceptual bullets into Core Mechanics, Best Practices, and Cautions/Guardrails
  const rawConcepts = dedupeStrings([
    ...(persisted?.concepts || []),
    ...(feature?.concepts || []),
    ...(parsedTopic?.concepts || []),
    ...(parsedTopic?.otherBullets || []),
  ]);

  const coreConcepts = [];
  const bestPractices = [];
  const cautionConcepts = [];

  for (const item of rawConcepts) {
    if (CAUTION_RE.test(item) && !BEST_PRACTICE_RE.test(item)) {
      cautionConcepts.push(ensurePeriod(item));
      // Keep core architectural scoping statements in coreConcepts too when few core items exist
      if (coreConcepts.length < 2) coreConcepts.push(ensurePeriod(item));
    } else if (BEST_PRACTICE_RE.test(item)) {
      bestPractices.push(ensurePeriod(item));
    } else {
      coreConcepts.push(ensurePeriod(item));
    }
  }

  // Ensure every bucket has rich, topic-grounded training points
  if (conceptName && conceptSummary) {
    coreConcepts.unshift(`**${conceptName} architecture:** ${ensurePeriod(conceptSummary)}`);
  }
  if (coreConcepts.length === 0 && rawConcepts.length > 0) {
    coreConcepts.push(...rawConcepts.slice(0, 3).map(ensurePeriod));
  }

  // Microsoft Learn takeaways (persisted live grounding + parsed quote + snapshot)
  const refUrls = (parsedTopic?.references || []).map((r) => r.url).filter(Boolean);
  const learnTakeaways = [];
  const seenTakeawayKeys = new Set();
  const pushTakeaway = (entry) => {
    if (!entry?.summary) return;
    const key = stripMarkdownPlain(entry.summary).toLowerCase().slice(0, 120);
    if (!key || seenTakeawayKeys.has(key)) return;
    seenTakeawayKeys.add(key);
    learnTakeaways.push(entry);
  };

  if (parsedTopic?.fromTheDocs) {
    pushTakeaway({
      title: "Microsoft Learn Highlight",
      url: refUrls[0] || feature?.verifiedAgainst || "",
      summary: ensurePeriod(parsedTopic.fromTheDocs),
    });
  }
  for (const t of persisted?.learnTakeaways || []) pushTakeaway(t);
  for (const snap of lookupSnapshotLearnNotes(feature, refUrls)) pushTakeaway(snap);
  for (const vt of persisted?.vendorTakeaways || []) pushTakeaway(vt);

  // Best practices & when-to-use guidance
  const whenToUse = [];
  whenToUse.push(`**Primary purpose:** ${capabilitySummary}`);
  if (whyItMatters && stripMarkdownPlain(whyItMatters) !== stripMarkdownPlain(capabilitySummary)) {
    whenToUse.push(`**Architectural value:** ${whyItMatters}`);
  }
  if (bestPractices.length === 0) {
    if (feature?.category === "knowledge" || /knowledge|sharepoint|dataverse/i.test(topicTitle)) {
      bestPractices.push(
        "Write specific, non-overlapping source descriptions so the generative orchestrator selects the right knowledge source on the first turn.",
        "Keep source libraries curated and current; grounded responses inherit the accuracy and ACLs of the underlying documents."
      );
    } else if (feature?.category === "tools" || /connector|mcp|tool|flow|api/i.test(topicTitle)) {
      bestPractices.push(
        "Write action and parameter descriptions in business language so the orchestrator populates inputs accurately without extra clarifying turns.",
        "Test error responses, missing permissions, and boundary inputs before enabling actions in shared channels."
      );
    } else if (feature?.category === "governance" || /dlp|auth|governance|security|purview/i.test(topicTitle)) {
      bestPractices.push(
        "Validate DLP, authentication, and Managed Environment rules in a dedicated sandbox environment before applying tenant-wide enforcement.",
        "Pair preventive connector controls with ongoing audit and transcript review so policy exceptions are caught early."
      );
    } else {
      bestPractices.push(
        `Scope **${topicTitle}** clearly to the business domain and audience of **${stripMarkdownPlain(agentName)}** rather than leaving generic defaults.`,
        "Verify every configuration change in the interactive test pane with representative positive and out-of-scope prompts before publishing."
      );
    }
  }

  // Surface / harness comparisons
  const surfaceComparisons =
    persisted?.surfaceComparisons?.rows?.length || persisted?.surfaceComparisons?.notes?.length
      ? persisted.surfaceComparisons
      : buildSurfaceComparisons(feature, harness);
  const surfaceNotes = dedupeStrings([
    ...(surfaceComparisons?.notes || []),
    ...(parsedTopic?.differenceNotes || []),
  ]);

  // Governance, licensing, DLP & guardrails
  const governance =
    persisted?.governance?.rows?.length
      ? persisted.governance
      : buildTopicGovernance(feature, {
          harness,
          sharepointSite:
            hints.manifest?.sharepointSite ||
            (parsedTopic?.sharepointSite ? { label: parsedTopic.sharepointSite } : null),
        });

  const guardrails = dedupeStrings([
    ...(governance.guardrails || []),
    ...cautionConcepts,
  ]);

  // Learning objectives (3-4 crisp, measurable objectives for Slide 1)
  const verifyTarget =
    feature?.validation?.[0] ||
    parsedTopic?.checkYourWork?.[0]?.text ||
    parsedTopic?.expectedResults?.[0] ||
    `expected runtime behavior for ${topicTitle}`;
  const learningObjectives = [
    `Explain how **${topicTitle}** works in **${productLabel}** and why it matters for **${stripMarkdownPlain(agentName)}**.`,
    `Evaluate architectural best practices, ${
      surfaceComparisons?.rows?.length ? "cross-harness differences, " : ""
    }licensing/DLP prerequisites, and production guardrails.`,
    `Configure **${topicTitle}** step by step${
      parsedTopic?.codeSnippets?.length ? " using grounded prompts and structured inputs" : ""
    }.`,
    `Verify readiness (${stripMarkdownPlain(verifyTarget).replace(/[.]+$/, "")}) and diagnose common pitfalls.`,
  ];

  // Architecture flow
  const architectureFlow =
    persisted?.architectureFlow?.length
      ? persisted.architectureFlow
      : buildCategoryArchitectureFlow(feature, prodObj);

  // Configuration quick-reference rows (used when Markdown has no explicit reference table)
  const synthesizedConfigRows = buildConfigReferenceRows(
    feature,
    parsedTopic,
    productLabel,
    stripMarkdownPlain(agentName)
  );

  // Rich troubleshooting list (`Symptom -> Fix`)
  const authoredTrouble = [
    ...(persisted?.troubleshooting || []),
    ...(feature?.troubleshooting || []),
  ]
    .filter((t) => t?.symptom && t?.fix)
    .map((t) => `**${cleanWhitespace(t.symptom)}** — ${ensurePeriod(t.fix)}`);

  const troubleshootingItems = dedupeStrings([
    ...authoredTrouble,
    ...(parsedTopic?.troubleshooting || []),
    ...guardrails.slice(0, 2).map((g) =>
      /^\*\*/.test(g) ? g : `**Configuration guardrail:** ${g}`
    ),
  ]);

  // Check-your-work items (enrich from catalog validation if Markdown had none)
  const checkItems =
    parsedTopic?.checkYourWork?.length > 0
      ? parsedTopic.checkYourWork
      : (persisted?.validation || feature?.validation || []).map((v) => ({
          checked: false,
          text: v,
        }));

  // Expected results (enrich from catalog if Markdown had none)
  const expectedResults = dedupeStrings([
    ...(parsedTopic?.expectedResults || []),
    ...(persisted?.expectedResults || []),
    ...(feature?.expectedResults || []),
    ...(feature?.validation?.length ? [`Confirmed outcome: ${feature.validation[0]}`] : []),
  ]);

  return {
    featureId: feature?.id || persisted?.featureId || null,
    productLabel,
    availabilityBadge: governance.availabilityBadge,
    availabilityGuidance: governance.availabilityGuidance,
    conceptName,
    conceptSummary,
    capabilitySummary,
    whyItMatters,
    inYourScenario: cleanWhitespace(
      parsedTopic?.inYourScenario || persisted?.appliedScenario || ""
    ),
    learningObjectives,
    coreConcepts: dedupeStrings(coreConcepts),
    bestPractices: dedupeStrings(bestPractices),
    whenToUse: dedupeStrings(whenToUse),
    architectureFlow,
    learnTakeaways,
    docHeadings: persisted?.docHeadings || [],
    surfaceComparisons: {
      conceptTitle: surfaceComparisons?.conceptTitle || conceptName || topicTitle,
      notes: surfaceNotes,
      rows: surfaceComparisons?.rows || [],
    },
    governanceRows: governance.rows || [],
    guardrails,
    synthesizedConfigRows,
    troubleshootingItems,
    checkItems,
    expectedResults,
  };
}
