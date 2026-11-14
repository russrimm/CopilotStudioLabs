/**
 * Step validation runner.
 *
 * For each lab: parse steps, extract claims, gather Microsoft Learn evidence,
 * and evaluate every claim with the deterministic matcher. Progress events are
 * emitted per lab and per step so a caller (the portal job, the CLI) can show
 * real progress.
 *
 * Evidence is gathered cheapest-first and only while claims stay unresolved:
 *   1. the Learn pages the lab itself cites (fetched once per lab)
 *   2. a targeted Learn search for the step (title + key terms)
 *   3. a second search on the still-unresolved terms
 *   4. the single most relevant search hit, fetched in full
 *
 * Failure policy: a claim that is still unresolved after a failed lookup is
 * `unable`, never `unverified` and never `verified`. Only a claim whose lookups
 * all succeeded can be reported as unverified.
 */

import { extractClaims, extractLabClaims } from "./claims.js";
import { buildEvidence, evaluateClaim } from "./matcher.js";
import { buildReport, combineChecks, countClaims, labStatus, stepStatus } from "./report.js";
import { parseLabSteps } from "./steps.js";
import { canonicalLearnUrl, isLearnUrl, sanitizeExcerpt } from "./text.js";

const DEFAULTS = Object.freeze({
  maxCitedPages: 6,
  maxClaimsPerStep: 12,
  maxSearchesPerStep: 2,
  maxPagesPerStep: 1,
  maxQueryChars: 180,
});

/** Learn pages a lab links to in prose (code blocks and images are ignored). */
export function extractLearnLinks(markdown) {
  const withoutCode = String(markdown || "")
    .replace(/(^|\n)\s*(`{3,}|~{3,})[\s\S]*?\n\s*\2[^\n]*/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  const found = new Map();
  const re = /https:\/\/learn\.microsoft\.com\/[^\s)<>"'\]]+/gi;
  let m;
  while ((m = re.exec(withoutCode)) !== null) {
    const url = m[0].replace(/[.,;:!?'"*_]+$/, "");
    if (!isLearnUrl(url)) continue;
    const key = canonicalLearnUrl(url);
    if (!found.has(key)) found.set(key, url.split("#")[0]);
  }
  return [...found.values()];
}

function firstProduct(lab) {
  const raw = Array.isArray(lab.products) ? lab.products[0] : String(lab.products || "").split(",")[0];
  const product = String(raw || "").replace(/[`*]/g, "").trim();
  return product || "Microsoft Copilot Studio";
}

function queryTerm(claim) {
  if (claim.kind === "nav-path") return claim.segments.at(-1);
  if (claim.kind === "setting") return claim.terms[0];
  return claim.term;
}

function buildQuery(parts, max) {
  const seen = new Set();
  const words = [];
  for (const part of parts) {
    for (const word of String(part || "").replace(/[^\p{L}\p{N}'+. -]+/gu, " ").split(/\s+/)) {
      const key = word.toLowerCase();
      if (!word || seen.has(key)) continue;
      seen.add(key);
      words.push(word);
    }
  }
  return words.join(" ").slice(0, max).trim();
}

function toClaimResult(claim, verdict) {
  return {
    id: claim.id,
    kind: claim.kind,
    term: claim.term,
    confidence: claim.confidence,
    line: claim.line,
    context: claim.context,
    status: verdict.status,
    rule: verdict.rule,
    explanation: verdict.explanation,
    evidence: verdict.evidence || [],
  };
}

const isResolved = (verdict) => verdict.status === "verified" || verdict.status === "stale";

/**
 * Validate one lab's steps against Learn.
 *
 * @param {{labId:string,title:string,markdown:string,products?:string[]|string}} lab
 * @param {{learn:object, onProgress?:Function, signal?:AbortSignal, ignoreTerms?:string[], limits?:object, labIndex?:number, labTotal?:number}} options
 */
export async function validateLabSteps(lab, { learn, onProgress, signal, ignoreTerms = [], limits = {}, labIndex = 1, labTotal = 1 } = {}) {
  const cfg = { ...DEFAULTS, ...limits };
  const emit = (event) => onProgress?.({ labId: lab.labId, title: lab.title, labIndex, labTotal, ...event });
  const throwIfAborted = () => {
    if (signal?.aborted) throw new DOMException("Operation canceled", "AbortError");
  };

  const parsed = parseLabSteps(lab.markdown);
  const units = [];
  const hasExplicitStepClaims = parsed.steps.some((step) =>
    extractClaims(step, { ignoreTerms, maxClaims: cfg.maxClaimsPerStep }).claims.some((c) => c.confidence === "high"),
  );
  const overview = extractLabClaims({
    title: lab.title,
    labId: lab.labId,
    overview: parsed.overview,
    includeOverviewTerms: !hasExplicitStepClaims,
    ignoreTerms,
  });
  if (overview.claims.length) {
    units.push({
      step: { id: "overview", index: 0, ordinal: null, title: "Lab overview", group: null, line: parsed.overview?.line ?? 1, items: [] },
      preset: overview,
    });
  }
  if (parsed.prerequisites) units.push({ step: parsed.prerequisites });
  for (const step of parsed.steps) units.push({ step });

  const notes = [];
  if (!parsed.steps.length) {
    notes.push(
      "No step-by-step instructions were found in index.md (it may link to a separate guide), so only prerequisites and the title were checked.",
    );
  }
  emit({ type: "lab-start", stepTotal: units.length, message: `Checking ${units.length} section(s)` });

  // The lab's own cited pages are the most authoritative evidence for its claims.
  const citedDocs = [];
  const citedPages = [];
  const links = extractLearnLinks(lab.markdown).slice(0, cfg.maxCitedPages);
  const pageDocs = new Map();
  if (units.length && links.length) {
    for (const url of links) {
      throwIfAborted();
      emit({ type: "progress", message: `Reading cited page ${sanitizeExcerpt(url, 90)}` });
      const page = await learn.fetchPage(url);
      citedPages.push({ url, ok: page.ok, error: page.ok ? null : sanitizeExcerpt(page.error, 160) });
      if (page.ok) {
        const doc = buildEvidence({ url, title: url, text: page.markdown, source: "cited-page" });
        citedDocs.push(doc);
        pageDocs.set(canonicalLearnUrl(url), doc);
      }
    }
    if (citedPages.some((p) => !p.ok)) {
      notes.push(`${citedPages.filter((p) => !p.ok).length} cited Learn page(s) could not be read; see citedPages.`);
    }
  }

  const product = firstProduct(lab);
  const stepResults = [];

  for (let i = 0; i < units.length; i += 1) {
    throwIfAborted();
    const { step, preset } = units[i];
    const extracted = preset || extractClaims(step, { ignoreTerms, maxClaims: cfg.maxClaimsPerStep });
    const claims = extracted.claims;
    const stepText = [step.title, ...(step.items || []).map((item) => item.text)].filter(Boolean).join("\n");
    emit({ type: "step-start", stepId: step.id, stepIndex: i + 1, stepTotal: units.length, stepTitle: step.title, message: `Checking ${claims.length} claim(s)` });

    const docs = [...citedDocs];
    const queries = [];
    const pagesFetched = [];
    let stepLookupFailed = false;
    let lastFailure = null;
    const verdicts = new Map();
    let pending = claims.slice();

    const evaluatePending = () => {
      const stillPending = [];
      for (const claim of pending) {
        const verdict = evaluateClaim(claim, docs, { claim, stepText, labText: lab.markdown || "" });
        verdicts.set(claim.id, verdict);
        if (!isResolved(verdict)) stillPending.push(claim);
      }
      pending = stillPending;
    };
    const unresolvedHigh = () => pending.filter((c) => c.confidence === "high");

    if (claims.length) {
      evaluatePending();

      let searches = 0;
      let lastSearchResults = [];
      while (pending.length && searches < (unresolvedHigh().length ? cfg.maxSearchesPerStep : 1)) {
        throwIfAborted();
        const unresolved = unresolvedHigh().length ? unresolvedHigh() : pending;
        const query =
          searches === 0
            ? buildQuery([product, step.title, ...unresolved.slice(0, 2).map(queryTerm)], cfg.maxQueryChars)
            : buildQuery([product, ...unresolved.slice(0, 3).map(queryTerm)], cfg.maxQueryChars);
        if (!query || queries.includes(query)) break;
        queries.push(query);
        searches += 1;
        emit({ type: "progress", stepId: step.id, stepIndex: i + 1, stepTotal: units.length, message: `Searching Learn: ${sanitizeExcerpt(query, 100)}` });
        const result = await learn.search(query);
        if (!result.ok) {
          stepLookupFailed = true;
          lastFailure = result.error;
          if (result.code === "circuit-open" || result.code === "budget") break;
          continue;
        }
        lastSearchResults = result.results;
        for (const hit of result.results) {
          docs.push(buildEvidence({ url: hit.url, title: hit.title, text: hit.excerpt, source: "search" }));
        }
        evaluatePending();
      }

      if (unresolvedHigh().length && cfg.maxPagesPerStep > 0) {
        const candidates = lastSearchResults
          .filter((hit) => !pageDocs.has(canonicalLearnUrl(hit.url)))
          .slice(0, cfg.maxPagesPerStep);
        for (const hit of candidates) {
          throwIfAborted();
          emit({ type: "progress", stepId: step.id, stepIndex: i + 1, stepTotal: units.length, message: `Reading ${sanitizeExcerpt(hit.title, 80)}` });
          const page = await learn.fetchPage(hit.url);
          if (!page.ok) {
            stepLookupFailed = true;
            lastFailure = page.error;
            continue;
          }
          const doc = buildEvidence({ url: hit.url, title: hit.title, text: page.markdown, source: "page" });
          pageDocs.set(canonicalLearnUrl(hit.url), doc);
          pagesFetched.push(hit.url);
          docs.push(doc);
        }
        if (candidates.length) evaluatePending();
      }
    }

    const claimResults = claims.map((claim) => {
      let verdict = verdicts.get(claim.id);
      if (!isResolved(verdict) && stepLookupFailed) {
        verdict = {
          status: "unable",
          rule: "lookup-failed",
          explanation: `A Microsoft Learn lookup failed (${sanitizeExcerpt(lastFailure || "unknown error", 140)}), so this claim could not be fully checked. This is not a pass.`,
          evidence: verdict.evidence || [],
        };
      }
      return toClaimResult(claim, verdict);
    });

    const docsStatus = claims.length ? stepStatus(claimResults) : "no-claims";
    const checks = {
      docs: {
        status: docsStatus,
        claims: claimResults,
        skipped: extracted.skipped,
        truncated: extracted.truncated,
        queries,
        pagesFetched,
      },
      live: { status: "not-run" },
    };
    const result = {
      id: step.id,
      number: step.ordinal ?? null,
      title: step.title,
      group: step.group ?? null,
      line: step.line ?? null,
      status: combineChecks(checks),
      counts: countClaims(claimResults),
      checks,
    };
    stepResults.push(result);
    emit({ type: "step-done", stepId: step.id, stepIndex: i + 1, stepTotal: units.length, stepTitle: step.title, status: result.status, step: result });
  }

  const labResult = {
    labId: lab.labId,
    title: lab.title,
    status: labStatus(stepResults, units.length > 0),
    stepSource: parsed.source,
    citedPages,
    notes,
    steps: stepResults,
  };
  const finalReport = buildReport({ labs: [labResult], source: null });
  emit({ type: "lab-done", status: labResult.status, lab: finalReport.labs[0] });
  return finalReport.labs[0];
}

/**
 * Validate several labs in order and return a full report.
 *
 * @param {Array} labs [{labId,title,markdown,products}]
 * @param {{learn:object, onProgress?:Function, signal?:AbortSignal, ignoreTerms?:string[], limits?:object}} options
 */
export async function validateLabs(labs, { learn, onProgress, signal, ignoreTerms, limits } = {}) {
  const results = [];
  let canceled = false;
  try {
    for (let i = 0; i < labs.length; i += 1) {
      if (signal?.aborted) throw new DOMException("Operation canceled", "AbortError");
      results.push(
        await validateLabSteps(labs[i], { learn, onProgress, signal, ignoreTerms, limits, labIndex: i + 1, labTotal: labs.length }),
      );
    }
  } catch (err) {
    if (err?.name !== "AbortError") throw err;
    canceled = true;
  }
  const report = buildReport({ labs: results, source: { endpoint: learn.endpoint, ...learn.status() }, canceled });
  onProgress?.({ type: "run-done", labTotal: labs.length, summary: report.summary, canceled });
  return report;
}
