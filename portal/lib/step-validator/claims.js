/**
 * Claim extraction.
 *
 * A claim is one statement in a lab step that Microsoft Learn can confirm or
 * contradict. Extraction is rule based and explainable: each claim records the
 * rule-relevant `kind`, the exact `term`(s) taken from the lab, and the line it
 * came from. Text a learner types or names themselves is never a claim.
 *
 * Kinds (highest priority first):
 *   nav-path      Settings → Generative AI          every segment must appear, in order
 *   setting       Set **X** to **Y**                the setting and its value must co-occur
 *   ui-label      Select **Add tool**               a named control after a UI verb or noun
 *   requirement   "requires a Microsoft 365 Copilot license"
 *   limit         "up to 25 MB"
 *   availability  "(preview)" / "generally available"
 *   term          other bold feature names          low confidence; never downgrades a step alone
 */

import { normalizeText, stripMarkdown } from "./text.js";

export const CLAIM_KINDS = Object.freeze(["nav-path", "setting", "ui-label", "requirement", "limit", "availability", "term"]);

const GENERIC_BOLD = new Set(
  [
    "note", "tip", "important", "warning", "caution", "objective", "scenario", "example", "optional", "why",
    "goal", "time", "outcome", "expected", "result", "results", "prerequisites", "step", "steps", "lab", "yes",
    "no", "true", "false", "ok", "done", "tbd", "and", "or", "when", "continue", "if", "then", "else", "all",
    "any", "none", "each", "here", "this", "that", "facilitated workshop", "related scenario lab", "suggested next labs",
  ].map((w) => w.toLowerCase()),
);

const PROSE_PRODUCT_TERMS = [
  "Microsoft Copilot Studio",
  "Copilot Studio",
  "Microsoft 365 Copilot",
  "Microsoft agent usage estimator",
  "Agent Store",
  "Microsoft Teams",
  "SharePoint list",
  "SharePoint",
  "Dataverse table",
  "Dataverse",
  "Power Automate",
  "Power Apps",
  "Power Fx",
  "Power BI",
  "Power Platform",
  "Microsoft Entra ID",
  "Microsoft Entra",
  "Entra agent identities",
  "Entra identity",
  "agent identities",
  "agent identity",
  "Entra ID",
  "Azure DevOps",
  "Prompt Assistant",
  "Prompt Advisor",
  "Prompt Builder",
  "prompt-node",
  "prompt node",
  "prompt nodes",
  "agent flow",
  "agent flows",
  "flow variables",
  "agent node",
  "agent nodes",
  "question node",
  "question nodes",
  "conversational topics",
  "topic logic",
  "agent instructions",
  "system instructions",
  "Generative AI settings",
  "Generative AI",
  "generative orchestration",
  "model picker",
  "model dropdown",
  "model selection",
  "content moderation",
  "knowledge-source",
  "knowledge source",
  "knowledge sources",
  "asynchronous responses",
  "asynchronous response",
  "express mode",
  "MSN Weather",
  "custom connector",
  "custom connectors",
  "premium connectors",
  "on-premises data gateway",
  "gateway cluster",
  "ServiceNow connector",
  "Snowflake (v2)",
  "Snowflake connector",
  "Bing Custom Search",
  "Fabric Data Agent",
  "Work IQ MCP",
  "Work IQ",
  "Model Context Protocol",
  "MCP server",
  "MCP tools",
  "computer-using agents",
  "computer-use",
  "computer use",
  "Cloud PC",
  "connected agent",
  "connected agents",
  "child agent",
  "multi-agent",
  "orchestrator agent",
  "specialist agent",
  "specialist agents",
  "activity map",
  "voice agent",
  "voice features",
  "voice settings",
  "voice test panel",
  "barge-in",
  "interruption handling",
  "silence detection",
  "turn-taking",
  "DTMF input",
  "hold and resume",
  "agent evaluations",
  "evaluation run",
  "test set",
  "test chat",
  "test mode",
  "multi-turn conversation",
  "multi-turn testing",
  "agent analytics",
  "custom analytics",
  "custom metric",
  "conversation transcript",
  "Copilot Credits",
  "usage estimator",
  "access review",
  "single sign-on",
  "end-user authentication",
  "data loss prevention",
];

const PROSE_PRODUCT_RE = new RegExp(
  `(?<!\\w)(${[...PROSE_PRODUCT_TERMS]
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"))
    .join("|")})(?!\\w)`,
  "gi",
);
const PROSE_CODE_RE =
  /`((?:@(?:microsoft|azure)\/[\w.-]+|pac\s+[a-z][\w -]{1,30}|power\.config\.json|(?:User|System)\.[A-Z][\w]+|Conversation Start))`/g;
const PROSE_LINK_RE = /\[([^\]]{4,80})\]\((https?:\/\/[^)\s]+)\)/g;
const GENERIC_LINK_LABEL_RE =
  /^(?:microsoft learn|learn|here|link|this link|documentation|official documentation|docs|official docs|guide|read more|more info|overview|reference|source)$/i;

const UI_VERB_RE =
  /\b(?:select|selecting|click|clicking|choose|open|opening|go to|navigate to|navigate|switch to|toggle|turn on|turn off|enable|disable|expand|collapse|add|adding|create|configure|set|use|under|in|on|from|tab|within|press|tap|check|uncheck|review)\b[^.;]{0,30}$/i;
const UI_NOUN_AFTER_RE =
  /^\s*(?:\w+\s+)?(?:tile|button|tab|page|pane|menu|option|setting|settings|toggle|field|drop-?down|dialog|section|node|icon|link|card|panel|blade|checkbox|switch|action|template|connector|trigger|topic|tool|screen|window|list|selector)\b/i;
const NAMING_BEFORE_RE =
  /(?:\b(?:named|called|titled|name it|name the \w+|enter|type|paste|input|e\.g\.|for example|such as|like|say|ask|prompt|sample|try)\b[^.;]{0,25}|\bset (?:the )?(?:name|title|description|value|text|prompt) to)\s*[:"“']?\s*$/i;
const STATE_VALUE_RE = /^(?:on|off|enabled|disabled|true|false|yes|no)$/i;
const PLACEHOLDER_RE = /[<>{}[\]]|^\W*$|^\d+$/;
const REQUIREMENT_RE =
  /\b(?:requires?|required|must have|need(?:s|ed)? (?:a|an)\b|licen[sc]\w*|administrator|admin role|permissions? to|access to)\b/i;
const LIMIT_UNIT_RE =
  /(\d[\d,]*(?:\.\d+)?)\s*(MB|GB|KB|TB|milliseconds?|seconds?|minutes?|mins?|hours?|days?|weeks?|months?|characters?|tokens?|messages?|turns?|items?|rows?|records?|requests?|calls?|agents?|topics?|files?|users?|credits?|environments?|%)(?![\w])/i;
const LIMIT_CUE_RE =
  /\b(?:limit(?:ed|s)?|maximum|max|up to|at most|no more than|at least|minimum|quota|per (?:minute|hour|day|month|user)|retention|expires?|expiry|timeout|capped|allowed|supports? up)\b/i;
// In prose, "preview" is also an ordinary verb ("preview the output"), so only stage wording counts.
const AVAILABILITY_RE =
  /(?:\bpublic preview\b|\bprivate preview\b|\b(?:in|is|are|currently|still)\s+(?:in\s+)?preview\b|\(preview\)|\bpreview (?:feature|capabilit(?:y|ies)|release|only)\b|\bgenerally available\b|\bgeneral availability\b|\bnow GA\b|\(GA\))/i;
const TITLE_AVAILABILITY_RE = /\b(?:[Pp]review|generally available|GA)\b/;

const PRIORITY = Object.fromEntries(CLAIM_KINDS.map((kind, i) => [kind, i]));

function cleanTerm(text) {
  let cleaned = stripMarkdown(text)
    .replace(/^[\s"'“”‘’:.,;-]+|[\s"'“”‘’:.,;-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  while (cleaned.startsWith("(") && cleaned.endsWith(")")) {
    const inner = cleaned.slice(1, -1).trim();
    if (!inner || (inner.includes(")") && !inner.includes("("))) break;
    cleaned = inner;
  }
  cleaned = cleaned.replace(/^\(+/, "");
  if (!cleaned.includes("(")) cleaned = cleaned.replace(/\)+$/, "");
  return cleaned.trim();
}

function isUsableTerm(term, ignore) {
  if (!term || term.length < 2 || term.length > 80) return false;
  if (PLACEHOLDER_RE.test(term)) return false;
  if (term.split(/\s+/).length > 9) return false;
  const lower = term.toLowerCase();
  if (GENERIC_BOLD.has(lower)) return false;
  if (/^step\s*\d/i.test(term)) return false;
  return !ignore.some((word) => lower.includes(word));
}

function boldSpans(text) {
  const spans = [];
  const re = /\*\*([^*]+?)\*\*|(?<![\w*])__([^_]+?)__(?!\w)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    spans.push({ raw: m[1] ?? m[2], index: m.index, end: m.index + m[0].length });
  }
  return spans;
}

function quotedSpans(text) {
  const spans = [];
  const re = /[“"]([^“”"\n]{2,60})[”"]/g;
  let m;
  while ((m = re.exec(text)) !== null) spans.push({ raw: m[1], index: m.index, end: m.index + m[0].length });
  return spans;
}

const PATH_CLAUSE_SPLIT_RE =
  /(?:\.(?=\s|$)|[;!?\n])+|,\s*(?:or|and|then)\b|\b(?:or|and)\s+(?:go|navigate|select|open|choose|click|in|from|under)\b/i;

/** Arrow chains such as "Power Platform admin center → Policies → Data policies". */
function findPaths(text) {
  const plain = stripMarkdown(text);
  const clauses = plain.split(PATH_CLAUSE_SPLIT_RE);
  const paths = [];
  // Walk the arrow-separated pieces within each clause; the first and last pieces are trimmed to the words that belong to the path.
  const trimLead = (piece) => {
    const words = piece.trim().split(/\s+/);
    const verbIdx = words.map((w) => /^(?:to|in|on|from|select|open|click|choose|navigate|go|via|under|then|and)$/i.test(w)).lastIndexOf(true);
    const kept = verbIdx >= 0 ? words.slice(verbIdx + 1) : words.slice(-4);
    while (kept.length > 1 && /^(?:the|a|an|your|this)$/i.test(kept[0])) kept.shift();
    return kept.slice(-5).join(" ");
  };
  const trimTail = (piece) => {
    const words = piece.trim().split(/\s+/);
    const out = [];
    for (const w of words) {
      if (/[.,;:]$/.test(w)) {
        out.push(w.replace(/[.,;:]+$/, ""));
        break;
      }
      if (/^(?:and|then|to|so|where|which|when|if|or|for|you|the|your)$/i.test(w) && out.length) break;
      out.push(w);
      if (out.length >= 5) break;
    }
    return out.join(" ");
  };
  for (const clause of clauses) {
    const parts = clause.split(/\s*(?:→|->|›|»|(?<=\s)>(?=\s))\s*/);
    if (parts.length < 2) continue;
    const chain = [];
    parts.forEach((piece, i) => {
      if (i === 0) {
        chain.push(trimLead(piece));
        return;
      }
      const isLast = i === parts.length - 1;
      chain.push(isLast ? trimTail(piece) : piece.trim().split(/\s+/).slice(0, 5).join(" "));
    });
    paths.push(chain);
  }
  return paths.filter((p) => p.length >= 2 && p.every((s) => s && s.length <= 60));
}

function sentenceOf(text, index) {
  const before = text.slice(0, index);
  const start = Math.max(before.lastIndexOf(". "), before.lastIndexOf("\n")) + 1;
  const rest = text.slice(index);
  const endRel = rest.search(/[.!?](?:\s|$)/);
  return text.slice(start, endRel === -1 ? text.length : index + endRel + 1).trim();
}

/**
 * Extract the verifiable claims in one step.
 *
 * @param {{id:string,title:string,items:Array<{text:string,line:number,kind:string}>}} step
 * @param {{ignoreTerms?:string[], maxClaims?:number}} [options]
 * @returns {{claims:Array, skipped:Array<{text:string,reason:string,line:number}>, truncated:number}}
 */
export function extractClaims(step, { ignoreTerms = [], maxClaims = 12 } = {}) {
  const ignore = ["contoso", ...ignoreTerms.map((t) => String(t).toLowerCase()).filter(Boolean)];
  const found = [];
  const skipped = [];
  const skip = (text, reason, line) => {
    if (skipped.length < 25) skipped.push({ text: cleanTerm(text).slice(0, 80), reason, line });
  };

  const items = [...(step.items || [])];
  // The heading itself can carry availability ("(Preview)") worth checking.
  if (step.title && TITLE_AVAILABILITY_RE.test(step.title)) {
    items.unshift({ text: step.title, line: step.line ?? 0, kind: "title" });
  }

  items.forEach((item) => {
    const text = item.text;
    const line = item.line;
    const context = stripMarkdown(text).slice(0, 220);
    const add = (claim) => found.push({ ...claim, context, line });

    // 1. Navigation paths.
    const pathTerms = new Set();
    for (const segments of findPaths(text)) {
      if (segments.every((s) => isUsableTerm(s, ignore))) {
        add({ kind: "nav-path", term: segments.join(" > "), segments, confidence: "high" });
        segments.forEach((s) => pathTerms.add(normalizeText(s)));
      } else {
        skip(segments.join(" > "), "path contains a placeholder, generic, or lab-specific segment", line);
      }
    }

    // 2. Settings with a value.
    const settingPatterns = [
      /\b(?:set|change|switch|adjust)\s+(?:the\s+)?\*\*([^*]+?)\*\*\s+(?:to|as)\s+(?:\*\*([^*]+?)\*\*|"([^"]+)")/gi,
      /\b(?:select|choose)\s+\*\*([^*]+?)\*\*\s+(?:for|as)\s+(?:the\s+)?\*\*([^*]+?)\*\*/gi,
    ];
    const used = new Set();
    settingPatterns.forEach((re, patternIndex) => {
      let m;
      while ((m = re.exec(text)) !== null) {
        const [setting, value] =
          patternIndex === 0 ? [cleanTerm(m[1]), cleanTerm(m[2] ?? m[3])] : [cleanTerm(m[2]), cleanTerm(m[1])];
        if (!isUsableTerm(setting, ignore) || !isUsableTerm(value, ignore)) continue;
        if (NAMING_BEFORE_RE.test(text.slice(0, m.index))) continue;
        used.add(normalizeText(setting));
        used.add(normalizeText(value));
        add({ kind: "setting", term: `${setting} = ${value}`, terms: [setting, value], confidence: "high" });
      }
    });

    // 3. Named controls: bold (or quoted) text in a UI context.
    const bolds = boldSpans(text);
    for (const span of [...bolds.map((s) => ({ ...s, quoted: false })), ...quotedSpans(text).map((s) => ({ ...s, quoted: true }))]) {
      const term = cleanTerm(span.raw);
      const key = normalizeText(term);
      if (!key || used.has(key) || pathTerms.has(key)) continue;
      if (/→|->|›/.test(span.raw)) continue;
      if (!isUsableTerm(term, ignore)) {
        if (term) skip(term, "placeholder, generic word, or lab-specific name", line);
        continue;
      }
      const before = text.slice(Math.max(0, span.index - 60), span.index);
      const after = text.slice(span.end, span.end + 40);
      if (NAMING_BEFORE_RE.test(before)) {
        skip(term, "value the learner names or types", line);
        continue;
      }
      if (STATE_VALUE_RE.test(term)) continue;
      const uiContext = UI_VERB_RE.test(before) || UI_NOUN_AFTER_RE.test(after);
      // Quoted text is far more often a sample value than a control name.
      if (span.quoted && !uiContext) continue;
      add({ kind: uiContext ? "ui-label" : "term", term, confidence: uiContext ? "high" : "low" });
    }

    // 4. Requirements (roles, licenses, permissions) naming a product or role.
    if (REQUIREMENT_RE.test(text) && item.kind !== "title") {
      const named = boldSpans(text)
        .map((s) => cleanTerm(s.raw))
        .filter((t) => isUsableTerm(t, ignore));
      if (named.length) {
        add({ kind: "requirement", term: named[0], terms: named.slice(0, 3), confidence: "high" });
      } else {
        const m = stripMarkdown(text).match(
          /\b((?:[A-Z][\w-]+(?:\s+[A-Za-z][\w-]*){0,3})\s+(?:administrator|admin|license|maker|contributor|owner|role))\b/,
        );
        if (m && isUsableTerm(m[1], ignore)) add({ kind: "requirement", term: m[1], terms: [m[1]], confidence: "high" });
      }
    }

    // 5. Limits.
    const limit = stripMarkdown(text).match(LIMIT_UNIT_RE);
    if (limit && LIMIT_CUE_RE.test(text)) {
      const subjects = boldSpans(text)
        .map((s) => cleanTerm(s.raw))
        .filter((t) => isUsableTerm(t, ignore) && !LIMIT_UNIT_RE.test(t));
      const words = subjects.length
        ? subjects
        : [
            ...new Set(
              stripMarkdown(text)
                .toLowerCase()
                .match(/[a-z]{5,}/g)
                ?.filter((w) => !/^(?:limit|maximum|minimum|about|should|which|there|their|these|those|within|allowed|before|after|using|where|users?)$/.test(w)) ?? [],
            ),
          ].slice(0, 4);
      if (words.length) {
        add({
          kind: "limit",
          term: `${limit[1]} ${limit[2]}`,
          value: limit[1].replace(/,/g, ""),
          unit: limit[2].toLowerCase(),
          subject: words,
          confidence: subjects.length ? "high" : "low",
        });
      }
    }

    // 6. Availability stage.
    const avail = stripMarkdown(text).match(AVAILABILITY_RE);
    if (avail) {
      const state = /preview/i.test(avail[0]) ? "preview" : "ga";
      const bold = boldSpans(text)
        .map((s) => cleanTerm(s.raw))
        .find((t) => isUsableTerm(t, ignore) && !AVAILABILITY_RE.test(t));
      const subject = bold || cleanTerm(step.group || step.title || "").replace(AVAILABILITY_RE, "").trim();
      if (isUsableTerm(subject, ignore)) {
        add({ kind: "availability", term: subject, state, confidence: "high", sentence: sentenceOf(stripMarkdown(text), avail.index) });
      }
    }
  });

  // 7. Prose fallback: when a section uses plain prose instead of bold UI formatting,
  // extract named external links, official SDK/CLI/system tokens, and recognized product/capability terms.
  if (found.length === 0) {
    extractProseItemClaims(step.items || [], ignore, found);
    if (found.length === 0 && step.title && (step.items || []).length > 0) {
      extractProseItemClaims([{ text: step.title, line: step.line ?? 0, kind: "heading" }], ignore, found);
    }
  }

  // De-duplicate per step by kind + normalized subject as well as cross-kind normalized term,
  // keeping the first/highest-priority occurrence, then cap by priority.
  const byPriority = found
    .map((claim, order) => ({ claim, order }))
    .sort((a, b) => PRIORITY[a.claim.kind] - PRIORITY[b.claim.kind] || a.order - b.order);
  const seen = new Set();
  const ranked = byPriority.filter(({ claim }) => {
    const keys = claimDedupKeys(claim);
    if (keys.some((k) => seen.has(k))) return false;
    for (const k of keys) seen.add(k);
    return true;
  });
  const kept = ranked.slice(0, maxClaims).map((r) => r.claim);
  kept.sort((a, b) => a.line - b.line);
  const claims = kept.map((claim, i) => ({ id: `${step.id}-c${i + 1}`, ...claim }));
  return { claims, skipped, truncated: Math.max(0, ranked.length - kept.length) };
}

function claimDedupKeys(claim) {
  const normTerm = normalizeText(claim.term);
  if (claim.kind === "availability") {
    return [`availability:${normTerm}`];
  }
  if (claim.kind === "limit") {
    const subj = [...new Set((claim.subject || []).map(normalizeText).filter(Boolean))].sort().join("+");
    return subj ? [`limit:${normTerm}:${subj}`, `limit:${normTerm}`] : [`limit:${normTerm}`];
  }
  if (claim.kind === "nav-path") {
    const segs = (claim.segments || [claim.term]).map(normalizeText).join(" > ");
    return [`nav-path:${segs}`, normTerm];
  }
  if (claim.kind === "setting") {
    const pair = (claim.terms || [claim.term]).map(normalizeText).join(" = ");
    return [`setting:${pair}`, normTerm];
  }
  if (claim.kind === "requirement") {
    const req = (claim.terms || [claim.term]).map(normalizeText).join("|");
    return [`requirement:${req}`, `requirement:${normTerm}`, normTerm];
  }
  return [`${claim.kind}:${normTerm}`, normTerm];
}

function extractProseItemClaims(items, ignore, out) {
  const seenProse = new Set();
  const pushUnique = (candidate) => {
    const key = `${candidate.kind}:${normalizeText(candidate.term)}`;
    if (!key || seenProse.has(key)) return;
    seenProse.add(key);
    out.push(candidate);
  };

  for (const item of items) {
    if (!item?.text || item.kind === "title") continue;
    const text = item.text;
    const line = item.line;
    const context = stripMarkdown(text).slice(0, 220);

    let m;
    PROSE_LINK_RE.lastIndex = 0;
    while ((m = PROSE_LINK_RE.exec(text)) !== null) {
      const label = cleanTerm(m[1]);
      if (GENERIC_LINK_LABEL_RE.test(label) || !isUsableTerm(label, ignore)) continue;
      const before = text.slice(Math.max(0, m.index - 60), m.index);
      if (NAMING_BEFORE_RE.test(before)) continue;
      pushUnique({ kind: "term", term: label, confidence: "low", context, line });
    }

    PROSE_CODE_RE.lastIndex = 0;
    while ((m = PROSE_CODE_RE.exec(text)) !== null) {
      const token = m[1].trim();
      if (!isUsableTerm(token, ignore)) continue;
      pushUnique({ kind: "term", term: token, confidence: "low", context, line });
    }

    const plain = stripMarkdown(text);
    PROSE_PRODUCT_RE.lastIndex = 0;
    while ((m = PROSE_PRODUCT_RE.exec(plain)) !== null) {
      const phrase = cleanTerm(m[1]).replace(/-/g, (ch, idx, str) => {
        const lower = str.toLowerCase();
        if (lower === "prompt-node" || lower === "computer-use" || lower === "knowledge-source") return " ";
        return ch;
      });
      if (!isUsableTerm(phrase, ignore)) continue;
      const before = plain.slice(Math.max(0, m.index - 30), m.index);
      if (/\b(?:named|called|titled)\s*[:"“']?\s*$/i.test(before)) continue;
      pushUnique({ kind: "term", term: phrase, confidence: "low", context, line });
    }
  }
}

/** Availability and overview claims from a lab's title and optional Overview section. */
export function extractLabClaims({ title, labId, overview = null, includeOverviewTerms = false, ignoreTerms = [] }) {
  const claims = [];
  const heading = String(title || "");
  if (TITLE_AVAILABILITY_RE.test(heading)) {
    const subject = cleanTerm(
      heading
        .replace(/^[^\p{L}\p{N}]*lab\s*\d+\s*[:—–-]\s*/iu, "")
        .replace(/\(?\b(?:[Pp]review|generally available|GA)\b\)?/g, "")
        .replace(/[—–:-]\s*$/, ""),
    );
    if (subject) {
      const state = /preview/i.test(heading) ? "preview" : "ga";
      claims.push({
        id: `${labId || "lab"}-overview-c1`,
        kind: "availability",
        term: subject,
        state,
        confidence: "high",
        context: stripMarkdown(heading),
        line: 1,
      });
    }
  }

  if (claims.length === 0 && includeOverviewTerms && overview?.items?.length) {
    const ignore = ["contoso", ...ignoreTerms.map((t) => String(t).toLowerCase()).filter(Boolean)];
    const prose = [];
    extractProseItemClaims(overview.items, ignore, prose);
    const seen = new Set();
    for (const candidate of prose) {
      const key = `${candidate.kind}:${normalizeText(candidate.term)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      claims.push({
        ...candidate,
        id: `${labId || "lab"}-overview-c${claims.length + 1}`,
      });
      if (claims.length >= 6) break;
    }
  }

  return { claims, skipped: [], truncated: 0 };
}
