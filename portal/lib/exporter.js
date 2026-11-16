/**
 * Lab export — generates ZIP bundles of selected labs with customized content.
 */

import { readFileSync, readdirSync, existsSync, lstatSync } from "fs";
import { dirname, extname, isAbsolute, join, posix, relative, resolve } from "path";
import { ZipArchive } from "archiver";
import { getLabPath, isValidLabId } from "./labs.js";
import {
   applyBrandingTokens,
  DEFAULT_BRANDING,
  getBrandingLogoAbsolutePath,
  loadBranding,
  prependBrandingBanner,
} from "./branding.js";
import { renderStandaloneLabHtml } from "./lab-builder/html-lab.js";
import { resolveLabScreenshot } from "./lab-builder/captured.js";
import { MIN_CAPTURED_BYTES } from "./lab-builder/slots.js";
import { renderMarkdownToDocxBuffer } from "./lab-builder/docx-builder.js";
import { renderMarkdownToPdfBuffer } from "./lab-builder/pdf-builder.js";
import {
  renderMarkdownToPptxBuffer,
  renderTopicToPptxBuffer,
} from "./lab-builder/pptx-builder.js";
import {
  buildModuleSampleFiles,
  sanitizeFilesystemTitle,
  splitGeneratedLabModules,
} from "./lab-builder/module-samples.js";
import { renderLabMarkdown } from "./markdown.js";

const SAFE_GENERATED_LAB_ID = /^[a-z0-9][a-z0-9-]{0,99}$/i;
const ALLOWED_DOC_FORMATS = ["docx", "pptx", "pdf", "html"];

/**
 * Normalize requested per-module export document formats (`all`, `docx`, `pptx`,
 * `pdf`, `html`, array, or comma-separated list). Throws a 400 error on unknown tokens.
 */
export function normalizeDocFormats(rawFormats) {
  if (rawFormats === undefined || rawFormats === null || rawFormats === "") {
    return [...ALLOWED_DOC_FORMATS];
  }
  const tokens = (Array.isArray(rawFormats) ? rawFormats : String(rawFormats).split(","))
    .map((item) => String(item).trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean);
  if (!tokens.length || tokens.includes("all")) {
    for (const tok of tokens) {
      if (tok !== "all" && !ALLOWED_DOC_FORMATS.includes(tok)) {
        const err = new Error(`Unsupported document format '${tok}'. Allowed values: all, docx, pptx, pdf, html.`);
        err.status = 400;
        throw err;
      }
    }
    return [...ALLOWED_DOC_FORMATS];
  }
  const selected = [];
  for (const tok of tokens) {
    if (!ALLOWED_DOC_FORMATS.includes(tok)) {
      const err = new Error(`Unsupported document format '${tok}'. Allowed values: all, docx, pptx, pdf, html.`);
      err.status = 400;
      throw err;
    }
    if (!selected.includes(tok)) selected.push(tok);
  }
  return ALLOWED_DOC_FORMATS.filter((fmt) => selected.includes(fmt));
}

function resolveLabAssetBuffer(generatedRoot, labId, labDir, rawSrc, resolveAsset) {
  const match = String(rawSrc || "").trim().match(/^(?:\/?assets\/)([A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|gif|webp))$/i);
  const assetName = match ? match[1] : null;
  if (!assetName) return null;
  const localPath = resolve(join(labDir, "assets", assetName));
  if (typeof resolveAsset === "function") {
    const resolved = resolveAsset(generatedRoot, labId, assetName);
    if (resolved?.status === 200 && resolved.path && existsSync(resolved.path)) {
      try {
        const buf = readFileSync(resolved.path);
        const resolvedAbs = resolve(resolved.path);
        if (resolvedAbs !== localPath || buf.length >= MIN_CAPTURED_BYTES) {
          return buf;
        }
      } catch {
        // Fall through to standard per-lab / shared screenshot resolution.
      }
    }
  }
  const captured = resolveLabScreenshot(labDir, assetName);
  if (captured?.file && existsSync(captured.file)) {
    try {
      return readFileSync(captured.file);
    } catch {
      return null;
    }
  }
  return null;
}
const IMAGE_MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

function fileToDataUri(filePath, explicitMime) {
  if (!filePath || !existsSync(filePath)) return null;
  const mime = explicitMime || IMAGE_MIME_BY_EXT[extname(filePath).toLowerCase()];
  if (!mime) return null;
  try {
    const bytes = readFileSync(filePath);
    return `data:${mime};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

export function isCustomBranding(branding = loadBranding()) {
  return Boolean(
    branding.logo ||
    branding.companyName !== DEFAULT_BRANDING.companyName ||
    branding.tagline !== DEFAULT_BRANDING.tagline ||
    branding.primaryColor !== DEFAULT_BRANDING.primaryColor
  );
}

export function resolveSafeGeneratedLabDir(generatedRoot, rawLabId) {
  const labId = String(rawLabId ?? "");
  if (!SAFE_GENERATED_LAB_ID.test(labId)) {
    return { status: 400, error: "Invalid lab id" };
  }

  const root = resolve(generatedRoot);
  const labDir = resolve(root, labId);
  const rel = relative(root, labDir);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || !existsSync(labDir)) {
    return { status: 404, error: "Generated lab not found" };
  }

  let stats;
  try {
    stats = lstatSync(labDir);
  } catch {
    return { status: 404, error: "Generated lab not found" };
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    return { status: 404, error: "Generated lab not found" };
  }

  const indexPath = join(labDir, "index.md");
  const manifestPath = join(labDir, "manifest.json");
  if (!existsSync(indexPath) || !existsSync(manifestPath)) {
    return { status: 404, error: "Generated lab not found" };
  }

  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    manifest = null;
  }

  return { status: 200, labId, labDir, manifest };
}

/**
 * Find all .md files recursively in a directory.
 */
function findMdFiles(dir) {
  const results = [];
  function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) results.push(full);
    }
  }
  walk(dir);
  return results;
}

/**
 * Create a ZIP archive of selected labs.
 *
 * @param {string[]} labIds          - Lab folder names to include
 * @param {Object}   [replacements]  - { search: replace } text substitutions
 * @param {import("stream").Writable} outputStream - Where to pipe the ZIP
 * @returns {Promise<{ bytes: number, labCount: number }>}
 */
export function exportLabs(labIds, replacements = {}, outputStream) {
  if (!Array.isArray(labIds) || labIds.length === 0) {
    throw new Error("At least one lab id is required.");
  }

  const labDirectories = labIds.map((labId) => {
    const labDir = getLabPath(labId);
    if (!isValidLabId(labId) || !labDir || !existsSync(labDir)) {
      throw new Error(`Invalid or unknown lab id: ${labId}`);
    }
    return { labId, labDir };
  });

  return new Promise((resolve, reject) => {
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const branding = loadBranding();
    const logoSourcePath = getBrandingLogoAbsolutePath(branding.logo);
    const logoArchivePath = logoSourcePath
      ? posix.join("_branding", `logo${extname(logoSourcePath).toLowerCase()}`)
      : null;

    archive.on("error", reject);
    archive.on("end", () => resolve({ bytes: archive.pointer(), labCount: labIds.length }));

    archive.pipe(outputStream);

    const replacementEntries = Object.entries(replacements).filter(([k, v]) => k && v && k !== v);

    if (logoSourcePath && existsSync(logoSourcePath) && logoArchivePath) {
      archive.file(logoSourcePath, { name: logoArchivePath });
    }

    for (const { labId, labDir } of labDirectories) {
      archive.directory(labDir, labId, (entry) => {
        return entry.name.endsWith(".md") ? false : entry;
      });

      for (const mdFile of findMdFiles(labDir)) {
        let content = readFileSync(mdFile, "utf-8");
        for (const [search, replace] of replacementEntries) {
          content = content.split(search).join(replace);
        }

        const relativePath = relative(labDir, mdFile).replace(/\\/g, "/");
        const archiveName = posix.join(labId, relativePath);
        const logoRelativePath = logoArchivePath
          ? relative(dirname(archiveName), logoArchivePath).replace(/\\/g, "/")
          : null;

        content = prependBrandingBanner(content, branding, logoRelativePath);
        archive.append(content, { name: archiveName });
      }
    }

    // Add a manifest
    const manifest = {
      exportedAt: new Date().toISOString(),
      labs: labIds,
      customized: replacementEntries.length > 0 || isCustomBranding(branding),
      branding: {
        companyName: branding.companyName,
        logo: logoArchivePath,
        primaryColor: branding.primaryColor,
        tagline: branding.tagline,
      },
    };
    archive.append(JSON.stringify(manifest, null, 2), { name: "export-manifest.json" });

    archive.finalize();
  });
}

/**
 * Render a single generated lab's index.md for direct Markdown download,
 * applying optional replacements and any configured custom branding banner.
 */
export function renderGeneratedLabMarkdown(
  generatedRoot,
  rawLabId,
  replacements = {},
  { branding = loadBranding() } = {},
) {
  const found = resolveSafeGeneratedLabDir(generatedRoot, rawLabId);
  if (found.status !== 200) return { status: found.status, error: found.error };

  const replacementEntries = Object.entries(replacements || {}).filter(([k, v]) => k && v && k !== v);
  let content = readFileSync(join(found.labDir, "index.md"), "utf-8");
  for (const [search, replace] of replacementEntries) {
    content = content.split(search).join(replace);
  }
  content = isCustomBranding(branding)
    ? prependBrandingBanner(content, branding, null)
    : applyBrandingTokens(content, branding);

  return { status: 200, labId: found.labId, markdown: content };
}

/**
 * Render a single generated lab as a standalone multi-page HTML document,
 * applying optional replacements, custom branding, and inline image data URIs
 * so a downloaded `.html` file works offline as a single file.
 */
export function renderGeneratedLabHtml(
  generatedRoot,
  rawLabId,
  replacements = {},
  { branding = loadBranding(), resolveAsset, logoSourcePath: explicitLogoPath } = {},
) {
  const found = resolveSafeGeneratedLabDir(generatedRoot, rawLabId);
  if (found.status !== 200) return { status: found.status, error: found.error };

  const replacementEntries = Object.entries(replacements || {}).filter(([k, v]) => k && v && k !== v);
  let content = readFileSync(join(found.labDir, "index.md"), "utf-8");
  for (const [search, replace] of replacementEntries) {
    content = content.split(search).join(replace);
  }
  content = applyBrandingTokens(content, branding);

  const customizedBranding = isCustomBranding(branding);
  const logoPath = customizedBranding
    ? explicitLogoPath || getBrandingLogoAbsolutePath(branding.logo)
    : null;
  const brandingInfo = customizedBranding
    ? {
        companyName: branding.companyName,
        tagline: branding.tagline,
        primaryColor: branding.primaryColor,
        logoUrl: fileToDataUri(logoPath),
      }
    : null;

  const html = renderStandaloneLabHtml(content, {
    title: found.manifest?.title || found.labId,
    labId: found.labId,
    branding: brandingInfo,
    renderMarkdown: renderLabMarkdown,
    resolveImageSrc: (assetName) => {
      if (typeof resolveAsset === "function") {
        const resolved = resolveAsset(generatedRoot, found.labId, assetName);
        if (resolved?.status === 200 && resolved.path) {
          const uri = fileToDataUri(resolved.path, resolved.type);
          if (uri) return uri;
        }
      }
      const captured = resolveLabScreenshot(found.labDir, assetName);
      if (captured?.file) {
        const uri = fileToDataUri(captured.file);
        if (uri) return uri;
      }
      return `/api/lab-builder/generated/${found.labId}/assets/${assetName}`;
    },
  });

  return { status: 200, labId: found.labId, html };
}

/**
 * Render a full generated lab as a single `.docx` Buffer.
 */
export function renderGeneratedLabDocx(
  generatedRoot,
  rawLabId,
  replacements = {},
  { branding = loadBranding(), resolveAsset, logoSourcePath: explicitLogoPath } = {},
) {
  const found = resolveSafeGeneratedLabDir(generatedRoot, rawLabId);
  if (found.status !== 200) return { status: found.status, error: found.error };

  const replacementEntries = Object.entries(replacements || {}).filter(([k, v]) => k && v && k !== v);
  let content = readFileSync(join(found.labDir, "index.md"), "utf-8");
  for (const [search, replace] of replacementEntries) {
    content = content.split(search).join(replace);
  }
  content = applyBrandingTokens(content, branding);

  const customizedBranding = isCustomBranding(branding);
  const logoPath = customizedBranding
    ? explicitLogoPath || getBrandingLogoAbsolutePath(branding.logo)
    : null;
  const logoBuffer = logoPath && existsSync(logoPath) ? readFileSync(logoPath) : null;

  const buffer = renderMarkdownToDocxBuffer(content, {
    title: found.manifest?.title || found.labId,
    branding: customizedBranding
      ? {
          companyName: branding.companyName,
          tagline: branding.tagline,
          primaryColor: branding.primaryColor,
          logoBuffer,
        }
      : { primaryColor: branding.primaryColor },
    resolveImageBuffer: (src) => resolveLabAssetBuffer(generatedRoot, found.labId, found.labDir, src, resolveAsset),
  });

  return { status: 200, labId: found.labId, buffer };
}

/**
 * Render a full generated lab as a single `.pptx` Buffer.
 */
export function renderGeneratedLabPptx(
  generatedRoot,
  rawLabId,
  replacements = {},
  { branding = loadBranding(), resolveAsset, logoSourcePath: explicitLogoPath } = {},
) {
  const found = resolveSafeGeneratedLabDir(generatedRoot, rawLabId);
  if (found.status !== 200) return { status: found.status, error: found.error };

  const replacementEntries = Object.entries(replacements || {}).filter(([k, v]) => k && v && k !== v);
  let content = readFileSync(join(found.labDir, "index.md"), "utf-8");
  let brandedTitle = found.manifest?.title || found.labId;
  for (const [search, replace] of replacementEntries) {
    content = content.split(search).join(replace);
    brandedTitle = brandedTitle.split(search).join(replace);
  }
  content = applyBrandingTokens(content, branding);
  brandedTitle = applyBrandingTokens(brandedTitle, branding);

  const customizedBranding = isCustomBranding(branding);
  const logoPath = customizedBranding
    ? explicitLogoPath || getBrandingLogoAbsolutePath(branding.logo)
    : null;
  const logoBuffer = logoPath && existsSync(logoPath) ? readFileSync(logoPath) : null;

  const buffer = renderMarkdownToPptxBuffer(content, {
    title: brandedTitle,
    manifest: { ...(found.manifest || {}), title: brandedTitle },
    branding: customizedBranding
      ? {
          companyName: branding.companyName,
          tagline: branding.tagline,
          primaryColor: branding.primaryColor,
          logoBuffer,
        }
      : { primaryColor: branding.primaryColor },
    resolveImageBuffer: (src) => resolveLabAssetBuffer(generatedRoot, found.labId, found.labDir, src, resolveAsset),
  });

  return { status: 200, labId: found.labId, buffer };
}

/**
 * Render a full generated lab as a single `.pdf` Buffer.
 */
export function renderGeneratedLabPdf(
  generatedRoot,
  rawLabId,
  replacements = {},
  { branding = loadBranding(), resolveAsset } = {},
) {
  const found = resolveSafeGeneratedLabDir(generatedRoot, rawLabId);
  if (found.status !== 200) return { status: found.status, error: found.error };

  const replacementEntries = Object.entries(replacements || {}).filter(([k, v]) => k && v && k !== v);
  let content = readFileSync(join(found.labDir, "index.md"), "utf-8");
  for (const [search, replace] of replacementEntries) {
    content = content.split(search).join(replace);
  }
  content = applyBrandingTokens(content, branding);

  const customizedBranding = isCustomBranding(branding);
  const buffer = renderMarkdownToPdfBuffer(content, {
    title: found.manifest?.title || found.labId,
    branding: customizedBranding
      ? {
          companyName: branding.companyName,
          tagline: branding.tagline,
          primaryColor: branding.primaryColor,
        }
      : { primaryColor: branding.primaryColor },
    resolveImageBuffer: (src) => resolveLabAssetBuffer(generatedRoot, found.labId, found.labDir, src, resolveAsset),
  });

  return { status: 200, labId: found.labId, buffer };
}

/**
 * Create a ZIP archive of a single generated lab, resolving captured assets
 * when available, applying custom branding when configured, and packaging each
 * module in its own titled folder with `.docx`, `.pdf`, `.html` guides and
 * scenario-tailored `sample-files/`.
 */
export function exportGeneratedLab(
  generatedRoot,
  rawLabId,
  replacements = {},
  outputStream,
  { resolveAsset, branding = loadBranding(), logoSourcePath: explicitLogoPath, formats, docFormats } = {},
) {
  const selectedFormats = normalizeDocFormats(formats ?? docFormats ?? "all");
  const found = resolveSafeGeneratedLabDir(generatedRoot, rawLabId);
  if (found.status !== 200) {
    const err = new Error(found.error);
    err.status = found.status;
    throw err;
  }

  const { labId, labDir } = found;

  return new Promise((resolveArchive, reject) => {
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const customizedBranding = isCustomBranding(branding);
    const logoSourcePath = customizedBranding
      ? explicitLogoPath || getBrandingLogoAbsolutePath(branding.logo)
      : null;
    const logoArchivePath = logoSourcePath && existsSync(logoSourcePath)
      ? posix.join("_branding", `logo${extname(logoSourcePath).toLowerCase()}`)
      : null;

    archive.on("error", reject);
    archive.on("end", () => resolveArchive({ bytes: archive.pointer(), labCount: 1, labId }));

    archive.pipe(outputStream);

    const replacementEntries = Object.entries(replacements || {}).filter(([k, v]) => k && v && k !== v);

    if (logoArchivePath) {
      archive.file(logoSourcePath, { name: logoArchivePath });
    }

    function walkLab(currentDir) {
      for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const fullPath = join(currentDir, entry.name);
        let stats;
        try {
          stats = lstatSync(fullPath);
        } catch {
          continue;
        }
        if (stats.isSymbolicLink()) continue;
        if (stats.isDirectory()) {
          const relDir = relative(labDir, fullPath).replace(/\\/g, "/");
          if (relDir === "topics") {
            // Per-topic documents are rendered per requested format and branding below.
            continue;
          }
          walkLab(fullPath);
          continue;
        }
        if (!stats.isFile()) continue;

        const relPath = relative(labDir, fullPath).replace(/\\/g, "/");
        const archiveName = posix.join(labId, relPath);

        if (relPath === "index.html") {
          // Rendered fresh below from index.md so replacements and branding match.
          continue;
        }

        if (entry.name.endsWith(".md")) {
          let content = readFileSync(fullPath, "utf-8");
          for (const [search, replace] of replacementEntries) {
            content = content.split(search).join(replace);
          }
          if (customizedBranding) {
            const logoRelativePath = logoArchivePath
              ? relative(dirname(archiveName), logoArchivePath).replace(/\\/g, "/")
              : null;
            content = prependBrandingBanner(content, branding, logoRelativePath);
          } else {
            content = applyBrandingTokens(content, branding);
          }
          archive.append(content, { name: archiveName });
          continue;
        }

        if (relPath.startsWith("assets/") && !relPath.slice("assets/".length).includes("/")) {
          if (typeof resolveAsset === "function") {
            const resolved = resolveAsset(generatedRoot, labId, entry.name);
            if (resolved?.status === 200 && resolved.path && existsSync(resolved.path)) {
              archive.file(resolved.path, { name: archiveName });
              continue;
            }
          }
          const captured = resolveLabScreenshot(labDir, entry.name);
          if (captured?.file && existsSync(captured.file)) {
            archive.file(captured.file, { name: archiveName });
            continue;
          }
        }

        archive.file(fullPath, { name: archiveName });
      }
    }

    walkLab(labDir);

    let htmlSourceMd = readFileSync(join(labDir, "index.md"), "utf-8");
    for (const [search, replace] of replacementEntries) {
      htmlSourceMd = htmlSourceMd.split(search).join(replace);
    }
    htmlSourceMd = applyBrandingTokens(htmlSourceMd, branding);
    const htmlArchiveName = posix.join(labId, "index.html");
    const htmlLogoRel = logoArchivePath
      ? relative(dirname(htmlArchiveName), logoArchivePath).replace(/\\/g, "/")
      : null;
    const standaloneHtml = renderStandaloneLabHtml(htmlSourceMd, {
      title: found.manifest?.title || labId,
      labId,
      renderMarkdown: renderLabMarkdown,
      branding: customizedBranding
        ? {
            companyName: branding.companyName,
            tagline: branding.tagline,
            primaryColor: branding.primaryColor,
            logoUrl: htmlLogoRel,
          }
        : null,
    });
    archive.append(standaloneHtml, { name: htmlArchiveName });

    // Build per-module titled folders (`Module NN - <Module Title>/`) + sample files +
    // `00 - Overview and Admin Prerequisites/` in the requested format(s).
    const logoBuffer = logoSourcePath && existsSync(logoSourcePath) ? readFileSync(logoSourcePath) : null;
    const inlineLogoUri = logoSourcePath ? fileToDataUri(logoSourcePath) : null;
    const resolveImgBuffer = (src) => resolveLabAssetBuffer(generatedRoot, labId, labDir, src, resolveAsset);
    const resolveInlineImgUri = (assetName) => {
      if (typeof resolveAsset === "function") {
        const resolved = resolveAsset(generatedRoot, labId, assetName);
        if (resolved?.status === 200 && resolved.path) {
          const uri = fileToDataUri(resolved.path, resolved.type);
          if (uri) return uri;
        }
      }
      const captured = resolveLabScreenshot(labDir, assetName);
      if (captured?.file) {
        const uri = fileToDataUri(captured.file);
        if (uri) return uri;
      }
      return null;
    };

    const docBranding = customizedBranding
      ? {
          companyName: branding.companyName,
          tagline: branding.tagline,
          primaryColor: branding.primaryColor,
          logoBuffer,
        }
      : { primaryColor: branding.primaryColor };

    const htmlBranding = customizedBranding
      ? {
          companyName: branding.companyName,
          tagline: branding.tagline,
          primaryColor: branding.primaryColor,
          logoUrl: inlineLogoUri,
        }
      : null;

    const appendFormattedDocs = (folderRelPath, baseFileName, docTitle, docMarkdown, topicContext = null) => {
      if (selectedFormats.includes("docx")) {
        const docxBuf = renderMarkdownToDocxBuffer(docMarkdown, {
          title: docTitle,
          branding: docBranding,
          resolveImageBuffer: resolveImgBuffer,
        });
        archive.append(docxBuf, { name: posix.join(labId, folderRelPath, `${baseFileName}.docx`) });
      }
      if (selectedFormats.includes("pptx")) {
        const pptxBuf = topicContext
          ? renderTopicToPptxBuffer(docMarkdown, {
              title: docTitle,
              branding: docBranding,
              resolveImageBuffer: resolveImgBuffer,
              topic: topicContext,
            })
          : renderMarkdownToPptxBuffer(docMarkdown, {
              title: docTitle,
              manifest: found.manifest || {},
              branding: docBranding,
              resolveImageBuffer: resolveImgBuffer,
            });
        archive.append(pptxBuf, { name: posix.join(labId, folderRelPath, `${baseFileName}.pptx`) });
      }
      if (selectedFormats.includes("pdf")) {
        const pdfBuf = renderMarkdownToPdfBuffer(docMarkdown, {
          title: docTitle,
          branding: docBranding,
          resolveImageBuffer: resolveImgBuffer,
        });
        archive.append(pdfBuf, { name: posix.join(labId, folderRelPath, `${baseFileName}.pdf`) });
      }
      if (selectedFormats.includes("html")) {
        const modHtml = renderStandaloneLabHtml(docMarkdown, {
          title: docTitle,
          labId,
          renderMarkdown: renderLabMarkdown,
          branding: htmlBranding,
          resolveImageSrc: resolveInlineImgUri,
        });
        archive.append(modHtml, { name: posix.join(labId, folderRelPath, `${baseFileName}.html`) });
      }
    };

    let brandedLabTitle = found.manifest?.title || labId;
    for (const [search, replace] of replacementEntries) {
      brandedLabTitle = brandedLabTitle.split(search).join(replace);
    }
    brandedLabTitle = applyBrandingTokens(brandedLabTitle, branding);

    const effectiveManifest = { ...(found.manifest || {}), title: brandedLabTitle };
    const split = splitGeneratedLabModules(htmlSourceMd, effectiveManifest, { labId });
    appendFormattedDocs(
      split.overview.folderName,
      sanitizeFilesystemTitle(split.overview.fileBaseName, "Lab Overview and Admin Prerequisites"),
      split.overview.title,
      split.overview.markdown,
    );

    const manifestMods = Array.isArray(effectiveManifest.modules) ? effectiveManifest.modules : [];
    const productsText = Array.isArray(effectiveManifest.products)
      ? effectiveManifest.products.join(", ")
      : "";

    const exportedModules = [];
    for (const mod of split.modules) {
      const mMeta =
        manifestMods.find((m) => Number(m.order) === Number(mod.order)) || {};
      appendFormattedDocs(
        mod.folderName,
        mod.fileBaseName,
        `${brandedLabTitle} - ${mod.stepLabel} - ${mod.title}`,
        mod.markdown,
        {
          featureId: mMeta.id || mod.id || null,
          labTitle: brandedLabTitle,
          stepLabel: mod.stepLabel,
          topicTitle: mod.title,
          levelText: mMeta.level ? `Level ${mMeta.level}` : "",
          estimatedTime: mMeta.minutes ? `~${mMeta.minutes} min` : "",
          products: productsText,
          agentName: effectiveManifest?.options?.agentName || effectiveManifest?.request?.agentName || "",
          harness:
            effectiveManifest?.request?.harness ||
            effectiveManifest?.differences?.labHarness ||
            null,
          trainingDigest: mMeta.trainingDigest || null,
          manifest: effectiveManifest,
        },
      );

      const sampleFiles = buildModuleSampleFiles(mod.moduleInfo, {
        manifest: effectiveManifest,
        labTitle: brandedLabTitle,
        replacementEntries,
      });
      const sampleFileNames = [];
      for (const sample of sampleFiles) {
        const brandedSampleContent = applyBrandingTokens(sample.content, branding);
        archive.append(brandedSampleContent, {
          name: posix.join(labId, mod.folderName, "sample-files", sample.filename),
        });
        sampleFileNames.push(sample.filename);
      }

      exportedModules.push({
        order: mod.order,
        id: mod.id,
        stepLabel: mod.stepLabel,
        title: mod.title,
        fileBaseName: mod.fileBaseName,
        folder: posix.join(labId, mod.folderName),
        documents: selectedFormats.map((fmt) => posix.join(labId, mod.folderName, `${mod.fileBaseName}.${fmt}`)),
        sampleFiles: sampleFileNames.map((fn) => posix.join(labId, mod.folderName, "sample-files", fn)),
      });
    }

    const manifest = {
      exportedAt: new Date().toISOString(),
      source: "generated",
      labs: [labId],
      title: brandedLabTitle,
      formats: selectedFormats,
      overviewFolder: posix.join(labId, split.overview.folderName),
      modules: exportedModules,
      customized: replacementEntries.length > 0 || customizedBranding,
      branding: {
        companyName: branding.companyName,
        logo: logoArchivePath,
        primaryColor: branding.primaryColor,
        tagline: branding.tagline,
      },
    };
    archive.append(JSON.stringify(manifest, null, 2), { name: "export-manifest.json" });

    archive.finalize();
  });
}
