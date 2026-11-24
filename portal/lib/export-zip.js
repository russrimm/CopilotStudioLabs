/**
 * The one writer every lab ZIP goes through. It wraps the archive so that no entry can be added without passing the path
 * guard (see export-names.js), and it records what each entry is (its full title, kind, format, module order, minutes),
 * which is what the README contents and the `index` in export-manifest.json are built from.
 */

import { ZipArchive } from "archiver";
import { createZipPathGuard, resolveExportBudget } from "./export-names.js";
import { containsEmoji, plainText } from "./lab-builder/plain-text.js";

const TEXT_ENTRY = /\.(md|markdown|txt|csv|json|html?)$/i;
const HTML_ENTRY = /\.html?$/i;

/** Text entries leave the archive as plain text: the last place a symbol from any source can be taken out. */
function plainEntry(name, data) {
  if (!TEXT_ENTRY.test(name)) return data;
  const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : null;
  if (text === null || !containsEmoji(text)) return data;
  const clean = plainText(text, { html: HTML_ENTRY.test(name) });
  return Buffer.isBuffer(data) ? Buffer.from(clean, "utf8") : clean;
}

/**
 * @param {object} [options]
 * @param {object} [options.budget]   from resolveExportBudget()
 * @param {boolean} [options.strict]  throw on a path over budget instead of shortening it (default: only under `node --test`)
 * @param {number} [options.level]    zlib level
 */
export function createExportZip({ budget = resolveExportBudget(), strict, level = 9 } = {}) {
  const archive = new ZipArchive({ zlib: { level } });
  const guard = createZipPathGuard({ budget, strict });
  const entries = [];

  return {
    archive,
    budget,
    guard,
    /** Every entry added so far: `{path, ...meta}` in the order added. */
    entries,
    /** Add in-memory content. Returns the path actually written. */
    add(name, data, meta = {}) {
      const path = guard.claim(name);
      archive.append(plainEntry(path, data), { name: path });
      entries.push({ path, ...meta });
      return path;
    },
    /** Add a file from disk. Returns the path actually written. */
    addFile(name, file, meta = {}) {
      const path = guard.claim(name);
      archive.file(file, { name: path });
      entries.push({ path, ...meta });
      return path;
    },
    /** Add a folder entry (an empty `assets/`, say). */
    addDirectory(name) {
      const path = guard.claim(name);
      archive.append(null, { name: `${path}/` });
      return path;
    },
    /** What the manifest records about the budget. */
    budgetReport() {
      return {
        entryMax: budget.entryMax,
        entryTarget: budget.entryTarget,
        zipNameMax: budget.zipNameMax,
        entryCount: guard.count,
        longestEntry: guard.longest,
        entriesOverTarget: entries.filter((entry) => entry.path.length > budget.entryTarget).length,
        warnings: guard.warnings,
      };
    },
  };
}
