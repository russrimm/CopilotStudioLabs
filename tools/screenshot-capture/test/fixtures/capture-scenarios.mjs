// End-to-end capture scenarios: a real portal server, a real lab built by the lab builder, the real Local
// Capture Companion, and a real browser that sees a pretend Copilot Studio (see fake-product-site.mjs).
// `repoDir` is the checkout to test, which is how a before and after comparison is made:
//   node test/fixtures/capture-repro.mjs --repo-dir=<checkout>
//
// Nothing leaves this computer: the browser is only allowed to reach the pretend hosts, and the portal listens
// on 127.0.0.1 with a temporary storage folder.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { FAKE_ENV_ID, FAKE_HOSTS, createFakeProductSite, withFakeProductSite } from "./fake-product-site.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const WORKTREE_ROOT = path.resolve(here, "..", "..", "..", "..");

/** The Copilot Studio lab used for every scenario: the same features as the lab in the real report. */
export const FIXTURE_FEATURES = ["create-agent", "agent-instructions", "knowledge-sharepoint", "generative-orchestration", "publish-agent"];

/**
 * What a correct screenshot of each fixture shot shows. `sections` are the agent or environment pages the
 * picture may come from; `needsState` shots also need something only a person sets up (a test conversation, a
 * dialog, a publish).
 */
export const GROUND_TRUTH = Object.freeze({
  "copilot-studio-home.png": { sections: ["home", "agents"] },
  "create-agent-describe.png": { sections: ["home"] },
  "agent-overview.png": { sections: ["overview"] },
  "agent-instructions.png": { sections: ["overview"] },
  "test-pane-in-scope.png": { sections: ["overview", "knowledge", "settings", "actions", "topics", "analytics"], needsState: "test conversation" },
  "generative-orchestration-setting.png": { sections: ["settings"] },
  "activity-map-plan.png": { sections: ["overview", "knowledge", "settings", "actions", "topics", "analytics"], needsState: "test conversation" },
  "knowledge-sharepoint-add.png": { sections: ["knowledge"], needsState: "dialog" },
  "knowledge-answer-citation.png": { sections: ["overview", "knowledge", "settings", "actions", "topics", "analytics"], needsState: "test conversation" },
  "publish-confirmation.png": { sections: ["overview", "knowledge", "settings", "actions", "topics", "analytics"], needsState: "publish" },
});

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Start the portal of a checkout on a free port with a temporary storage folder. Returns `{base, stop}`. */
export async function startPortal({ repoDir, storageRoot, env = {} }) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let stderr = "";
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(repoDir, "portal"),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      PORTAL_AUTH_DISABLED: "true",
      AZURE_KEYVAULT_URL: "",
      PORTAL_STORAGE_ROOT: storageRoot,
      FEATURE_TOUR_SCREENSHOTS_DIR: "",
      LAB_BUILDER_LINK_CHECK: "off",
      LAB_BUILDER_LLM: "off",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`The portal exited early (${child.exitCode}): ${stderr.slice(-600)}`);
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error("The portal did not start in time.");
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return { base, port, stop: () => child.kill() };
}

/** Build a small Copilot Studio lab offline (no Learn, no model) in `<storageRoot>/generated-labs`. */
export async function buildFixtureLab({ repoDir, storageRoot, features = FIXTURE_FEATURES, products = ["copilot-studio"], harness = "standard", sharepointSiteUrl = "", sharepointSiteName = "" }) {
  const generatedRoot = path.join(storageRoot, "generated-labs");
  fs.mkdirSync(generatedRoot, { recursive: true });
  const emptyLabs = fs.mkdtempSync(path.join(os.tmpdir(), "capture-empty-labs-"));
  const { generateLab } = await import(pathToFileURL(path.join(repoDir, "portal", "lib", "lab-builder", "generator.js")).href);
  const build = await generateLab(
    { products, features, harness, includeCore: false, ...(sharepointSiteUrl ? { sharepointSiteUrl } : {}), ...(sharepointSiteName ? { sharepointSiteName } : {}) },
    { outputRoot: generatedRoot, labsDir: emptyLabs, useLearnMcp: false, useLlm: false },
  );
  fs.rmSync(emptyLabs, { recursive: true, force: true });
  return { labId: build.labId, labDir: build.outputDir, generatedRoot };
}

/**
 * Say that every Copilot Studio slot of a generated lab is taken in one harness (the plan reads the lab's own shot list). The pretend site
 * shows one harness: its newer layout is the Microsoft Copilot harness and its classic layout is the Standard (Classic) harness, so a test that
 * keeps the features it needs from the other harness retags the lab to the harness the site shows, which is what a lab for that harness would do.
 */
export function retagLab(labDir, harness) {
  const file = path.join(labDir, "screenshots", "shots.json");
  const plan = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const shot of plan.shots) {
    shot.harness = harness;
    delete shot.harnessGap;
    delete shot.harnessGapNote;
  }
  fs.writeFileSync(file, JSON.stringify(plan, null, 2));
}

export async function call(base, method, route, json) {
  const res = await fetch(`${base}${route}`, { method, headers: json === undefined ? {} : { "Content-Type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json) });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

async function loadModule(toolDir, name) {
  return import(pathToFileURL(path.join(toolDir, name)).href);
}

/** The segment after the agent id (or the area, for an environment page) of a reported address. */
export function sectionOf(finalUrl) {
  const match = String(finalUrl || "").match(/\/environments\/[^/]+\/(?:bots\/[^/]+\/([^/?#]+)|([^/?#]+))/);
  return match ? match[1] || match[2] : null;
}

/** Judge a finished shot row against the ground truth. */
export function judge(row) {
  const truth = GROUND_TRUTH[row.filename];
  const section = sectionOf(row.finalUrl);
  const right = truth && section ? truth.sections.includes(section) : null;
  return { section, right };
}

/**
 * Start one scenario: a real portal with a temporary storage folder, a lab, the pretend product site, and a
 * companion folder. Several jobs can then be run in it, which is how a recipe recorded in one job is replayed in the next.
 * @param {object} options
 * @param {string} options.repoDir the checkout to test
 * @param {object} [options.site] options for the pretend product site (or `siteInstance`, an existing one, to keep its tenant)
 * @param {object} [options.lab] options for buildFixtureLab
 * @param {string} [options.channel] "msedge" to use the installed Edge
 * @param {string} [options.home] a companion folder to reuse (it is not deleted when the scenario closes)
 */
export async function startScenario({ repoDir, site: siteOptions = {}, siteInstance = null, lab: labOptions = {}, channel = undefined, home = null, signInWaitSec = 8 }) {
  const toolDir = path.join(repoDir, "tools", "screenshot-capture");
  const companion = await loadModule(toolDir, "companion.mjs");
  const labRunner = await loadModule(path.join(WORKTREE_ROOT, "tools", "screenshot-capture"), "lab-runner.mjs");
  const playwright = await labRunner.loadPlaywrightModule(WORKTREE_ROOT);
  if (!playwright?.chromium) throw new Error("Playwright is not installed.");

  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "capture-scenario-"));
  const ownHome = !home;
  const companionHome = home || fs.mkdtempSync(path.join(os.tmpdir(), "capture-home-"));
  const portal = await startPortal({ repoDir, storageRoot });
  const siteModel = siteInstance || createFakeProductSite(siteOptions);
  const wrapped = withFakeProductSite(playwright, siteModel, { forceChannel: channel });
  const lab = await buildFixtureLab({ repoDir, storageRoot, ...labOptions });
  const api = (m, r, j) => call(portal.base, m, r, j);
  const scenario = {
    repoDir,
    base: portal.base,
    lab,
    site: siteModel,
    home: companionHome,
    call: api,
    launches: wrapped.launches,
    /** Queue a job, hand it to a fresh companion, run it, and report what happened. */
    async runJob({ job: jobBody = {}, runOptions = {}, onUpload = null, onClient = null } = {}) {
      const lines = [];
      const started = Date.now();
      const queued = await api("POST", "/api/capture/jobs", { target: { type: "lab", labId: lab.labId }, scope: { mode: "all" }, ...jobBody });
      if (queued.status >= 400 || !queued.body?.job) throw new Error(`The job was not queued (${queued.status}): ${queued.text.slice(0, 300)}`);
      const code = (await api("POST", "/api/capture/pair")).body;
      const paired = await companion.createPortalClient({ portal: portal.base }).pair({ code: code.code, deviceName: "TEST-PC" });
      const real = companion.createPortalClient({ portal: portal.base, token: paired.token });
      let uploads = 0;
      const client = new Proxy(real, {
        get(target, prop) {
          if (prop === "upload") {
            return async (...args) => {
              const result = await target.upload(...args);
              uploads += 1;
              if (onUpload) await onUpload({ uploads, filename: args[1], result, contexts: wrapped.contexts, site: siteModel });
              return result;
            };
          }
          return typeof target[prop] === "function" ? target[prop].bind(target) : target[prop];
        },
      });
      if (onClient) onClient(client);

      const claimed = await client.next();
      if (!claimed) throw new Error("The companion was given no job.");
      const result = await companion.runJob({
        client,
        claimed,
        home: companionHome,
        playwright: wrapped,
        options: { headless: true, waitForSignIn: true, signInWaitSec, callouts: "none", ...runOptions },
        log: (line) => lines.push(String(line)),
        heartbeatMs: 60_000,
        shouldStop: runOptions.shouldStop,
        sleepFn: runOptions.sleepFn,
      });
      const finished = (await api("GET", `/api/capture/jobs/${queued.body.job.id}`)).body.job;
      const status = (await api("GET", `/api/generated-labs/${lab.labId}/screenshots`)).body;
      const rows = finished.shots.map((s) => ({ filename: s.filename, status: s.status, finalUrl: s.verification?.finalUrl || null, reason: s.error || s.message || s.verification?.reasons?.[0]?.message || null, verification: s.verification, cause: s.cause || null, raw: s }));
      return { job: finished, rows, result, lines, claimed, site: siteModel, launches: wrapped.launches, lab, labStatus: status, queued: queued.body, elapsedMs: Date.now() - started, uploads, home: companionHome };
    },
    async close() {
      portal.stop();
      await Promise.all(wrapped.contexts.map((c) => c.close().catch(() => {})));
      for (const dir of [storageRoot, ...(ownHome ? [companionHome] : [])]) {
        try {
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
        } catch {
          // A browser can hold a file a moment longer on Windows; the folder is in the temp directory.
        }
      }
    },
  };
  return scenario;
}

/**
 * Run one lab capture end to end.
 * @param {object} options see `startScenario`, plus:
 * @param {object} [options.job] the POST /api/capture/jobs body (the lab target is added)
 * @param {object} [options.runOptions] companion options (headless is the default)
 * @param {(ctx: object) => Promise<void>} [options.prepare] runs after the lab and portal exist, before the job is queued (save settings here)
 * @param {(ctx: object) => void} [options.onUpload] called after each upload (close the browser from here)
 */
export async function runCaptureScenario({ job = {}, runOptions = {}, prepare = null, onUpload = null, onClient = null, ...startOptions }) {
  const scenario = await startScenario(startOptions);
  try {
    if (prepare) await prepare(scenario);
    return await scenario.runJob({ job, runOptions, onUpload, onClient });
  } finally {
    await scenario.close();
  }
}

/** Count what happened, judged against the ground truth. */
export function tally(rows) {
  const out = { total: rows.length, accepted: 0, acceptedOnRightScreen: 0, acceptedOnWrongScreen: 0, needsReview: 0, needsReviewOnRightScreen: 0, failed: 0, skipped: 0, paused: 0, needsYou: 0, other: 0, landedRight: 0, landedWrong: 0 };
  for (const row of rows) {
    const { right } = judge(row);
    if (right === true) out.landedRight += 1;
    if (right === false) out.landedWrong += 1;
    if (row.status === "captured") {
      out.accepted += 1;
      if (right === false) out.acceptedOnWrongScreen += 1;
      else out.acceptedOnRightScreen += 1;
    } else if (row.status === "needs-review") {
      out.needsReview += 1;
      if (right === true) out.needsReviewOnRightScreen += 1;
    } else if (row.status === "failed" || row.status === "auth-required") out.failed += 1;
    else if (row.status === "skipped") out.skipped += 1;
    else if (row.status === "paused") out.paused += 1;
    else if (row.status === "needs-you") out.needsYou += 1;
    else out.other += 1;
  }
  return out;
}

export { FAKE_ENV_ID, FAKE_HOSTS };
