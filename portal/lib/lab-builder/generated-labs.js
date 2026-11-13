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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const LAB_ID = /^[a-z0-9-]+$/i;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|gif|webp)$/i;
const CONTENT_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
// Smaller than this is the "Screenshot pending" placeholder or another stub,
// the same bar tools/screenshot-capture uses to decide a shot is still missing.
const MIN_CAPTURED_BYTES = 5 * 1024;

/**
 * Point a generated lab's images at the asset route and mark pending ones.
 *
 * A lab's Markdown never changes when a screenshot is captured, so whether an
 * image is still a placeholder is decided here from the file on disk each time
 * the lab is read. The note is visible text, not color, so it reaches everyone.
 *
 * @returns {{html: string, pending: string[]}}
 */
export function decorateGeneratedHtml(html, labId, labDir) {
  const pending = [];
  const decorated = String(html).replace(/<img\b[^>]*>/gi, (tag) => {
    const src = tag.match(/\bsrc="assets\/([^"]+)"/i);
    if (!src || !ASSET_NAME.test(src[1])) return tag;
    const name = src[1];
    const next = tag.replace(src[0], `src="/api/lab-builder/generated/${labId}/assets/${name}"`);
    let size = 0;
    try {
      size = statSync(join(labDir, "assets", name)).size;
    } catch {
      /* a missing file is pending too */
    }
    if (size >= MIN_CAPTURED_BYTES) return next;
    pending.push(name);
    return `${next}<br><strong class="shot-pending">Screenshot pending.</strong> The image will appear here once it is captured.`;
  });
  return { html: decorated, pending };
}

/**
 * Resolve one image inside a generated lab's assets folder.
 *
 * @returns {{status: number, path?: string, type?: string, error?: string}}
 */
export function resolveGeneratedAsset(rootDir, rawId, rawName) {
  const labId = String(rawId);
  const name = String(rawName);
  if (!LAB_ID.test(labId) || !ASSET_NAME.test(name)) return { status: 400, error: "Invalid asset" };
  const assetsDir = resolve(resolve(rootDir), labId, "assets");
  const file = resolve(assetsDir, name);
  const rel = relative(assetsDir, file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || !existsSync(file)) return { status: 404, error: "Asset not found" };
  return { status: 200, path: file, type: CONTENT_TYPES[name.split(".").pop().toLowerCase()] };
}

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
    const { html, pending } = decorateGeneratedHtml(renderMarkdown(markdown), labId, labDir);
    return { status: 200, body: { labId, markdown, html, manifest, pendingScreenshots: pending } };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}
