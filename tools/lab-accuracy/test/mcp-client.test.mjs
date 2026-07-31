import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeContent } from "../lib/mcp-client.mjs";
import { safePath } from "../check-accuracy.mjs";

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
