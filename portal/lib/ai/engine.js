/**
 * AI writing: the engine that turns blocks into guarded text.
 *
 * A unit is a group of blocks sent together (the writable text of one lab module, or of one deck). The engine looks each
 * block up in the cache, asks the model for the rest in as few requests as it can (every prompt counts against someone's
 * allowance), parses and validates the JSON, runs the guard on every block, and returns for each block either the new
 * text or a reason it keeps the standard text. It never throws for a model failure: the worst case is a plain lab.
 */

import { AI_PROMPT_VERSION } from "./config.js";
import { blockCacheKey } from "./cache.js";
import { AiError, classifyError, describeFailure, logAi } from "./errors.js";
import { checkList, checkText, protectedTokens } from "./guard.js";
import { buildPrompt, parseAnswer, RESPONSE_SCHEMA, SYSTEM_PROMPT } from "./prompts.js";

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function keepList(block) {
  const lists = { ui: block.ui || [], names: block.names || [] };
  const sources = block.type === "list" ? block.sources : [block.source];
  const keep = new Set();
  for (const source of sources) {
    const tokens = protectedTokens(source, lists);
    for (const group of [tokens.urls, tokens.code, tokens.numbers, tokens.ui, tokens.names]) for (const token of group) keep.add(token);
  }
  return [...keep];
}

function emptySummary() {
  return { total: 0, ai: 0, cached: 0, kept: 0, requests: 0, failed: {}, rejected: {}, tokens: 0, stopped: false, stopKind: null, notes: [] };
}

function bump(map, key) {
  map[key] = (map[key] || 0) + 1;
}

/**
 * @param {object} deps
 * @param {{complete: Function}} deps.backend
 * @param {ReturnType<import("./config.js").readAiConfig>} deps.config
 * @param {ReturnType<import("./cache.js").createAiCache>} deps.cache
 * @param {ReturnType<import("./limits.js").createUsageLimiter>} [deps.limiter]
 * @param {(line: string) => void} [deps.logger]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 */
export function createEngine({ backend, config, cache, limiter = null, logger, sleep = defaultSleep }) {
  /**
   * @param {object} run
   * @param {object[]} run.units  { id, context, reference?, blocks: [{id, kind, type, source|sources, ...}] }
   * @param {string} run.model
   * @param {string} run.provider  recorded in cache keys and in the lab's note
   * @param {string} [run.token]  the visitor's own GitHub token (per-user mode); passed to the SDK and nowhere else
   * @param {string} [run.visitor]  the key the visitor's limits are counted under
   * @param {AbortSignal} [run.signal]
   * @param {(p: {done: number, total: number}) => void} [run.onProgress]
   * @returns {Promise<{results: Map<string, object>, summary: object}>}
   */
  async function run({ units, model, provider, token, visitor, signal, onProgress, reasoningEffort }) {
    const summary = emptySummary();
    const results = new Map();
    const started = Date.now();
    const all = units.flatMap((unit) => unit.blocks.map((block) => ({ unit, block })));
    summary.total = all.length;
    let done = 0;
    const settle = (id, result) => {
      results.set(id, result);
      done += 1;
      if (result.status === "ai") summary.ai += 1;
      else if (result.status === "cached") summary.cached += 1;
      else {
        summary.kept += 1;
        if (result.reason) bump(summary.rejected, result.reason);
      }
      onProgress?.({ done, total: summary.total, ai: summary.ai + summary.cached, kept: summary.kept });
    };

    // Work out which blocks need a model, in requests of at most maxBlocksPerRequest blocks of one unit.
    const requests = [];
    let admitted = 0;
    for (const unit of units) {
      const context = JSON.stringify(unit.context || {});
      const pending = [];
      for (const block of unit.blocks) {
        const key = blockCacheKey(block, { model, provider, context });
        const hit = cache.get(key);
        if (hit) {
          settle(block.id, { status: "cached", ...hit });
          continue;
        }
        if (admitted >= config.maxBlocksPerLab) {
          settle(block.id, { status: "kept", reason: "lab-limit" });
          continue;
        }
        if (visitor && limiter && limiter.blocksLeft(visitor) <= admitted) {
          settle(block.id, { status: "kept", reason: "daily-limit" });
          continue;
        }
        admitted += 1;
        pending.push({ block, key });
      }
      for (let i = 0; i < pending.length; i += config.maxBlocksPerRequest) {
        requests.push({ unit, items: pending.slice(i, i + config.maxBlocksPerRequest) });
      }
    }

    let stopped = false;
    const stopRun = (kind) => {
      if (!stopped) {
        stopped = true;
        summary.stopped = true;
        summary.stopKind = kind;
        summary.notes.push(describeFailure(kind));
      }
    };

    async function ask(request) {
      const { unit, items } = request;
      const blocks = items.map(({ block }) => ({ ...block, keep: keepList(block) }));
      const prompt = buildPrompt({ context: unit.context, reference: unit.reference, blocks });
      let attempt = 0;
      for (;;) {
        try {
          summary.requests += 1;
          const reply = await backend.complete({ model, system: SYSTEM_PROMPT, prompt, schema: RESPONSE_SCHEMA, token, signal, timeoutMs: config.timeoutMs, reasoningEffort });
          const tokens = (reply?.usage?.inputTokens || 0) + (reply?.usage?.outputTokens || 0);
          summary.tokens += tokens;
          if (visitor && limiter) {
            limiter.addTokens(visitor, tokens);
            limiter.addBlocks(visitor, items.length);
            if (limiter.tokensLeft(visitor) <= 0) stopRun("quota");
          }
          return String(reply?.text ?? "");
        } catch (err) {
          const info = classifyError(err);
          if (info.transient && attempt < config.retries && !signal?.aborted) {
            attempt += 1;
            await sleep(1000 * attempt);
            continue;
          }
          bump(summary.failed, info.kind);
          if (info.stop) stopRun(info.kind);
          else summary.notes.push(describeFailure(info.kind));
          return null;
        }
      }
    }

    async function handle(request) {
      const { items } = request;
      if (stopped || signal?.aborted) {
        if (signal?.aborted) stopRun("aborted");
        for (const { block } of items) settle(block.id, { status: "kept", reason: "stopped" });
        return;
      }
      const raw = await ask(request);
      if (raw === null) {
        for (const { block } of items) settle(block.id, { status: "kept", reason: "model-failed" });
        return;
      }
      const parsed = parseAnswer(raw);
      if (!parsed.ok) {
        for (const { block } of items) settle(block.id, { status: "kept", reason: parsed.reason });
        return;
      }
      for (const { block, key } of items) {
        const answer = parsed.byId.get(block.id);
        if (!answer) {
          settle(block.id, { status: "kept", reason: "missing" });
          continue;
        }
        const checked =
          block.type === "list"
            ? checkList({ ...block }, answer.items, { maxOutputChars: config.maxOutputChars })
            : checkText(block, answer.text, { maxOutputChars: config.maxOutputChars });
        if (!checked.ok) {
          settle(block.id, { status: "kept", reason: checked.reason.split(":")[0] === "structure" ? "structure" : checked.reason });
          continue;
        }
        const value = block.type === "list" ? { items: checked.items } : { text: checked.text };
        cache.set(key, value);
        settle(block.id, { status: "ai", ...value });
      }
    }

    // A small pool: at most maxParallel requests at once.
    const queue = [...requests];
    const workers = Array.from({ length: Math.min(config.maxParallel, queue.length) }, async () => {
      while (queue.length) await handle(queue.shift());
    });
    await Promise.all(workers);
    cache.flush();

    logAi(logger, {
      event: "run",
      model,
      provider,
      durationMs: Date.now() - started,
      blocks: summary.total,
      ai: summary.ai,
      cached: summary.cached,
      kept: summary.kept,
      requests: summary.requests,
      tokens: summary.tokens,
      outcome: summary.stopped ? summary.stopKind : "done",
    });
    return { results, summary };
  }

  return { run, promptVersion: AI_PROMPT_VERSION };
}

export { AiError };
