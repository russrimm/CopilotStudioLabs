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
import { TOPIC_BASE_MINUTES, subtopicMinutes, topicMinutes } from "./subtopics.js";

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

export const DEFAULT_MINUTES = TOPIC_BASE_MINUTES;

const THIRD_PARTY_TITLE_RE =
  /\b(servicenow|service-now|salesforce|sap(?:\s+(?:erp|odata|hana|s\/4hana|bw))?|snowflake|jira|atlassian|confluence|epic\s+on\s+fhir|fhirlink|shopify|workday|zendesk|hubspot|netsuite|docusign|adobe\s+sign|pagerduty|splunk|coupa|ariba)\b|\b(box|dropbox|slack|asana|trello)\s+connector\b/i;
const THIRD_PARTY_URL_RE =
  /\/connectors\/(service-now|salesforce|saperp|sapodata|snowflake\w*|jira|fhirlink|shopify\w*|zendesk|workday|hubspot|docusign|box|dropbox|slack|asana|trello|confluence|netsuite)\b|\/microsoft-365\/copilot\/connectors\/(service-now|servicenow|salesforce|jira|confluence|zendesk|box|dropbox|slack|workday|hubspot|snowflake|sap)(?:[-/]|$)/i;

/** True when a discovered Microsoft Learn topic targets a non-Microsoft 3rd-party connector or SaaS/ERP/CRM data source. */
export function isThirdPartyConnectorTopic(topic) {
  if (!topic) return false;
  if (topic.thirdPartyConnector === true) return true;
  const title = cleanText(topic.title, MAX_TITLE);
  if (THIRD_PARTY_TITLE_RE.test(title)) return true;
  const urls = [
    ...(Array.isArray(topic.urls) ? topic.urls : []),
    ...(Array.isArray(topic.subtopics) ? topic.subtopics.map((sub) => sub?.url) : []),
  ].filter((u) => typeof u === "string");
  return urls.some((u) => THIRD_PARTY_URL_RE.test(u));
}

/** The one step a sub-topic shows when no procedure could be read from its article. */
export function subtopicPlaceholderStep(title) {
  const name = cleanText(title, MAX_TITLE) || "this sub-topic";
  return (
    `[Unverified] Open the Microsoft Learn article **${name}** (linked in this sub-topic) and follow its procedure. ` +
    "No reviewed steps exist for it yet, and none could be read from the article during this build."
  );
}

/** What step derivation needs to read one sub-topic's own article as if it were a small topic. */
export function subtopicToFeature(sub) {
  const title = cleanText(sub.title, MAX_TITLE) || sub.id;
  return {
    id: sub.id,
    name: title,
    summary: cleanText(sub.summary, MAX_SUMMARY) || `${title}: see the linked Microsoft Learn article.`,
    steps: [subtopicPlaceholderStep(title)],
    learnTopic: { url: sub.url, urls: [sub.url] },
    docUrls: [sub.url],
  };
}

/**
 * The feature a discovered topic becomes. `learnTopic` marks it for the composer and generator.
 *
 * Every sub-topic is part of the feature unless it is named in `excludedSubtopics`. An excluded sub-topic is
 * absent from the feature's pages, queries, concepts, estimate, and `learnTopic.subtopics`; it is listed only in
 * `learnTopic.subtopicChoices` (as not included) so the lab can say what was left out.
 */
export function topicToFeature(topic, { excludedSubtopics = null } = {}) {
  const excluded = excludedSubtopics instanceof Set ? excludedSubtopics : new Set(excludedSubtopics || []);
  const title = cleanText(topic.title, MAX_TITLE) || "Microsoft Learn topic";
  const summary = cleanText(topic.summary, MAX_SUMMARY) || `${title}: see the linked Microsoft Learn article.`;
  const url = topic.urls[0];
  const productLabel = topic.productName || "Microsoft Copilot Studio";
  const everySubtopic = (topic.subtopics || []).filter((sub) => sub && typeof sub.url === "string");
  const eachMinutes = subtopicMinutes(everySubtopic.length);
  const subtopics = everySubtopic
    .filter((sub) => !excluded.has(sub.id))
    .map((sub) => ({
      id: sub.id,
      title: cleanText(sub.title, MAX_TITLE) || sub.id,
      url: sub.url,
      ...(sub.summary ? { summary: cleanText(sub.summary, MAX_SUMMARY) } : {}),
      ...(sub.level ? { level: sub.level } : {}),
      ...(sub.availability ? { availability: sub.availability } : {}),
      minutes: eachMinutes,
    }));
  const left = everySubtopic.filter((sub) => excluded.has(sub.id));
  const leftUrls = new Set(left.map((sub) => sub.url));
  const urls = topic.urls.filter((pageUrl, position) => position === 0 || !leftUrls.has(pageUrl));
  const companionConcepts = subtopics
    .filter((sub) => sub.summary && sub.summary !== summary)
    .slice(0, 2)
    .map((sub) => `[Unverified] Companion Microsoft Learn article (${sub.title}): ${sub.summary}`);
  const learnQueries = [
    ...new Set([
      `${productLabel} ${title}`,
      ...subtopics.slice(0, 2).map((sub) => `${productLabel} ${sub.title}`),
    ]),
  ];
  // A topic whose level cannot be resolved keeps `level: null`, so it never passes a level filter by accident.
  const { level, basis } = resolveTopicLevel(topic);
  return {
    id: topic.id,
    name: title,
    category: CATEGORY_BY_CONCEPT[topic.conceptId] || "advanced",
    level,
    levelBasis: basis,
    minutes: topicMinutes(everySubtopic.length, subtopics.length),
    core: false,
    thirdPartyConnector: isThirdPartyConnectorTopic(topic),
    // Only a topic of another product names its product; harness tags exist only for a product that has harnesses.
    ...(topic.product && topic.product !== "copilot-studio" ? { product: topic.product } : { harness: [...topic.harnesses] }),
    availability: topic.availability || undefined,
    summary,
    whyItMatters:
      "This topic was found on Microsoft Learn and is not yet part of this repository's reviewed catalog. " +
      "What follows comes from the Learn article and has not been checked against the product by hand, " +
      "so confirm each detail against the linked article.",
    concepts: [
      `Microsoft Learn describes this topic as: ${summary}`,
      ...companionConcepts,
      "[Unverified] This topic has no curated concepts yet; read the linked article before you start.",
    ],
    steps: [
      `[Unverified] Open the Microsoft Learn article **${title}** (linked under Sources) and follow its procedure. ` +
        "No reviewed steps exist for this topic yet, and none could be read from the article during this build.",
    ],
    validation: [
      "[Unverified] You completed the procedure in the linked Microsoft Learn article and the result matches what the article describes.",
    ],
    learnQueries,
    docUrls: urls,
    prereqs: [],
    relatedLabs: [],
    concept: topic.conceptId,
    learnTopic: {
      url,
      urls: [...urls],
      ...(subtopics.length ? { subtopics } : {}),
      // Every sub-topic the topic has, in Learn order, with whether this lab includes it (`subtopics` lists only the included ones).
      ...(everySubtopic.length
        ? {
            subtopicChoices: everySubtopic.map((sub) => ({
              id: sub.id,
              title: cleanText(sub.title, MAX_TITLE) || sub.id,
              url: sub.url,
              minutes: eachMinutes,
              included: !excluded.has(sub.id),
            })),
          }
        : {}),
      status: topic.status,
      lastSeen: topic.lastSeen,
    },
  };
}
