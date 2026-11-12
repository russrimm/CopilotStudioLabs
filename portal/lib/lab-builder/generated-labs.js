/**
 * Read-side helpers for generated labs, kept free of Express so they can be
 * tested directly. The portal's routes call these and only translate the
 * result into an HTTP response.
 *
 * Generated labs are a shared library: any authenticated portal user can list
 * and read every lab. Nothing sensitive is written into a lab (decision makers
 * go to the server log, never the manifest), and the manifest is exportable by
 * design. If per-user privacy is ever required, record an owner at generation
 * time and filter here.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const LAB_ID = /^[a-z0-9-]+$/i;

/** @returns {{labs: Array}} previously generated labs, newest first */
export function listGeneratedLabs(rootDir) {
  if (!existsSync(rootDir)) return { labs: [] };

  const labs = readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const manifestPath = join(rootDir, entry.name, "manifest.json");
      if (!existsSync(manifestPath)) return null;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        return {
          labId: entry.name,
          title: manifest.title,
          difficulty: manifest.difficulty,
          totalMinutes: manifest.totalMinutes,
          generatedAt: manifest.generatedAt,
          moduleCount: manifest.modules?.length || 0,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));

  return { labs };
}

/**
 * Read one generated lab by id.
 *
 * @returns {{status: number, body: object}} an HTTP-shaped result
 */
export function readGeneratedLab(rootDir, rawId, renderMarkdown) {
  const labId = String(rawId);
  if (!LAB_ID.test(labId)) return { status: 400, body: { error: "Invalid lab id" } };

  const root = resolve(rootDir);
  const labDir = resolve(root, labId);
  const rel = relative(root, labDir);
  const indexPath = join(labDir, "index.md");
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || !existsSync(indexPath)) {
    return { status: 404, body: { error: "Generated lab not found" } };
  }

  try {
    const markdown = readFileSync(indexPath, "utf-8");
    const manifestPath = join(labDir, "manifest.json");
    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf-8")) : null;
    return { status: 200, body: { labId, markdown, html: renderMarkdown(markdown), manifest } };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}
