#!/usr/bin/env node
// Reports which feature tour screenshots are captured and which are still pending, per
// product and per feature, and prints the exact command to run next.
//
//   npm run status                        summary per product
//   node status.mjs --product=<id>        per-feature detail for one product
//   node status.mjs --detail              per-feature detail for every product
//   node status.mjs --json                machine-readable output
//   node status.mjs --strict              exit 1 while anything is pending

import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectScreenshot } from "../feature-tour/lib/screenshots.mjs";
import { FEATURE_ASSETS_DIR, listFeatureManifests, repoRoot as defaultRoot } from "./manifests.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Count captured and pending shots per product and feature. */
export function buildStatus({ manifestDir = here, repoRoot = defaultRoot } = {}) {
  const assetsDir = path.resolve(repoRoot, FEATURE_ASSETS_DIR);
  const products = [];
  for (const entry of listFeatureManifests(manifestDir)) {
    const shots = Array.isArray(entry.manifest?.shots) ? entry.manifest.shots : [];
    const features = new Map();
    const envVars = new Set();
    let manual = 0;
    for (const shot of shots) {
      const info = inspectScreenshot(assetsDir, shot.filename);
      const ready = info.status === "ready";
      if (!features.has(shot.feature)) features.set(shot.feature, { feature: shot.feature, name: shot.featureName, total: 0, captured: 0, pending: [] });
      const f = features.get(shot.feature);
      f.total += 1;
      if (ready) f.captured += 1;
      else {
        f.pending.push(shot.filename);
        if (shot.manual) manual += 1;
        if (shot.urlEnv && !shot.url) envVars.add(shot.urlEnv);
      }
    }
    const list = [...features.values()];
    const captured = list.reduce((n, f) => n + f.captured, 0);
    const total = list.reduce((n, f) => n + f.total, 0);
    products.push({
      product: entry.product,
      file: entry.file,
      error: entry.error,
      total,
      captured,
      pending: total - captured,
      manualPending: manual,
      requiredEnv: [...envVars].sort(),
      features: list,
    });
  }
  const total = products.reduce((n, p) => n + p.total, 0);
  const captured = products.reduce((n, p) => n + p.captured, 0);
  const next = products.find((p) => p.pending > 0);
  return {
    total,
    captured,
    pending: total - captured,
    products,
    nextCommand: next ? `cd tools/screenshot-capture && node capture.js --product=${next.product} --missing` : null,
    nextProduct: next?.product ?? null,
  };
}

function printReport(status, { detail, only }) {
  const rows = status.products.filter((p) => !only || p.product === only);
  console.log(`Feature tour screenshots: ${status.captured} of ${status.total} captured, ${status.pending} pending.\n`);
  const width = Math.max(...rows.map((p) => p.product.length), 7);
  console.log(`${"Product".padEnd(width)}  Captured  Pending  Total`);
  for (const p of rows) {
    console.log(`${p.product.padEnd(width)}  ${String(p.captured).padStart(8)}  ${String(p.pending).padStart(7)}  ${String(p.total).padStart(5)}`);
  }
  if (detail || only) {
    for (const p of rows) {
      console.log(`\n${p.product}: ${p.captured} of ${p.total} captured`);
      for (const f of p.features) {
        const mark = f.captured === f.total ? "done   " : f.captured === 0 ? "pending" : "partial";
        console.log(`  [${mark}] ${f.feature}: ${f.captured}/${f.total}`);
      }
    }
  }
  const next = rows.find((p) => p.pending > 0);
  if (!next) {
    console.log("\nNothing pending. Run npm run feature-tour:build to refresh the site.");
    return;
  }
  console.log("\nNext command (opens a browser; sign in when asked):");
  console.log(`  cd tools/screenshot-capture && node capture.js --product=${next.product} --missing`);
  if (next.requiredEnv.length) console.log(`  Set these first (tenant-specific addresses): ${next.requiredEnv.join(", ")}`);
  if (next.manualPending) console.log(`  ${next.manualPending} shot(s) are manual: capture them with an OS screenshot tool and save them at the printed path.`);
  console.log(`Preview first without a browser: cd tools/screenshot-capture && node capture.js --product=${next.product} --dry-run`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const productArg = args.find((a) => a.startsWith("--product="));
  const rootArg = args.find((a) => a.startsWith("--root="));
  const only = productArg ? productArg.slice("--product=".length) : null;
  // --root=<dir> reads another repo layout (tests use it); the default is this repository.
  const root = rootArg ? path.resolve(rootArg.slice("--root=".length)) : defaultRoot;
  const status = buildStatus({ repoRoot: root, manifestDir: path.join(root, "tools", "screenshot-capture") });
  if (only && !status.products.some((p) => p.product === only)) {
    console.error(`Unknown product "${only}". Products: ${status.products.map((p) => p.product).join(", ")}.`);
    process.exit(2);
  }
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  else printReport(status, { detail: args.includes("--detail"), only });
  process.exit(args.includes("--strict") && status.pending > 0 ? 1 : 0);
}
