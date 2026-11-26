/**
 * AI writing: the engine that turns blocks into guarded text.
 *
 * A unit is a group of blocks that share a scenario (the writable text of one lab module, or of one deck). The engine looks
 * each block up in the cache, skips what is not worth a model's time (a bold label, a number, two words), packs the rest into
 * requests by size (batching.js), runs them a few at a time, parses and validates the JSON, runs the guard on every block,
 * and returns for each block either the new text or a reason it keeps the standard text. It never throws for a model
 * failure: the worst case is a plain lab.
 *
 * What it does when a call goes wrong, because every prompt counts against someone's allowance:
 *   - a rate limit or a busy service (429, 502, 503): wait (the service's own Retry-After when it gives one, else a growing
 *     pause), try again, and run fewer calls at once until the service recovers;
 *   - a time-out, or an answer that is not the JSON asked for: split the request in half and ask each half, so one slow or
 *     garbled call costs part of a batch, not all of it;
 *   - a passage left out of an answer: ask for just those once more;
 *   - an exhausted allowance, a refused sign-in, or a cancel: stop the run, keep the standard text for the rest.
 * Retries and splits share a budget (three quarters of the planned requests, plus three), so a bad day cannot multiply the
 * prompts a lab uses.
 */

import { AI_PROMPT_VERSION } from "./config.js";
import { blockCacheKey } from "./cache.js";
import { AiError, classifyError, describeFailure, logAi } from "./errors.js";
import { checkList, checkText, rejectionKind } from "./guard.js";
import { buildPrompt, parseAnswer, RESPONSE_SCHEMA, SYSTEM_PROMPT } from "./prompts.js";
import { callTimeoutMs, packRequests, piecesOf, sectionsOf, sizeOf, splitInHalf } from "./batching.js";

const MAX_SPLIT_DEPTH = 3;
const MAX_CALL_RECORDS = 200;

const defaultSleep = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

function emptySummary() {
  return {
    total: 0,
    ai: 0,
    cached: 0,
    kept: 0,
    skipped: 0,
    requests: 0,
    plannedRequests: 0,
    extraRequests: 0,
    splits: 0,
    backoffs: 0,
    timeouts: 0,
    remembered: 0,
    changed: 0,
    unchanged: 0,
    charsIn: 0,
    charsOut: 0,
    maxInflight: 0,
    failed: {},
    rejected: {},
    rejectedKinds: {},
    keptWhy: {},
    tokens: 0,
    tokensIn: 0,
    tokensOut: 0,
    reasoningTokens: 0,
    stopped: false,
    stopKind: null,
    notes: [],
    calls: [],
  };
}

function bump(map, key, by = 1) {
  map[key] = (map[key] || 0) + by;
}

/** True when the same text now appears twice in a list whose sources did not repeat it. */
function gainedDuplicates(sources, items) {
  const seen = new Set();
  const sourceSeen = new Set();
  for (let i = 0; i < items.length; i += 1) {
    const key = items[i].toLowerCase();
    const sourceKey = sources[i].toLowerCase();
    if (seen.has(key) && !sourceSeen.has(sourceKey) && items.length > 1) return true;
    seen.add(key);
    sourceSeen.add(sourceKey);
  }
  return false;
}

/**
 * @param {object} deps
 * @param {{complete: Function}} deps.backend
 * @param {ReturnType<import("./config.js").readAiConfig>} deps.config
 * @param {ReturnType<import("./cache.js").createAiCache>} deps.cache
 * @param {ReturnType<import("./limits.js").createUsageLimiter>} [deps.limiter]
 * @param {ReturnType<import("./limits.js").createCallGate>} [deps.gate]  server-wide ceiling on calls in flight
 * @param {(line: string) => void} [deps.logger]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 */
export function createEngine({ backend, config, cache, limiter = null, gate = null, logger, sleep = defaultSleep }) {
  /**
   * @param {object} run
   * @param {object[]} run.units  { id, context, reference?, blocks: [{id, kind, type, source|sources, ...}] }
   * @param {string} run.model
   * @param {string} run.provider  recorded in cache keys and in the lab's note
   * @param {string} [run.token]  the visitor's own GitHub token (per-user mode); passed to the SDK and nowhere else
   * @param {string} [run.visitor]  the key the visitor's limits are counted under
   * @param {AbortSignal} [run.signal]
   * @param {(p: {done: number, total: number, ai: number, kept: number, requests: number}) => void} [run.onProgress]
   * @param {boolean} [run.diagnostics]  keep the short protected term a guard rejection named, on each result, for tuning
   * @returns {Promise<{results: Map<string, object>, summary: object}>}
   */
  async function run({ units, model, provider, token, visitor, signal, onProgress, reasoningEffort, diagnostics = false }) {
    const summary = emptySummary();
    const results = new Map();
    const started = Date.now();
    const guardOptions = { maxOutputChars: config.maxOutputChars };

    // ── Sort every block: reuse, skip, refuse, or ask ───────────────────────────
    const immediate = [];
    const entries = [];
    let admitted = 0;
    for (const unit of units) {
      const context = JSON.stringify(unit.context || {});
      for (const block of unit.blocks) {
        const pieces = piecesOf(block);
        const { chars, items } = sizeOf(pieces);
        if (!items) {
          immediate.push([block.id, { status: "skipped" }]);
          continue;
        }
        const key = blockCacheKey(block, { model, provider, context });
        const hit = cache.get(key);
        if (hit) {
          immediate.push([block.id, { status: "cached", ...hit }]);
          continue;
        }
        const refused = cache.getReject?.(key);
        if (refused) {
          immediate.push([block.id, { status: "kept", reason: refused, group: "guard", remembered: true }]);
          continue;
        }
        if (admitted >= config.maxBlocksPerLab) {
          immediate.push([block.id, { status: "kept", reason: "lab-limit", group: "limit" }]);
          continue;
        }
        if (visitor && limiter && limiter.blocksLeft(visitor) <= admitted) {
          immediate.push([block.id, { status: "kept", reason: "daily-limit", group: "limit" }]);
          continue;
        }
        admitted += 1;
        entries.push({ unit, block, key, pieces, chars, items });
      }
    }
    summary.total = immediate.filter(([, result]) => result.status !== "skipped").length + entries.length;

    let done = 0;
    const settle = (id, result) => {
      results.set(id, result);
      if (result.status === "skipped") {
        summary.skipped += 1;
        return;
      }
      done += 1;
      if (result.status === "ai") summary.ai += 1;
      else if (result.status === "cached") summary.cached += 1;
      else {
        summary.kept += 1;
        if (result.reason) bump(summary.rejected, result.reason);
        bump(summary.keptWhy, result.group || "model");
        if (result.remembered) summary.remembered += 1;
        if ((result.group === "guard" || result.group === "answer") && result.reason) bump(summary.rejectedKinds, result.kind || rejectionKind(result.reason));
      }
      onProgress?.({ done, total: summary.total, ai: summary.ai + summary.cached, kept: summary.kept, requests: summary.requests });
    };
    for (const [id, result] of immediate) settle(id, result);

    const keepAll = (list, reason, group) => {
      for (const { block } of list) settle(block.id, { status: "kept", reason, group });
    };

    // ── Plan the requests ───────────────────────────────────────────────────────
    const queue = packRequests(entries, { maxChars: config.maxCharsPerRequest, maxBlocks: config.maxBlocksPerRequest });
    summary.plannedRequests = queue.length;
    const extraBudget = Math.ceil(queue.length * 0.75) + 3;
    const spend = (count) => {
      if (summary.extraRequests + count > extraBudget) return false;
      summary.extraRequests += count;
      return true;
    };

    let stopped = false;
    const stopRun = (kind) => {
      if (!stopped) {
        stopped = true;
        summary.stopped = true;
        summary.stopKind = kind;
        summary.notes.push(describeFailure(kind));
      }
    };
    const aborted = signal
      ? new Promise((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", resolve, { once: true });
        })
      : null;
    const wait = (ms) => (aborted ? Promise.race([sleep(ms), aborted]) : sleep(ms));

    let limit = Math.max(1, Math.min(config.maxParallel, queue.length || 1));
    let inflight = 0;
    let streak = 0;

    // ── Judge one block's answers ───────────────────────────────────────────────
    function evaluate(entry, byId) {
      const { block, pieces } = entry;
      const asked = pieces.filter((piece) => piece.ask);
      const answers = [];
      for (const piece of asked) {
        const text = byId.get(piece.id);
        if (typeof text !== "string") return { missing: true };
        answers.push(text);
      }
      let checked;
      let value;
      if (block.type === "list") {
        const sub = { ...block, sources: asked.map((piece) => piece.source) };
        checked = checkList(sub, answers, guardOptions);
        if (checked.ok) {
          let next = 0;
          const items = pieces.map((piece) => (piece.ask ? checked.items[next++] : piece.source));
          if (gainedDuplicates(block.sources, items)) checked = { ok: false, reason: "duplicate-items" };
          else value = { items };
        }
      } else {
        checked = checkText(block, answers[0], guardOptions);
        if (checked.ok) value = { text: checked.text };
      }
      return { checked, value, asked, answers };
    }

    function accept(entry, outcome) {
      const { block, key } = entry;
      const { value, asked } = outcome;
      cache.set(key, value);
      const out = block.type === "list" ? asked.map((piece, i) => outcome.checked.items[i]) : [value.text];
      asked.forEach((piece, i) => {
        summary.charsIn += piece.source.length;
        summary.charsOut += out[i].length;
        if (out[i] === piece.source) summary.unchanged += 1;
        else summary.changed += 1;
      });
      settle(block.id, { status: "ai", ...value });
    }

    function refuse(entry, outcome) {
      const { block, key } = entry;
      const full = outcome.checked.reason;
      const reason = full.split(":")[0] === "structure" ? "structure" : full;
      cache.setReject?.(key, reason);
      settle(block.id, {
        status: "kept",
        reason,
        group: "guard",
        kind: rejectionKind(full),
        ...(diagnostics ? { detail: { reason: full, token: outcome.checked.token ?? null, index: outcome.checked.index ?? null } } : {}),
      });
    }

    function requeue(list, task, changes = {}) {
      queue.unshift({ entries: list, depth: task.depth, attempts: task.attempts, ...changes });
    }

    // ── One request ─────────────────────────────────────────────────────────────
    async function handle(task) {
      const list = task.entries;
      if (stopped || signal?.aborted) {
        if (signal?.aborted) stopRun("aborted");
        keepAll(list, "stopped", "stopped");
        return;
      }
      const { sections, ids } = sectionsOf(list);
      const prompt = buildPrompt({ sections });
      const size = list.reduce((sum, entry) => ({ chars: sum.chars + entry.chars, items: sum.items + entry.items }), { chars: 0, items: 0 });
      const timeoutMs = callTimeoutMs(size, config.timeoutMs);

      let release;
      try {
        release = gate ? await gate.acquire(signal) : () => {};
      } catch {
        stopRun("aborted");
        keepAll(list, "stopped", "stopped");
        return;
      }
      const callStarted = Date.now();
      summary.maxInflight = Math.max(summary.maxInflight, inflight);
      let reply = null;
      let failure = null;
      try {
        reply = await backend.complete({ model, system: SYSTEM_PROMPT, prompt, schema: RESPONSE_SCHEMA, token, signal, timeoutMs, reasoningEffort });
      } catch (err) {
        failure = { ...classifyError(err), prompts: Number.isFinite(err?.prompts) ? err.prompts : 1 };
      } finally {
        release();
      }
      const ms = Date.now() - callStarted;
      const prompts = failure ? failure.prompts : Number.isFinite(reply?.prompts) ? reply.prompts : 1;
      summary.requests += prompts;
      const tokensIn = Number(reply?.usage?.inputTokens) || 0;
      const tokensOut = Number(reply?.usage?.outputTokens) || 0;
      summary.tokensIn += tokensIn;
      summary.tokensOut += tokensOut;
      summary.tokens += tokensIn + tokensOut;
      summary.reasoningTokens += Number(reply?.usage?.reasoningTokens) || 0;
      const record = {
        blocks: list.length,
        items: size.items,
        chars: size.chars,
        ms,
        timeoutMs,
        depth: task.depth,
        attempt: task.attempts,
        outcome: failure ? failure.kind : "ok",
        tokensIn,
        tokensOut,
        reasoning: Number(reply?.usage?.reasoningTokens) || 0,
        apiCalls: Number(reply?.usage?.apiCalls) || 0,
        apiMs: Number(reply?.usage?.apiMs) || 0,
        firstTokenMs: Number(reply?.usage?.firstTokenMs) || 0,
      };
      if (summary.calls.length < MAX_CALL_RECORDS) summary.calls.push(record);
      logAi(logger, { event: "request", model, ...record, inflight, prompts });

      if (visitor && limiter && reply) {
        limiter.addTokens(visitor, tokensIn + tokensOut);
        limiter.addBlocks(visitor, list.length);
        if (limiter.tokensLeft(visitor) <= 0) stopRun("quota");
      }

      if (failure) return onFailure(task, failure);

      streak += 1;
      if (streak >= 3 && limit < config.maxParallel) {
        limit += 1;
        streak = 0;
      }

      const parsed = parseAnswer(reply.text);
      if (!parsed.ok) {
        bump(summary.failed, parsed.reason);
        const halves = splitInHalf(list);
        if (halves && task.depth < MAX_SPLIT_DEPTH && spend(2)) return split(task, halves);
        if (task.attempts < 1 && spend(1)) return requeue(list, task, { attempts: task.attempts + 1 });
        keepAll(list, parsed.reason, "answer");
        return undefined;
      }

      // The answer is keyed by the short ids the model saw; the guard works on the pieces' own ids.
      const byPiece = new Map();
      for (const [local, pieceId] of ids) if (parsed.byId.has(local)) byPiece.set(pieceId, parsed.byId.get(local));
      const missing = [];
      for (const entry of list) {
        const outcome = evaluate(entry, byPiece);
        if (outcome.missing) missing.push(entry);
        else if (outcome.checked.ok) accept(entry, outcome);
        else refuse(entry, outcome);
      }
      if (missing.length) {
        if (!task.leftOut && spend(1)) requeue(missing, task, { attempts: 0, leftOut: true });
        else keepAll(missing, "missing", "answer");
      }
      return undefined;
    }

    function split(task, halves) {
      summary.splits += 1;
      for (const half of [...halves].reverse()) requeue(half, task, { depth: task.depth + 1, attempts: 0 });
    }

    async function onFailure(task, failure) {
      const list = task.entries;
      bump(summary.failed, failure.kind);
      streak = 0;
      if (failure.stop) {
        stopRun(failure.kind);
        keepAll(list, failure.kind === "aborted" ? "stopped" : "model-failed", failure.kind === "aborted" ? "stopped" : failure.kind === "quota" ? "quota" : "model");
        return;
      }
      if (failure.kind === "rate" || failure.kind === "transient") {
        summary.backoffs += 1;
        if (limit > 1) limit -= 1;
        if (task.attempts < config.retries && spend(1)) {
          const growing = config.backoffMs * 2 ** task.attempts;
          const pause = Math.min(60000, failure.retryAfterMs || growing) * (1 + Math.random() * 0.25);
          await wait(pause);
          return requeue(list, task, { attempts: task.attempts + 1 });
        }
        summary.notes.push(describeFailure(failure.kind));
        keepAll(list, "model-failed", "busy");
        return undefined;
      }
      if (failure.kind === "timeout") {
        summary.timeouts += 1;
        const halves = splitInHalf(list);
        if (halves && task.depth < MAX_SPLIT_DEPTH && spend(2)) return split(task, halves);
        if (task.attempts < config.retries && spend(1)) return requeue(list, task, { attempts: task.attempts + 1 });
        summary.notes.push(describeFailure("timeout"));
        keepAll(list, "model-failed", "timeout");
        return undefined;
      }
      summary.notes.push(describeFailure(failure.kind));
      keepAll(list, "model-failed", "model");
      return undefined;
    }

    // ── Run them, a few at a time ───────────────────────────────────────────────
    await new Promise((resolve) => {
      const pump = () => {
        while (inflight < limit && queue.length) {
          const task = queue.shift();
          inflight += 1;
          handle(task)
            .catch((err) => {
              // A bug here must not lose the lab: the block keeps its standard text.
              summary.notes.push(describeFailure("failed"));
              bump(summary.failed, err instanceof AiError ? err.code : "failed");
              keepAll(task.entries.filter(({ block }) => !results.has(block.id)), "model-failed", "model");
            })
            .finally(() => {
              inflight -= 1;
              pump();
            });
        }
        if (!inflight && !queue.length) resolve();
      };
      pump();
    });
    cache.flush();

    summary.seconds = (Date.now() - started) / 1000;
    logAi(logger, {
      event: "run",
      model,
      provider,
      durationMs: Date.now() - started,
      blocks: summary.total,
      ai: summary.ai,
      cached: summary.cached,
      kept: summary.kept,
      skipped: summary.skipped,
      requests: summary.requests,
      splits: summary.splits,
      backoffs: summary.backoffs,
      tokens: summary.tokens,
      outcome: summary.stopped ? summary.stopKind : "done",
    });
    return { results, summary };
  }

  return { run, promptVersion: AI_PROMPT_VERSION };
}

export { AiError };
