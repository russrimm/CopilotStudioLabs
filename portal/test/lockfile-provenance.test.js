/**
 * Regression tests for npm registry provenance.
 *
 * A machine-level ~/.npmrc pointing at an internal Microsoft package proxy
 * silently rewrites every `resolved` URL in a lockfile during install. That
 * corrupts provenance for this public repository and breaks `npm ci` for
 * outside contributors, who cannot reach the internal feed. Each install root
 * therefore declares the public registry explicitly, and these tests fail if a
 * contaminated lockfile is ever committed.
 *
 * Run with:  npm --prefix portal test
 * (uses Node's built-in --test runner; no new dependency).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const INTERNAL_FEED =
  /ms-feed-\d+\.pkgs\.visualstudio\.com|packagefeedproxy\.microsoft\.io|pkgs\.dev\.azure\.com/i;

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next"]);

function findLockfiles(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) findLockfiles(join(dir, entry.name), found);
    } else if (entry.name === "package-lock.json") {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

const lockfiles = findLockfiles(repoRoot);

test("the repository still has lockfiles to check", () => {
  // Guards against the walker silently finding nothing and vacuously passing.
  assert.ok(
    lockfiles.length > 0,
    "no package-lock.json found; the discovery walk is broken",
  );
});

for (const lockfile of lockfiles) {
  const rel = relative(repoRoot, lockfile).replace(/\\/g, "/");

  test(`${rel} resolves only to the public npm registry`, () => {
    const contents = readFileSync(lockfile, "utf8");
    const matches = contents.match(new RegExp(INTERNAL_FEED, "gi")) ?? [];
    assert.deepEqual(
      [...new Set(matches)],
      [],
      `${rel} contains internal package-feed URLs. It was generated on a machine ` +
        `whose npm registry points at an internal proxy. Regenerate it with ` +
        `\`npm install --registry=https://registry.npmjs.org\`.`,
    );
  });

  test(`${rel} has a sibling .npmrc pinning the public registry`, () => {
    const npmrc = join(dirname(lockfile), ".npmrc");
    assert.ok(
      existsSync(npmrc),
      `${rel} has no sibling .npmrc. npm reads project config from the working ` +
        `directory and does not walk up the tree, so every install root needs ` +
        `its own declaration.`,
    );
    assert.match(
      readFileSync(npmrc, "utf8"),
      /^\s*registry\s*=\s*https:\/\/registry\.npmjs\.org\/?\s*$/m,
      `${dirname(rel)}/.npmrc does not pin registry.npmjs.org.`,
    );
  });
}
