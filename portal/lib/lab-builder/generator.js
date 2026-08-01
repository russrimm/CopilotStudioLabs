/**
 * Lab generator — the orchestrator.
 *
 * plan → ground against Microsoft Learn (MCP) → optional LLM enrichment →
 * compose markdown → write `index.md`, `assets/`, `shots.json`, `manifest.json`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { planLab } from "./planner.js";
import { connect, groundFeature, LEARN_MCP_ENDPOINT } from "./learn-mcp.js";
import { createLlm } from "./llm.js";
import { planScreenshots, copyScreenshots, buildShotsManifest } from "./screenshots.js";
import { composeLab } from "./composer.js";
import { validateLabDir } from "../validator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const LABS_DIR = path.join(REPO_ROOT, "labs");
export const OUTPUT_ROOT = path.join(REPO_ROOT, "generated-labs");

const SYSTEM_PROMPT = [
  "You write hands-on Microsoft Copilot Studio lab content for practitioners.",
  "Rules:",
  "- Be concrete and specific to the stated industry, role, and agent scenario.",
  "- Never invent product UI, menu names, or features. Only describe what the supplied documentation and step list support.",
  "- Explain the reasoning behind a configuration, not just the clicks.",
  "- Plain markdown prose only. No headings, no numbered lists, no code fences.",
  "- Never use the words TODO, FIXME, TBD, or XXX.",
].join("\n");

function reserveUniqueDir(root, slug) {
  for (let n = 1; ; n += 1) {
    const dir = path.join(root, n === 1 ? slug : `${slug}-${n}`);
    try {
      fs.mkdirSync(dir);
      return dir;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
  }
}

function concurrency(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 8 ? parsed : fallback;
}

async function mapLimit(items, limit, fn, signal) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      if (signal?.aborted) throw new DOMException(String(signal.reason || "Operation cancelled"), "AbortError");
      const index = nextIndex++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function enrich(llm, plan, groundingByFeature, { onProgress, signal, maxConcurrency }) {
  const enrichment = { byFeature: new Map() };
  if (!llm.available) return enrichment;

  const roleLine = plan.roles.length ? plan.roles.map((r) => r.name).join(", ") : "a general business audience";
  const context = [
    `Industry: ${plan.industry?.name || "Cross-industry"}`,
    `Audience: ${roleLine}`,
    `Agent: ${plan.profile.agentName} for ${plan.profile.domain}`,
    `Business problem: ${plan.profile.problem}`,
    `Target outcome: ${plan.profile.outcome}`,
  ].join("\n");

  onProgress?.({ stage: "enrich", message: "Drafting scenario narrative" });
  const overview = await llm.complete(
    SYSTEM_PROMPT,
    `${context}\n\nModules in this lab: ${plan.features.map((f) => f.name).join(", ")}.\n\nWrite two short paragraphs introducing this lab. Paragraph one: the business problem in this industry and why an agent helps. Paragraph two: what the learner ends up with and how the modules connect. Do not list the modules verbatim.`,
    { maxTokens: 500, signal },
  );
  if (overview) enrichment.overview = overview;

  const appliedByFeature = await mapLimit(plan.features, maxConcurrency, async (feature) => {
    onProgress?.({ stage: "enrich", message: `Applying ${feature.name} to the scenario` });
    const grounding = groundingByFeature.get(feature.id);
    const docs = (grounding?.results || [])
      .slice(0, 3)
      .map((r) => `- ${r.title || r.url}: ${r.excerpt.slice(0, 600)}`)
      .join("\n");

    const applied = await llm.complete(
      SYSTEM_PROMPT,
      [
        context,
        "",
        `Module: ${feature.name}`,
        `What it does: ${feature.summary}`,
        `Why it matters: ${feature.whyItMatters}`,
        `Steps the learner performs:\n${feature.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
        docs ? `\nMicrosoft Learn excerpts:\n${docs}` : "",
        "",
        "Write one paragraph (3-5 sentences) telling the learner exactly how to apply this module to the agent scenario above: what to name things, what content or records to use, and what the agent should be able to do afterwards. Use the industry's vocabulary.",
      ].join("\n"),
      { maxTokens: 400, signal },
    );

    return { featureId: feature.id, applied };
  }, signal);
  for (const { featureId, applied } of appliedByFeature) {
    if (applied) enrichment.byFeature.set(featureId, { applied });
  }

  return enrichment;
}

/**
 * Generate a lab.
 *
 * @param {object} request see planner.planLab
 * @param {object} [opts]
 * @param {string} [opts.outputRoot] where to write (default `generated-labs/`)
 * @param {boolean} [opts.write=true] set false for a dry-run preview
 * @param {boolean} [opts.useLearnMcp=true]
 * @param {boolean} [opts.useLlm=true]
 * @param {AbortSignal} [opts.signal]
 * @param {(e:{stage:string,message:string})=>void} [opts.onProgress]
 */
export async function generateLab(request, opts = {}) {
  const {
    outputRoot = OUTPUT_ROOT,
    write = true,
    useLearnMcp = true,
    useLlm = true,
    signal,
    onProgress,
  } = opts;
  const maxConcurrency = concurrency(opts.maxConcurrency || process.env.LAB_BUILDER_CONCURRENCY, 4);

  const startedAt = Date.now();
  const plan = planLab(request);
  onProgress?.({ stage: "plan", message: `Planned ${plan.features.length} modules (${plan.duration})` });

  // 1. Ground every module against Microsoft Learn.
  const groundingByFeature = new Map();
  let session = { ok: false };
  if (useLearnMcp) {
    onProgress?.({ stage: "learn", message: "Connecting to the Microsoft Learn MCP server" });
    session = await (opts.connect || connect)({ signal });
    if (!session.ok) {
      plan.warnings.push(`Microsoft Learn MCP unavailable (${session.error}) — using the curated documentation links instead.`);
    }
  } else {
    plan.warnings.push("Microsoft Learn grounding was skipped — using the curated documentation links instead.");
  }

  const grounding = await mapLimit(plan.features, maxConcurrency, async (feature) => {
    onProgress?.({ stage: "learn", message: `Researching ${feature.name}` });
    return [feature.id, await groundFeature(session, feature)];
  }, signal);
  for (const [featureId, result] of grounding) {
    groundingByFeature.set(featureId, result);
  }
  const groundedFeatures = [...groundingByFeature.values()].filter((g) => g.grounded).length;

  // 2. Optional LLM narrative.
  const llm = useLlm
    ? opts.llm || createLlm()
    : { available: false, failures: [], provider: { kind: "none", reason: "Disabled for this run" } };
  const enrichment = await enrich(llm, plan, groundingByFeature, { onProgress, signal, maxConcurrency });
  if (llm.failures?.length) {
    plan.warnings.push(
      `${llm.failures.length} language model request(s) failed — affected narrative used deterministic catalog content instead.`,
    );
  }

  // 3. Screenshots.
  const screenshots = planScreenshots(plan, { labsDir: LABS_DIR });

  // 4. Compose.
  onProgress?.({ stage: "compose", message: "Composing the lab" });
  const generation = {
    groundedFeatures,
    llmProvider: llm.available ? llm.provider.label : "none",
    generatedAt: new Date().toISOString(),
  };
  const markdown = composeLab(plan, groundingByFeature, screenshots.byFeature, enrichment, generation);

  const manifest = {
    slug: plan.slug,
    title: plan.title,
    generatedAt: generation.generatedAt,
    durationMs: Date.now() - startedAt,
    request: plan.request,
    industry: plan.industry?.id || null,
    roles: plan.roles.map((r) => r.id),
    difficulty: plan.difficulty,
    totalMinutes: plan.totalMinutes,
    modules: plan.features.map((f) => ({
      id: f.id,
      name: f.name,
      order: f.order,
      level: f.level,
      minutes: f.minutes,
      grounded: Boolean(groundingByFeature.get(f.id)?.grounded),
      sources: groundingByFeature.get(f.id)?.sources || [],
    })),
    deferred: plan.deferred,
    grounding: {
      endpoint: LEARN_MCP_ENDPOINT,
      connected: Boolean(session.ok),
      groundedModules: groundedFeatures,
      totalModules: plan.features.length,
    },
    llm: { provider: llm.provider.kind, label: llm.provider.label || null, reason: llm.provider.reason || null },
    screenshots: {
      reused: screenshots.copies.length,
      toCapture: screenshots.shots.length,
    },
    warnings: plan.warnings,
  };

  const result = {
    plan,
    manifest,
    markdown,
    shots: buildShotsManifest(plan, screenshots.shots),
    outputDir: null,
    validation: null,
  };

  if (!write) return result;

  // 5. Write.
  fs.mkdirSync(outputRoot, { recursive: true });
  const outputDir = reserveUniqueDir(outputRoot, plan.slug);
  try {
    copyScreenshots(screenshots.copies, path.join(outputDir, "assets"));
    fs.writeFileSync(path.join(outputDir, "index.md"), markdown, "utf8");
    fs.writeFileSync(path.join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    if (screenshots.shots.length) {
      fs.writeFileSync(path.join(outputDir, "shots.json"), JSON.stringify(result.shots, null, 2) + "\n", "utf8");
    }

    result.outputDir = outputDir;
    result.labId = path.basename(outputDir);

    onProgress?.({ stage: "validate", message: "Validating the generated lab" });
    result.validation = validateLabDir(outputDir, { labId: result.labId, title: plan.title });
    if (result.validation.failed) {
      throw new Error(`Generated lab failed ${result.validation.failed} validation check(s).`);
    }
  } catch (err) {
    fs.rmSync(outputDir, { recursive: true, force: true });
    result.outputDir = null;
    result.labId = null;
    throw err;
  }

  return result;
}
