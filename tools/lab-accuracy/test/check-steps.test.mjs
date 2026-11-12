import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { EXIT, UsageError, exitCodeFor, main, parseArgs, resolveLabNames } from "../check-steps.mjs";

const LEARN = "https://learn.microsoft.com/en-us/microsoft-copilot-studio";

const LAB = {
  labId: "35-dlp-governance-policies",
  title: "Lab 35: DLP",
  products: ["Microsoft Copilot Studio"],
  markdown: "# Lab 35\n\n## Step-by-Step\n\n### Step 1 — Open\n\n1. Select **Power Virtual Agents** in the **Tools** pane.\n",
};

function mockLearn({ fail = false, results = [] } = {}) {
  return {
    endpoint: "mock://learn",
    async search() {
      return fail ? { ok: false, code: "error", error: "unavailable" } : { ok: true, results };
    },
    async fetchPage(url) {
      return fail ? { ok: false, code: "error", error: "unavailable" } : { ok: true, url, markdown: results[0]?.excerpt || "text" };
    },
    status: () => ({ calls: 0 }),
  };
}

async function run(argv, learn) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "step-cli-"));
  const logs = [];
  const errors = [];
  try {
    const code = await main({
      argv: [...argv, `--out=${out}`],
      learn,
      loadLabs: () => [LAB],
      log: (line) => logs.push(line),
      errorLog: (line) => errors.push(line),
    });
    const jsonPath = path.join(out, "step-accuracy.json");
    const report = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, "utf8")) : null;
    return { code, logs, errors, report, md: fs.existsSync(path.join(out, "step-accuracy.md")) };
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    delete process.env.LAB_ACCURACY_OUT_DIR;
  }
}

test("parseArgs accepts the documented flags and rejects unknown ones", () => {
  const opts = parseArgs(["--lab=35", "--lab=06", "--fail-on=unverified", "--markdown", "--no-cache", "--max-calls=10"]);
  assert.deepEqual(opts.labs, ["35", "06"]);
  assert.equal(opts.failOn, "unverified");
  assert.equal(opts.maxCalls, 10);
  assert.throws(() => parseArgs(["--bogus"]), UsageError);
  assert.throws(() => parseArgs(["--fail-on=maybe"]), UsageError);
  assert.throws(() => parseArgs(["--max-calls=-1"]), UsageError);
});

test("resolveLabNames matches a numeric prefix and rejects unknown labs", () => {
  const available = ["06-energy-weather-agent", "35-dlp-governance-policies"];
  assert.deepEqual(resolveLabNames(["35"], available), ["35-dlp-governance-policies"]);
  assert.deepEqual(resolveLabNames(["6"], available), ["06-energy-weather-agent"]);
  assert.throws(() => resolveLabNames(["99"], available), UsageError);
  assert.deepEqual(resolveLabNames([], available), available);
});

test("exit code: stale findings fail, outages exit 2 unless allowed, unverified only on request", () => {
  const report = (claimStatus) => ({ summary: { claimStatus } });
  const clean = { verified: 3, unverified: 0, stale: 0, unable: 0 };
  assert.equal(exitCodeFor(report(clean)), EXIT.OK);
  assert.equal(exitCodeFor(report({ ...clean, stale: 1 })), EXIT.FINDINGS);
  assert.equal(exitCodeFor(report({ ...clean, stale: 1 }), { failOn: "none" }), EXIT.OK);
  assert.equal(exitCodeFor(report({ ...clean, unverified: 2 })), EXIT.OK);
  assert.equal(exitCodeFor(report({ ...clean, unverified: 2 }), { failOn: "unverified" }), EXIT.FINDINGS);
  assert.equal(exitCodeFor(report({ ...clean, unable: 2 })), EXIT.UNAVAILABLE);
  assert.equal(exitCodeFor(report({ ...clean, unable: 2 }), { allowUnavailable: true }), EXIT.OK);
});

test("a stale claim is reported with its Learn citation and exits 1", async () => {
  const learn = mockLearn({
    results: [{ title: "Rename", url: `${LEARN}/rename`, excerpt: "Power Virtual Agents is now called Copilot Studio." }],
  });
  const { code, logs, report } = await run(["--markdown"], learn);
  assert.equal(code, EXIT.FINDINGS);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.labs[0].steps[0].status, "stale");
  assert.ok(logs.some((line) => line.includes("likely stale") || line.includes("⚠")));
  assert.ok(logs.some((line) => line.includes(`${LEARN}/rename`)));
});

test("an unavailable Learn MCP exits 2 and never reports a pass; --allow-unavailable tolerates it", async () => {
  const failing = await run([], mockLearn({ fail: true }));
  assert.equal(failing.code, EXIT.UNAVAILABLE);
  assert.equal(failing.report.summary.claimStatus.verified, 0);
  assert.ok(failing.report.summary.claimStatus.unable > 0);
  const tolerated = await run(["--allow-unavailable"], mockLearn({ fail: true }));
  assert.equal(tolerated.code, EXIT.OK);
  assert.ok(tolerated.report.summary.claimStatus.unable > 0);
});

test("usage errors exit 3 without running anything", async () => {
  const errors = [];
  const code = await main({ argv: ["--nope"], learn: mockLearn(), errorLog: (m) => errors.push(m) });
  assert.equal(code, EXIT.ERROR);
  assert.match(errors[0], /Unknown argument/);
});
