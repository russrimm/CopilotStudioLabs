/**
 * The plan behind a lab's pre-lab training decks.
 *
 * Reads a lab's Markdown and manifest (nothing else, so it works for labs built before training decks
 * existed) and works out, for every module and prerequisite recap: which concept it teaches, what the
 * learner needs to know first, what Microsoft Learn and the catalog say about it, how long the training takes,
 * and whether it must be reviewed before it is presented. Foundations decks are planned per product.
 *
 * Pure: no I/O besides reading the bundled catalog and the training library. The deck builders turn a plan
 * into slides; the store (training-decks.js) turns those into files.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getFeature, getHarnesses } from "./catalog.js";
import { getConceptForFeature, getConcepts } from "./concepts.js";
import { getDifference } from "./differences.js";
import {
  SHARED_LATE_PART,
  SHARED_PART,
  combinedHarnessOrder,
  harnessShortName,
  harnessTitle,
  isCombinedHarnessMode,
  partLabel,
} from "./harness-parts.js";
import { isAdminAudienceTopic } from "./learner-guide.js";
import { DEFAULT_PRODUCT, getProduct, productName, productOf } from "./products.js";
import { capFilesystemSegment, formatModuleBaseName, sanitizeFilesystemTitle, splitGeneratedLabModules } from "./module-samples.js";
import { loadTrainingLibrary, TRAINING_LIBRARY_DIR } from "./training-library.js";
import { isConceptSentence } from "./training-guard.js";
import { endWithPeriod, firstSentence, fleschKincaid, lowerFirst, plainText, splitSentences, wholeSentences } from "./training-text.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS = JSON.parse(fs.readFileSync(path.join(__dirname, "scenario-profiles.json"), "utf8"));

/**
 * Bump whenever the training deck content or layout changes, so cached `training/` files rebuild on demand.
 * 1: first release (storyline, foundations decks, complete deck).
 * 2: the title, eyebrow, and subtitle are laid out from one measured vertical budget (pptx-text-fit.js): a long title
 *    steps down, then is shortened, and can no longer run into the eyebrow or the body.
 */
export const TRAINING_SCHEMA_VERSION = 2;

/**
 * Version of the combined-harness deck layout. It is part of the fingerprint of a lab that covers two harnesses only,
 * so changing how those decks are built rebuilds them and leaves every single-harness lab's saved decks as they are.
 * 1: first release (parts, sections, one deck set that teaches each idea once).
 */
export const TRAINING_COMBINED_VERSION = 1;

/** Minutes of training: a full topic deck, a prerequisite refresher, a short deck for a topic only Learn describes, and foundations. */
export const TRAINING_MINUTES = Object.freeze({ topic: 25, refresher: 20, short: 12, foundations: 12, foundationsShort: 8, covered: 12 });


export const TRAINING_FOLDER = "training";
export const TRAINING_ZIP_FOLDER = "1 - Training decks (deliver first)";
export const TRAINING_DECK_PREFIX = "Training deck";

const FILE_CAP = 46;

const CLASSIC_RE = /\bclassic\b/i;

let libraryHash = null;

/** A short hash of the training library files, so a content edit makes cached decks stale. */
export function trainingLibraryHash() {
  if (libraryHash) return libraryHash;
  const hash = crypto.createHash("sha1");
  const files = fs.existsSync(TRAINING_LIBRARY_DIR) ? fs.readdirSync(TRAINING_LIBRARY_DIR).filter((n) => n.endsWith(".json")).sort() : [];
  for (const name of files) {
    hash.update(name);
    hash.update(fs.readFileSync(path.join(TRAINING_LIBRARY_DIR, name)));
  }
  libraryHash = hash.digest("hex").slice(0, 12);
  return libraryHash;
}

export function resetTrainingPlanCaches() {
  libraryHash = null;
}

/** The scenario profile (industry story) for a lab, with the lab's own agent name when it has one. */
export function resolveScenario(manifest = {}) {
  const industryId = manifest?.industry || manifest?.request?.industry || "default";
  const base = SCENARIOS?.industries?.[industryId] || {};
  const customName = manifest?.options?.agentName || manifest?.request?.agentName;
  return {
    industryId,
    agentName: String(customName || base.agentName || "the team assistant").trim(),
    domain: base.domain || "everyday team operations",
    audience: base.audience || "the team that owns the process",
    problem: base.problem || "People answer the same questions again and again from documents and systems that live in different places.",
    outcome: base.outcome || "",
    sampleQuestions: Array.isArray(base.sampleQuestions) && base.sampleQuestions.length ? base.sampleQuestions : ["What is our policy on this?"],
  };
}

/** Facts the lab's own module text carries: what the learner does, why it matters, the sample prompt, the expected result. */
export function parseModuleFacts(markdown) {
  const text = String(markdown || "");
  const grab = (label) => {
    const m = text.match(new RegExp(`\\*\\*${label}\\.?\\*\\*\\s*([^\\n]+)`, "i"));
    return m ? plainText(m[1]) : "";
  };
  const sample = text.match(/\*\*Sample prompt\.?\*\*[^\n"“]*["“]([^"”\n]+)["”]/i);
  const expected = text.match(/Expected outcome:\s*([^\n]+)/i);
  return {
    whatYouAreDoing: grab("What you are doing"),
    whyItMatters: grab("Why it matters"),
    samplePrompt: sample ? sample[1].trim() : "",
    expectedOutcome: expected ? plainText(expected[1]) : "",
  };
}

/** Turn a lab goal such as "Add a connector action..." into "You will add a connector action...". */
export function toYouWill(sentence) {
  const text = endWithPeriod(plainText(sentence));
  if (!text) return "";
  if (/^you\b/i.test(text)) return text;
  if (/^[A-Z][a-z]+\b/.test(text)) return `You will ${lowerFirst(text)}`;
  return text;
}

const IMPERATIVE_START = /^(?:Add|Create|Write|Configure|Connect|Confirm|Turn|Use|Choose|Publish|Test|Review|Build|Set|Define|Ground|Enable|Make|Assign|Open|Explore|Check|Compare|Run|Deploy|Understand|Learn|Identify|Describe|Manage|Give|Let|Control|Decide|Pick|Keep|Track|Measure|Monitor|Protect|Share|Customize|Import|Export|Move|Find|Apply|Restrict|Limit|Allow|Block|Automate|Call|Extend|Train|Prepare|Organize|Select|Start|Send|Read|Reuse|Update|Upgrade|Switch|Tune|Trace|Audit|Secure)\b/;

/**
 * "SharePoint knowledge" + "Ground the agent in SharePoint sites..." becomes
 * "SharePoint knowledge lets you ground the agent in SharePoint sites...". A summary that already
 * reads as a statement is kept.
 */
export function describeFeature(name, summary) {
  const clean = endWithPeriod(plainText(summary));
  if (!clean) return "";
  if (IMPERATIVE_START.test(clean)) return `With ${name}, you can ${lowerFirst(clean)}`;
  return clean;
}

/** A curated "when to use it" note as a statement: "You ..." becomes "It helps when you ...", a task becomes "With X, you can ...". */
export function helpLine(name, note) {
  const clean = endWithPeriod(plainText(note));
  if (!clean) return "";
  if (/^you\b/i.test(clean)) return `It helps when ${lowerFirst(clean)}`;
  if (IMPERATIVE_START.test(clean)) return `With ${name}, you can ${lowerFirst(clean)}`;
  return clean;
}

/** Short topic name for slide titles: whole words, at most `max` characters. `tidy` (combined labs only) also backs up past a joining word. */
export function shortName(name, max = 38, { tidy = false } = {}) {
  const clean = String(name || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(" ");
  const trimmed = cut.slice(0, space > 16 ? space : max);
  // A name cut off after "or" or "and" reads as a broken sentence. Single-harness labs keep their existing titles.
  return (tidy ? trimmed.replace(/\s+(?:or|and|of|to|the|a|an|for|in|on|with)$/i, "") : trimmed).replace(/[,:;&-]+$/, "").trim();
}

/** Resolve the concept id a module teaches: the catalog's own mapping first, then the saved digest, then the category. */
function resolveConceptId(feature, meta) {
  const direct = feature?.id ? getConceptForFeature(feature.id) : null;
  if (direct) return direct.id;
  if (feature?.concept) return feature.concept;
  const wanted = String(meta?.trainingDigest?.conceptName || "").toLowerCase();
  if (wanted) {
    const match = getConcepts().find((c) => c.name.toLowerCase() === wanted);
    if (match) return match.id;
  }
  return null;
}

const LIMIT_RE = /\b(?:limits?|up to|at most|maximum|can't|cannot|can not|must|requires?|not supported|isn't|aren't|doesn't|don't|only)\b/i;

/** Sentences from catalog concept text that name a limit or a requirement and read as facts, not instructions. */
function limitSentences(feature, extra = []) {
  const out = [];
  const pool = [...extra, ...(feature?.concepts || [])];
  for (const raw of pool) {
    for (const sentence of splitSentences(raw)) {
      if (!LIMIT_RE.test(sentence) || !isConceptSentence(sentence)) continue;
      const words = sentence.split(/\s+/).length;
      if (words > 30 || fleschKincaid(sentence).grade > 13) continue;
      if (!out.includes(sentence)) out.push(sentence);
    }
  }
  return out;
}

/** What the catalog and the lab say about availability, in words a presenter can use. */
export function availabilityFacts(feature, conceptId, harness) {
  const harnessName = getHarnesses().find((h) => h.id === harness)?.name || null;
  const stage = String(feature?.availability || "").toLowerCase();
  if (stage === "preview") return { confirmed: true, stage, text: "Preview. Microsoft Learn labels this as a preview, so it can change before it is generally available." };
  if (stage === "retired") return { confirmed: true, stage, text: "Retired. Microsoft Learn says this has been retired, so do not plan new work around it." };
  if (stage === "ga") return { confirmed: true, stage, text: "Generally available, according to Microsoft Learn." };
  const diff = conceptId && harness ? getDifference(conceptId)?.harnesses?.[harness] : null;
  if (diff && diff.availability && diff.availability !== "unknown") {
    const where = harnessName || "this harness";
    const map = {
      supported: `Supported on the ${where}, according to Microsoft Learn.`,
      preview: `Preview on the ${where}. Microsoft Learn labels it as a preview, so it can change.`,
      planned: `Planned for the ${where}, but not available yet, according to Microsoft Learn.`,
      "not-supported": `Not supported on the ${where}, according to Microsoft Learn.`,
    };
    if (map[diff.availability]) return { confirmed: true, stage: diff.availability, text: map[diff.availability] };
  }
  return { confirmed: false, stage: "unknown", text: "Not confirmed in Microsoft Learn for this topic: whether it is preview or generally available." };
}

/** The topics a module builds on, by catalog prerequisites, in the order the lab teaches them. */
function buildsOn(feature, allTopics, self) {
  const wanted = new Set(feature?.prereqs || []);
  const fromLab = allTopics.filter((t) => t !== self && (wanted.has(t.id) || (t.isRecap && t.order < self.order)));
  const names = [];
  for (const t of fromLab) if (!names.includes(t.title)) names.push(t.title);
  for (const id of feature?.prereqs || []) {
    const name = getFeature(id)?.name;
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** True when a brief has every field a topic deck draws on. An override that is not complete cannot stand in for a concept brief. */
export function isCompleteBrief(brief) {
  return Boolean(
    brief?.definition &&
      Array.isArray(brief.blocks) && brief.blocks.length >= 3 &&
      Array.isArray(brief.flow) && brief.flow.length >= 4 &&
      brief.example?.input && brief.example?.output &&
      Array.isArray(brief.whenToUse) && brief.whenToUse.length >= 2 &&
      Array.isArray(brief.whenNot) && brief.whenNot.length >= 2 &&
      Array.isArray(brief.quiz) && brief.quiz.length >= 3,
  );
}

/**
 * The teaching brief for a topic: its concept's brief with the feature's own override laid over it. A concept brief
 * lists the products it is true for (`appliesTo`); for another product's feature it is not used, and only a complete
 * override of that feature can stand in. No brief at all means a short deck built from the catalog and Learn alone.
 */
export function briefFor(topic, library) {
  if (!topic?.conceptId && !topic?.id) return null;
  const base = topic.conceptId ? library.concepts[topic.conceptId] : null;
  const override = (topic.id && library.featureOverrides[topic.id]) || null;
  const applies = base && (!Array.isArray(base.appliesTo) || !topic.productId || base.appliesTo.includes(topic.productId));
  if (base && applies) {
    if (!override) return { ...base, conceptId: topic.conceptId };
    const merged = { ...base, ...override, conceptId: topic.conceptId };
    // An override that redefines the topic must not keep the concept's picture of it (its comparison to something familiar).
    if (override.definition && !override.analogy) delete merged.analogy;
    return merged;
  }
  if (override && isCompleteBrief(override)) return { ...override, conceptId: topic.conceptId || null };
  return null;
}

function conceptAppliesTo(conceptId, productId, library) {
  const base = library.concepts[conceptId];
  return Boolean(base) && (!Array.isArray(base.appliesTo) || !productId || base.appliesTo.includes(productId));
}

/** Concept ids this topic builds on, nearest first: catalog prerequisites, then the lab's refreshers, then the first-steps concept. */
function prerequisiteConcepts(feature, topic, topics, library) {
  const ids = [];
  const add = (id, productId) => {
    if (id && id !== topic.conceptId && !ids.includes(id) && conceptAppliesTo(id, productId || topic.productId, library)) ids.push(id);
  };
  for (const prereqId of feature?.prereqs || []) {
    const prereq = getFeature(prereqId);
    add(getConceptForFeature(prereqId)?.id, prereq ? productOf(prereq) : null);
  }
  for (const other of topics) if (other !== topic && other.isRecap && other.order < topic.order) add(other.conceptId, other.productId);
  if (Number(topic.level) >= 200 && !ids.length) add("create-agent", topic.productId);
  return ids.slice(0, 3);
}

/** How many minutes the training for one lab module takes. */
export function trainingMinutesFor({ isRecap = false, unreviewed = false } = {}) {
  if (unreviewed) return TRAINING_MINUTES.short;
  return isRecap ? TRAINING_MINUTES.refresher : TRAINING_MINUTES.topic;
}

/** Minutes for a product's foundations deck. A product the library cannot support well gets a shorter one. */
export function foundationsMinutes(productId, library = loadTrainingLibrary()) {
  return library.products[productId]?.thin ? TRAINING_MINUTES.foundationsShort : TRAINING_MINUTES.foundations;
}

/** "25 minutes", "1 hour", "1 hour 15 minutes": the same wording the lab uses for its hands-on time. */
export function formatTrainingDuration(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  if (total < 60) return `${total} minutes`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  const hourLabel = `${hours} hour${hours === 1 ? "" : "s"}`;
  return rest ? `${hourLabel} ${rest} minutes` : hourLabel;
}

/**
 * In a lab that covers two harnesses every idea is taught once. A topic whose concept an earlier topic already taught
 * needs only a short deck (it points back to the earlier one and says what is different). `items` are in lab order;
 * the result gives, for each, the index of the earlier topic it builds on (or null) and its training minutes.
 */
export function coverConceptMinutes(items) {
  const first = new Map();
  return items.map((item, index) => {
    const prior = item.conceptId && first.has(item.conceptId) ? first.get(item.conceptId) : null;
    if (item.hasBrief && item.conceptId && prior === null && !first.has(item.conceptId)) first.set(item.conceptId, index);
    return { prior, minutes: prior === null ? item.minutes : Math.min(item.minutes, TRAINING_MINUTES.covered) };
  });
}

/**
 * Training minutes for a planned lab (the composer calls this before any deck exists): every module and refresher
 * plus one foundations deck per product. A lab that covers two harnesses counts each idea once, so the number equals
 * the combined deck's total (its title, agenda, and closing slides take no time of their own).
 */
export function estimateLabTrainingMinutes(plan) {
  const library = loadTrainingLibrary();
  const features = Array.isArray(plan?.features) ? plan.features : [];
  const items = features.map((f) => {
    const productId = productOf(f) || DEFAULT_PRODUCT;
    const conceptId = resolveConceptId(f, {});
    const brief = briefFor({ id: f.id, conceptId, productId }, library);
    const unreviewed = Boolean(f.learnTopic) || !f.lastVerified;
    return { conceptId, hasBrief: Boolean(brief), minutes: trainingMinutesFor({ isRecap: Boolean(f.prerequisite), unreviewed: unreviewed || !brief }) };
  });
  const combined = Boolean(plan?.harnessParts);
  const modules = (combined ? coverConceptMinutes(items).map((c) => c.minutes) : items.map((i) => i.minutes)).reduce((sum, m) => sum + m, 0);
  const ids = Array.isArray(plan?.products) && plan.products.length ? plan.products : [DEFAULT_PRODUCT];
  const productIds = ids.filter((id) => features.some((f) => (productOf(f) || DEFAULT_PRODUCT) === id) || ids.length === 1);
  const foundations = productIds.reduce((sum, id) => sum + foundationsMinutes(id, library), 0);
  return { modules, foundations, total: modules + foundations };
}

function gatherTopic(mod, meta, ctx) {
  const id = meta.id || mod.id || null;
  // A lab that covers two harnesses reads each topic against its own harness; a shared topic reads against the first.
  const harness = ctx.combined ? meta.harness || ctx.order[0] : ctx.harness;
  const feature = (id && (getFeature(id, { harness }) || getFeature(id))) || null;
  const digest = meta.trainingDigest || null;
  const stored = meta.training || null;
  const facts = parseModuleFacts(mod.markdown);
  const conceptId = resolveConceptId(feature, meta);
  const concept = conceptId ? getConcepts().find((c) => c.id === conceptId) : null;
  const library = ctx.library;
  const productId = meta.product || (feature ? productOf(feature) : null) || ctx.productIds[0] || DEFAULT_PRODUCT;

  const learnTopic = Boolean(feature?.learnTopic) || (Array.isArray(meta.subtopics) && meta.subtopics.length > 0);
  const unreviewed = Boolean(stored?.unreviewed) || learnTopic || !feature || (!feature.lastVerified && !meta.catalog?.lastVerified);
  const isRecap = Boolean(mod.isRecap);

  const summary = plainText(feature?.summary || digest?.summary || facts.whatYouAreDoing || "");
  const whyItMatters = plainText(facts.whyItMatters || feature?.whyItMatters || digest?.whyItMatters || "");
  // Kept as the catalog wrote them (with any **interface label**), so the slide check can refuse a sentence that names one.
  const concepts = [...(feature?.concepts || []), ...(digest?.concepts || [])].map((c) => String(c));
  const validation = [...(feature?.validation || []), ...(digest?.validation || [])].map((v) => String(v));

  const learnTakeaways = [...(stored?.learnTakeaways || []), ...(digest?.learnTakeaways || [])].filter((t) => t?.summary && t?.url);
  const cautions = (stored?.cautions || []).map(plainText).filter(Boolean);
  const docUrls = [...new Set([meta.steps?.url, ...(feature?.docUrls || []), ...learnTakeaways.map((t) => t.url), meta.catalog?.verifiedAgainst].filter((u) => typeof u === "string" && /^https:\/\/learn\.microsoft\.com\//i.test(u)))];

  const availability = availabilityFacts(feature || digest || {}, conceptId, harness);
  const limits = limitSentences(feature || {}, cautions).slice(0, 2);

  const notes = [];
  if (unreviewed) notes.push("This topic comes from Microsoft Learn and has not been reviewed by hand. Review the deck against the Learn page before you present it.");
  if (isAdminAudienceTopic(feature || { id })) notes.push("This topic is for administrators. The deck explains what it is and why it matters; the settings themselves are in the Administrator setup guide, which is separate.");
  if (CLASSIC_RE.test(`${feature?.name || ""} ${summary} ${concepts.join(" ")}`)) notes.push("This topic touches classic behavior. Check the Learn page to confirm it applies to the harness you are teaching before you answer questions about it.");
  const brief = briefFor({ id, conceptId, productId }, library);
  if (!conceptId) notes.push("No teaching brief exists for the idea behind this topic, so the deck is short. Review it before you present.");
  else if (!brief) notes.push("The teaching brief for this idea is written for another product, so this deck is short and built only from the catalog and Microsoft Learn. Review it before you present.");

  const minutes = trainingMinutesFor({ isRecap, unreviewed: unreviewed || !brief });

  return {
    order: mod.order,
    stepLabel: mod.stepLabel,
    isRecap,
    id,
    title: mod.title,
    short: shortName(mod.title, 38, { tidy: ctx.combined }),
    level: meta.level ?? feature?.level ?? null,
    productId,
    handsOnMinutes: Number(meta.minutes) || Number(feature?.minutes) || null,
    conceptId: conceptId || null,
    conceptName: concept?.name || digest?.conceptName || "",
    category: feature?.category || digest?.category || null,
    summary,
    whyItMatters,
    concepts,
    validation,
    facts,
    availability,
    limits,
    cautions,
    learnTakeaways: learnTakeaways.slice(0, 3).map((t) => ({ title: plainText(t.title), url: t.url, summary: plainText(t.summary) })),
    docUrls,
    unreviewed,
    thin: unreviewed || !brief,
    presenterNotes: notes,
    minutes,
    prereqNames: [],
    prereqConceptIds: [],
    featureLabel: mod.stepLabel,
    fileBaseName: `${TRAINING_DECK_PREFIX} - ${formatModuleBaseName(mod.order, mod.isRecap ? `Recap - ${mod.title}` : mod.title)}`,
    feature,
    // A lab that covers two harnesses: which part this topic sits in and which harness it is written for (null when shared).
    ...(ctx.combined
      ? { harnessPart: meta.harnessPart || null, harness: meta.harness ?? null, harnessScope: meta.harnessScope || null, hasBrief: Boolean(brief), baseMinutes: minutes }
      : {}),
  };
}

function foundationsFileBase(productId) {
  const short = getProduct(productId)?.shortName || productName(productId) || productId;
  return `${TRAINING_DECK_PREFIX} - 00 Foundations - ${capFilesystemSegment(sanitizeFilesystemTitle(short, "Product"), FILE_CAP, "Product")}`;
}

/**
 * The parts of a lab that covers two harnesses, as the training sees them. Every topic is marked with the earlier topic
 * that already taught its idea (`coveredEarlier`), and its minutes drop to a short deck when one did, so each idea is
 * taught once and the minutes equal the slides of the combined deck. Mutates `topics`.
 */
function planCombinedParts(topics, order) {
  const covered = coverConceptMinutes(topics.map((t) => ({ conceptId: t.conceptId, hasBrief: t.hasBrief, minutes: t.baseMinutes })));
  topics.forEach((topic, index) => {
    const prior = covered[index].prior === null ? null : topics[covered[index].prior];
    topic.minutes = covered[index].minutes;
    topic.coveredEarlier = prior
      ? { order: prior.order, title: prior.title, short: prior.short, harness: prior.harness, part: prior.harnessPart, stepLabel: prior.stepLabel, conceptId: topic.conceptId }
      : null;
  });
  const parts = [];
  for (const topic of topics) {
    const id = topic.harnessPart || (topic.harness ? topic.harness : SHARED_PART);
    let part = parts.find((p) => p.id === id);
    if (!part) {
      part = { id, label: partLabel(id), harness: id === SHARED_PART || id === SHARED_LATE_PART ? null : id, topicOrders: [], minutes: 0, handsOnMinutes: 0 };
      parts.push(part);
    }
    part.topicOrders.push(topic.order);
    part.minutes += topic.minutes;
    part.handsOnMinutes += topic.handsOnMinutes || 0;
  }
  parts.forEach((part, i) => {
    part.n = i + 1;
  });
  return { order: [...order], parts };
}

/**
 * Plan every training deck for a lab.
 * @param {{markdown: string, manifest?: object, labId?: string, outputDir?: string, library?: object}} input
 */
export function buildTrainingPlan({ markdown, manifest = {}, labId = "", outputDir = "", library = loadTrainingLibrary() } = {}) {
  const split = splitGeneratedLabModules(markdown, manifest, { labId, outputDir });
  const combinedOrder = isCombinedHarnessMode(manifest) ? combinedHarnessOrder(manifest) : [];
  const isCombined = combinedOrder.length === 2;
  const harness = isCombined ? null : manifest?.request?.harness || manifest?.differences?.labHarness || null;
  const manifestModules = Array.isArray(manifest?.modules) ? manifest.modules : [];
  const declared = Array.isArray(manifest?.products) && manifest.products.length ? manifest.products : [manifest?.product || DEFAULT_PRODUCT];
  const ctx = { harness, library, productIds: declared, combined: isCombined, order: combinedOrder };

  const topics = split.modules.map((mod, idx) => {
    const meta = manifestModules.find((m) => Number(m.order) === Number(mod.order)) || manifestModules[idx] || {};
    return gatherTopic(mod, meta, ctx);
  });
  for (const topic of topics) {
    topic.prereqNames = buildsOn(topic.feature, topics, topic);
    topic.prereqConceptIds = prerequisiteConcepts(topic.feature, topic, topics, library);
  }
  const combined = isCombined ? planCombinedParts(topics, combinedOrder) : null;

  // Foundations for every product that has a topic, in the lab's product order; one product still gets its deck.
  const used = [...new Set(topics.map((t) => t.productId))];
  const ordered = [...declared.filter((id) => used.includes(id)), ...used.filter((id) => !declared.includes(id))];
  const productIds = ordered.length ? ordered : [declared[0]];
  const foundations = productIds.map((productId) => ({
    productId,
    name: productName(productId) || productId,
    short: getProduct(productId)?.shortName || productName(productId) || productId,
    minutes: foundationsMinutes(productId, library),
    thin: Boolean(library.products[productId]?.thin) || !library.products[productId],
    hasBrief: Boolean(library.products[productId]),
    topicOrders: topics.filter((t) => t.productId === productId).map((t) => t.order),
    fileBaseName: foundationsFileBase(productId),
  }));

  const labTitle = String(manifest?.title || split.labTitle || labId || "Lab").trim();
  const trainingMinutes = topics.reduce((s, t) => s + t.minutes, 0) + foundations.reduce((s, f) => s + f.minutes, 0);
  const handsOnMinutes = topics.reduce((s, t) => s + (t.handsOnMinutes || 0), 0);

  const plan = {
    version: TRAINING_SCHEMA_VERSION,
    libraryHash: trainingLibraryHash(),
    labId: labId || manifest?.slug || "",
    labTitle,
    harness,
    harnessName: getHarnesses().find((h) => h.id === harness)?.name || null,
    // A lab that covers two harnesses: their order, and the parts the topics sit in (null for every other lab).
    combined,
    scenario: resolveScenario(manifest),
    productIds,
    foundations,
    topics,
    totalMinutes: trainingMinutes,
    handsOnMinutes,
    completeFileBase: `${TRAINING_DECK_PREFIX} - Complete`,
  };
  plan.fingerprint = planFingerprint(plan, manifestModules);
  return plan;
}

/**
 * A hash of everything that decides what the decks say. Anything that changes a deck changes it: the schema,
 * the library, the lab's text for each module, and the Microsoft Learn record (page, date, headings) the lab holds.
 */
export function planFingerprint(plan, manifestModules = []) {
  const learnRecord = (topic) => {
    const meta = manifestModules.find((m) => Number(m.order) === Number(topic.order)) || {};
    return [meta.steps?.url, meta.steps?.fetchedAt, meta.steps?.sectionHeading, meta.steps?.drift?.level, meta.training?.contentFingerprint, meta.training?.learnCheckedAt];
  };
  const body = {
    v: plan.version,
    lib: plan.libraryHash,
    title: plan.labTitle,
    harness: plan.harness,
    scenario: [plan.scenario.industryId, plan.scenario.agentName],
    topics: plan.topics.map((t) => [t.order, t.id, t.title, t.stepLabel, t.level, t.handsOnMinutes, t.conceptId, t.summary, t.whyItMatters, t.concepts, t.validation, t.facts, t.limits, t.cautions, t.learnTakeaways, t.docUrls, t.unreviewed, t.availability.text, t.prereqNames, t.prereqConceptIds, learnRecord(t)]),
    foundations: plan.foundations.map((f) => [f.productId, f.minutes, f.thin]),
  };
  // A lab that covers two harnesses adds its own record, so only those decks rebuild when the combined layout changes.
  if (plan.combined) {
    body.combined = [TRAINING_COMBINED_VERSION, plan.combined.order, plan.topics.map((t) => [t.order, t.harnessPart, t.harness, t.coveredEarlier?.order ?? null, t.minutes])];
  }
  return crypto.createHash("sha1").update(JSON.stringify(body)).digest("hex").slice(0, 16);
}

/**
 * Persisted Learn record for one module, written into `manifest.modules[i].training` at generation time so
 * decks can be rebuilt later from the manifest alone. Holds only what Microsoft Learn printed (cautions,
 * takeaways, page fingerprint); nothing here is invented.
 */
export function buildModuleTrainingSources({ feature, grounding, stepsRecord, digest } = {}) {
  const takeaways = [];
  for (const r of (grounding?.results || []).slice(0, 3)) {
    const summary = wholeSentences(r.excerpt || "", 300, 2);
    if (summary && r.url) takeaways.push({ title: plainText(r.title || "Microsoft Learn"), url: r.url, summary });
  }
  for (const t of digest?.learnTakeaways || []) {
    if (takeaways.length >= 3) break;
    if (t?.summary && t?.url && !takeaways.some((x) => x.url === t.url)) takeaways.push({ title: plainText(t.title), url: t.url, summary: wholeSentences(t.summary, 300, 2) });
  }
  return {
    unreviewed: Boolean(feature?.learnTopic),
    cautions: (stepsRecord?.cautions || []).slice(0, 3).map(plainText),
    learnTakeaways: takeaways,
    pageHeadings: (stepsRecord?.pageHeadings || []).slice(0, 6).map(plainText),
    contentFingerprint: stepsRecord?.contentFingerprint || null,
    learnCheckedAt: stepsRecord?.fetchedAt || null,
  };
}

/** Where a presenter should look to first sentences of text without cutting words. */
export function excerpt(text, maxChars = 200) {
  return firstSentence(text, maxChars);
}
