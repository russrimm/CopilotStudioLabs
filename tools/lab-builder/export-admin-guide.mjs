#!/usr/bin/env node
/**
 * Export a generated lab's Administrator setup guide by itself: every administrator setting the lab needs
 * (connectors, data policies, environment, tenant, identity, and cloud settings), grouped by role and in the
 * order of work. Learner guides never list these settings.
 *
 *   node tools/lab-builder/export-admin-guide.mjs --lab my-lab-slug
 *   node tools/lab-builder/export-admin-guide.mjs --lab my-lab-slug --format pdf --out guide.pdf
 *   node tools/lab-builder/export-admin-guide.mjs --lab path/to/lab-folder --format html --out -
 *
 * It is the same document as "Download administrator setup guide" in the portal (GET
 * /api/lab-builder/generated/:labId/export?format=admin-guide-docx). It reads the lab's manifest.json and
 * index.md, so labs built before this document existed work too. Nothing is written to the lab and nothing
 * is fetched. The lab's own brand (logo, company name, colors) is applied when the lab has one.
 *
 * Flags:
 *   --lab <id|folder>        a generated lab's id (under --root) or the path of its folder (required)
 *   --root <dir>             the folder that holds generated labs (default: generated-labs/)
 *   --format <docx|pdf|html|md>   default docx
 *   --out <file|dir|->       where to write (default: "<Lab title> - Administrator setup guide.<ext>" in the
 *                            current folder; "-" writes to standard output)
 *   --help
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const lib = (name) => import(pathToFileURL(path.join(REPO_ROOT, "portal", "lib", name)).href);

const { ADMIN_GUIDE_FORMATS, normalizeAdminGuideFormat, renderAdministratorSetupGuideFile } = await lib("lab-builder/admin-guide-render.js");
const { shortenDownloadFileName } = await lib("export-names.js");

const FLAGS = new Set(["lab", "root", "format", "out", "help"]);
const SAFE_LAB_ID = /^[a-z0-9][a-z0-9-]{0,99}$/i;

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument "${token}".`);
    const eq = token.indexOf("=");
    const key = eq > -1 ? token.slice(2, eq) : token.slice(2);
    if (!FLAGS.has(key)) throw new Error(`Unknown flag --${key}. Run with --help.`);
    if (key === "help") {
      out.help = true;
      continue;
    }
    const value = eq > -1 ? token.slice(eq + 1) : argv[(i += 1)];
    if (value === undefined || (eq === -1 && value.startsWith("--") && value !== "--")) throw new Error(`--${key} needs a value.`);
    out[key] = value;
  }
  return out;
}

function usage() {
  return `Export a generated lab's Administrator setup guide by itself.

Usage:
  node tools/lab-builder/export-admin-guide.mjs --lab <id|folder> [flags]

Flags:
  --lab <id|folder>         a generated lab's id (under --root) or the path of its folder (required)
  --root <dir>              the folder that holds generated labs (default: generated-labs/)
  --format <docx|pdf|html|md>  default docx
  --out <file|dir|->        where to write (default: a descriptive file name in the current folder;
                            "-" writes to standard output)
  --help                    show this message`;
}

function findLabFolder(lab, root) {
  const asPath = path.resolve(lab);
  if (fs.existsSync(path.join(asPath, "index.md")) && fs.existsSync(path.join(asPath, "manifest.json"))) return asPath;
  if (!SAFE_LAB_ID.test(lab)) throw new Error(`"${lab}" is neither a lab folder nor a lab id.`);
  const dir = path.resolve(root, lab);
  if (!fs.existsSync(path.join(dir, "index.md")) || !fs.existsSync(path.join(dir, "manifest.json"))) {
    throw new Error(`No generated lab "${lab}" was found in ${root}.`);
  }
  return dir;
}

let flags;
try {
  flags = parse(process.argv.slice(2));
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
if (flags.help) {
  console.log(usage());
  process.exit(0);
}

try {
  if (!flags.lab) throw new Error("--lab is required. Run with --help.");
  const format = normalizeAdminGuideFormat(flags.format ?? "docx");
  if (!format) throw new Error(`--format must be one of ${ADMIN_GUIDE_FORMATS.join(", ")}.`);
  const root = flags.root ? path.resolve(flags.root) : path.join(REPO_ROOT, "generated-labs");
  const labDir = findLabFolder(flags.lab, root);
  const manifest = JSON.parse(fs.readFileSync(path.join(labDir, "manifest.json"), "utf8"));
  const markdown = fs.readFileSync(path.join(labDir, "index.md"), "utf8");
  const result = renderAdministratorSetupGuideFile({ manifest, markdown, format });
  if (result.status !== 200) throw new Error(result.error);
  const data = result.buffer ?? Buffer.from(result.text, "utf8");
  // A name that stays within 120 characters, so saving into a deep folder works.
  const defaultName = shortenDownloadFileName(`${result.baseName}.${result.ext}`);

  if (flags.out === "-") {
    process.stdout.write(data);
  } else {
    let file = path.resolve(flags.out || defaultName);
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, defaultName);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
    console.error(`${result.model.itemCount} items for ${result.model.roles.length} roles.\nWrote ${path.relative(process.cwd(), file) || file}`);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
