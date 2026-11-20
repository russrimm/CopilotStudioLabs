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
import { SUB_STEP_NOTE, endSubStep, joinStep } from "./sub-steps.js";

/** A derived step list is refused below this score. */
export const DEFAULT_THRESHOLD = 0.34;

/** Share of the curated step list's UI labels a candidate must reproduce. */
const MIN_LABEL_COVERAGE = 0.34;

const MAX_STEPS = 15;
const MAX_STEP_LENGTH = 700;
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
  [/^how\s+(?:[\w-]+\s+){1,3}works?\b/i, 0.25],
];

const CONCEPTUAL_SECTION_RE = /^how\s+(?:[\w-]+\s+){1,3}works?\b/i;
const MULTI_SECTION_UI_STEP_RE =
  /\b(select|choose|open|go to|navigate|sign in|enter|type|paste|turn on|turn off|enable|disable|toggle|set|pick|upload|add|create|save|publish|review|confirm|expand|ask|filter|view|delete|manage|test|check|submit|in the|from the|on the|in chat)\b/i;

const TAB_HEADING_RE = /^\[([^\]]+)\]\(#tab\/[^)]+\)/i;
const STEP_HEADING_RE = /^step\s+(\d{1,2})\s*[:.–—-]\s*(.+)$/i;
const PROCEDURAL_SECTION_RE =
  /\b(how to|create|configure|set up|setup|assign|enable|manage|deploy|build|test|publish|share|add|connect|turn on|restrict|view|run|install|register|provision|evaluate|import|export|customize|edit|update)\b/i;
const ACTION_BULLET_RE =
  /^(?:\*\*[^*]{1,60}\*\*|(?:select|choose|open|go to|navigate|sign in|enter|type|paste|turn on|turn off|enable|disable|set|pick|upload|add|create|save|publish|review|confirm|expand|in the|from the|on the|under|next to)\b)/i;
const CODE_TAB_RE =
  /\b(python|c#|csharp|\.net|javascript|typescript|java|azure cli|\bcli\b|rest api|bicep|terraform|arm template|powershell)\b/i;
const UI_TAB_RE = /\b(portal|studio|foundry|admin|copilot|maker|web|ui)\b/i;
const CODE_FEATURE_RE = /\b(sdk|cli|rest|code|typespec|powershell|bicep|api)\b/i;
const INLINE_ARTIFACT_RE = /^(?:!?\[!\[|!\[|:::image\b|:::(?:zone|row|column|moniker)\b|>|\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\])/i;

function singular(word) {
  if (word.length > 3 && word.endsWith("s") && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

/**
 * Content words of a string, lowercased, de-pluralized, stopwords removed.
 *
 * Exported because `relevance.js` scores Learn *search results* with the same
 * vocabulary this module uses to score *procedures*. Two tokenizers that
 * disagree about what a content word is would make the two scores
 * incomparable, and the numbers appear side by side in the manifest.
 */
export function tokens(text) {
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
export function overlap(a, b) {
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
export function coverage(wanted, candidate) {
  if (wanted.size === 0) return 0;
  let shared = 0;
  for (const item of wanted) if (candidate.has(item)) shared += 1;
  return shared / wanted.size;
}

export function clamp(value) {
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
export function absolutize(href, docUrl) {
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

export function decodeEntities(text) {
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
 * and the step is incomplete without them. They become lettered sub-steps, one
 * per line, in Learn's own words (see `sub-steps.js` for the string shape).
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
    const lead = primary.replace(/[::]\s*$/, "").trim();
    // A lead that already ends a sentence gets a short label so the choices never follow a stray colon.
    const intro = /[.!?]$/.test(lead) ? `${lead} Choose from:` : `${lead}:`;
    const choices = [];
    let used = intro.length;
    for (const [index, option] of options.entries()) {
      const piece = `(${String.fromCharCode(97 + index)}) ${option.replace(/[.;]+\s*$/, "")}`;
      if (used + piece.length + 2 > MAX_STEP_LENGTH) break;
      choices.push(option);
      used += piece.length + 2;
    }
    const left = options.length - choices.length;
    if (choices.length) {
      // Each choice keeps Learn's wording on its own line; see sub-steps.js for the shape.
      const clean = (text) => scrubForbidden(text).replace(/\s+/g, " ").trim();
      return joinStep(clean(intro), choices.map((choice) => endSubStep(clean(choice))), left > 0 ? SUB_STEP_NOTE : "");
    }
    primary = `${lead}${/[.!?]$/.test(lead) ? "" : "."} The choices are in the linked article.`;
  } else {
    // A colon with nothing after it is a dangling reference to content we
    // dropped (a screenshot, a code sample, a table). Close the sentence.
    primary = primary.replace(/[::]\s*$/, ".");
  }

  primary = scrubForbidden(primary).replace(/\s+/g, " ").trim();
  // A step is never cut in the middle: past the limit it ends at its last full sentence, and one with no
  // sentence break stays whole rather than losing its end.
  if (primary.length > MAX_STEP_LENGTH) {
    const stop = primary.slice(0, MAX_STEP_LENGTH).lastIndexOf(". ");
    if (stop > 120) primary = primary.slice(0, stop + 1).trim();
  }
  return primary;
}

const CAUTION_LABEL = /^(?:important|warning|caution)$/i;
const LIMITS_HEADING = /^#{2,4}\s+(?:known issues|known limitations|limitations|limits)\s*$/i;
const MAX_CAUTION_LENGTH = 300;
const MAX_CAUTIONS = 3;

/**
 * The cautions Microsoft Learn itself prints on a page: the paragraph under an Important, Warning, or Caution callout,
 * and the bullets under a Limitations or Known issues heading. Each is the page's own sentence (links reduced to their
 * text), never longer than one short paragraph, and never cut in the middle: a sentence that does not fit is left out.
 * Plain Note and Tip callouts are skipped because they are mostly scope notes, not warnings.
 * @returns {string[]} up to three
 */
export function extractLearnCautions(markdown, docUrl) {
  const lines = String(markdown || "").split(/\r?\n/);
  const found = [];
  const add = (raw) => {
    let text = inlineClean(String(raw).replace(/^[-*]\s+/, ""), docUrl).replace(/\[([^\]]+)]\([^)]*\)/g, "$1");
    text = scrubForbidden(text).replace(/\s+/g, " ").trim();
    if (text.length > MAX_CAUTION_LENGTH) {
      const stop = text.slice(0, MAX_CAUTION_LENGTH).lastIndexOf(". ");
      text = stop > 40 ? text.slice(0, stop + 1).trim() : "";
    }
    // "This article ..." is a note about the page's scope, not something a learner can act on.
    if (text.length < 25 || /^\[!|^:::|\[!INCLUDE/i.test(text) || /^\W*$/.test(text) || /^This (?:article|topic|page|section)\b/i.test(text)) return;
    if (!found.some((known) => known.toLowerCase() === text.toLowerCase())) found.push(text);
  };

  let fenced = false;
  for (let i = 0; i < lines.length && found.length < MAX_CAUTIONS; i += 1) {
    const line = lines[i].trim();
    if (/^(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (CAUTION_LABEL.test(line)) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j += 1;
      const paragraph = [];
      while (j < lines.length && lines[j].trim() && !/^#{1,6}\s/.test(lines[j].trim())) {
        paragraph.push(lines[j].trim());
        j += 1;
      }
      add(paragraph.join(" "));
    } else if (LIMITS_HEADING.test(line)) {
      let taken = 0;
      for (let j = i + 1; j < lines.length && taken < 2; j += 1) {
        const next = lines[j].trim();
        if (/^#{1,6}\s/.test(next)) break;
        if (/^[-*]\s+/.test(next)) {
          const before = found.length;
          add(next);
          if (found.length > before) taken += 1;
        }
      }
    }
  }
  return found.slice(0, MAX_CAUTIONS);
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
  let parentHeading = "";
  let activeTab = null;
  let tabLevel = 0;
  let current = null;
  let expected = 1;
  let stepHeadingRun = null;
  let bulletRun = null;
  let fenced = false;

  const flushOrdered = () => {
    if (current && current.items.length >= 2) procedures.push(current);
    current = null;
    expected = 1;
  };

  const flushBullets = () => {
    if (bulletRun && bulletRun.items.length >= MIN_STEPS) {
      const actionCount = bulletRun.items.filter((item) => ACTION_BULLET_RE.test(item[0].trim())).length;
      if (actionCount / bulletRun.items.length >= 0.75) {
        procedures.push(bulletRun);
      }
    }
    bulletRun = null;
  };

  const flushStepHeadings = () => {
    if (stepHeadingRun && stepHeadingRun.items.length >= MIN_STEPS) {
      procedures.push(stepHeadingRun);
    }
    stepHeadingRun = null;
  };

  const flushAll = () => {
    flushOrdered();
    flushBullets();
    flushStepHeadings();
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

    if (/^\s*---\s*$/.test(line)) {
      flushOrdered();
      flushBullets();
      activeTab = null;
      tabLevel = 0;
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      flushOrdered();
      flushBullets();
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      const tabMatch = TAB_HEADING_RE.exec(text);
      // Tabbed sections render as headings like `[Web app](#tab/webApp)`. They
      // are switcher labels, not sections, so the procedure keeps the real
      // heading above it rather than being attributed to the tab.
      if (tabMatch) {
        activeTab = tabMatch[1].trim();
        tabLevel = level;
        continue;
      }

      if (tabLevel && level <= tabLevel) {
        activeTab = null;
        tabLevel = 0;
      }

      const stepHeading = STEP_HEADING_RE.exec(text);
      if (stepHeading) {
        const stepNum = Number(stepHeading[1]);
        const stepTitle = stepHeading[2].trim();
        if (stepNum === 1) {
          flushStepHeadings();
          stepHeadingRun = {
            heading: parentHeading || heading || "Procedure",
            tab: activeTab,
            kind: "step-headings",
            expectedStep: 2,
            awaitingBody: true,
            items: [[`**${stepTitle.replace(/\.$/, "")}.**`]],
          };
        } else if (stepHeadingRun && stepNum === stepHeadingRun.expectedStep) {
          stepHeadingRun.expectedStep += 1;
          stepHeadingRun.awaitingBody = true;
          stepHeadingRun.items.push([`**${stepTitle.replace(/\.$/, "")}.**`]);
        } else {
          flushStepHeadings();
        }
        heading = text;
        continue;
      }

      flushStepHeadings();
      if (level <= 2) parentHeading = text;
      heading = text;
      continue;
    }

    const itemMatch = /^(\d{1,2})\.\s+(.*)$/.exec(line);
    if (itemMatch) {
      flushBullets();
      const number = Number(itemMatch[1]);
      if (number === 1) {
        flushOrdered();
        current = { heading, ...(activeTab ? { tab: activeTab } : {}), items: [[itemMatch[2]]] };
        expected = 2;
      } else if (current && number === expected) {
        current.items.push([itemMatch[2]]);
        expected += 1;
      } else {
        flushOrdered();
      }
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) continue;

    // Inside an ordered procedure, Microsoft Learn frequently renders unindented
    // screenshots, Note/Tip/Important callout banners, blockquotes, and reference
    // tables between step N and step N+1. Keep the procedure open without folding
    // table or callout noise into the click instruction.
    if (current) {
      if (/^\s/.test(line)) {
        current.items[current.items.length - 1].push(line);
        continue;
      }
      if (CALLOUT.test(trimmed) || INLINE_ARTIFACT_RE.test(trimmed) || /^\|.*\|\s*$/.test(trimmed)) {
        continue;
      }
      flushOrdered();
    }

    // Top-level action bullets under a procedural heading (for Learn pages that
    // present short 3-6 action checklists as bullets rather than `<ol>`).
    const topBullet = /^[-*]\s+(.*)$/.exec(line);
    if (topBullet) {
      const canCollectBullets =
        heading &&
        PROCEDURAL_SECTION_RE.test(heading) &&
        !HEADING_PENALTIES.some(([pattern]) => pattern.test(heading));
      if (canCollectBullets) {
        if (!bulletRun) {
          bulletRun = {
            heading,
            ...(activeTab ? { tab: activeTab } : {}),
            kind: "action-bullets",
            items: [[topBullet[1]]],
          };
        } else {
          bulletRun.items.push([topBullet[1]]);
        }
        continue;
      }
    }

    if (/^\s/.test(line)) {
      if (bulletRun) bulletRun.items[bulletRun.items.length - 1].push(line);
      continue;
    }

    if (stepHeadingRun && stepHeadingRun.awaitingBody && !CALLOUT.test(trimmed) && !INLINE_ARTIFACT_RE.test(trimmed) && !/^\|.*\|\s*$/.test(trimmed)) {
      const lastItem = stepHeadingRun.items[stepHeadingRun.items.length - 1];
      lastItem[0] = `${lastItem[0]} ${trimmed}`;
      stepHeadingRun.awaitingBody = false;
      continue;
    }

    flushBullets();
  }

  flushAll();
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
  const baseShape = count >= MIN_STEPS && count <= 12 ? 1 : count === 2 ? 0.3 : count > 12 ? 0.4 : 0;
  const shape = procedure.kind === "action-bullets" ? baseShape * 0.8 : baseShape;

  let penalty = 0;
  for (const [pattern, weight] of HEADING_PENALTIES) {
    if (pattern.test(procedure.heading)) {
      penalty = Math.max(penalty, weight);
    }
  }
  if (procedure.tab) {
    const isCodeFeature = CODE_FEATURE_RE.test(`${feature.id || ""} ${feature.name || ""}`);
    if (!isCodeFeature && CODE_TAB_RE.test(procedure.tab)) {
      penalty += 0.2;
    } else if (UI_TAB_RE.test(procedure.tab)) {
      penalty = Math.max(0, penalty - 0.03);
    }
  }

  // Earlier procedures are the canonical ones on a Learn page; later sections
  // are variants and edge cases. Small enough only to break a near-tie.
  const order = 0.02 * (1 - position);

  // Discovered Learn topics (`feature.learnTopic`) have no curated step list:
  // their `feature.steps` is a single `[Unverified]` fallback placeholder whose
  // bolded label is the article title rather than UI screen labels. Score them
  // against the topic's own title, summary, and merged subtopic titles plus
  // UI-action density so procedural companion pages derive cleanly.
  if (feature.learnTopic) {
    const subtopicText = (feature.learnTopic.subtopics || [])
      .map((sub) => `${sub.title || ""} ${sub.summary || ""}`)
      .join(" ");
    const topicTokens = tokens([feature.name, feature.summary, subtopicText].join(" "));
    const actionItems = procedure.items.filter((item) => {
      const joined = item.join(" ");
      return /\*\*[^*]{1,80}\*\*/.test(joined) || ACTION_BULLET_RE.test(joined.trim());
    }).length;
    const actionDensity = count ? actionItems / count : 0;
    const topicCoverage = coverage(topicTokens, procedureTokens);
    const learnHeadingScore = overlap(tokens(procedure.heading), topicTokens);
    return clamp(
      0.35 * actionDensity + 0.25 * topicCoverage + 0.25 * learnHeadingScore + 0.15 * shape - penalty + order,
    );
  }

  return clamp(
    0.45 * labelCoverage + 0.2 * bodyCoverage + 0.2 * headingScore + 0.15 * shape - penalty + order,
  );
}

/**
 * Combine sequential procedural sections on a multi-section Microsoft Learn
 * how-to article when no single `<ol>` covers the full walkthrough on its own
 * (for example `authoring-test-bot` or `memory-overview`, where Microsoft Learn
 * splits turning a feature on, testing it, and managing it across adjacent H2/H3
 * headings). Requires at least two qualifying UI procedural sections so a
 * single-fragment page is never promoted.
 */
function extractMultiSectionProcedures(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const sections = [];
  let heading = "";
  let parentHeading = "";
  let activeTab = null;
  let tabLevel = 0;
  let current = null;
  let expected = 1;
  let bulletRun = null;
  let fenced = false;

  const isEligibleHeading = (h) =>
    Boolean(h) &&
    !CONCEPTUAL_SECTION_RE.test(h) &&
    !HEADING_PENALTIES.some(([pattern]) => pattern.test(h));

  const hasUiActionDensity = (items) => {
    if (!items.length) return false;
    const hits = items.filter((item) => MULTI_SECTION_UI_STEP_RE.test(item.join(" "))).length;
    return hits / items.length >= 0.6;
  };

  const flushOrdered = () => {
    if (current && current.items.length >= 2 && isEligibleHeading(current.heading) && hasUiActionDensity(current.items)) {
      sections.push(current);
    }
    current = null;
    expected = 1;
  };

  const flushBullets = () => {
    if (bulletRun && bulletRun.items.length >= 2) {
      const actionCount = bulletRun.items.filter((item) => ACTION_BULLET_RE.test(item[0].trim())).length;
      if (actionCount / bulletRun.items.length >= 0.75 && hasUiActionDensity(bulletRun.items)) {
        sections.push(bulletRun);
      }
    }
    bulletRun = null;
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    if (/^\s*---\s*$/.test(line)) {
      flushOrdered();
      flushBullets();
      activeTab = null;
      tabLevel = 0;
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      flushOrdered();
      flushBullets();
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      const tabMatch = TAB_HEADING_RE.exec(text);
      if (tabMatch) {
        activeTab = tabMatch[1].trim();
        tabLevel = level;
        continue;
      }
      if (tabLevel && level <= tabLevel) {
        activeTab = null;
        tabLevel = 0;
      }
      if (level <= 2) parentHeading = text;
      heading = text;
      continue;
    }

    const itemMatch = /^(\d{1,2})\.\s+(.*)$/.exec(line);
    if (itemMatch) {
      flushBullets();
      const number = Number(itemMatch[1]);
      if (number === 1) {
        flushOrdered();
        current = { heading: heading || parentHeading, ...(activeTab ? { tab: activeTab } : {}), items: [[itemMatch[2]]] };
        expected = 2;
      } else if (current && number === expected) {
        current.items.push([itemMatch[2]]);
        expected += 1;
      } else {
        flushOrdered();
      }
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) continue;

    if (current) {
      if (/^\s/.test(line)) {
        current.items[current.items.length - 1].push(line);
        continue;
      }
      if (CALLOUT.test(trimmed) || INLINE_ARTIFACT_RE.test(trimmed) || /^\|.*\|\s*$/.test(trimmed)) {
        continue;
      }
      flushOrdered();
    }

    const topBullet = /^[-*]\s+(.*)$/.exec(line);
    if (topBullet) {
      if (isEligibleHeading(heading) && PROCEDURAL_SECTION_RE.test(heading)) {
        if (!bulletRun) {
          bulletRun = {
            heading,
            ...(activeTab ? { tab: activeTab } : {}),
            kind: "action-bullets",
            items: [[topBullet[1]]],
          };
        } else {
          bulletRun.items.push([topBullet[1]]);
        }
        continue;
      }
    }

    if (/^\s/.test(line)) {
      if (bulletRun) bulletRun.items[bulletRun.items.length - 1].push(line);
      continue;
    }

    flushBullets();
  }

  flushOrdered();
  flushBullets();

  const byTab = new Map();
  for (const sec of sections) {
    const key = sec.tab || "";
    const group = byTab.get(key) || [];
    group.push(sec);
    byTab.set(key, group);
  }

  const combined = [];
  for (const [tabKey, group] of byTab.entries()) {
    if (group.length < 2) continue;
    const seen = new Set();
    const mergedItems = [];
    for (const sec of group) {
      for (const item of sec.items) {
        const key = item[0].trim().toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        mergedItems.push(item);
        if (mergedItems.length >= MAX_STEPS) break;
      }
      if (mergedItems.length >= MAX_STEPS) break;
    }
    if (mergedItems.length >= MIN_STEPS) {
      combined.push({
        heading: group.map((sec) => sec.heading).filter(Boolean)[0] || "Procedure",
        ...(tabKey ? { tab: tabKey } : {}),
        kind: "multi-section",
        items: mergedItems,
      });
    }
  }
  return combined;
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
  const catalogSteps = feature.steps || [];
  const catalogLabels = labels(catalogSteps.join(" "));
  const minComplete =
    catalogSteps.length <= 5
      ? Math.max(MIN_STEPS, catalogSteps.length - 1)
      : Math.max(4, Math.ceil(catalogSteps.length * 0.6));

  const tryMultiSection = () => {
    const multiCandidates = extractMultiSectionProcedures(markdown)
      .map((procedure) => ({ procedure, score: scoreProcedure(procedure, feature, 0) }))
      .sort((a, b) => b.score - a.score);
    for (const candidate of multiCandidates) {
      if (candidate.score < threshold) break;
      if (catalogLabels.size >= 2) {
        const labelCoverage = coverage(
          catalogLabels,
          labels(candidate.procedure.items.map((i) => i.join(" ")).join(" ")),
        );
        if (labelCoverage < MIN_LABEL_COVERAGE) continue;
      }
      const steps = candidate.procedure.items
        .slice(0, MAX_STEPS)
        .map((item) => cleanStep(item, docUrl))
        .filter(Boolean);
      if (steps.length < MIN_STEPS) continue;
      if (catalogSteps.length && steps.length < minComplete) continue;
      return { ok: true, steps, heading: candidate.procedure.heading, score: candidate.score };
    }
    return null;
  };

  const procedures = extractProcedures(markdown);
  if (!procedures.length) {
    return tryMultiSection() || { ok: false, reason: "no-procedure-found", score: 0, heading: null };
  }

  const last = Math.max(1, procedures.length - 1);
  const ranked = procedures
    .map((procedure, index) => ({
      procedure,
      score: scoreProcedure(procedure, feature, procedures.length > 1 ? index / last : 0),
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (best.score < threshold) {
    return (
      tryMultiSection() || {
        ok: false,
        reason: "low-confidence",
        score: best.score,
        heading: best.procedure.heading,
      }
    );
  }

  let topFailure = null;
  for (const candidate of ranked) {
    if (candidate.score < threshold) break;
    const candidateHeading = candidate.procedure.heading;

    // Gate 1 — does the candidate visit the screens this module is about?
    if (catalogLabels.size >= 2) {
      const labelCoverage = coverage(
        catalogLabels,
        labels(candidate.procedure.items.map((i) => i.join(" ")).join(" ")),
      );
      if (labelCoverage < MIN_LABEL_COVERAGE) {
        if (!topFailure) topFailure = { ok: false, reason: "label-mismatch", score: candidate.score, heading: candidateHeading };
        continue;
      }
    }

    const steps = candidate.procedure.items
      .slice(0, MAX_STEPS)
      .map((item) => cleanStep(item, docUrl))
      .filter(Boolean);

    if (steps.length < MIN_STEPS) {
      if (!topFailure) topFailure = { ok: false, reason: "too-few-steps", score: candidate.score, heading: candidateHeading };
      continue;
    }

    // Gate 2 — never trade a curated procedure for a fragment that stops early,
    // while allowing complete official Microsoft Learn procedures that group
    // multiple clicks into 4-8 concise steps where the catalog splits 6-11.
    if (catalogSteps.length && steps.length < minComplete) {
      if (!topFailure) topFailure = { ok: false, reason: "less-complete-than-catalog", score: candidate.score, heading: candidateHeading };
      continue;
    }

    return { ok: true, steps, heading: candidateHeading, score: candidate.score };
  }

  return tryMultiSection() || topFailure || { ok: false, reason: "low-confidence", score: best.score, heading: best.procedure.heading };
}

/**
 * True when a fetched Microsoft Learn `verifiedAgainst` article is a live,
 * substantive, on-topic page for `feature` (even if it is written as conceptual,
 * architectural, or reference prose rather than a numbered click checklist).
 *
 * Rejects short stubs, malformed text, 404 banners, and pages about a different
 * feature so genuine grounding failures still raise `steps-not-derived`.
 */
export function isVerifiedCanonicalArticle(markdown, feature) {
  const text = String(markdown || "").trim();
  if (text.length < 350) return false;
  const headerSample = text.slice(0, 400);
  if (/\b(?:404\s*[-–:]?\s*(?:page\s+)?not\s+found|page\s+not\s+found|we\s+couldn['’]t\s+find\s+this\s+page)\b/i.test(headerSample)) {
    return false;
  }
  const headings = text.match(/^#{1,3}\s+\S.*$/gm) || [];
  if (headings.length < 2) return false;

  const wanted = tokens([feature?.name || "", feature?.summary || ""].join(" "));
  if (wanted.size >= 2) {
    const pageTokens = tokens(text);
    if (coverage(wanted, pageTokens) < 0.3) return false;
  }
  return true;
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
