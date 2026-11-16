/**
 * Canonical Microsoft Learn URL normalization, citation label formatting,
 * source deduplication, and relevance-matched reference selection.
 *
 * Pure and dependency-free (Node built-ins only) so every lab-builder module
 * shares one consistent rule for deduplicating Learn pages across `#fragment`
 * section chunks, `/en-us/` locale prefixes, trailing slashes, and duplicate
 * visible page titles.
 */

const LEARN_HOSTS = new Set(["learn.microsoft.com", "docs.microsoft.com"]);

const LEARN_TERM_CASE = new Map([
  ["ai", "AI"],
  ["mcp", "MCP"],
  ["mcps", "MCPs"],
  ["api", "API"],
  ["apis", "APIs"],
  ["sso", "SSO"],
  ["dlp", "DLP"],
  ["rbac", "RBAC"],
  ["alm", "ALM"],
  ["m365", "M365"],
  ["rest", "REST"],
  ["oauth", "OAuth"],
  ["http", "HTTP"],
  ["https", "HTTPS"],
  ["json", "JSON"],
  ["sql", "SQL"],
  ["url", "URL"],
  ["urls", "URLs"],
  ["ui", "UI"],
  ["ux", "UX"],
  ["cli", "CLI"],
  ["sdk", "SDK"],
  ["sdks", "SDKs"],
  ["ide", "IDE"],
  ["ides", "IDEs"],
  ["pr", "PR"],
  ["prs", "PRs"],
  ["gpt", "GPT"],
  ["nlu", "NLU"],
  ["faq", "FAQ"],
  ["faqs", "FAQs"],
  ["cua", "CUA"],
  ["iva", "IVA"],
  ["ivr", "IVR"],
  ["sap", "SAP"],
  ["fhir", "FHIR"],
  ["a2a", "A2A"],
  ["byom", "BYOM"],
  ["vnet", "VNet"],
  ["vnets", "VNets"],
  ["entra", "Entra"],
  ["id", "ID"],
  ["sharepoint", "SharePoint"],
  ["onedrive", "OneDrive"],
  ["onenote", "OneNote"],
  ["dataverse", "Dataverse"],
  ["powerfx", "Power Fx"],
  ["powershell", "PowerShell"],
  ["github", "GitHub"],
  ["openapi", "OpenAPI"],
  ["graphql", "GraphQL"],
  ["servicenow", "ServiceNow"],
  ["dynamics365", "Dynamics 365"],
  ["copilot", "Copilot"],
  ["microsoft", "Microsoft"],
  ["azure", "Azure"],
  ["foundry", "Foundry"],
  ["teams", "Teams"],
  ["vscode", "VS Code"],
  ["javascript", "JavaScript"],
  ["typescript", "TypeScript"],
  ["nodejs", "Node.js"],
  ["yaml", "YAML"],
  ["xml", "XML"],
  ["csv", "CSV"],
  ["html", "HTML"],
  ["css", "CSS"],
  ["pdf", "PDF"],
  ["docx", "DOCX"],
  ["pptx", "PPTX"],
  ["jwt", "JWT"],
  ["saml", "SAML"],
  ["oidc", "OIDC"],
  ["pii", "PII"],
  ["phi", "PHI"],
]);

const MINOR_TITLE_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "nor",
  "of",
  "on",
  "or",
  "per",
  "the",
  "to",
  "up",
  "via",
  "vs",
  "with",
]);

const GENERIC_LEARN_SLUGS = new Set([
  "overview",
  "index",
  "quickstart",
  "get-started",
  "getting-started",
  "whats-new",
  "faq",
  "faqs",
  "introduction",
  "readme",
]);

const STRUCTURAL_PATH_SEGMENTS = new Set([
  "concepts",
  "how-to",
  "quickstarts",
  "tutorials",
  "guidance",
  "reference",
  "includes",
]);

const TRACKING_QUERY_PARAMS = new Set([
  "wt.mc_id",
  "ocid",
  "tabs",
  "pivots",
  "source",
  "ns-enrollment-type",
  "ns-enrollment-id",
]);

const STOPWORDS = new Set([
  "a",
  "about",
  "after",
  "all",
  "also",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "before",
  "between",
  "both",
  "build",
  "by",
  "can",
  "check",
  "choose",
  "click",
  "confirm",
  "copilot",
  "create",
  "does",
  "each",
  "following",
  "for",
  "from",
  "how",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "lab",
  "learn",
  "make",
  "microsoft",
  "module",
  "more",
  "most",
  "new",
  "not",
  "of",
  "on",
  "one",
  "only",
  "open",
  "or",
  "page",
  "select",
  "should",
  "so",
  "step",
  "studio",
  "such",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "these",
  "this",
  "through",
  "to",
  "use",
  "used",
  "using",
  "when",
  "where",
  "which",
  "why",
  "with",
  "work",
  "working",
  "you",
  "your",
]);

function stripLearnSuffix(title) {
  return String(title || "")
    .replace(/\s*[|—–-]\s*Microsoft Learn\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isMicrosoftLearnUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    return LEARN_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Normalize a documentation URL to its clean article-level form.
 *
 * On Microsoft Learn (`learn.microsoft.com` / `docs.microsoft.com`), strips
 * locale segments like `/en-us/`, removes `#fragment` section anchors (unless
 * `keepFragment: true`), removes tracking/tab query parameters while keeping
 * meaningful parameters such as `view`, and strips trailing slashes.
 */
export function canonicalLearnUrl(rawUrl, { keepFragment = false } = {}) {
  const trimmed = String(rawUrl || "").trim();
  if (!trimmed) return "";

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return trimmed;
  }

  const host = parsed.hostname.toLowerCase();
  const isLearn = LEARN_HOSTS.has(host);
  parsed.protocol = isLearn ? "https:" : parsed.protocol.toLowerCase();
  parsed.hostname = isLearn ? "learn.microsoft.com" : host;

  let pathname = parsed.pathname.replace(/\/{2,}/g, "/");
  if (isLearn) {
    pathname = pathname.replace(/^\/[a-z]{2}-[a-z]{2,4}(?=\/|$)/i, "") || "/";
  }
  if (pathname.length > 1) {
    pathname = pathname.replace(/\/+$/, "");
  }
  parsed.pathname = pathname || "/";

  const entries = [];
  for (const [key, val] of parsed.searchParams.entries()) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.startsWith("utm_") || TRACKING_QUERY_PARAMS.has(lowerKey)) continue;
    entries.push([key, val]);
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  parsed.search = "";
  for (const [key, val] of entries) {
    parsed.searchParams.append(key, val);
  }

  if (!keepFragment) {
    parsed.hash = "";
  }

  return parsed.toString();
}

/**
 * Stable comparison key for identifying whether two URLs point to the same
 * documentation article.
 *
 * On Microsoft Learn, two URLs that differ only by `#fragment`, `/en-us/`
 * locale prefix, trailing slash, or `?view=` moniker map to the same page key.
 */
export function canonicalLearnPageKey(rawUrl) {
  const normalized = canonicalLearnUrl(rawUrl, { keepFragment: false });
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    if (LEARN_HOSTS.has(parsed.hostname.toLowerCase())) {
      return `https://learn.microsoft.com${parsed.pathname.toLowerCase()}`;
    }
    return normalized.toLowerCase();
  } catch {
    return normalized.toLowerCase();
  }
}

export function isExplicitHumanTitle(title, url) {
  const cleaned = stripLearnSuffix(title);
  if (!cleaned) return false;
  if (url && cleaned.toLowerCase() === String(url).trim().toLowerCase()) return false;
  if (/^https?:\/\//i.test(cleaned)) return false;
  return true;
}

/**
 * Human-readable citation label for a source `{ title, url }` or URL string.
 * Falls back to a readable title derived from the URL's final path slug when
 * only a bare URL is available.
 */
export function formatCitationLabel(source, scrub = (s) => String(s ?? "")) {
  const obj = typeof source === "string" ? { title: "", url: source } : source || {};
  const url = String(obj.url || "").trim();
  const cleanedTitle = stripLearnSuffix(obj.title);
  if (isExplicitHumanTitle(cleanedTitle, url)) {
    return scrub(cleanedTitle);
  }

  let slug = "";
  try {
    const canonical = canonicalLearnUrl(url) || url;
    const pathname = new URL(canonical).pathname.replace(/\/+$/, "");
    slug = decodeURIComponent(pathname.slice(pathname.lastIndexOf("/") + 1));
  } catch {
    /* fallback below */
  }
  const words = slug.replace(/\.[a-z]+$/i, "").replace(/[-_]+/g, " ").trim();
  return scrub(
    words ? `Microsoft Learn: ${words.charAt(0).toUpperCase()}${words.slice(1)}` : "Microsoft Learn page",
  );
}

/**
 * Normalized key for comparing visible citation titles so identical labels
 * never appear twice in the same reference list.
 */
export function normalizeCitationTitleKey(label) {
  return stripLearnSuffix(label)
    .toLowerCase()
    .replace(/^microsoft learn:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function chooseBetterUrl(existingUrl, candidateUrl) {
  const cleanExisting = canonicalLearnUrl(existingUrl, { keepFragment: false });
  const cleanCandidate = canonicalLearnUrl(candidateUrl, { keepFragment: false });
  if (!cleanExisting) return cleanCandidate;
  if (!cleanCandidate) return cleanExisting;
  // Preserve explicit `?view=` moniker when curated docUrls carry one.
  if (!cleanExisting.includes("?view=") && cleanCandidate.includes("?view=")) {
    return cleanCandidate;
  }
  return cleanExisting;
}

function chooseBetterTitle(existingTitle, existingUrl, candidateTitle, candidateUrl) {
  const existingHuman = isExplicitHumanTitle(existingTitle, existingUrl);
  const candidateHuman = isExplicitHumanTitle(candidateTitle, candidateUrl);
  const cleanExisting = stripLearnSuffix(existingTitle);
  const cleanCandidate = stripLearnSuffix(candidateTitle);
  if (existingHuman && !candidateHuman) return cleanExisting;
  if (!existingHuman && candidateHuman) return cleanCandidate;
  if (existingHuman && candidateHuman) {
    const existingPrefixed = /^microsoft learn:\s*/i.test(cleanExisting);
    const candidatePrefixed = /^microsoft learn:\s*/i.test(cleanCandidate);
    if (existingPrefixed && !candidatePrefixed) return cleanCandidate;
    if (!existingPrefixed && candidatePrefixed) return cleanExisting;
    return cleanCandidate.length > cleanExisting.length ? cleanCandidate : cleanExisting;
  }
  return cleanExisting || cleanCandidate;
}

/**
 * Deduplicate documentation sources by BOTH canonical article URL and
 * normalized visible citation title, merging metadata so the cleanest
 * fragment-free URL and richest human-readable title win.
 *
 * @param {Array<string|{title?:string,url?:string,excerpt?:string}>} rawSources
 * @param {{maxItems?:number, scrub?:(s:string)=>string}} [options]
 * @returns {Array<{title:string,url:string,excerpt?:string}>}
 */
export function dedupeLearnSources(rawSources, { maxItems = Infinity, scrub = (s) => String(s ?? "") } = {}) {
  if (!Array.isArray(rawSources) || !rawSources.length) return [];

  const byPageKey = new Map();
  const pageOrder = [];

  for (const raw of rawSources) {
    const item = typeof raw === "string" ? { title: raw, url: raw } : raw;
    if (!item || typeof item !== "object") continue;
    const rawUrl = String(item.url || "").trim();
    const cleanUrl = canonicalLearnUrl(rawUrl, { keepFragment: false });
    if (!cleanUrl) continue;

    const pageKey = canonicalLearnPageKey(cleanUrl);
    if (!pageKey) continue;

    if (!byPageKey.has(pageKey)) {
      const normalizedTitle = isExplicitHumanTitle(item.title, rawUrl)
        ? stripLearnSuffix(item.title)
        : cleanUrl;
      const entry = {
        ...item,
        title: normalizedTitle,
        url: cleanUrl,
      };
      byPageKey.set(pageKey, entry);
      pageOrder.push(pageKey);
    } else {
      const existing = byPageKey.get(pageKey);
      const mergedUrl = chooseBetterUrl(existing.url, cleanUrl);
      const mergedTitle = chooseBetterTitle(existing.title, existing.url, item.title, rawUrl);
      existing.url = mergedUrl;
      existing.title = mergedTitle || mergedUrl;
      if (!existing.excerpt && item.excerpt) {
        existing.excerpt = item.excerpt;
      }
    }
  }

  // Second pass: deduplicate by visible citation title so two distinct URLs
  // that render the exact same link label never duplicate in a list.
  const byTitleKey = new Map();
  const finalEntries = [];

  for (const pageKey of pageOrder) {
    const entry = byPageKey.get(pageKey);
    const visibleLabel = formatCitationLabel(entry, scrub);
    const titleKey = normalizeCitationTitleKey(visibleLabel);
    if (!titleKey) continue;

    if (!byTitleKey.has(titleKey)) {
      byTitleKey.set(titleKey, entry);
      finalEntries.push(entry);
    } else {
      const prev = byTitleKey.get(titleKey);
      prev.url = chooseBetterUrl(prev.url, entry.url);
      prev.title = chooseBetterTitle(prev.title, prev.url, entry.title, entry.url) || prev.url;
      if (!prev.excerpt && entry.excerpt) prev.excerpt = entry.excerpt;
    }
  }

  return Number.isFinite(maxItems) ? finalEntries.slice(0, maxItems) : finalEntries;
}

function tokenizeForMatch(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

/**
 * Select the single best-matching Microsoft Learn source for a quiz question,
 * answer explanation, or specific point of interest.
 *
 * Scores candidate sources by keyword overlap across the source's title, URL
 * path segments, and optional search excerpt, falling back deterministically
 * to the module's primary Microsoft Learn source.
 *
 * @param {Array<string|{title?:string,url?:string,excerpt?:string}>} sources
 * @param {string|string[]} textHints
 * @param {{fallbackUrls?:string[], results?:Array<{title?:string,url?:string,excerpt?:string}>, scrub?:(s:string)=>string}} [options]
 * @returns {{title:string, label:string, url:string}|null}
 */
export function selectRelevantLearnSource(sources, textHints = [], options = {}) {
  const { fallbackUrls = [], results = [], scrub = (s) => String(s ?? "") } = options;
  const resultExcerptsByKey = new Map();
  for (const r of results || []) {
    if (!r?.url || !r?.excerpt) continue;
    const key = canonicalLearnPageKey(r.url);
    const prev = resultExcerptsByKey.get(key) || "";
    if (r.excerpt.length > prev.length) resultExcerptsByKey.set(key, r.excerpt);
  }

  const combinedRaw = [
    ...(Array.isArray(sources) ? sources : []),
    ...(Array.isArray(fallbackUrls) ? fallbackUrls.map((url) => ({ title: url, url })) : []),
  ];
  const candidates = dedupeLearnSources(combinedRaw, { scrub }).filter((item) => isMicrosoftLearnUrl(item.url));
  const pool = candidates.length ? candidates : dedupeLearnSources(combinedRaw, { scrub });
  if (!pool.length) return null;

  const hintList = Array.isArray(textHints) ? textHints : [textHints];
  const queryTokens = new Set(tokenizeForMatch(hintList.join(" ")));

  let best = pool[0];
  let bestScore = -1;

  pool.forEach((candidate, idx) => {
    const label = formatCitationLabel(candidate, scrub);
    const pageKey = canonicalLearnPageKey(candidate.url);
    const excerpt = candidate.excerpt || resultExcerptsByKey.get(pageKey) || "";
    let urlPathWords = "";
    try {
      urlPathWords = new URL(candidate.url).pathname.replace(/[\/_-]+/g, " ");
    } catch {
      urlPathWords = candidate.url;
    }

    const titleTokens = new Set(tokenizeForMatch(`${label} ${urlPathWords}`));
    const excerptTokens = new Set(tokenizeForMatch(excerpt));

    let score = 0;
    for (const token of queryTokens) {
      if (titleTokens.has(token)) score += 3;
      else if (excerptTokens.has(token)) score += 1;
    }
    // Slight tie-breaker for earlier (higher-ranked) module sources.
    score += Math.max(0, 0.25 - idx * 0.05);

    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  });

  return {
    title: best.title,
    label: formatCitationLabel(best, scrub),
    url: best.url,
  };
}

/**
 * Validate that a raw URL is strictly `https://learn.microsoft.com/...` with no
 * credentials, custom port, or unsafe characters, then return its canonical
 * Microsoft Learn URL. Rejects `http:`, `javascript:`, `docs.microsoft.com`,
 * and all third-party domains.
 */
export function strictHttpsLearnUrl(rawUrl) {
  if (typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || /[\s<>"'`\u0000-\u001f]/.test(trimmed)) return null;

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password || parsed.port) return null;
  if (parsed.hostname.toLowerCase() !== "learn.microsoft.com") return null;

  const clean = canonicalLearnUrl(trimmed, { keepFragment: false });
  if (!clean || !clean.startsWith("https://learn.microsoft.com/")) return null;
  try {
    const cleanParsed = new URL(clean);
    if (!cleanParsed.pathname || cleanParsed.pathname === "/") return null;
  } catch {
    return null;
  }
  return clean;
}

function learnPathSegments(url) {
  try {
    const pathname = new URL(url).pathname
      .replace(/^\/[a-z]{2}-[a-z]{2,4}(?=\/|$)/i, "")
      .replace(/\/+$/, "");
    return pathname
      .split("/")
      .filter(Boolean)
      .map((seg) => {
        try {
          return decodeURIComponent(seg);
        } catch {
          return seg;
        }
      });
  } catch {
    return [];
  }
}

function humanizeLearnSegment(segment) {
  const cleaned = String(segment || "")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  if (!cleaned) return "";
  const words = cleaned.split(/\s+/);
  return words
    .map((word, idx) => {
      const lower = word.toLowerCase();
      if (LEARN_TERM_CASE.has(lower)) return LEARN_TERM_CASE.get(lower);
      if (idx > 0 && idx < words.length - 1 && MINOR_TITLE_WORDS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

/**
 * Derive a concise, human-readable US English article title from a Microsoft
 * Learn URL slug, capitalizing known technical acronyms and product names.
 */
export function formatLearnSlugTitle(rawUrl) {
  const segments = learnPathSegments(rawUrl);
  if (!segments.length) return "Microsoft Learn Documentation";
  const leaf = segments[segments.length - 1];
  const leafClean = leaf.replace(/\.[a-z0-9]+$/i, "").toLowerCase();
  const leafTitle = humanizeLearnSegment(leaf);
  if (!leafTitle) return "Microsoft Learn Documentation";

  if (GENERIC_LEARN_SLUGS.has(leafClean) && segments.length >= 2) {
    let parentIdx = segments.length - 2;
    while (parentIdx > 0 && STRUCTURAL_PATH_SEGMENTS.has(segments[parentIdx].toLowerCase())) {
      parentIdx -= 1;
    }
    const parentTitle = humanizeLearnSegment(segments[parentIdx]);
    if (parentTitle && parentTitle.toLowerCase() !== leafTitle.toLowerCase()) {
      return `${parentTitle}: ${leafTitle}`;
    }
  }

  return leafTitle;
}

/**
 * Collect, validate, canonicalize, deduplicate, and label all
 * `https://learn.microsoft.com/...` links associated with a catalog feature
 * and/or dynamic Microsoft Learn topic.
 *
 * @param {object|null|undefined} feature
 * @param {object|null|undefined} [dynamicTopic]
 * @returns {Array<{url: string, title: string}>}
 */
export function extractFeatureLearnLinks(feature, dynamicTopic = null) {
  const dyn = dynamicTopic || feature?.learnTopic || feature?.learn || null;
  const rawCandidates = [];

  const primaryDynUrl =
    typeof dyn?.url === "string"
      ? dyn.url
      : Array.isArray(dyn?.urls) && typeof dyn.urls[0] === "string"
      ? dyn.urls[0]
      : null;
  const primaryDynTitle =
    dyn?.title ||
    (primaryDynUrl && (dynamicTopic || feature?.learnTopic || feature?.source === "learn") ? feature?.name : "") ||
    "";

  if (primaryDynUrl) {
    rawCandidates.push({ url: primaryDynUrl, title: primaryDynTitle });
  }

  if (Array.isArray(dyn?.subtopics)) {
    for (const sub of dyn.subtopics) {
      if (sub && typeof sub === "object" && sub.url) {
        rawCandidates.push({ url: sub.url, title: sub.title || "" });
      }
    }
  }

  if (Array.isArray(dyn?.urls)) {
    for (const url of dyn.urls) {
      rawCandidates.push({ url, title: "" });
    }
  }

  if (Array.isArray(feature?.learnLinks)) {
    for (const link of feature.learnLinks) {
      if (link && typeof link === "object" && link.url) {
        rawCandidates.push({ url: link.url, title: link.title || "" });
      }
    }
  }

  if (Array.isArray(feature?.docUrls)) {
    for (const url of feature.docUrls) {
      rawCandidates.push({ url, title: "" });
    }
  }

  if (typeof feature?.verifiedAgainst === "string" && feature.verifiedAgainst) {
    rawCandidates.push({ url: feature.verifiedAgainst, title: "" });
  }

  const byPageKey = new Map();
  const pageOrder = [];

  for (const candidate of rawCandidates) {
    const cleanUrl = strictHttpsLearnUrl(candidate?.url);
    if (!cleanUrl) continue;
    const pageKey = canonicalLearnPageKey(cleanUrl);
    if (!pageKey) continue;

    const explicitTitle = isExplicitHumanTitle(candidate.title, candidate.url)
      ? stripLearnSuffix(candidate.title)
      : "";

    if (!byPageKey.has(pageKey)) {
      byPageKey.set(pageKey, { url: cleanUrl, explicitTitle });
      pageOrder.push(pageKey);
    } else {
      const prev = byPageKey.get(pageKey);
      prev.url = chooseBetterUrl(prev.url, cleanUrl);
      if (!prev.explicitTitle && explicitTitle) {
        prev.explicitTitle = explicitTitle;
      } else if (prev.explicitTitle && explicitTitle) {
        prev.explicitTitle = chooseBetterTitle(prev.explicitTitle, prev.url, explicitTitle, cleanUrl);
      }
    }
  }

  const results = pageOrder.map((key) => {
    const entry = byPageKey.get(key);
    return {
      url: entry.url,
      title: entry.explicitTitle || formatLearnSlugTitle(entry.url),
    };
  });

  // Disambiguate any distinct Learn URLs on the same topic that share the same visible title.
  const groupsByTitle = new Map();
  results.forEach((item, index) => {
    const norm = item.title.toLowerCase();
    if (!groupsByTitle.has(norm)) groupsByTitle.set(norm, []);
    groupsByTitle.get(norm).push(index);
  });

  for (const indices of groupsByTitle.values()) {
    if (indices.length < 2) continue;
    const segLists = indices.map((idx) => learnPathSegments(results[idx].url).slice(0, -1));
    for (let pos = 0; pos < indices.length; pos += 1) {
      const idx = indices[pos];
      const ownSegs = segLists[pos];
      let qualifier = "";
      for (let depth = ownSegs.length - 1; depth >= 0; depth -= 1) {
        const candidateSeg = ownSegs[depth];
        if (STRUCTURAL_PATH_SEGMENTS.has(candidateSeg.toLowerCase())) continue;
        const differsFromSome = segLists.some(
          (otherSegs, otherPos) =>
            otherPos !== pos &&
            (otherSegs[otherSegs.length - (ownSegs.length - depth)] || "").toLowerCase() !==
              candidateSeg.toLowerCase(),
        );
        if (differsFromSome) {
          qualifier = humanizeLearnSegment(candidateSeg);
          break;
        }
      }
      if (!qualifier && ownSegs.length) {
        qualifier = ownSegs.map(humanizeLearnSegment).filter(Boolean).join(" / ");
      }
      if (qualifier) {
        results[idx].title = `${results[idx].title} (${qualifier})`;
      }
    }
  }

  return results;
}
