/**
 * A bounded, fair queue for heavy work (building a lab), so many people can ask at once and nobody sees a failure:
 * at most `concurrency` builds run, the rest wait in the order they asked, and each person may hold at most
 * `maxPerOwner` places (running plus waiting).
 *
 * `enter()` resolves with a `release()` when it is that request's turn. Aborting the signal while waiting leaves the
 * line. A request that waits longer than `waitTimeoutMs` is turned away with a plain message. `status(ticket)` tells the
 * page where it stands, without naming anybody.
 */

export class BuildQueueError extends Error {
  constructor(code, message, status = 429, retryAfterSec = 10) {
    super(message);
    this.name = "BuildQueueError";
    this.code = code;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

const TICKET_RE = /^[A-Za-z0-9_-]{8,64}$/;
const FINISHED_KEEP_MS = 30000;

export function isTicket(value) {
  return typeof value === "string" && TICKET_RE.test(value);
}

/**
 * @param {object} [options]
 * @param {number} [options.concurrency] builds that run at once
 * @param {number} [options.maxPerOwner] places one person may hold (running plus waiting)
 * @param {number} [options.maxWaiting] people allowed to wait in all
 * @param {number} [options.waitTimeoutMs] longest a request waits for its turn
 * @param {() => number} [options.now] clock, injectable for tests
 */
export function createBuildQueue({ concurrency = 2, maxPerOwner = 2, maxWaiting = 50, waitTimeoutMs = 10 * 60000, now = Date.now } = {}) {
  const running = new Map();
  const waiting = [];
  const finished = new Map();
  let counter = 0;

  const holds = (owner) => [...running.values()].filter((e) => e.owner === owner).length + waiting.filter((e) => e.owner === owner).length;

  function forgetFinished() {
    const cutoff = now() - FINISHED_KEEP_MS;
    for (const [ticket, at] of finished) if (at < cutoff) finished.delete(ticket);
  }

  function pump() {
    while (running.size < concurrency && waiting.length) {
      const entry = waiting.shift();
      clearTimeout(entry.timer);
      entry.signal?.removeEventListener("abort", entry.onAbort);
      entry.state = "running";
      entry.startedAt = now();
      running.set(entry.ticket, entry);
      entry.resolve({
        ticket: entry.ticket,
        waitedMs: entry.startedAt - entry.queuedAt,
        release: () => release(entry.ticket),
      });
    }
  }

  function release(ticket) {
    if (!running.delete(ticket)) return;
    finished.set(ticket, now());
    forgetFinished();
    pump();
  }

  function leave(entry, error) {
    const index = waiting.indexOf(entry);
    if (index === -1) return;
    waiting.splice(index, 1);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener("abort", entry.onAbort);
    finished.set(entry.ticket, now());
    entry.reject(error);
  }

  /**
   * Ask for a turn. Rejects at once with a BuildQueueError when the person already holds their share of places or the
   * line is full; otherwise resolves when it is this request's turn.
   */
  function enter({ owner, ticket, signal } = {}) {
    const id = isTicket(ticket) ? ticket : `t${(counter += 1)}-${Math.random().toString(36).slice(2, 10)}`;
    if (running.has(id) || waiting.some((e) => e.ticket === id)) {
      return Promise.reject(new BuildQueueError("duplicate-ticket", "This build is already in line.", 409, 1));
    }
    if (signal?.aborted) return Promise.reject(new BuildQueueError("cancelled", "The build was cancelled.", 499, 0));
    const who = String(owner || "anonymous");
    if (holds(who) >= maxPerOwner) {
      return Promise.reject(new BuildQueueError("owner-limit", `You already have ${maxPerOwner} labs building or waiting. Wait for one to finish, then start another.`, 429, 15));
    }
    if (running.size >= concurrency && waiting.length >= maxWaiting) {
      return Promise.reject(new BuildQueueError("queue-full", "Many people are building labs right now. Try again in a few minutes.", 503, 60));
    }
    return new Promise((resolve, reject) => {
      const entry = { ticket: id, owner: who, state: "queued", queuedAt: now(), startedAt: null, resolve, reject, signal, timer: null, onAbort: null };
      entry.onAbort = () => leave(entry, new BuildQueueError("cancelled", "The build was cancelled.", 499, 0));
      signal?.addEventListener("abort", entry.onAbort, { once: true });
      if (waitTimeoutMs > 0) {
        entry.timer = setTimeout(
          () => leave(entry, new BuildQueueError("timeout", "The lab builder stayed busy for too long. Try again in a few minutes.", 503, 60)),
          waitTimeoutMs,
        );
        entry.timer.unref?.();
      }
      waiting.push(entry);
      pump();
    });
  }

  /** Where a ticket stands: `queued` (with `position` from 1), `running`, `finished`, or `unknown`. Counts never name people. */
  function status(ticket) {
    const base = { running: running.size, waiting: waiting.length, concurrency };
    if (running.has(ticket)) return { ...base, state: "running", position: 0, ahead: 0 };
    const index = waiting.findIndex((e) => e.ticket === ticket);
    if (index >= 0) return { ...base, state: "queued", position: index + 1, ahead: index };
    forgetFinished();
    return { ...base, state: finished.has(ticket) ? "finished" : "unknown", position: 0, ahead: 0 };
  }

  const snapshot = () => ({ running: running.size, waiting: waiting.length, concurrency, maxPerOwner, maxWaiting });

  return { enter, release, status, snapshot };
}
