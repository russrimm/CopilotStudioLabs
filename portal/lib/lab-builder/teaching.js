/**
 * Teaching blocks for a generated lab: the parts that turn a list of clicks into
 * a walkthrough a learner can follow and check themselves against.
 *
 * Everything here is deterministic and derived from text the catalog already
 * vets (summary, why it matters, concepts, validation, doc URLs) and from the
 * scenario profile, so no block invents a UI path, a limit, or a URL. Optional
 * catalog fields (`expectedResults`, `troubleshooting`) take precedence when a
 * feature supplies them. `u` carries the composer's text helpers
 * ({ scrub, esc, lowerFirst, bullets }), passed in to avoid a circular import.
 */

import { getFeature } from "./catalog.js";
import { getProduct } from "./products.js";
import { DELIVERABLE_MODES, describeDeliverable } from "./deliverable.js";
import {
  canonicalLearnPageKey,
  dedupeLearnSources,
  formatCitationLabel,
  normalizeCitationTitleKey,
  selectRelevantLearnSource,
} from "./learn-citations.js";

const CAUTION = /\b(?:can't|cannot|can not|must|requires?|required|only|unavailable|isn't|aren't|not available|don't|doesn't|won't|might|may not|limits?)\b/i;

const CREATE_IDS = new Set(["create-agent", "mc-create-agent", "cc-create-agent"]);
const INSTRUCTION_IDS = new Set(["agent-instructions", "mc-instructions", "cc-instructions"]);
const TEST_IDS = new Set(["test-agent", "multiturn-tests", "mc-preview-test", "cc-preview-test", "evaluations", "mc-evaluate", "cc-evaluate"]);
const DCA_CREATE_IDS = new Set(["dca-agent-builder-first-agent", "dca-agent-builder-configure", "dca-typespec-copilot-pro-dev"]);
const PPAI_PROMPT_IDS = new Set([
  "ppai-prompt-builder-basics",
  "ppai-prompt-inputs-and-variables",
  "ppai-prompt-dataverse-grounding",
  "ppai-prompt-json-and-structured-output",
  "ppai-prompt-model-choice-and-tuning",
]);
const FDY_PLAYGROUND_IDS = new Set([
  "fdy-explore-model-catalog",
  "fdy-deploy-serverless-model",
  "fdy-deploy-provisioned-throughput",
  "fdy-chat-playground-and-parameters",
  "fdy-structured-outputs-and-tools",
  "fdy-evaluate-genai-app",
  "fdy-safety-and-risk-evaluations",
  "fdy-red-teaming-agent",
]);

function firstSentence(text) {
  const match = String(text || "").trim().match(/^.*?[.!?](?=\s|$)/);
  return (match ? match[0] : String(text || "")).trim();
}

/** True for text that only says a topic is unreviewed or restates its Learn summary; none of it can be a quiz answer. */
export function isUnreviewedText(text) {
  return /^\s*\[Unverified\]|^\s*Microsoft Learn describes this topic as\b|was found on Microsoft Learn and is not yet part of|Not confirmed in Microsoft Learn/i.test(String(text || ""));
}

/** Caller-supplied text inside a code fence: it must not be able to close the fence or add markup. */
function plain(text) {
  return String(text ?? "").replace(/[`<>*_~|\[\]\\\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function trimStop(text) {
  return String(text || "").trim().replace(/[.!?]+$/, "");
}

function ensureStop(text) {
  const clean = String(text || "").trim();
  if (!clean) return "";
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
}

function conciseSentence(text, maxChars = 160) {
  const sentence = ensureStop(firstSentence(text).replace(/\s+/g, " ").trim());
  if (sentence.length <= maxChars) return sentence;
  const cut = sentence.slice(0, maxChars);
  const space = cut.lastIndexOf(" ");
  return `${(space > 60 ? cut.slice(0, space) : cut).replace(/[,:;.\s]+$/, "")}.`;
}

function safeMarkdownUrl(url) {
  return String(url || "").replace(/[()\s]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

function moduleLearnSources(feature, grounding, u) {
  return dedupeLearnSources(
    [
      ...(grounding?.sources || []),
      ...((feature?.docUrls || []).map((url) => ({ title: url, url }))),
      ...(feature?.verifiedAgainst ? [{ title: feature.verifiedAgainst, url: feature.verifiedAgainst }] : []),
    ],
    { scrub: u.scrub },
  );
}

function learnReferenceLink(sources, contextText, u) {
  const chosen = selectRelevantLearnSource(sources, contextText);
  if (!chosen?.url) return null;
  const label = u.label ? u.label(chosen) : formatCitationLabel(chosen, u.scrub);
  return `[${label}](${safeMarkdownUrl(chosen.url)})`;
}

/** The "What you should see" block: a screen to compare against and an outcome to confirm. */
export function expectedResultBlock(feature, shots, u) {
  const items = [];
  const authored = Array.isArray(feature.expectedResults) ? feature.expectedResults : [];
  for (const line of authored) items.push(u.scrub(line));

  if (!authored.length) {
    const shown = shots?.capture?.length ? shots.capture[shots.capture.length - 1] : null;
    if (shown) items.push(`Compare your screen with Figure ${shown.figure}: ${u.lowerFirst(trimStop(shown.alt))}.`);
    if (feature.validation?.length) items.push(`Expected outcome: ${u.scrub(feature.validation[0])}`);
  }
  if (!items.length) return [];
  return ["", "**What you should see.** After the last numbered step:", "", u.bullets(items)];
}

/** Troubleshooting: authored items first, then cautions already in the concepts, then universal checks. */
export function troubleshootingBlock(feature, u, grounding) {
  const items = [];
  const learnSources = moduleLearnSources(feature, grounding, u);
  for (const entry of feature.troubleshooting || []) {
    if (entry?.symptom && entry?.fix) {
      const ref = learnReferenceLink(learnSources, `${entry.symptom} ${entry.fix} ${feature.name}`, u);
      items.push(
        `**${u.scrub(entry.symptom)}** ${ensureStop(u.scrub(entry.fix))}${ref ? ` See ${ref} on Microsoft Learn.` : ""}`,
      );
    }
  }

  const cautions = (feature.concepts || []).filter((c) => CAUTION.test(c));
  for (const caution of cautions.slice(0, 2)) {
    const ref = learnReferenceLink(learnSources, `${caution} ${feature.name}`, u);
    items.push(
      `**Watch for this.** ${ensureStop(u.scrub(caution))}${ref ? ` Review ${ref} on Microsoft Learn.` : ""}`,
    );
  }

  const primaryRef = learnReferenceLink(learnSources, `${feature.name} ${feature.summary || ""}`, u);
  items.push(
    `**A step does not match your screen.** Product screens change often. Compare with ${
      primaryRef || "the Microsoft Learn page for this module"
    } and follow it where the two differ.`,
  );
  if (feature.validation?.length) {
    items.push(
      `**"${trimStop(u.scrub(feature.validation[0]))}" is not true yet.** Repeat the numbered steps in order, and confirm you are working in the environment you chose at the start of the lab.`,
    );
  }
  if (feature.availability === "preview") {
    items.push("**An option is missing.** This capability is in preview, so it might not be available in every tenant or region yet.");
  }
  return ["", "**Troubleshooting**", "", u.bullets(items)];
}

const OPTION_LETTERS = ["A", "B", "C", "D"];

function placeCorrectOption(correctText, distractors, targetSlot) {
  const pool = distractors.slice(0, 3);
  const slot = ((targetSlot % 4) + 4) % 4;
  const ordered = [...pool];
  ordered.splice(slot, 0, correctText);
  return {
    correctLetter: OPTION_LETTERS[slot],
    options: ordered.slice(0, 4).map((text, idx) => `**${OPTION_LETTERS[idx]}.** ${text}`),
  };
}

/**
 * Per-lesson multiple-choice mini-quiz derived deterministically from vetted
 * catalog content and linked to the module's Microsoft Learn references.
 */
export function knowledgeCheckBlock(feature, plan, u, grounding) {
  if (plan?.includeKnowledgeCheck === false) return [];

  const agent = u.esc(plan.profile.agentName);
  const name = u.scrub(feature.name);
  const learnSources = moduleLearnSources(feature, grounding, u);
  const stepSeed = Number(feature.stepOrder ?? feature.order ?? 1);
  const questions = [];

  const whyFull = ensureStop(u.scrub(feature.whyItMatters || feature.summary));
  const whyConcise = conciseSentence(whyFull, 160);
  const whyRef = learnReferenceLink(learnSources, `${feature.name} ${feature.whyItMatters || feature.summary || ""}`, u);
  // Text about an unreviewed topic is a disclaimer, not content: a quiz must never ask for it as the right answer.
  if (!isUnreviewedText(feature.whyItMatters || feature.summary)) questions.push({
    prompt: `Why do you configure **${name}** for **${agent}** in this scenario?`,
    correct: whyConcise,
    distractors: [
      `It bypasses environment permissions for ${name}.`,
      `It skips validation checks for ${name} before rollout.`,
      `It deletes prior settings configured in ${name}.`,
    ],
    explanation: `${whyFull}${whyRef ? ` Review how **${name}** works in ${whyRef}.` : ""}`,
    learnRef: whyRef,
  });

  const verifyRaw = feature.validation?.[0] || feature.expectedResults?.[0];
  if (verifyRaw && !isUnreviewedText(verifyRaw)) {
    const verifyFull = ensureStop(u.scrub(verifyRaw));
    const secondaryVerify = feature.validation?.[1] ? ` Also verify: ${ensureStop(u.scrub(feature.validation[1]))}` : "";
    const verifyRef = learnReferenceLink(
      learnSources,
      `${feature.name} ${verifyRaw} ${feature.validation?.[1] || ""}`,
      u,
    );
    questions.push({
      prompt: `Which check confirms that **${name}** is working as expected?`,
      correct: conciseSentence(verifyFull, 160),
      distractors: [
        `Closing the tab right after opening ${name} without testing.`,
        `Skipping the Check your work list for ${name}.`,
        `Removing ${name} before running any scenario test.`,
      ],
      explanation: `Confirm **${name}** by checking this outcome: ${verifyFull}${secondaryVerify}${
        verifyRef ? ` Compare expected results in ${verifyRef}.` : ""
      }`,
      learnRef: verifyRef,
    });
  }

  const cautionConcept = (feature.concepts || []).find((c) => CAUTION.test(c) && !isUnreviewedText(c));
  const conceptRaw =
    cautionConcept ||
    (feature.concepts || []).find((c) => !isUnreviewedText(c)) ||
    (feature.troubleshooting?.[0]?.fix ? `${feature.troubleshooting[0].symptom} ${feature.troubleshooting[0].fix}` : null);
  if (conceptRaw && !isUnreviewedText(conceptRaw)) {
    const conceptFull = ensureStop(u.scrub(conceptRaw));
    const conceptRef = learnReferenceLink(learnSources, `${feature.name} ${conceptRaw}`, u);
    questions.push({
      prompt: `Which point of interest applies when configuring **${name}**?`,
      correct: conciseSentence(conceptFull, 160),
      distractors: [
        `${name} ignores tenant licensing and environment roles.`,
        `Updates to ${name} never affect ${agent} behavior.`,
        `Every change to ${name} requires a brand-new tenant.`,
      ],
      explanation: `Keep this **${name}** detail in mind: ${conceptFull}${
        conceptRef ? ` Read more about this point of interest in ${conceptRef}.` : ""
      }`,
      learnRef: conceptRef,
    });
  }

  if (!questions.length) {
    return feature.learnTopic
      ? [
          "",
          "**Knowledge check: Lesson mini-quiz**",
          "",
          "*No quiz for this topic. It is new on Microsoft Learn and not in the reviewed catalog yet, so there is no verified content to ask about. Use the Check your work list instead.*",
        ]
      : [];
  }

  const lines = [
    "",
    "**Knowledge check: Lesson mini-quiz**",
    "",
    `*Test your understanding of ${name} (${questions.length} multiple-choice question${questions.length === 1 ? "" : "s"}).*`,
  ];

  questions.forEach((question, index) => {
    const number = index + 1;
    const { correctLetter, options } = placeCorrectOption(question.correct, question.distractors, stepSeed + index);
    lines.push(
      "",
      `**Question ${number}.** ${question.prompt}`,
      "",
      u.bullets(options),
      "",
      "<details>",
      `<summary>Knowledge check: Question ${number} answer and Microsoft Learn reference</summary>`,
      "",
      `**Correct answer: ${correctLetter}.** ${question.explanation}`,
      ...(question.learnRef ? ["", `**Microsoft Learn reference:** ${question.learnRef}`] : []),
      "",
      "</details>",
    );
  });

  return lines;
}

/** Sample data or a prompt to type, tailored to the lab's vertical, audience, and product deliverable. */
export function sampleInputBlock(feature, plan, index, u) {
  const profile = plan.profile;
  const questions = profile.sampleQuestions || [];
  const entities = (profile.entities || []).slice(0, 3);
  const terms = (profile.terms || []).slice(0, 4);
  const source = profile.knowledgeSources?.[index % Math.max(1, (profile.knowledgeSources || []).length)];
  const d = describeDeliverable(plan);
  const fence = (label, text) => ["", label, "", "```text", text, "```"];

  if (d.mode === DELIVERABLE_MODES.LEARN_PRODUCT) return [];

  if (d.mode === DELIVERABLE_MODES.M365_COPILOT_GOVERNANCE) {
    return fence(
      "**Sample rollout configuration note.** Record these pilot parameters in your admin change log as you complete this step:",
      [
        `Rollout plan: ${plain(profile.agentName)}`,
        `Pilot security group: ${plain(profile.audience)}`,
        `Protected content scope: ${plain(source || "approved SharePoint sites and Teams workspaces")}`,
        `Governance controls to verify: ${plain(terms.join(", ") || "licensing, DLP, audit")}`,
      ].join("\n"),
    );
  }

  if (d.mode === DELIVERABLE_MODES.POWER_PLATFORM_AI_BUILDER) {
    if (PPAI_PROMPT_IDS.has(feature.id)) {
      return fence(
        "**Sample AI Builder prompt.** Paste this into the prompt editor and bind the input variables for your scenario:",
        [
          `Analyze the following ${plain(profile.domain)} record: {{InputRecord}}`,
          `Extract ${plain(entities.join(", ") || "key identifiers and status")} using our standard terms (${plain(terms.join(", ") || "status, owner")}).`,
          "Return a concise summary and next action in structured JSON with fields summary, priority, and citedField.",
        ].join("\n"),
      );
    }
    return [
      "",
      `**Sample test input.** Run **${u.esc(profile.agentName)}** against ${u.lowerFirst(source || "a sample document or Dataverse row")} containing ${entities.join(", ") || "representative fields"}, and verify how it handles: "${questions[index % Math.max(1, questions.length)] || "a standard business request"}"`,
    ];
  }

  if (d.mode === DELIVERABLE_MODES.POWER_PLATFORM_AI_GOVERNANCE) {
    return fence(
      "**Sample governance record.** Capture these environment and credit settings for your AI Builder rollout:",
      [
        `Solution scope: ${plain(profile.agentName)}`,
        `Target makers and business owners: ${plain(profile.audience)}`,
        `Monitored entities and terms: ${plain([...entities, ...terms].slice(0, 4).join(", "))}`,
      ].join("\n"),
    );
  }

  if (d.mode === DELIVERABLE_MODES.SHAREPOINT_CONTENT_AI) {
    return [
      "",
      `**Sample library content.** Upload 3–5 non-production files from ${u.lowerFirst(source || "a sample SharePoint document library")} and map extracted columns for ${entities.join(", ") || "document type, owner, and status"}.`,
    ];
  }

  if (d.mode === DELIVERABLE_MODES.SHAREPOINT_GOVERNANCE) {
    return fence(
      "**Sample SharePoint governance scope.** Use these site criteria when configuring your report or policy:",
      [
        `Governance plan: ${plain(profile.agentName)}`,
        `Target libraries: ${plain(source || "departmental SharePoint sites")}`,
        `Sensitivity and review terms: ${plain(terms.join(", ") || "access review, oversharing, lifecycle")}`,
      ].join("\n"),
    );
  }

  if (d.mode === DELIVERABLE_MODES.SHAREPOINT_AGENT) {
    if (feature.id === "spai-create-custom-sharepoint-agent" || feature.id === "spai-customize-agent-sources-and-prompts") {
      return fence(
        "**Sample SharePoint agent configuration.** Use these grounded instructions and starter prompts for your site library:",
        [
          `Agent name: ${plain(profile.agentName)}`,
          `Purpose: Answer questions for ${plain(profile.audience)} using only approved files in this SharePoint site.`,
          `Starter prompt: "${plain(questions[0] || "Summarize the latest policy in this library.")}"`,
        ].join("\n"),
      );
    }
    return questions.length
      ? ["", `**Sample prompt.** Test **${u.esc(profile.agentName)}** in SharePoint or Teams with: "${questions[index % questions.length]}"`]
      : [];
  }

  if (d.mode === DELIVERABLE_MODES.FOUNDRY_MODELS_PLATFORM) {
    if (FDY_PLAYGROUND_IDS.has(feature.id)) {
      return fence(
        "**Sample evaluation prompt.** Test your deployed model in the Microsoft Foundry playground or evaluation dataset with:",
        [
          `System message: You assist ${plain(profile.audience)} with ${plain(profile.domain)}. Ground responses strictly in supplied context and use consistent terms (${plain(terms.join(", "))}).`,
          `User prompt: "${plain(questions[index % Math.max(1, questions.length)] || "Summarize the key operational status and cite the source record.")}"`,
        ].join("\n"),
      );
    }
    return fence(
      "**Sample Foundry project metadata.** Keep naming and tags consistent across your hub, project, and connections:",
      [
        `Workload: ${plain(profile.agentName)}`,
        `Stakeholder team: ${plain(profile.audience)}`,
        `Data asset scope: ${plain(source || "indexed operational documents")}`,
      ].join("\n"),
    );
  }

  if (d.mode === DELIVERABLE_MODES.FOUNDRY_AGENT) {
    if (feature.id === "fdy-agent-service-basics" || feature.id === "fdy-prompt-flow-and-Orchestration") {
      return fence(
        "**Sample Foundry agent instructions.** Paste this into the system instructions field for your Foundry agent:",
        [
          `You are ${plain(profile.agentName)} for ${plain(profile.audience)}.`,
          `Assist with ${plain(profile.domain)} using connected tools and grounded indexes.`,
          `Keep domain terminology consistent: ${plain(terms.join(", "))}.`,
          "Cite retrieved documents and decline out-of-scope requests clearly.",
        ].join("\n"),
      );
    }
    return questions.length
      ? ["", `**Sample prompt.** Test **${u.esc(profile.agentName)}** in the Foundry agent playground with: "${questions[index % questions.length]}"`]
      : [];
  }

  if (d.mode === DELIVERABLE_MODES.DECLARATIVE_AGENT_GOVERNANCE) {
    return fence(
      "**Sample declarative agent review criteria.** Check each item before approving or publishing in the Microsoft 365 admin center:",
      [
        `Package under review: ${plain(profile.agentName)}`,
        `Intended user group: ${plain(profile.audience)}`,
        `Scoped knowledge sources: ${plain(source || "approved SharePoint sites and connectors")}`,
      ].join("\n"),
    );
  }

  if (d.mode === DELIVERABLE_MODES.DECLARATIVE_AGENT) {
    if (DCA_CREATE_IDS.has(feature.id)) {
      return fence(
        "**Sample input.** Paste and adapt these declarative agent instructions in Agent Builder:",
        [
          `You are ${plain(profile.agentName)}, a declarative agent in Microsoft 365 Copilot for ${plain(profile.audience)}.`,
          `Help with ${plain(profile.domain)}, such as: "${plain(questions[0] || "common team questions")}"`,
          `Use these terms consistently: ${plain(terms.join(", "))}.`,
          "Answer only from scoped SharePoint, Teams, or connector sources and cite every reference.",
        ].join("\n"),
      );
    }
    if (feature.category === "knowledge" || /knowledge/.test(feature.id)) {
      return source
        ? ["", `**Sample data.** Scope **${u.esc(profile.agentName)}** to ${u.lowerFirst(source)}, then test in Microsoft 365 Copilot with: "${questions[0] || ""}"`]
        : [];
    }
    return questions.length
      ? ["", `**Sample prompt.** Try asking **${u.esc(profile.agentName)}** in Microsoft 365 Copilot: "${questions[index % questions.length]}"`]
      : [];
  }

  if (CREATE_IDS.has(feature.id)) {
    return fence(
      "**Sample input.** When Copilot Studio asks you to describe the agent, you can paste this and adjust the wording:",
      `I want ${profile.outcome}, for ${plain(profile.audience)}.`,
    );
  }
  if (INSTRUCTION_IDS.has(feature.id)) {
    return fence(
      "**Sample input.** A starting point for the instructions; edit it to match your content:",
      [
        `You are ${plain(profile.agentName)}, an assistant for ${plain(profile.audience)}.`,
        `Help with ${profile.domain}, for example: "${questions[0] || "common questions"}"`,
        `Use these terms consistently: ${(profile.terms || []).join(", ")}.`,
        "If a question is outside this scope, say so and suggest who can help.",
        "Cite the knowledge source you used whenever one applies.",
      ].join("\n"),
    );
  }
  if (feature.category === "knowledge" || /knowledge/.test(feature.id)) {
    return source
      ? ["", `**Sample data.** Use content like this for ${u.esc(profile.agentName)}: ${u.lowerFirst(source)}. Then ask: "${questions[0] || ""}"`]
      : [];
  }
  if (TEST_IDS.has(feature.id) && questions.length) {
    return fence("**Sample test prompts.** Use these to exercise the agent:", questions.join("\n"));
  }
  if (questions.length) {
    return ["", `**Sample prompt.** Try asking ${u.esc(profile.agentName)}: "${questions[index % questions.length]}"`];
  }
  return [];
}

/** Rendered to a short, accurate glossary: one line per module, from vetted text. */
export function glossarySection(plan, u) {
  const rows = plan.features.map((f) => `**${u.esc(u.scrub(f.name))}:** ${u.scrub(firstSentence(f.whyItMatters || f.summary))}`);
  return ["## Glossary", "", "The terms this lab introduces, in one line each.", "", u.bullets(rows)].join("\n");
}

/** Cleanup that follows from the modules actually in the lab; nothing is deleted for the learner. */
export function cleanupSection(plan, u) {
  const has = (id) => plan.features.some((f) => f.id === id);
  const d = describeDeliverable(plan);
  const ids = plan.products?.length ? plan.products : ["copilot-studio"];
  const powerPlatformProducts = ids.some((id) => ["copilot-studio", "power-platform-ai-hub", "m365-copilot-agent-builder"].includes(id));
  const inCategory = (...cats) => plan.features.some((f) => cats.includes(f.category));
  const items = [...d.cleanupLead(u.esc(plan.profile.agentName))];
  if (powerPlatformProducts && inCategory("tools", "automation", "integrations")) {
    items.push("Delete the connections and flows you created for testing, and revoke any test credentials you shared.");
  }
  if (has("authentication") || has("channel-web-sdk")) {
    items.push("Delete the Microsoft Entra app registration you created for the lab, or remove its test secret.");
  }
  if (has("onprem-data-gateway")) items.push("Uninstall the on-premises data gateway from the test machine if you installed it only for this lab.");
  if (has("vnet-private-connectivity")) items.push("Remove the virtual network and subnet delegation you created for the lab, if they are not used by anything else.");
  items.push("Keep the sample documents and test records if you plan to extend the lab; they contain no production data.");
  return ["## Cleanup", "", "Nothing in this lab needs to stay running. When you are finished:", "", u.bullets(items)].join("\n");
}

/** Licensing and permissions, tied to the modules that need them, with the catalog's own Learn page. */
export function licensingBlock(plan, u) {
  const ids = plan.products?.length ? plan.products : ["copilot-studio"];
  const billing = getFeature("usage-credits")?.docUrls?.[0];
  const items = [];
  if (ids.includes("copilot-studio")) {
    items.push(
      `**License.** You need a Copilot Studio license or trial in your tenant before you start. ${
        billing ? `Check the current options in [Copilot Studio billing and licensing](${billing}).` : "Check the current options on Microsoft Learn."
      }`,
    );
  }
  for (const id of ids.filter((pid) => pid !== "copilot-studio")) {
    const product = getProduct(id);
    if (product) items.push(`**License (${product.shortName}).** ${product.licenseNote}`);
  }
  items.push(
    `**Role.** You need permission to ${ids.includes("copilot-studio") ? "create agents in the environment you use, for example the Environment Maker role" : "do the work in your tenant or subscription, as listed in the prerequisites"}. Modules that need more are called out in the list above.`,
  );
  if (plan.features.some((f) => f.availability === "preview")) {
    items.push("**Preview features.** Some modules cover preview capabilities. They might be unavailable in your tenant or region, and they can change before general availability.");
  }
  return ["", "**Licensing and permissions**", "", u.bullets(items)];
}

/** Microsoft Learn pages already cited in the lab, gathered for further reading. */
export function furtherLearningBlock(plan, groundingByFeature, u = {}) {
  const scrub = u?.scrub || ((s) => String(s ?? ""));
  const esc = u?.esc || ((s) => String(s ?? ""));
  const bullets = u?.bullets || ((items) => items.map((item) => `- ${item}`).join("\n"));
  const seenPages = new Set();
  const seenTitles = new Set();
  const rows = [];
  for (const feature of plan?.features || []) {
    const candidates = dedupeLearnSources(
      [
        ...(groundingByFeature?.get(feature.id)?.sources || []),
        ...((feature.docUrls || []).map((url) => ({ title: url, url }))),
      ],
      { scrub },
    );
    const chosen = candidates.find((candidate) => {
      const pageKey = canonicalLearnPageKey(candidate.url);
      const label = u?.label ? u.label(candidate) : formatCitationLabel(candidate, scrub);
      const titleKey = normalizeCitationTitleKey(label);
      return pageKey && titleKey && !seenPages.has(pageKey) && !seenTitles.has(titleKey);
    });
    if (!chosen) continue;
    const label = u?.label ? u.label(chosen) : formatCitationLabel(chosen, scrub);
    seenPages.add(canonicalLearnPageKey(chosen.url));
    seenTitles.add(normalizeCitationTitleKey(label));
    rows.push(`**${esc(scrub(feature.name || feature.id || "Reference"))}:** [${label}](${chosen.url})`);
  }
  return rows.length ? ["**Further reading on Microsoft Learn**", "", bullets(rows), ""] : [];
}
