/**
 * Claim matching against Microsoft Learn text.
 *
 * Every verdict names the rule that produced it and explains itself, so a
 * reviewer can check the call without re-running anything. There is no scoring
 * model and no LLM: a claim is `verified` when a documented rule finds support,
 * `stale` only when a named staleness rule finds contradicting text, and
 * `unverified` otherwise. (`unable` is decided by the runner when lookups fail;
 * a matcher never sees a claim it could not search for.)
 */

import { containsPhrase, normalizeText, sanitizeExcerpt, splitSentences } from "./text.js";

/** Every rule the matcher can report, for docs and the UI. */
export const RULES = Object.freeze({
  "exact-phrase": { outcome: "verified", description: "The exact wording appears in current Learn text." },
  "exact-phrase-bold": {
    outcome: "verified",
    description: "A single-word control name appears in bold (as Learn formats UI labels).",
  },
  "path-in-order": { outcome: "verified", description: "Every menu or navigation segment appears in order in one Learn passage." },
  "path-suffix-in-order": {
    outcome: "verified",
    description: "A path of three or more segments appears in order after its first segment, and the same Learn page names that first segment.",
  },
  "setting-and-value": { outcome: "verified", description: "The setting and its value appear together in one Learn sentence." },
  "requirement-wording": { outcome: "verified", description: "The role, license, or product appears next to requirement wording." },
  "limit-match": { outcome: "verified", description: "A Learn sentence on the same subject states the same number and unit." },
  "availability-match": { outcome: "verified", description: "Learn describes the feature with the same stage (preview or generally available)." },
  renamed: { outcome: "stale", description: "Learn says the name was renamed, replaced, or is formerly known as something else." },
  deprecated: { outcome: "stale", description: "Learn says the item is deprecated, retired, removed, or no longer supported." },
  "availability-changed": { outcome: "stale", description: "Learn gives a different availability stage than the lab states." },
  "limit-mismatch": { outcome: "stale", description: "A Learn sentence on the same subject states a different number for the same unit." },
  "no-support": { outcome: "unverified", description: "No Learn text supporting the claim was found." },
  "partial-support": { outcome: "unverified", description: "Related text was found, but not enough to confirm the whole claim." },
  "mixed-evidence": { outcome: "unverified", description: "Learn text gives conflicting stages; a person should decide." },
});

const MAX_UNITS_PER_DOC = 6000;
const COMMON_SINGLE_WORDS = new Set(
  "save create test add next back ok cancel done close delete edit new open publish settings agent agents tools tool topics topic".split(" "),
);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const LIMIT_CUE_RE = /\b(?:limit|limits|maximum|max|up to|at most|no more than|minimum|quota|per|retention|timeout|capped|cap|allowed)\b/;

/**
 * Index a document for matching.
 *
 * @param {{url:string,title?:string,text:string,source:"cited-page"|"page"|"search"}} doc
 */
export function buildEvidence(doc) {
  const units = [];
  const lines = String(doc.text ?? "").split(/\r?\n/);
  for (const line of lines) {
    if (units.length >= MAX_UNITS_PER_DOC) break;
    const raw = line.trim().slice(0, 3000);
    if (!raw) continue;
    const norm = normalizeText(raw);
    if (!norm) continue;
    const sentences = splitSentences(raw).map((s) => ({ raw: s, norm: normalizeText(s) }));
    units.push({ raw, norm, sentences: sentences.length ? sentences : [{ raw, norm }] });
  }
  return { url: doc.url, title: doc.title || doc.url, source: doc.source || "search", units };
}

function cite(doc, unitText) {
  return { url: doc.url, title: sanitizeExcerpt(doc.title, 140), excerpt: sanitizeExcerpt(unitText, 320) };
}

function findSentence(docs, predicate) {
  for (const doc of docs) {
    for (const unit of doc.units) {
      for (const sentence of unit.sentences) {
        const hit = predicate(sentence, unit, doc);
        if (hit) return { doc, sentence, unit, hit };
      }
    }
  }
  return null;
}

function findUnit(docs, predicate) {
  for (const doc of docs) {
    for (const unit of doc.units) {
      const hit = predicate(unit, doc);
      if (hit) return { doc, unit, hit };
    }
  }
  return null;
}

function termsOf(claim) {
  if (claim.kind === "nav-path") return claim.segments;
  if (claim.kind === "setting") return claim.terms;
  if (claim.kind === "requirement") return claim.terms?.length ? claim.terms : [claim.term];
  return [claim.term];
}

/** Staleness rules that apply to any named item (renamed / deprecated). */
function findNameStale(term, docs) {
  const t = escapeRe(normalizeText(term));
  if (!t || t.length < 6) return null;
  const renamedPatterns = [
    new RegExp(`(?:^| )${t}(?:s)? (?:has been |was |is now |was recently |were )?(?:renamed|replaced by|replaced with|rebranded)\\b`),
    new RegExp(`(?:^| )${t}(?:s)? (?:is|are) now (?:called|known as|named)\\b`),
    new RegExp(`\\b(?:formerly|previously|originally)(?: (?:called|known as|named))? (?:the )?${t}(?:s)?(?: |$)`),
    new RegExp(`\\brenamed from (?:the )?${t}(?:s)?(?: |$)`),
  ];
  const renamed = findSentence(docs, (s) => renamedPatterns.some((re) => re.test(s.norm)));
  if (renamed) {
    return {
      rule: "renamed",
      doc: renamed.doc,
      text: renamed.sentence.raw,
      explanation: `Learn says "${term}" was renamed or replaced.`,
    };
  }
  const deprecatedRe = new RegExp(
    `(?:^| )${t}(?:s)?(?: [a-z0-9]+){0,2} (?:(?:is|are|was|were|has been|have been|will be|is being|is now|are now) )?(?:deprecated|retired|removed|no longer (?:available|supported|offered))\\b`,
  );
  const deprecated = findSentence(docs, (s) => {
    if (/\bnot (?:been )?(?:deprecated|retired)\b/.test(s.norm)) return false;
    return deprecatedRe.test(s.norm);
  });
  if (deprecated) {
    return {
      rule: "deprecated",
      doc: deprecated.doc,
      text: deprecated.sentence.raw,
      explanation: `Learn describes "${term}" as deprecated, retired, or removed.`,
    };
  }
  return null;
}

function stageOfSentence(norm) {
  const preview = /\bpreview\b/.test(norm);
  const ga = /\bgenerally available\b|\bgeneral availability\b|\bga\b/.test(norm);
  return { preview, ga };
}

function canonicalUnit(unit) {
  const u = unit.toLowerCase();
  if (/^mins?$|^minutes?$/.test(u)) return "minute";
  if (/^secs?$|^seconds?$/.test(u)) return "second";
  if (u === "%") return "%";
  return u.replace(/s$/, "");
}

function numbersWithUnit(raw, unit) {
  const out = [];
  const re = /(\d[\d,]*(?:\.\d+)?)\s*([A-Za-z%]+)/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    if (canonicalUnit(m[2]) === unit) out.push(Number(m[1].replace(/,/g, "")));
  }
  return out;
}

function subjectHit(norm, subject) {
  const tokens = [...new Set(subject.map((s) => normalizeText(s)).filter(Boolean))];
  if (!tokens.length) return false;
  const present = tokens.filter((t) => containsPhrase(norm, t));
  return present.length >= Math.min(2, tokens.length);
}

function evaluateLimit(claim, docs) {
  const unit = canonicalUnit(claim.unit);
  const value = Number(claim.value);
  let mismatch = null;
  for (const doc of docs) {
    for (const unitBlock of doc.units) {
      for (const sentence of unitBlock.sentences) {
        if (!subjectHit(sentence.norm, claim.subject)) continue;
        const values = numbersWithUnit(sentence.raw, unit);
        if (!values.length) continue;
        if (values.includes(value)) {
          return {
            status: "verified",
            rule: "limit-match",
            explanation: `A Learn sentence on the same subject states ${claim.term}.`,
            evidence: [cite(doc, sentence.raw)],
          };
        }
        if (LIMIT_CUE_RE.test(sentence.norm)) mismatch ??= { doc, sentence, values };
      }
    }
  }
  // Subjects guessed from loose words (low confidence) can verify, but are too weak to call a limit stale.
  if (mismatch && claim.confidence !== "low") {
    return {
      status: "stale",
      rule: "limit-mismatch",
      explanation: `The lab says ${claim.term}, but a Learn sentence on the same subject states ${mismatch.values.join(" / ")} ${claim.unit}. Subjects are matched by shared keywords, so confirm it is the same limit.`,
      evidence: [cite(mismatch.doc, mismatch.sentence.raw)],
    };
  }
  return null;
}

function evaluateAvailability(claim, docs) {
  const subject = normalizeText(claim.term);
  const states = { preview: null, ga: null, both: null };
  // The stage must be stated about the subject itself: within a short window after its name.
  // Link-only lines ("[Add X tools (preview)](...)") describe other pages, not this feature.
  for (const doc of docs) {
    for (const unit of doc.units) {
      if (/^\s*[-*]?\s*\[[^\]]+\]\([^)]*\)\s*$/.test(unit.raw)) continue;
      for (const sentence of unit.sentences) {
        const at = (` ${sentence.norm} `).indexOf(` ${subject} `);
        if (at < 0) continue;
        const window = sentence.norm.slice(Math.max(0, at), at + subject.length + 70);
        const stage = stageOfSentence(window);
        if (!stage.preview && !stage.ga) continue;
        const hit = { doc, text: sentence.raw };
        if (stage.preview && stage.ga) states.both ??= hit;
        else if (stage.preview) states.preview ??= hit;
        else states.ga ??= hit;
      }
    }
  }
  const claimed = claim.state;
  const opposite = claimed === "preview" ? "ga" : "preview";
  const label = (s) => (s === "preview" ? "preview" : "generally available");
  if (states[claimed] && !states[opposite]) {
    return {
      status: "verified",
      rule: "availability-match",
      explanation: `Learn also describes "${claim.term}" as ${label(claimed)}.`,
      evidence: [cite(states[claimed].doc, states[claimed].text)],
    };
  }
  if (states[opposite] && !states[claimed] && !states.both) {
    return {
      status: "stale",
      rule: "availability-changed",
      explanation: `The lab says "${claim.term}" is ${label(claimed)}, but Learn describes it as ${label(opposite)}.`,
      evidence: [cite(states[opposite].doc, states[opposite].text)],
    };
  }
  if (states[claimed] || states[opposite] || states.both) {
    const first = states.both || states[opposite] || states[claimed];
    return {
      status: "unverified",
      rule: "mixed-evidence",
      explanation: `Learn text about "${claim.term}" mentions both preview and generally available wording; a person should confirm the current stage.`,
      evidence: [cite(first.doc, first.text)],
    };
  }
  return null;
}

function evaluatePath(claim, docs) {
  const segs = claim.segments.map((s) => normalizeText(s));
  const hit = findUnit(docs, (unit) => {
    if (!unit.norm.includes(" > ")) return false;
    const parts = unit.norm.split(" > ").map((p) => p.trim());
    let from = 0;
    for (const seg of segs) {
      let found = -1;
      for (let i = from; i < parts.length; i += 1) {
        if (parts[i] === seg || containsPhrase(parts[i], seg)) {
          found = i;
          break;
        }
      }
      if (found < 0) return false;
      from = found + 1;
    }
    return true;
  });
  if (hit) {
    return {
      status: "verified",
      rule: "path-in-order",
      explanation: `Every segment of "${claim.term}" appears, in order, in one Learn passage.`,
      evidence: [cite(hit.doc, hit.unit.raw)],
    };
  }
  // Learn often starts a path at the app ("Select Policies > Data policies") rather than naming it.
  if (segs.length >= 3) {
    const rest = segs.slice(1);
    const suffix = findUnit(docs, (unit) => {
      if (!unit.norm.includes(" > ")) return false;
      const parts = unit.norm.split(" > ").map((p) => p.trim());
      let from = 0;
      for (const seg of rest) {
        const found = parts.findIndex((p, i) => i >= from && (p === seg || containsPhrase(p, seg)));
        if (found < 0) return false;
        from = found + 1;
      }
      return true;
    });
    const rootDoc = suffix && docs.find((d) => d.url === suffix.doc.url && d.units.some((u) => containsPhrase(u.norm, segs[0])));
    if (suffix && rootDoc) {
      return {
        status: "verified",
        rule: "path-suffix-in-order",
        explanation: `"${rest.join(" > ")}" appears in order in Learn, and the same page names "${claim.segments[0]}".`,
        evidence: [cite(suffix.doc, suffix.unit.raw)],
      };
    }
  }
  const partial = segs
    .map((seg) => ({ seg, hit: findUnit(docs, (unit) => containsPhrase(unit.norm, seg)) }))
    .filter((p) => p.hit);
  if (partial.length) {
    return {
      status: "unverified",
      rule: "partial-support",
      explanation: `Found ${partial.length} of ${segs.length} segments of "${claim.term}" in Learn, but never as a path in this order.`,
      evidence: partial.slice(0, 2).map((p) => cite(p.hit.doc, p.hit.unit.raw)),
    };
  }
  return null;
}

function evaluateSetting(claim, docs) {
  const [setting, value] = claim.terms.map((t) => normalizeText(t));
  const both = findSentence(docs, (s) => containsPhrase(s.norm, setting) && containsPhrase(s.norm, value));
  if (both) {
    return {
      status: "verified",
      rule: "setting-and-value",
      explanation: `Learn shows "${claim.terms[0]}" together with "${claim.terms[1]}".`,
      evidence: [cite(both.doc, both.sentence.raw)],
    };
  }
  const onlySetting = findUnit(docs, (unit) => containsPhrase(unit.norm, setting));
  if (onlySetting) {
    return {
      status: "unverified",
      rule: "partial-support",
      explanation: `Learn mentions "${claim.terms[0]}" but never together with "${claim.terms[1]}".`,
      evidence: [cite(onlySetting.doc, onlySetting.unit.raw)],
    };
  }
  return null;
}

function evaluateRequirement(claim, docs) {
  const REQ = /\b(?:requires?|required|license[sd]?|licensing|administrator|admin|permissions?|roles?|must|need|needs|prerequisites?)\b/;
  for (const term of termsOf(claim)) {
    const t = normalizeText(term);
    const withWording = findSentence(docs, (s) => containsPhrase(s.norm, t) && REQ.test(s.norm));
    if (withWording) {
      return {
        status: "verified",
        rule: "requirement-wording",
        explanation: `Learn mentions "${term}" next to requirement wording.`,
        evidence: [cite(withWording.doc, withWording.sentence.raw)],
      };
    }
  }
  for (const term of termsOf(claim)) {
    const t = normalizeText(term);
    const mention = findUnit(docs, (unit) => containsPhrase(unit.norm, t));
    if (mention) {
      return {
        status: "unverified",
        rule: "partial-support",
        explanation: `Learn mentions "${term}", but not as a requirement.`,
        evidence: [cite(mention.doc, mention.unit.raw)],
      };
    }
  }
  return null;
}

function evaluatePhrase(claim, docs) {
  const t = normalizeText(claim.term);
  const words = t.split(" ");
  const needsBold = words.length === 1 && (COMMON_SINGLE_WORDS.has(t) || t.length <= 5);
  if (needsBold) {
    const re = new RegExp(`\\*\\*\\s*${escapeRe(claim.term.trim())}s?\\s*\\*\\*`, "i");
    const hit = findUnit(docs, (unit) => re.test(unit.raw));
    if (hit) {
      return {
        status: "verified",
        rule: "exact-phrase-bold",
        explanation: `"${claim.term}" appears in bold in Learn, which is how Learn formats UI labels.`,
        evidence: [cite(hit.doc, hit.unit.raw)],
      };
    }
    return null;
  }
  const hit = findUnit(docs, (unit) => containsPhrase(unit.norm, t));
  if (hit) {
    return {
      status: "verified",
      rule: "exact-phrase",
      explanation: `The exact wording "${claim.term}" appears in current Learn text.`,
      evidence: [cite(hit.doc, hit.unit.raw)],
    };
  }
  return null;
}

/**
 * Evaluate one claim against indexed Learn documents.
 *
 * @param {object} claim a claim from claims.js
 * @param {Array} docs documents from buildEvidence(), most authoritative first
 * @returns {{status:"verified"|"unverified"|"stale", rule:string, explanation:string, evidence:Array<{url,title,excerpt}>}}
 */
export function evaluateClaim(claim, docs) {
  // Contradicting text wins over supporting text: if Learn says the name changed, the lab is stale
  // even when the old name still appears elsewhere.
  if (claim.kind === "availability") {
    const result = evaluateAvailability(claim, docs);
    if (result) return result;
  } else if (claim.kind === "limit") {
    const result = evaluateLimit(claim, docs);
    if (result) return result;
  } else {
    const terms = claim.kind === "nav-path" ? [claim.segments.at(-1)] : termsOf(claim).slice(0, 2);
    for (const term of terms) {
      const stale = findNameStale(term, docs);
      if (stale) {
        return {
          status: "stale",
          rule: stale.rule,
          explanation: stale.explanation,
          evidence: [cite(stale.doc, stale.text)],
        };
      }
    }
    const result =
      claim.kind === "nav-path"
        ? evaluatePath(claim, docs)
        : claim.kind === "setting"
          ? evaluateSetting(claim, docs)
          : claim.kind === "requirement"
            ? evaluateRequirement(claim, docs)
            : evaluatePhrase(claim, docs);
    if (result) return result;
  }
  return {
    status: "unverified",
    rule: "no-support",
    explanation: `No Learn text supporting "${claim.term}" was found in the ${docs.length} document(s) checked.`,
    evidence: [],
  };
}
