/**
 * Worker-thread entry for the export pool (see concurrency/worker-pool.js). It runs one named, synchronous renderer per
 * message and posts back the plain result, so the main thread never spends its time building Word, PowerPoint, PDF, or ZIP
 * files. Only the names below can be called. The renderers are the same functions the portal used to call directly, so
 * the files they produce are the same.
 */

import { createWriteStream, rmSync } from "node:fs";
import { once } from "node:events";
import { parentPort } from "node:worker_threads";
import * as exporter from "../exporter.js";
import { readGeneratedLabTopicDocument, resolveGeneratedAsset } from "../lab-builder/generated-labs.js";

/** `resolveAsset: true` in an options object stands for the portal's generated-asset resolver, which cannot cross threads. */
function hydrate(arg) {
  if (arg && typeof arg === "object" && !Array.isArray(arg) && !ArrayBuffer.isView(arg) && arg.resolveAsset === true) {
    return { ...arg, resolveAsset: resolveGeneratedAsset };
  }
  return arg;
}

const TASKS = {
  renderGeneratedLabMarkdown: exporter.renderGeneratedLabMarkdown,
  renderGeneratedLabHtml: exporter.renderGeneratedLabHtml,
  renderGeneratedLabDocx: exporter.renderGeneratedLabDocx,
  renderGeneratedLabPptx: exporter.renderGeneratedLabPptx,
  renderGeneratedLabPdf: exporter.renderGeneratedLabPdf,
  renderGeneratedLabFacilitatorMarkdown: exporter.renderGeneratedLabFacilitatorMarkdown,
  renderGeneratedLabFacilitatorHtml: exporter.renderGeneratedLabFacilitatorHtml,
  renderGeneratedLabFacilitatorDocx: exporter.renderGeneratedLabFacilitatorDocx,
  renderGeneratedLabFacilitatorPdf: exporter.renderGeneratedLabFacilitatorPdf,
  renderGeneratedLabAdminGuide: exporter.renderGeneratedLabAdminGuide,
  renderGeneratedLabPrerequisites: exporter.renderGeneratedLabPrerequisites,
  readGeneratedLabTopicDocument,
  /** Build a lab's ZIP into `file` (the main thread streams it to the person and removes it). */
  async exportGeneratedLabToFile(generatedRoot, labId, replacements, options, file) {
    const out = createWriteStream(file, { flags: "wx" });
    try {
      const done = once(out, "close");
      const summary = await exporter.exportGeneratedLab(generatedRoot, labId, replacements, out, hydrate(options));
      await done;
      return summary;
    } catch (err) {
      out.destroy();
      rmSync(file, { force: true });
      throw err;
    }
  },
};

parentPort.on("message", async ({ id, fn, args }) => {
  const task = TASKS[fn];
  if (typeof task !== "function") {
    parentPort.postMessage({ id, error: { message: `Unknown export task: ${String(fn).slice(0, 60)}`, status: 500, code: "unknown-task" } });
    return;
  }
  try {
    const result = await task(...(args || []).map(hydrate));
    parentPort.postMessage({ id, result });
  } catch (err) {
    // A file that vanished mid-render means the lab was deleted or replaced while this was being built.
    const gone = err?.code === "ENOENT" || err?.code === "ENOTDIR";
    parentPort.postMessage({
      id,
      error: gone
        ? { message: "Someone else changed this lab while you were viewing it. Reload to see the latest.", status: 410, code: "lab-changed" }
        : { message: String(err?.message || err), status: err?.status || 500, code: err?.code || "task-error" },
    });
  }
});
