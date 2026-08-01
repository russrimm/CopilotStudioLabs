import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("issue report lists unreachable links exactly once without broken links", (t) => {
  const outDir = mkdtempSync(join(tmpdir(), "lab-accuracy-report-"));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));

  writeFileSync(join(outDir, "accuracy.json"), JSON.stringify({
    summary: {
      labs: 1,
      brokenLinks: 0,
      unreachableLinks: 1,
      mcpDriftWarnings: 0,
      mcpUnavailable: false,
    },
    labs: [{
      name: "01-test",
      brokenLinks: [],
      unreachableLinks: [{ url: "https://learn.example.test/page", error: "timeout" }],
      mcp: { note: null },
    }],
  }));
  writeFileSync(join(outDir, "screenshots.json"), JSON.stringify({
    staleThresholdDays: 180,
    summary: { labsNeedingRecapture: 0, missingImages: 0, staleImages: 0 },
    verifyShots: { available: true, critical: 0, warning: 0 },
    labs: [],
  }));
  writeFileSync(join(outDir, "smoke.json"), JSON.stringify({
    summary: { urls: 0, reachable: 0, unreachable: 0 },
    urls: [],
  }));

  const output = execFileSync(process.execPath, [join(toolRoot, "build-issue.mjs")], {
    encoding: "utf8",
    env: { ...process.env, LAB_ACCURACY_OUT_DIR: outDir },
  });
  const body = readFileSync(join(outDir, "issue.md"), "utf8");

  assert.match(output, /needs_action=true/);
  assert.match(body, /Reference links that could not be checked/);
  assert.equal(body.match(/https:\/\/learn\.example\.test\/page/g)?.length, 1);
});
