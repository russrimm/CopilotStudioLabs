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

const CAUTION = /\b(?:can't|cannot|can not|must|requires?|required|only|unavailable|isn't|aren't|not available|don't|doesn't|won't|might|may not|limits?)\b/i;

const CREATE_IDS = new Set(["create-agent", "mc-create-agent", "cc-create-agent"]);
const INSTRUCTION_IDS = new Set(["agent-instructions", "mc-instructions", "cc-instructions"]);
const TEST_IDS = new Set(["test-agent", "multiturn-tests", "mc-preview-test", "cc-preview-test", "evaluations", "mc-evaluate", "cc-evaluate"]);

function firstSentence(text) {
  const match = String(text || "").trim().match(/^.*?[.!?](?=\s|$)/);
  return (match ? match[0] : String(text || "")).trim();
}

/** Caller-supplied text inside a code fence: it must not be able to close the fence or add markup. */
function plain(text) {
  return String(text ?? "").replace(/[`<>*_~|\[\]\\\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function trimStop(text) {
  return String(text || "").trim().replace(/[.!?]+$/, "");
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
export function troubleshootingBlock(feature, u) {
  const items = [];
  for (const entry of feature.troubleshooting || []) {
    if (entry?.symptom && entry?.fix) items.push(`**${u.scrub(entry.symptom)}** ${u.scrub(entry.fix)}`);
  }

  const cautions = (feature.concepts || []).filter((c) => CAUTION.test(c));
  for (const caution of cautions.slice(0, 2)) {
    items.push(`**Watch for this.** ${u.scrub(caution)}`);
  }

  const doc = feature.docUrls?.[0];
  items.push(
    `**A step does not match your screen.** Product screens change often. Compare with ${
      doc ? `[the ${u.scrub(feature.name)} documentation](${doc})` : "the Microsoft Learn page for this module"
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

function details(summary, answer) {
  return ["", "<details>", `<summary>${summary}</summary>`, "", answer, "", "</details>"];
}

/** Short self-check questions with expandable answers, from vetted catalog text. */
export function knowledgeCheckBlock(feature, plan, u) {
  const agent = u.esc(plan.profile.agentName);
  const name = u.scrub(feature.name);
  const lines = [];

  const why = firstSentence(feature.whyItMatters);
  lines.push(...details(`Knowledge check: why does ${name} matter for ${agent}?`, u.scrub(feature.whyItMatters || why)));

  if (feature.validation?.length) {
    lines.push(
      ...details(
        `Knowledge check: how will you know ${name} is working in your scenario?`,
        u.bullets(feature.validation.map(u.scrub)),
      ),
    );
  }

  const used = new Set((feature.concepts || []).filter((c) => CAUTION.test(c)).slice(0, 2));
  const spare = (feature.concepts || []).find((c) => !used.has(c));
  if (spare) lines.push(...details(`Knowledge check: what should you remember about ${name} before you click?`, u.scrub(spare)));

  return lines;
}

/** Sample data or a prompt to type, tailored to the lab's vertical and audience. */
export function sampleInputBlock(feature, plan, index, u) {
  const profile = plan.profile;
  const questions = profile.sampleQuestions || [];
  const fence = (label, text) => ["", label, "", "```text", text, "```"];

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
    const source = profile.knowledgeSources?.[index % profile.knowledgeSources.length];
    return source
      ? ["", `**Sample data.** Use content like this for ${u.esc(profile.agentName)}: ${u.lowerFirst(source)}. Then ask: "${questions[0] || ""}"`]
      : [];
  }
  if (TEST_IDS.has(feature.id) && questions.length) {
    return fence("**Sample test prompts.** Use these to exercise the agent:", questions.join("\n"));
  }
  if (questions.length) {
    return ["", `**Sample prompt.** Try asking ${u.esc(profile.agentName)}: "${questions[index]}"`];
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
  const inCategory = (...cats) => plan.features.some((f) => cats.includes(f.category));
  const items = [
    `If you built **${u.esc(plan.profile.agentName)}** only to learn, remove it from the **Agents** page when you no longer need it. Ask your administrator first if the environment is shared.`,
    "Stop sharing the agent with test users, and unpublish it if you published it for the lab.",
  ];
  if (inCategory("tools", "automation", "integrations")) {
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
export function furtherLearningBlock(plan, groundingByFeature, u) {
  const seen = new Set();
  const rows = [];
  for (const feature of plan.features) {
    const grounded = groundingByFeature?.get(feature.id)?.sources?.[0];
    const url = grounded?.url || feature.docUrls?.[0];
    if (!url || seen.has(url)) continue;
    seen.add(url);
    rows.push(`**${u.esc(u.scrub(feature.name))}:** [${u.label(grounded || { title: "", url })}](${url})`);
  }
  return rows.length ? ["**Further reading on Microsoft Learn**", "", u.bullets(rows), ""] : [];
}
