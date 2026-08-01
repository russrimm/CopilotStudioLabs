import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeContent } from "../lib/mcp-client.mjs";
import { safePath, unexpectedDriftLabs } from "../check-accuracy.mjs";

test("normalizeContent unwraps the current Learn MCP results envelope", () => {
  const result = {
    content: [{
      type: "text",
      text: JSON.stringify({
        results: [{
          title: "Agent usage estimator",
          contentUrl: "https://learn.microsoft.com/microsoft-copilot-studio/agent-usage-estimator",
          content: "Official estimator guidance.",
        }],
      }),
    }],
  };

  assert.deepEqual(normalizeContent(result), [{
    title: "Agent usage estimator",
    url: "https://learn.microsoft.com/microsoft-copilot-studio/agent-usage-estimator",
    snippet: "Official estimator guidance.",
  }]);
});

test("normalizeContent keeps compatibility with array responses", () => {
  const result = {
    content: [{
      type: "text",
      text: JSON.stringify([{
        title: "Custom metrics",
        contentUrl: "https://learn.microsoft.com/microsoft-copilot-studio/analytics-custom-metrics",
        content: "Custom metrics guidance.",
      }]),
    }],
  };

  assert.equal(normalizeContent(result)[0].title, "Custom metrics");
});

test("safePath treats localized and canonical Learn URLs as the same page", () => {
  assert.equal(
    safePath("https://learn.microsoft.com/en-us/microsoft-copilot-studio/computer-use"),
    safePath("https://learn.microsoft.com/microsoft-copilot-studio/computer-use#overview"),
  );
});

test("drift baseline permits known warnings and rejects new lab drift", () => {
  const rankingWarning =
    "No exact cited Learn page appeared in the current top search results. The links still resolve; review search ranking and product relevance before changing documentation.";
  const report = {
    labs: [
      { name: "known-lab", mcp: { note: rankingWarning } },
      { name: "clean-lab", mcp: { note: null } },
      { name: "new-drift", mcp: { note: rankingWarning } },
      { name: "known-query-failure", mcp: { note: "MCP query failed: timed out" } },
    ],
  };

  assert.deepEqual(
    unexpectedDriftLabs(report, { knownLabWarnings: ["known-lab", "known-query-failure"] }),
    ["new-drift", "known-query-failure"],
  );
});
