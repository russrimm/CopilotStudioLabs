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

import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { escapeMarkdown, scrubForbidden } from "./composer.js";
import { capturedImage, capturedScreenshotsDir } from "./captured.js";

const LAB_ID = /^[a-z0-9-]{1,100}$/i;
export const MAX_TITLE_LENGTH = 160;
export const MAX_NOTES_LENGTH = 1000;
const MAX_SELECTION_ITEMS = 300;
const MAX_SELECTION_TEXT = 120;
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
 * the lab is read. A slot still holding the placeholder counts as captured when
 * the feature tour has a real screenshot under the same name, and the asset route
 * serves that image. The note is visible text, not color, so it reaches everyone.
 *
 * @returns {{html: string, pending: string[]}}
 */
export function decorateGeneratedHtml(html, labId, labDir, { capturedDir = capturedScreenshotsDir() } = {}) {
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
    if (size >= MIN_CAPTURED_BYTES || capturedImage(capturedDir, name)) return next;
    pending.push(name);
    return `${next}<br><strong class="shot-pending">Screenshot pending.</strong> The image will appear here once it is captured.`;
  });
  return { html: decorated, pending };
}

/**
 * Resolve one image inside a generated lab's assets folder. When the lab still
 * holds a placeholder (or no file) for it, a captured feature tour screenshot
 * with the same name is served instead.
 *
 * @returns {{status: number, path?: string, type?: string, error?: string}}
 */
export function resolveGeneratedAsset(rootDir, rawId, rawName, { capturedDir = capturedScreenshotsDir() } = {}) {
  const labId = String(rawId);
  const name = String(rawName);
  if (!LAB_ID.test(labId) || !ASSET_NAME.test(name)) return { status: 400, error: "Invalid asset" };
  const type = CONTENT_TYPES[name.split(".").pop().toLowerCase()];
  const assetsDir = resolve(resolve(rootDir), labId, "assets");
  const file = resolve(assetsDir, name);
  const rel = relative(assetsDir, file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return { status: 404, error: "Asset not found" };
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    /* fall through to the captured image */
  }
  if (size >= MIN_CAPTURED_BYTES) return { status: 200, path: file, type };
  const captured = existsSync(join(resolve(rootDir), labId, "manifest.json")) ? capturedImage(capturedDir, name) : null;
  if (captured) return { status: 200, path: captured.file, type };
  return existsSync(file) ? { status: 200, path: file, type } : { status: 404, error: "Asset not found" };
}

function textList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string" && item && item.length <= MAX_SELECTION_TEXT)
    .slice(0, MAX_SELECTION_ITEMS);
}

function shortText(value) {
  return typeof value === "string" && value.length <= MAX_SELECTION_TEXT ? value : null;
}

/**
 * What the wizard needs to re-open a lab pre-filled, or null for a lab whose
 * manifest does not record its inputs (generated before they were kept).
 */
export function selectionsFromManifest(manifest) {
  const request = manifest?.request;
  if (!request || typeof request !== "object" || !Array.isArray(request.features)) return null;
  const features = textList(request.features);
  if (!features.length) return null;
  const options = manifest.options && typeof manifest.options === "object" ? manifest.options : {};
  const level = Number(request.level ?? manifest.level);
  return {
    industry: shortText(request.industry),
    roles: textList(request.roles),
    // A lab saved before products existed is a Copilot Studio lab.
    products: textList(request.products).length ? textList(request.products) : textList(manifest.products).length ? textList(manifest.products) : ["copilot-studio"],
    features,
    excluded: textList(request.excluded),
    harness: shortText(request.harness) || shortText(manifest.harness),
    level: [100, 200, 300].includes(level) ? level : null,
    differencesFor: Array.isArray(request.differencesFor) ? textList(request.differencesFor) : null,
    targetMinutes: Number.isInteger(request.targetMinutes) && request.targetMinutes > 0 ? request.targetMinutes : null,
    customTitle: typeof options.customTitle === "string" ? options.customTitle.slice(0, MAX_TITLE_LENGTH) : null,
    agentName: typeof options.agentName === "string" ? options.agentName.slice(0, 128) : null,
    useLearnMcp: options.useLearnMcp !== false,
    useLlm: options.useLlm !== false,
  };
}

function validationSummary(manifest) {
  const v = manifest.validation;
  if (!v || typeof v !== "object" || !Number.isFinite(v.passed) || !Number.isFinite(v.failed)) return null;
  return { status: v.failed ? "failed" : "passed", passed: v.passed, failed: v.failed, checkedAt: v.checkedAt || null };
}

function summarizeManifest(labId, manifest) {
  const request = manifest.request && typeof manifest.request === "object" ? manifest.request : {};
  const selections = selectionsFromManifest(manifest);
  return {
    labId,
    title: manifest.title,
    notes: typeof manifest.notes === "string" ? manifest.notes : "",
    difficulty: manifest.difficulty,
    totalMinutes: manifest.totalMinutes,
    generatedAt: manifest.generatedAt,
    updatedAt: manifest.updatedAt || null,
    moduleCount: manifest.modules?.length || 0,
    prerequisiteCount: Array.isArray(manifest.prerequisites) ? manifest.prerequisites.length : 0,
    vertical: manifest.industry || request.industry || null,
    level: selections?.level ?? null,
    products: selections?.products ?? textList(manifest.products),
    product: shortText(manifest.product) || selections?.products?.[0] || "copilot-studio",
    harness: selections?.harness ?? null,
    validation: validationSummary(manifest),
    selections,
  };
}

/** @returns {{labs: Array}} previously generated labs, newest first */
export function listGeneratedLabs(rootDir) {
  if (!existsSync(rootDir)) return { labs: [] };

  const labs = readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && LAB_ID.test(entry.name))
    .map((entry) => {
      const manifestPath = join(rootDir, entry.name, "manifest.json");
      if (!existsSync(manifestPath)) return null;
      try {
        return summarizeManifest(entry.name, JSON.parse(readFileSync(manifestPath, "utf-8")));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));

  return { labs };
}

/**
 * Resolve a generated lab's folder. Only a real, non-symlinked directory that
 * sits directly inside `rootDir` and holds a manifest counts as a generated lab,
 * so nothing outside that library can be reached through an id.
 *
 * @returns {{status: number, error?: string, labId?: string, labDir?: string}}
 */
function locateGeneratedLab(rootDir, rawId) {
  if (typeof rawId !== "string" || !LAB_ID.test(rawId)) return { status: 400, error: "Invalid lab id" };
  const root = resolve(rootDir);
  const labDir = resolve(root, rawId);
  const rel = relative(root, labDir);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel !== rawId) return { status: 400, error: "Invalid lab id" };
  try {
    const stat = lstatSync(labDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { status: 404, error: "Generated lab not found" };
  } catch {
    return { status: 404, error: "Generated lab not found" };
  }
  if (!existsSync(join(labDir, "manifest.json"))) return { status: 404, error: "Generated lab not found" };
  return { status: 200, labId: rawId, labDir };
}

/** @returns {boolean} whether `rawId` names an existing generated lab */
export function generatedLabExists(rootDir, rawId) {
  return locateGeneratedLab(rootDir, rawId).status === 200;
}

/**
 * Delete one generated lab. Hand-written labs live elsewhere and are never reachable here.
 *
 * @returns {{status: number, body: object}}
 */
export function deleteGeneratedLab(rootDir, rawId) {
  const found = locateGeneratedLab(rootDir, rawId);
  if (found.status !== 200) return { status: found.status, body: { error: found.error } };
  try {
    rmSync(found.labDir, { recursive: true, force: true });
  } catch (err) {
    return { status: 500, body: { error: `Could not delete the lab: ${err.message}` } };
  }
  return { status: 200, body: { deleted: true, labId: found.labId } };
}

/**
 * Validate a rename/notes request. Only `title` and `notes` are accepted.
 *
 * @returns {{error?: string, patch?: {title?: string, notes?: string}}}
 */
export function normalizeMetaPatch(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Request body must be a JSON object." };
  const unknown = Object.keys(body).filter((key) => key !== "title" && key !== "notes");
  if (unknown.length) return { error: `Only title and notes can be changed (not ${unknown.join(", ")}).` };
  if (body.title === undefined && body.notes === undefined) return { error: "Send a title, notes, or both." };

  const patch = {};
  if (body.title !== undefined) {
    if (typeof body.title !== "string") return { error: "title must be a string." };
    const title = body.title.trim();
    if (!title) return { error: "The title cannot be empty." };
    if (title.length > MAX_TITLE_LENGTH) return { error: `The title must be at most ${MAX_TITLE_LENGTH} characters.` };
    if (/[\u0000-\u001f\u007f]/.test(title)) return { error: "The title must not contain control characters or line breaks." };
    patch.title = title;
  }
  if (body.notes !== undefined) {
    if (typeof body.notes !== "string") return { error: "notes must be a string." };
    const notes = body.notes.trim();
    if (notes.length > MAX_NOTES_LENGTH) return { error: `Notes must be at most ${MAX_NOTES_LENGTH} characters.` };
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(notes)) return { error: "Notes must not contain control characters." };
    patch.notes = notes;
  }
  return { patch };
}

function writeFileAtomic(file, content) {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, content, "utf-8");
    renameSync(temp, file);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/**
 * Rename a generated lab and/or change its notes. The title lives in the
 * manifest and in the lab's single H1, so both are kept in step.
 *
 * @returns {{status: number, body: object}}
 */
export function updateGeneratedLabMeta(rootDir, rawId, body) {
  const found = locateGeneratedLab(rootDir, rawId);
  if (found.status !== 200) return { status: found.status, body: { error: found.error } };
  const { error, patch } = normalizeMetaPatch(body);
  if (error) return { status: 400, body: { error } };

  try {
    const manifestPath = join(found.labDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

    if (patch.title !== undefined) {
      const indexPath = join(found.labDir, "index.md");
      if (existsSync(indexPath)) {
        const lines = readFileSync(indexPath, "utf-8").split("\n");
        const h1 = lines.slice(0, 5).findIndex((line) => /^# /.test(line));
        if (h1 >= 0) {
          lines[h1] = `# ${escapeMarkdown(scrubForbidden(patch.title))}`;
          writeFileAtomic(indexPath, lines.join("\n"));
        }
      }
      manifest.title = patch.title;
      // "Edit selections" prefills the Review title from here, so a rename survives a rebuild or replacement.
      manifest.options = { ...(manifest.options && typeof manifest.options === "object" ? manifest.options : {}), customTitle: patch.title };
    }
    if (patch.notes !== undefined) manifest.notes = patch.notes;
    manifest.updatedAt = new Date().toISOString();
    writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    return { status: 200, body: { lab: summarizeManifest(found.labId, manifest) } };
  } catch (err) {
    return { status: 500, body: { error: `Could not update the lab: ${err.message}` } };
  }
}

/**
 * After a replacement lab was built, carry the old lab's notes across and
 * remove the old one. The old lab is only touched once the new one exists.
 */
export function replaceGeneratedLab(rootDir, oldId, newId) {
  const old = locateGeneratedLab(rootDir, oldId);
  if (old.status !== 200 || oldId === newId) return { replaced: false };
  try {
    const oldManifest = JSON.parse(readFileSync(join(old.labDir, "manifest.json"), "utf-8"));
    if (typeof oldManifest.notes === "string" && oldManifest.notes) {
      updateGeneratedLabMeta(rootDir, newId, { notes: oldManifest.notes });
    }
  } catch {
    /* notes are a convenience; replacement still proceeds */
  }
  return { replaced: deleteGeneratedLab(rootDir, oldId).status === 200 };
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
