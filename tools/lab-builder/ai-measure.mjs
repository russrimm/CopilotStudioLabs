#!/usr/bin/env node
/**
 * Measure AI writing on the real GitHub Copilot service for one small lab. Counts and timings only.
 *
 *   node tools/lab-builder/ai-measure.mjs --features agent-instructions --levels 100 --model claude-haiku-4.5 --out <temp> --ledger <file>
 *   node tools/lab-builder/ai-measure.mjs --features agent-instructions --levels 100 --no-ai --out <temp>
 *
 * It builds the lab with the same code as build.mjs, wraps the real backend to time every model call, and prints one JSON
 * report: how the passages were grouped into calls, the size and duration of each call, the outcome, the guard rejections by
 * kind, the AI-written share per part and the seconds the AI parts took. The report never holds a prompt, a model answer or a
 * token.
 *
 * Every prompt counts against the person's Copilot allowance, so a ledger file counts them and the run refuses to start a call
 * once the ledger holds --cap prompts (default 190). Use temporary folders for --out; never the real generated-labs folder.
 *
 *   --ledger <file>   append one line per prompt (counts and timings only). Required unless --no-ai.
 *   --cap <n>         stop making real calls when the ledger holds this many prompts (default 190).
 *   --max-calls <n>   stop after this many calls in this run (default 40).
 *   --cache-dir <dir> keep the AI cache in this folder, to measure a rebuild (default: in memory only).
 *   --dump <dir>      write each call's prompt and answer under this folder for local guard tuning. Keep it out of the repository.
 *   --label <text>    a name for this run in the ledger.
 *   --abort-after <s> cancel the build this many seconds after it starts, and report how quickly it stopped and whether every
 *                     SDK session was disconnected.
 *   --diagnose        keep, in the report, the short protected term each guard rejection named (for tuning the guard).
 *   --plan-only       call no model: count the blocks, passages and requests the engine would use for this lab.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const lib = (name) => import(pathToFileURL(path.join(REPO_ROOT, "portal", "lib", name)).href);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[token.slice(2)] = next;
      i += 1;
    } else args[token.slice(2)] = true;
  }
  return args;
}

const list = (csv) => String(csv || "").split(",").map((s) => s.trim()).filter(Boolean);
const args = parseArgs(process.argv.slice(2));

if (!args.out || typeof args.out !== "string") {
  console.error("Error: --out <temporary folder> is required (never the real generated-labs folder).");
  process.exit(1);
}
const outRoot = path.resolve(args.out);
if (/generated-labs/i.test(outRoot)) {
  console.error("Error: --out must be a temporary folder, not generated-labs.");
  process.exit(1);
}
const noAi = args["no-ai"] === true;
const planOnly = args["plan-only"] === true;
const ledgerFile = typeof args.ledger === "string" ? path.resolve(args.ledger) : null;
if (!noAi && !planOnly && !ledgerFile) {
  console.error("Error: --ledger <file> is required for a real run, so every prompt is counted.");
  process.exit(1);
}
const cap = Number(args.cap) || 190;
const maxCalls = Number(args["max-calls"]) || 40;
const label = typeof args.label === "string" ? args.label : "run";
const dumpDir = typeof args.dump === "string" ? path.resolve(args.dump) : null;
const diagnose = args.diagnose === true;
if (dumpDir) fs.mkdirSync(dumpDir, { recursive: true });

function ledgerCount() {
  if (!ledgerFile || !fs.existsSync(ledgerFile)) return 0;
  return fs.readFileSync(ledgerFile, "utf8").split("\n").filter((line) => line.includes('"event":"prompt"')).length;
}
function ledgerAppend(row) {
  if (!ledgerFile) return;
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  fs.appendFileSync(ledgerFile, `${JSON.stringify({ at: new Date().toISOString(), label, ...row })}\n`);
}

const { generateLab } = await lib("lab-builder/generator.js");
const { createAi, localRequest } = await lib("ai/index.js");
const { readAiConfig } = await lib("ai/config.js");
const { createCopilotBackend } = await lib("ai/copilot-client.js");

const calls = [];
const runs = [];
const t0 = Date.now();
let made = 0;
let realBackend = null;
let ai = null;
let writer = null;

function describePrompt(prompt) {
  try {
    const body = JSON.parse(String(prompt).slice(String(prompt).indexOf("{")));
    const passages = (body.units || []).flatMap((unit) => unit.passages || []);
    const groups = new Set(passages.map((p) => p.group || p.id));
    return { blocks: groups.size, passages: passages.length, sourceChars: passages.reduce((sum, p) => sum + String(p.source || "").length, 0) };
  } catch {
    return { blocks: 0, passages: 0, sourceChars: 0 };
  }
}

if (planOnly) {
  // No model is called: count what the engine would ask (blocks, items, characters and requests) for this lab.
  const { piecesOf, sizeOf, packRequests } = await lib("ai/batching.js");
  const config = readAiConfig({ ...process.env, AI_GENERATION: "local-user" });
  const planner = {
    mode: "local-user",
    availability: async () => ({ ok: true }),
    listModels: async () => [{ id: "plan-only", name: "Plan only", multiplier: null, cost: "", reasoningEfforts: [] }],
    authStatus: async () => ({ signedIn: true, login: null }),
    complete: async () => {
      throw new Error("plan-only runs never call a model");
    },
    stop: async () => {},
    tally: {},
  };
  ai = createAi({ env: { ...process.env, AI_GENERATION: "local-user" }, bindHost: "127.0.0.1", authEnabled: false, backend: planner });
  const scope = args.scope ? list(args.scope) : undefined;
  writer = await ai.service.authorize(localRequest(), { enabled: true, provider: "github-copilot", model: "plan-only", ...(scope ? { scope } : {}) });
  writer.run = async (input) => {
    const entries = [];
    let skipped = 0;
    for (const unit of input.units) {
      for (const block of unit.blocks) {
        const pieces = piecesOf(block);
        const { chars, items } = sizeOf(pieces);
        if (!items) skipped += 1;
        else entries.push({ unit, block, pieces, chars, items });
      }
    }
    const requests = packRequests(entries, { maxChars: config.maxCharsPerRequest, maxBlocks: config.maxBlocksPerRequest });
    const part = String(input.units[0]?.id || "").startsWith("deck.") ? "training" : "lab";
    runs.push({ part, seconds: 0, calls: 0, summary: { blocks: entries.length, skipped, items: entries.reduce((s, e) => s + e.items, 0), chars: entries.reduce((s, e) => s + e.chars, 0), plannedRequests: requests.length, units: input.units.length }, rows: [] });
    const results = new Map();
    for (const entry of entries) results.set(entry.block.id, { status: "kept", reason: "plan-only", group: "model" });
    return { results, summary: { total: entries.length, ai: 0, cached: 0, kept: entries.length, skipped, requests: 0, notes: [], keptWhy: {}, calls: [], stopped: false } };
  };
} else if (!noAi) {
  const config = readAiConfig({ ...process.env, AI_GENERATION: "local-user" });
  realBackend = createCopilotBackend({ config, env: process.env });
  const wrapped = {
    ...realBackend,
    mode: realBackend.mode,
    availability: () => realBackend.availability(),
    listModels: (a) => realBackend.listModels(a),
    authStatus: () => realBackend.authStatus(),
    stop: () => realBackend.stop(),
    tally: realBackend.tally,
    async complete(request) {
      if (made >= maxCalls || ledgerCount() >= cap) {
        const error = new Error("The measurement run reached its prompt cap, so no more real calls were made.");
        error.code = "cap";
        throw error;
      }
      made += 1;
      const seq = made;
      const shape = describePrompt(request.prompt);
      ledgerAppend({ event: "prompt", model: request.model, seq, ...shape, promptChars: String(request.prompt).length });
      if (dumpDir) fs.writeFileSync(path.join(dumpDir, `${label}-call-${String(seq).padStart(2, "0")}.prompt.txt`), request.prompt);
      const started = Date.now();
      const record = { seq, model: request.model, startedAtS: +((started - t0) / 1000).toFixed(1), promptChars: String(request.prompt).length, timeoutMs: request.timeoutMs, ...shape };
      calls.push(record);
      try {
        const reply = await realBackend.complete(request);
        record.durationS = +((Date.now() - started) / 1000).toFixed(1);
        record.outcome = "ok";
        record.replyChars = reply.text.length;
        record.inputTokens = reply.usage?.inputTokens || 0;
        record.outputTokens = reply.usage?.outputTokens || 0;
        record.reasoningTokens = reply.usage?.reasoningTokens || 0;
        record.apiCalls = reply.usage?.apiCalls || 0;
        record.apiS = +((reply.usage?.apiMs || 0) / 1000).toFixed(1);
        record.firstTokenS = +((reply.usage?.firstTokenMs || 0) / 1000).toFixed(1);
        record.effort = request.reasoningEffort || null;
        record.prompts = reply.prompts || 1;
        if (record.prompts > 1) ledgerAppend({ event: "prompt", model: request.model, seq, note: "extra prompt inside one call", count: record.prompts - 1 });
        if (dumpDir) fs.writeFileSync(path.join(dumpDir, `${label}-call-${String(seq).padStart(2, "0")}.reply.txt`), reply.text);
        ledgerAppend({ event: "done", seq, ms: Date.now() - started, replyChars: reply.text.length });
        return reply;
      } catch (err) {
        record.durationS = +((Date.now() - started) / 1000).toFixed(1);
        record.outcome = String(err?.message || "error").replace(/[^A-Za-z0-9 .:_-]/g, " ").slice(0, 80);
        ledgerAppend({ event: "done", seq, ms: Date.now() - started, error: record.outcome });
        throw err;
      }
    },
  };
  ai = createAi({ env: { ...process.env, AI_GENERATION: "local-user" }, bindHost: "127.0.0.1", authEnabled: false, backend: wrapped, dataDir: typeof args["cache-dir"] === "string" ? path.resolve(args["cache-dir"]) : null });
  const scope = args.scope ? list(args.scope) : undefined;
  writer = await ai.service.authorize(localRequest(), { enabled: true, provider: "github-copilot", model: String(args.model), ...(scope ? { scope } : {}) });
  const originalRun = writer.run;
  writer.run = async (input) => {
    const started = Date.now();
    const before = calls.length;
    const out = await originalRun({ ...input, diagnostics: diagnose });
    const part = String(input.units[0]?.id || "").startsWith("deck.") ? "training" : "lab";
    const rows = [...out.results].map(([id, result]) => ({ id, status: result.status, reason: result.reason || null, kind: result.kind || null, group: result.group || null, detail: result.detail || null }));
    const { calls: engineCalls, notes, ...rest } = out.summary;
    runs.push({ part, seconds: +((Date.now() - started) / 1000).toFixed(1), calls: calls.length - before, summary: { ...rest, notes: notes.length }, engineCalls, rows });
    return out;
  };
}

const request = {
  products: args.products ? list(args.products) : undefined,
  industry: typeof args.industry === "string" ? args.industry : undefined,
  departments: args.departments ? list(args.departments) : undefined,
  roles: list(args.roles),
  levels: args.levels ? list(args.levels).map(Number) : undefined,
  features: list(args.features),
  includeCore: false,
  ...(writer ? { ai: { enabled: true, provider: "github-copilot", model: writer.model, scope: writer.scope } } : {}),
};

const started = Date.now();
const stages = {};
let lastStage = null;
let result;
// --abort-after <seconds>: cancel the build that long after it starts, then report how fast it stopped and what is left open.
const abortAfter = Number(args["abort-after"]) || 0;
const controller = new AbortController();
let abortedAt = 0;
let abortTimer = null;
if (abortAfter) {
  abortTimer = setTimeout(() => {
    abortedAt = Date.now();
    controller.abort();
  }, abortAfter * 1000);
}
let cancelReport = null;
try {
  result = await generateLab(request, {
    outputRoot: outRoot,
    write: true,
    useLearnMcp: args["no-learn"] !== true,
    useLlm: false,
    decisions: undefined,
    decisionSource: "cli-flag",
    ai: writer,
    ...(abortAfter ? { signal: controller.signal } : {}),
    onProgress: (event) => {
      const now = Date.now();
      if (lastStage) stages[lastStage.stage] = (stages[lastStage.stage] || 0) + (now - lastStage.at) / 1000;
      lastStage = { stage: event.stage, at: now };
    },
  });
} catch (err) {
  if (!abortAfter || !controller.signal.aborted) throw err;
  result = { status: "cancelled", manifest: {}, plan: {} };
} finally {
  clearTimeout(abortTimer);
  if (abortedAt && realBackend) {
    cancelReport = {
      abortedAfterS: abortAfter,
      stoppedAfterMs: Date.now() - abortedAt,
      sessionsOpened: realBackend.tally.sessions,
      sessionsDisconnected: realBackend.tally.disconnected,
      sessionsStillOpen: realBackend.openSessions(),
      callsStartedAfterAbort: calls.filter((c) => c.startedAtS * 1000 + t0 > abortedAt).length,
    };
  }
  writer?.release();
  await ai?.service.stop();
}
if (lastStage) stages[lastStage.stage] = (stages[lastStage.stage] || 0) + (Date.now() - lastStage.at) / 1000;

const manifest = result.manifest || {};
const kinds = {};
const keptKinds = {};
const diagnostics = [];
for (const run of runs) {
  for (const row of run.rows) {
    if (row.status !== "kept") continue;
    kinds[`${run.part}:${row.reason}`] = (kinds[`${run.part}:${row.reason}`] || 0) + 1;
    if (row.kind) keptKinds[row.kind] = (keptKinds[row.kind] || 0) + 1;
    if (row.detail) diagnostics.push({ part: run.part, id: row.id, ...row.detail });
  }
}
const ownCalls = runs.flatMap((run) => run.engineCalls || []);
const rejectedTotal = Object.values(keptKinds).reduce((sum, n) => sum + n, 0);

const report = {
  label,
  model: args.model || null,
  status: result.status,
  totalSeconds: +((Date.now() - started) / 1000).toFixed(1),
  stagesSeconds: Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, +v.toFixed(1)])),
  aiWriting: manifest.aiWriting
    ? { parts: manifest.aiWriting.parts, requests: manifest.aiWriting.requests, stoppedEarly: manifest.aiWriting.stoppedEarly, notes: manifest.aiWriting.notes, promptVersion: manifest.aiWriting.promptVersion }
    : null,
  warnings: (result.warnings || result.plan?.warnings || []).filter((w) => /AI|repeat|model/i.test(w)),
  runs: runs.map(({ rows, engineCalls, ...rest }) => rest),
  keptByReason: kinds,
  rejectedByKind: keptKinds,
  rejectedTotal,
  calls,
  engineCalls: ownCalls.length,
  promptsInThisRun: calls.reduce((sum, c) => sum + (c.prompts || 1), 0),
  outputDir: result.outputDir || null,
  quality: manifest.quality ? { score: manifest.quality.score, findings: manifest.quality.findings } : null,
  gate: manifest.gate ? { grade: manifest.gate.grade, gaps: manifest.gate.gaps, polish: manifest.gate.polish } : null,
  ...(diagnose ? { diagnostics } : {}),
  ...(cancelReport ? { cancel: cancelReport } : {}),
};
if (typeof args.report === "string") fs.writeFileSync(path.resolve(args.report), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
