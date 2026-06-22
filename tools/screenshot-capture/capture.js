// Interactive screenshot capture for Copilot Studio Labs.
// Reads shots.json, walks the user through each shot in a real browser,
// and writes PNGs straight into the lab's assets/ folder with the exact
// filenames already wired into the markdown.
//
// Usage:
//   npm run capture                  # capture all shots that aren't on disk yet
//   npm run list                     # list shots and which already exist
//   node capture.js --help           # show all flags
//   node capture.js --dry-run        # validate and print resolved shot setup
//   node capture.js --all            # re-capture even shots that already exist
//   node capture.js --only=3,7       # capture just shots #3 and #7
//   node capture.js --range=5-10     # capture shots #5 through #10
//   node capture.js --from=5         # capture from shot #5 onward
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
import { existsSync, readFileSync, mkdirSync, statSync } from "node:fs";
import readline from "node:readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..", "..");

// --manifest=<path> lets callers point at any lab's shots.json (paths are
// resolved relative to the current working directory, then the repo root).
const manifestArg = process.argv
  .slice(2)
  .find((a) => a.startsWith("--manifest="));
const manifestOverride = manifestArg ? manifestArg.slice("--manifest=".length) : null;
const manifestPath = manifestOverride
  ? (existsSync(resolve(process.cwd(), manifestOverride))
      ? resolve(process.cwd(), manifestOverride)
      : resolve(repoRoot, manifestOverride))
  : join(__dirname, "shots.json");
if (!existsSync(manifestPath)) {
  console.error(`Error: shots manifest not found at ${manifestPath}`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
const assetsDir = resolve(repoRoot, manifest.assetsDir);
const userDataDir = join(__dirname, ".auth");

const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
const DEFAULT_ZOOM = 1.0;
const MIN_PNG_BYTES = 5 * 1024;

// TODO: Future highlight support is reserved via optional shot.highlight = { selector, label }.
// The tool should eventually draw a callout arrow on the saved PNG, but does not today.

// ---------- arg parsing ----------
const args = process.argv.slice(2);
const flag = (name) => args.some((a) => a === name);
const value = (name) => {
  const a = args.find((x) => x.startsWith(`${name}=`));
  return a ? a.slice(name.length + 1) : null;
};

const wantHelp = flag("--help") || flag("-h");
const wantList = flag("--list");
const wantDryRun = flag("--dry-run");
const wantAll = flag("--all");
const wantMissing = flag("--missing");
const onlyRaw = value("--only");
const rangeRaw = value("--range");
const fromRaw = value("--from");

function printHelp() {
  console.log(`\nCopilot Studio Labs screenshot capture\n\nUsage:\n  node capture.js [flags]\n\nSelection flags (mutually exclusive):\n  --all             Capture every shot, even if the file exists.\n  --only=<csv>      Capture only specific shot IDs, e.g. --only=2,4,7.\n  --range=A-B       Capture an inclusive shot ID range.\n  --from=<id>       Capture from the matching shot ID through the end.\n  --missing         Capture only shots missing on disk (also the default).\n\nOther flags:\n  --manifest=<path> Use a specific shots.json (e.g. a lab's own manifest).\n  --list            List shots and whether each file exists.\n  --dry-run         Print resolved shot setup without launching Playwright.\n  --help, -h        Show this help.\n\nKeystrokes during capture:\n  SPACE             Snap the current shot and advance.\n  r                 Retry/re-snap the current shot.\n  n                 Skip this shot without saving.\n  q                 Quit gracefully and persist auth.\n  ?                 Re-print the current shot instructions.\n\nPrecedence: --only beats --range beats --from beats --missing default.\nConflicting selection flags are rejected so intent stays explicit.\n`);
}

function failArg(message) {
  console.error(`Error: ${message}`);
  console.error("Run `node capture.js --help` for usage.");
  process.exit(1);
}

const selectionFlags = [
  ["--all", wantAll],
  ["--only", Boolean(onlyRaw)],
  ["--range", Boolean(rangeRaw)],
  ["--from", Boolean(fromRaw)],
  ["--missing", wantMissing],
].filter(([, present]) => present);
if (selectionFlags.length > 1) {
  failArg(`conflicting selection flags: ${selectionFlags.map(([name]) => name).join(", ")}`);
}

const onlyIds = onlyRaw
  ? new Set(onlyRaw.split(",").map((s) => Number(s.trim())))
  : null;
if (onlyIds && [...onlyIds].some((n) => !Number.isFinite(n))) {
  failArg("--only must be a comma-separated list of numeric shot IDs.");
}

let rangeStart = null;
let rangeEnd = null;
if (rangeRaw) {
  const [a, b, extra] = rangeRaw.split("-").map((s) => Number(s.trim()));
  if (extra !== undefined || !Number.isFinite(a) || !Number.isFinite(b) || a > b) {
    failArg("--range must be in A-B numeric order, e.g. --range=5-10.");
  }
  rangeStart = a;
  rangeEnd = b;
}

const fromId = fromRaw === null ? null : Number(fromRaw.trim());
if (fromRaw !== null && !Number.isFinite(fromId)) {
  failArg("--from must be a numeric shot ID.");
}

// ---------- helpers ----------
function shotPath(filename) {
  return join(assetsDir, filename);
}

function shotExists(filename) {
  return existsSync(shotPath(filename));
}

function resolvedViewport(shot) {
  return {
    width: Number(shot.viewport?.width ?? DEFAULT_VIEWPORT.width),
    height: Number(shot.viewport?.height ?? DEFAULT_VIEWPORT.height),
  };
}

function resolvedZoom(shot) {
  return Number(shot.zoom ?? DEFAULT_ZOOM);
}

function isAbsoluteUrl(value) {
  return /^https?:\/\//i.test(value ?? "");
}

function shotNavSection(shot) {
  return typeof shot.section === "string" && shot.section.trim() ? shot.section.trim().replace(/^\/+/, "") : null;
}

function resolveBotSectionUrl(currentUrl, section) {
  const navSection = section?.trim().replace(/^\/+/, "");
  if (!navSection) return null;
  const match = currentUrl.match(/^(https:\/\/(?:copilotstudio\.microsoft\.com|[^/]+\.copilotstudio\.[^/]+)\/environments\/[^/]+\/bots\/[^/]+\/)(?:.*)?$/i);
  return match ? `${match[1]}${navSection}` : null;
}

function urlMatchesTarget(currentUrl, targetUrl) {
  if (currentUrl === targetUrl || currentUrl.startsWith(`${targetUrl}?`) || currentUrl.startsWith(`${targetUrl}#`)) return true;
  const prefix = targetUrl.endsWith("/") ? targetUrl : `${targetUrl}/`;
  return currentUrl.startsWith(prefix);
}

function resolvedUrl(shot, currentUrl = null) {
  if (shot.url && isAbsoluteUrl(shot.url)) return shot.url;
  const navSection = shotNavSection(shot);
  if (navSection) {
    const resolved = currentUrl ? resolveBotSectionUrl(currentUrl, navSection) : null;
    return resolved ?? `(current bot → ${navSection})`;
  }
  return shot.url ?? "(stay on current page)";
}

function validateShotShape(shot) {
  if (!Number.isFinite(Number(shot.id))) throw new Error(`Shot has invalid id: ${shot.id}`);
  if (!shot.filename || typeof shot.filename !== "string") throw new Error(`Shot #${shot.id} is missing filename.`);
  if (!shot.section || typeof shot.section !== "string") throw new Error(`Shot #${shot.id} is missing section.`);
  if (!Array.isArray(shot.instructions)) throw new Error(`Shot #${shot.id} is missing instructions[].`);
  const viewport = resolvedViewport(shot);
  if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0) {
    throw new Error(`Shot #${shot.id} has invalid viewport.`);
  }
  if (!Number.isFinite(resolvedZoom(shot)) || resolvedZoom(shot) <= 0) {
    throw new Error(`Shot #${shot.id} has invalid zoom.`);
  }
  if (shot.highlight && (typeof shot.highlight.selector !== "string" || typeof shot.highlight.label !== "string")) {
    throw new Error(`Shot #${shot.id} highlight must be { selector, label } strings.`);
  }
}

for (const shot of manifest.shots) validateShotShape(shot);

function selectShots() {
  if (wantAll) return [...manifest.shots];
  if (onlyIds) return manifest.shots.filter((s) => onlyIds.has(Number(s.id)));
  if (rangeStart !== null) return manifest.shots.filter((s) => s.id >= rangeStart && s.id <= rangeEnd);
  if (fromId !== null) {
    const index = manifest.shots.findIndex((s) => Number(s.id) === fromId);
    if (index === -1) failArg(`--from shot ID ${fromId} was not found in shots.json.`);
    return manifest.shots.slice(index);
  }
  return manifest.shots.filter((s) => !shotExists(s.filename));
}

function listAll() {
  console.log(`\nShots manifest (${manifest.shots.length} total)\n`);
  for (const s of manifest.shots) {
    const have = shotExists(s.filename) ? "✓" : " ";
    console.log(`  [${have}] #${String(s.id).padStart(2, "0")}  ${s.filename}`);
    console.log(`        ${s.labSection ?? s.section}`);
    console.log(`        target: ${resolvedUrl(s)}`);
  }
  console.log(`\nAssets dir: ${assetsDir}`);
  console.log(`✓ = already on disk, blank = missing\n`);
}

function printDryRun(shots) {
  console.log(`\nDry run: ${shots.length} selected shot(s); Playwright was not launched.`);
  console.log(`Assets dir: ${assetsDir}\n`);
  for (const shot of shots) {
    const viewport = resolvedViewport(shot);
    console.log(`#${String(shot.id).padStart(2, "0")} ${shot.filename}`);
    console.log(`  exists: ${shotExists(shot.filename) ? "yes" : "no"}`);
    console.log(`  url: ${resolvedUrl(shot)}`);
    console.log(`  viewport: ${viewport.width}x${viewport.height}`);
    console.log(`  zoom: ${resolvedZoom(shot)}`);
    console.log(`  lab section: ${shot.labSection ?? "(not set)"}`);
    console.log(`  section: ${shot.section}`);
    console.log("  instructions:");
    for (const line of shot.instructions) console.log(`    - ${line}`);
    if (shot.highlight) console.log(`  highlight: ${shot.highlight.selector} (${shot.highlight.label})`);
  }
  console.log("");
}

function printInstructions(shot) {
  console.log("─".repeat(72));
  console.log(`Shot #${shot.id}  →  ${shot.filename}`);
  console.log(`Section: ${shot.labSection ?? shot.section}`);
  console.log(`Target: ${resolvedUrl(shot)}`);
  const viewport = resolvedViewport(shot);
  console.log(`Viewport: ${viewport.width}x${viewport.height}; zoom: ${resolvedZoom(shot)}`);
  console.log("");
  console.log("Setup steps:");
  for (const line of shot.instructions) console.log(`  • ${line}`);
  console.log("");
}

function statusLine(shot, index, total) {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(`[shot ${index + 1}/${total}] ${shot.filename} — SPACE=snap | r=retry | n=skip | q=quit | ?=help`);
}

async function preShotCountdown(seconds = 2) {
  for (let remaining = seconds; remaining > 0; remaining -= 1) {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(`Ready in ${remaining}...`);
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 1000));
  }
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
}

function readKey(shot, index, total) {
  return new Promise((resolveKey) => {
    const stdin = process.stdin;
    const onData = (buffer) => {
      const key = buffer.toString("utf8");
      if (key === "\u0003") {
        cleanup();
        resolveKey("ctrl-c");
        return;
      }
      const normalized = key === " " ? "space" : key.toLowerCase();
      if (["space", "r", "n", "q", "?"].includes(normalized)) {
        cleanup();
        resolveKey(normalized);
      }
    };
    const cleanup = () => {
      stdin.off("data", onData);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    statusLine(shot, index, total);
    stdin.resume();
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.on("data", onData);
  });
}

function readVerifyChoice() {
  return new Promise((resolveChoice) => {
    const stdin = process.stdin;
    process.stdout.write("Verification failed. Press [r] to redo, anything else to keep: ");
    const onData = (buffer) => {
      cleanup();
      resolveChoice(buffer.toString("utf8").trim().toLowerCase() === "r");
    };
    const cleanup = () => {
      stdin.off("data", onData);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    stdin.resume();
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.on("data", onData);
  });
}

async function activePage(context) {
  const pages = context.pages();
  const target = pages[pages.length - 1] ?? (await context.newPage());
  try {
    await target.bringToFront();
  } catch {
    /* noop */
  }
  return target;
}

async function applyShotSetup(page, shot) {
  await page.setViewportSize(DEFAULT_VIEWPORT).catch(() => {});
  await page.evaluate((zoom) => {
    document.body.style.zoom = String(zoom);
  }, DEFAULT_ZOOM).catch(() => {});

  const currentUrl = page.url();
  if (shot.url && isAbsoluteUrl(shot.url)) {
    if (!urlMatchesTarget(currentUrl, shot.url)) {
      console.log(`Navigating to ${shot.url}`);
      await page.goto(shot.url).catch((err) => console.warn(`Navigation warning: ${err.message}`));
    }
  } else {
    const navSection = shotNavSection(shot);
    const targetUrl = navSection ? resolveBotSectionUrl(currentUrl, navSection) : null;
    if (targetUrl && !urlMatchesTarget(currentUrl, targetUrl)) {
      console.log(`Navigating to ${targetUrl}`);
      await page.goto(targetUrl).catch((err) => console.warn(`Navigation warning: ${err.message}`));
    } else if (navSection && !targetUrl) {
      console.log(`💡 Open any agent first, then this shot can auto-jump to the ${navSection} page.`);
    } else if (shot.url && !urlMatchesTarget(currentUrl, shot.url)) {
      console.log(`Navigating to ${shot.url}`);
      await page.goto(shot.url).catch((err) => console.warn(`Navigation warning: ${err.message}`));
    }
  }

  const viewport = resolvedViewport(shot);
  await page.setViewportSize(viewport).catch(() => {});
  await page.evaluate((zoom) => {
    document.body.style.zoom = String(zoom);
  }, resolvedZoom(shot)).catch(() => {});
}

async function clickIfVisible(page, locator, label, dismissed) {
  try {
    const count = Math.min(await locator.count({ timeout: 250 }).catch(() => 0), 3);
    for (let i = 0; i < count; i += 1) {
      const item = locator.nth(i);
      if (await item.isVisible({ timeout: 250 }).catch(() => false)) {
        await item.click({ timeout: 500 }).catch(() => {});
        dismissed.push(label);
        await page.waitForTimeout(100).catch(() => {});
        return;
      }
    }
  } catch {
    /* best effort */
  }
}

async function autoDismiss(page) {
  const dismissed = [];
  await clickIfVisible(page, page.getByRole("button", { name: /^accept all$/i }), "cookie banner: Accept all", dismissed);
  await clickIfVisible(page, page.getByRole("button", { name: /^reject all$/i }), "cookie banner: Reject all", dismissed);
  await clickIfVisible(page, page.locator("#wcpConsentBannerCtrl button[aria-label*='close' i], #wcpConsentBannerCtrl .close"), "cookie banner close", dismissed);

  for (const label of ["Got it", "Dismiss", "Skip tour"]) {
    await clickIfVisible(page, page.getByRole("button", { name: new RegExp(`^${label}$`, "i") }), `tip: ${label}`, dismissed);
  }
  await clickIfVisible(
    page,
    page.locator("[role='dialog'] button[aria-label*='close' i], [role='tooltip'] button[aria-label*='close' i], [class*='popover' i] button[aria-label*='close' i], [class*='coach' i] button[aria-label*='close' i]"),
    "popover close",
    dismissed
  );
  await clickIfVisible(
    page,
    page.locator("[role='status'] button[aria-label*='close' i], [role='alert'] button[aria-label*='close' i], [class*='toast' i] button[aria-label*='close' i], [class*='notification' i] button[aria-label*='close' i]"),
    "toast close",
    dismissed
  );

  for (const label of dismissed) console.log(`Dismissed ${label}.`);
}

function verifyPng(out) {
  try {
    const bytes = readFileSync(out);
    const isPng = bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const size = statSync(out).size;
    return { ok: isPng && size > MIN_PNG_BYTES, isPng, size };
  } catch {
    return { ok: false, isPng: false, size: 0 };
  }
}

function remainingMissing() {
  return manifest.shots.filter((s) => !shotExists(s.filename));
}

function printSummary(summary) {
  console.log("─".repeat(72));
  console.log("Session summary");
  console.log(`  snapped: ${summary.snapped}`);
  console.log(`  skipped: ${summary.skipped}`);
  console.log(`  retried: ${summary.retried}`);
  console.log(`  failed verify: ${summary.failedVerify}`);
  const missing = remainingMissing();
  console.log(`  remaining missing: ${missing.length}`);
  for (const shot of missing) console.log(`    #${shot.id} ${shot.filename}`);
  console.log("");
}

// ---------- main ----------
if (wantHelp) {
  printHelp();
  process.exit(0);
}

if (wantList) {
  listAll();
  process.exit(0);
}

mkdirSync(assetsDir, { recursive: true });

const todo = selectShots();
if (wantDryRun) {
  printDryRun(todo);
  process.exit(0);
}

if (todo.length === 0) {
  console.log("\nNothing to capture. Use --all to re-capture existing shots, or --list to see status.\n");
  process.exit(0);
}

mkdirSync(userDataDir, { recursive: true });

console.log(`\nWill capture ${todo.length} shot(s) into:`);
console.log(`  ${assetsDir}\n`);

let context;
const summary = { snapped: 0, skipped: 0, retried: 0, failedVerify: 0 };

async function shutdown(exitCode = 0) {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  printSummary(summary);
  if (context) {
    console.log("Persisting auth and closing Chromium...");
    await context.close().catch(() => {});
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => {
  shutdown(130);
});

context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  viewport: DEFAULT_VIEWPORT,
  args: ["--start-maximized"],
});

const page = context.pages()[0] ?? (await context.newPage());
if (!page.url() || page.url() === "about:blank") {
  await page.goto(manifest.startUrl).catch(() => {});
}

console.log("A Chromium window is now open. If this is your first run, sign in to Copilot Studio.");
console.log("Your session is cached locally in tools/screenshot-capture/.auth so you won't need to sign in again.\n");

for (let index = 0; index < todo.length; index += 1) {
  const shot = todo[index];
  let retrying = true;

  while (retrying) {
    retrying = false;
    const target = await activePage(context);
    await applyShotSetup(target, shot);
    await autoDismiss(target);
    printInstructions(shot);
    await preShotCountdown();

    const action = await readKey(shot, index, todo.length);
    if (action === "ctrl-c" || action === "q") {
      console.log(action === "q" ? "Quitting at user request." : "Interrupted.");
      await shutdown(action === "q" ? 0 : 130);
    }
    if (action === "?") {
      retrying = true;
      continue;
    }
    if (action === "n") {
      summary.skipped += 1;
      console.log(`Skipped #${shot.id}.\n`);
      continue;
    }
    if (action === "r") {
      summary.retried += 1;
      retrying = true;
      continue;
    }

    const out = shotPath(shot.filename);
    try {
      await target.screenshot({ path: out, fullPage: false });
      summary.snapped += 1;
      console.log(`Saved → ${out}`);
      const verified = verifyPng(out);
      if (!verified.ok) {
        summary.failedVerify += 1;
        console.warn(`WARNING: ${shot.filename} failed verification (png=${verified.isPng}, size=${verified.size} bytes).`);
        if (await readVerifyChoice()) {
          summary.retried += 1;
          retrying = true;
        }
      } else {
        console.log(`Verified PNG (${verified.size} bytes).\n`);
      }
    } catch (err) {
      summary.failedVerify += 1;
      console.error(`Failed to capture #${shot.id}: ${err.message}\n`);
      if (await readVerifyChoice()) {
        summary.retried += 1;
        retrying = true;
      }
    }
  }
}

await shutdown(0);
