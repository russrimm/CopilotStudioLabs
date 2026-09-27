import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { cleanCatalogReport } from "./catalog-fixture.mjs";

const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CLEAN_SCREENSHOTS = {
  staleThresholdDays: 180,
  summary: { labsNeedingRecapture: 0, missingImages: 0, staleImages: 0 },
  verifyShots: { available: true, critical: 0, warning: 0 },
  labs: [],
};
const CLEAN_SMOKE = { summary: { urls: 0, reachable: 0, unreachable: 0 }, urls: [] };

function accuracyWith(thirdPartyLinks, thirdPartyCounts, extra = {}) {
  return {
    summary: {
      labs: 1,
      brokenLinks: 0,
      unreachableLinks: 0,
      mcpDriftWarnings: 0,
      mcpUnavailable: false,
      references: {
        firstParty: { checked: 12, broken: 0, unreachable: 0 },
        thirdParty: { checked: 4, broken: 0, unreachable: 0, unverifiable: 0, skipped: 0, ...thirdPartyCounts },
      },
      ...extra,
    },
    labs: [
      {
        name: "18-account-orchestration-agent",
        brokenLinks: [],
        unreachableLinks: [],
        thirdPartyLinks: { broken: [], unreachable: [], unverifiable: [], skipped: [], ...thirdPartyLinks },
        mcp: { note: null },
      },
    ],
  };
}

function buildIssue(t, accuracy) {
  const outDir = mkdtempSync(join(tmpdir(), "lab-accuracy-references-"));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  writeFileSync(join(outDir, "accuracy.json"), JSON.stringify(accuracy));
  writeFileSync(join(outDir, "screenshots.json"), JSON.stringify(CLEAN_SCREENSHOTS));
  writeFileSync(join(outDir, "smoke.json"), JSON.stringify(CLEAN_SMOKE));
  writeFileSync(join(outDir, "catalog.json"), JSON.stringify(cleanCatalogReport()));

  const { GITHUB_OUTPUT: _output, ...parentEnv } = process.env;
  const output = execFileSync(process.execPath, [join(toolRoot, "build-issue.mjs")], {
    encoding: "utf8",
    env: { ...parentEnv, LAB_ACCURACY_OUT_DIR: outDir },
  });
  return { output, body: readFileSync(join(outDir, "issue.md"), "utf8") };
}

test("the issue reports Learn and third-party counts separately", (t) => {
  const { output, body } = buildIssue(t, accuracyWith({}, {}));
  assert.match(body, /### 🔗 Reference links/);
  assert.match(body, /Microsoft Learn \(first-party\): \*\*12\*\* checked · broken \*\*0\*\* · unreachable \*\*0\*\*/);
  assert.match(body, /Third-party: \*\*4\*\* checked · broken \*\*0\*\* · unreachable \*\*0\*\* · unverifiable \*\*0\*\* · skipped by policy \*\*0\*\*/);
  assert.match(output, /needs_action=false/);
});

test("a broken third-party link is listed with its lab and status, and needs action", (t) => {
  const { output, body } = buildIssue(
    t,
    accuracyWith(
      { broken: [{ url: "https://microsoft.github.io/enhanced-task-completion/", status: 404, host: "microsoft.github.io", party: "third" }] },
      { broken: 1 },
    ),
  );
  assert.match(output, /needs_action=true/);
  assert.match(body, /<details open><summary>Broken third-party links — fix or replace in the lab<\/summary>/);
  assert.match(body, /`18-account-orchestration-agent` → https:\/\/microsoft\.github\.io\/enhanced-task-completion\/ \(HTTP 404\)/);
  assert.match(body, /Do not add the host to `tools\/lab-accuracy\/link-policy\.json`/);
});

test("an unreachable third-party link needs action too", (t) => {
  const { output, body } = buildIssue(
    t,
    accuracyWith({ unreachable: [{ url: "https://slow.example.org/", status: 0, error: "timeout" }] }, { unreachable: 1 }),
  );
  assert.match(output, /needs_action=true/);
  assert.match(body, /Third-party links that could not be reached/);
  assert.match(body, /https:\/\/slow\.example\.org\/ \(timeout\)/);
});

test("bot-blocked and policy-skipped links are listed but do not open the issue", (t) => {
  const { output, body } = buildIssue(
    t,
    accuracyWith(
      {
        unverifiable: [{ url: "https://www.npmjs.com/package/adaptivecards", status: 403 }],
        skipped: [{ url: "https://copilotstudio.microsoft.com/", host: "copilotstudio.microsoft.com", reason: "Sign-in portal." }],
      },
      { unverifiable: 1, skipped: 1 },
    ),
  );
  assert.match(output, /needs_action=false/);
  assert.match(body, /Third-party links a site refused to check \(HTTP 401\/403\/429\)/);
  assert.match(body, /npmjs\.com\/package\/adaptivecards \(HTTP 403\)/);
  assert.match(body, /`copilotstudio\.microsoft\.com` \(`18-account-orchestration-agent`\): Sign-in portal\./);
});

test("an accuracy report without the reference split fails closed", (t) => {
  const accuracy = accuracyWith({}, {});
  delete accuracy.summary.references;
  const { output, body } = buildIssue(t, accuracy);
  assert.match(output, /needs_action=true/);
  assert.match(body, /no valid first-\/third-party reference-link data/);
});
