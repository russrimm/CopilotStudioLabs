// Interactive screenshot capture for Copilot Studio Labs.
// Reads shots.json, walks the user through each shot in a real browser,
// and writes PNGs straight into the lab's assets/ folder with the exact
// filenames already wired into the markdown.
//
// Usage:
//   npm run capture                  # capture all shots that aren't on disk yet
//   npm run list                     # list shots and which already exist
//   node capture.js --all            # re-capture even shots that already exist
//   node capture.js --only=3,7       # capture just shots #3 and #7
//   node capture.js --range=5-10     # capture shots #5 through #10
//
// Note: npm 11 strips unknown flags from `npm run ... -- --flag`, so for
// anything other than the two predefined scripts use `node capture.js ...`.
//
// The first run opens a real Chromium window so you can sign in interactively.
// Login state is persisted in tools/screenshot-capture/.auth so subsequent
// runs reuse the session.

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import readline from "node:readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..", "..");

const manifestPath = join(__dirname, "shots.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
const assetsDir = resolve(repoRoot, manifest.assetsDir);
const userDataDir = join(__dirname, ".auth");

// ---------- arg parsing ----------
const args = process.argv.slice(2);
const flag = (name) => args.some((a) => a === name);
const value = (name) => {
  const a = args.find((x) => x.startsWith(`${name}=`));
  return a ? a.slice(name.length + 1) : null;
};

const wantList = flag("--list");
const wantAll = flag("--all");
const onlyRaw = value("--only");
const rangeRaw = value("--range");

const onlyIds = onlyRaw
  ? new Set(onlyRaw.split(",").map((s) => Number(s.trim())))
  : null;
let rangeStart = null;
let rangeEnd = null;
if (rangeRaw) {
  const [a, b] = rangeRaw.split("-").map((s) => Number(s.trim()));
  rangeStart = a;
  rangeEnd = b;
}

// ---------- helpers ----------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) =>
  new Promise((res) => rl.question(q, (a) => res(a.trim().toLowerCase())));

function shotPath(filename) {
  return join(assetsDir, filename);
}

function shotExists(filename) {
  return existsSync(shotPath(filename));
}

function selectShots() {
  return manifest.shots.filter((s) => {
    if (onlyIds && !onlyIds.has(s.id)) return false;
    if (rangeStart !== null && (s.id < rangeStart || s.id > rangeEnd)) return false;
    if (!wantAll && shotExists(s.filename)) return false;
    return true;
  });
}

function listAll() {
  console.log(`\nShots manifest (${manifest.shots.length} total)\n`);
  for (const s of manifest.shots) {
    const have = shotExists(s.filename) ? "✓" : " ";
    console.log(`  [${have}] #${String(s.id).padStart(2, "0")}  ${s.filename}`);
    console.log(`        ${s.section}`);
  }
  console.log(`\nAssets dir: ${assetsDir}`);
  console.log(`✓ = already on disk, blank = missing\n`);
}

// ---------- main ----------
if (wantList) {
  listAll();
  rl.close();
  process.exit(0);
}

mkdirSync(assetsDir, { recursive: true });
mkdirSync(userDataDir, { recursive: true });

const todo = selectShots();
if (todo.length === 0) {
  console.log("\nNothing to capture. Use --all to re-capture existing shots, or --list to see status.\n");
  rl.close();
  process.exit(0);
}

console.log(`\nWill capture ${todo.length} shot(s) into:`);
console.log(`  ${assetsDir}\n`);

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  viewport: null,
  args: ["--start-maximized"],
});

const page = context.pages()[0] ?? (await context.newPage());

// Only navigate on first run / when no page is open.
if (!page.url() || page.url() === "about:blank") {
  await page.goto(manifest.startUrl).catch(() => {});
}

console.log(
  "A Chromium window is now open. If this is your first run, sign in to Copilot Studio."
);
console.log(
  "After this run, your session is cached locally in tools/screenshot-capture/.auth so you won't need to sign in again.\n"
);

for (const shot of todo) {
  console.log("─".repeat(72));
  console.log(`Shot #${shot.id}  →  ${shot.filename}`);
  console.log(`Section: ${shot.section}`);
  console.log("");
  console.log("Setup steps:");
  for (const line of shot.instructions) {
    console.log(`  • ${line}`);
  }
  console.log("");

  const action = await ask(
    "Press [Enter] to capture, [s] to skip, [f] for fullscreen+capture, [q] to quit: "
  );

  if (action === "q") {
    console.log("Quitting at user request.");
    break;
  }
  if (action === "s") {
    console.log(`Skipped #${shot.id}.\n`);
    continue;
  }

  // Re-resolve the active page in case the user opened a new tab during setup.
  const pages = context.pages();
  const target = pages[pages.length - 1];

  // Try to make sure the target tab is brought to the front before snapping.
  try {
    await target.bringToFront();
  } catch {
    /* noop */
  }

  if (action === "f") {
    try {
      await target.evaluate(() => document.documentElement.requestFullscreen?.());
    } catch {
      /* noop */
    }
    // Tiny delay to let fullscreen settle.
    await target.waitForTimeout(400);
  }

  const out = shotPath(shot.filename);
  try {
    await target.screenshot({ path: out, fullPage: false });
    console.log(`Saved → ${out}\n`);
  } catch (err) {
    console.error(`Failed to capture #${shot.id}: ${err.message}\n`);
  }

  if (action === "f") {
    try {
      await target.evaluate(() => document.exitFullscreen?.());
    } catch {
      /* noop */
    }
  }
}

console.log("─".repeat(72));
console.log("Done. Browser will stay open so you can keep working.");
console.log("Close the Chromium window manually when finished, or rerun the script.");

rl.close();
// Don't auto-close the context — let the user close the browser themselves
// so any in-progress lab work isn't lost.
