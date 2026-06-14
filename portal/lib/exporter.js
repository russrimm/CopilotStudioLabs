/**
 * Lab export — generates ZIP bundles of selected labs with customized content.
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import archiver from "archiver";
import { getLabPath } from "./labs.js";

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
  return new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.on("error", reject);
    archive.on("end", () => resolve({ bytes: archive.pointer(), labCount: labIds.length }));

    archive.pipe(outputStream);

    const replacementEntries = Object.entries(replacements).filter(([k, v]) => k && v && k !== v);

    for (const labId of labIds) {
      const labDir = getLabPath(labId);
      if (!existsSync(labDir)) continue;

      if (replacementEntries.length > 0) {
        // Add non-.md files as-is
        archive.directory(labDir, labId, (entry) => {
          return entry.name.endsWith(".md") ? false : entry;
        });

        // Process .md files with text replacements
        for (const mdFile of findMdFiles(labDir)) {
          let content = readFileSync(mdFile, "utf-8");
          for (const [search, replace] of replacementEntries) {
            content = content.split(search).join(replace);
          }
          const relativePath = mdFile.replace(labDir, "").replace(/^[/\\]/, "");
          archive.append(content, { name: join(labId, relativePath) });
        }
      } else {
        archive.directory(labDir, labId);
      }
    }

    // Add a manifest
    const manifest = {
      exportedAt: new Date().toISOString(),
      labs: labIds,
      customized: replacementEntries.length > 0,
    };
    archive.append(JSON.stringify(manifest, null, 2), { name: "export-manifest.json" });

    archive.finalize();
  });
}
