/**
 * Instructor / Facilitator Guide synthesizer and multi-format document builder.
 *
 * Produces a grounded Facilitator Guide model (`buildFacilitatorGuideModel`) and
 * renders instructor-ready `.md`, `.docx`, `.pdf`, and standalone printable `.html`
 * outputs from a generated lab's `manifest.json`, `index.md`, catalog metadata,
 * topic training digests, administrator prerequisites, SharePoint grounding checks,
 * and per-module `sample-files/` inventories.
 *
 * Strictly zero external npm dependencies and US English throughout.
 */

import fs from "node:fs";
import path from "node:path";

import { buildAdminPrerequisites } from "./admin-prereqs.js";
import { getFeature, getHarnesses } from "./catalog.js";
import { buildDocxFromLabMarkdown } from "./docx-builder.js";
import {
  dedupeLearnSources,
  formatCitationLabel,
  selectRelevantLearnSource,
} from "./learn-citations.js";
import { buildModuleSampleFiles, splitGeneratedLabModules } from "./module-samples.js";
import { buildPdfFromLabMarkdown } from "./pdf-builder.js";
import { parseTopicMarkdownStructure } from "./pptx-builder.js";
import { DEFAULT_PRODUCT, productName, productOf, productsPhrase } from "./products.js";
import { parseMinutes } from "./qa.js";
import { isUnreviewedText } from "./teaching.js";
import {
  featureRequiresSharepointSite,
  labRequiresSharepointSite,
  resolveSharepointSite,
} from "./sharepoint-site.js";
import { createLabImageResolver } from "./topic-documents.js";
import { resolveTopicTrainingDigest } from "./topic-training.js";
import {
  ensureReadableColor,
  getBrandFont,
  normalizeHexColor6,
  renderBrandInfoHtml,
  renderBrandInfoMarkdown,
} from "./brand-theme.js";

export const FACILITATOR_GUIDE_SCHEMA_VERSION = 1;

const OPTION_LETTERS = ["A", "B", "C", "D"];
const CAUTION_RE =
  /\b(?:can't|cannot|can not|must|requires?|required|only|unavailable|isn't|aren't|not available|don't|doesn't|won't|might|may not|limits?)\b/i;

function cleanText(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

function stripMarkdownFormatting(value) {
  return cleanText(value)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/<\/?[^>]+>/g, "")
    .trim();
}

function ensurePeriod(value) {
  const trimmed = cleanText(value);
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function firstSentence(value) {
  const text = cleanText(value);
  const match = text.match(/^.*?[.!?](?=\s|$)/);
  return (match ? match[0] : text).trim();
}

function conciseSentence(value, maxChars = 160) {
  const sentence = ensurePeriod(firstSentence(value));
  if (sentence.length <= maxChars) return sentence;
  const cut = sentence.slice(0, maxChars);
  const space = cut.lastIndexOf(" ");
  return `${(space > 60 ? cut.slice(0, space) : cut).replace(/[,:;.\s]+$/, "")}.`;
}

function escapeMarkdownTableCell(value) {
  return cleanText(value).replace(/\|/g, "\\|");
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[ch],
  );
}

function safeMarkdownUrl(url) {
  return String(url || "").replace(/[()\s]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

function normalizeReplacementEntries(rawReplacements) {
  if (!rawReplacements) return [];
  if (Array.isArray(rawReplacements)) {
    return rawReplacements
      .map((entry) => {
        if (Array.isArray(entry) && entry.length >= 2) {
          return [String(entry[0] ?? ""), String(entry[1] ?? "")];
        }
        if (entry && typeof entry === "object") {
          const from = entry.find ?? entry.from ?? entry.search ?? "";
          const to = entry.replace ?? entry.to ?? entry.value ?? "";
          return [String(from), String(to)];
        }
        return null;
      })
      .filter((pair) => pair && pair[0] && pair[0] !== pair[1]);
  }
  if (typeof rawReplacements === "object") {
    return Object.entries(rawReplacements)
      .filter(([from, to]) => from && typeof to === "string" && from !== to)
      .map(([from, to]) => [from, to]);
  }
  return [];
}

function applyReplacements(text, entries = []) {
  let out = String(text ?? "");
  for (const [from, to] of entries) {
    if (from && from !== to) {
      out = out.split(from).join(to);
    }
  }
  return out;
}

function applyReplacementsToValue(value, entries = []) {
  if (!entries.length || value == null) return value;
  if (typeof value === "string") return applyReplacements(value, entries);
  if (Array.isArray(value)) return value.map((item) => applyReplacementsToValue(item, entries));
  if (typeof value === "object") {
    const clone = {};
    for (const [k, v] of Object.entries(value)) {
      clone[k] = applyReplacementsToValue(v, entries);
    }
    return clone;
  }
  return value;
}

function placeCorrectOption(correctText, distractors, targetSlot) {
  const pool = distractors.slice(0, 3);
  const slot = ((targetSlot % 4) + 4) % 4;
  const ordered = [...pool];
  ordered.splice(slot, 0, correctText);
  return {
    correctLetter: OPTION_LETTERS[slot],
    orderedTexts: ordered.slice(0, 4),
  };
}

function buildDistractorWhyWrong(distractorText, moduleName, correctText) {
  const lower = distractorText.toLowerCase();
  if (/bypass|ignore.*permission|ignore.*licens|anonymous|public guest|unauthenticated/.test(lower)) {
    return `Incorrect because ${moduleName} enforces tenant identity, licensing, and environment access controls rather than bypassing security boundaries.`;
  }
  if (/skip.*validation|closing the tab|without testing|skip.*check/.test(lower)) {
    return `Incorrect because configuration changes must be verified with interactive runtime checks (${stripMarkdownFormatting(correctText)}) before confirming readiness.`;
  }
  if (/deletes prior|removing .* before|brand-new tenant|never affect/.test(lower)) {
    return `Incorrect because configuring ${moduleName} updates scoped behavior inside the active environment without wiping unrelated settings or requiring a new tenant.`;
  }
  return `Incorrect because this statement contradicts documented ${moduleName} behavior; the expected outcome is: ${stripMarkdownFormatting(correctText)}`;
}

/**
 * Deterministically synthesize complete Knowledge Check questions, A-D options,
 * correct answer keys, full explanations, distractor rationales, and clickable
 * Microsoft Learn URLs for a module — even when learner quizzes were unchecked!
 */
export function synthesizeModuleKnowledgeChecks({
  feature = null,
  parsedTopic = null,
  manifestMod = {},
  order = 1,
  stepOrder = null,
  agentName = "the target agent",
  topicTitle = "this capability",
} = {}) {
  const cleanName = stripMarkdownFormatting(feature?.name || manifestMod?.name || topicTitle);
  const cleanAgent = stripMarkdownFormatting(agentName || "the target agent");
  const parsedRefs = (parsedTopic?.references || []).filter((r) => r?.url);
  const learnSources = dedupeLearnSources([
    ...parsedRefs.map((r) => ({ title: r.label || r.url, url: r.url })),
    ...(manifestMod?.trainingDigest?.learnTakeaways || []).map((t) => ({
      title: t.title || t.url,
      url: t.url,
    })),
    ...((feature?.docUrls || []).map((url) => ({ title: url, url }))),
    ...(feature?.verifiedAgainst
      ? [{ title: feature.verifiedAgainst, url: feature.verifiedAgainst }]
      : []),
  ]);

  const pickLearnSource = (contextText) => {
    const chosen = selectRelevantLearnSource(learnSources, contextText) || learnSources[0] || null;
    if (chosen?.url) {
      return {
        title: formatCitationLabel(chosen, (s) => cleanText(s)),
        url: chosen.url,
      };
    }
    return {
      title: "Microsoft Copilot Studio Documentation",
      url: "https://learn.microsoft.com/en-us/microsoft-copilot-studio/",
    };
  };

  // If parsed Markdown already contains custom/authored 3-4 option questions that
  // were not generated from a catalog feature, preserve their exact options and
  // enrich rationales + Learn links. When a catalog feature exists, we align with
  // `teaching.js` (`placeCorrectOption` with `stepSeed`) and merge any parsed choices.
  const parsedChecks = Array.isArray(parsedTopic?.knowledgeChecks)
    ? parsedTopic.knowledgeChecks.filter((kc) => kc?.question && Array.isArray(kc.options) && kc.options.length >= 2)
    : [];

  if (!feature && parsedChecks.length > 0) {
    return parsedChecks.map((kc, idx) => {
      const parsedAnswerMatch = String(kc.answer || "").match(
        /^(?:Correct answer:\s*)?([A-D])\b[.:—–-\s]*(.*)$/i,
      );
      const optionRows = kc.options.slice(0, 4).map((opt, optIdx) => {
        const optMatch = String(opt).match(/^\s*(?:\*\*)?([A-D])(?:\.|\))\s*(?:\*\*)?\s*(.*)$/i);
        const letter = optMatch ? optMatch[1].toUpperCase() : OPTION_LETTERS[optIdx] || "A";
        const rawText = optMatch ? optMatch[2].trim() : cleanText(opt);
        const markedCorrect = /\(correct\)/i.test(rawText);
        const cleanedOptText = rawText.replace(/\s*\(correct\)\s*$/i, "").trim();
        return { letter, text: ensurePeriod(cleanedOptText), markedCorrect };
      });

      const correctLetter =
        (parsedAnswerMatch && parsedAnswerMatch[1].toUpperCase()) ||
        optionRows.find((o) => o.markedCorrect)?.letter ||
        optionRows[0]?.letter ||
        "A";
      const correctRow = optionRows.find((o) => o.letter === correctLetter) || optionRows[0];
      const learnSource = pickLearnSource(`${kc.question} ${kc.answer || ""} ${cleanName}`);
      const rawExplanation = parsedAnswerMatch?.[2]
        ? stripMarkdownFormatting(parsedAnswerMatch[2])
        : stripMarkdownFormatting(kc.answer || correctRow?.text || "");

      const options = optionRows.map((row) => {
        const isCorrect = row.letter === correctLetter;
        const rationale = isCorrect
          ? ensurePeriod(rawExplanation || `Correct: ${row.text}`)
          : buildDistractorWhyWrong(row.text, cleanName, correctRow?.text || "");
        return {
          letter: row.letter,
          text: row.text,
          isCorrect,
          rationale,
        };
      });

      return {
        number: idx + 1,
        question: cleanText(kc.question),
        correctLetter,
        correctText: correctRow?.text || "",
        explanation: ensurePeriod(
          rawExplanation || `${correctRow?.text || ""} confirms ${cleanName} behavior`,
        ),
        options,
        distractorRationales: options
          .filter((o) => !o.isCorrect)
          .map((o) => ({ letter: o.letter, text: o.text, whyWrong: o.rationale })),
        learnTitle: learnSource.title,
        learnUrl: learnSource.url,
      };
    });
  }

  const stepSeed = Number(stepOrder ?? manifestMod?.stepOrder ?? order ?? 1);
  const rawQuestions = [];

  const whyFull = ensurePeriod(
    feature?.whyItMatters ||
      feature?.summary ||
      parsedTopic?.whyItMatters ||
      manifestMod?.trainingDigest?.whyItMatters ||
      `Configuring ${cleanName} gives ${cleanAgent} governed, repeatable behavior for business users.`,
  );
  const whyConcise = conciseSentence(whyFull, 160);
  const whySource = pickLearnSource(`${cleanName} ${whyFull}`);
  if (!isUnreviewedText(feature?.whyItMatters || feature?.summary)) rawQuestions.push({
    prompt: `Why do you configure ${cleanName} for ${cleanAgent} in this scenario?`,
    correct: whyConcise,
    distractors: [
      `It bypasses environment permissions for ${cleanName}.`,
      `It skips validation checks for ${cleanName} before rollout.`,
      `It deletes prior settings configured in ${cleanName}.`,
    ],
    explanation: whyFull,
    learnSource: whySource,
  });

  const verifyRaw =
    feature?.validation?.[0] ||
    feature?.expectedResults?.[0] ||
    parsedTopic?.checkYourWork?.[0]?.text ||
    parsedTopic?.expectedResults?.[0] ||
    `Verify ${cleanName} responds accurately in the interactive test pane.`;
  if (verifyRaw && !isUnreviewedText(verifyRaw)) {
    const verifyFull = ensurePeriod(verifyRaw);
    const secondaryVerify = feature?.validation?.[1]
      ? ` Also verify: ${ensurePeriod(feature.validation[1])}`
      : "";
    const verifySource = pickLearnSource(`${cleanName} ${verifyFull}`);
    rawQuestions.push({
      prompt: `Which check confirms that ${cleanName} is working as expected?`,
      correct: conciseSentence(verifyFull, 160),
      distractors: [
        `Closing the tab right after opening ${cleanName} without testing.`,
        `Skipping the Check your work list for ${cleanName}.`,
        `Removing ${cleanName} before running any scenario test.`,
      ],
      explanation: `Confirm ${cleanName} by checking this outcome: ${verifyFull}${secondaryVerify}`,
      learnSource: verifySource,
    });
  }

  const conceptsPool = [
    ...(feature?.concepts || []),
    ...(manifestMod?.trainingDigest?.concepts || []),
    ...(parsedTopic?.concepts || []),
  ].filter((c) => !isUnreviewedText(c));
  const cautionConcept = conceptsPool.find((c) => CAUTION_RE.test(c));
  const conceptRaw =
    cautionConcept ||
    conceptsPool[0] ||
    (feature?.troubleshooting?.[0]?.fix
      ? `${feature.troubleshooting[0].symptom} ${feature.troubleshooting[0].fix}`
      : feature?.learnTopic
        ? null
        : `Scope ${cleanName} permissions and environment settings before publishing to end users.`);

  if (conceptRaw) {
    const conceptFull = ensurePeriod(conceptRaw);
    const conceptSource = pickLearnSource(`${cleanName} ${conceptFull}`);
    rawQuestions.push({
      prompt: `Which point of interest applies when configuring ${cleanName}?`,
      correct: conciseSentence(conceptFull, 160),
      distractors: [
        `${cleanName} ignores tenant licensing and environment roles.`,
        `Updates to ${cleanName} never affect ${cleanAgent} behavior.`,
        `Every change to ${cleanName} requires a brand-new tenant.`,
      ],
      explanation: `Keep this ${cleanName} detail in mind: ${conceptFull}`,
      learnSource: conceptSource,
    });
  }

  return rawQuestions.map((q, index) => {
    const { correctLetter, orderedTexts } = placeCorrectOption(
      q.correct,
      q.distractors,
      stepSeed + index,
    );
    const options = orderedTexts.map((text, idx) => {
      const letter = OPTION_LETTERS[idx];
      const isCorrect = letter === correctLetter;
      const rationale = isCorrect
        ? ensurePeriod(q.explanation)
        : buildDistractorWhyWrong(text, cleanName, q.correct);
      return {
        letter,
        text: stripMarkdownFormatting(text),
        isCorrect,
        rationale: stripMarkdownFormatting(rationale),
      };
    });

    return {
      number: index + 1,
      question: stripMarkdownFormatting(q.prompt),
      correctLetter,
      correctText: stripMarkdownFormatting(q.correct),
      explanation: stripMarkdownFormatting(q.explanation),
      options,
      distractorRationales: options
        .filter((o) => !o.isCorrect)
        .map((o) => ({
          letter: o.letter,
          text: o.text,
          whyWrong: o.rationale,
        })),
      learnTitle: q.learnSource.title,
      learnUrl: q.learnSource.url,
    };
  });
}

function computeDemoHandsOnSplit(targetMinutes, isRecap = false) {
  const total = Math.max(5, Number(targetMinutes) || (isRecap ? 10 : 15));
  const rawDemo = isRecap
    ? Math.min(4, Math.max(2, Math.round(total * 0.28)))
    : Math.min(5, Math.max(3, Math.round(total * 0.24)));
  const demoMinutes = Math.min(rawDemo, Math.max(2, total - 3));
  const handsOnMinutes = Math.max(2, total - demoMinutes);
  return {
    targetMinutes: total,
    demoMinutes,
    handsOnMinutes,
    splitLabel: `${demoMinutes} min demo / ${handsOnMinutes} min hands-on`,
  };
}

function formatClockRange(startMin, endMin) {
  return `${startMin}–${endMin} min`;
}

function buildPacingSchedule(moduleEntries, preFlightBufferMinutes = 15) {
  const rawModulesMinutes = moduleEntries.reduce((sum, m) => sum + m.targetMinutes, 0);
  const totalWithoutBreaks = preFlightBufferMinutes + rawModulesMinutes;
  const needsBreaks = rawModulesMinutes > 90 || (totalWithoutBreaks > 90 && moduleEntries.length >= 2);

  const rows = [];
  let cursor = 0;

  rows.push({
    kind: "preflight",
    stepLabel: "Pre-Flight",
    title: "Tenant Sign-In, Sample Files & Environment Readiness Check",
    levelLabel: "All Attendees",
    targetMinutes: preFlightBufferMinutes,
    demoMinutes: 5,
    handsOnMinutes: Math.max(5, preFlightBufferMinutes - 5),
    splitLabel: `5 min orientation / ${Math.max(5, preFlightBufferMinutes - 5)} min attendee verification`,
    clockWindow: formatClockRange(0, preFlightBufferMinutes),
    notes: "Verify browser profile, environment selector, and downloaded sample-files ZIP before Step 1.",
  });
  cursor += preFlightBufferMinutes;

  let minutesSinceBreak = 0;
  let breaksInserted = 0;

  moduleEntries.forEach((mod, idx) => {
    const start = cursor;
    const end = cursor + mod.targetMinutes;
    cursor = end;
    minutesSinceBreak += mod.targetMinutes;

    rows.push({
      kind: mod.isRecap ? "recap" : "module",
      order: mod.order,
      stepLabel: mod.stepLabel,
      title: mod.title,
      levelLabel: mod.levelLabel,
      targetMinutes: mod.targetMinutes,
      demoMinutes: mod.demoMinutes,
      handsOnMinutes: mod.handsOnMinutes,
      splitLabel: mod.splitLabel,
      clockWindow: formatClockRange(start, end),
      notes: mod.isRecap
        ? "Fast baseline check — confirm prerequisite state before advancing."
        : `Lead ${mod.demoMinutes}-min screen demo, then coach ${mod.handsOnMinutes}-min hands-on build.`,
    });

    const remainingModules = moduleEntries.slice(idx + 1);
    const remainingMinutes = remainingModules.reduce((sum, r) => sum + r.targetMinutes, 0);
    const isMidpointFallback =
      needsBreaks &&
      breaksInserted === 0 &&
      idx === Math.floor((moduleEntries.length - 1) / 2) &&
      remainingModules.length > 0;

    if (
      needsBreaks &&
      remainingModules.length > 0 &&
      (minutesSinceBreak >= 65 && remainingMinutes >= 20 || isMidpointFallback)
    ) {
      const breakDuration = 10;
      const breakStart = cursor;
      const breakEnd = cursor + breakDuration;
      cursor = breakEnd;
      minutesSinceBreak = 0;
      breaksInserted += 1;
      rows.push({
        kind: "break",
        stepLabel: `Break ${breaksInserted}`,
        title: "Suggested Stretch Break & Tenant Catch-Up Buffer",
        levelLabel: "Facilitator Cue",
        targetMinutes: breakDuration,
        demoMinutes: 0,
        handsOnMinutes: 0,
        splitLabel: "10 min break & 1:1 catch-up",
        clockWindow: formatClockRange(breakStart, breakEnd),
        notes: "Recommended break for >90-minute workshops; use the last 3 minutes to unblock any attendee behind on prerequisites.",
      });
    }
  });

  const breakMinutes = breaksInserted * 10;
  return {
    preFlightBufferMinutes,
    modulesMinutes: rawModulesMinutes,
    breakMinutes,
    suggestedBreakCount: breaksInserted,
    totalWorkshopMinutes: preFlightBufferMinutes + rawModulesMinutes + breakMinutes,
    rows,
  };
}

function buildModulePlaybookEntry({
  mod,
  matchedMeta,
  feature,
  parsedTopic,
  digest,
  manifest,
  labTitle,
  agentName,
  harnessName,
  spSite,
  replacementEntries,
  learnerKnowledgeCheckEnabled,
}) {
  const levelNum = matchedMeta?.level || feature?.level || null;
  const levelLabel = levelNum
    ? `Level ${levelNum}${mod.isRecap ? " (Recap)" : ""}`
    : parsedTopic?.meta?.level || (mod.isRecap ? "Prerequisite Recap" : "Level 200");

  const parsedMins =
    Number(matchedMeta?.minutes) ||
    parseMinutes(parsedTopic?.meta?.estimatedTime) ||
    Number(feature?.minutes) ||
    (mod.isRecap ? 10 : 15);
  const split = computeDemoHandsOnSplit(parsedMins, mod.isRecap);

  const prodId = matchedMeta?.product || (feature ? productOf(feature) : null) || manifest?.product || DEFAULT_PRODUCT;
  const prodLabel = digest?.productLabel || productName(prodId);

  const sampleFiles = buildModuleSampleFiles(mod.moduleInfo, {
    manifest,
    labTitle,
    replacementEntries,
  });
  const sampleFilesPath = `${mod.folderName}/sample-files/`;
  const primarySampleFiles = sampleFiles.filter((f) => f.filename !== "README.txt");

  // 1. Teaching Objective & Opening Framing
  const teachingObjective = stripMarkdownFormatting(
    digest?.learningObjectives?.[0] ||
      `Guide learners to configure and validate ${mod.title} in ${prodLabel} for ${agentName}.`,
  );
  const whyHook = ensurePeriod(
    stripMarkdownFormatting(
      digest?.whyItMatters ||
        parsedTopic?.whyItMatters ||
        feature?.whyItMatters ||
        feature?.summary ||
        `This capability turns ${agentName} from a static prototype into a governed, production-aligned solution.`,
    ),
  );
  const cleanedScenario = digest?.inYourScenario
    ? stripMarkdownFormatting(digest.inYourScenario).replace(/:\s*$/, "").trim()
    : "";
  const scenarioTieIn =
    cleanedScenario && !/^sample input\b/i.test(cleanedScenario)
      ? ` In this workshop scenario: ${ensurePeriod(cleanedScenario)}`
      : "";
  const surfaceContextParts = [
    `Product surface: ${prodLabel}${harnessName ? ` (${harnessName})` : ""}.`,
    digest?.availabilityBadge ? `Release status: ${digest.availabilityBadge}.` : "",
    digest?.surfaceNotes?.[0] ? stripMarkdownFormatting(digest.surfaceNotes[0]) : "",
  ].filter(Boolean);

  // 2. Live Demo Talking Points (3-5 minutes)
  const steps = parsedTopic?.steps || [];
  const firstStepText = steps[0]?.text
    ? stripMarkdownFormatting(steps[0].text)
    : `Open ${prodLabel} and navigate to the ${mod.title} configuration surface.`;
  const midStepText = steps[Math.min(1, steps.length - 1)]?.text
    ? stripMarkdownFormatting(steps[Math.min(1, steps.length - 1)].text)
    : "";
  const archFlowSummary =
    Array.isArray(digest?.architectureFlow) && digest.architectureFlow.length >= 2
      ? stripMarkdownFormatting(digest.architectureFlow.slice(0, 2).join(" -> "))
      : `Configuration -> Orchestrator binding -> Runtime verification`;

  const liveDemoTalkingPoints = [
    `Frame the ${split.demoMinutes}-minute demo around the runtime mental model (${archFlowSummary}) before clicking into menus.`,
    `Show where ${mod.title} lives in ${prodLabel}: "${firstStepText}"${
      midStepText && midStepText !== firstStepText ? ` followed by "${midStepText}"` : ""
    }.`,
    primarySampleFiles.length > 0
      ? `Open \`${sampleFilesPath}${primarySampleFiles[0].filename}\` on screen so learners see where copy-ready inputs and synthetic datasets live before typing.`
      : `Point out the copy-ready configuration values and prompts so learners paste clean inputs rather than typing long strings manually.`,
    parsedTopic?.codeSnippets?.[0]?.code
      ? `Preview the verification prompt (\`${cleanText(parsedTopic.codeSnippets[0].code).slice(0, 110)}\`) in the test pane and highlight what a grounded response looks like.`
      : `Highlight the expected completion indicator (${stripMarkdownFormatting(digest?.expectedResults?.[0] || "Ready status and verified test response")}) before releasing the class for hands-on work.`,
  ];
  if (
    spSite?.configured &&
    (featureRequiresSharepointSite(feature) || featureRequiresSharepointSite(matchedMeta) || parsedTopic?.sharepointSite)
  ) {
    liveDemoTalkingPoints.push(
      `Confirm the target SharePoint site URL (${spSite.url || spSite.name}) has no file-level query parameters and remind learners that signed-in Entra ID ACLs govern query results.`,
    );
  }

  // 3. Step-by-Step Coaching & Pacing Cues
  const coachingAndPacingCues = [];
  coachingAndPacingCues.push(
    `Minute 0–${split.demoMinutes} (Instructor Demo): Keep your screen zoomed to 125%+ in ${prodLabel}; pause at navigation transitions so attendees orient their own tenant window.`,
  );
  if (steps.length > 0) {
    const checkpointIdx = Math.max(0, Math.floor((steps.length - 1) / 2));
    const checkpointStep = stripMarkdownFormatting(steps[checkpointIdx].text);
    coachingAndPacingCues.push(
      `Mid-Module Pacing Check (~Minute ${split.demoMinutes + Math.max(2, Math.floor(split.handsOnMinutes / 2))}): Ask for a quick thumbs-up once learners complete Step ${checkpointIdx + 1} ("${conciseSentence(checkpointStep, 110)}").`,
    );
  }
  if (primarySampleFiles.length > 0) {
    coachingAndPacingCues.push(
      `Sample Assets Cue: Direct learners to \`${sampleFilesPath}\` (${primarySampleFiles.map((f) => `\`${f.filename}\``).join(", ")}) so nobody stalls crafting test payloads from scratch.`,
    );
  }
  if (digest?.bestPractices?.[0]) {
    coachingAndPacingCues.push(
      `Coaching Callout: Reinforce this design habit while circulating — ${ensurePeriod(stripMarkdownFormatting(digest.bestPractices[0]))}`,
    );
  }
  coachingAndPacingCues.push(
    `Final 2 Minutes of Module: Prompt early finishers to run an out-of-scope boundary test prompt while you verify remaining attendees reach the expected completion state.`,
  );

  // 4. Common Learner Roadblocks & Fast Rescue Steps
  const roadblocksAndFastRescues = [];
  if (Array.isArray(feature?.prereqs) && feature.prereqs.length > 0) {
    const prereqNames = feature.prereqs.map((id) => getFeature(id)?.name || id).join(", ");
    roadblocksAndFastRescues.push({
      roadblock: `Attendee missed or broke an earlier prerequisite (${prereqNames}).`,
      fastRescue: `Have the attendee open \`${sampleFilesPath}starter-inputs-and-prompts.md\`, paste the baseline configuration values into their existing ${agentName} workspace (or clone your pre-staged backup solution/agent), and resume from Step 1 of ${mod.stepLabel} within 90 seconds.`,
    });
  } else {
    roadblocksAndFastRescues.push({
      roadblock: `Attendee is working in the Default environment instead of the designated workshop sandbox.`,
      fastRescue: `Use the top-right environment picker in ${prodLabel} to switch immediately to the workshop environment before saving connectors or knowledge sources; copy any typed text from \`${sampleFilesPath}starter-inputs-and-prompts.md\`.`,
    });
  }

  for (const item of (digest?.troubleshootingItems || []).slice(0, 2)) {
    const cleanItem = stripMarkdownFormatting(item);
    const parts = cleanItem.split(/\s+[—–-]\s+/);
    if (parts.length >= 2) {
      roadblocksAndFastRescues.push({
        roadblock: ensurePeriod(parts[0]),
        fastRescue: ensurePeriod(parts.slice(1).join(" — ")),
      });
    } else {
      roadblocksAndFastRescues.push({
        roadblock: `Configuration or validation check does not match expected state.`,
        fastRescue: ensurePeriod(cleanItem),
      });
    }
  }

  roadblocksAndFastRescues.push({
    roadblock: `Connector blocked by DLP policy, missing SharePoint read ACL, or preview toggle unavailable in attendee's tenant.`,
    fastRescue: `Pair the attendee with your shared demo screen or pre-provisioned test user account to observe live execution, record the exact admin control from Section 2 for their tenant admin, and keep the cohort moving on schedule.`,
  });

  // 5. Validation & Debrief Prompt
  const validationChecks = (digest?.checkItems || []).length
    ? digest.checkItems.map((c) => ensurePeriod(stripMarkdownFormatting(c.text || c)))
    : (digest?.expectedResults || []).length
      ? digest.expectedResults.map((r) => ensurePeriod(stripMarkdownFormatting(r)))
      : [`Confirm ${mod.title} saves cleanly without policy warnings and returns the expected test output.`];

  const debriefQuestion = `How would you govern and validate **${mod.title}** differently when promoting **${agentName}** from this workshop sandbox into a production business unit?`;
  const whatToListenFor = stripMarkdownFormatting(
    digest?.guardrails?.[0] ||
      digest?.bestPractices?.[0] ||
      `Listen for least-privilege Entra ID permissions, DLP connector classification, and repeatable evaluation checks before publishing.`,
  );

  // 6. Knowledge Check Answer Key & Rationales
  const knowledgeChecks = synthesizeModuleKnowledgeChecks({
    feature,
    parsedTopic,
    manifestMod: matchedMeta,
    order: mod.order,
    stepOrder: mod.stepOrder,
    agentName,
    topicTitle: mod.title,
  });

  return {
    order: mod.order,
    stepLabel: mod.stepLabel,
    isRecap: Boolean(mod.isRecap),
    id: mod.id || matchedMeta?.id || null,
    title: mod.title,
    levelLabel,
    productLabel: prodLabel,
    targetMinutes: split.targetMinutes,
    demoMinutes: split.demoMinutes,
    handsOnMinutes: split.handsOnMinutes,
    splitLabel: split.splitLabel,
    sampleFilesFolder: sampleFilesPath,
    sampleFiles: sampleFiles.map((f) => ({
      filename: f.filename,
      description: f.description,
    })),
    teachingObjectiveAndFraming: {
      objective: teachingObjective,
      whyLearnersCareHook: `${whyHook}${scenarioTieIn}`,
      productAndHarnessContext: surfaceContextParts.join(" "),
    },
    liveDemoTalkingPoints,
    coachingAndPacingCues,
    roadblocksAndFastRescues,
    validationAndDebrief: {
      confirmationChecks: validationChecks,
      discussionQuestion: debriefQuestion,
      whatToListenFor: ensurePeriod(whatToListenFor),
    },
    learnerKnowledgeCheckEnabled,
    knowledgeChecks,
  };
}

/**
 * Build a complete, JSON-serializable Facilitator Guide model from either a
 * generated lab directory path (`labDir`) or an in-memory context object
 * `{ labDir, labId, title, markdown, manifest, replacements, branding }`.
 */
export function buildFacilitatorGuideModel(labDirOrContext, options = {}) {
  if (
    labDirOrContext &&
    typeof labDirOrContext === "object" &&
    labDirOrContext.schemaVersion === FACILITATOR_GUIDE_SCHEMA_VERSION &&
    Array.isArray(labDirOrContext.modules) &&
    labDirOrContext.pacing
  ) {
    return labDirOrContext;
  }

  const ctx =
    typeof labDirOrContext === "string"
      ? { ...options, labDir: labDirOrContext }
      : { ...(labDirOrContext || {}), ...options };

  const resolvedLabDir = ctx.labDir ? path.resolve(ctx.labDir) : "";
  const rawMarkdown =
    ctx.markdown !== undefined
      ? String(ctx.markdown)
      : resolvedLabDir && fs.existsSync(path.join(resolvedLabDir, "index.md"))
        ? fs.readFileSync(path.join(resolvedLabDir, "index.md"), "utf8")
        : "";
  const rawManifest =
    ctx.manifest && typeof ctx.manifest === "object"
      ? ctx.manifest
      : resolvedLabDir && fs.existsSync(path.join(resolvedLabDir, "manifest.json"))
        ? JSON.parse(fs.readFileSync(path.join(resolvedLabDir, "manifest.json"), "utf8"))
        : {};

  const replacementEntries = normalizeReplacementEntries(ctx.replacements);
  const markdown = applyReplacements(rawMarkdown, replacementEntries);
  const manifest = applyReplacementsToValue(rawManifest, replacementEntries) || {};

  const labId =
    ctx.labId ||
    manifest.labId ||
    manifest.slug ||
    (resolvedLabDir ? path.basename(resolvedLabDir) : "generated-lab");

  const split = splitGeneratedLabModules(markdown, manifest, {
    labId,
    outputDir: resolvedLabDir,
  });

  const labTitle = cleanText(ctx.title || manifest.title || split.labTitle || labId);
  const rawProducts =
    (Array.isArray(manifest.products) && manifest.products.length && manifest.products) ||
    (manifest.product ? [manifest.product] : [DEFAULT_PRODUCT]);
  const productsLabel = productsPhrase(rawProducts);

  const harnessId =
    manifest?.request?.harness ||
    manifest?.differences?.labHarness ||
    manifest?.options?.harness ||
    null;
  const harnessObj = harnessId ? getHarnesses().find((h) => h.id === harnessId) : null;
  const harnessLabel = harnessObj ? harnessObj.name : harnessId || "Standard";

  const agentName = cleanText(
    manifest?.options?.agentName ||
      manifest?.request?.agentName ||
      manifest?.profile?.agentName ||
      "Workshop Agent",
  );

  // Determine whether student Knowledge Check mini-quizzes are enabled in the learner handout
  const explicitKcFlag =
    ctx.includeKnowledgeCheck ??
    manifest?.options?.includeKnowledgeCheck ??
    manifest?.request?.includeKnowledgeCheck;
  const markdownHasQuiz =
    /\*\*Knowledge check:\s*Lesson mini-quiz\*\*/i.test(markdown) ||
    /^#{3,4}\s+Knowledge check\b/im.test(markdown);
  const learnerKnowledgeCheckEnabled =
    typeof explicitKcFlag === "boolean" ? explicitKcFlag : markdownHasQuiz;

  const learnerKnowledgeCheckStatusText = learnerKnowledgeCheckEnabled
    ? "Enabled in learner handout — attendees see the multiple-choice Knowledge Check questions in their lab guide. Use the Answer Key and distractor rationales below during module debriefs."
    : "Disabled in learner handout — student lab guides omit Knowledge Check quizzes (`includeKnowledgeCheck: false`). This Facilitator Guide still includes the complete Answer Key and distractor rationales so you can run live verbal checks, polls, or Presenter View Q&A.";

  const spSite = resolveSharepointSite(
    manifest?.sharepointSite ||
      manifest?.request?.sharepointSite ||
      manifest?.request ||
      manifest?.options ||
      {},
  );
  const manifestModules = Array.isArray(manifest.modules) ? manifest.modules : [];
  const catalogFeaturesForLab = split.modules
    .map((m) => {
      const meta = manifestModules.find((mm) => Number(mm.order) === Number(m.order)) || {};
      return (m.id && getFeature(m.id)) || (meta.id && getFeature(meta.id)) || meta;
    })
    .filter(Boolean);
  const requiresSharepoint =
    spSite.configured ||
    labRequiresSharepointSite({ products: rawProducts, features: catalogFeaturesForLab });

  const adminPrerequisites = buildAdminPrerequisites({
    manifest,
    markdown,
    products: rawProducts,
    harness: harnessId,
  });

  const modulePlaybooks = split.modules.map((mod, idx) => {
    const matchedMeta =
      manifestModules.find((m) => Number(m.order) === Number(mod.order)) ||
      manifestModules[idx] ||
      {};
    const featureId = mod.id || matchedMeta.id || null;
    const feature = featureId ? getFeature(featureId) : null;
    const parsedTopic = parseTopicMarkdownStructure(mod.markdown, {
      labTitle,
      stepLabel: mod.stepLabel,
      topicTitle: mod.title,
      products: productsLabel,
      agentName,
    });
    const digest = resolveTopicTrainingDigest(parsedTopic, {
      featureId,
      harness: harnessId,
      agentName,
      manifest,
      module: matchedMeta,
      trainingDigest: matchedMeta.trainingDigest || null,
    });

    return buildModulePlaybookEntry({
      mod,
      matchedMeta,
      feature,
      parsedTopic,
      digest,
      manifest,
      labTitle,
      agentName,
      harnessName: harnessObj?.name || null,
      spSite,
      replacementEntries,
      learnerKnowledgeCheckEnabled,
    });
  });

  const pacing = buildPacingSchedule(modulePlaybooks, 15);

  const sharepointReadiness = {
    required: requiresSharepoint,
    configured: Boolean(spSite.configured),
    siteName: spSite.name || "",
    siteUrl: spSite.url || "",
    markdownLink: spSite.markdownLink || "",
    verificationSteps: requiresSharepoint
      ? [
          spSite.configured
            ? `Open the configured SharePoint site (${spSite.markdownLink || spSite.url || spSite.name}) using an attendee test account and confirm at least Read access to the target document library.`
            : `Provision or select a non-production SharePoint team/communication site and upload the synthetic policy documents from the module \`sample-files/\` folders at least 24 hours before class so search indexing completes.`,
          `Confirm SharePoint URLs pasted into knowledge sources point to the site or library root without file-level query parameters (\`?web=1\` or \`AllItems.aspx\`).`,
          `Verify test accounts carry Microsoft Entra ID permissions matching the documents you expect grounded responses to cite.`,
        ]
      : [
          `No mandatory SharePoint site dependency detected for the selected modules; skip SharePoint library provisioning unless demonstrating optional knowledge extensions.`,
        ],
  };

  const sampleFilesInventory = modulePlaybooks.map((m) => ({
    order: m.order,
    stepLabel: m.stepLabel,
    title: m.title,
    folderPath: m.sampleFilesFolder,
    files: m.sampleFiles,
  }));

  const twentyFourHourChecklist = [
    `Provision and test at least 2 non-production attendee accounts plus 1 clean instructor demo account in a dedicated InPrivate / Incognito browser profile.`,
    `Confirm target environment capacity, maker security roles, and active licensing / Copilot Studio message capacity for ${productsLabel}.`,
    `Verify all required connectors (${
      (adminPrerequisites.connectors || []).map((c) => c.name).join(", ") || "platform default connectors"
    }) sit in the **Business** data group of the active Power Platform DLP policy and none are Blocked.`,
    requiresSharepoint
      ? `Validate SharePoint site permissions and search indexing (${spSite.url || spSite.name || "target workshop SharePoint site"}) with a non-admin attendee account.`
      : `Confirm sandbox sample data and starter prompts open cleanly without external network blocks.`,
    `Distribute or stage the Complete Lab Package (\`.zip\`) so every attendee has local access to each \`Module NN .../sample-files/\` directory before class starts.`,
    `Open the workshop PowerPoint deck (\`.pptx\`) in PowerPoint Presenter View to verify speaker notes, live-demo talking points, and Knowledge Check rationales on your secondary monitor.`,
  ];

  return {
    schemaVersion: FACILITATOR_GUIDE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    labId,
    labDir: resolvedLabDir || null,
    title: labTitle,
    documentTitle: `${labTitle} - Facilitator Guide`,
    products: rawProducts,
    productsLabel,
    harness: harnessId,
    harnessLabel,
    agentName,
    difficulty: cleanText(manifest.difficulty || "Intermediate"),
    industry: cleanText(manifest.industry || manifest?.request?.industry || "Enterprise"),
    learnerKnowledgeCheckEnabled,
    learnerKnowledgeCheckStatusText,
    pacing,
    readinessRunbook: {
      leadTimeHours: 24,
      twentyFourHourChecklist,
      adminPrerequisites,
      sharepointReadiness,
      sampleFilesInventory,
    },
    modules: modulePlaybooks,
  };
}

/**
 * Render the Facilitator Guide model (or labDir/context) to clean, well-structured Markdown.
 */
export function renderFacilitatorGuideMarkdown(modelOrContext, options = {}) {
  const model = buildFacilitatorGuideModel(modelOrContext, options);
  const lines = [];

  lines.push(
    `# ${model.title} — Instructor & Facilitator Guide`,
    "",
    `> **Instructor-Only Delivery Manual:** This guide contains workshop pacing, T-24h tenant readiness checks, live-demo scripts, fast learner rescue steps, and the complete Knowledge Check Answer Key & rationales. Do not distribute directly to learners if running graded or blind knowledge checks.`,
    "",
    "## 1. Workshop Overview & Run-of-Show Pacing",
    "",
    "| Workshop Attribute | Details |",
    "| --- | --- |",
    `| **Workshop Title** | ${escapeMarkdownTableCell(model.title)} |`,
    `| **Products & Harness** | ${escapeMarkdownTableCell(`${model.productsLabel} (${model.harnessLabel})`)} |`,
    `| **Target Solution / Agent** | ${escapeMarkdownTableCell(model.agentName)} |`,
    `| **Module Count** | ${model.modules.length} module${model.modules.length === 1 ? "" : "s"} |`,
    `| **Recommended Pre-Flight Buffer** | ${model.pacing.preFlightBufferMinutes} minutes (sign-in, environment check, sample-files verification) |`,
    `| **Core Module Delivery Time** | ${model.pacing.modulesMinutes} minutes${
      model.pacing.breakMinutes > 0
        ? ` + ${model.pacing.breakMinutes} minutes suggested break buffer`
        : ""
    } |`,
    `| **Total Scheduled Workshop Window** | **${model.pacing.totalWorkshopMinutes} minutes** |`,
    `| **Learner Handout Knowledge Checks** | ${escapeMarkdownTableCell(
      model.learnerKnowledgeCheckEnabled
        ? "Enabled in learner handout (Answer Key & distractor rationales included below)"
        : "Unchecked / omitted in learner handout (Full Answer Key & rationales still included below for live verbal checks)",
    )} |`,
    "",
    `> **Knowledge Check Delivery Note:** ${model.learnerKnowledgeCheckStatusText}`,
    "",
    "### Run-of-Show Pacing Table",
    "",
    "| Window | Segment | Module / Activity | Level | Target Min | Demo vs. Hands-On Split | Facilitator Pacing Cue |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );

  for (const row of model.pacing.rows) {
    lines.push(
      `| ${escapeMarkdownTableCell(row.clockWindow)} | **${escapeMarkdownTableCell(row.stepLabel)}** | ${escapeMarkdownTableCell(row.title)} | ${escapeMarkdownTableCell(row.levelLabel)} | ${row.targetMinutes} min | ${escapeMarkdownTableCell(row.splitLabel)} | ${escapeMarkdownTableCell(row.notes)} |`,
    );
  }

  lines.push(
    "",
    "---",
    "",
    "## 2. Pre-Delivery Tenant, Licensing & Environment Readiness Runbook (T-24 Hours)",
    "",
    "Complete this readiness verification **at least 24 hours before class** using a non-admin attendee test account so tenant policy or indexing delays never stall live delivery.",
    "",
    "### 24-Hour Pre-Flight Verification Checklist",
    "",
  );

  for (const item of model.readinessRunbook.twentyFourHourChecklist) {
    lines.push(`- [ ] ${item}`);
  }

  const prereqs = model.readinessRunbook.adminPrerequisites || {};
  if (Array.isArray(prereqs.connectors) && prereqs.connectors.length > 0) {
    lines.push(
      "",
      "### Required Connectors & DLP Data Groups",
      "",
      "| Connector | Required DLP Group | Auth / Scope | Admin Center Path & Notes |",
      "| --- | --- | --- | --- |",
    );
    for (const c of prereqs.connectors) {
      const endpoints =
        Array.isArray(c.endpoints) && c.endpoints.length
          ? ` Endpoints: \`${c.endpoints.slice(0, 2).join("`, `")}\`.`
          : "";
      lines.push(
        `| **${escapeMarkdownTableCell(c.name)}** | ${escapeMarkdownTableCell(c.dataGroup || "Business")} | ${escapeMarkdownTableCell(c.authType || "Delegated user / OAuth")} | ${escapeMarkdownTableCell(`${c.details || ""}${endpoints} (${c.adminPath || "Power Platform admin center"})`)} |`,
      );
    }
  }

  const govItems = [
    ...(prereqs.dlpAndAcp || []).map((g) => ({ category: "DLP & ACP", ...g })),
    ...(prereqs.environmentSettings || []).map((e) => ({ category: "Environment", ...e })),
    ...(prereqs.tenantAndCloud || []).map((t) => ({ category: "Tenant & RBAC", ...t })),
  ];
  if (govItems.length > 0) {
    lines.push(
      "",
      "### DLP, ACP, Environment & Tenant Guardrails",
      "",
      "| Area | Control | Status | Verification Guidance & Admin Path |",
      "| --- | --- | --- | --- |",
    );
    for (const item of govItems) {
      lines.push(
        `| ${escapeMarkdownTableCell(item.category)} | **${escapeMarkdownTableCell(item.title)}** | ${escapeMarkdownTableCell(item.status || "Required")} | ${escapeMarkdownTableCell(`${item.details || ""} (${item.adminPath || "Admin center"})`)} |`,
      );
    }
  }

  const sp = model.readinessRunbook.sharepointReadiness;
  lines.push(
    "",
    "### Target SharePoint Site Readiness Check",
    "",
    `- **SharePoint Grounding Required:** ${sp.required ? "Yes" : "Optional / Not required by selected modules"}`,
    ...(sp.configured
      ? [`- **Configured Workshop SharePoint Site:** ${sp.markdownLink || sp.siteUrl || sp.siteName}`]
      : []),
    ...sp.verificationSteps.map((step) => `- [ ] ${step}`),
    "",
    "### Per-Module Sample Files Verification (`sample-files/`)",
    "",
    "Confirm the Complete Lab Package `.zip` includes the following scenario-tailored starter assets:",
    "",
    "| Module | Sample Files Folder | Included Starter Assets |",
    "| --- | --- | --- |",
  );

  for (const inv of model.readinessRunbook.sampleFilesInventory) {
    const fileList = inv.files
      .map((f) => `\`${f.filename}\` (${cleanText(f.description)})`)
      .join("; ");
    lines.push(
      `| **${escapeMarkdownTableCell(`${inv.stepLabel} — ${inv.title}`)}** | \`${escapeMarkdownTableCell(inv.folderPath)}\` | ${escapeMarkdownTableCell(fileList)} |`,
    );
  }

  lines.push(
    "",
    "---",
    "",
    "## 3. Per-Module Facilitator Playbook",
  );

  for (const mod of model.modules) {
    lines.push(
      "",
      `### ${mod.stepLabel} — ${mod.title}`,
      "",
      `*${mod.levelLabel} · ${mod.targetMinutes} min (${mod.splitLabel}) · ${mod.productLabel}*`,
      "",
      "#### Teaching Objective & Opening Framing",
      "",
      `- **Teaching Objective:** ${mod.teachingObjectiveAndFraming.objective}`,
      `- **Why Learners Care (Opening Hook):** ${mod.teachingObjectiveAndFraming.whyLearnersCareHook}`,
      `- **Product & Harness Context:** ${mod.teachingObjectiveAndFraming.productAndHarnessContext}`,
      "",
      `#### Live Demo Talking Points (${mod.demoMinutes} Minutes)`,
      "",
      ...mod.liveDemoTalkingPoints.map((pt, idx) => `${idx + 1}. ${pt}`),
      "",
      "#### Step-by-Step Coaching & Pacing Cues",
      "",
      ...mod.coachingAndPacingCues.map((cue) => `- ${cue}`),
      "",
      "#### Common Learner Roadblocks & Fast Rescue Steps",
      "",
      "| Learner Roadblock / Symptom | Fast Facilitator Rescue (Keep Class Moving) |",
      "| --- | --- |",
      ...mod.roadblocksAndFastRescues.map(
        (r) =>
          `| **${escapeMarkdownTableCell(r.roadblock)}** | ${escapeMarkdownTableCell(r.fastRescue)} |`,
      ),
      "",
      "#### Validation & Debrief Prompt",
      "",
      ...mod.validationAndDebrief.confirmationChecks.map((chk) => `- [ ] **Room Check:** ${chk}`),
      `- **Facilitator Debrief Question:** ${mod.validationAndDebrief.discussionQuestion}`,
      `- **What to Listen For:** ${mod.validationAndDebrief.whatToListenFor}`,
      "",
      "#### Knowledge Check Answer Key & Rationales",
      "",
      mod.learnerKnowledgeCheckEnabled
        ? "*Status: Included in learner handout — review answers and distractor rationales after learners attempt each question.*"
        : "*Status: Omitted from learner handout (`includeKnowledgeCheck: false`) — pose these questions verbally or in Presenter View.*",
    );

    for (const kc of mod.knowledgeChecks) {
      const learnLink = `[${kc.learnTitle}](${safeMarkdownUrl(kc.learnUrl)})`;
      lines.push(
        "",
        `**Question ${kc.number}:** ${kc.question}`,
        "",
        ...kc.options.map(
          (opt) =>
            `- **${opt.letter}.** ${opt.text}${opt.isCorrect ? " *(Correct Answer)*" : ""}`,
        ),
        "",
        `- **Correct Choice (${kc.correctLetter}):** ${kc.explanation}`,
        ...kc.distractorRationales.map(
          (d) => `- **Why ${d.letter} is incorrect:** ${d.whyWrong}`,
        ),
        `- **Microsoft Learn Reference:** ${learnLink}`,
      );
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Render the Facilitator Guide to an ECMA-376 `.docx` buffer with branding support.
 */
export function renderFacilitatorGuideDocxBuffer(modelOrContext, options = {}) {
  const model = buildFacilitatorGuideModel(modelOrContext, options);
  const branding = options.branding || modelOrContext?.branding || undefined;
  const markdown = `${renderFacilitatorGuideMarkdown(model, options).replace(/\s+$/, "")}\n${renderBrandInfoMarkdown(branding)}`;
  const resolveImageBuffer =
    typeof options.resolveImageBuffer === "function"
      ? options.resolveImageBuffer
      : model.labDir
        ? createLabImageResolver(model.labDir)
        : undefined;

  return buildDocxFromLabMarkdown(markdown, {
    title: model.documentTitle,
    branding,
    resolveImageBuffer,
  });
}

/**
 * Render the Facilitator Guide to a PDF 1.4 `.pdf` buffer with branding support.
 */
export function renderFacilitatorGuidePdfBuffer(modelOrContext, options = {}) {
  const model = buildFacilitatorGuideModel(modelOrContext, options);
  const branding = options.branding || modelOrContext?.branding || undefined;
  const markdown = `${renderFacilitatorGuideMarkdown(model, options).replace(/\s+$/, "")}\n${renderBrandInfoMarkdown(branding)}`;
  const resolveImageBuffer =
    typeof options.resolveImageBuffer === "function"
      ? options.resolveImageBuffer
      : model.labDir
        ? createLabImageResolver(model.labDir)
        : undefined;

  return buildPdfFromLabMarkdown(markdown, {
    title: model.documentTitle,
    branding,
    resolveImageBuffer,
  });
}

/**
 * Render the Facilitator Guide as a standalone, printable HTML document with
 * light/dark theme support and clean print pagination styles.
 */
export function renderFacilitatorGuideHtml(modelOrContext, options = {}) {
  const model = buildFacilitatorGuideModel(modelOrContext, options);
  const branding = options.branding || modelOrContext?.branding || {};
  const primaryColor = /^#[0-9a-fA-F]{6}$/.test(String(branding.primaryColor || ""))
    ? branding.primaryColor
    : "#0f6cbd";
  const companyName = cleanText(branding.companyName || "Microsoft AI Training Generator");
  const tagline = cleanText(branding.tagline || "Instructor & Facilitator Delivery Pack");
  const coverSubtitle = cleanText(branding.coverSubtitle);
  const secondaryHex = normalizeHexColor6(branding.secondaryColor);
  const secondaryLight = secondaryHex ? ensureReadableColor(secondaryHex, ["#ffffff", "#f8fafc"], "#123f9a", 3) : "";
  const secondaryDark = secondaryHex ? ensureReadableColor(secondaryHex, ["#1e293b", "#0f172a"], "#93c5fd", 3) : "";
  const bodyFontStack = getBrandFont(branding.font).css || '"Segoe UI", system-ui, -apple-system, sans-serif';
  const brandInfoHtml = renderBrandInfoHtml(branding, { className: "brand-info" });

  const pacingRowsHtml = model.pacing.rows
    .map(
      (row) => `<tr class="row-${escapeHtml(row.kind)}">
        <td><code>${escapeHtml(row.clockWindow)}</code></td>
        <td><strong>${escapeHtml(row.stepLabel)}</strong></td>
        <td>${escapeHtml(row.title)}</td>
        <td>${escapeHtml(row.levelLabel)}</td>
        <td>${row.targetMinutes} min</td>
        <td>${escapeHtml(row.splitLabel)}</td>
        <td>${escapeHtml(row.notes)}</td>
      </tr>`,
    )
    .join("\n");

  const checklistHtml = model.readinessRunbook.twentyFourHourChecklist
    .map((item) => `<li><label><input type="checkbox"> <span>${escapeHtml(item)}</span></label></li>`)
    .join("\n");

  const prereqs = model.readinessRunbook.adminPrerequisites || {};
  const connectorsHtml =
    Array.isArray(prereqs.connectors) && prereqs.connectors.length > 0
      ? `<h3>Required Connectors &amp; DLP Data Groups</h3>
      <table>
        <thead><tr><th>Connector</th><th>Required DLP Group</th><th>Auth / Scope</th><th>Admin Path &amp; Notes</th></tr></thead>
        <tbody>
          ${prereqs.connectors
            .map(
              (c) => `<tr>
                <td><strong>${escapeHtml(c.name)}</strong></td>
                <td>${escapeHtml(c.dataGroup || "Business")}</td>
                <td>${escapeHtml(c.authType || "Delegated / OAuth")}</td>
                <td>${escapeHtml(`${c.details || ""} (${c.adminPath || "Power Platform admin center"})`)}</td>
              </tr>`,
            )
            .join("\n")}
        </tbody>
      </table>`
      : "";

  const sampleFilesRowsHtml = model.readinessRunbook.sampleFilesInventory
    .map(
      (inv) => `<tr>
        <td><strong>${escapeHtml(`${inv.stepLabel} — ${inv.title}`)}</strong></td>
        <td><code>${escapeHtml(inv.folderPath)}</code></td>
        <td>${inv.files
          .map((f) => `<code>${escapeHtml(f.filename)}</code> — ${escapeHtml(f.description)}`)
          .join("<br>")}</td>
      </tr>`,
    )
    .join("\n");

  const modulesHtml = model.modules
    .map((mod) => {
      const kcHtml = mod.knowledgeChecks
        .map(
          (kc) => `<div class="kc-card">
            <div class="kc-q"><strong>Question ${kc.number}:</strong> ${escapeHtml(kc.question)}</div>
            <ul class="kc-options">
              ${kc.options
                .map(
                  (opt) => `<li class="${opt.isCorrect ? "kc-correct" : "kc-distractor"}">
                    <strong>${escapeHtml(opt.letter)}.</strong> ${escapeHtml(opt.text)}
                    ${opt.isCorrect ? '<span class="badge-correct">Correct Answer</span>' : ""}
                    <div class="kc-rationale">${
                      opt.isCorrect
                        ? `<strong>Why ${escapeHtml(opt.letter)} is right:</strong> ${escapeHtml(opt.rationale)}`
                        : `<strong>Why ${escapeHtml(opt.letter)} is wrong:</strong> ${escapeHtml(opt.rationale)}`
                    }</div>
                  </li>`,
                )
                .join("\n")}
            </ul>
            <div class="kc-ref">Microsoft Learn Source: <a href="${escapeHtml(kc.learnUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(kc.learnTitle)}</a></div>
          </div>`,
        )
        .join("\n");

      return `<section class="module-card" id="module-${mod.order}">
        <div class="module-header">
          <span class="step-pill">${escapeHtml(mod.stepLabel)}</span>
          <h3>${escapeHtml(mod.title)}</h3>
          <div class="module-meta">${escapeHtml(mod.levelLabel)} &middot; ${mod.targetMinutes} min (${escapeHtml(mod.splitLabel)}) &middot; ${escapeHtml(mod.productLabel)}</div>
        </div>

        <h4>Teaching Objective &amp; Opening Framing</h4>
        <ul>
          <li><strong>Teaching Objective:</strong> ${escapeHtml(mod.teachingObjectiveAndFraming.objective)}</li>
          <li><strong>Why Learners Care:</strong> ${escapeHtml(mod.teachingObjectiveAndFraming.whyLearnersCareHook)}</li>
          <li><strong>Product &amp; Harness Context:</strong> ${escapeHtml(mod.teachingObjectiveAndFraming.productAndHarnessContext)}</li>
        </ul>

        <h4>Live Demo Talking Points (${mod.demoMinutes} Minutes)</h4>
        <ol>
          ${mod.liveDemoTalkingPoints.map((pt) => `<li>${escapeHtml(pt)}</li>`).join("\n")}
        </ol>

        <h4>Step-by-Step Coaching &amp; Pacing Cues</h4>
        <ul>
          ${mod.coachingAndPacingCues.map((cue) => `<li>${escapeHtml(cue)}</li>`).join("\n")}
        </ul>

        <h4>Common Learner Roadblocks &amp; Fast Rescue Steps</h4>
        <table>
          <thead><tr><th>Learner Roadblock / Symptom</th><th>Fast Facilitator Rescue</th></tr></thead>
          <tbody>
            ${mod.roadblocksAndFastRescues
              .map(
                (r) => `<tr><td><strong>${escapeHtml(r.roadblock)}</strong></td><td>${escapeHtml(r.fastRescue)}</td></tr>`,
              )
              .join("\n")}
          </tbody>
        </table>

        <h4>Validation &amp; Debrief Prompt</h4>
        <ul class="checklist">
          ${mod.validationAndDebrief.confirmationChecks
            .map((chk) => `<li><label><input type="checkbox"> <span><strong>Room Check:</strong> ${escapeHtml(chk)}</span></label></li>`)
            .join("\n")}
        </ul>
        <p><strong>Debrief Question:</strong> ${escapeHtml(stripMarkdownFormatting(mod.validationAndDebrief.discussionQuestion))}<br>
        <strong>What to Listen For:</strong> ${escapeHtml(mod.validationAndDebrief.whatToListenFor)}</p>

        <h4>Knowledge Check Answer Key &amp; Rationales</h4>
        <p class="kc-status-note">${escapeHtml(
          mod.learnerKnowledgeCheckEnabled
            ? "Included in learner handout — review answers and distractor rationales during module debrief."
            : "Omitted from learner handout (includeKnowledgeCheck: false) — use for live verbal checks or Presenter View Q&A.",
        )}</p>
        ${kcHtml}
      </section>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(model.documentTitle)}</title>
  <style>
    :root {
      --accent: ${primaryColor};${secondaryLight ? `\n      --accent2: ${secondaryLight};` : ""}
      --bg: #f8fafc;
      --surface: #ffffff;
      --text: #0f172a;
      --muted: #475569;
      --border: #cbd5e1;
      --row-alt: #f1f5f9;
      --break-bg: #fffbeb;
      --ok-bg: #ecfdf5;
      --ok-border: #10b981;
    }
    html[data-theme="dark"] {${secondaryDark ? `\n      --accent2: ${secondaryDark};` : ""}
      --bg: #0f172a;
      --surface: #1e293b;
      --text: #f1f5f9;
      --muted: #94a3b8;
      --border: #334155;
      --row-alt: #0f172a;
      --break-bg: #422006;
      --ok-bg: #064e3b;
      --ok-border: #34d399;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ${bodyFontStack};
      background: var(--bg);
      color: var(--text);
      line-height: 1.55;
    }
    .container { max-width: 1080px; margin: 0 auto; padding: 28px 24px 64px; }
    header.hero {
      background: var(--surface);
      border: 1px solid var(--border);
      border-bottom: 4px solid var(--accent2, var(--border));
      border-radius: 10px;
      padding: 22px 24px;
      margin-bottom: 24px;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
    }
    .hero-kicker { font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--accent); font-weight: 700; }
    h1 { margin: 6px 0 8px; font-size: 1.75rem; }
    h2 { margin-top: 32px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
    .toolbar { display: flex; gap: 8px; flex-shrink: 0; }
    .toolbar button {
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      padding: 7px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
    }
    .callout {
      background: var(--row-alt);
      border: 1px solid var(--border);
      padding: 12px 16px;
      border-radius: 8px;
      margin: 14px 0;
    }
    table { width: 100%; border-collapse: collapse; margin: 14px 0 20px; background: var(--surface); font-size: 0.92rem; }
    th, td { border: 1px solid var(--border); padding: 9px 11px; text-align: left; vertical-align: top; }
    th { background: var(--row-alt); font-weight: 700; }
    tr.row-break td { background: var(--break-bg); font-weight: 600; }
    ul.checklist { list-style: none; padding-left: 0; }
    ul.checklist li { margin: 6px 0; }
    .module-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 20px 24px;
      margin: 22px 0;
      page-break-inside: avoid;
    }
    .step-pill {
      display: inline-block;
      background: var(--accent);
      color: #fff;
      padding: 2px 10px;
      border-radius: 999px;
      font-size: 0.78rem;
      font-weight: 700;
    }
    .module-meta { color: var(--muted); font-size: 0.9rem; margin-top: 4px; }
    .kc-card { border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; margin: 12px 0; }
    .kc-options { list-style: none; padding-left: 0; margin: 10px 0; }
    .kc-options li { padding: 8px 10px; border-radius: 6px; margin-bottom: 6px; border: 1px solid var(--border); }
    .kc-options li.kc-correct { background: var(--ok-bg); border-color: var(--ok-border); }
    .badge-correct {
      display: inline-block;
      margin-left: 8px;
      padding: 1px 8px;
      border-radius: 999px;
      font-size: 0.75rem;
      font-weight: 700;
      background: var(--ok-border);
      color: #06281e;
    }
    .kc-rationale { font-size: 0.86rem; color: var(--muted); margin-top: 4px; }
    .kc-ref { font-size: 0.85rem; margin-top: 6px; }
    a { color: var(--accent); }
    .brand-info { margin-top: 40px; padding-top: 16px; border-top: 2px solid var(--accent2, var(--border)); }
    .brand-info h2 { margin-top: 12px; font-size: 1.1rem; }
    .brand-info p { margin: 6px 0; }
    .brand-info-footer { color: var(--muted); font-size: 0.9rem; }
    @media print {
      body { background: #fff; color: #000; }
      .toolbar { display: none !important; }
      .container { max-width: 100%; padding: 0; }
      .module-card { break-inside: avoid; box-shadow: none; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="hero">
      <div>
        <div class="hero-kicker">${escapeHtml(companyName)} &middot; ${escapeHtml(tagline)}</div>
        <h1>${escapeHtml(model.title)} — Facilitator Guide</h1>
        <div class="module-meta">${escapeHtml(model.productsLabel)} (${escapeHtml(model.harnessLabel)}) &middot; ${model.modules.length} Modules &middot; Total Window: ${model.pacing.totalWorkshopMinutes} min (includes ${model.pacing.preFlightBufferMinutes} min pre-flight)</div>${coverSubtitle ? `\n        <div class="module-meta"><em>${escapeHtml(coverSubtitle)}</em></div>` : ""}
      </div>
      <div class="toolbar">
        <button type="button" onclick="document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'">Toggle Theme</button>
        <button type="button" onclick="window.print()">Print / Save PDF</button>
      </div>
    </header>

    <div class="callout">
      <strong>Learner Handout Knowledge Check Status:</strong> ${escapeHtml(model.learnerKnowledgeCheckStatusText)}
    </div>

    <h2>1. Workshop Overview &amp; Run-of-Show Pacing</h2>
    <table>
      <thead>
        <tr><th>Window</th><th>Segment</th><th>Module / Activity</th><th>Level</th><th>Target</th><th>Demo vs. Hands-On</th><th>Facilitator Cue</th></tr>
      </thead>
      <tbody>
        ${pacingRowsHtml}
      </tbody>
    </table>

    <h2>2. Pre-Delivery Tenant, Licensing &amp; Environment Readiness Runbook (T-24h)</h2>
    <ul class="checklist">
      ${checklistHtml}
    </ul>
    ${connectorsHtml}
    <h3>Target SharePoint Site Readiness</h3>
    <ul class="checklist">
      ${model.readinessRunbook.sharepointReadiness.verificationSteps
        .map((s) => `<li><label><input type="checkbox"> <span>${escapeHtml(s)}</span></label></li>`)
        .join("\n")}
    </ul>
    <h3>Per-Module Sample Files Inventory (<code>sample-files/</code>)</h3>
    <table>
      <thead><tr><th>Module</th><th>Folder</th><th>Starter Assets</th></tr></thead>
      <tbody>${sampleFilesRowsHtml}</tbody>
    </table>

    <h2>3. Per-Module Facilitator Playbook</h2>
    ${modulesHtml}
    ${brandInfoHtml}
  </div>
</body>
</html>
`;
}
