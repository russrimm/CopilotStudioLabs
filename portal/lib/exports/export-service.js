/**
 * The portal's export pool: every heavy renderer (Word, PowerPoint, PDF, ZIP, the per-topic files) runs in a worker thread.
 * `PORTAL_EXPORT_WORKERS` (default 1: the container has half a CPU, so more workers only add memory),
 * `PORTAL_EXPORT_TIMEOUT_MS` (default 120000), `PORTAL_EXPORT_MAX_QUEUED` (default 200), `PORTAL_EXPORT_WORKER_IDLE_MS`
 * (default 60000: an idle worker stops and gives its memory back), and `PORTAL_EXPORT_WORKER_HEAP_MB` (default 384) tune it;
 * `PORTAL_EXPORT_WORKERS=0` runs everything on the main thread, as the portal did before.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { createWorkerPool } from "../concurrency/worker-pool.js";
import * as exporter from "../exporter.js";
import { readGeneratedLabTopicDocument, resolveGeneratedAsset } from "../lab-builder/generated-labs.js";

function intFromEnv(name, fallback, { min = 0, max = 64 } = {}) {
  const parsed = Number.parseInt(String(process.env[name] ?? ""), 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/** A Buffer again: a structured clone turns one into a plain Uint8Array. */
function asBuffer(value) {
  return value instanceof Uint8Array && !Buffer.isBuffer(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : value;
}

function restoreBuffers(result) {
  if (result && typeof result === "object" && "buffer" in result) result.buffer = asBuffer(result.buffer);
  return result;
}

const inline = {
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
};

/**
 * @param {object} options
 * @param {string} options.generatedRoot the generated-labs folder
 * @param {string} options.tempDir where ZIP builds are staged before they are streamed
 */
export function createExportService({ generatedRoot, tempDir }) {
  const size = intFromEnv("PORTAL_EXPORT_WORKERS", 1);
  const pool =
    size > 0
      ? createWorkerPool({
          file: new URL("./render-worker.js", import.meta.url),
          size,
          timeoutMs: intFromEnv("PORTAL_EXPORT_TIMEOUT_MS", 120000, { min: 1000, max: 3600000 }),
          maxQueued: intFromEnv("PORTAL_EXPORT_MAX_QUEUED", 200, { min: 1, max: 10000 }),
          idleMs: intFromEnv("PORTAL_EXPORT_WORKER_IDLE_MS", 60000, { min: 0, max: 3600000 }),
          resourceLimits: { maxOldGenerationSizeMb: intFromEnv("PORTAL_EXPORT_WORKER_HEAP_MB", 384, { min: 64, max: 4096 }) },
        })
      : null;

  /** Run a named renderer (see render-worker.js) with the same arguments the portal passed before. */
  async function render(name, args) {
    if (!pool) return inline[name](...args.map((a) => (a && a.resolveAsset === true ? { ...a, resolveAsset: resolveGeneratedAsset } : a)));
    return restoreBuffers(await pool.run(name, args));
  }

  /**
   * Build a lab's ZIP in a worker and return the staged file. The caller streams `file` and then calls `remove()`.
   * `options.formats` is the list normalizeDocFormats accepted. `fileName` is the short name the download should carry,
   * and `summary` the exporter's own account of the ZIP (lab folder, entry count, longest entry, path-budget warnings).
   */
  async function buildZip(labId, replacements, options) {
    mkdirSync(tempDir, { recursive: true });
    const file = path.join(tempDir, `export-${randomUUID()}.zip.blob-tmp-export`);
    const remove = () => rmSync(file, { force: true });
    try {
      let summary;
      if (!pool) {
        const { createWriteStream } = await import("node:fs");
        const { once } = await import("node:events");
        const out = createWriteStream(file, { flags: "wx" });
        const done = once(out, "close");
        summary = await exporter.exportGeneratedLab(generatedRoot, labId, replacements, out, { ...options, resolveAsset: resolveGeneratedAsset });
        await done;
      } else {
        summary = await pool.run("exportGeneratedLabToFile", [generatedRoot, labId, replacements, { ...options, resolveAsset: true }, file]);
      }
      return { file, remove, fileName: summary?.zipFileName || null, summary };
    } catch (err) {
      remove();
      throw err;
    }
  }

  return { render, buildZip, snapshot: () => (pool ? pool.snapshot() : { size: 0 }), close: () => pool?.close() };
}
