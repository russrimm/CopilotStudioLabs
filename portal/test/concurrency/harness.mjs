/**
 * The concurrency harness: starts a throwaway portal, simulates N people using it at the same time, and reports what
 * broke and how slow it got. Run it with `npm run test:concurrency` from portal/ (see docs/lab-builder.md, "Many people at
 * once"), or call runHarness() from a test.
 *
 * What it does
 *  - Starts the portal in a child process with throwaway storage folders, sign-in off, no language model, no link check,
 *    topic refresh off, and a fake Microsoft Learn on 127.0.0.1. Nothing touches the network, the owner's data, or Azure.
 *  - Preloads monitor-preload.mjs into the portal so the event-loop stall and memory are measured from outside (that also
 *    works on an older checkout, which is how a before/after comparison is made: --portal-dir <other checkout>/portal).
 *  - Runs N virtual people in parallel. Each has its own browser id (X-Client-Id) and address (X-Forwarded-For), a
 *    seeded random generator, and a realistic mix: open the wizard, ask for recommendations, add a Learn topic and a
 *    product, save/resume/rename/delete drafts and autosave, build labs (two people send the SAME request at once),
 *    export every kind of file, open labs while others replace or delete them, and pair two fake companions that queue,
 *    claim, and upload pictures to the same shared slot.
 *  - Samples /healthz every 100 ms the whole time, and checks the files left behind when the run ends.
 *
 * Same seed, same workload: the choices each person makes come from a seeded generator, so a run on main and a run on a
 * branch send the same requests (timing differs, which is the point).
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { startFakeLearn } from "./fake-learn.mjs";
import * as integrity from "./integrity.mjs";
import { makePng } from "../../../tools/screenshot-capture/test/fixtures/png.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PORTAL_DIR = path.resolve(HERE, "..", "..");
const PRELOAD = pathToFileURL(path.join(HERE, "monitor-preload.mjs")).href;

// ── Small helpers ───────────────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, list) => list[Math.floor(rng() * list.length)];

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index] * 10) / 10;
}

function summarizeLatency(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted.length ? Math.round(sorted[sorted.length - 1] * 10) / 10 : 0 };
}

async function freePort() {
  const probe = (port) =>
    new Promise((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(0));
      server.listen(port, "127.0.0.1", () => {
        const { port: bound } = server.address();
        server.close(() => resolve(bound));
      });
    });
  for (let port = 3131; port <= 3139; port += 1) {
    const got = await probe(port);
    if (got) return got;
  }
  return probe(0);
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve, count: 0 };
}

const shared = (ctx, name) => {
  if (!ctx.shared.has(name)) ctx.shared.set(name, deferred());
  return ctx.shared.get(name);
};

async function waitFor(ctx, name, ms = 90000) {
  // The timers are unreferenced: a race that is already won must not keep the process alive for the rest of the wait.
  return Promise.race([shared(ctx, name).promise, sleep(ms, undefined, { ref: false }).then(() => undefined)]);
}

/** Everyone listed arrives, or 45 seconds pass. */
async function barrier(ctx, name, parties) {
  const b = shared(ctx, `barrier:${name}`);
  b.count += 1;
  if (b.count >= parties) b.resolve(true);
  await Promise.race([b.promise, sleep(45000, undefined, { ref: false })]);
}

// ── The workload's data ─────────────────────────────────────────────────────

const PRODUCTS = ["copilot-studio", "sharepoint-ai", "power-platform-ai-hub", "ai-foundry", "m365-copilot-agent-builder", "m365-copilot-hub"];
const INDUSTRIES = ["manufacturing", "retail", "financial-services", "healthcare", "energy-resources", "education", "nonprofit"];
const ROLES = ["executives", "sales", "marketing", "customer-service", "legal", "finance", "hr", "it", "operations"];
const LEVELS = [100, 200, 300];
const HUBS = ["power-automate", "power-apps", "power-bi", "dynamics365", "azure/ai-foundry"];
const GENERATE_VARIANTS = [
  { products: ["copilot-studio"], features: ["mc-memory"], harness: "microsoft-copilot", includeCore: false },
  { products: ["copilot-studio"], features: ["create-agent", "agent-instructions"], harness: "standard", includeCore: false },
  { products: ["copilot-studio"], features: ["topics", "power-fx"], harness: "standard", includeCore: false },
  { products: ["copilot-studio"], features: ["knowledge-sharepoint"], harness: "standard", includeCore: false },
  { products: ["copilot-studio"], features: ["connector-tools", "mcp-servers"], harness: "standard", includeCore: false },
  { products: ["copilot-studio"], features: ["publish-agent", "test-agent"], harness: "standard", includeCore: false },
];
const EXPORT_FORMATS = ["docx", "pptx", "pdf", "zip", "prerequisites-docx", "admin-guide-docx", "facilitator-docx", "html", "md", "prerequisites-pdf"];
const OFFICE_KIND = { docx: "docx", "prerequisites-docx": "docx", "admin-guide-docx": "docx", "facilitator-docx": "docx", pptx: "pptx", zip: "zip" };

function draftContent(token, step = 3) {
  return {
    selections: {
      products: ["copilot-studio"],
      industry: "retail",
      roles: ["sales"],
      level: 200,
      harness: "standard",
      features: ["create-agent"],
      customTitle: `Lab ${token}`,
      useLearnMcp: false,
      useLlm: false,
    },
    wizard: { step, furthest: step, chosenSteps: ["product", "tailor", "topics"] },
    labels: {},
  };
}

/** The address a correct screenshot of this shot would be taken at (mirrors what the companion tests use). */
function evidenceFor(shot) {
  const expect = shot.capture?.expect;
  let finalUrl = "https://copilotstudio.microsoft.com/environments/abc/bots";
  if (expect?.family === "copilot-studio") {
    const base = "https://copilotstudio.microsoft.com/environments/abc";
    finalUrl = expect.scope === "agent" ? `${base}/bots/def/${expect.paths[0]}` : `${base}/${expect.paths[0]}`;
  } else if (expect?.family === "url" && expect.host) {
    finalUrl = `https://${expect.host}/`;
  }
  // A current companion proves the harness before it takes a picture (a product with no harnesses has none).
  const harness = shot.harness === "standard" || shot.harness === "microsoft-copilot" || shot.harness === "customer-conversation" ? shot.harness : null;
  const landmarks = harness === "standard" ? ["Overview", "Knowledge", "Topics"] : ["Build", "Preview", "Evaluate", harness === "customer-conversation" ? "Deploy" : "Monitor"];
  return {
    version: 2,
    finalUrl: `${finalUrl}?token=SECRET#frag`,
    title: "Copilot Studio",
    visibleText: shot.expectedLabels?.length ? shot.expectedLabels : ["Settings"],
    redaction: { applied: true, masked: 2 },
    capturedAt: new Date().toISOString(),
    executedSteps: 5,
    ...(harness ? { harness: { version: 1, id: harness, proof: "landmarks", landmarks, switched: harness === "standard", wanted: harness } } : {}),
  };
}

// ── Talking to the portal ───────────────────────────────────────────────────

function familyOf(method, p) {
  if (p === "/healthz") return "health";
  if (p.startsWith("/api/capture")) return "capture";
  if (p.includes("/drafts")) return "drafts";
  if (p === "/api/lab-builder/generate") return "generate";
  if (/\/(export|prerequisites|admin-guide)(\?|$)/.test(p) || /\/topics\/\d+\//.test(p)) return "export";
  if (/\/generated(\/|\?|$)|\/api\/generated-labs/.test(p)) return "labs";
  return "wizard";
}

async function request(ctx, user, method, urlPath, { json, body, headers = {}, ok = [200, 201], timeoutMs = 120000, family, companion = false } = {}) {
  const started = performance.now();
  const record = { user: user.index, family: family || familyOf(method, urlPath), method, path: urlPath.replace(/draft-[0-9a-f]{24}/g, ":draft").replace(/job_[0-9a-f]{16}/g, ":job").replace(/[a-z0-9-]*-lab-?[a-z0-9-]*/gi, ":lab"), status: 0, ms: 0, ok: false };
  let res = null;
  let buffer = Buffer.alloc(0);
  try {
    res = await fetch(`${ctx.base}${urlPath}`, {
      method,
      headers: {
        ...(json !== undefined ? { "content-type": "application/json" } : {}),
        ...(!companion && ctx.opts.clientIds ? { "x-client-id": user.clientId } : {}),
        ...(!companion ? { "x-forwarded-for": ctx.opts.sharedIp ? "203.0.113.9" : user.ip } : {}),
        ...headers,
      },
      body: json !== undefined ? JSON.stringify(json) : body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    buffer = Buffer.from(await res.arrayBuffer());
    record.status = res.status;
  } catch (err) {
    record.error = String(err?.cause?.code || err?.message || err).slice(0, 120);
  }
  record.ms = performance.now() - started;
  record.ok = ok.includes(record.status);
  if (!record.ok && record.status) record.detail = buffer.toString("utf8", 0, 200);
  ctx.records.push(record);
  let parsed = null;
  const type = res?.headers?.get("content-type") || "";
  if (type.includes("json")) {
    try {
      parsed = JSON.parse(buffer.toString("utf8"));
    } catch {
      parsed = null;
    }
  }
  return { status: record.status, json: parsed, buffer, text: type.includes("json") || type.startsWith("text/") ? buffer.toString("utf8") : "", headers: res?.headers, ms: record.ms, ok: record.ok };
}

function saveExport(ctx, user, format, labId, result) {
  const kind = OFFICE_KIND[format];
  if (!kind || result.status !== 200 || ctx.savedExports.length >= ctx.opts.maxSavedExports) return;
  if (kind === "zip" && ctx.savedExports.filter((f) => f.kind === "zip").length >= 4) return;
  const ext = kind === "zip" ? "zip" : kind;
  const file = path.join(ctx.exportsDir, `${ctx.savedExports.length}-${labId}-${format}.${ext}`);
  writeFileSync(file, result.buffer);
  ctx.savedExports.push({ file, kind, label: `${labId} ${format} (user ${user.index})` });
}

// ── The people's flows ──────────────────────────────────────────────────────

async function wizardOpen(ctx, user) {
  await Promise.all([
    request(ctx, user, "GET", "/api/lab-builder/features"),
    request(ctx, user, "GET", "/api/lab-builder/topics"),
    request(ctx, user, "GET", "/api/lab-builder/generated"),
    request(ctx, user, "GET", "/api/lab-builder/products/picklist"),
  ]);
}

async function wizardChoices(ctx, user, round) {
  const rng = user.rng;
  for (let i = 0; i < 3; i += 1) {
    const product = pick(rng, PRODUCTS);
    const answers = { products: [product], industry: pick(rng, INDUSTRIES), roles: [pick(rng, ROLES)], level: pick(rng, LEVELS), ...(product === "copilot-studio" ? { harness: "standard" } : {}) };
    await request(ctx, user, "POST", "/api/lab-builder/recommend", { json: answers });
  }
  await request(ctx, user, "POST", "/api/lab-builder/preview", { json: { ...GENERATE_VARIANTS[(user.index + round) % GENERATE_VARIANTS.length], useLearnMcp: false, useLlm: false } });
  // Two people adding the same kind of thing is normal: "already added" is an expected answer, a failure is not.
  const topicUrl = `https://learn.microsoft.com/microsoft-copilot-studio/hx${ctx.opts.seed}-u${user.index}-r${round}-guide`;
  const added = await request(ctx, user, "POST", "/api/lab-builder/topics/mine", { json: { url: topicUrl, level: 100 }, ok: [200, 201, 409] });
  if (added.json?.topic?.id) ctx.addedTopics.add(added.json.topic.id);
  await request(ctx, user, "POST", "/api/lab-builder/products/mine", { json: { root: `https://learn.microsoft.com/${HUBS[user.index % HUBS.length]}` }, ok: [200, 201, 409] });
  await request(ctx, user, "GET", "/api/lab-builder/topics");
}

async function draftsFlow(ctx, user, round) {
  const token = user.token;
  const mine = (text) => ctx.opts.expectIsolation !== false && ctx.allTokens.some((t) => t !== token && text.includes(t));
  const watch = (res, where) => {
    ctx.observations.push({ user: user.index, tokens: ctx.allTokens.filter((t) => t !== token), bodyText: res.text || "", where });
  };

  watch(await request(ctx, user, "GET", "/api/lab-builder/drafts"), "list at start");
  await request(ctx, user, "PUT", "/api/lab-builder/drafts/unsaved", { json: { content: draftContent(token, 2) } });
  const slot = await request(ctx, user, "GET", "/api/lab-builder/drafts/unsaved");
  watch(slot, "autosave slot");
  const title = slot.json?.unsaved?.content?.selections?.customTitle;
  if (title && title !== `Lab ${token}`) ctx.unsavedMismatches.push({ user: user.index, saw: title });

  const created = await request(ctx, user, "POST", "/api/lab-builder/drafts", { json: { name: `Draft ${token} r${round}`, content: draftContent(token) } });
  const id = created.json?.draft?.id;
  if (id) {
    user.draftIds.add(id);
    await request(ctx, user, "GET", `/api/lab-builder/drafts/${id}`);
    const renamed = await request(ctx, user, "PUT", `/api/lab-builder/drafts/${id}`, { json: { name: `Renamed ${token} r${round}` } });
    if (renamed.ok) user.draftNames.set(id, `Renamed ${token} r${round}`);
    const copy = await request(ctx, user, "POST", `/api/lab-builder/drafts/${id}/duplicate`);
    if (copy.json?.draft?.id) user.draftIds.add(copy.json.draft.id);
    if (copy.json?.draft?.id && round % 2 === 0) {
      const gone = await request(ctx, user, "DELETE", `/api/lab-builder/drafts/${copy.json.draft.id}`);
      if (gone.ok) user.draftIds.delete(copy.json.draft.id);
    }
  }
  const listed = await request(ctx, user, "GET", "/api/lab-builder/drafts");
  watch(listed, "list after saves");
  if (mine(listed.text)) ctx.draftLeaks.push({ user: user.index, where: "list after saves" });
  const ids = new Set((listed.json?.drafts || []).map((d) => d.id));
  const missing = [...user.draftIds].filter((d) => !ids.has(d));
  if (missing.length) ctx.draftsMissing.push({ user: user.index, missing: missing.length });
  if (round === ctx.opts.rounds - 1) user.finalDraftList = listed.json?.drafts || [];
}

async function generateOne(ctx, user, body, { replaceLabId, ok = [200] } = {}) {
  ctx.generating += 1;
  try {
    const result = await request(ctx, user, "POST", "/api/lab-builder/generate", { json: { ...body, useLearnMcp: false, useLlm: false, ...(replaceLabId ? { replaceLabId } : {}) }, ok, timeoutMs: 180000, headers: { "x-build-ticket": `hx${user.index}${Math.random().toString(36).slice(2, 12)}` } });
    if (result.status === 200 && result.json?.status === "complete" && result.json.labId) {
      ctx.createdIds.push(result.json.labId);
      // A name may be reused after its lab was deleted or replaced; a name handed out while its lab still exists is a collision.
      if (ctx.expectedIds.has(result.json.labId)) ctx.duplicateIds.push(result.json.labId);
      ctx.expectedIds.add(result.json.labId);
      if (result.json.replacedLabId) ctx.expectedIds.delete(result.json.replacedLabId);
      user.labs.push(result.json.labId);
      ctx.pool.add(result.json.labId);
      if (result.json.replacedLabId) {
        ctx.pool.delete(result.json.replacedLabId);
        user.labs = user.labs.filter((l) => l !== result.json.replacedLabId);
      }
      return result.json.labId;
    }
    return null;
  } finally {
    ctx.generating -= 1;
  }
}

async function generateFlow(ctx, user, round) {
  // Two people send exactly the same request at the same moment in the first round.
  if (round === 0 && ctx.opts.users >= 2 && user.index < 2) {
    await barrier(ctx, "same-request", 2);
    await generateOne(ctx, user, GENERATE_VARIANTS[0]);
    return;
  }
  await generateOne(ctx, user, GENERATE_VARIANTS[(user.index + round) % GENERATE_VARIANTS.length]);
}

async function exportFlow(ctx, user, round) {
  const rng = user.rng;
  const stable = [...ctx.pool].filter((id) => !ctx.racing.has(id));
  if (!stable.length) return;
  const formats = [EXPORT_FORMATS[(user.index * 3 + round) % EXPORT_FORMATS.length], EXPORT_FORMATS[(user.index * 3 + round + 1) % EXPORT_FORMATS.length], pick(rng, EXPORT_FORMATS)];
  // The same lab may be deleted by its owner between choosing it and exporting it: "gone" is a clean answer, a 500 is not.
  const okExport = [200, 404, 410];
  await Promise.all(
    formats.map(async (format) => {
      const labId = user.labs[0] && rng() < 0.5 ? user.labs[0] : pick(rng, stable);
      const result = await request(ctx, user, "GET", `/api/lab-builder/generated/${labId}/export?format=${format}`, { ok: okExport });
      if (result.status === 200) saveExport(ctx, user, format, labId, result);
    }),
  );
  const labId = user.labs[0] || pick(rng, stable);
  await Promise.all([
    request(ctx, user, "GET", `/api/lab-builder/generated/${labId}`, { ok: okExport }),
    request(ctx, user, "GET", `/api/lab-builder/generated/${labId}/screenshots`, { ok: okExport }),
    request(ctx, user, "GET", `/api/lab-builder/generated/${labId}/validate`, { ok: okExport }),
    request(ctx, user, "GET", `/api/lab-builder/generated/${labId}/prerequisites`, { ok: okExport }),
    request(ctx, user, "GET", `/api/lab-builder/generated/${labId}/topics/1/docx`, { ok: [200, 404, 410] }),
    request(ctx, user, "GET", "/api/lab-builder/generated"),
  ]);
}

/** One person replaces a lab while another reads it, and one deletes a lab while another opens it. */
async function raceFlow(ctx, user, round) {
  if (ctx.opts.users < 4) return;
  const role = user.index % 4;
  const whole = [200, 404, 410];
  const readLab = async (labId) => {
    const open = await request(ctx, user, "GET", `/api/lab-builder/generated/${labId}`, { ok: whole });
    if (open.status === 200 && !open.json?.labId && !open.json?.markdown && !open.json?.html) ctx.wholeOrGone.push({ user: user.index, what: "open returned an unreadable body", labId });
    const docx = await request(ctx, user, "GET", `/api/lab-builder/generated/${labId}/export?format=docx`, { ok: whole });
    if (docx.status === 200) saveExport(ctx, user, "docx", labId, docx);
    await request(ctx, user, "GET", `/api/lab-builder/generated/${labId}/export?format=zip`, { ok: whole });
    await request(ctx, user, "GET", `/api/lab-builder/generated/${labId}/topics/1/pptx`, { ok: whole });
  };

  if (role === 0) {
    // Replacer: build a lab, tell the reader, then replace it while the reader hammers it.
    const first = await generateOne(ctx, user, GENERATE_VARIANTS[2]);
    if (first) ctx.racing.add(first);
    shared(ctx, `race-lab-${round}`).resolve(first);
    if (first) {
      await generateOne(ctx, user, GENERATE_VARIANTS[2], { replaceLabId: first });
      ctx.racing.delete(first);
    }
    shared(ctx, `race-done-${round}`).resolve(true);
  } else if (role === 1) {
    const labId = await waitFor(ctx, `race-lab-${round}`);
    if (!labId) return;
    const done = shared(ctx, `race-done-${round}`);
    let finished = false;
    done.promise.then(() => {
      finished = true;
    });
    let reads = 0;
    while (!finished && reads < 40) {
      await readLab(labId);
      reads += 1;
    }
    await readLab(labId);
  } else if (role === 2) {
    // Deleter: build a lab, tell the opener, delete it.
    const victim = await generateOne(ctx, user, GENERATE_VARIANTS[3]);
    if (victim) ctx.racing.add(victim);
    shared(ctx, `delete-lab-${round}`).resolve(victim);
    if (victim) {
      await sleep(30);
      const removed = await request(ctx, user, "DELETE", `/api/lab-builder/generated/${victim}`, { ok: [200, 404] });
      if (removed.status === 200) {
        ctx.expectedIds.delete(victim);
        ctx.pool.delete(victim);
        user.labs = user.labs.filter((l) => l !== victim);
      }
      ctx.racing.delete(victim);
    }
    shared(ctx, `delete-done-${round}`).resolve(true);
  } else {
    const labId = await waitFor(ctx, `delete-lab-${round}`);
    if (!labId) return;
    let finished = false;
    shared(ctx, `delete-done-${round}`).promise.then(() => {
      finished = true;
    });
    let reads = 0;
    while (!finished && reads < 40) {
      await readLab(labId);
      reads += 1;
    }
    await readLab(labId);
  }
}

async function captureFlow(ctx, user, round) {
  if (round !== 0 || ctx.opts.users < 2 || user.index > 1 || !ctx.opts.capture) return;
  const labId = user.labs[0];
  if (!labId) {
    await barrier(ctx, "capture-ready", 2);
    await barrier(ctx, "capture-queued", 2);
    return;
  }
  const pair = await request(ctx, user, "POST", "/api/capture/pair");
  const code = pair.json?.code;
  let token = null;
  if (code) {
    const paired = await request(ctx, user, "POST", "/api/capture/companion/pair", { json: { code, deviceName: `HARNESS-PC-${user.index}`, platform: "win32", companionVersion: "1.0.0" }, companion: true });
    token = paired.json?.token || null;
  }
  const auth = token ? { authorization: `Bearer ${token}` } : {};
  if (token) await request(ctx, user, "POST", "/api/capture/companion/heartbeat", { json: { signedInProducts: ["copilot-studio"] }, headers: auth, companion: true });
  await barrier(ctx, "capture-ready", 2);
  const queued = await request(ctx, user, "POST", "/api/capture/jobs", { json: { target: { type: "lab", labId }, scope: "missing" }, ok: [200, 201] });
  const queuedId = queued.json?.job?.id || null;
  await barrier(ctx, "capture-queued", 2);
  if (!token) return;
  // Both companions ask for work at the same moment.
  const next = await request(ctx, user, "GET", "/api/capture/companion/next", { headers: auth, ok: [200, 204], companion: true });
  const claimed = next.status === 200 ? next.json : null;
  if (!claimed?.job?.id) return;
  ctx.claims.push({ user: user.index, jobId: claimed.job.id, ownJob: claimed.job.id === queuedId });
  const barrierName = "capture-upload";
  await barrier(ctx, barrierName, 2);
  for (const shot of (claimed.shots || []).slice(0, 3)) {
    const form = new FormData();
    form.append("file", new Blob([makePng({ mode: "ui", seed: 8 + user.index })], { type: "image/png" }), shot.filename);
    form.append("evidence", JSON.stringify(evidenceFor(shot)));
    await request(ctx, user, "PUT", `/api/capture/companion/jobs/${claimed.job.id}/shots/${encodeURIComponent(shot.filename)}`, { body: form, headers: auth, ok: [200], companion: true });
  }
  await request(ctx, user, "POST", `/api/capture/companion/jobs/${claimed.job.id}/complete`, { json: { message: "done" }, headers: auth, ok: [200], companion: true });
  await request(ctx, user, "GET", `/api/capture/jobs?labId=${labId}`);
  await request(ctx, user, "GET", `/api/lab-builder/generated/${labId}/screenshots`);
}

async function runUser(ctx, user) {
  for (let round = 0; round < ctx.opts.rounds; round += 1) {
    // A run never goes past its time budget: it stops starting new work and reports what it did.
    if (round > 0 && performance.now() - ctx.startedAt > ctx.opts.maxSeconds * 1000) break;
    const steps = [
      ["open the wizard", () => wizardOpen(ctx, user)],
      ["wizard choices", () => wizardChoices(ctx, user, round)],
      ["drafts", () => draftsFlow(ctx, user, round)],
      ["build a lab", () => generateFlow(ctx, user, round)],
      ["exports and reads", () => exportFlow(ctx, user, round)],
      ["replace and delete races", () => raceFlow(ctx, user, round)],
      ["capture", () => captureFlow(ctx, user, round)],
    ];
    for (const [name, run] of steps) {
      try {
        await run();
      } catch (err) {
        ctx.scenarioErrors.push({ user: user.index, round, step: name, error: String(err?.message || err).slice(0, 200) });
      }
    }
  }
}

// ── Starting and measuring the portal ───────────────────────────────────────

async function startPortal(ctx) {
  const port = await freePort();
  const storageRoot = path.join(ctx.root, "storage");
  const dirs = {
    storageRoot,
    generated: path.join(storageRoot, "generated-labs"),
    data: path.join(storageRoot, "data"),
    shots: path.join(storageRoot, "screenshots"),
    localAppData: path.join(ctx.root, "localappdata"),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  const relaxed = ctx.opts.relaxedLimits
    ? { LAB_BUILDER_RATE_MAX: "1000", LAB_BUILDER_MANAGE_RATE_MAX: "1000", LAB_BUILDER_DRAFTS_RATE_MAX: "5000", LAB_BUILDER_TOPICS_RATE_MAX: "1000", LAB_BUILDER_USER_TOPICS_RATE_MAX: "1000", LAB_BUILDER_USER_PRODUCTS_RATE_MAX: "1000", CAPTURE_PAIR_RATE_MAX: "1000", CAPTURE_MANAGE_RATE_MAX: "1000", CAPTURE_UPLOAD_RATE_MAX: "5000", CAPTURE_EXCHANGE_RATE_MAX: "1000", CAPTURE_COMPANION_RATE_MAX: "5000" }
    : {};
  const child = spawn(process.execPath, ["--import", PRELOAD, "server.js"], {
    cwd: ctx.opts.portalDir,
    env: {
      ...process.env,
      LOCALAPPDATA: dirs.localAppData,
      PORT: String(port),
      HOST: "127.0.0.1",
      PORTAL_AUTH_DISABLED: "true",
      AZURE_KEYVAULT_URL: "",
      AZURE_STORAGE_BLOB_ENDPOINT: "",
      PORTAL_STORAGE_ROOT: storageRoot,
      PORTAL_DATA_DIR: dirs.data,
      LAB_BUILDER_OUTPUT_DIR: dirs.generated,
      FEATURE_TOUR_SCREENSHOTS_DIR: dirs.shots,
      LAB_BUILDER_LINK_CHECK: "off",
      LAB_BUILDER_LLM: "off",
      LAB_BUILDER_VENDOR_DOCS: "off",
      LAB_BUILDER_TOPICS_DISABLED: "1",
      LAB_BUILDER_TOPICS_AUTO_REFRESH: "",
      LEARN_MCP_URL: ctx.fakeLearn.url,
      ...relaxed,
      ...ctx.opts.env,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`The portal exited early (${child.exitCode}): ${stderr.slice(-600)}`);
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`The portal did not start in time: ${stderr.slice(-600)}`);
    await sleep(120);
  }
  const waiting = new Map();
  let nextMessage = 1;
  child.on("message", (message) => waiting.get(message?.id)?.(message));
  const ask = (type) =>
    new Promise((resolve) => {
      const id = nextMessage++;
      const timer = setTimeout(() => resolve(null), 5000);
      waiting.set(id, (m) => {
        clearTimeout(timer);
        waiting.delete(id);
        resolve(m);
      });
      child.send({ type, id });
    });
  return { base, child, dirs, ask, stderr: () => stderr };
}

async function stopPortal(portal) {
  const { child } = portal;
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(8000)]);
}

// ── The run ─────────────────────────────────────────────────────────────────

/**
 * @param {object} [options]
 * @param {string} [options.portalDir] the portal folder to test (default: this checkout)
 * @param {number} [options.users] virtual people (default 4; the harness caps it at 12)
 * @param {number} [options.rounds] times each person repeats the mix (default 2)
 * @param {number} [options.seed] seed for every random choice (default 1)
 * @param {boolean} [options.sharedIp] every request comes from one address (an ingress that hides the real one)
 * @param {boolean} [options.relaxedLimits] raise the per-person rate limits so capacity, not throttling, is measured
 * @param {boolean} [options.capture] include the capture flows (default true)
 * @param {boolean} [options.clientIds] send X-Client-Id (default true)
 * @param {object} [options.env] extra portal environment
 * @param {string} [options.outDir] keep the run's files here (default: a temp folder that is removed)
 * @param {string} [options.label] a name for the report
 */
export async function runHarness(options = {}) {
  const opts = {
    portalDir: options.portalDir ? path.resolve(options.portalDir) : DEFAULT_PORTAL_DIR,
    users: Math.min(12, Math.max(1, Number(options.users) || 4)),
    rounds: Math.min(6, Math.max(1, Number(options.rounds) || 2)),
    seed: Number.isFinite(Number(options.seed)) ? Number(options.seed) : 1,
    sharedIp: Boolean(options.sharedIp),
    relaxedLimits: Boolean(options.relaxedLimits),
    capture: options.capture !== false,
    clientIds: options.clientIds !== false,
    expectIsolation: options.expectIsolation,
    maxSavedExports: Number(options.maxSavedExports) || 16,
    maxSeconds: Number(options.maxSeconds) || 110,
    env: options.env || {},
    label: options.label || "run",
    outDir: options.outDir ? path.resolve(options.outDir) : "",
  };
  const root = mkdtempSync(path.join(tmpdir(), "lb-concurrency-"));
  const exportsDir = path.join(root, "exports");
  mkdirSync(exportsDir, { recursive: true });
  const fakeLearn = await startFakeLearn();
  const users = Array.from({ length: opts.users }, (_, index) => {
    const rng = mulberry32(opts.seed * 1000 + index);
    return {
      index,
      rng,
      token: `hx${opts.seed}u${index}x`,
      clientId: Buffer.from(Array.from({ length: 16 }, () => Math.floor(rng() * 256))).toString("base64url"),
      ip: `10.1.${Math.floor(index / 250)}.${(index % 250) + 1}`,
      labs: [],
      draftIds: new Set(),
      draftNames: new Map(),
      finalDraftList: [],
    };
  });
  const ctx = {
    opts,
    root,
    exportsDir,
    fakeLearn,
    users,
    allTokens: users.map((u) => u.token),
    records: [],
    shared: new Map(),
    generating: 0,
    createdIds: [],
    duplicateIds: [],
    expectedIds: new Set(),
    pool: new Set(),
    racing: new Set(),
    addedTopics: new Set(),
    observations: [],
    unsavedMismatches: [],
    draftLeaks: [],
    draftsMissing: [],
    wholeOrGone: [],
    scenarioErrors: [],
    savedExports: [],
    claims: [],
    health: [],
  };

  let portal = null;
  const report = { label: opts.label, portalDir: opts.portalDir, users: opts.users, rounds: opts.rounds, seed: opts.seed, sharedIp: opts.sharedIp, relaxedLimits: opts.relaxedLimits };
  try {
    portal = await startPortal(ctx);
    ctx.base = portal.base;
    await portal.ask("reset");

    let probing = true;
    const prober = (async () => {
      while (probing) {
        const during = ctx.generating > 0;
        const started = performance.now();
        let ok = false;
        try {
          const res = await fetch(`${ctx.base}/healthz`, { signal: AbortSignal.timeout(15000) });
          await res.arrayBuffer();
          ok = res.ok;
        } catch {
          ok = false;
        }
        ctx.health.push({ ms: performance.now() - started, ok, during });
        await sleep(100);
      }
    })();

    const started = performance.now();
    ctx.startedAt = started;
    await Promise.all(users.map((user) => runUser(ctx, user)));
    report.durationSec = Math.round((performance.now() - started) / 100) / 10;
    probing = false;
    await prober;

    // Final per-person checks through the API.
    for (const user of users) {
      const listed = await request(ctx, user, "GET", "/api/lab-builder/drafts");
      const names = (listed.json?.drafts || []).map((d) => d.name);
      const foreign = names.filter((n) => typeof n === "string" && ctx.allTokens.some((t) => t !== user.token && n.includes(t)));
      if (foreign.length) ctx.draftLeaks.push({ user: user.index, where: "final list", foreign: foreign.length });
      const own = (listed.json?.drafts || []).filter((d) => typeof d.name === "string" && d.name.includes(user.token)).length;
      user.finalOwnDrafts = own;
      user.expectedDrafts = user.draftIds.size;
    }

    const snapshot = await portal.ask("snapshot");
    report.eventLoop = snapshot?.lag || null;
    report.memory = snapshot?.memory || null;
    report.portalStderrTail = portal.stderr().slice(-300);
    report.fakeLearnCalls = { ...fakeLearn.stats };
    // Let background clean-up (removing deleted lab folders) finish before the files are checked.
    await sleep(1500);
    await stopPortal(portal);

    // Integrity checks on what the run left behind.
    const checks = [
      integrity.jsonFilesParse(portal.dirs.storageRoot),
      integrity.noTempLeftovers(portal.dirs.storageRoot),
      integrity.labFoldersValid(portal.dirs.generated),
      integrity.labIdsMatch({ generatedDir: portal.dirs.generated, duplicates: ctx.duplicateIds, expectedIds: ctx.expectedIds }),
      integrity.officeFilesValid(ctx.savedExports),
      integrity.noCrossUserData(ctx.observations),
    ];
    const draftProblems = users.filter((u) => u.finalOwnDrafts !== u.expectedDrafts).map((u) => `user ${u.index} has ${u.finalOwnDrafts} of ${u.expectedDrafts} drafts`);
    checks.push({ name: "each person's drafts add up", ok: draftProblems.length === 0 && ctx.draftsMissing.length === 0, detail: draftProblems.concat(ctx.draftsMissing.map((m) => `user ${m.user} lost ${m.missing} just-saved drafts from their list`)).slice(0, 6).join("; ") || `${users.length} people` });
    checks.push({ name: "autosave slot always holds the person's own work", ok: ctx.unsavedMismatches.length === 0, detail: ctx.unsavedMismatches.length ? `${ctx.unsavedMismatches.length} reads returned someone else's work` : "ok" });
    checks.push({ name: "drafts of one person never listed for another", ok: ctx.draftLeaks.length === 0, detail: ctx.draftLeaks.length ? `${ctx.draftLeaks.length} leaks` : "ok" });
    checks.push({ name: "open/export during replace or delete is whole or gone", ok: ctx.wholeOrGone.length === 0, detail: ctx.wholeOrGone.length ? `${ctx.wholeOrGone.length} unreadable answers` : "ok" });
    const claimCounts = new Map();
    for (const c of ctx.claims) claimCounts.set(c.jobId, (claimCounts.get(c.jobId) || 0) + 1);
    checks.push({ name: "no capture job was claimed twice", ok: [...claimCounts.values()].every((n) => n === 1), detail: `${ctx.claims.length} claims` });
    report.checks = checks;
    report.capture = { claims: ctx.claims.length, claimedOtherPersonsJob: ctx.claims.filter((c) => !c.ownJob).length };
  } catch (err) {
    report.fatal = String(err?.message || err);
    if (portal) await stopPortal(portal).catch(() => {});
  } finally {
    await fakeLearn.close().catch(() => {});
  }

  // Latency, failures, and health.
  const byFamily = {};
  for (const record of ctx.records) {
    const entry = (byFamily[record.family] ||= { latencies: [], failures: 0, statuses: {} });
    entry.latencies.push(record.ms);
    if (!record.ok) {
      entry.failures += 1;
      const key = record.status || record.error || "no-response";
      entry.statuses[key] = (entry.statuses[key] || 0) + 1;
    }
  }
  report.families = Object.fromEntries(Object.entries(byFamily).map(([name, e]) => [name, { ...summarizeLatency(e.latencies), failures: e.failures, statuses: e.statuses }]));
  report.requests = ctx.records.length;
  const failed = ctx.records.filter((r) => !r.ok);
  report.failures = failed.length;
  report.failureSamples = failed.slice(0, 12).map((r) => `${r.method} ${r.path} -> ${r.status || r.error}${r.detail ? ` ${String(r.detail).replace(/\s+/g, " ").slice(0, 110)}` : ""}`);
  report.generate = {
    ok: ctx.createdIds.length,
    attempts: ctx.records.filter((r) => r.family === "generate" && r.method === "POST").length,
    ...summarizeLatency(ctx.records.filter((r) => r.family === "generate" && r.ok).map((r) => r.ms)),
  };
  report.health = { ...summarizeLatency(ctx.health.map((h) => h.ms)), failures: ctx.health.filter((h) => !h.ok).length, duringGenerate: summarizeLatency(ctx.health.filter((h) => h.during).map((h) => h.ms)) };
  report.scenarioErrors = ctx.scenarioErrors.slice(0, 10);
  report.isolation = { draftLeaks: ctx.draftLeaks.length, autosaveMismatches: ctx.unsavedMismatches.length, wholeOrGoneProblems: ctx.wholeOrGone.length };
  report.labsPerMinute = report.durationSec ? Math.round((ctx.createdIds.length / report.durationSec) * 600) / 10 : 0;
  report.ok = !report.fatal && report.failures === 0 && ctx.scenarioErrors.length === 0 && (report.checks || []).every((c) => c.ok);

  if (opts.outDir) {
    mkdirSync(opts.outDir, { recursive: true });
    writeFileSync(path.join(opts.outDir, `${opts.label}.json`), `${JSON.stringify(report, null, 2)}\n`);
  }
  rmSync(root, { recursive: true, force: true });
  return report;
}

/** A plain-text table of one report. */
export function formatReport(report) {
  const lines = [];
  lines.push(`${report.label}: ${report.users} people x ${report.rounds} rounds, seed ${report.seed}${report.sharedIp ? ", all from one address" : ""}${report.relaxedLimits ? ", relaxed limits" : ""}`);
  if (report.fatal) lines.push(`  FATAL: ${report.fatal}`);
  lines.push(`  ${report.requests} requests in ${report.durationSec}s, ${report.failures} unexpected answers, ${report.generate?.ok}/${report.generate?.attempts} lab builds succeeded (${report.labsPerMinute} labs/min)`);
  lines.push("  route family      count  p50 ms  p95 ms  max ms  failures");
  for (const [name, f] of Object.entries(report.families || {})) {
    lines.push(`  ${name.padEnd(16)} ${String(f.count).padStart(6)} ${String(f.p50).padStart(7)} ${String(f.p95).padStart(7)} ${String(f.max).padStart(7)} ${String(f.failures).padStart(9)}${f.failures ? `  ${JSON.stringify(f.statuses)}` : ""}`);
  }
  if (report.eventLoop) lines.push(`  event loop stall: p99 ${report.eventLoop.p99Ms} ms, max ${report.eventLoop.maxMs} ms`);
  if (report.memory) lines.push(`  memory: ${report.memory.startRssMb} MB at start, ${report.memory.peakRssMb} MB peak, ${report.memory.endRssMb} MB at end`);
  if (report.health) lines.push(`  /healthz: p50 ${report.health.p50} ms, p95 ${report.health.p95} ms, max ${report.health.max} ms (${report.health.count} probes, ${report.health.failures} failed); while labs were building: p95 ${report.health.duringGenerate.p95} ms, max ${report.health.duringGenerate.max} ms (${report.health.duringGenerate.count} probes)`);
  if (report.capture) lines.push(`  capture: ${report.capture.claims} claims, ${report.capture.claimedOtherPersonsJob} of another person's job`);
  for (const check of report.checks || []) lines.push(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name}${check.detail ? ` (${check.detail})` : ""}`);
  for (const sample of report.failureSamples || []) lines.push(`  e.g. ${sample}`);
  for (const err of report.scenarioErrors || []) lines.push(`  scenario error: user ${err.user} round ${err.round} ${err.step}: ${err.error}`);
  return lines.join("\n");
}
