import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkCoverage } from "../check-catalog.mjs";

function fixture({ notApplicable = {}, knownGaps = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coverage-"));
  const catalog = {
    harnesses: [{ id: "standard" }, { id: "customer-conversation" }],
    features: [{ id: "a", harness: ["standard"] }],
  };
  const concepts = {
    knownGaps,
    concepts: [{ id: "c", name: "C", summary: "S", order: 1, features: ["a"], notApplicable }],
  };
  fs.writeFileSync(path.join(dir, "features.json"), JSON.stringify(catalog));
  fs.writeFileSync(path.join(dir, "concepts.json"), JSON.stringify(concepts));
  return path.join(dir, "features.json");
}

test("a concept with no variant and no n/a reason fails the catalog check", () => {
  assert.match(checkCoverage(fixture()).join("\n"), /coverage c: .*"customer-conversation"/);
  assert.deepEqual(checkCoverage(fixture({ notApplicable: { "customer-conversation": "Not offered." } })), []);
  assert.deepEqual(checkCoverage(fixture({ knownGaps: ["c:customer-conversation"] })), []);
});
