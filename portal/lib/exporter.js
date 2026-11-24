/**
 * Lab export — generates ZIP bundles of selected labs with customized content.
 */

import { readFileSync, readdirSync, existsSync, lstatSync } from "fs";
import { dirname, extname, isAbsolute, join, posix, relative, resolve } from "path";
import { getLabPath, isValidLabId } from "./labs.js";
import {
  applyBrandingToMarkdown,
  applyBrandingTokens,
  getBrandingLogoAbsolutePath,
  loadBranding,
  prependBrandingBanner,
} from "./branding.js";
import { resolveLabBrand } from "./branding-profiles.js";
import {
  getBrandInfoLines,
  getBrandSharepointSite,
  hasBrandCustomization,
  normalizeBrand,
  renderBrandInfoMarkdown,
} from "./lab-builder/brand-theme.js";
import { renderStandaloneLabHtml } from "./lab-builder/html-lab.js";
import { resolveLabScreenshot } from "./lab-builder/captured.js";
import { altOfTag, loadShotSlots } from "./lab-builder/pending-shot-card.js";
import { repairLabPlaceholders } from "./lab-builder/lab-screenshots.js";
import { isBuilding } from "./lab-builder/lab-state.js";
import { isPlaceholder } from "./lab-builder/placeholder-detect.js";
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
import {
  EXTRACT_ON_WINDOWS_TIP,
  ExportBudgetError,
  docKind,
  planLabFolder,
  planModuleNames,
  resolveExportBudget,
  zipDownloadName,
} from "./export-names.js";
import { createExportZip } from "./export-zip.js";
import { buildIndexRows, renderContentsMarkdown } from "./export-index.js";
import {
  buildFacilitatorGuideModel,
  renderFacilitatorGuideDocxBuffer,
  renderFacilitatorGuideHtml,
  renderFacilitatorGuideMarkdown,
  renderFacilitatorGuidePdfBuffer,
} from "./lab-builder/facilitator-guide.js";
import { renderLabMarkdown } from "./markdown.js";
import { ADMIN_FOLDER_NAME, ADMIN_GUIDE_TITLE, learnerGuideMarkdown, learnerSafeManifest } from "./lab-builder/learner-guide.js";
import { repairRunOnSteps } from "./lab-builder/sub-steps.js";
import { plainTextDeep } from "./lab-builder/plain-text.js";
import { repairConnectorNames, rewriteConnectorValue } from "./lab-builder/connector-names.js";
import { TRAINING_ZIP_FOLDER, trainingZipEntries } from "./lab-builder/training-decks.js";
import { buildPrerequisitesChecklist, renderPrerequisitesChecklistMarkdown } from "./lab-builder/prereq-checklist.js";
import { renderPrerequisitesChecklistHtml } from "./lab-builder/prereq-checklist-html.js";
import { renderPrerequisitesChecklistDocxBuffer } from "./lab-builder/prereq-checklist-docx.js";
import { renderPrerequisitesChecklistPdfBuffer } from "./lab-builder/prereq-checklist-pdf.js";
import {
  PREREQUISITES_FORMATS,
  normalizePrerequisitesFormat,
  renderPrerequisitesChecklistFile,
} from "./lab-builder/prereq-checklist-render.js";
import { buildAdministratorSetupGuide, renderAdministratorSetupGuideMarkdown } from "./lab-builder/admin-guide.js";
import { renderAdministratorSetupGuideDocxBuffer } from "./lab-builder/admin-guide-docx.js";
import { renderAdministratorSetupGuideHtml } from "./lab-builder/admin-guide-html.js";
import { renderAdministratorSetupGuidePdfBuffer } from "./lab-builder/admin-guide-pdf.js";
import {
  ADMIN_GUIDE_FORMATS,
  normalizeAdminGuideFormat,
  renderAdministratorSetupGuideFile,
} from "./lab-builder/admin-guide-render.js";

const SAFE_GENERATED_LAB_ID = /^[a-z0-9][a-z0-9-]{0,99}$/i;
const ALLOWED_DOC_FORMATS = ["docx", "pptx", "pdf", "html"];
const PICTURE_NAME = /\.(png|jpe?g|gif|webp|svg)$/i;

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
        // A placeholder picture (the pending image or a captioned filler) is no screenshot: fall through to the callout.
        if (!isPlaceholder(buf) && (resolvedAbs !== localPath || buf.length >= MIN_CAPTURED_BYTES)) {
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
  return hasBrandCustomization(branding);
}

/** Visual and text brand fields every renderer understands (logo is attached per format). */
function brandRenderOptions(brand) {
  const b = normalizeBrand(brand);
  return {
    companyName: b.companyName,
    tagline: b.tagline,
    primaryColor: b.primaryColor,
    secondaryColor: b.secondaryColor,
    font: b.font,
    coverSubtitle: b.coverSubtitle,
    footerText: b.footerText,
    moreInfoLabel: b.moreInfoLabel,
    moreInfoUrl: b.moreInfoUrl,
    supportName: b.supportName,
    supportEmail: b.supportEmail,
    communityUrl: b.communityUrl,
  };
}

/** Branding handed to DOCX/PDF/PPTX builders; plain defaults stay unbranded apart from the accent color. */
function buildDocBranding(brand, custom, logoBuffer = null) {
  return custom
    ? { ...brandRenderOptions(brand), logoBuffer }
    : { primaryColor: normalizeBrand(brand).primaryColor };
}

/** Branding handed to the standalone HTML renderers. */
function buildHtmlBranding(brand, custom, logoUrl = null) {
  return custom ? { ...brandRenderOptions(brand), logoUrl } : null;
}

/** Brand details recorded in export manifests (no contact details). */
function buildManifestBranding(brand, logoArchivePath = null) {
  const b = normalizeBrand(brand);
  return {
    companyName: b.companyName,
    logo: logoArchivePath,
    primaryColor: b.primaryColor,
    secondaryColor: b.secondaryColor || null,
    font: b.font,
    tagline: b.tagline,
    profileId: brand?.profileId || null,
    profileName: brand?.profileName || null,
  };
}

function appendBrandInfo(markdown, brand) {
  const info = renderBrandInfoMarkdown(brand);
  return info ? `${String(markdown ?? "").replace(/\s+$/, "")}\n${info}` : markdown;
}

/** README.md placed at the root of every generated-lab bundle. */
export function renderBundleReadme({ title, brand, formats = [], modules = [], hasFacilitatorGuide = true, customerChecklistFile = null, hasAdministratorFolder = false, trainingDecks = null, labFolder = null, contents = "" } = {}) {
  const b = normalizeBrand(brand);
  const site = getBrandSharepointSite(b);
  const lines = [`# ${title || "Lab bundle"}`, ""];
  lines.push(`${b.companyName}${b.tagline ? ` — ${b.tagline}` : ""}`, "");
  if (b.coverSubtitle) lines.push(`_${b.coverSubtitle}_`, "");
  lines.push(`> ${EXTRACT_ON_WINDOWS_TIP}`, "");
  lines.push("## What is in this bundle", "");
  if (trainingDecks) {
    lines.push(`- \`${trainingDecks.folder}/\` — the pre-lab training decks: deliver these first, to people who are new to this. About ${trainingDecks.minutes} minutes, no lab steps. It has a complete deck, a foundations deck for each product, and one deck for each module.`);
  }
  lines.push(labFolder ? `- \`${labFolder}/index.md\` and \`${labFolder}/index.html\` — the complete lab guide (Markdown and a single-file web page).` : "- `index.md` and `index.html` — the complete lab guide (Markdown and a single-file web page).");
  if (formats.length) {
    lines.push(`- One folder per module${labFolder ? ` inside \`${labFolder}/\`` : ""} with the guide in ${formats.map((f) => `.${f}`).join(", ")} and a \`sample-files/\` starter pack. Folders start with the module's number, so they list in teaching order.`);
  }
  if (hasAdministratorFolder) {
    lines.push(`- \`${ADMIN_FOLDER_NAME}/\` — the ${ADMIN_GUIDE_TITLE} and the Prerequisites checklist. Admin settings only: hand this folder to your administrator and keep it out of the learner materials.`);
  }
  if (customerChecklistFile) lines.push(`- \`${customerChecklistFile}\` — only the prerequisites, safe to send to the customer hosting the workshop.`);
  if (hasFacilitatorGuide) lines.push(`- \`${labFolder ? `${labFolder}/` : ""}Facilitator Guide/\` — the instructor pack for delivering the lab.`);
  lines.push(`- \`${labFolder ? `${labFolder}/` : ""}assets/\` — screenshots used by the guide.`);
  if (modules.length) {
    lines.push("", "## Modules", "");
    for (const mod of modules) lines.push(`${mod.order}. ${mod.title}`);
  }
  if (contents) lines.push("", String(contents).trim());
  const resources = [];
  if (site.url) resources.push(`SharePoint site: ${site.name ? `${site.name} — ` : ""}${site.url}`);
  resources.push(...getBrandInfoLines(b));
  if (resources.length) {
    lines.push("", "## Links and support", "", ...resources.map((line) => `- ${line}`));
  }
  if (b.footerText) lines.push("", "---", "", b.footerText);
  lines.push("");
  return lines.join("\n");
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
  if (!existsSync(indexPath) || !existsSync(manifestPath) || isBuilding(labDir)) {
    return { status: 404, error: "Generated lab not found" };
  }

  // Every preview and export starts here, so a lab built while placeholder pictures counted as captures is repaired first.
  repairLabPlaceholders(labDir, { labId });

  let manifest = null;
  try {
    // A lab saved with symbols in its title or notes is read as plain text; the file on disk is not rewritten.
    manifest = plainTextDeep(JSON.parse(readFileSync(manifestPath, "utf-8")));
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
 * Every file of a static lab, in the order the ZIP lists them: `{dir: true, rel}` for a folder, `{full, rel}` for a file.
 * The lab's own Markdown files are left out: they are read, branded, and added as text.
 */
function listStaticLabFiles(rootDir) {
  const out = [];
  const walk = (current, rel) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push({ dir: true, rel: relPath });
        walk(full, relPath);
      } else if (entry.isFile() && !entry.name.endsWith(".md")) {
        out.push({ full, rel: relPath });
      }
    }
  };
  walk(rootDir, "");
  return out;
}

/**
 * Create a ZIP archive of selected labs.
 *
 * Every entry goes through the shared path guard (see export-names.js). The labs' own folder names are short ids, so
 * nothing is renamed here; a path that ever went over the budget would be shortened and recorded in export-manifest.json.
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
    const zip = createExportZip();
    const archive = zip.archive;
    const branding = loadBranding();
    const logoSourcePath = getBrandingLogoAbsolutePath(branding.logo);
    const logoArchivePath = logoSourcePath
      ? posix.join("_branding", `logo${extname(logoSourcePath).toLowerCase()}`)
      : null;
    let summary = null;

    archive.on("error", reject);
    archive.on("end", () => resolve({ bytes: archive.pointer(), labCount: labIds.length, ...summary }));

    archive.pipe(outputStream);

    try {
      const replacementEntries = Object.entries(replacements).filter(([k, v]) => k && v && k !== v);

      if (logoSourcePath && existsSync(logoSourcePath) && logoArchivePath) {
        zip.addFile(logoArchivePath, logoSourcePath, { group: "lab", kind: "Logo", title: "Company logo" });
      }

      for (const { labId, labDir } of labDirectories) {
        for (const item of listStaticLabFiles(labDir)) {
          if (item.dir) zip.addDirectory(posix.join(labId, item.rel));
          else zip.addFile(posix.join(labId, item.rel), item.full, { group: PICTURE_NAME.test(item.rel) ? "picture" : "lab" });
        }

        for (const mdFile of findMdFiles(labDir)) {
          let content = readFileSync(mdFile, "utf-8");
          // A lab built while sub-steps were one sentence is repaired as it is exported; the file on disk is not touched.
          if (relative(labDir, mdFile) === "index.md") content = repairRunOnSteps(content);
          // A lab saved with a connector's internal name shows the display name in the export.
          content = repairConnectorNames(content);
          for (const [search, replace] of replacementEntries) {
            content = content.split(search).join(replace);
          }

          const relativePath = relative(labDir, mdFile).replace(/\\/g, "/");
          const archiveName = posix.join(labId, relativePath);
          const logoRelativePath = logoArchivePath
            ? relative(dirname(archiveName), logoArchivePath).replace(/\\/g, "/")
            : null;

          content = prependBrandingBanner(content, branding, logoRelativePath, { infoBlocks: relativePath === "index.md" });
          zip.add(archiveName, content, { group: "lab", kind: relativePath === "index.md" ? "Lab guide" : "Notes", format: "md" });
        }
      }

      // Add a manifest
      const manifest = {
        exportedAt: new Date().toISOString(),
        labs: labIds,
        customized: replacementEntries.length > 0 || isCustomBranding(branding),
        branding: buildManifestBranding(branding, logoArchivePath),
        pathBudget: zip.budgetReport(),
        index: buildIndexRows(zip.entries),
      };
      summary = { entryCount: zip.guard.count + 1, longestEntry: zip.guard.longest, warnings: zip.guard.warnings };
      zip.add("export-manifest.json", JSON.stringify(manifest, null, 2), { group: "lab", kind: "Data", title: "Export manifest" });

      archive.finalize();
    } catch (err) {
      archive.abort();
      reject(err);
    }
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
  { branding } = {},
) {
  const found = resolveSafeGeneratedLabDir(generatedRoot, rawLabId);
  if (found.status !== 200) return { status: found.status, error: found.error };

  const brand = resolveLabBrand(found.manifest, { brand: branding });
  const replacementEntries = Object.entries(replacements || {}).filter(([k, v]) => k && v && k !== v);
  let content = repairRunOnSteps(learnerGuideMarkdown(readFileSync(join(found.labDir, "index.md"), "utf-8")));
  for (const [search, replace] of replacementEntries) {
    content = content.split(search).join(replace);
  }
  content = isCustomBranding(brand)
    ? prependBrandingBanner(content, brand, null)
    : applyBrandingTokens(content, brand);

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
  { branding, resolveAsset, logoSourcePath: explicitLogoPath } = {},
) {
  const found = resolveSafeGeneratedLabDir(generatedRoot, rawLabId);
  if (found.status !== 200) return { status: found.status, error: found.error };

  const brand = resolveLabBrand(found.manifest, { brand: branding });
  const replacementEntries = Object.entries(replacements || {}).filter(([k, v]) => k && v && k !== v);
  let content = learnerGuideMarkdown(readFileSync(join(found.labDir, "index.md"), "utf-8"));
  for (const [search, replace] of replacementEntries) {
    content = content.split(search).join(replace);
  }
  content = applyBrandingToMarkdown(content, brand);

  const customizedBranding = isCustomBranding(brand);
  const logoPath = customizedBranding
    ? explicitLogoPath || getBrandingLogoAbsolutePath(brand.logo)
    : null;
  const brandingInfo = buildHtmlBranding(brand, customizedBranding, fileToDataUri(logoPath));
  const shotSlots = loadShotSlots(found.labDir);

  const html = renderStandaloneLabHtml(content, {
    title: found.manifest?.title || found.labId,
    labId: found.labId,
    branding: brandingInfo,
    renderMarkdown: renderLabMarkdown,
    pendingShotFor: (tag) => {
      const src = /\bsrc="assets\/([^"]+)"/i.exec(tag);
      if (!src || resolveLabScreenshot(found.labDir, src[1])) return null;
      return { filename: src[1], slot: shotSlots.get(src[1]) || null, alt: altOfTag(tag) };
    },
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
  { branding, resolveAsset, logoSourcePath: explicitLogoPath } = {},
) {
  const found = resolveSafeGeneratedLabDir(generatedRoot, rawLabId);
  if (found.status !== 200) return { status: found.status, error: found.error };

  const brand = resolveLabBrand(found.manifest, { brand: branding });
  const replacementEntries = Object.entries(replacements || {}).filter(([k, v]) => k && v && k !== v);
  let content = learnerGuideMarkdown(readFileSync(join(found.labDir, "index.md"), "utf-8"));
  for (const [search, replace] of replacementEntries) {
    content = content.split(search).join(replace);
  }
  content = applyBrandingToMarkdown(content, brand);

  const customizedBranding = isCustomBranding(brand);
  const logoPath = customizedBranding
    ? explicitLogoPath || getBrandingLogoAbsolutePath(brand.logo)
    : null;
  const logoBuffer = logoPath && existsSync(logoPath) ? readFileSync(logoPath) : null;

  const buffer = renderMarkdownToDocxBuffer(content, {
    title: found.manifest?.title || found.labId,
    branding: buildDocBranding(brand, customizedBranding, logoBuffer),
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
  { branding, resolveAsset, logoSourcePath: explicitLogoPath } = {},
) {
  const found = resolveSafeGeneratedLabDir(generatedRoot, rawLabId);
  if (found.status !== 200) return { status: found.status, error: found.error };

  const brand = resolveLabBrand(found.manifest, { brand: branding });
  const replacementEntries = Object.entries(replacements || {}).filter(([k, v]) => k && v && k !== v);
  let content = learnerGuideMarkdown(readFileSync(join(found.labDir, "index.md"), "utf-8"));
  let brandedTitle = found.manifest?.title || found.labId;
  for (const [search, replace] of replacementEntries) {
    content = content.split(search).join(replace);
    brandedTitle = brandedTitle.split(search).join(replace);
  }
  content = applyBrandingTokens(content, brand);
  brandedTitle = applyBrandingTokens(brandedTitle, brand);

  const customizedBranding = isCustomBranding(brand);
  const logoPath = customizedBranding
    ? explicitLogoPath || getBrandingLogoAbsolutePath(brand.logo)
    : null;
  const logoBuffer = logoPath && existsSync(logoPath) ? readFileSync(logoPath) : null;

  const buffer = renderMarkdownToPptxBuffer(content, {
    title: brandedTitle,
    manifest: { ...(found.manifest || {}), title: brandedTitle },
    branding: buildDocBranding(brand, customizedBranding, logoBuffer),
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
  { branding, resolveAsset } = {},
) {
  const found = resolveSafeGeneratedLabDir(generatedRoot, rawLabId);
  if (found.status !== 200) return { status: found.status, error: found.error };

  const brand = resolveLabBrand(found.manifest, { brand: branding });
  const replacementEntries = Object.entries(replacements || {}).filter(([k, v]) => k && v && k !== v);
  let content = learnerGuideMarkdown(readFileSync(join(found.labDir, "index.md"), "utf-8"));
  for (const [search, replace] of replacementEntries) {
    content = content.split(search).join(replace);
  }
  content = applyBrandingToMarkdown(content, brand);

  const customizedBranding = isCustomBranding(brand);
  const buffer = renderMarkdownToPdfBuffer(content, {
    title: found.manifest?.title || found.labId,
    branding: buildDocBranding(brand, customizedBranding),
    resolveImageBuffer: (src) => resolveLabAssetBuffer(generatedRoot, found.labId, found.labDir, src, resolveAsset),
  });

  return { status: 200, labId: found.labId, buffer };
}

function buildGeneratedLabFacilitatorContext(
  generatedRoot,
  rawLabId,
  replacements = {},
  { branding, logoSourcePath: explicitLogoPath } = {},
) {
  const found = resolveSafeGeneratedLabDir(generatedRoot, rawLabId);
  if (found.status !== 200) return { status: found.status, error: found.error };

  const brand = resolveLabBrand(found.manifest, { brand: branding });
  const replacementEntries = Object.entries(replacements || {}).filter(([k, v]) => k && v && k !== v);
  let content = learnerGuideMarkdown(readFileSync(join(found.labDir, "index.md"), "utf-8"));
  let brandedTitle = found.manifest?.title || found.labId;
  for (const [search, replace] of replacementEntries) {
    content = content.split(search).join(replace);
    brandedTitle = brandedTitle.split(search).join(replace);
  }
  content = applyBrandingTokens(content, brand);
  brandedTitle = applyBrandingTokens(brandedTitle, brand);

  const customizedBranding = isCustomBranding(brand);
  const logoPath = customizedBranding
    ? explicitLogoPath || getBrandingLogoAbsolutePath(brand.logo)
    : null;
  const logoBuffer = logoPath && existsSync(logoPath) ? readFileSync(logoPath) : null;
  const logoUrl = customizedBranding && logoPath ? fileToDataUri(logoPath) : null;

  const effectiveManifest = { ...(found.manifest || {}), title: brandedTitle };
  const model = buildFacilitatorGuideModel({
    labId: found.labId,
    labDir: found.labDir,
    manifest: effectiveManifest,
    markdown: content,
  });

  return {
    status: 200,
    labId: found.labId,
    labDir: found.labDir,
    title: brandedTitle,
    model,
    customizedBranding,
    branding: brand,
    docBranding: buildDocBranding(brand, customizedBranding, logoBuffer),
    htmlBranding: buildHtmlBranding(brand, customizedBranding, logoUrl),
  };
}

/**
 * Render the Instructor / Facilitator Guide for a generated lab as Markdown.
 */
export function renderGeneratedLabFacilitatorMarkdown(
  generatedRoot,
  rawLabId,
  replacements = {},
  options = {},
) {
  const ctx = buildGeneratedLabFacilitatorContext(generatedRoot, rawLabId, replacements, options);
  if (ctx.status !== 200) return { status: ctx.status, error: ctx.error };

  let markdown = renderFacilitatorGuideMarkdown(ctx.model);
  markdown = ctx.customizedBranding
    ? prependBrandingBanner(markdown, ctx.branding, null)
    : applyBrandingTokens(markdown, ctx.branding);

  return { status: 200, labId: ctx.labId, title: ctx.title, markdown };
}

/**
 * Render the Instructor / Facilitator Guide for a generated lab as standalone HTML.
 */
export function renderGeneratedLabFacilitatorHtml(
  generatedRoot,
  rawLabId,
  replacements = {},
  options = {},
) {
  const ctx = buildGeneratedLabFacilitatorContext(generatedRoot, rawLabId, replacements, options);
  if (ctx.status !== 200) return { status: ctx.status, error: ctx.error };

  const html = renderFacilitatorGuideHtml(ctx.model, {
    branding: ctx.htmlBranding || { primaryColor: ctx.branding?.primaryColor },
  });
  return { status: 200, labId: ctx.labId, title: ctx.title, html };
}

/**
 * Render the Instructor / Facilitator Guide for a generated lab as a `.docx` Buffer.
 */
export function renderGeneratedLabFacilitatorDocx(
  generatedRoot,
  rawLabId,
  replacements = {},
  options = {},
) {
  const ctx = buildGeneratedLabFacilitatorContext(generatedRoot, rawLabId, replacements, options);
  if (ctx.status !== 200) return { status: ctx.status, error: ctx.error };

  const buffer = renderFacilitatorGuideDocxBuffer(ctx.model, {
    title: `${ctx.title} — Facilitator Guide`,
    branding: ctx.docBranding,
  });
  return { status: 200, labId: ctx.labId, title: ctx.title, buffer };
}

/**
 * Render the Instructor / Facilitator Guide for a generated lab as a `.pdf` Buffer.
 */
export function renderGeneratedLabFacilitatorPdf(
  generatedRoot,
  rawLabId,
  replacements = {},
  options = {},
) {
  const ctx = buildGeneratedLabFacilitatorContext(generatedRoot, rawLabId, replacements, options);
  if (ctx.status !== 200) return { status: ctx.status, error: ctx.error };

  const buffer = renderFacilitatorGuidePdfBuffer(ctx.model, {
    title: `${ctx.title} — Facilitator Guide`,
    branding: ctx.docBranding,
  });
  return { status: 200, labId: ctx.labId, title: ctx.title, buffer };
}

export { PREREQUISITES_FORMATS, normalizePrerequisitesFormat, ADMIN_GUIDE_FORMATS, normalizeAdminGuideFormat };

/**
 * The Administrator setup guide for a generated lab: every administrator setting, grouped by role and in the
 * order of work, in Word (`docx`), `pdf`, a single-file web page (`html`), or Markdown (`md`). Works for labs
 * built before this document existed, because it reads only the saved manifest and `index.md` (the old
 * administrator section in it is never read: the settings come from the manifest's modules).
 */
export function renderGeneratedLabAdminGuide(
  generatedRoot,
  rawLabId,
  format = "docx",
  replacements = {},
  { branding, logoSourcePath, now } = {},
) {
  if (!normalizeAdminGuideFormat(format)) return renderAdministratorSetupGuideFile({ format });
  const found = resolveSafeGeneratedLabDir(generatedRoot, rawLabId);
  if (found.status !== 200) return { status: found.status, error: found.error };
  return renderAdministratorSetupGuideFile({
    manifest: found.manifest,
    markdown: readFileSync(join(found.labDir, "index.md"), "utf-8"),
    format,
    replacements,
    branding,
    logoSourcePath,
    now,
  });
}

/**
 * The standalone "Prerequisites checklist" for a generated lab: only what the customer must have ready,
 * in Word (`docx`), `pdf`, a single-file web page (`html`), or Markdown (`md`). Works for labs built
 * before this document existed, because it reads only the saved manifest and `index.md`.
 */
export function renderGeneratedLabPrerequisites(
  generatedRoot,
  rawLabId,
  format = "docx",
  replacements = {},
  { branding, logoSourcePath, now } = {},
) {
  if (!normalizePrerequisitesFormat(format)) return renderPrerequisitesChecklistFile({ format });
  const found = resolveSafeGeneratedLabDir(generatedRoot, rawLabId);
  if (found.status !== 200) return { status: found.status, error: found.error };
  return renderPrerequisitesChecklistFile({
    manifest: found.manifest,
    markdown: readFileSync(join(found.labDir, "index.md"), "utf-8"),
    format,
    replacements,
    branding,
    logoSourcePath,
    now,
  });
}
/** The files of a generated lab folder that go into the ZIP as they are named on disk (pictures, the saved guide, the shot list). */
function listLabFiles(labDir) {
  const out = [];
  const walk = (currentDir) => {
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
        // Per-topic documents are rendered per requested format and branding; the pre-lab training decks go in their own
        // top-level folder. Neither is copied from its name on disk.
        if (relDir === "topics" || relDir === "training") continue;
        walk(fullPath);
        continue;
      }
      if (!stats.isFile()) continue;
      out.push({ full: fullPath, rel: relative(labDir, fullPath).replace(/\\/g, "/"), name: entry.name });
    }
  };
  walk(labDir);
  return out;
}

/** What the README and the manifest index say about a file of the lab folder. */
function labFileMeta(rel, title) {
  if (rel === "index.md") return { group: "lab", kind: "Lab guide", format: "md", title };
  if (rel === "index.html") return { group: "lab", kind: "Lab guide", format: "html", title };
  if (rel === "manifest.json") return { group: "lab", kind: "Data", title: "Lab manifest" };
  if (rel === "SHOTLIST.md" || rel === "shots.json" || rel.startsWith("screenshots/")) return { group: "lab", kind: "Screenshot list", title: "Screenshot checklist and capture record" };
  if (PICTURE_NAME.test(rel)) return { group: "picture", kind: "Picture", title: rel.split("/").pop() };
  return { group: "lab" };
}

/**
 * Create a ZIP archive of a single generated lab, resolving captured assets
 * when available, applying custom branding when configured, and packaging each
 * module in its own folder with `.docx`, `.pdf`, `.html` guides and
 * scenario-tailored `sample-files/`.
 *
 * Every folder and file name in the ZIP is short (see export-names.js) so it extracts on Windows, and every entry
 * goes through the shared path guard. The README.md and export-manifest.json at the top map each short path to the
 * full title. Resolves with `{ bytes, labCount, labId, labFolder, zipFileName, entryCount, longestEntry, warnings }`;
 * `zipFileName` is the name the download should carry.
 */
export function exportGeneratedLab(
  generatedRoot,
  rawLabId,
  replacements = {},
  outputStream,
  { resolveAsset, branding: brandingOption, logoSourcePath: explicitLogoPath, formats, docFormats } = {},
) {
  const selectedFormats = normalizeDocFormats(formats ?? docFormats ?? "all");
  const found = resolveSafeGeneratedLabDir(generatedRoot, rawLabId);
  if (found.status !== 200) {
    const err = new Error(found.error);
    err.status = found.status;
    throw err;
  }

  const { labId, labDir } = found;
  // Per-lab overrides > lab profile snapshot > active profile > defaults.
  const branding = resolveLabBrand(found.manifest, { brand: brandingOption });

  return new Promise((resolveArchive, reject) => {
    const budget = resolveExportBudget();
    const zip = createExportZip({ budget });
    const archive = zip.archive;
    let summary = null;

    archive.on("error", reject);
    archive.on("end", () => resolveArchive({ bytes: archive.pointer(), labCount: 1, labId, ...summary }));
    archive.pipe(outputStream);

    try {
      const customizedBranding = isCustomBranding(branding);
      const logoSourcePath = customizedBranding
        ? explicitLogoPath || getBrandingLogoAbsolutePath(branding.logo)
        : null;
      const logoArchivePath = logoSourcePath && existsSync(logoSourcePath)
        ? posix.join("_branding", `logo${extname(logoSourcePath).toLowerCase()}`)
        : null;
      const replacementEntries = Object.entries(replacements || {}).filter(([k, v]) => k && v && k !== v);

      // The saved text with replacements and branding tokens applied. The administrator documents read this as it is;
      // every learner-facing file below reads `htmlSourceMd`, which has the administrator section taken out.
      let rawSourceMd = readFileSync(join(labDir, "index.md"), "utf-8");
      for (const [search, replace] of replacementEntries) {
        rawSourceMd = rawSourceMd.split(search).join(replace);
      }
      rawSourceMd = applyBrandingTokens(rawSourceMd, branding);
      const htmlSourceMd = learnerGuideMarkdown(rawSourceMd);

      let brandedLabTitle = found.manifest?.title || labId;
      for (const [search, replace] of replacementEntries) {
        brandedLabTitle = brandedLabTitle.split(search).join(replace);
      }
      brandedLabTitle = applyBrandingTokens(brandedLabTitle, branding);

      const effectiveManifest = { ...(found.manifest || {}), title: brandedLabTitle };
      const split = splitGeneratedLabModules(htmlSourceMd, effectiveManifest, { labId });

      // Names: short lab folder, "NN <short title>" module folders (see export-names.js). The lab folder is as short as the
      // pictures and saved guide inside it need, because those keep the names the guide's links use.
      const labFiles = listLabFiles(labDir);
      const longestFixedRelPath = Math.max("index.html".length, ...labFiles.map((file) => file.rel.length));
      const reservedTopLevel = new Set([ADMIN_FOLDER_NAME, TRAINING_ZIP_FOLDER, "_branding", "readme.md", "export-manifest.json"].map((name) => name.toLowerCase()));
      const labFolder = planLabFolder(brandedLabTitle, { labId, used: reservedTopLevel, longestFixedRelPath, budget });
      const moduleNames = planModuleNames(
        split.modules.map((m) => ({ order: m.order, title: m.title, isRecap: m.isRecap })),
        { labFolder, budget },
      );
      const folderNameOf = (m) => moduleNames.get(Number(m.order)).folder;
      const zipFileName = zipDownloadName(brandedLabTitle, {
        labName: labFolder,
        variant: selectedFormats.length === ALLOWED_DOC_FORMATS.length ? "" : selectedFormats.join("+"),
        max: budget.zipNameMax,
      });

      if (logoArchivePath) {
        zip.addFile(logoArchivePath, logoSourcePath, { group: "lab", kind: "Logo", title: "Company logo" });
      }

      for (const { full: fullPath, rel: relPath, name: fileName } of labFiles) {
        const archiveName = posix.join(labFolder, relPath);
        const meta = labFileMeta(relPath, brandedLabTitle);

        if (relPath === "index.html") {
          // Rendered fresh below from index.md so replacements and branding match.
          continue;
        }

        if (relPath === "manifest.json") {
          // The administrator model is not part of the learner folder; the Administrator setup guide rebuilds it.
          try {
            const safe = learnerSafeManifest(JSON.parse(readFileSync(fullPath, "utf-8")));
            zip.add(archiveName, `${JSON.stringify(safe, null, 2)}\n`, meta);
            continue;
          } catch (err) {
            if (err instanceof ExportBudgetError) throw err;
            // An unreadable manifest is copied as it is.
          }
        }

        if (fileName.endsWith(".md")) {
          let content = readFileSync(fullPath, "utf-8");
          if (relPath === "index.md") content = learnerGuideMarkdown(content);
          else content = repairConnectorNames(content);
          for (const [search, replace] of replacementEntries) {
            content = content.split(search).join(replace);
          }
          if (customizedBranding) {
            const logoRelativePath = logoArchivePath
              ? relative(dirname(archiveName), logoArchivePath).replace(/\\/g, "/")
              : null;
            content = prependBrandingBanner(content, branding, logoRelativePath, { infoBlocks: relPath === "index.md" });
          } else {
            content = applyBrandingTokens(content, branding);
          }
          zip.add(archiveName, content, meta);
          continue;
        }

        if (fileName.endsWith(".json")) {
          // The shot list and the Learn record of an older lab may carry a connector's internal name; the copy shows the display name.
          let repairedText = null;
          try {
            const parsed = JSON.parse(readFileSync(fullPath, "utf-8"));
            const repaired = rewriteConnectorValue(parsed);
            if (JSON.stringify(repaired) !== JSON.stringify(parsed)) repairedText = `${JSON.stringify(repaired, null, 2)}\n`;
          } catch {
            // An unreadable file is copied as it is.
          }
          if (repairedText !== null) {
            zip.add(archiveName, repairedText, meta);
            continue;
          }
        }

        if (relPath.startsWith("assets/") && !relPath.slice("assets/".length).includes("/")) {
          if (typeof resolveAsset === "function") {
            const resolved = resolveAsset(generatedRoot, labId, fileName);
            if (resolved?.status === 200 && resolved.path && existsSync(resolved.path)) {
              zip.addFile(archiveName, resolved.path, meta);
              continue;
            }
          }
          const captured = resolveLabScreenshot(labDir, fileName);
          if (captured?.file && existsSync(captured.file)) {
            zip.addFile(archiveName, captured.file, meta);
            continue;
          }
        }

        zip.addFile(archiveName, fullPath, meta);
      }

      const htmlArchiveName = posix.join(labFolder, "index.html");
      const htmlLogoRel = logoArchivePath
        ? relative(dirname(htmlArchiveName), logoArchivePath).replace(/\\/g, "/")
        : null;
      const standaloneHtml = renderStandaloneLabHtml(applyBrandingToMarkdown(htmlSourceMd, branding), {
        title: found.manifest?.title || labId,
        labId,
        renderMarkdown: renderLabMarkdown,
        branding: buildHtmlBranding(branding, customizedBranding, htmlLogoRel),
      });
      zip.add(htmlArchiveName, standaloneHtml, labFileMeta("index.html", brandedLabTitle));

      // Build per-module folders (`NN <short title>/`) + sample files + `00 - Overview/` in the requested format(s).
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

      const docBranding = buildDocBranding(branding, customizedBranding, logoBuffer);
      const htmlBranding = buildHtmlBranding(branding, customizedBranding, inlineLogoUri);

      /** Writes the document in every requested format and returns the paths written, in format order. */
      const appendFormattedDocs = (folderRelPath, nameFor, docTitle, docMarkdown, topicContext = null, meta = {}) => {
        // DOCX, PDF, and HTML get the closing "More information" / "Need help?" blocks as Markdown;
        // PPTX renders the same content as a dedicated closing slide instead.
        const docMarkdownWithInfo = appendBrandInfo(docMarkdown, branding);
        const written = [];
        const put = (fmt, data) => written.push(zip.add(posix.join(labFolder, folderRelPath, nameFor(fmt)), data, { ...meta, kind: docKind(fmt), format: fmt }));
        if (selectedFormats.includes("docx")) {
          put("docx", renderMarkdownToDocxBuffer(docMarkdownWithInfo, {
            title: docTitle,
            branding: docBranding,
            resolveImageBuffer: resolveImgBuffer,
          }));
        }
        if (selectedFormats.includes("pptx")) {
          put("pptx", topicContext
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
              }));
        }
        if (selectedFormats.includes("pdf")) {
          put("pdf", renderMarkdownToPdfBuffer(docMarkdownWithInfo, {
            title: docTitle,
            branding: docBranding,
            resolveImageBuffer: resolveImgBuffer,
          }));
        }
        if (selectedFormats.includes("html")) {
          put("html", renderStandaloneLabHtml(docMarkdownWithInfo, {
            title: docTitle,
            labId,
            renderMarkdown: renderLabMarkdown,
            branding: htmlBranding,
            resolveImageSrc: resolveInlineImgUri,
          }));
        }
        return written;
      };

      // The overview table names the folders as this ZIP writes them.
      appendFormattedDocs(
        split.overview.folderName,
        (fmt) => `${sanitizeFilesystemTitle(split.overview.fileBaseName, "Lab Overview")}.${fmt}`,
        split.overview.title,
        split.renderOverviewMarkdown(folderNameOf),
        null,
        { group: "overview", title: split.overview.title },
      );

      const manifestMods = Array.isArray(effectiveManifest.modules) ? effectiveManifest.modules : [];
      const productsText = Array.isArray(effectiveManifest.products)
        ? effectiveManifest.products.join(", ")
        : "";

      const exportedModules = [];
      for (const mod of split.modules) {
        const mMeta =
          manifestMods.find((m) => Number(m.order) === Number(mod.order)) || {};
        const names = moduleNames.get(Number(mod.order));
        const moduleMeta = {
          group: "module",
          order: mod.order,
          stepLabel: mod.stepLabel,
          moduleTitle: mod.title,
          minutes: mMeta.minutes ?? null,
          folder: names.folder,
          title: `${mod.stepLabel} — ${mod.title}`,
        };
        const documents = appendFormattedDocs(
          names.folder,
          (fmt) => names.docName(fmt),
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
          moduleMeta,
        );

        const sampleFiles = buildModuleSampleFiles(mod.moduleInfo, {
          manifest: effectiveManifest,
          labTitle: brandedLabTitle,
          replacementEntries,
          fileNameMax: names.sampleNameMax,
        });
        const sampleFilePaths = [];
        for (const sample of sampleFiles) {
          const brandedSampleContent = applyBrandingTokens(sample.content, branding);
          sampleFilePaths.push(
            zip.add(posix.join(labFolder, names.folder, "sample-files", sample.filename), brandedSampleContent, {
              ...moduleMeta,
              kind: "Sample file",
              title: sample.description,
            }),
          );
        }

        exportedModules.push({
          order: mod.order,
          id: mod.id,
          stepLabel: mod.stepLabel,
          title: mod.title,
          isRecap: Boolean(mod.isRecap),
          minutes: mMeta.minutes ?? null,
          // The lab's own name for this module's documents (also the name of its cached files on disk), not a name in this ZIP.
          fileBaseName: mod.fileBaseName,
          folder: posix.join(labFolder, names.folder),
          documents,
          sampleFiles: sampleFilePaths,
        });
      }

      // Bundle dedicated Instructor / Facilitator Guide Pack inside `<lab folder>/Facilitator Guide/`
      const facilitatorModel = buildFacilitatorGuideModel({
        labId,
        labDir,
        manifest: effectiveManifest,
        markdown: htmlSourceMd,
        exportNames: moduleNames,
      });
      const facilitatorFolder = posix.join(labFolder, "Facilitator Guide");
      const facilitatorFiles = [];
      const addFacilitatorFile = (fmt, data) =>
        facilitatorFiles.push(
          zip.add(posix.join(facilitatorFolder, `Facilitator guide.${fmt}`), data, {
            group: "facilitator",
            kind: "Facilitator guide",
            format: fmt,
            title: `${brandedLabTitle} — Facilitator Guide`,
          }),
        );

      let facilitatorMd = renderFacilitatorGuideMarkdown(facilitatorModel);
      if (customizedBranding) {
        const facLogoRel = logoArchivePath
          ? relative(facilitatorFolder, logoArchivePath).replace(/\\/g, "/")
          : null;
        facilitatorMd = prependBrandingBanner(facilitatorMd, branding, facLogoRel);
      } else {
        facilitatorMd = applyBrandingTokens(facilitatorMd, branding);
      }
      addFacilitatorFile("md", facilitatorMd);

      if (selectedFormats.includes("docx")) {
        addFacilitatorFile("docx", renderFacilitatorGuideDocxBuffer(facilitatorModel, {
          title: `${brandedLabTitle} — Facilitator Guide`,
          branding: docBranding,
        }));
      }
      if (selectedFormats.includes("pdf")) {
        addFacilitatorFile("pdf", renderFacilitatorGuidePdfBuffer(facilitatorModel, {
          title: `${brandedLabTitle} — Facilitator Guide`,
          branding: docBranding,
        }));
      }
      if (selectedFormats.includes("html")) {
        addFacilitatorFile("html", renderFacilitatorGuideHtml(facilitatorModel, {
          branding: htmlBranding || { primaryColor: branding?.primaryColor },
        }));
      }

      // The one file that is safe to send to the customer: only the prerequisites, at the top of the archive.
      const checklistFormat = selectedFormats.includes("docx") ? "docx" : selectedFormats.includes("pdf") ? "pdf" : "html";
      const checklistModel = buildPrerequisitesChecklist({
        manifest: effectiveManifest,
        markdown: rawSourceMd,
        brand: customizedBranding ? branding : null,
        replacements,
      });
      const customerChecklistFile = zip.add(
        `Send to Customer - Prerequisites Checklist - ${labFolder}.${checklistFormat}`,
        checklistFormat === "docx"
          ? renderPrerequisitesChecklistDocxBuffer(checklistModel, { branding: docBranding })
          : checklistFormat === "pdf"
            ? renderPrerequisitesChecklistPdfBuffer(checklistModel, { branding: docBranding })
            : renderPrerequisitesChecklistHtml(checklistModel, { branding: htmlBranding || { primaryColor: branding?.primaryColor } }),
        { group: "customer", kind: "Prerequisites checklist (for the customer)", format: checklistFormat, title: checklistModel.title || `${brandedLabTitle} — Prerequisites checklist` },
      );

      // Everything for the administrator in one folder at the top of the archive, so it can be handed over on its
      // own: the Administrator setup guide and the Prerequisites checklist, in the requested formats plus Markdown.
      const adminFormats = ["docx", "pdf", "html"].filter((fmt) => selectedFormats.includes(fmt));
      if (!adminFormats.length) adminFormats.push("docx");
      const guideModel = buildAdministratorSetupGuide({
        manifest: effectiveManifest,
        markdown: rawSourceMd,
        brand: customizedBranding ? branding : null,
        replacements,
      });
      const adminFolderFiles = [];
      const addAdminFile = (fileName, data, kind, title) => {
        const format = fileName.split(".").pop();
        adminFolderFiles.push(zip.add(posix.join(ADMIN_FOLDER_NAME, fileName), data, { group: "administrator", kind, format, title }));
      };
      const htmlOptions = { branding: htmlBranding || { primaryColor: branding?.primaryColor } };
      for (const fmt of adminFormats) {
        addAdminFile(
          `Administrator setup guide.${fmt}`,
          fmt === "docx"
            ? renderAdministratorSetupGuideDocxBuffer(guideModel, { branding: docBranding })
            : fmt === "pdf"
              ? renderAdministratorSetupGuidePdfBuffer(guideModel, { branding: docBranding })
              : renderAdministratorSetupGuideHtml(guideModel, htmlOptions),
          "Administrator setup guide",
          guideModel.title || `${brandedLabTitle} — ${ADMIN_GUIDE_TITLE}`,
        );
      }
      addAdminFile("Administrator setup guide.md", renderAdministratorSetupGuideMarkdown(guideModel), "Administrator setup guide", guideModel.title || `${brandedLabTitle} — ${ADMIN_GUIDE_TITLE}`);
      for (const fmt of adminFormats) {
        addAdminFile(
          `Prerequisites checklist.${fmt}`,
          fmt === "docx"
            ? renderPrerequisitesChecklistDocxBuffer(checklistModel, { branding: docBranding })
            : fmt === "pdf"
              ? renderPrerequisitesChecklistPdfBuffer(checklistModel, { branding: docBranding })
              : renderPrerequisitesChecklistHtml(checklistModel, htmlOptions),
          "Prerequisites checklist",
          checklistModel.title || `${brandedLabTitle} — Prerequisites checklist`,
        );
      }
      addAdminFile("Prerequisites checklist.md", renderPrerequisitesChecklistMarkdown(checklistModel), "Prerequisites checklist", checklistModel.title || `${brandedLabTitle} — Prerequisites checklist`);

      // The pre-lab training decks, in the folder that sorts first. They are PowerPoint files, so they follow the formats asked for.
      let trainingExport = null;
      if (selectedFormats.includes("pptx")) {
        try {
          trainingExport = trainingZipEntries(labDir, {
            labId,
            markdown: htmlSourceMd,
            manifest: effectiveManifest,
            branding: docBranding,
            live: replacementEntries.length > 0 || customizedBranding,
          });
        } catch {
          trainingExport = null;
        }
        if (trainingExport) {
          const deckKinds = { complete: "Training deck (complete)", foundations: "Training deck (foundations)", topic: "Training deck" };
          for (const entry of trainingExport.entries) {
            const isDeck = entry.name.endsWith(".pptx");
            zip.add(entry.name, entry.data, {
              group: "training",
              kind: isDeck ? deckKinds[entry.kind] || "Training deck" : entry.kind || "Training notes",
              format: isDeck ? "pptx" : "md",
              title: entry.stepLabel ? `${entry.stepLabel} — ${entry.title}` : entry.title,
              order: entry.order ?? null,
              minutes: entry.minutes ?? null,
            });
          }
        }
      }

      const readme = renderBundleReadme({
        title: brandedLabTitle,
        brand: branding,
        formats: selectedFormats,
        modules: exportedModules,
        customerChecklistFile,
        hasAdministratorFolder: true,
        trainingDecks: trainingExport ? { folder: TRAINING_ZIP_FOLDER, minutes: trainingExport.summary.totalMinutes } : null,
        labFolder,
        contents: renderContentsMarkdown(zip.entries, { labFolder }),
      });
      zip.add("README.md", readme, { group: "readme", kind: "Guide", format: "md", title: "README" });

      const manifest = {
        exportedAt: new Date().toISOString(),
        source: "generated",
        labs: [labId],
        title: brandedLabTitle,
        formats: selectedFormats,
        labFolder,
        zipFileName,
        overviewFolder: posix.join(labFolder, split.overview.folderName),
        trainingDecksFolder: trainingExport ? TRAINING_ZIP_FOLDER : null,
        trainingDecks: trainingExport ? trainingExport.files : [],
        trainingMinutes: trainingExport ? trainingExport.summary.totalMinutes : null,
        administratorFolder: ADMIN_FOLDER_NAME,
        administratorFiles: adminFolderFiles,
        facilitatorGuideFolder: facilitatorFolder,
        facilitatorGuideFiles: facilitatorFiles,
        customerPrerequisitesChecklist: customerChecklistFile,
        modules: exportedModules,
        customized: replacementEntries.length > 0 || customizedBranding,
        branding: buildManifestBranding(branding, logoArchivePath),
        // Added with the path budget: what the ZIP held to, and every short path with its full title.
        pathBudget: zip.budgetReport(),
        index: buildIndexRows(zip.entries),
      };
      summary = { labFolder, zipFileName, entryCount: zip.guard.count + 1, longestEntry: zip.guard.longest, warnings: zip.guard.warnings };
      zip.add("export-manifest.json", JSON.stringify(manifest, null, 2), { group: "readme", kind: "Data", format: "json", title: "Export manifest" });

      archive.finalize();
    } catch (err) {
      archive.abort();
      reject(err);
    }
  });
}
