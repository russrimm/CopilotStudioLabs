/**
 * Lab discovery and metadata extraction.
 *
 * Scans the labs/ directory, parses each index.md for its metadata table,
 * and returns structured lab objects for the portal API.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, resolve } from "path";

const LABS_DIR = resolve(import.meta.dirname, "..", "..", "labs");

/** Extract the value from a Markdown metadata‐table row like `| ⭐ **DIFFICULTY** | Intermediate |` */
function extractMeta(content, label) {
  const re = new RegExp(`\\|[^|]*\\*\\*${label}\\*\\*[^|]*\\|\\s*(.+?)\\s*\\|`, "i");
  const m = content.match(re);
  return m ? m[1].trim() : null;
}

/** Extract the first H1 heading */
function extractTitle(content) {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].replace(/^[^\w]*/, "").trim() : "Untitled Lab";
}

/** Extract the overview/description paragraph (first paragraph after ## Overview) */
function extractOverview(content) {
  const m = content.match(/## Overview\s*\n\n([\s\S]*?)(?:\n\n---|\n\n##)/);
  if (m) return m[1].trim().split("\n")[0];
  // fallback: first paragraph after front-matter table
  const fallback = content.match(/\|\s*\n\n---\s*\n\n([\s\S]*?)(?:\n\n---|\n\n##)/);
  return fallback ? fallback[1].trim().split("\n")[0] : "";
}

/** List image files in a lab's assets folder */
function listImages(labDir) {
  const assetsDir = join(labDir, "assets");
  if (!existsSync(assetsDir)) return [];
  return readdirSync(assetsDir)
    .filter((f) => /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(f))
    .map((f) => join("assets", f));
}

/** List all .md files in the lab directory (recursive) */
function listDocs(labDir) {
  const results = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) results.push(full);
    }
  }
  walk(labDir);
  return results;
}

/**
 * Discover all labs and return structured metadata.
 * @returns {Array<Object>} Array of lab metadata objects
 */
export function discoverLabs() {
  if (!existsSync(LABS_DIR)) return [];

  const labs = readdirSync(LABS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => {
      const labDir = join(LABS_DIR, d.name);
      const indexPath = join(labDir, "index.md");

      if (!existsSync(indexPath)) {
        return { id: d.name, title: d.name, available: false };
      }

      const content = readFileSync(indexPath, "utf-8");
      const title = extractTitle(content);
      const difficulty = extractMeta(content, "DIFFICULTY");
      const time = extractMeta(content, "TIME");
      const products = extractMeta(content, "PRODUCTS");
      const tags = extractMeta(content, "TAGS");
      const industry = extractMeta(content, "INDUSTRIES") || extractMeta(content, "INDUSTRY");
      const status = extractMeta(content, "STATUS");
      const overview = extractOverview(content);
      const images = listImages(labDir);
      const docs = listDocs(labDir).map((f) => f.replace(labDir + "\\", "").replace(labDir + "/", ""));

      // Get folder size
      let sizeBytes = 0;
      function walkSize(dir) {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walkSize(full);
          else sizeBytes += statSync(full).size;
        }
      }
      walkSize(labDir);

      return {
        id: d.name,
        title,
        overview,
        difficulty: difficulty || "Unknown",
        time: time || "Unknown",
        products: products || "",
        tags: tags ? tags.split(",").map((t) => t.trim()) : [],
        industry: industry || "General",
        status: status || "Active",
        images,
        docs,
        sizeBytes,
        available: true,
      };
    });

  return labs;
}

/**
 * Get full Markdown content for a specific lab.
 * @param {string} labId - The lab folder name
 * @returns {string|null} The index.md content or null
 */
export function getLabContent(labId) {
  const indexPath = join(LABS_DIR, labId, "index.md");
  if (!existsSync(indexPath)) return null;
  return readFileSync(indexPath, "utf-8");
}

/**
 * Get the absolute path to a lab directory.
 * @param {string} labId - The lab folder name
 * @returns {string} Absolute path
 */
export function getLabPath(labId) {
  return join(LABS_DIR, labId);
}
