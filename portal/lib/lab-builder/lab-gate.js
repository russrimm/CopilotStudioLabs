/**
 * Lab gate: a deterministic substance check for a finished lab.
 *
 * The validators decide whether a lab is well formed and qa.js scores its structure. This answers a different
 * question a teacher asks before using a lab: is anything in it cut off, empty, generic, misleading or out of date
 * with the product, and which pictures are still missing? It reads the lab's Markdown (plus its assets folder and
 * manifest when given) and never touches the network, so the same lab always gives the same report. It works on
 * generated labs and on the hand-written labs under labs/.
 *
 * Findings carry one of three severities:
 *   gap     a learner could be blocked or misled (cut-off step, no steps, no check, a quiz that teaches a disclaimer,
 *           wording the product no longer uses)
 *   polish  works but looks unfinished (pending pictures, generic checks and troubleshooting, a very long title)
 *   note    honest flags that are expected on Learn-derived content ([Unverified], Not confirmed in Microsoft Learn)
 */

import fs from "node:fs";
import path from "node:path";

import { capturedScreenshotsDirs, resolveLabScreenshot } from "./captured.js";
import { scopeProblem } from "./topic-scope.js";

export const GATE_VERSION = 1;

export const GRADES = {
  ready: "Ready to teach",
  almost: "Almost ready",
  "needs-work": "Needs fixes",
  "not-ready": "Not ready",
};

export const MAX_TITLE_LENGTH = 110;

/** Wording the real product no longer uses on the Microsoft Copilot harness (agent page tabs are Build, Preview, Evaluate, Monitor). */
export const STALE_MICROSOFT_COPILOT_WORDING = [
  { pattern: /\bOverview (?:page|tab)\b/i, say: "the agent page has the tabs Build, Preview, Evaluate, and Monitor, not an Overview page" },
  { pattern: /\bInstructions (?:page|tab)\b/i, say: "instructions are edited on the Build tab, not on an Instructions page" },
  { pattern: /\bPublish page\b/i, say: "publishing opens a Publish dialog from the agent page, not a Publish page" },
];

/** Quiz answers that are wrong on their face; they make a question trivial and the lab look careless. */
export const FILLER_DISTRACTORS = [
  /\bbypasses environment permissions\b/i,
  /\bskips validation checks\b/i,
  /\bdeletes prior settings\b/i,
  /\bwithout testing\.?$/i,
  /\bSkipping the Check your work list\b/i,
  /\bbefore running any scenario test\b/i,
  /\bignores tenant licensing and environment roles\b/i,
  /\bnever affect .* behavior\b/i,
  /\brequires a brand-new tenant\b/i,
];

const DISCLAIMER_ANSWER = /^(?:This topic was found on Microsoft Learn|Microsoft Learn describes this topic as)\b/i;
const PLACEHOLDER_CHECK = /^\[Unverified\]|linked Microsoft Learn article and the result matches/i;
const MODULE_HEADING = /^###\s+(?:(Step|Recap|Part|Exercise|Task|Section)\s+(\d+)|(\d+(?:\.\d+)+))\s*(?:[-\u2013\u2014:.]\s*)?(.*)$/;
const TEMPLATE_TROUBLESHOOTING = [/^\*\*A step does not match your screen\./i, /is not true yet\.\*\*/i, /^\*\*An option is missing\./i];

function stripFences(markdown) {
  const out = [];
  let inFence = false;
  for (const line of String(markdown ?? "").split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push("");
      continue;
    }
    out.push(inFence ? "" : line);
  }
  return out;
}

function stripDetails(lines) {
  let depth = 0;
  return lines.map((line) => {
    if (/<details\b/i.test(line)) depth += 1;
    const keep = depth === 0 ? line : "";
    if (/<\/details>/i.test(line)) depth = Math.max(0, depth - 1);
    return keep;
  });
}

function splitModules(lines) {
  const modules = [];
  let current = null;
  lines.forEach((line, index) => {
    const heading = MODULE_HEADING.exec(line);
    if (heading) {
      const label = heading[1] ? `${heading[1]} ${heading[2]}` : `Part ${heading[3]}`;
      current = { label, title: heading[4].trim() || label, start: index, lines: [] };
      modules.push(current);
      return;
    }
    if (/^#{1,3}\s/.test(line) && !/^####/.test(line)) {
      current = null;
      return;
    }
    if (current) current.lines.push(line);
  });
  return modules;
}

/** Lines between a bold label and the next bold label (or the end of the module). */
function section(lines, labelPattern) {
  const start = lines.findIndex((line) => labelPattern.test(line));
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\*\*[^*]+\*\*\s*$/.test(lines[i]) || /^\*\*(?:What you should see|In your scenario|Sample|Knowledge check)/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

function stepLines(lines) {
  const doThis = section(lines, /^\*\*Do this\*\*/);
  return (doThis ?? lines).filter((line) => /^\d+\.\s/.test(line));
}

function quizOf(lines) {
  const options = [];
  const answers = [];
  for (const line of lines) {
    const option = /^\s*[-*]\s+\*\*([A-D])\.\*\*\s+(.*)$/.exec(line);
    if (option) options.push({ letter: option[1], text: option[2].trim() });
    const answer = /\*\*Correct answer: ([A-D])\.\*\*\s*(.*)$/.exec(line);
    if (answer) answers.push({ letter: answer[1], text: answer[2].trim() });
  }
  return { options, answers, questions: lines.filter((line) => /^\*\*Question \d+\./.test(line)).length };
}

function picturesOf(lines, { labDir, capturedDir }) {
  const pictures = [];
  for (const line of lines) {
    for (const match of line.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) {
      const target = match[1];
      if (/^https?:/i.test(target)) continue;
      const filename = path.basename(target.split(/[?#]/)[0]);
      let pending = null;
      if (labDir) pending = !resolveLabScreenshot(labDir, filename, { capturedDir });
      pictures.push({ filename, pending });
    }
  }
  return pictures;
}

function reviewModule(module, context) {
  const lines = stripDetails(module.lines);
  const text = lines.join("\n");
  const steps = stepLines(lines);
  const findings = [];
  const add = (code, severity, count, message, fix) =>
    findings.push({ code, severity, module: module.label, moduleTitle: module.title, count, message, fix });
  const where = `${module.label} (${module.title})`;
  // A Recap is a short refresher of a lower-level module: steps only, with no check, quiz, or troubleshooting by design.
  const full = context.isGenerated && !module.label.startsWith("Recap");

  const cutOffSteps = steps.filter((line) => /(?:\.\.\.|\u2026)\s*$/.test(line.replace(/\*+$/, "")));
  const fusedSteps = steps.filter((line) => /[.!?];\s+[A-Z]/.test(line));
  const cutOffText = lines.filter((line) => !/^\d+\.\s/.test(line) && /[A-Za-z]\u2026(?:\s|$|\*|")/.test(line));

  if (context.isGenerated && steps.length === 0) {
    add("no-steps", "gap", 1, `${where} has no numbered steps, so a learner has nothing to follow.`, "Rebuild the lab with Microsoft Learn on, or write the steps in the catalog.");
  }
  if (cutOffSteps.length) {
    add("cut-off-step", "gap", cutOffSteps.length, `${where}: ${cutOffSteps.length} step${cutOffSteps.length === 1 ? " is" : "s are"} cut off with "...", so the last part of the instruction is missing.`, "Show the whole step (with its sub-steps) instead of shortening it.");
  }
  if (fusedSteps.length) {
    add("fused-substeps", "gap", fusedSteps.length, `${where}: ${fusedSteps.length} step${fusedSteps.length === 1 ? " runs" : "s run"} several sub-steps together on one line, which is hard to follow.`, "Show sub-steps as an indented list under the step.");
  }
  if (cutOffText.length) {
    add("cut-off-text", "gap", cutOffText.length, `${where}: ${cutOffText.length} sentence${cutOffText.length === 1 ? " is" : "s are"} cut off in the middle of a word.`, "Shorten text at a sentence end, never in the middle of a word.");
  }

  if (full) {
    const check = section(lines, /^\*\*Check your work\*\*/);
    const items = (check || []).filter((line) => /^\s*-\s+\[ \]/.test(line));
    if (!check || !items.length) {
      add("no-check", "gap", 1, `${where} has no Check your work list, so a learner cannot tell whether it worked.`, "Add at least one observable result to the module.");
    } else if (items.every((line) => PLACEHOLDER_CHECK.test(line.replace(/^\s*-\s+\[ \]\s+/, "")))) {
      add("generic-check", "polish", 1, `${where}: the Check your work list only says to follow the Learn article.`, "Name one thing the learner should see on screen.");
    }
    const missing = [
      ["What you are doing", /^\*\*What you are doing\./],
      ["Do this", /^\*\*Do this\*\*/],
      ["Troubleshooting", /^\*\*Troubleshooting\*\*/],
    ].filter(([, pattern]) => !lines.some((line) => pattern.test(line)));
    if (missing.length) {
      add("missing-section", "gap", missing.length, `${where} is missing: ${missing.map(([name]) => name).join(", ")}.`, "Every module has the same sections in the same order.");
    }
    const doing = lines.find((line) => /^\*\*What you are doing\.\*\*/.test(line));
    const scope = doing ? scopeProblem(doing.replace(/^\*\*What you are doing\.\*\*\s*/, ""), context.harness) : null;
    if (scope?.kind === "classic-only") {
      add("topic-not-for-harness", "gap", 1, `${where}: Microsoft Learn says this topic applies to classic chatbots only, which is not what this lab builds.`, "Remove the module, or choose a topic for the kind of agent the lab builds.");
    } else if (scope) {
      add("topic-harness-limit", "polish", 1, `${where}: Microsoft Learn limits this topic for the lab's harness: "${scope.sentences[0]}"`, "Confirm it against the tenant before teaching it.");
    }
    const trouble = section(lines, /^\*\*Troubleshooting\*\*/);
    const bullets = (trouble || []).filter((line) => /^\s*-\s+/.test(line));
    if (bullets.length && bullets.every((line) => TEMPLATE_TROUBLESHOOTING.some((pattern) => pattern.test(line.replace(/^\s*-\s+/, ""))))) {
      add("generic-troubleshooting", "polish", 1, `${where}: troubleshooting has only the generic tips, nothing specific to this module.`, "Add the module's own known problems and fixes.");
    }
  }

  // The quiz answers sit inside <details>, so the quiz and pictures read the module as written.
  const quiz = quizOf(module.lines);
  if (quiz.answers.some((answer) => DISCLAIMER_ANSWER.test(answer.text))) {
    add("quiz-teaches-disclaimer", "gap", 1, `${where}: a quiz answer is the Learn-derived disclaimer, so the quiz teaches nothing about the topic.`, "Leave the quiz out of a module that has no verified content to ask about.");
  }
  const filler = quiz.options.filter((option) => FILLER_DISTRACTORS.some((pattern) => pattern.test(option.text)));
  if (filler.length) {
    add("quiz-filler-answers", "polish", filler.length, `${where}: ${filler.length} quiz answer${filler.length === 1 ? " is" : "s are"} obviously wrong filler, which makes the question trivial.`, "Write wrong answers that a learner could plausibly choose.");
  }

  const pictures = picturesOf(module.lines, context);
  const pending = pictures.filter((picture) => picture.pending === true);
  if (pending.length) {
    add("pending-picture", "polish", pending.length, `${where}: ${pending.length} picture${pending.length === 1 ? " is" : "s are"} still a placeholder.`, "Capture the screenshots in the Screenshot Center.");
  }
  if (full && pictures.length === 0) {
    add("no-picture", "polish", 1, `${where} has no screenshot at all.`, "Add a screenshot slot for the screen this module is about.");
  }

  const unverified = lines.filter((line) => /\[Unverified\]/.test(line)).length;
  const notConfirmed = lines.filter((line) => /Not confirmed in Microsoft Learn/i.test(line)).length;
  if (unverified) add("unverified", "note", unverified, `${where}: ${unverified} line${unverified === 1 ? " is" : "s are"} marked [Unverified].`, "Confirm each against the product or the linked article before teaching.");
  if (notConfirmed) add("not-confirmed", "note", notConfirmed, `${where}: ${notConfirmed} passage${notConfirmed === 1 ? " is" : "s are"} flagged as not confirmed in Microsoft Learn.`, "Confirm against the product or leave as flagged.");

  if (context.microsoftCopilot && context.isModuleOfMicrosoftCopilot(module)) {
    for (const rule of STALE_MICROSOFT_COPILOT_WORDING) {
      const hits = lines.filter((line) => rule.pattern.test(line));
      if (hits.length) add("stale-ui-wording", "gap", hits.length, `${where}: ${hits.length} line${hits.length === 1 ? "" : "s"} use wording the product no longer has; ${rule.say}.`, "Use the current tab and dialog names.");
    }
  }

  return {
    label: module.label,
    title: module.title,
    steps: steps.length,
    pictures: pictures.length,
    pendingPictures: pending.length,
    quizQuestions: quiz.questions,
    findings,
    text,
  };
}

function gradeOf({ gaps, polish, gapModules, modules }) {
  if (gaps === 0 && polish === 0) return "ready";
  if (gaps === 0) return "almost";
  return gapModules / modules >= 0.5 ? "not-ready" : "needs-work";
}

function sentenceFor(grade, totals) {
  const bits = [];
  if (totals.gaps) bits.push(`${totals.gaps} gap${totals.gaps === 1 ? "" : "s"} to fix`);
  if (totals.pendingPictures) bits.push(`${totals.pendingPictures} picture${totals.pendingPictures === 1 ? "" : "s"} still to capture`);
  if (totals.polish - (totals.pendingPictureFindings || 0) > 0) bits.push(`${totals.polish - totals.pendingPictureFindings} polish item${totals.polish - totals.pendingPictureFindings === 1 ? "" : "s"}`);
  if (totals.notes) bits.push(`${totals.unverifiedLines + totals.notConfirmedLines} flagged as not confirmed`);
  return bits.length ? `${GRADES[grade]}: ${bits.join(", ")}.` : `${GRADES[grade]}: nothing found.`;
}

/**
 * Scan a lab's Markdown.
 * @param {string} markdown the lab's index.md
 * @param {object} [options]
 * @param {string} [options.labDir] the lab folder; when given, pictures are checked against its assets and the shared library
 * @param {object} [options.manifest] the lab's manifest.json (marks the lab as generated and tells which modules are Microsoft Copilot harness modules)
 * @param {string[]} [options.moduleIds] module ids in order, when there is no manifest yet (generation time)
 * @param {boolean} [options.generated] force the generated-lab section rules on or off (default: true when a manifest or module ids are given)
 * @param {number} [options.pendingPictureCount] known pending pictures when no folder is available (generation time)
 */
export function scanLabMarkdown(markdown, options = {}) {
  const { labDir = null, manifest = null, moduleIds = null, capturedDir = labDir ? capturedScreenshotsDirs() : null } = options;
  const isGenerated = options.generated ?? Boolean(manifest || moduleIds);
  const lines = stripFences(markdown);
  const title = (manifest?.title || (/^#\s+(.+)$/m.exec(String(markdown ?? ""))?.[1] ?? "")).trim();
  const ids = moduleIds || (manifest?.modules || []).map((m) => m.id);
  const harnesses = manifest?.request?.harnesses || (manifest?.request?.harness ? [manifest.request.harness] : []);
  const microsoftCopilot = harnesses.includes("microsoft-copilot") || ids.some((id) => String(id).startsWith("mc-"));

  const rawModules = splitModules(lines);
  const stepModules = rawModules;
  const context = {
    isGenerated,
    labDir,
    capturedDir,
    microsoftCopilot,
    harness: harnesses[0] || null,
    // Module ids line up with Step and Recap headings in order; without ids every module counts.
    isModuleOfMicrosoftCopilot: (module) => {
      if (!ids.length) return true;
      const index = stepModules.indexOf(module);
      return String(ids[index] ?? "").startsWith("mc-");
    },
  };

  const modules = stepModules.map((module) => reviewModule(module, context));
  const findings = modules.flatMap((module) => module.findings);

  if (!modules.length) {
    findings.push({
      code: "no-sections",
      severity: "polish",
      module: null,
      moduleTitle: null,
      count: 1,
      message: "No Step sections were found, so the steps could not be checked.",
      fix: "Use ### Step N headings so every module is easy to find and to check.",
    });
  }
  if (title.length > MAX_TITLE_LENGTH) {
    findings.push({
      code: "long-title",
      severity: "polish",
      module: null,
      moduleTitle: null,
      count: 1,
      message: `The title is ${title.length} characters long; a title this long is hard to read in a list or on a cover page.`,
      fix: "Use a short title that names the scenario and the product.",
    });
  }

  const count = (severity) => findings.filter((f) => f.severity === severity).reduce((sum, f) => sum + f.count, 0);
  const gapModules = new Set(findings.filter((f) => f.severity === "gap" && f.module).map((f) => f.module)).size;
  const folderPending = modules.reduce((sum, m) => sum + m.pendingPictures, 0);
  const pendingPictures = labDir ? folderPending : Number(options.pendingPictureCount) || 0;
  const pendingFindingCount = findings.filter((f) => f.code === "pending-picture").length;
  if (!labDir && pendingPictures) {
    findings.push({
      code: "pending-picture",
      severity: "polish",
      module: null,
      moduleTitle: null,
      count: pendingPictures,
      message: `${pendingPictures} picture${pendingPictures === 1 ? " is" : "s are"} still a placeholder.`,
      fix: "Capture the screenshots in the Screenshot Center.",
    });
  }
  const totals = {
    modules: modules.length,
    steps: modules.reduce((sum, m) => sum + m.steps, 0),
    pictures: modules.reduce((sum, m) => sum + m.pictures, 0),
    pendingPictures,
    quizQuestions: modules.reduce((sum, m) => sum + m.quizQuestions, 0),
    gaps: count("gap"),
    polish: findings.filter((f) => f.severity === "polish").length,
    notes: findings.filter((f) => f.severity === "note").length,
    gapModules,
    pendingPictureFindings: labDir ? pendingFindingCount : pendingPictures ? 1 : 0,
    cutOffSteps: findings.filter((f) => f.code === "cut-off-step").reduce((sum, f) => sum + f.count, 0),
    unverifiedLines: findings.filter((f) => f.code === "unverified").reduce((sum, f) => sum + f.count, 0),
    notConfirmedLines: findings.filter((f) => f.code === "not-confirmed").reduce((sum, f) => sum + f.count, 0),
  };
  const grade = gradeOf({ gaps: totals.gaps, polish: totals.polish, gapModules, modules: modules.length });
  const order = { gap: 0, polish: 1, note: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  return {
    version: GATE_VERSION,
    kind: isGenerated ? "generated" : "handwritten",
    title,
    grade,
    label: GRADES[grade],
    summary: sentenceFor(grade, totals),
    totals,
    modules: modules.map(({ text: _text, findings: moduleFindings, ...rest }) => ({
      ...rest,
      gaps: moduleFindings.filter((f) => f.severity === "gap").length,
      polish: moduleFindings.filter((f) => f.severity === "polish").length,
      notes: moduleFindings.filter((f) => f.severity === "note").length,
    })),
    findings,
  };
}

/** Scan a lab folder: index.md and, when present, manifest.json and assets/. */
export function scanLabDirectory(labDir, options = {}) {
  const dir = path.resolve(labDir);
  const markdown = fs.readFileSync(path.join(dir, "index.md"), "utf8");
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  } catch {
    manifest = null;
  }
  const result = scanLabMarkdown(markdown, { ...options, labDir: dir, manifest });
  return { ...result, lab: path.basename(dir) };
}

/** The compact form saved in manifest.json and shown in lists. */
export function summarizeGate(result) {
  return {
    version: result.version,
    grade: result.grade,
    gaps: result.totals.gaps,
    polish: result.totals.polish,
    notes: result.totals.notes,
    pendingPictures: result.totals.pendingPictures,
  };
}

/** Plain-text report for the CLI. */
export function formatGateReport(result, { maxFindings = 12, all = false } = {}) {
  const lines = [`${result.lab || result.title || "Lab"}`, `  ${result.summary}`];
  const shown = all ? result.findings : result.findings.filter((f) => f.severity !== "note").slice(0, maxFindings);
  for (const finding of shown) lines.push(`  ${finding.severity.toUpperCase().padEnd(6)} ${finding.message}`);
  const hidden = result.findings.length - shown.length;
  if (hidden > 0) lines.push(`  ... and ${hidden} more (run with --all)`);
  return lines.join("\n");
}
