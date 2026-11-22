/**
 * After-the-run integrity checks for the concurrency harness. Each check returns { name, ok, detail } and never throws, so
 * one broken file cannot hide the others. They read the throwaway storage folder the run used, after the server stopped.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { checkDocxPackage, checkPptxPackage } from "../../../tools/lab-builder/lib/ooxml-strict.mjs";

function walk(dir, visit, { skipDirs = [] } = {}) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.includes(entry.name)) continue;
      walk(full, visit, { skipDirs });
    } else {
      visit(full);
    }
  }
}

const result = (name, problems, okDetail = "") => ({ name, ok: problems.length === 0, detail: problems.length ? problems.slice(0, 8).join("; ") + (problems.length > 8 ? ` (+${problems.length - 8} more)` : "") : okDetail });

/** Every JSON file under the storage root parses. */
export function jsonFilesParse(storageRoot) {
  const problems = [];
  let count = 0;
  walk(storageRoot, (file) => {
    if (!file.endsWith(".json")) return;
    count += 1;
    try {
      JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      problems.push(`${path.relative(storageRoot, file)}: ${err.message}`);
    }
  });
  return result("every JSON file parses", problems, `${count} files`);
}

/** No temp, lock, or staging leftovers remain once the server is idle. */
export function noTempLeftovers(storageRoot) {
  const problems = [];
  walk(storageRoot, (file) => {
    const name = path.basename(file);
    if (/\.blob-tmp-|\.tmp$|\.stale-|^\.building$|\.trash-/.test(name) || file.includes(`${path.sep}.trash`)) problems.push(path.relative(storageRoot, file));
  });
  return result("no .tmp or .blob-tmp leftovers", problems, "none");
}

/** Every lab folder has a readable manifest and a non-empty index.md, and nothing is half built. */
export function labFoldersValid(generatedDir) {
  const problems = [];
  let count = 0;
  let names = [];
  try {
    names = fs.readdirSync(generatedDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith("."));
  } catch {
    /* no labs at all */
  }
  for (const entry of names) {
    count += 1;
    const dir = path.join(generatedDir, entry.name);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
      if (!manifest || typeof manifest.title !== "string" || !manifest.title) problems.push(`${entry.name}: manifest has no title`);
      if (fs.statSync(path.join(dir, "index.md")).size === 0) problems.push(`${entry.name}: index.md is empty`);
      if (fs.existsSync(path.join(dir, ".building"))) problems.push(`${entry.name}: still marked as building`);
    } catch (err) {
      problems.push(`${entry.name}: ${err.message}`);
    }
  }
  return result("every lab folder has a valid manifest and index.md", problems, `${count} labs`);
}

/** The lab ids the run was told about match the folders on disk, and no id was handed to a second build while the first still existed. */
export function labIdsMatch({ generatedDir, duplicates, expectedIds }) {
  const problems = [];
  for (const id of duplicates) problems.push(`lab id ${id} was handed to a second build while the first still existed`);
  let onDisk = [];
  try {
    onDisk = fs.readdirSync(generatedDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  } catch {
    /* none */
  }
  const disk = new Set(onDisk);
  for (const id of expectedIds) if (!disk.has(id)) problems.push(`${id} was reported built but is not on disk`);
  for (const id of disk) if (!expectedIds.has(id)) problems.push(`${id} is on disk but nothing reported it`);
  return result("lab ids are unique and the counts add up", problems, `${expectedIds.size} labs`);
}

/** A bundle ZIP is not an Office package, so it is checked as an archive: the central directory is readable and every entry inflates. */
export function zipArchiveProblems(buffer) {
  const problems = [];
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return ["no end-of-archive record"];
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) return [...problems, `entry ${i} has a bad directory record`];
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    try {
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const data = buffer.subarray(start, start + compressed);
      if (method === 8) zlib.inflateRawSync(data);
    } catch (err) {
      problems.push(`${name}: ${err.message}`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return problems;
}

/** Every exported Word, PowerPoint, and ZIP file passes the strict Open XML checks. */
export function officeFilesValid(files) {
  const problems = [];
  let count = 0;
  for (const { file, kind, label } of files) {
    try {
      const bytes = fs.readFileSync(file);
      count += 1;
      let found = [];
      if (kind === "docx") found = checkDocxPackage(bytes);
      else if (kind === "pptx") found = checkPptxPackage(bytes);
      else if (kind === "zip") found = zipArchiveProblems(bytes);
      for (const p of found.slice(0, 2)) problems.push(`${label}: ${p}`);
    } catch (err) {
      problems.push(`${label}: ${err.message}`);
    }
  }
  return result("every exported docx, pptx, and zip is valid", problems, `${count} files`);
}

/** No person's responses contain another person's tokens. */
export function noCrossUserData(observations) {
  const problems = [];
  for (const { user, tokens, bodyText, where } of observations) {
    for (const token of tokens) if (bodyText.includes(token)) problems.push(`${where}: user ${user} saw ${token}`);
  }
  return result("no cross-user data in anyone's responses", problems, `${observations.length} responses checked`);
}
