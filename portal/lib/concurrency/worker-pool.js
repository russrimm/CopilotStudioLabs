/**
 * A small pool of worker threads that run CPU-heavy, synchronous functions (building a Word, PowerPoint, or PDF file, or a
 * whole ZIP) so the main thread keeps answering every other request while they run.
 *
 * Tasks wait in one first-in, first-out line; at most `size` run at once, which also keeps the machine from being
 * saturated by many exports. A task that runs longer than `timeoutMs` is stopped by replacing its worker, and a worker that
 * crashes is replaced, so one bad lab never wedges the pool. Workers start on first use and never keep the process alive.
 */

import { Worker } from "node:worker_threads";

export class WorkerPoolError extends Error {
  constructor(message, status = 500, code = "worker-error") {
    super(message);
    this.name = "WorkerPoolError";
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {object} options
 * @param {URL|string} options.file the worker entry module
 * @param {number} [options.size] workers that run at once
 * @param {number} [options.timeoutMs] longest one task may run
 * @param {number} [options.maxQueued] tasks allowed to wait before new ones are turned away
 * @param {object} [options.workerData] passed to every worker
 */
export function createWorkerPool({ file, size = 1, timeoutMs = 120000, maxQueued = 200, idleMs = 60000, workerData, resourceLimits } = {}) {
  const slots = [];
  const queue = [];
  let nextId = 1;
  let closed = false;
  const stats = { completed: 0, failed: 0, timedOut: 0, restarted: 0, retiredIdle: 0 };

  function spawn() {
    const worker = new Worker(file, { workerData, ...(resourceLimits ? { resourceLimits } : {}) });
    worker.unref();
    const slot = { worker, busy: null, idleTimer: null };
    worker.on("message", (message) => {
      const task = slot.busy;
      if (!task || message?.id !== task.id) return;
      finish(slot, task, message);
    });
    worker.on("error", (err) => crash(slot, err));
    worker.on("exit", (code) => {
      if (slot.busy) crash(slot, new Error(`The export worker stopped unexpectedly (code ${code}).`));
      else replaceSlot(slot);
    });
    return slot;
  }

  function replaceSlot(slot) {
    clearTimeout(slot.idleTimer);
    const index = slots.indexOf(slot);
    if (index === -1 || closed) return;
    slots.splice(index, 1);
  }

  /** A worker that has had nothing to do for a while is stopped, so its memory goes back to the machine. */
  function armIdle(slot) {
    if (!(idleMs > 0)) return;
    clearTimeout(slot.idleTimer);
    slot.idleTimer = setTimeout(() => {
      if (slot.busy || queue.length) return;
      stats.retiredIdle += 1;
      replaceSlot(slot);
      slot.worker.terminate().catch(() => {});
    }, idleMs);
    slot.idleTimer.unref?.();
  }

  function finish(slot, task, message) {
    clearTimeout(task.timer);
    slot.busy = null;
    armIdle(slot);
    if (message.error) {
      stats.failed += 1;
      task.reject(new WorkerPoolError(message.error.message || "The export failed.", message.error.status || 500, message.error.code || "task-error"));
    } else {
      stats.completed += 1;
      task.resolve(message.result);
    }
    pump();
  }

  function crash(slot, err) {
    const task = slot.busy;
    slot.busy = null;
    replaceSlot(slot);
    stats.restarted += 1;
    slot.worker.terminate().catch(() => {});
    if (task) {
      clearTimeout(task.timer);
      stats.failed += 1;
      task.reject(new WorkerPoolError(err?.message || "The export worker failed.", 500, "worker-crashed"));
    }
    pump();
  }

  function idleSlot() {
    let slot = slots.find((s) => !s.busy);
    if (!slot && slots.length < size) {
      slot = spawn();
      slots.push(slot);
    }
    return slot;
  }

  function pump() {
    while (queue.length && !closed) {
      const slot = idleSlot();
      if (!slot) return;
      const task = queue.shift();
      if (task.aborted) continue;
      clearTimeout(slot.idleTimer);
      slot.busy = task;
      task.timer = setTimeout(() => {
        stats.timedOut += 1;
        task.reject(new WorkerPoolError("That export took too long and was stopped. Try again, or export a smaller selection.", 504, "timeout"));
        slot.busy = null;
        replaceSlot(slot);
        slot.worker.terminate().catch(() => {});
        pump();
      }, timeoutMs);
      task.timer.unref?.();
      slot.worker.postMessage({ id: task.id, fn: task.fn, args: task.args });
    }
  }

  /** Run `fn(...args)` in a worker. Arguments and the result are copied (structured clone), so they must be plain data and Buffers. */
  function run(fn, args = []) {
    if (closed) return Promise.reject(new WorkerPoolError("The server is shutting down.", 503, "closed"));
    if (queue.length >= maxQueued) return Promise.reject(new WorkerPoolError("Many exports are running right now. Try again in a minute.", 503, "queue-full"));
    return new Promise((resolve, reject) => {
      const task = { id: nextId++, fn, args, resolve, reject, timer: null, aborted: false };
      queue.push(task);
      pump();
    });
  }

  async function close() {
    closed = true;
    for (const task of queue.splice(0)) task.reject(new WorkerPoolError("The server is shutting down.", 503, "closed"));
    await Promise.all(slots.splice(0).map((slot) => slot.worker.terminate().catch(() => {})));
  }

  const snapshot = () => ({ size, workers: slots.length, busy: slots.filter((s) => s.busy).length, queued: queue.length, ...stats });

  return { run, close, snapshot };
}
