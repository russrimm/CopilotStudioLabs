/**
 * Per-topic Word (.docx) and PowerPoint (.pptx) document generation, per-lab
 * filename management, rename synchronization, and legacy on-demand synthesis.
 *
 * Stores generated per-topic documents inside `generated-labs/<labId>/topics/`
 * (kept separate from `assets/` so image-only asset hygiene checks remain clean)
 * and records metadata on `manifest.topicDocuments` and `manifest.modules[i]`.
 *
 * Strictly zero external npm dependencies.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveLabScreenshot } from "./captured.js";
import { inspectImageDimensions, renderMarkdownToDocxBuffer } from "./docx-builder.js";
import { renderTopicToPptxBuffer } from "./pptx-builder.js";
import { splitGeneratedLabModules } from "./module-samples.js";

export const ALLOWED_TOPIC_DOC_FORMATS = Object.freeze(["docx", "pptx"]);
// Bump whenever the per-topic .docx/.pptx output changes so cached `topics/` files regenerate on demand.
// 4: PPTX notes master gets its own theme part (PowerPoint rejected decks that shared theme1.xml); DOCX schema order.
// 5: Learner documents no longer carry administrator settings: the Admin Prerequisites, DLP & Guardrails slides
//    are gone and the overview has no admin section.
export const TOPIC_DOCUMENTS_SCHEMA_VERSION = 5;

export const TOPIC_DOC_MIME_TYPES = Object.freeze({
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
});

/**
 * Create a safe image resolver scoped strictly inside `labDir`.
 * Resolves real per-lab captured PNGs (`generated-labs/<labId>/assets/<file>`)
 * first, then shared `docs/feature-tour/screenshots/<file>`, and returns `null`
 * for tiny "Screenshot pending" stubs so DOCX and PPTX fall back to structured
 * figure callouts / wireframes until captured.
 */
export function createLabImageResolver(labDir) {
  if (!labDir) return () => null;
  const resolvedLabRoot = path.resolve(labDir);
  const prefix = resolvedLabRoot.endsWith(path.sep)
    ? resolvedLabRoot
    : resolvedLabRoot + path.sep;

  return (rawSrc) => {
    const cleaned = String(rawSrc || "")
      .trim()
      .split(/[?#]/)[0]
      .replace(/\\/g, "/")
      .replace(/^\.\//, "");
    if (!cleaned || /^https?:\/\//i.test(cleaned) || cleaned.startsWith("/")) {
      return null;
    }
    const candidate = path.resolve(resolvedLabRoot, cleaned);
    if (!candidate.startsWith(prefix)) return null;
    try {
      if (cleaned.startsWith("assets/") && !cleaned.slice("assets/".length).includes("/")) {
        const assetName = cleaned.slice("assets/".length);
        const resolved = resolveLabScreenshot(resolvedLabRoot, assetName);
        if (!resolved?.file || !fs.existsSync(resolved.file)) return null;
        const buf = fs.readFileSync(resolved.file);
        return inspectImageDimensions(buf) ? buf : null;
      }
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
      const buf = fs.readFileSync(candidate);
      return inspectImageDimensions(buf) ? buf : null;
    } catch {
      return null;
    }
  };
}

/**
 * Compute deterministic per-lab topic document descriptors from lab Markdown
 * and manifest without touching the filesystem.
 */
export function buildTopicDocumentsMeta(markdown, manifest = {}, options = {}) {
  const labId = options.labId || manifest?.labId || manifest?.slug || "";
  const outputDir = options.outputDir || "";
  const split = splitGeneratedLabModules(markdown, manifest, { labId, outputDir });
  const manifestModules = Array.isArray(manifest?.modules) ? manifest.modules : [];

  const topicDocuments = split.modules.map((mod) => {
    const matchedMod =
      manifestModules.find((m) => Number(m.order) === Number(mod.order)) || {};
    const docxFileName = `${mod.fileBaseName}.docx`;
    const pptxFileName = `${mod.fileBaseName}.pptx`;
    return {
      order: mod.order,
      stepOrder: mod.stepOrder ?? null,
      recapOrder: mod.recapOrder ?? null,
      role: mod.isRecap ? "prerequisite" : matchedMod.role || "level",
      id: mod.id || matchedMod.id || null,
      stepLabel: mod.stepLabel,
      title: mod.title,
      level: matchedMod.level ?? null,
      minutes: matchedMod.minutes ?? null,
      fileBaseName: mod.fileBaseName,
      docxFileName,
      pptxFileName,
      docxPath: `topics/${docxFileName}`,
      pptxPath: `topics/${pptxFileName}`,
    };
  });

  return { split, topicDocuments };
}

/**
 * Attach `topicDocuments` to `manifest` and enrich each `manifest.modules[i]`
 * with its per-lab `fileBaseName`, `docxFileName`, `pptxFileName`, `docxPath`,
 * and `pptxPath`.
 */
export function applyTopicDocumentsToManifest(manifest, topicDocuments) {
  if (!manifest || typeof manifest !== "object") return topicDocuments;
  const docs = Array.isArray(topicDocuments) ? topicDocuments : [];
  manifest.topicDocuments = docs;
  manifest.topicDocumentsVersion = TOPIC_DOCUMENTS_SCHEMA_VERSION;
  if (Array.isArray(manifest.modules)) {
    const byOrder = new Map(docs.map((d) => [Number(d.order), d]));
    manifest.modules = manifest.modules.map((mod, idx) => {
      const doc = byOrder.get(Number(mod.order) || idx + 1);
      if (!doc) return mod;
      return {
        ...mod,
        fileBaseName: doc.fileBaseName,
        docxFileName: doc.docxFileName,
        pptxFileName: doc.pptxFileName,
        docxPath: doc.docxPath,
        pptxPath: doc.pptxPath,
      };
    });
  }
  return docs;
}

/**
 * Render both `.docx` and `.pptx` buffers for a single split module.
 */
export function renderSingleTopicBuffers(mod, { labTitle, manifest = {}, branding, resolveImageBuffer } = {}) {
  const manifestModules = Array.isArray(manifest?.modules) ? manifest.modules : [];
  const matchedMod =
    manifestModules.find((m) => Number(m.order) === Number(mod.order)) || {};
  const productsText = Array.isArray(manifest?.products) ? manifest.products.join(", ") : "";
  const docTitle = `${labTitle} - ${mod.stepLabel} - ${mod.title}`;

  const docxBuffer = renderMarkdownToDocxBuffer(mod.markdown, {
    title: docTitle,
    branding,
    resolveImageBuffer,
  });

  const pptxBuffer = renderTopicToPptxBuffer(mod.markdown, {
    title: docTitle,
    branding,
    resolveImageBuffer,
    topic: {
      featureId: matchedMod.id || mod.id || null,
      labTitle,
      stepLabel: mod.stepLabel,
      topicTitle: mod.title,
      levelText: matchedMod.level ? `Level ${matchedMod.level}` : "",
      estimatedTime: matchedMod.minutes ? `~${matchedMod.minutes} min` : "",
      products: productsText,
      agentName: manifest?.options?.agentName || manifest?.request?.agentName || "",
      harness: manifest?.request?.harness || manifest?.differences?.labHarness || null,
      trainingDigest: matchedMod.trainingDigest || null,
      manifest,
    },
  });

  return { docxBuffer, pptxBuffer };
}

/**
 * Generate and write standalone `.docx` and `.pptx` files for every topic in
 * the lab into `<labDir>/topics/`, removing any stale files from previous lab
 * titles, and updating `manifest` in memory.
 */
export function writeGeneratedLabTopicDocuments(labDir, options = {}) {
  const resolvedLabDir = path.resolve(labDir);
  const labId = options.labId || path.basename(resolvedLabDir);
  const markdown =
    options.markdown !== undefined
      ? String(options.markdown)
      : fs.readFileSync(path.join(resolvedLabDir, "index.md"), "utf8");
  const manifest =
    options.manifest ||
    (fs.existsSync(path.join(resolvedLabDir, "manifest.json"))
      ? JSON.parse(fs.readFileSync(path.join(resolvedLabDir, "manifest.json"), "utf8"))
      : {});

  const { split, topicDocuments } = buildTopicDocumentsMeta(markdown, manifest, {
    labId,
    outputDir: resolvedLabDir,
  });

  const topicsDir = path.join(resolvedLabDir, "topics");
  fs.mkdirSync(topicsDir, { recursive: true });

  const resolveImageBuffer =
    typeof options.resolveImageBuffer === "function"
      ? options.resolveImageBuffer
      : createLabImageResolver(resolvedLabDir);

  const expectedFileNames = new Set();
  split.modules.forEach((mod, idx) => {
    const docMeta = topicDocuments[idx];
    const { docxBuffer, pptxBuffer } = renderSingleTopicBuffers(mod, {
      labTitle: split.labTitle,
      manifest,
      branding: options.branding,
      resolveImageBuffer,
    });
    fs.writeFileSync(path.join(topicsDir, docMeta.docxFileName), docxBuffer);
    fs.writeFileSync(path.join(topicsDir, docMeta.pptxFileName), pptxBuffer);
    expectedFileNames.add(docMeta.docxFileName.toLowerCase());
    expectedFileNames.add(docMeta.pptxFileName.toLowerCase());
  });

  // Remove stale `.docx` / `.pptx` files in `topics/` (e.g., after renaming a lab)
  for (const entry of fs.readdirSync(topicsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const lower = entry.name.toLowerCase();
    if ((lower.endsWith(".docx") || lower.endsWith(".pptx")) && !expectedFileNames.has(lower)) {
      fs.rmSync(path.join(topicsDir, entry.name), { force: true });
    }
  }

  applyTopicDocumentsToManifest(manifest, topicDocuments);
  return topicDocuments;
}

/**
 * Ensure `topics/*.docx` and `topics/*.pptx` exist on disk for a generated lab
 * (synthesizing on demand for legacy labs created before `topics/` existed)
 * and return the up-to-date `topicDocuments` array.
 */
export function ensureGeneratedLabTopicDocuments(labDir, options = {}) {
  const resolvedLabDir = path.resolve(labDir);
  const labId = options.labId || path.basename(resolvedLabDir);
  const indexPath = path.join(resolvedLabDir, "index.md");
  const manifestPath = path.join(resolvedLabDir, "manifest.json");

  const markdown =
    options.markdown !== undefined
      ? String(options.markdown)
      : fs.existsSync(indexPath)
        ? fs.readFileSync(indexPath, "utf8")
        : "";
  const manifest =
    options.manifest ||
    (fs.existsSync(manifestPath)
      ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
      : {});

  const { topicDocuments: expectedDocs } = buildTopicDocumentsMeta(markdown, manifest, {
    labId,
    outputDir: resolvedLabDir,
  });

  const allPresentOnDisk =
    expectedDocs.length === 0 ||
    expectedDocs.every((doc) => {
      const docxAbs = path.join(resolvedLabDir, doc.docxPath);
      const pptxAbs = path.join(resolvedLabDir, doc.pptxPath);
      return fs.existsSync(docxAbs) && fs.existsSync(pptxAbs);
    });

  const manifestMatches =
    manifest?.topicDocumentsVersion === TOPIC_DOCUMENTS_SCHEMA_VERSION &&
    Array.isArray(manifest?.topicDocuments) &&
    manifest.topicDocuments.length === expectedDocs.length &&
    manifest.topicDocuments.every(
      (d, idx) =>
        d.docxFileName === expectedDocs[idx].docxFileName &&
        d.pptxFileName === expectedDocs[idx].pptxFileName
    );

  if (allPresentOnDisk && manifestMatches) {
    return manifest.topicDocuments;
  }

  const generated = writeGeneratedLabTopicDocuments(resolvedLabDir, {
    labId,
    markdown,
    manifest,
    branding: options.branding,
  });

  if (fs.existsSync(manifestPath)) {
    try {
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    } catch {
      /* best-effort persistence for read-only legacy directories */
    }
  }

  return generated;
}

/**
 * Build an RFC 5987 / RFC 6266 compliant `Content-Disposition` attachment
 * header value with an ASCII fallback and UTF-8 `filename*` parameter.
 */
export function buildAttachmentContentDisposition(exactFileName) {
  const raw = String(exactFileName || "topic-document").replace(/[\r\n"]/g, "");
  const asciiFallback = raw
    .replace(/[^\x20-\x7E]/g, "-")
    .replace(/[\\";]/g, "-")
    .trim() || "topic-document";
  const encodedUtf8 = encodeURIComponent(raw).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedUtf8}`;
}
