// Builds the feature-tour model from the lab builder catalog (features.json,
// the single source of truth) plus the curated overlay.json. Pure functions:
// no file or network access, so the output is deterministic and testable.

export const LEVELS = {
  100: { value: 100, label: "100 Beginner", short: "Beginner" },
  200: { value: 200, label: "200 Intermediate", short: "Intermediate" },
  300: { value: 300, label: "300 Advanced", short: "Advanced" },
};

export const HARNESS_ORDER = ["standard", "both", "microsoft-copilot", "customer-conversation"];

// Wording is deliberately independent of the catalog's harness descriptions,
// which mention the earlier product name. The site always uses the current one.
export const HARNESS_GROUPS = {
  standard: {
    id: "standard",
    name: "Standard harness",
    short: "Standard",
    description:
      "The classic Copilot Studio experience for rule-based agents and agent flows: topics, triggers, and explicit conversation paths.",
  },
  both: {
    id: "both",
    name: "Both harnesses",
    short: "Both",
    description:
      "Features that apply to the Standard harness and the Microsoft Copilot harness, such as choosing between them or upgrading.",
  },
  "microsoft-copilot": {
    id: "microsoft-copilot",
    name: "Microsoft Copilot harness",
    short: "Microsoft Copilot",
    description:
      "The Build-tab experience for reasoning-heavy agents and workflows: natural-language instructions, knowledge, tools, skills, memory, and hooks, billed in Copilot Credits.",
  },
  "customer-conversation": {
    id: "customer-conversation",
    name: "Customer Conversation harness",
    short: "Customer Conversation",
    description:
      "Preview. Agents that answer questions and resolve issues for customers over voice and chat, with specialized sub-agents and escalation to a human representative, billed in Copilot Credits.",
  },
};

export const AVAILABILITY = {
  preview: { id: "preview", label: "Preview", note: "Documented as a preview feature on Microsoft Learn. The UI and behavior might change." },
  ga: { id: "ga", label: "Generally available", note: "Documented as generally available on Microsoft Learn." },
  retired: { id: "retired", label: "Retired", note: "Documented as retired on Microsoft Learn." },
  unflagged: { id: "unflagged", label: "Not flagged", note: "The catalog does not record a preview or general availability label for this feature. Check the Learn page for its current status." },
};

// Sections for which the capture tool may jump straight to the agent page.
// Everything else is reached by following the setup steps.
export const NAV_SECTIONS = new Set(["topics", "settings", "agents", "evaluations"]);

export const SECTION_LABELS = {
  home: "Copilot Studio Home",
  agents: "Agents",
  overview: "Agent Overview page",
  topics: "Topics page",
  knowledge: "Knowledge",
  tools: "Tools",
  analytics: "Analytics page",
  settings: "Agent Settings",
  channels: "Channels",
  evaluations: "Evaluations page",
  evaluate: "Evaluate tab",
  monitor: "Monitor page",
  test: "Test your agent panel",
  admin: "Admin center",
  solutions: "Solutions",
  custom: "Custom location",
  build: "Build tab",
  preview: "Preview tab",
  deploy: "Deploy tab",
};

export function harnessGroup(harness) {
  const list = Array.isArray(harness) ? harness : [];
  const hasStd = list.includes("standard");
  const hasMc = list.includes("microsoft-copilot");
  const hasCc = list.includes("customer-conversation");
  if (hasStd && hasMc) return "both";
  if (hasMc) return "microsoft-copilot";
  if (hasCc && !hasStd) return "customer-conversation";
  return "standard";
}

export function availabilityOf(feature) {
  return AVAILABILITY[feature.availability] ? feature.availability : "unflagged";
}

// Terms the catalog wrote in **bold**: they name real UI elements in the
// Learn procedures, so they are the only labels we treat as UI evidence.
export function boldTerms(text) {
  const out = [];
  for (const match of String(text ?? "").matchAll(/\*\*([^*]+)\*\*/g)) {
    const term = match[1].trim();
    if (term && !out.includes(term)) out.push(term);
  }
  return out;
}

export function stripMarkdown(text) {
  return String(text ?? "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
}

function uiTerms(steps) {
  const terms = [];
  for (const step of steps) for (const term of boldTerms(step)) if (!terms.includes(term)) terms.push(term);
  return terms.slice(0, 6);
}

export function validateOverlay(overlay, catalog) {
  const errors = [];
  const ids = new Set(catalog.features.map((f) => f.id));
  for (const key of Object.keys(overlay.features ?? {})) {
    if (!ids.has(key)) errors.push(`overlay.features has unknown feature id: ${key}`);
  }
  for (const key of Object.keys(overlay.shots ?? {})) {
    if (!ids.has(key)) errors.push(`overlay.shots has unknown feature id: ${key}`);
  }
  return errors;
}

export function tourOrder(features, categories) {
  const catRank = new Map(categories.map((c, i) => [c.id, i]));
  return features
    .map((f, index) => ({ f, index }))
    .sort((a, b) => {
      const h = HARNESS_ORDER.indexOf(harnessGroup(a.f.harness)) - HARNESS_ORDER.indexOf(harnessGroup(b.f.harness));
      if (h) return h;
      const c = (catRank.get(a.f.category) ?? 99) - (catRank.get(b.f.category) ?? 99);
      if (c) return c;
      const l = a.f.level - b.f.level;
      if (l) return l;
      return a.index - b.index;
    })
    .map((x) => x.f);
}

export function buildModel(catalog, overlay = {}) {
  const problems = validateOverlay(overlay, catalog);
  if (problems.length) throw new Error(problems.join("\n"));

  const categories = catalog.categories.map((c) => ({ id: c.id, name: c.name, icon: c.icon, description: c.description }));
  const byId = new Map(catalog.features.map((f) => [f.id, f]));
  const ordered = tourOrder(catalog.features, categories);

  const features = ordered.map((f, i) => {
    const extra = overlay.features?.[f.id] ?? {};
    const availability = availabilityOf(f);
    const caveats = [];
    if (f.harnessNote) caveats.push(f.harnessNote);
    if (availability === "preview") caveats.push(AVAILABILITY.preview.note);
    for (const c of extra.caveats ?? []) caveats.push(c);
    for (const src of f.thirdPartySources ?? []) {
      caveats.push(`Part of this feature follows ${src.vendor} documentation outside Microsoft Learn. ${src.stability}`);
    }
    return {
      id: f.id,
      order: i + 1,
      name: f.name,
      category: f.category,
      harness: [...f.harness],
      harnessGroup: harnessGroup(f.harness),
      level: f.level,
      levelLabel: LEVELS[f.level]?.label ?? String(f.level),
      availability,
      minutes: f.minutes,
      summary: f.summary,
      whyItMatters: f.whyItMatters,
      concepts: [...(f.concepts ?? [])],
      steps: [...(f.steps ?? [])],
      uiPath: extra.uiPath ?? uiTerms(f.steps ?? []),
      prereqs: (f.prereqs ?? []).map((id) => ({ id, name: byId.get(id)?.name ?? id })),
      validation: [...(f.validation ?? [])],
      caveats,
      learn: (f.docUrls ?? []).map((url) => ({ url })),
      verifiedAgainst: f.verifiedAgainst,
      lastVerified: f.lastVerified,
      relatedLabs: [...(f.relatedLabs ?? [])],
    };
  });

  return {
    product: catalog.product,
    harnesses: HARNESS_ORDER.map((id) => HARNESS_GROUPS[id]),
    categories,
    levels: Object.values(LEVELS),
    availability: Object.values(AVAILABILITY),
    features,
  };
}
