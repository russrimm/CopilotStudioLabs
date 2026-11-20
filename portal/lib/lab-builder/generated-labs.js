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
import { buildAdminPrerequisites } from "./admin-prereqs.js";
import { learnerGuideMarkdown } from "./learner-guide.js";
import { capturedImage, capturedScreenshotsDirs } from "./captured.js";
import { renderStandaloneLabHtml } from "./html-lab.js";
import { getLabScreenshotsStatus, repairLabPlaceholders } from "./lab-screenshots.js";
import { summarizeLabLearnDrift } from "./learn-drift-dashboard.js";
import { splitGeneratedLabModules } from "./module-samples.js";
import { isPlaceholder } from "./placeholder-detect.js";
import { altOfTag, loadShotSlots, replacePendingPictures } from "./pending-shot-card.js";
import { tidyMetaTable } from "./meta-table.js";
import { PLACEHOLDER_PATH } from "./slots.js";
import {
  ALLOWED_TOPIC_DOC_FORMATS,
  TOPIC_DOC_MIME_TYPES,
  buildAttachmentContentDisposition,
  createLabImageResolver,
  ensureGeneratedLabTopicDocuments,
  renderSingleTopicBuffers,
  writeGeneratedLabTopicDocuments,
} from "./topic-documents.js";
import { labRequiresSharepointSite, resolveSharepointSite } from "./sharepoint-site.js";

const LAB_ID = /^[a-z0-9-]{1,100}$/i;
export const MAX_TITLE_LENGTH = 160;
export const MAX_NOTES_LENGTH = 1000;
const MAX_SELECTION_ITEMS = 300;
const MAX_SELECTION_TEXT = 120;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|gif|webp)$/i;
const CONTENT_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
// Smaller than this is the "Screenshot pending" placeholder or another stub,
// the same bar tools/screenshot-capture uses to decide a shot is still missing.
// A placeholder picture (a captioned filler) is pending whatever its size.
const MIN_CAPTURED_BYTES = 5 * 1024;
// The lab list checks each lab for placeholder pictures at most this often; opening a lab always checks.
const LIST_REPAIR_INTERVAL_MS = 30_000;

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
export function decorateGeneratedHtml(html, labId, labDir, { capturedDir = capturedScreenshotsDirs() } = {}) {
  const pending = [];
  const slots = loadShotSlots(labDir);
  const isCaptured = (name) => {
    let size = 0;
    try {
      size = statSync(join(labDir, "assets", name)).size;
    } catch {
      /* a missing file is pending too */
    }
    return (size >= MIN_CAPTURED_BYTES && !isPlaceholder(join(labDir, "assets", name))) || Boolean(capturedImage(capturedDir, name));
  };
  // A pending picture becomes a "Screenshot to add" card with what it should show and how to capture it.
  const withCards = replacePendingPictures(tidyMetaTable(html), (tag) => {
    const src = tag.match(/\bsrc="assets\/([^"]+)"/i);
    if (!src || !ASSET_NAME.test(src[1]) || isCaptured(src[1])) return null;
    pending.push(src[1]);
    return { filename: src[1], slot: slots.get(src[1]) || null, alt: altOfTag(tag) };
  });
  const decorated = withCards.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = tag.match(/\bsrc="assets\/([^"]+)"/i);
    if (!src || !ASSET_NAME.test(src[1])) return tag;
    return tag.replace(src[0], `src="/api/lab-builder/generated/${labId}/assets/${src[1]}"`);
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
export function resolveGeneratedAsset(rootDir, rawId, rawName, { capturedDir = capturedScreenshotsDirs() } = {}) {
  const labId = String(rawId ?? "");
  const name = String(rawName ?? "");
  if (!LAB_ID.test(labId) || !ASSET_NAME.test(name) || name.includes("..")) {
    return { status: 400, error: "Invalid asset" };
  }
  const found = locateGeneratedLab(rootDir, labId);
  const type = CONTENT_TYPES[name.split(".").pop().toLowerCase()];
  const assetsDir = resolve(resolve(rootDir), labId, "assets");
  const file = resolve(assetsDir, name);
  const rel = relative(assetsDir, file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return { status: 400, error: "Invalid asset" };
  let size = 0;
  let existsLocal = false;
  try {
    const lst = lstatSync(file);
    if (lst.isSymbolicLink() || !lst.isFile()) return { status: 400, error: "Invalid asset" };
    existsLocal = true;
    size = lst.size;
  } catch {
    /* fall through to the captured image */
  }
  // A placeholder picture is not a capture, whatever its size.
  const placeholder = existsLocal && size >= MIN_CAPTURED_BYTES && isPlaceholder(file);
  if (size >= MIN_CAPTURED_BYTES && !placeholder) return { status: 200, path: file, type };
  const captured = found.status === 200 ? capturedImage(capturedDir, name) : null;
  if (captured) return { status: 200, path: captured.file, type };
  // A filler picture is served as the standard pending image, never as itself.
  if (placeholder) return { status: 200, path: PLACEHOLDER_PATH, type: CONTENT_TYPES.png };
  return existsLocal ? { status: 200, path: file, type } : { status: 404, error: "Asset not found" };
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
  const resolvedSpSite = resolveSharepointSite({
    sharepointSiteName: options.sharepointSiteName ?? request.sharepointSiteName ?? manifest?.sharepointSite?.name,
    sharepointSiteUrl: options.sharepointSiteUrl ?? request.sharepointSiteUrl ?? manifest?.sharepointSite?.url,
  });
  return {
    industry: shortText(request.industry),
    roles: textList(request.roles),
    // A lab saved before products existed is a Copilot Studio lab.
    products: textList(request.products).length ? textList(request.products) : textList(manifest.products).length ? textList(manifest.products) : ["copilot-studio"],
    features,
    excluded: textList(request.excluded),
    moduleOrder: textList(request.moduleOrder),
    excludedSubtopics: textList(request.excludedSubtopics),
    harness: shortText(request.harness) || shortText(manifest.harness),
    level: [100, 200, 300].includes(level) ? level : null,
    differencesFor: Array.isArray(request.differencesFor) ? textList(request.differencesFor) : null,
    targetMinutes: Number.isInteger(request.targetMinutes) && request.targetMinutes > 0 ? request.targetMinutes : null,
    customTitle: typeof options.customTitle === "string" ? options.customTitle.slice(0, MAX_TITLE_LENGTH) : null,
    agentName: typeof options.agentName === "string" ? options.agentName.slice(0, 128) : null,
    sharepointSiteName: resolvedSpSite.name,
    sharepointSiteUrl: resolvedSpSite.url,
    useLearnMcp: options.useLearnMcp !== false,
    useLlm: options.useLlm !== false,
    includeKnowledgeCheck: Boolean(options.includeKnowledgeCheck ?? request.includeKnowledgeCheck ?? false),
    // Re-opening a customized lab pre-selects its brand profile and per-lab overrides in Step 7.
    ...(manifest.customization && typeof manifest.customization === "object" && typeof manifest.customization.profileId === "string"
      ? {
          brandProfileId: manifest.customization.profileId,
          brandOverrides:
            manifest.customization.overrides && typeof manifest.customization.overrides === "object"
              ? { ...manifest.customization.overrides }
              : {},
        }
      : {}),
  };
}

function validationSummary(manifest) {
  const v = manifest.validation;
  if (!v || typeof v !== "object" || !Number.isFinite(v.passed) || !Number.isFinite(v.failed)) return null;
  return { status: v.failed ? "failed" : "passed", passed: v.passed, failed: v.failed, checkedAt: v.checkedAt || null };
}

function summarizeManifest(rootDir, labId, manifest) {
  const request = manifest.request && typeof manifest.request === "object" ? manifest.request : {};
  const options = manifest.options && typeof manifest.options === "object" ? manifest.options : {};
  const selections = selectionsFromManifest(manifest);
  const spSite = resolveSharepointSite({
    sharepointSiteName: options.sharepointSiteName ?? request.sharepointSiteName ?? manifest?.sharepointSite?.name,
    sharepointSiteUrl: options.sharepointSiteUrl ?? request.sharepointSiteUrl ?? manifest?.sharepointSite?.url,
  });
  const requiresSharepointSite =
    typeof manifest.requiresSharepointSite === "boolean"
      ? manifest.requiresSharepointSite
      : labRequiresSharepointSite({
          products: selections?.products ?? textList(manifest.products),
          features: Array.isArray(manifest.modules) ? manifest.modules : selections?.features || [],
        });
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
    requiresSharepointSite,
    sharepointSite: spSite.configured
      ? { name: spSite.name, url: spSite.url, label: spSite.label }
      : null,
    validation: validationSummary(manifest),
    screenshots: manifest.screenshots
      ? {
          total: Number(
            manifest.screenshots.total ??
              Number(manifest.screenshots.reused || 0) + Number(manifest.screenshots.toCapture || 0),
          ),
          captured: Number(manifest.screenshots.captured ?? manifest.screenshots.reused ?? 0),
          pending: Number(manifest.screenshots.pending ?? manifest.screenshots.toCapture ?? 0),
          stale: Number(manifest.screenshots.stale || 0),
          learnSyncStatus: manifest.screenshots.learnSyncStatus || "up-to-date",
        }
      : null,
    learnDrift: summarizeLabLearnDrift(rootDir, labId, manifest),
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
        // Counts come from the manifest, so a lab built with placeholder pictures is repaired before it is summarized.
        repairLabPlaceholders(join(rootDir, entry.name), { labId: entry.name, maxAgeMs: LIST_REPAIR_INTERVAL_MS });
        return summarizeManifest(rootDir, entry.name, JSON.parse(readFileSync(manifestPath, "utf-8")));
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
      let activeMarkdown = "";
      if (existsSync(indexPath)) {
        const currentMd = readFileSync(indexPath, "utf-8");
        const lines = currentMd.split("\n");
        const h1 = lines.slice(0, 5).findIndex((line) => /^# /.test(line));
        if (h1 >= 0) {
          lines[h1] = `# ${escapeMarkdown(scrubForbidden(patch.title))}`;
          activeMarkdown = lines.join("\n");
          writeFileAtomic(indexPath, activeMarkdown);
          writeFileAtomic(
            join(found.labDir, "index.html"),
            renderStandaloneLabHtml(learnerGuideMarkdown(activeMarkdown), { title: patch.title, labId: found.labId }),
          );
        } else {
          activeMarkdown = currentMd;
        }
      }
      manifest.title = patch.title;
      // "Edit selections" prefills the Review title from here, so a rename survives a rebuild or replacement.
      manifest.options = { ...(manifest.options && typeof manifest.options === "object" ? manifest.options : {}), customTitle: patch.title };
      if (activeMarkdown) {
        writeGeneratedLabTopicDocuments(found.labDir, {
          labId: found.labId,
          markdown: activeMarkdown,
          manifest,
        });
      }
    }
    if (patch.notes !== undefined) manifest.notes = patch.notes;
    manifest.updatedAt = new Date().toISOString();
    writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    return {
      status: 200,
      body: {
        lab: summarizeManifest(rootDir, found.labId, manifest),
        topicDocuments: manifest.topicDocuments || [],
      },
    };
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
export function readGeneratedLab(rootDir, rawId, renderMarkdown = (md) => String(md ?? "")) {
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
    // A lab built while placeholder pictures counted as captures repairs itself before anything is rendered from it.
    repairLabPlaceholders(labDir, { labId });
    const markdown = learnerGuideMarkdown(readFileSync(indexPath, "utf-8"));
    const manifestPath = join(labDir, "manifest.json");
    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf-8")) : null;
    const topicDocuments = ensureGeneratedLabTopicDocuments(labDir, {
      labId,
      markdown,
      manifest: manifest || { title: labId },
    });
    const adminPrerequisites = manifest?.adminPrerequisites || buildAdminPrerequisites({ manifest, markdown });
    const summary = manifest ? summarizeManifest(rootDir, labId, manifest) : null;
    const { html, pending } = decorateGeneratedHtml(renderMarkdown(markdown), labId, labDir);
    const screenshotStatus = getLabScreenshotsStatus(rootDir, labId);
    return {
      status: 200,
      body: {
        labId,
        markdown,
        html,
        manifest,
        selections: summary?.selections || null,
        adminPrerequisites,
        requiresSharepointSite: Boolean(summary?.requiresSharepointSite),
        sharepointSite: summary?.sharepointSite || null,
        topicDocuments,
        pendingScreenshots: pending,
        screenshotState: screenshotStatus.status === 200 ? screenshotStatus.body : null,
      },
    };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

/**
 * Resolve and read (or synthesize on demand for legacy labs) a single topic's
 * Word (`.docx`) or PowerPoint (`.pptx`) document named per lab.
 *
 * @returns {{status: number, body?: object, labId?: string, topic?: object, fileName?: string, contentType?: string, contentDisposition?: string, buffer?: Buffer}}
 */
export function readGeneratedLabTopicDocument(rootDir, rawId, rawOrder, rawFormat, options = {}) {
  const format = String(rawFormat || "")
    .trim()
    .toLowerCase()
    .replace(/^\./, "");
  if (!ALLOWED_TOPIC_DOC_FORMATS.includes(format)) {
    return {
      status: 400,
      body: { error: "Unsupported topic document format. Use 'docx' or 'pptx'." },
    };
  }

  const orderStr = String(rawOrder ?? "").trim();
  if (!/^\d+$/.test(orderStr) || Number.parseInt(orderStr, 10) < 1) {
    return {
      status: 400,
      body: { error: "Topic order must be a positive integer." },
    };
  }
  const order = Number.parseInt(orderStr, 10);

  const labId = String(rawId || "");
  if (!LAB_ID.test(labId)) {
    return { status: 400, body: { error: "Invalid lab id" } };
  }

  const root = resolve(rootDir);
  const labDir = resolve(root, labId);
  const rel = relative(root, labDir);
  const indexPath = join(labDir, "index.md");
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel !== labId || !existsSync(indexPath)) {
    return { status: 404, body: { error: "Generated lab not found" } };
  }
  try {
    const stat = lstatSync(labDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { status: 404, body: { error: "Generated lab not found" } };
    }
  } catch {
    return { status: 404, body: { error: "Generated lab not found" } };
  }

  try {
    repairLabPlaceholders(labDir, { labId });
    const markdown = readFileSync(indexPath, "utf-8");
    const manifestPath = join(labDir, "manifest.json");
    const manifest = existsSync(manifestPath)
      ? JSON.parse(readFileSync(manifestPath, "utf-8"))
      : { title: labId };

    const topicDocuments = ensureGeneratedLabTopicDocuments(labDir, {
      labId,
      markdown,
      manifest,
    });

    const doc = topicDocuments.find((item) => Number(item.order) === order);
    if (!doc) {
      return { status: 404, body: { error: `Topic ${order} not found in generated lab.` } };
    }

    const fileName = format === "docx" ? doc.docxFileName : doc.pptxFileName;
    const relDocPath = format === "docx" ? doc.docxPath : doc.pptxPath;
    let buffer;

    if (options.branding && options.customBranding) {
      const split = splitGeneratedLabModules(markdown, manifest, { labId, outputDir: labDir });
      const mod = split.modules.find((m) => Number(m.order) === order);
      if (mod) {
        const rendered = renderSingleTopicBuffers(mod, {
          labTitle: split.labTitle,
          manifest,
          branding: options.branding,
          resolveImageBuffer: createLabImageResolver(labDir),
        });
        buffer = format === "docx" ? rendered.docxBuffer : rendered.pptxBuffer;
      }
    }

    if (!buffer) {
      const absDocPath = resolve(labDir, relDocPath);
      const docRel = relative(labDir, absDocPath);
      if (!docRel || docRel.startsWith("..") || isAbsolute(docRel) || !existsSync(absDocPath)) {
        return { status: 404, body: { error: "Topic document file not found." } };
      }
      buffer = readFileSync(absDocPath);
    }

    return {
      status: 200,
      labId,
      topic: doc,
      fileName,
      contentType: TOPIC_DOC_MIME_TYPES[format],
      contentDisposition: buildAttachmentContentDisposition(fileName),
      buffer,
    };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}
