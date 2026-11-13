/**
 * Lab quality assessment.
 *
 * Runs on a composed lab's Markdown after generation and reports a 0-100 quality
 * score, a completeness checklist per module, and actionable findings. It never
 * blocks generation: the validators decide whether a lab is well formed, this
 * decides how good it is, and surfaces what to fix.
 *
 * The module is dependency-free and deterministic (the same Markdown always
 * yields the same report) so it can run in the offline CLI, in the portal, and
 * against hand-written labs. Time estimates are checked for consistency only;
 * nothing here ever asks for content to be cut to fit a duration.
 */

export const QA_VERSION = 1;

const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 };

const US_ENGLISH = [
  [/\bcolou?rs?\b/i, "colou?r", "color"],
  [/\bbehaviours?\b/i, "behaviour", "behavior"],
  [/\bfavour(?:s|ed|ite|ites)?\b/i, "favour", "favor"],
  [/\borgani[sz]ations?\b/i, null, null],
  [/\borganis(?:e|es|ed|ing|ation|ations)\b/i, "organis-", "organiz-"],
  [/\bcustomis(?:e|es|ed|ing|ation|ations)\b/i, "customis-", "customiz-"],
  [/\boptimis(?:e|es|ed|ing|ation|ations)\b/i, "optimis-", "optimiz-"],
  [/\bauthoris(?:e|es|ed|ing|ation|ations)\b/i, "authoris-", "authoriz-"],
  [/\bsummaris(?:e|es|ed|ing)\b/i, "summaris-", "summariz-"],
  [/\bprioritis(?:e|es|ed|ing)\b/i, "prioritis-", "prioritiz-"],
  [/\bsynchronis(?:e|es|ed|ing|ation)\b/i, "synchronis-", "synchroniz-"],
  [/\brecognis(?:e|es|ed|ing)\b/i, "recognis-", "recogniz-"],
  [/\bcentres?\b/i, "centre", "center"],
  [/\bcatalogues?\b/i, "catalogue", "catalog"],
  [/\banalys(?:e|es|ed|ing)\b/i, "analyse", "analyze"],
  [/\bprogrammes?\b/i, "programme", "program"],
  [/\bwhilst\b/i, "whilst", "while"],
  [/\bgrey\b/i, "grey", "gray"],
];

const GENERIC_ALT = /^(?:an? )?(?:image|picture|screenshot|photo|graphic|figure)(?: of)?\b/i;

/** Remove fenced code blocks (keeping line count so line numbers still map). */
function stripFences(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const out = [];
  let fence = null;
  for (const line of lines) {
    const match = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length) fence = null;
      out.push("");
      continue;
    }
    if (match) {
      fence = match[1];
      out.push("");
      continue;
    }
    out.push(line);
  }
  return out;
}

/** Prose for language checks: no code, link targets, URLs, or HTML tags. */
function proseOf(lines) {
  return lines
    .join("\n")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/`[^`\n]*`/g, " ");
}

export function parseMinutes(value) {
  const text = String(value || "")
    .replace(/[*_`]/g, "")
    .split("(")[0]
    .split("+")[0]
    .toLowerCase();
  const hours = text.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)/);
  const minutes = text.match(/(\d+)\s*(?:minutes?|mins?)/);
  const total = (hours ? Math.round(parseFloat(hours[1]) * 60) : 0) + (minutes ? parseInt(minutes[1], 10) : 0);
  return total || null;
}

function wordCount(text) {
  return (String(text).match(/[A-Za-z0-9'’-]+/g) || []).length;
}

function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "").match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

/** Flesch-Kincaid grade and mean sentence length over prose lines. */
export function readingLevel(text) {
  const clean = String(text)
    .replace(/^\s*(?:[-*]|\d+\.)\s+(?:\[[ xX]]\s*)?/gm, "")
    .replace(/[*_]+/g, "")
    .replace(/^\|.*$/gm, " ")
    .replace(/^#{1,6}\s.*$/gm, " ");
  const sentences = clean
    .split(/(?<=[.!?])\s+|\n{2,}|\n/)
    .map((s) => s.trim())
    .filter((s) => wordCount(s) >= 3);
  if (!sentences.length) return { sentences: 0, avgSentenceWords: 0, grade: 0 };
  const words = clean.match(/[A-Za-z][A-Za-z'’-]*/g) || [];
  const syl = words.reduce((n, w) => n + syllables(w), 0);
  const avg = wordCount(sentences.join(" ")) / sentences.length;
  const grade = 0.39 * avg + 11.8 * (syl / Math.max(1, words.length)) - 15.59;
  return { sentences: sentences.length, avgSentenceWords: Math.round(avg * 10) / 10, grade: Math.round(grade * 10) / 10 };
}

function parseSections(lines) {
  const headings = [];
  lines.forEach((line, index) => {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) headings.push({ level: m[1].length, text: m[2].trim(), line: index });
  });
  return headings.map((h, i) => {
    let end = lines.length;
    for (let j = i + 1; j < headings.length; j += 1) {
      if (headings[j].level <= h.level) {
        end = headings[j].line;
        break;
      }
    }
    return { ...h, body: lines.slice(h.line + 1, end) };
  });
}

function imagesIn(lines) {
  const images = [];
  lines.forEach((line, index) => {
    for (const m of line.matchAll(/!\[([^\]]*)]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      images.push({ alt: m[1].trim(), target: m[2], line: index + 1 });
    }
  });
  return images;
}

function altProblem(image) {
  const alt = image.alt;
  if (!alt) return "has no alt text";
  const file = image.target.split("/").pop();
  if (alt.toLowerCase() === file.toLowerCase() || /\.(png|jpe?g|gif|svg|webp)$/i.test(alt)) return "uses the file name as alt text";
  if (GENERIC_ALT.test(alt)) return 'starts with "image of" or "screenshot of" (screen readers already announce an image)';
  if (alt.length < 20) return "is too short to say what the image shows";
  if (alt.length > 250) return "is longer than 250 characters; move detail into the caption or the steps";
  return null;
}

function normalizeLine(line) {
  return line
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[*_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const MODULE_CHECKS = [
  { id: "numbered-steps", label: "Numbered click-by-click steps", test: (m) => m.steps >= 2 },
  { id: "expected-results", label: "Says what you should see after key steps", test: (m) => /\*\*(?:what you should see|expected result)/i.test(m.text) },
  { id: "verification", label: "Has a Check your work list", test: (m) => /\*\*check your work\*\*/i.test(m.text) && /\[ ]/.test(m.text) },
  { id: "troubleshooting", label: "Covers common mistakes and fixes", test: (m) => /troubleshooting|common mistakes/i.test(m.text) },
  { id: "knowledge-check", label: "Has a knowledge check with an answer", test: (m) => /<summary>[^<]*(?:knowledge check|self-check)/i.test(m.text) },
  { id: "scenario-thread", label: "Ties the module to the lab scenario", test: (m) => /\*\*in your scenario/i.test(m.text) },
  { id: "screenshot", label: "Has a screenshot with alt text", test: (m) => m.images.some((i) => !altProblem(i)) },
  { id: "time-estimate", label: "States an estimated time", test: (m) => /about \d+ (?:minutes?|hours?)/i.test(m.text) },
  { id: "sources", label: "Cites Microsoft Learn", test: (m) => /learn\.microsoft\.com/i.test(m.text) },
];

const MODULE_CHECK_FIX = {
  "numbered-steps": "Add numbered steps that say exactly what to select or type.",
  "expected-results": 'Add a "What you should see" line after the key steps so a learner can confirm progress.',
  verification: 'Add a "Check your work" checklist the learner can tick off.',
  troubleshooting: "Add the two or three mistakes learners hit most often and how to fix each.",
  "knowledge-check": "Add a short self-check question with an expandable answer.",
  "scenario-thread": 'Add an "In your scenario" passage that uses the lab\'s sample data and terms.',
  screenshot: "Add a screenshot slot with specific alt text for the key screen or result.",
  "time-estimate": "State how long the module takes.",
  sources: "Link the Microsoft Learn page the module is based on.",
};

function topicsOf(sections, lines) {
  const stepHeading = /^Step\s+(\d+)\s*[-–—:]\s*(.+)$/i;
  return sections
    .filter((s) => s.level === 3 && stepHeading.test(s.text))
    .map((s) => {
      const [, order, name] = s.text.match(stepHeading);
      const body = s.body.join("\n");
      const module = {
        order: Number(order),
        name: name.trim(),
        text: body,
        steps: s.body.filter((l) => /^\s*\d+\.\s+\S/.test(l)).length,
        images: imagesIn(s.body),
      };
      const checklist = MODULE_CHECKS.map((c) => ({ id: c.id, label: c.label, pass: c.test(module) }));
      const passed = checklist.filter((c) => c.pass).length;
      const minutes = parseMinutes((body.match(/about (\d+ (?:minutes?|hours?)(?: \d+ minutes?)?)/i) || [])[1]);
      return {
        order: module.order,
        name: module.name,
        minutes,
        steps: module.steps,
        images: module.images.length,
        checklist,
        score: Math.round((100 * passed) / checklist.length),
      };
    });
}

/**
 * Assess a composed lab.
 *
 * @param {string} markdown the lab's index.md
 * @param {object} [options]
 * @param {Array<{name: string}>} [options.expectedTopics] the modules the learner selected
 * @returns {{version: number, score: number, grade: string, stats: object, checks: object[], topics: object[], findings: object[]}}
 */
export function assessLab(markdown, options = {}) {
  const source = String(markdown || "");
  const lines = stripFences(source);
  const sections = parseSections(lines);
  const topics = topicsOf(sections, lines);
  const findings = [];
  const checks = [];

  const add = (id, label, weight, ratio, severity, detail, fix) => {
    const r = Math.max(0, Math.min(1, ratio));
    checks.push({ id, label, weight, ratio: Math.round(r * 100) / 100, status: r >= 1 ? "pass" : r >= 0.6 ? "warn" : "fail" });
    if (r < 1) findings.push({ rule: id, severity, topic: null, message: detail, fix });
  };

  const titled = (re) => sections.find((s) => s.level >= 2 && re.test(s.text));

  // Structure
  const objectives = titled(/objectives|what you(?:'ll| will) (?:learn|do|build)/i);
  const objectiveItems = (objectives?.body || []).filter((l) => /^\s*[-*]\s+\S/.test(l));
  const mapped = objectiveItems.filter((l) => /\bstep\s+\d+/i.test(l)).length;
  add(
    "objectives-mapped",
    "Learning objectives map to steps",
    8,
    !objectives || !objectiveItems.length ? 0 : mapped / objectiveItems.length,
    "warn",
    !objectives
      ? "The lab has no learning objectives."
      : `${objectiveItems.length - mapped} of ${objectiveItems.length} learning objectives do not say which step teaches them.`,
    "Name the step beside each objective (for example, \"Step 3\") so learners can see where each goal is met.",
  );

  const prereq = titled(/prerequisites/i);
  const prereqText = (prereq?.body || []).join("\n");
  const hasLicensing = /licen[sc]/i.test(prereqText);
  const hasPermissions = /permission|role|admin|maker/i.test(prereqText);
  add(
    "prerequisites-licensing",
    "Prerequisites cover licensing and permissions",
    8,
    !prereq ? 0 : (hasLicensing ? 0.5 : 0) + (hasPermissions ? 0.5 : 0),
    "warn",
    !prereq
      ? "The lab has no Prerequisites section."
      : `Prerequisites do not mention ${[!hasLicensing && "licensing", !hasPermissions && "permissions or roles"].filter(Boolean).join(" or ")}.`,
    "State the license or trial a learner needs and the role required to complete each module.",
  );

  const scenario = titled(/scenario/i);
  add("scenario", "Scenario narrative", 5, scenario ? 1 : 0, "warn", "The lab has no scenario section that sets up the sample agent and its users.", "Add a scenario section naming the problem, the users, and what done looks like.");

  add(
    "validation-section",
    "Validation or success criteria section",
    4,
    titled(/validation|success criteria/i) ? 1 : 0,
    "warn",
    "The lab has no end-to-end validation section.",
    "Add a section that lists how to confirm the finished agent works.",
  );

  add(
    "troubleshooting-section",
    "Troubleshooting guidance",
    4,
    titled(/troubleshoot/i) || topics.some((t) => t.checklist.find((c) => c.id === "troubleshooting")?.pass) ? 1 : 0,
    "warn",
    "The lab has no troubleshooting guidance.",
    "Add a troubleshooting section or per-module common mistakes.",
  );

  add("cleanup", "Cleanup section", 3, titled(/clean ?up|remove the resources|delete the/i) ? 1 : 0, "info", "The lab does not say how to clean up the resources it created.", "Add a cleanup section listing what to delete or unpublish.");

  const learnLinks = (titled(/where to go next|next steps|further learning|learn more/i)?.body || []).join("\n").match(/learn\.microsoft\.com/g) || [];
  add(
    "further-learning",
    "Next steps with Microsoft Learn links",
    4,
    !titled(/where to go next|next steps|further learning|learn more/i) ? 0 : learnLinks.length ? 1 : 0.5,
    "info",
    "Next steps do not link to further Microsoft Learn reading.",
    "Add a further-learning list of Microsoft Learn pages that were fetched or cited during the build.",
  );

  add("glossary", "Glossary of terms", 2, titled(/glossary|key terms/i) ? 1 : 0, "info", "The lab has no glossary of the terms it introduces.", "Add a short glossary of the product and domain terms used.");

  // Per-module completeness
  for (const check of MODULE_CHECKS) {
    const failing = topics.filter((t) => !t.checklist.find((c) => c.id === check.id).pass);
    const ratio = topics.length ? 1 - failing.length / topics.length : 0;
    const weights = { "numbered-steps": 8, "expected-results": 9, verification: 6, troubleshooting: 6, "knowledge-check": 5, "scenario-thread": 5, screenshot: 6, "time-estimate": 3, sources: 5 };
    const severity = ["numbered-steps", "verification"].includes(check.id) ? "error" : "warn";
    add(`module-${check.id}`, `Every module: ${check.label.toLowerCase()}`, weights[check.id], ratio, severity, topics.length ? `${check.label}: ${failing.length} of ${topics.length} modules fall short (${failing.map((t) => `Step ${t.order}`).join(", ")}).` : "No `### Step N - ...` modules were found.", MODULE_CHECK_FIX[check.id]);
      }

  const expected = options.expectedTopics || [];
  if (expected.length) {
    const have = topics.map((t) => t.name.toLowerCase());
    const missing = expected.filter((e) => !have.some((h) => h.includes(String(e.name).toLowerCase())));
    add("topics-covered", "Every selected topic has its own module", 8, 1 - missing.length / expected.length, "error", `No module found for: ${missing.map((m) => m.name).join(", ")}.`, "Add a step module for every selected topic.");
  }

  // Accessibility
  const images = imagesIn(lines);
  const badAlts = images.map((i) => ({ i, problem: altProblem(i) })).filter((x) => x.problem);
  add(
    "image-alt-text",
    "Images have specific alt text (WCAG 1.1.1)",
    8,
    images.length ? 1 - badAlts.length / images.length : 1,
    "error",
    `${badAlts.length} of ${images.length} images have weak alt text.`,
    "Describe what the image shows and why it matters, in a sentence of 20 to 250 characters.",
  );
  for (const { i, problem } of badAlts) {
    findings.push({ rule: "image-alt-text", severity: "error", topic: null, line: i.line, message: `Image ${i.target} ${problem}.`, fix: "Write alt text that says what the screen shows and what the learner should notice.", scope: "item" });
  }
  const captioned = images.filter((i) => /^\s*\*Figure\s+[\d.]+\./.test(lines.slice(i.line, i.line + 4).find((l) => l.trim()) || "")).length;
  add("figure-captions", "Figures have numbered captions", 3, images.length ? captioned / images.length : 1, "info", `${images.length - captioned} of ${images.length} images have no numbered caption.`, "Add an italic `Figure N.` caption under each image.");

  const headings = sections.map((s) => s);
  const skips = [];
  let previous = 0;
  for (const h of headings) {
    if (previous && h.level > previous + 1) skips.push(`"${h.text}" jumps from H${previous} to H${h.level}`);
    previous = h.level;
  }
  const h1 = headings.filter((h) => h.level === 1).length;
  add("heading-order", "Heading levels are sequential", 4, skips.length || h1 !== 1 ? 0 : 1, "error", skips.length ? `Heading order problem: ${skips.join("; ")}.` : `Expected exactly one H1, found ${h1}.`, "Use one H1 and never skip heading levels.");

  // Consistency and language
  const meta = parseMinutes((source.match(/TIME\*\*\s*\|\s*([^|\n]+)\|/) || [])[1]);
  const table = parseMinutes((source.match(/^\|\s*\|\s*\*\*Total\*\*\s*\|[^|]*\|\s*([^|\n]+)\|/m) || [])[1]);
  const stepSum = topics.length && topics.every((t) => t.minutes) ? topics.reduce((n, t) => n + t.minutes, 0) : null;
  const rowSum = (() => {
    const rows = [...source.matchAll(/^\|\s*\d+\s*\|[^|\n]+\|[^|\n]*\|\s*about (\d+) min/gim)];
    return rows.length ? rows.reduce((n, m) => n + Number(m[1]), 0) : null;
  })();
  const stated = [meta, table, stepSum, rowSum].filter((v) => v != null);
  add(
    "time-consistency",
    "Time estimates agree and sum to the total",
    5,
    !stated.length ? 0 : new Set(stated).size === 1 ? 1 : 0,
    "warn",
    !stated.length
      ? "The lab states no estimated time."
      : `Time estimates disagree: header ${meta ?? "none"} min, table total ${table ?? "none"} min, table rows ${rowSum ?? "none"} min, module headers ${stepSum ?? "none"} min.`,
    "Make the header, table total, per-module times, and the sum of the rows agree. Estimates are guidance: never trim content to meet one.",
  );

  const visible = stripFences(source);
  const prose = proseOf(visible);
  const harnessHits = prose.match(/GitHub Copilot harness/gi) || [];
  add("terminology", 'Terminology: "Microsoft Copilot harness", never "GitHub Copilot harness"', 4, harnessHits.length ? 0 : 1, "error", `"GitHub Copilot harness" appears ${harnessHits.length} time(s).`, 'Use "Microsoft Copilot harness".');
  const uk = US_ENGLISH.filter(([re, from]) => from && re.test(prose));
  add("us-english", "US English spelling", 2, uk.length ? 0 : 1, "warn", `Non-US spelling found: ${uk.map(([, from, to]) => `${from} → ${to}`).join(", ")}.`, "Use US English spellings.");

  const markers = visible.join("\n").match(/\b(?:TODO|FIXME|TBD|XXX)\b/g) || [];
  add("no-markers", "No unfinished-work markers", 3, markers.length ? 0 : 1, "error", `${markers.length} TODO-style marker(s) remain.`, "Replace each marker with final guidance.");

  const level = readingLevel(prose);
  add(
    "reading-level",
    "Sentences are short enough to scan",
    3,
    level.avgSentenceWords <= 20 ? 1 : level.avgSentenceWords <= 26 ? 0.7 : 0.4,
    "info",
    `Average sentence length is ${level.avgSentenceWords} words (grade level about ${level.grade}).`,
    "Split sentences longer than 25 words and prefer plain verbs.",
  );

  const longLines = new Map();
  for (const raw of visible) {
    if (/^\s*[|#]/.test(raw) || /^\s*\[ ]/.test(raw)) continue;
    const norm = normalizeLine(raw);
    if (norm.length >= 90) longLines.set(norm, (longLines.get(norm) || 0) + 1);
  }
  const dupes = [...longLines.entries()].filter(([, n]) => n > 1);
  const dupLineCount = dupes.reduce((n, [, c]) => n + c - 1, 0);
  add("duplicate-content", "No repeated paragraphs", 3, 1 - Math.min(1, dupLineCount / 8), "warn", `${dupes.length} paragraph(s) repeat word for word, for example: "${(dupes[0]?.[0] || "").slice(0, 80)}...".`, "Say each thing once; refer back to the earlier step instead of repeating it.");

  const unconfirmed = (source.match(/Not confirmed in Microsoft Learn|\[Unverified]/gi) || []).length;
  if (unconfirmed) {
    findings.push({ rule: "unconfirmed-content", severity: "info", topic: null, message: `${unconfirmed} passage(s) are flagged as not confirmed in Microsoft Learn.`, fix: "Re-run with Microsoft Learn grounding, or confirm each against the product before sharing.", scope: "item" });
  }

  const totalWeight = checks.reduce((n, c) => n + c.weight, 0);
  const score = Math.round((100 * checks.reduce((n, c) => n + c.weight * c.ratio, 0)) / Math.max(1, totalWeight));
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  return {
    version: QA_VERSION,
    score,
    grade: score >= 90 ? "Excellent" : score >= 75 ? "Good" : score >= 55 ? "Needs work" : "Weak",
    stats: {
      words: wordCount(prose),
      modules: topics.length,
      steps: topics.reduce((n, t) => n + t.steps, 0),
      images: images.length,
      minutes: table ?? meta ?? null,
      avgSentenceWords: level.avgSentenceWords,
      readingGrade: level.grade,
    },
    checks,
    topics,
    findings,
  };
}

/** Plain-text report for the CLI. */
export function formatQaReport(report, { maxFindings = 12 } = {}) {
  const out = [`Quality ${report.score}/100 (${report.grade}) · ${report.stats.words} words · ${report.stats.modules} modules · ${report.stats.images} images`];
  const shown = report.findings.slice(0, maxFindings);
  for (const f of shown) out.push(`  ${f.severity.toUpperCase().padEnd(5)} ${f.message}`);
  if (report.findings.length > shown.length) out.push(`  ... and ${report.findings.length - shown.length} more finding(s).`);
  return out.join("\n");
}
