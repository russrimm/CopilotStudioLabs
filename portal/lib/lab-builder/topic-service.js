/**
 * The portal's topic service: the Microsoft Learn discovery run wired to the
 * real catalog, the real Learn MCP server, and the environment's settings.
 *
 * Tests build their own service with `createTopicService`; this module is the
 * one place that touches the network by default.
 */

import { connect, LEARN_MCP_ENDPOINT } from "./learn-mcp.js";
import { getCatalog } from "./catalog.js";
import { getConcepts } from "./concepts.js";
import { discoverSnapshot, DEFAULT_LIMITS } from "./topic-discovery.js";
import { createTopicService, topicConfig } from "./topic-store.js";

function envInt(name, fallback) {
  const parsed = Number.parseInt(String(process.env[name] ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Run discovery against the live Learn MCP server and the shipped catalog. */
export async function discoverFromLearn({ previous = null, signal, onProgress, endpoint = LEARN_MCP_ENDPOINT } = {}) {
  const session = await connect({ endpoint, timeoutMs: envInt("LAB_BUILDER_TOPICS_CALL_TIMEOUT_MS", 20000), signal });
  const catalog = getCatalog();
  const snapshot = await discoverSnapshot({
    session,
    catalog: { features: catalog.features, concepts: getConcepts(), version: catalog.version },
    previous,
    signal,
    onProgress,
    limits: {
      maxCalls: envInt("LAB_BUILDER_TOPICS_MAX_CALLS", DEFAULT_LIMITS.maxCalls),
      maxTopicPages: envInt("LAB_BUILDER_TOPICS_MAX_PAGES", DEFAULT_LIMITS.maxTopicPages),
      deadlineMs: envInt("LAB_BUILDER_TOPICS_DEADLINE_MS", DEFAULT_LIMITS.deadlineMs),
    },
  });
  snapshot.endpoint = endpoint;
  return snapshot;
}

let service = null;

/** The process-wide service, created on first use. */
export function getTopicService() {
  if (!service) service = createTopicService({ discover: discoverFromLearn, config: topicConfig() });
  return service;
}

/** Replace the process-wide service. Tests use this to inject a mocked Learn server. */
export function setTopicService(next) {
  service?.stop?.();
  service = next;
}
