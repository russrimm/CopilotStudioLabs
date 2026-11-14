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

// Standalone generic category nouns cannot be deprecated as a whole feature; only specific
// named modes or features (such as "Basic authentication" or "Classic chatbots") can be deprecated.
const GENERIC_DEPRECATION_NOUNS = new Set(
  [
    "authentication",
    "authorization",
    "connection",
    "connections",
    "connector",
    "connectors",
    "channel",
    "channels",
    "security",
    "governance",
    "integration",
    "integrations",
    "configuration",
    "settings",
    "setting",
    "environment",
    "environments",
    "analytics",
    "evaluation",
    "evaluations",
    "knowledge",
    "telephony",
    "identity",
    "identities",
    "permissions",
    "permission",
    "variables",
    "variable",
    "messages",
    "message",
    "triggers",
    "trigger",
    "actions",
    "action",
    "webhooks",
    "webhook",
    "plugins",
    "plugin",
    "topics",
    "topic",
    "models",
    "model",
    "registry",
    "registries",
    "default",
  ],
);

// Subtype qualifiers immediately before a term in Learn ("Basic authentication is deprecated")
// narrow the deprecation to that specific mode rather than the broader term.
const SUBTYPE_PREFIX_RE =
  /(?:^| )(?:basic|password|passwords|username|anonymous|unauthenticated|default|implicit|standalone|custom|manual|direct) $/;

// Product/brand prefixes immediately before a short term ("Microsoft 365 Copilot is now named Microsoft Copilot")
// mean the sentence is about the longer product name, not the bare suffix ("Copilot").
const PRODUCT_PREFIX_RE =
  /(?:^| )(?:microsoft 365|microsoft|azure ai|azure|power platform|power|dynamics 365|dynamics|github|windows|office 365|office|sharepoint|teams|entra|fabric|dataverse|viva) $/;

const IMAGE_MARKDOWN_RE = /!\[[^\]]*\]\([^)]*\)/g;
const CHILD_RECORD_NOUN_RE =
  /\b(?:entry|entries|item|items|row|rows|record|records|user|users|owner|owners|member|members|file|files|value|values|license|licenses|seat|seats|account|accounts|group|groups|role|roles|permission|permissions|assignment|assignments)\b/;
const CONTRAST_BOUNDARY_RE =
  /\b(?:separate from|different from|other than|unlike|except for|distinct from|independent of|aside from|rather than|instead of)\b/;

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

function docsHaveV2Connector(baseVendor, doc, docs) {
  const slug = escapeRe(baseVendor).replace(/\s+/g, "[-_]?");
  const v2UrlRe = new RegExp(`/connectors/${slug}v2(?:[/?#]|$)`, "i");
  if (v2UrlRe.test(doc?.url || "") || docs.some((d) => v2UrlRe.test(d.url || ""))) return true;
  const v2TextRe = new RegExp(
    `\\b${escapeRe(baseVendor)}(?:\\s*\\(\\s*v2\\s*\\)(?!\\w)|\\s+v2\\b)|\\bmigrate from an older ${escapeRe(baseVendor)} connector\\b`,
    "i",
  );
  return docs.some((d) => d.units.some((u) => v2TextRe.test(u.raw)));
}

function labUsesV2Connector(baseVendor, context) {
  const claimTerm = String(context?.claim?.term || "");
  if (/\(\s*v1\s*\)|\bv1\b|\blegacy\b|\bdeprecated\b/i.test(claimTerm)) return false;
  const proseSources = [context?.stepText || "", context?.labText || "", claimTerm, context?.claim?.context || ""]
    .join("\n")
    .replace(/https?:\/\/[^\s)>\]"']+/gi, " ")
    .replace(/[*_`~]+/g, "");
  const v2DisplayRe = new RegExp(`\\b${escapeRe(baseVendor)}(?:\\s*\\(\\s*v2\\s*\\)(?!\\w)|\\s+v2\\b)`, "i");
  return v2DisplayRe.test(proseSources);
}

function isConnectorClaimContext(baseVendor, context) {
  const claim = context?.claim;
  if (!claim) return false;
  const ctx = String(claim.context || "");
  const vendorConnectorRe = new RegExp(
    `\\b${escapeRe(baseVendor)}(?:\\s+\\w+)?\\s+connectors?\\b|\\bconnectors?\\s+(?:for|to)\\s+${escapeRe(baseVendor)}\\b`,
    "i",
  );
  if (vendorConnectorRe.test(ctx)) return true;
  return claim.kind === "ui-label" && /\b(?:add a tool|add tool|choose a connector|select a connector)\b/i.test(ctx);
}

function normalizeWithBoundaries(raw) {
  return String(raw ?? "")
    .replace(IMAGE_MARKDOWN_RE, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[*_`~]+/g, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s&\s/g, " and ")
    .replace(/[,;:()[\]|—–/.!?]+/g, " | ")
    .replace(/[^\p{L}\p{N}| ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isProductPrefixedOccurrence(bounded, termVariant) {
  if (!bounded || !termVariant) return false;
  const re = new RegExp(`(?:^| )(${escapeRe(termVariant)})(?= |\\||$)`, "g");
  let m;
  let sawAny = false;
  let sawUnprefixed = false;
  while ((m = re.exec(bounded)) !== null) {
    sawAny = true;
    const start = m.index + (bounded[m.index] === " " ? 1 : 0);
    const before = bounded.slice(0, start);
    const clauseBefore = before.includes("|") ? before.slice(before.lastIndexOf("|") + 1) : before;
    if (!PRODUCT_PREFIX_RE.test(clauseBefore)) {
      sawUnprefixed = true;
      break;
    }
  }
  return sawAny && !sawUnprefixed;
}

/** Staleness rules that apply to any named item (renamed / deprecated). */
function findNameStale(term, docs, context = {}) {
  const normTerm = normalizeText(term);
  const t = escapeRe(normTerm);
  if (!t || t.length < 6) return null;
  if (GENERIC_DEPRECATION_NOUNS.has(normTerm)) return null;

  const forwardRenamePatterns = [
    new RegExp(
      `(?:^| )(${t}(?:s)?) (?:(?:has been|have been|was|were|is now|are now|was recently) (?:renamed(?: (?:to|as))?|replaced (?:by|with)|rebranded)|renamed (?:to|as)|(?:is|are|was|were|has been|have been) replaced (?:by|with))\\b`,
      "g",
    ),
    new RegExp(`(?:^| )(${t}(?:s)?) (?:is|are) now (?:called|known as|named)\\b`, "g"),
  ];
  const backwardEndGuard = `(?=\\s*(?:\\||$)| (?:is|are|was|were|has|have|which|that|and|or|in|on|for|to|from|with|by|as|now)\\b)`;
  const backwardRenamePatterns = [
    new RegExp(`\\b(?:formerly|previously|originally)(?: (?:called|known as|named))? (?:the )?(${t}(?:s)?)${backwardEndGuard}`, "g"),
    new RegExp(`\\brenamed from (?:the )?(${t}(?:s)?)${backwardEndGuard}`, "g"),
  ];
  const renamed = findSentence(docs, (s) => {
    const rawWithoutImages = String(s.raw ?? "").replace(IMAGE_MARKDOWN_RE, " ").trim();
    if (!rawWithoutImages) return false;
    const bounded = normalizeWithBoundaries(rawWithoutImages);
    if (!bounded) return false;

    for (const re of forwardRenamePatterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(bounded)) !== null) {
        const start = bounded.indexOf(m[1], m.index);
        const before = bounded.slice(0, start);
        const clauseBefore = before.includes("|") ? before.slice(before.lastIndexOf("|") + 1) : before;
        if (SUBTYPE_PREFIX_RE.test(clauseBefore) || PRODUCT_PREFIX_RE.test(clauseBefore)) continue;
        const afterVerb = bounded.slice(m.index + m[0].length);
        const replacementClause = afterVerb.split(/\||(?:\band\b)/)[0] || "";
        const replacementNorm = normalizeText(replacementClause);
        if (replacementNorm && containsPhrase(replacementNorm, normTerm)) continue;
        return true;
      }
    }

    for (const re of backwardRenamePatterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(bounded)) !== null) {
        const start = bounded.indexOf(m[1], m.index);
        const before = bounded.slice(0, start);
        const clauseBefore = before.includes("|") ? before.slice(before.lastIndexOf("|") + 1) : before;
        if (SUBTYPE_PREFIX_RE.test(clauseBefore) || PRODUCT_PREFIX_RE.test(clauseBefore)) continue;
        const afterMatch = bounded.slice(m.index + m[0].length);
        const nowReplacement = afterMatch.match(/^(?:\s*\|[^|]*\|)?\s*(?:is|are) now ([^|]+)/);
        if (nowReplacement && containsPhrase(normalizeText(nowReplacement[1]), normTerm)) continue;
        return true;
      }
    }

    return false;
  });
  if (renamed) {
    return {
      rule: "renamed",
      doc: renamed.doc,
      text: renamed.sentence.raw,
      explanation: `Learn says "${term}" was renamed or replaced.`,
    };
  }
  const deprecatedRe = new RegExp(
    `(?:^| )(${t}(?:s)?((?: [a-z0-9]+){0,2})) (?:(?:(?:is|are|was|were|has been|have been|will be|is being|is now|are now) )?(?:deprecated|retired|no longer (?:available|supported|offered))|(?:is|are|was|were|has been|have been|will be|is being|is now|are now) removed)\\b`,
    "g",
  );
  const deprecated = findSentence(docs, (s, _unit, doc) => {
    const rawWithoutImages = String(s.raw ?? "").replace(IMAGE_MARKDOWN_RE, " ").trim();
    if (!rawWithoutImages) return false;
    const normWithoutImages = normalizeText(rawWithoutImages);
    if (!normWithoutImages) return false;
    if (/\bnot (?:been )?(?:deprecated|retired|removed)\b/.test(normWithoutImages)) return false;

    const bounded = normalizeWithBoundaries(rawWithoutImages);
    deprecatedRe.lastIndex = 0;
    let m;
    while ((m = deprecatedRe.exec(normWithoutImages)) !== null) {
      const start = m.index + (normWithoutImages[m.index] === " " ? 1 : 0);
      if (start > 0 && SUBTYPE_PREFIX_RE.test(normWithoutImages.slice(0, start))) continue;

      const trailing = (m[2] || "").trim();
      const matchedTermOnly = trailing ? m[1].slice(0, m[1].length - trailing.length).trim() : m[1];
      if (isProductPrefixedOccurrence(bounded, matchedTermOnly)) continue;

      if (trailing && CHILD_RECORD_NOUN_RE.test(trailing) && !CHILD_RECORD_NOUN_RE.test(normTerm)) {
        continue;
      }

      const termIsConnector = /\bconnectors?$/.test(normTerm);
      const trailingIsConnector = /^(?:connectors?|connections?)\b/.test(trailing);
      if (termIsConnector || trailingIsConnector) {
        const baseVendor = termIsConnector ? normTerm.replace(/\s+connectors?$/, "") : normTerm;
        // If Learn deprecates "<Vendor> connector" (not the external platform itself), platform-only
        // mentions (for example SQL worksheets or trial setup in Snowflake) are not connector claims.
        if (!termIsConnector && trailingIsConnector && !isConnectorClaimContext(baseVendor, context)) {
          continue;
        }
        // If Learn documents a v2 replacement connector and the lab/section already uses "(v2)",
        // prose or shorthand references to the vendor/connector are not referencing the legacy v1 connector.
        if (docsHaveV2Connector(baseVendor, doc, docs) && labUsesV2Connector(baseVendor, context)) {
          continue;
        }
      }
      return true;
    }
    return false;
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

function prepareAvailabilityWindow(rawSentence, subject) {
  // Strip images and neutralize inline links whose label refers to a different feature
  // (for example "... separate from [deep reasoning (preview)](...)" when checking "Model selection").
  const withoutOtherLinks = String(rawSentence ?? "")
    .replace(IMAGE_MARKDOWN_RE, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, (_full, label) => {
      const normLabel = normalizeText(label);
      return containsPhrase(normLabel, subject) ? label : " ";
    });

  // Neutralize parenthetical "(preview)" / "(GA)" attached to a different noun phrase.
  const cleanedRaw = withoutOtherLinks.replace(
    /\(\s*(?:public\s+|private\s+|in\s+)?(?:preview|ga|generally\s+available)\s*\)/gi,
    (tag, offset, str) => {
      const beforeNorm = normalizeText(str.slice(0, offset));
      if (!containsPhrase(beforeNorm, subject)) return " ";
      const padded = ` ${beforeNorm} `;
      const lastIdx = padded.lastIndexOf(` ${subject} `);
      if (lastIdx < 0) return " ";
      const between = beforeNorm.slice(lastIdx + subject.length).trim();
      if (!between) return tag;
      if (
        CONTRAST_BOUNDARY_RE.test(between) ||
        /\b(?:with|for|from|including|such as|like|and|or|via|using|into|under)\b/.test(between)
      ) {
        return " ";
      }
      return tag;
    },
  );

  const norm = normalizeText(cleanedRaw);
  if (!norm) return null;
  const at = (` ${norm} `).indexOf(` ${subject} `);
  if (at < 0) return null;
  const afterStart = at + subject.length;
  let tail = norm.slice(afterStart, afterStart + 70);
  const contrast = CONTRAST_BOUNDARY_RE.exec(tail);
  if (contrast) tail = tail.slice(0, contrast.index);
  return `${subject}${tail ? ` ${tail.trim()}` : ""}`;
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
        const window = prepareAvailabilityWindow(sentence.raw, subject);
        if (!window) continue;
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
  // Versioned connector names such as "Snowflake (v2)" are often documented on a /connectors/<name>v2/
  // reference page whose heading is simply "# <Name>".
  const versionedMatch = String(claim.term || "").trim().match(/^(.+?)\s*\(\s*v(\d+)\s*\)$/i);
  if (versionedMatch) {
    const baseNorm = normalizeText(versionedMatch[1]);
    const ver = versionedMatch[2];
    const slug = escapeRe(baseNorm).replace(/\s+/g, "[-_]?");
    const urlRe = new RegExp(`/connectors/${slug}v${ver}(?:[/?#]|$)`, "i");
    const versionedHit = findUnit(docs, (unit, doc) => urlRe.test(doc.url || "") && containsPhrase(unit.norm, baseNorm));
    if (versionedHit) {
      return {
        status: "verified",
        rule: "exact-phrase",
        explanation: `"${claim.term}" matches the versioned connector reference page on Learn.`,
        evidence: [cite(versionedHit.doc, versionedHit.unit.raw)],
      };
    }
  }
  return null;
}

/**
 * Evaluate one claim against indexed Learn documents.
 *
 * @param {object} claim a claim from claims.js
 * @param {Array} docs documents from buildEvidence(), most authoritative first
 * @param {{claim?:object, stepText?:string, labText?:string}} [context]
 * @returns {{status:"verified"|"unverified"|"stale", rule:string, explanation:string, evidence:Array<{url,title,excerpt}>}}
 */
export function evaluateClaim(claim, docs, context = {}) {
  const matchContext = { ...context, claim };
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
      const stale = findNameStale(term, docs, matchContext);
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
