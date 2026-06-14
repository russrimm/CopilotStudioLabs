import { readFileSync, existsSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { discoverLabs } from "./labs.js";

const LABS_DIR = resolve(import.meta.dirname, "..", "..", "labs");
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i;
const TODO_RE = /\b(?:TODO|FIXME|TBD|XXX)\b/i;

function extractMeta(content, label) {
  const re = new RegExp(`\\|[^|]*\\*\\*${label}\\*\\*[^|]*\\|\\s*(.+?)\\s*\\|`, "i");
  const match = content.match(re);
  return match ? match[1].trim() : "";
}

function extractTitle(content) {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].replace(/^[^\w]*/, "").trim() : "Untitled Lab";
}

function getHeadings(content) {
  const headings = [];
  const re = /^(#{1,6})\s+(.+?)\s*$/gm;
  let match;

  while ((match = re.exec(content))) {
    headings.push({
      level: match[1].length,
      text: match[2].trim(),
      start: match.index,
      end: re.lastIndex,
    });
  }

  return headings;
}

function stripSectionScaffolding(content) {
  return content
    .replace(/^\s*(?:[-*_]\s*){3,}\s*$/gm, "")
    .trim();
}

function parseImageRefs(content) {
  const refs = [];
  const re = /!\[[^\]]*]\(([^)]+)\)/g;
  let match;

  while ((match = re.exec(content))) {
    let ref = match[1].trim().replace(/^<|>$/g, "");
    const titled = ref.match(/^(.*?)(?:\s+["'][^"']*["'])$/);
    if (titled) ref = titled[1].trim();
    ref = ref.split("#")[0].split("?")[0].trim();

    if (!ref || /^(?:https?:|data:|mailto:)/i.test(ref)) continue;
    refs.push(ref.replace(/\//g, "\\"));
  }

  return refs;
}

function resolveLabPath(labId, relativePath) {
  const normalized = relativePath.replace(/\//g, "\\");
  return resolve(join(LABS_DIR, labId), normalized);
}

function collectAssetFiles(labDir) {
  const assetsDir = join(labDir, "assets");
  if (!existsSync(assetsDir)) return [];

  const files = [];

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;

      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }

      files.push(full.slice(labDir.length + 1).replace(/\//g, "\\"));
    }
  }

  walk(assetsDir);
  return files;
}

function buildResult(labId, title, tests) {
  const passed = tests.filter((test) => test.status === "pass").length;
  const failed = tests.filter((test) => test.status === "fail").length;
  const warnings = tests.filter((test) => test.status === "warn").length;

  return {
    labId,
    title,
    passed,
    failed,
    warnings,
    total: tests.length,
    tests,
    timestamp: new Date().toISOString(),
  };
}

function missingIndexResult(labId, title) {
  const tests = [
    { name: "index-exists", status: "fail", message: "index.md is missing." },
    { name: "has-title", status: "fail", message: "Cannot inspect title because index.md is missing." },
    { name: "has-metadata-table", status: "fail", message: "Cannot inspect metadata because index.md is missing." },
    { name: "has-difficulty", status: "fail", message: "Cannot inspect DIFFICULTY because index.md is missing." },
    { name: "has-time", status: "fail", message: "Cannot inspect TIME because index.md is missing." },
    { name: "has-products", status: "fail", message: "Cannot inspect PRODUCTS because index.md is missing." },
    { name: "has-tags", status: "fail", message: "Cannot inspect TAGS because index.md is missing." },
    { name: "has-industry", status: "fail", message: "Cannot inspect INDUSTRY/INDUSTRIES because index.md is missing." },
    { name: "has-overview", status: "fail", message: "Cannot inspect overview because index.md is missing." },
    { name: "has-objectives", status: "fail", message: "Cannot inspect objectives because index.md is missing." },
    { name: "has-steps", status: "fail", message: "Cannot inspect step headings because index.md is missing." },
    { name: "min-length", status: "fail", message: "Cannot inspect content length because index.md is missing." },
    { name: "no-todo-markers", status: "fail", message: "Cannot inspect TODO markers because index.md is missing." },
    { name: "no-broken-image-refs", status: "fail", message: "Cannot inspect image references because index.md is missing." },
    { name: "no-empty-sections", status: "fail", message: "Cannot inspect sections because index.md is missing." },
    { name: "screenshots-exist", status: "fail", message: "Cannot inspect screenshots because index.md is missing." },
  ];

  const assets = collectAssetFiles(join(LABS_DIR, labId));
  tests.push({
    name: "assets-dir-clean",
    status: assets.length ? "warn" : "pass",
    message: assets.length
      ? `${assets.length} asset file(s) found but lab content is unavailable to verify references.`
      : "No assets directory content to review.",
  });

  return buildResult(labId, title, tests);
}

export function validateLab(labId) {
  const knownLab = discoverLabs().find((lab) => lab.id === labId);
  const title = knownLab?.title || labId;
  const labDir = join(LABS_DIR, labId);

  if (!existsSync(labDir)) {
    throw new Error(`Lab not found: ${labId}`);
  }

  const indexPath = join(labDir, "index.md");
  if (!existsSync(indexPath)) {
    return missingIndexResult(labId, title);
  }

  const content = readFileSync(indexPath, "utf-8");
  const finalTitle = extractTitle(content) || title;
  const tests = [];
  const headings = getHeadings(content);
  const metadataRows = content.split(/\r?\n/).filter((line) => /^\|.*\|\s*$/.test(line));
  const difficulty = extractMeta(content, "DIFFICULTY");
  const time = extractMeta(content, "TIME");
  const products = extractMeta(content, "PRODUCTS");
  const tags = extractMeta(content, "TAGS");
  const industry = extractMeta(content, "INDUSTRIES") || extractMeta(content, "INDUSTRY");
  const imageRefs = parseImageRefs(content);
  const brokenImageRefs = imageRefs.filter((ref) => !existsSync(resolveLabPath(labId, ref)));
  const assetFiles = collectAssetFiles(labDir);
  const referencedAssets = new Set(
    imageRefs
      .map((ref) => ref.replace(/\//g, "\\").replace(/^\.\\/g, ""))
      .filter((ref) => ref.toLowerCase().startsWith("assets\\"))
  );
  const orphanedAssets = assetFiles.filter((file) => !referencedAssets.has(file));
  const unexpectedAssets = assetFiles.filter((file) => !IMAGE_EXT_RE.test(file));
  const emptySections = headings.filter((heading, index) => {
    const nextHeading = headings[index + 1];
    const nextHeadingStart = nextHeading?.start ?? content.length;
    const sectionContent = stripSectionScaffolding(content.slice(heading.end, nextHeadingStart));
    // A section with a child heading (deeper level) is NOT empty — it's a parent container
    if (nextHeading && nextHeading.level > heading.level) return false;
    return sectionContent.length === 0;
  });
  const contentLength = content.replace(/\s+/g, " ").trim().length;
  const stepHeadings = headings.slice(1).filter((heading) => /(?:\b(?:step|chapter|part|use case)\b|(?:^|\s)#?\d+\b)/i.test(heading.text));

  tests.push({
    name: "index-exists",
    status: "pass",
    message: "index.md is present.",
  });
  tests.push({
    name: "has-title",
    status: headings.some((heading) => heading.level === 1) ? "pass" : "fail",
    message: headings.some((heading) => heading.level === 1)
      ? `Found H1 title: ${finalTitle}.`
      : "Missing H1 title heading.",
  });
  tests.push({
    name: "has-metadata-table",
    status: metadataRows.length >= 3 ? "pass" : "fail",
    message: metadataRows.length >= 3
      ? `Found ${metadataRows.length} metadata table row(s).`
      : "Missing pipe-separated metadata table.",
  });
  tests.push({
    name: "has-difficulty",
    status: difficulty ? "pass" : "fail",
    message: difficulty ? `DIFFICULTY = ${difficulty}.` : "Missing DIFFICULTY value.",
  });
  tests.push({
    name: "has-time",
    status: time ? "pass" : "fail",
    message: time ? `TIME = ${time}.` : "Missing TIME value.",
  });
  tests.push({
    name: "has-products",
    status: products ? "pass" : "fail",
    message: products ? `PRODUCTS = ${products}.` : "Missing PRODUCTS value.",
  });
  tests.push({
    name: "has-tags",
    status: tags ? "pass" : "fail",
    message: tags ? `TAGS = ${tags}.` : "Missing TAGS value.",
  });
  tests.push({
    name: "has-industry",
    status: industry ? "pass" : "fail",
    message: industry ? `INDUSTRY = ${industry}.` : "Missing INDUSTRY or INDUSTRIES field.",
  });
  const overviewRe = /^##+\s+.*(?:overview|why this lab|why .+ cares|introduction|about this lab).*$/im;
  tests.push({
    name: "has-overview",
    status: overviewRe.test(content) ? "pass" : "fail",
    message: overviewRe.test(content)
      ? "Overview section found."
      : "Missing Overview section heading.",
  });
  const objectivesRe = /^##+\s+.*(?:objectives?|what you will (?:learn|do|build)|what you'?ll (?:learn|do|build)).*$/im;
  tests.push({
    name: "has-objectives",
    status: objectivesRe.test(content) ? "pass" : "fail",
    message: objectivesRe.test(content)
      ? "Objectives section found."
      : "Missing Objectives section heading.",
  });
  tests.push({
    name: "has-steps",
    status: stepHeadings.length ? "pass" : "fail",
    message: stepHeadings.length
      ? `Found ${stepHeadings.length} step/chapter/numbered heading(s).`
      : "Missing step, chapter, part, or numbered task headings.",
  });
  tests.push({
    name: "min-length",
    status: contentLength >= 500 ? "pass" : "fail",
    message: contentLength >= 500
      ? `Content length is ${contentLength} characters.`
      : `Content is only ${contentLength} characters; expected at least 500.`,
  });
  tests.push({
    name: "no-todo-markers",
    status: TODO_RE.test(content) ? "fail" : "pass",
    message: TODO_RE.test(content)
      ? "Found TODO/FIXME/TBD/XXX marker(s) in content."
      : "No TODO-style markers found.",
  });
  tests.push({
    name: "no-broken-image-refs",
    status: brokenImageRefs.length ? "fail" : "pass",
    message: brokenImageRefs.length
      ? `Missing image file(s): ${brokenImageRefs.join(", ")}.`
      : imageRefs.length
      ? `Validated ${imageRefs.length} image reference(s).`
      : "No local image references found.",
  });
  tests.push({
    name: "no-empty-sections",
    status: emptySections.length ? "fail" : "pass",
    message: emptySections.length
      ? `Empty section(s): ${emptySections.map((section) => section.text).join(", ")}.`
      : `All ${headings.length} heading section(s) contain content.`,
  });
  tests.push({
    name: "screenshots-exist",
    status: brokenImageRefs.length ? "fail" : "pass",
    message: brokenImageRefs.length
      ? `${brokenImageRefs.length} referenced screenshot/image file(s) are missing.`
      : imageRefs.length
      ? `All ${imageRefs.length} referenced screenshot/image file(s) exist.`
      : "No screenshots referenced in markdown.",
  });

  const orphanedImages = orphanedAssets.filter(
    (file) => IMAGE_EXT_RE.test(file) && !file.includes("\\images\\")
  );
  if (orphanedImages.length) {
    tests.push({
      name: "assets-dir-clean",
      status: "warn",
      message: `${orphanedImages.length} unreferenced image file(s) found in assets/.`,
    });
  } else {
    tests.push({
      name: "assets-dir-clean",
      status: "pass",
      message: assetFiles.length
        ? `All ${assetFiles.length} asset file(s) accounted for.`
        : "No assets directory files found.",
    });
  }

  return buildResult(labId, finalTitle, tests);
}

export function validateAllLabs() {
  const labs = discoverLabs();
  const results = labs.map((lab) => validateLab(lab.id));

  return {
    summary: {
      total: results.length,
      passed: results.filter((result) => result.failed === 0).length,
      failed: results.filter((result) => result.failed > 0).length,
      warnings: results.filter((result) => result.warnings > 0).length,
    },
    labs: results,
    timestamp: new Date().toISOString(),
  };
}
