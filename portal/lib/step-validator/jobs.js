/**
 * In-memory job store for portal step validation runs.
 *
 * A full run takes minutes (it makes real Microsoft Learn calls), so the portal
 * starts a job and polls it, the same model the provisioning flow uses. Only one
 * run is active at a time: the Learn MCP is a shared, rate-limited service and
 * parallel runs would only slow each other down.
 */

import { randomUUID } from "node:crypto";

const TERMINAL = new Set(["done", "failed", "canceled"]);

export class JobConflictError extends Error {
  constructor(activeId) {
    super("A step validation run is already in progress.");
    this.name = "JobConflictError";
    this.activeId = activeId;
  }
}

export function createJobStore({ ttlMs = 60 * 60 * 1000, maxJobs = 10, now = Date.now, newId = randomUUID } = {}) {
  const jobs = new Map();

  function prune() {
    for (const [id, job] of jobs) {
      if (TERMINAL.has(job.status) && now() - job.finishedAt > ttlMs) jobs.delete(id);
    }
    while (jobs.size > maxJobs) {
      const oldest = [...jobs.values()].filter((j) => TERMINAL.has(j.status)).sort((a, b) => a.finishedAt - b.finishedAt)[0];
      if (!oldest) break;
      jobs.delete(oldest.id);
    }
  }

  const active = () => [...jobs.values()].find((job) => !TERMINAL.has(job.status)) || null;

  /** Apply one runner progress event to a job. */
  function applyEvent(job, event) {
    job.updatedAt = now();
    switch (event.type) {
      case "lab-start":
        job.progress.labIndex = event.labIndex;
        job.progress.stepTotal = event.stepTotal;
        job.progress.stepsDone = 0;
        job.progress.labId = event.labId;
        job.progress.labTitle = event.title;
        job.progress.stepId = null;
        job.progress.stepTitle = null;
        job.progress.message = event.message || "";
        job.currentLab = { labId: event.labId, title: event.title, steps: [] };
        break;
      case "step-start":
        job.progress.stepIndex = event.stepIndex;
        job.progress.stepId = event.stepId;
        job.progress.stepTitle = event.stepTitle;
        job.progress.message = event.message || "";
        break;
      case "progress":
        job.progress.message = event.message || "";
        break;
      case "step-done":
        job.progress.stepsDone = event.stepIndex;
        job.progress.message = "";
        job.currentLab?.steps.push(event.step);
        break;
      case "lab-done":
        job.progress.labsDone += 1;
        job.completedLabs.push(event.lab);
        job.currentLab = null;
        break;
      default:
        break;
    }
  }

  /**
   * Start a job.
   * @param {{labTotal:number, run:(ctx:{onProgress:Function, signal:AbortSignal})=>Promise<object>}} options
   */
  function start({ labTotal, run }) {
    prune();
    const running = active();
    if (running) throw new JobConflictError(running.id);

    const controller = new AbortController();
    const job = {
      id: newId(),
      status: "running",
      createdAt: now(),
      updatedAt: now(),
      finishedAt: null,
      controller,
      progress: { labTotal, labsDone: 0, labIndex: 0, labId: null, labTitle: null, stepIndex: 0, stepTotal: 0, stepsDone: 0, stepId: null, stepTitle: null, message: "Starting" },
      completedLabs: [],
      currentLab: null,
      report: null,
      error: null,
    };
    jobs.set(job.id, job);

    void (async () => {
      try {
        const report = await run({ onProgress: (event) => applyEvent(job, event), signal: controller.signal });
        job.report = report;
        job.status = report.canceled ? "canceled" : "done";
      } catch (err) {
        job.status = controller.signal.aborted ? "canceled" : "failed";
        job.error = controller.signal.aborted ? null : err?.message || String(err);
      } finally {
        job.finishedAt = now();
        job.updatedAt = job.finishedAt;
        job.progress.message = "";
      }
    })();
    return job;
  }

  function snapshot(job, { includeLabs = true } = {}) {
    if (!job) return null;
    const body = {
      jobId: job.id,
      status: job.status,
      createdAt: new Date(job.createdAt).toISOString(),
      updatedAt: new Date(job.updatedAt).toISOString(),
      progress: { ...job.progress },
      error: job.error,
    };
    if (includeLabs) {
      body.completedLabs = job.report ? job.report.labs : job.completedLabs;
      body.currentLab = job.currentLab ? { ...job.currentLab, steps: [...job.currentLab.steps] } : null;
      body.report = job.report ? { ...job.report, labs: undefined } : null;
    }
    return body;
  }

  return {
    start,
    get: (id) => jobs.get(id) || null,
    active,
    snapshot,
    cancel(id) {
      const job = jobs.get(id);
      if (!job || TERMINAL.has(job.status)) return false;
      job.controller.abort();
      return true;
    },
  };
}
