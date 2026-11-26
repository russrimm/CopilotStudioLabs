/**
 * AI writing: per-visitor and global limits.
 *
 * Counted in memory, per UTC day, under the visitor key the portal already uses for its own rate limit and build queue
 * (their sign-in, else their browser id, else their address). The key is never logged. A cap on labs per day, on blocks
 * per day, on tokens per day, and a global limit on how many AI labs are written at once.
 */

import { AiError } from "./errors.js";

export function createUsageLimiter({ config, now = Date.now } = {}) {
  /** @type {Map<string, {day: string, labs: number, blocks: number, tokens: number}>} */
  const usage = new Map();
  let active = 0;

  const dayOf = () => new Date(now()).toISOString().slice(0, 10);
  function entry(visitor) {
    const today = dayOf();
    let row = usage.get(visitor);
    if (!row || row.day !== today) {
      row = { day: today, labs: 0, blocks: 0, tokens: 0 };
      usage.set(visitor, row);
      if (usage.size > 5000) usage.delete(usage.keys().next().value);
    }
    return row;
  }

  return {
    /**
     * Take one AI lab for this visitor, or throw. Call release() when the lab is done, whatever happened.
     */
    reserveLab(visitor) {
      const row = entry(visitor);
      if (row.labs >= config.dailyLabsPerVisitor) {
        throw new AiError("daily-limit", `You have used today's ${config.dailyLabsPerVisitor} AI-written labs. Build without AI, or try again tomorrow.`, 429);
      }
      if (row.tokens >= config.dailyTokensPerVisitor || row.blocks >= config.dailyBlocksPerVisitor) {
        throw new AiError("daily-limit", "You have reached today's AI writing allowance on this server. Build without AI, or try again tomorrow.", 429);
      }
      if (active >= config.maxConcurrentLabs) {
        throw new AiError("busy", "AI writing is busy with other labs right now. Try again in a minute, or build without AI.", 429);
      }
      row.labs += 1;
      active += 1;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          active -= 1;
        },
      };
    },
    /** How many more blocks this visitor may have written today. */
    blocksLeft(visitor) {
      return Math.max(0, config.dailyBlocksPerVisitor - entry(visitor).blocks);
    },
    tokensLeft(visitor) {
      return Math.max(0, config.dailyTokensPerVisitor - entry(visitor).tokens);
    },
    addBlocks(visitor, count) {
      entry(visitor).blocks += count;
    },
    addTokens(visitor, count) {
      if (Number.isFinite(count) && count > 0) entry(visitor).tokens += count;
    },
    /** Counts only, for tests and the status line. */
    snapshot(visitor) {
      const row = entry(visitor);
      return { labs: row.labs, blocks: row.blocks, tokens: row.tokens, activeLabs: active };
    },
  };
}
