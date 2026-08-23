/**
 * Walk-through step derivation.
 *
 * Reads a fetched Microsoft Learn page and derives the click-by-click steps for
 * one catalog feature from it, instead of trusting the hand-maintained step list
 * in `features.json`.
 *
 * The design constraint that matters: **every rendered step is a cleaned
 * substring of a page we actually fetched.** Nothing here writes prose, and no
 * language model is involved. `generator.js`'s SYSTEM_PROMPT asks a model not to
 * invent product UI, but a prompt is a request. Extraction is a guarantee, and
 * for click-level instructions — where a wrong button name dead-ends the learner
 * — the guarantee is worth more than the fluency.
 *
 * The hard part is not extraction, it is *selection*. A single Learn article
 * routinely carries several unrelated numbered procedures; `knowledge-add-sharepoint`
 * has six. Picking the wrong one is worse than not deriving at all, so a
 * candidate has to clear a confidence threshold before it is used. When nothing
 * clears it, the caller falls back to the curated steps and says so — that
 * decision belongs to `generator.js`, not here.
 *
 * Fetched documentation is untrusted input. It is never executed. Every step is
 * stripped of HTML, images, and control characters; links are resolved to
 * absolute `https:` URLs or dropped; and TODO-style markers are scrubbed because
 * `validator.js` rejects them anywhere in a lab file.
 */

import { scrubForbidden } from "./composer.js";

/** A derived step list is refused below this score. */
export const DEFAULT_THRESHOLD = 0.34;

/** Share of the curated step list's UI labels a candidate must reproduce. */
const MIN_LABEL_COVERAGE = 0.34;

const MAX_STEPS = 15;
const MAX_STEP_LENGTH = 400;
const MAX_OPTIONS = 6;
const MIN_STEPS = 3;

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "with", "your", "you", "it",
  "is", "are", "as", "from", "that", "this", "by", "at", "be", "can", "use", "using", "when",
  "how", "if", "then", "not", "no", "do", "does", "into", "its", "their", "these", "those",
  "so", "own", "want", "will", "each", "any", "all", "more", "new", "one", "two", "up", "out",
]);

/** Headings that usually own a numbered list which is not the module's procedure. */
const HEADING_PENALTIES = [
  [/\b(troubleshoot|known issue|limitation|consideration|faq)\b/i, 0.3],
  [/\b(example|sample|scenario walkthrough|appendix)\b/i, 0.25],
  [/\b(advanced|migrate|migration|deprecat|release note|what's new)\b/i, 0.15],
];

function singular(word) {
  if (word.length > 3 && word.endsWith("s") && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

/** Content words of a string, lowercased, de-pluralized, stopwords removed. */
function tokens(text) {
  const out = new Set();
  for (const raw of String(text || "").toLowerCase().match(/[a-z][a-z0-9+#-]{1,}/g) || []) {
    const word = singular(raw);
    if (word.length < 3 || STOPWORDS.has(word) || STOPWORDS.has(raw)) continue;
    out.add(word);
  }
  return out;
}

/** The **bolded** UI labels in a string — the strongest signal that two
 *  procedures describe the same screens. */
function labels(text) {
  const out = new Set();
  for (const match of String(text || "").matchAll(/\*\*([^*]{1,60})\*\*/g)) {
    const label = match[1].replace(/\s+/g, " ").trim().toLowerCase();
    if (label) out.add(label);
  }
  return out;
}

/**
 * Overlap of two token sets, normalized by the smaller one.
 *
 * Use this only for symmetric comparisons like heading similarity. It is the
 * wrong measure for "does this candidate cover the module", because a candidate
 * can score well merely by containing a few shared words — see `coverage`.
 */
function overlap(a, b) {
  const min = Math.min(a.size, b.size);
  if (min < 2) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) shared += 1;
  return shared / min;
}

/**
 * Directed coverage: how much of `wanted` the `candidate` actually reproduces.
 *
 * This is the measure that matters for selection, and using the symmetric one
 * instead was a real defect. On `create-agent` the live page's tutorial
 * narrative shares plenty of vocabulary with the catalog while omitting the two
 * clicks that create the agent — symmetric overlap rated it 0.647, directed
 * coverage of the catalog's UI labels rates it 0.0, which is the truth.
 */
function coverage(wanted, candidate) {
  if (wanted.size === 0) return 0;
  let shared = 0;
  for (const item of wanted) if (candidate.has(item)) shared += 1;
  return shared / wanted.size;
}

function clamp(value) {
  return Math.max(0, Math.min(1, value));
}

/**
 * Resolve a Markdown link target against the page it came from.
 *
 * Learn pages link relatively — `(nlu-boost-node)` and `(/en-us/troubleshoot/…)`
 * are both real targets on the SharePoint knowledge page — and a relative link
 * rendered inside a generated lab is simply broken. Anything that does not
 * resolve to `http:` or `https:` is dropped rather than rendered, which also
 * disposes of `javascript:` and `data:` targets from untrusted input.
 *
 * @returns {string|null} an absolute URL, or null if it must not be rendered
 */
function absolutize(href, docUrl) {
  const raw = String(href || "").trim().split(/\s+/)[0].replace(/^<|>$/g, "");
  if (!raw || raw.startsWith("#")) return null;
  try {
    const url = new URL(raw, docUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

const HTML_ENTITIES = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " ",
};

function decodeEntities(text) {
  return String(text || "")
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (entity) => HTML_ENTITIES[entity] ?? entity)
    .replace(/&#(\d{2,5});/g, (_match, code) => {
      const point = Number(code);
      return point >= 32 && point <= 0x10ffff ? String.fromCodePoint(point) : " ";
    });
}

/** Strip Markdown/HTML noise from one line of fetched documentation. */
function inlineClean(text, docUrl) {
  return decodeEntities(
    String(text || "")
      // Linked screenshots: [![alt](img)](full#lightbox). Must go before plain links.
      .replace(/\[!\[[^\]]*]\([^)]*\)]\([^)]*\)/g, " ")
      .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)]\(([^)]+)\)/g, (_match, label, href) => {
        const absolute = absolutize(href, docUrl);
        return absolute ? `[${label}](${absolute})` : label;
      })
      .replace(/<[^>]*>/g, " "),
  )
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const CALLOUT = /^(note|important|tip|caution|warning)$/i;

/**
 * Turn one raw list item (its numbered line plus any indented continuation)
 * into a single lab step.
 *
 * Continuation prose is dropped — Learn uses it for caveats and cross-links that
 * bloat a click instruction. Continuation *bullets* are kept, because they are
 * usually the enumerated choices the step is telling the learner to pick from,
 * and the step is incomplete without them.
 */
export function cleanStep(lines, docUrl) {
  const [first, ...rest] = lines;
  let primary = inlineClean(first, docUrl);
  if (!primary) return "";

  const options = [];
  for (const line of rest) {
    const trimmed = String(line).trim();
    if (!trimmed || CALLOUT.test(trimmed) || trimmed.startsWith("```")) continue;
    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    if (!bullet) continue;
    const cleaned = inlineClean(bullet[1], docUrl);
    if (cleaned) options.push(cleaned);
    if (options.length >= MAX_OPTIONS) break;
  }

  if (options.length) {
    primary = `${primary.replace(/[::]\s*$/, "")}: ${options.join("; ")}.`;
  } else {
    // A colon with nothing after it is a dangling reference to content we
    // dropped (a screenshot, a code sample, a table). Close the sentence.
    primary = primary.replace(/[::]\s*$/, ".");
  }

  primary = scrubForbidden(primary).replace(/\s+/g, " ").trim();
  if (primary.length > MAX_STEP_LENGTH) {
    const cut = primary.slice(0, MAX_STEP_LENGTH);
    const stop = cut.lastIndexOf(". ");
    primary = `${(stop > 120 ? cut.slice(0, stop) : cut).trim()}...`;
  }
  return primary;
}

/**
 * Find every numbered procedure in a page.
 *
 * A procedure is a run of top-level ordered-list items numbered 1, 2, 3… under
 * one heading. The run ends at the next heading, at unindented prose, or at a
 * number that breaks the sequence. Fenced code is skipped so that a numbered
 * list inside a sample is never mistaken for an instruction.
 *
 * @returns {Array<{heading:string, items:string[][]}>} in document order
 */
export function extractProcedures(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const procedures = [];
  let heading = "";
  let current = null;
  let expected = 1;
  let fenced = false;

  const flush = () => {
    if (current && current.items.length >= 2) procedures.push(current);
    current = null;
    expected = 1;
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    // Fenced sample code is dropped entirely, never folded into the step above
    // it. Learn embeds YAML whose lines begin with "- ", and treating those as
    // the step's option bullets produced steps like "Buy items; Buy online;
    // kind: SendMessage" — sample data presented to the learner as clicks.
    if (fenced) continue;

    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      flush();
      const text = headingMatch[2].trim();
      // Tabbed sections render as headings like `[Web app](#tab/webApp)`. They
      // are switcher labels, not sections, so the procedure keeps the real
      // heading above it rather than being attributed to the tab.
      if (!/\(#tab\//.test(text)) heading = text;
      continue;
    }

    const itemMatch = /^(\d{1,2})\.\s+(.*)$/.exec(line);
    if (itemMatch) {
      const number = Number(itemMatch[1]);
      if (number === 1) {
        flush();
        current = { heading, items: [[itemMatch[2]]] };
        expected = 2;
      } else if (current && number === expected) {
        current.items.push([itemMatch[2]]);
        expected += 1;
      } else {
        flush();
      }
      continue;
    }

    if (!line.trim()) continue;
    if (/^\s/.test(line)) {
      if (current) current.items[current.items.length - 1].push(line);
      continue;
    }
    flush();
  }

  flush();
  return procedures;
}

/**
 * How well one candidate procedure matches the feature we are building a module
 * for. Returns 0..1.
 *
 * The dominant term is *label coverage*: the share of the curated step list's
 * bolded UI vocabulary that the candidate reproduces. The curated steps are not
 * trusted for their wording — that is the whole point of issue #37 — but they
 * are a reliable statement of *which screens the module is about*, and a
 * candidate that never mentions those screens is describing something else.
 *
 * This is what separates a real procedure from a plausible impostor on the same
 * page. The `create-agent` article's tutorial narrative shares plenty of
 * vocabulary with the catalog yet never mentions **Create** or **New agent**;
 * symmetric overlap rated it 0.647 and it produced worse steps than the catalog.
 *
 * @param {object} procedure from extractProcedures
 * @param {object} feature   catalog feature
 * @param {number} [position] 0 for the first procedure on the page, 1 for the last
 */
export function scoreProcedure(procedure, feature, position = 0) {
  const catalogSteps = feature.steps || [];
  const catalogText = catalogSteps.join(" ");
  const featureText = [feature.name, feature.summary, catalogText].join(" ");
  const procedureText = procedure.items.map((item) => item.join(" ")).join(" ");

  const procedureLabels = labels(procedureText);
  const procedureTokens = tokens(procedureText);

  // Does the candidate visit the screens the module is about?
  const labelCoverage = coverage(labels(catalogText), procedureLabels);
  // Does it cover the ground the module covers, or only a fragment of it?
  const bodyCoverage = coverage(tokens(catalogText), procedureTokens);
  // Is this section even on-topic?
  const headingScore = overlap(tokens(procedure.heading), tokens(featureText));

  const count = procedure.items.length;
  const shape = count >= MIN_STEPS && count <= 12 ? 1 : count === 2 ? 0.3 : count > 12 ? 0.4 : 0;

  let penalty = 0;
  for (const [pattern, weight] of HEADING_PENALTIES) {
    if (pattern.test(procedure.heading)) {
      penalty = Math.max(penalty, weight);
    }
  }

  // Earlier procedures are the canonical ones on a Learn page; later sections
  // are variants and edge cases. Small enough only to break a near-tie.
  const order = 0.02 * (1 - position);

  return clamp(
    0.45 * labelCoverage + 0.2 * bodyCoverage + 0.2 * headingScore + 0.15 * shape - penalty + order,
  );
}

/**
 * Derive a step list for one feature from one fetched page.
 *
 * Selection is deliberately conservative. Falling back to curated steps costs
 * the learner slightly stale wording; adopting the wrong procedure costs them a
 * lab that does not work. Two structural gates run after scoring, because
 * scoring alone cannot separate them — measured on real pages, a bad candidate
 * scored 0.623 and a good one 0.616, so no threshold sits between them.
 *
 * @returns {{ok:true, steps:string[], heading:string, score:number}
 *          |{ok:false, reason:string, score:number, heading:string|null}}
 */
export function deriveSteps(markdown, feature, docUrl, { threshold = DEFAULT_THRESHOLD } = {}) {
  const procedures = extractProcedures(markdown);
  if (!procedures.length) {
    return { ok: false, reason: "no-procedure-found", score: 0, heading: null };
  }

  const last = Math.max(1, procedures.length - 1);
  const ranked = procedures
    .map((procedure, index) => ({
      procedure,
      score: scoreProcedure(procedure, feature, procedures.length > 1 ? index / last : 0),
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  const heading = best.procedure.heading;
  if (best.score < threshold) {
    return { ok: false, reason: "low-confidence", score: best.score, heading };
  }

  const catalogSteps = feature.steps || [];
  const catalogLabels = labels(catalogSteps.join(" "));

  // Gate 1 — does the candidate visit the screens this module is about?
  //
  // A candidate that reproduces none of the curated UI labels is describing
  // something else, however well its prose scores. The `create-agent` article's
  // tutorial narrative is the case that forced this: it scored 0.623 while never
  // mentioning **Create**, **New agent**, or the **Overview** page, and the
  // steps it produced were worse than the curated ones.
  if (catalogLabels.size >= 2) {
    const labelCoverage = coverage(catalogLabels, labels(best.procedure.items.map((i) => i.join(" ")).join(" ")));
    if (labelCoverage < MIN_LABEL_COVERAGE) {
      return { ok: false, reason: "label-mismatch", score: best.score, heading };
    }
  }

  const steps = best.procedure.items
    .slice(0, MAX_STEPS)
    .map((item) => cleanStep(item, docUrl))
    .filter(Boolean);

  if (steps.length < MIN_STEPS) {
    return { ok: false, reason: "too-few-steps", score: best.score, heading };
  }

  // Gate 2 — never trade a curated procedure for a shorter one.
  //
  // The curated list is not trusted for its wording, but it is a fair statement
  // of how much ground the module has to cover. A materially shorter candidate
  // is a fragment of the real procedure rather than the procedure. `channel-teams`
  // is the case: the best candidate stopped at "the configuration panel appears"
  // and never reached publishing or installing, which is most of the module.
  if (catalogSteps.length && steps.length < catalogSteps.length - 1) {
    return { ok: false, reason: "less-complete-than-catalog", score: best.score, heading };
  }

  return { ok: true, steps, heading, score: best.score };
}

/**
 * Compare the curated catalog steps against what the live page actually says.
 *
 * This is reported, never acted on: the doc-derived path has already resolved
 * the disagreement by using the live page. The value is telling a human that
 * `features.json` has gone stale — which is the signal issue #42 needs.
 *
 * `major` is not an error. On `knowledge-sharepoint` today the catalog says
 * "Save" and the live page says "Add to agent", and surfacing that is the point.
 */
export function diffSteps(catalogSteps = [], derivedSteps = []) {
  const catalogText = catalogSteps.join("\n");
  const derivedText = derivedSteps.join("\n");
  if (catalogText === derivedText) {
    return {
      level: "none",
      catalogSteps: catalogSteps.length,
      docSteps: derivedSteps.length,
      changedLabels: [],
      newLabels: [],
      unmatchedCatalogSteps: [],
    };
  }

  const catalogLabels = labels(catalogText);
  const derivedLabels = labels(derivedText);
  const missing = [...catalogLabels].filter((label) => !derivedLabels.has(label));
  const added = [...derivedLabels].filter((label) => !catalogLabels.has(label));

  // Bolded labels alone under-report drift, because the catalog does not bold
  // consistently. On `knowledge-sharepoint` the single most important change —
  // the catalog's "Save and wait for indexing" versus the live page's "Select
  // **Add to agent**" — is invisible to a label diff, since the catalog never
  // bolded "Save". Comparing whole steps by content-word overlap catches it.
  const derivedTokenSets = derivedSteps.map((step) => tokens(step));
  const unmatched = catalogSteps.filter((step) => {
    const wanted = tokens(step);
    if (wanted.size === 0) return false;
    return !derivedTokenSets.some((candidate) => coverage(wanted, candidate) >= 0.5);
  });

  const shared = overlap(catalogLabels, derivedLabels);
  const level = shared >= 0.6 && unmatched.length <= 1 ? "minor" : "major";

  return {
    level,
    catalogSteps: catalogSteps.length,
    docSteps: derivedSteps.length,
    // Labels the catalog still tells the learner to look for that the live page
    // no longer mentions. These are the ones that strand someone mid-lab.
    changedLabels: missing.slice(0, 8),
    newLabels: added.slice(0, 8),
    // Whole curated steps with no counterpart on the live page. Either the
    // product moved, or the step was a deliberate teaching addition.
    unmatchedCatalogSteps: unmatched.slice(0, 6),
  };
}
