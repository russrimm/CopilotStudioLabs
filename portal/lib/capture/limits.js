/**
 * Two small gates that keep a busy portal from running out of memory or sockets.
 *
 * - The stream gate counts open progress windows (server-sent events), for the whole portal and for each visitor.
 * - The upload gate lets only a few image bodies be read at the same time (each is held in memory); the others wait a
 *   short, bounded while for a free place.
 *
 * Both hand out a release function that is safe to call more than once, so every way a request can end (it finished, the
 * client left, an error, a timeout) can call it without double counting.
 */

export const DEFAULT_SSE_MAX = 100;
export const DEFAULT_SSE_PER_VISITOR_MAX = 6;
export const DEFAULT_UPLOAD_CONCURRENCY = 4;
export const DEFAULT_UPLOAD_WAIT_MS = 20_000;

export function createStreamGate({ max = DEFAULT_SSE_MAX, perVisitorMax = DEFAULT_SSE_PER_VISITOR_MAX } = {}) {
  let open = 0;
  const byVisitor = new Map();

  /** Count one more open stream for `visitor`. Returns a release function, or null when a limit is reached. */
  function tryOpen(visitor) {
    const key = String(visitor || "unknown");
    const mine = byVisitor.get(key) || 0;
    if (open >= max || mine >= perVisitorMax) return null;
    open += 1;
    byVisitor.set(key, mine + 1);
    let released = false;
    return () => {
      if (released) return false;
      released = true;
      open -= 1;
      const left = (byVisitor.get(key) || 1) - 1;
      if (left > 0) byVisitor.set(key, left);
      else byVisitor.delete(key);
      return true;
    };
  }

  const openFor = (visitor) => byVisitor.get(String(visitor || "unknown")) || 0;
  const snapshot = () => ({ open, visitors: byVisitor.size, max, perVisitorMax });
  return { tryOpen, openFor, snapshot };
}

export function createUploadGate({ max = DEFAULT_UPLOAD_CONCURRENCY, waitMs = DEFAULT_UPLOAD_WAIT_MS, maxWaiting = max * 10 } = {}) {
  let active = 0;
  const waiting = [];

  function grant() {
    active += 1;
    let released = false;
    return () => {
      if (released) return false;
      released = true;
      active -= 1;
      next();
      return true;
    };
  }

  function next() {
    while (active < max && waiting.length) {
      const entry = waiting.shift();
      clearTimeout(entry.timer);
      entry.resolve(grant());
    }
  }

  /**
   * Ask for a place. `ready` resolves to a release function, or to null when none became free in time (or too many are
   * already waiting). `cancel()` withdraws a request whose client has left, so it never takes a place afterwards.
   */
  function acquire() {
    if (active < max && waiting.length === 0) return { ready: Promise.resolve(grant()), cancel() {} };
    if (waiting.length >= maxWaiting) return { ready: Promise.resolve(null), cancel() {} };
    let entry;
    const ready = new Promise((resolve) => {
      entry = { resolve, timer: null };
      entry.timer = setTimeout(() => {
        const at = waiting.indexOf(entry);
        if (at >= 0) waiting.splice(at, 1);
        resolve(null);
      }, waitMs);
      entry.timer.unref?.();
      waiting.push(entry);
    });
    const cancel = () => {
      const at = waiting.indexOf(entry);
      if (at < 0) return;
      waiting.splice(at, 1);
      clearTimeout(entry.timer);
      entry.resolve(null);
    };
    return { ready, cancel };
  }

  const snapshot = () => ({ active, waiting: waiting.length, max, waitMs });
  return { acquire, snapshot };
}
