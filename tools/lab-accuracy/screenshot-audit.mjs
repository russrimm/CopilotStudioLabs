// Monthly screenshot integrity + staleness audit.
//
// Combines two signals per lab:
//   1. Integrity — delegates to tools/screenshot-capture/verify-shots.js --json
//      to detect missing files, bad signatures, placeholder-size PNGs, and
//      markdown/shots.json mismatches.
//   2. Staleness — uses `git log` to find each screenshot's last-changed date
//      and flags images older than the staleness threshold (default 180 days).
//
// Produces out/screenshots.json with a concrete re-capture plan (the exact
// command a maintainer runs) for every lab that needs attention. Screenshot
// capture of authenticated Copilot Studio UI is interactive by design, so this
// audit drives a human-in-the-loop re-capture rather than attempting unattended
// capture (which would produce inaccurate images).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadAllLabs, repoRoot, writeReport, relativeToRoot } from "./lib/labs.mjs";

const args = process.argv.slice(2);
const thresholdArg = args.find((a) => a.startsWith("--max-age-days="));
const STALE_DAYS = thresholdArg ? Number(thresholdArg.split("=")[1]) : 180;
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;

function gitLastModified(relPath) {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%cI", "--", relPath], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function runVerifyShots() {
  const script = path.join(repoRoot, "tools", "screenshot-capture", "verify-shots.js");
  if (!fs.existsSync(script)) return { ok: true, summary: {}, labs: {}, unavailable: true };
  try {
    const out = execFileSync("node", [script, "--json"], { cwd: repoRoot, encoding: "utf8" });
    return JSON.parse(out);
  } catch (error) {
    // verify-shots exits 1 when it finds critical issues but still prints JSON.
    if (error.stdout) {
      try {
        return JSON.parse(error.stdout);
      } catch {
        /* fall through */
      }
    }
    return { ok: false, summary: {}, labs: {}, error: error.message };
  }
}

function recaptureCommand(lab) {
  const manifest = lab.shots?.path;
  if (manifest) {
    return `cd tools/screenshot-capture && npm install && npx playwright install chromium && node capture.js --manifest=../../${manifest} --all`;
  }
  return `cd tools/screenshot-capture && node capture.js --help  # no shots.json for ${lab.name}; author one first`;
}

function main() {
  const labs = loadAllLabs();
  const verify = runVerifyShots();
  const now = Date.now();

  const report = {
    generatedAt: new Date().toISOString(),
    staleThresholdDays: STALE_DAYS,
    verifyShots: {
      available: !verify.unavailable,
      critical: verify.summary?.critical ?? 0,
      warning: verify.summary?.warning ?? 0,
    },
    summary: { labs: labs.length, labsNeedingRecapture: 0, missingImages: 0, staleImages: 0 },
    labs: [],
  };

  for (const lab of labs) {
    const verifyFindings = verify.labs?.[lab.name]?.findings ?? [];
    const critical = verifyFindings.filter((f) => f.severity === "critical");
    const warning = verifyFindings.filter((f) => f.severity === "warning");

    const stale = [];
    const missing = [];
    for (const imageRel of lab.images) {
      const abs = path.join(repoRoot, imageRel);
      if (!fs.existsSync(abs)) {
        missing.push(imageRel);
        continue;
      }
      const lastModified = gitLastModified(imageRel);
      if (lastModified) {
        const age = now - new Date(lastModified).getTime();
        if (age > STALE_MS) {
          stale.push({ path: imageRel, lastModified, ageDays: Math.round(age / 86400000) });
        }
      }
    }

    report.summary.missingImages += missing.length;
    report.summary.staleImages += stale.length;

    const needsRecapture = missing.length > 0 || stale.length > 0 || critical.length > 0;
    if (needsRecapture) report.summary.labsNeedingRecapture += 1;

    report.labs.push({
      name: lab.name,
      title: lab.title,
      hasManifest: Boolean(lab.shots?.path),
      imageCount: lab.images.length,
      missingImages: missing,
      staleImages: stale,
      criticalFindings: critical,
      warningFindings: warning,
      needsRecapture,
      recaptureCommand: needsRecapture ? recaptureCommand(lab) : null,
    });

    if (needsRecapture) {
      console.log(
        `• ${lab.name}: ${missing.length} missing, ${stale.length} stale, ${critical.length} critical`,
      );
    }
  }

  const target = writeReport("screenshots.json", report);
  console.log(`\nScreenshot audit written to ${relativeToRoot(target)}`);
  console.log(
    `Summary: ${report.summary.labsNeedingRecapture} lab(s) need re-capture ` +
      `(${report.summary.missingImages} missing, ${report.summary.staleImages} stale).`,
  );
}

main();
