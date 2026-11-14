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

const SAFE_GENERATED_LAB_ID = /^[a-z0-9][a-z0-9-]{0,99}$/i;

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
 * Create a ZIP archive of a single generated lab, resolving captured assets
 * when available and applying custom branding when configured.
 */
export function exportGeneratedLab(
  generatedRoot,
  rawLabId,
  replacements = {},
  outputStream,
  { resolveAsset, branding = loadBranding(), logoSourcePath: explicitLogoPath } = {},
) {
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
          walkLab(fullPath);
          continue;
        }
        if (!stats.isFile()) continue;

        const relPath = relative(labDir, fullPath).replace(/\\/g, "/");
        const archiveName = posix.join(labId, relPath);

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

        if (relPath.startsWith("assets/") && !relPath.slice("assets/".length).includes("/") && typeof resolveAsset === "function") {
          const resolved = resolveAsset(generatedRoot, labId, entry.name);
          if (resolved?.status === 200 && resolved.path && existsSync(resolved.path)) {
            archive.file(resolved.path, { name: archiveName });
            continue;
          }
        }

        archive.file(fullPath, { name: archiveName });
      }
    }

    walkLab(labDir);

    const manifest = {
      exportedAt: new Date().toISOString(),
      source: "generated",
      labs: [labId],
      title: found.manifest?.title || labId,
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
