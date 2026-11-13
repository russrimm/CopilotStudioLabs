/**
 * Turn a topic discovered on Microsoft Learn into a feature the planner and
 * generator can build a lab from.
 *
 * A discovered topic has no curated steps, so everything a lab says about it
 * is either read from the Learn article at build time (the same path catalog
 * features take) or marked as unverified. Nothing here is invented: the text
 * comes from the sanitized Learn title and summary, and the fixed sentences
 * say plainly that the topic is new and unreviewed.
 */

import { cleanText, MAX_TITLE, MAX_SUMMARY } from "./topic-sanitize.js";
import { resolveTopicLevel } from "./levels.js";

const CATEGORY_BY_CONCEPT = {
  "choose-harness": "foundations",
  "create-agent": "foundations",
  instructions: "foundations",
  "model-orchestration": "foundations",
  knowledge: "knowledge",
  tools: "tools",
  skills: "tools",
  mcp: "tools",
  subagents: "orchestration",
  sdk: "advanced",
  memory: "advanced",
  "files-code": "advanced",
  "conversation-design": "conversation",
  hooks: "advanced",
  triggers: "automation",
  workflows: "automation",
  integrations: "integrations",
  testing: "analytics",
  monitor: "analytics",
  publish: "channels",
  security: "governance",
  governance: "governance",
  billing: "governance",
};

export const DEFAULT_MINUTES = 20;

/** The feature a discovered topic becomes. `learnTopic` marks it for the composer and generator. */
export function topicToFeature(topic) {
  const title = cleanText(topic.title, MAX_TITLE) || "Microsoft Learn topic";
  const summary = cleanText(topic.summary, MAX_SUMMARY) || `${title}: see the linked Microsoft Learn article.`;
  const url = topic.urls[0];
  // A topic whose level cannot be resolved keeps `level: null`, so it never passes a level filter by accident.
  const { level, basis } = resolveTopicLevel(topic);
  return {
    id: topic.id,
    name: title,
    category: CATEGORY_BY_CONCEPT[topic.conceptId] || "advanced",
    level,
    levelBasis: basis,
    minutes: DEFAULT_MINUTES,
    core: false,
    harness: [...topic.harnesses],
    availability: topic.availability || undefined,
    summary,
    whyItMatters:
      "This topic was found on Microsoft Learn and is not yet part of this repository's reviewed catalog. " +
      "What follows comes from the Learn article and has not been checked against the product by hand, " +
      "so confirm each detail against the linked article.",
    concepts: [
      `Microsoft Learn describes this topic as: ${summary}`,
      "[Unverified] This topic has no curated concepts yet; read the linked article before you start.",
    ],
    steps: [
      `[Unverified] Open the Microsoft Learn article **${title}** (linked under Sources) and follow its procedure. ` +
        "No reviewed steps exist for this topic yet, and none could be read from the article during this build.",
    ],
    validation: [
      "[Unverified] You completed the procedure in the linked Microsoft Learn article and the result matches what the article describes.",
    ],
    learnQueries: [`Microsoft Copilot Studio ${title}`],
    docUrls: [...topic.urls],
    prereqs: [],
    relatedLabs: [],
    concept: topic.conceptId,
    learnTopic: { url, status: topic.status, lastSeen: topic.lastSeen },
  };
}
