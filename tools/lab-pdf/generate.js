#!/usr/bin/env node

import { createRequire } from "module";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { marked } from "marked";

const require = createRequire(import.meta.url);
const toolRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(toolRoot, "..", "..");
const labsRoot = join(repoRoot, "labs");
const defaultOutDir = join(repoRoot, "dist", "lab-pdfs");

function usage() {
  console.log(`Usage: node generate.js [options]\n\nOptions:\n  --lab=<lab-id>    Generate one lab only\n  --out=<dir>       Output directory (default: dist/lab-pdfs/)\n  --help            Show this help\n\nExamples:\n  node generate.js\n  node generate.js --lab=06-energy-weather-agent\n  node generate.js --out=dist/custom-pdfs`);
}

function parseArgs(argv) {
  const args = { lab: null, out: defaultOutDir, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--lab") {
      args.lab = argv[index + 1] || null;
      index += 1;
    } else if (arg.startsWith("--lab=")) {
      args.lab = arg.slice("--lab=".length);
    } else if (arg === "--out") {
      args.out = argv[index + 1] || defaultOutDir;
      index += 1;
    } else if (arg.startsWith("--out=")) {
      args.out = arg.slice("--out=".length);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  args.out = isAbsolute(args.out) ? args.out : resolve(repoRoot, args.out);
  return args;
}

function loadPlaywright() {
  const siblingPlaywright = join(repoRoot, "tools", "screenshot-capture", "node_modules", "playwright");
  try {
    return require(siblingPlaywright);
  } catch {
    return require("playwright");
  }
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function slugify(text, usedSlugs) {
  const base = text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-") || "section";
  let slug = base;
  let suffix = 2;
  while (usedSlugs.has(slug)) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
  usedSlugs.add(slug);
  return slug;
}

function textFromTokens(tokens = []) {
  return tokens.map((token) => {
    if (token.text) return token.text;
    if (token.tokens) return textFromTokens(token.tokens);
    return token.raw || "";
  }).join("");
}

function renderMarkdown(markdown) {
  const toc = [];
  const usedSlugs = new Set();
  const renderer = new marked.Renderer();

  renderer.heading = (token) => {
    const text = textFromTokens(token.tokens).trim() || token.text || "Section";
    const id = slugify(text, usedSlugs);
    if (token.depth === 2 || token.depth === 3) {
      toc.push({ id, depth: token.depth, text });
    }
    return `<h${token.depth} id="${id}">${marked.parseInline(token.text || text)}</h${token.depth}>`;
  };

  const html = marked.parse(markdown, { renderer, mangle: false, headerIds: false });
  return { html, toc };
}

function getTitle(markdown, labId) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : labId;
}

function parseAttributes(tag) {
  const attrs = new Map();
  const attrPattern = /([:\w-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
  let match;
  while ((match = attrPattern.exec(tag))) {
    const name = match[1].toLowerCase();
    let value = match[2] || "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    attrs.set(name, value);
  }
  return attrs;
}

function decodeAttribute(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function splitUrlSuffix(url) {
  const match = String(url).match(/^([^?#]*)([?#].*)?$/);
  return { pathPart: match?.[1] || "", suffix: match?.[2] || "" };
}

function resolveImagePath(src, labRoot) {
  if (!src || /^(?:[a-z][a-z\d+.-]*:|\/\/|#|data:)/i.test(src)) {
    return null;
  }
  const { pathPart, suffix } = splitUrlSuffix(decodeAttribute(src));
  const diskPath = resolve(labRoot, pathPart.replace(/\//g, "\\"));
  const relativeToLab = relative(labRoot, diskPath);
  if (relativeToLab.startsWith("..") || isAbsolute(relativeToLab)) return null;
  return { diskPath, relativePath: pathPart, suffix };
}

function processImages(html, labRoot, labId) {
  const screenshots = [];
  const stats = { embedded: 0, missing: 0 };
  let shotIndex = 0;

  const updatedHtml = html.replace(/<img\b[^>]*>/gi, (imgTag) => {
    const attrs = parseAttributes(imgTag);
    const src = attrs.get("src");
    const alt = attrs.get("alt") || "Lab screenshot";
    const resolved = resolveImagePath(src, labRoot);

    if (!resolved) {
      return imgTag;
    }

    if (!existsSync(resolved.diskPath)) {
      stats.missing += 1;
      console.warn(`[${labId}] Missing screenshot: ${resolved.relativePath}`);
      return `<div class="missing-screenshot">📷 Screenshot pending — see <code>${escapeHtml(resolved.relativePath)}</code></div>`;
    }

    shotIndex += 1;
    stats.embedded += 1;
    const shotId = `shot-${shotIndex}`;
    const fileUri = pathToFileURL(resolved.diskPath).href + resolved.suffix;
    const safeAlt = escapeHtml(decodeAttribute(alt));
    const safeRel = escapeHtml(resolved.relativePath);
    screenshots.push({ shotId, src: fileUri, alt: safeAlt, relativePath: safeRel });

    return `<span class="screenshot-inline" id="back-${shotId}"><a href="#full-${shotId}" title="Jump to full-size screenshot"><img src="${fileUri}" alt="${safeAlt}" loading="eager" /></a><span class="screenshot-caption">${safeAlt}<br><code>${safeRel}</code></span></span>`;
  });

  return { html: updatedHtml, screenshots, stats };
}

function buildToc(toc) {
  if (!toc.length) return `<p class="muted">No section headings found.</p>`;
  return `<ol class="toc-list">${toc.map((item) => `<li class="toc-depth-${item.depth}"><a href="#${item.id}">${escapeHtml(item.text)}</a></li>`).join("")}</ol>`;
}

function buildAppendix(screenshots) {
  if (!screenshots.length) return "";
  return `<section class="appendix"><h1>Screenshots — Full Size</h1>${screenshots.map((shot, index) => `
    <article class="appendix-shot" id="full-${shot.shotId}">
      <h2>Screenshot ${index + 1}</h2>
      <p class="appendix-caption">${shot.alt}<br><code>${shot.relativePath}</code></p>
      <img src="${shot.src}" alt="${shot.alt}" />
      <p class="back-link"><a href="#back-${shot.shotId}">← back to inline reference</a></p>
    </article>`).join("")}</section>`;
}

function buildDocument({ labId, title, contentHtml, toc, screenshots }) {
  const generatedDate = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)} Walkthrough</title>
  <style>
    @page { size: Letter; margin: 0.6in 0.7in; }
    * { box-sizing: border-box; }
    html { color: #172033; font-family: system-ui, "Segoe UI", sans-serif; font-size: 13px; line-height: 1.55; }
    body { margin: 0; }
    a { color: #2563eb; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .cover { align-items: center; break-after: page; display: flex; flex-direction: column; justify-content: center; min-height: 9in; text-align: center; }
    .cover h1 { color: #0f172a; font-size: 34px; line-height: 1.15; margin: 0 0 20px; }
    .cover .meta { color: #475569; font-size: 15px; }
    .toc { break-after: page; }
    .toc h1, .appendix h1 { color: #0f172a; font-size: 26px; margin-top: 0; }
    .toc-list { padding-left: 0; list-style-position: inside; }
    .toc-list li { border-bottom: 1px solid #e2e8f0; padding: 7px 0; }
    .toc-depth-3 { margin-left: 24px; font-size: 12px; }
    .lab-content h1 { break-before: page; color: #0f172a; font-size: 28px; }
    .lab-content h1:first-child { break-before: auto; }
    .lab-content h2 { break-before: page; color: #1e293b; font-size: 23px; margin-top: 0; }
    .lab-content h3 { color: #334155; font-size: 18px; }
    h1, h2, h3, h4 { break-after: avoid; page-break-after: avoid; }
    p, li { orphans: 3; widows: 3; }
    ul, ol { padding-left: 24px; }
    table { border-collapse: collapse; margin: 16px 0; width: 100%; }
    th, td { border: 1px solid #cbd5e1; padding: 7px 9px; vertical-align: top; }
    th { background: #f1f5f9; }
    pre { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; break-inside: avoid; font-family: Consolas, "Cascadia Mono", monospace; font-size: 11px; overflow-wrap: anywhere; padding: 12px; white-space: pre-wrap; }
    code { background: #f1f5f9; border-radius: 4px; font-family: Consolas, "Cascadia Mono", monospace; font-size: 0.92em; padding: 1px 4px; }
    pre code { background: transparent; padding: 0; }
    blockquote { border-left: 4px solid #93c5fd; color: #475569; margin-left: 0; padding: 8px 16px; }
    .screenshot-inline { break-inside: avoid; display: block; margin: 18px auto; max-width: 720px; text-align: center; }
    .screenshot-inline img { border: 1px solid #cbd5e1; border-radius: 10px; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.16); display: block; height: auto; margin: 0 auto; max-width: 720px; width: 100%; }
    .screenshot-caption, .appendix-caption { color: #475569; display: block; font-size: 11px; margin-top: 8px; }
    .missing-screenshot { background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; color: #78350f; font-style: italic; margin: 16px 0; padding: 14px 16px; }
    .appendix { break-before: page; }
    .appendix-shot { align-items: center; break-before: page; display: flex; flex-direction: column; min-height: 9.1in; justify-content: flex-start; text-align: center; }
    .appendix-shot:first-of-type { break-before: auto; }
    .appendix-shot h2 { color: #1e293b; margin: 0 0 8px; }
    .appendix-shot img { border: 1px solid #cbd5e1; border-radius: 10px; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.16); max-height: 7.2in; max-width: 95%; object-fit: contain; }
    .back-link { margin-top: auto; }
    .muted { color: #64748b; }
  </style>
</head>
<body>
  <section class="cover">
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">
      <p>Lab walkthrough PDF</p>
      <p>Generated ${escapeHtml(generatedDate)}</p>
      <p>Generated from <code>${escapeHtml(labId)}/index.md</code></p>
    </div>
  </section>
  <section class="toc">
    <h1>Table of Contents</h1>
    ${buildToc(toc)}
  </section>
  <main class="lab-content">
    ${contentHtml}
  </main>
  ${buildAppendix(screenshots)}
</body>
</html>`;
}

function discoverLabIds() {
  return readdirSync(labsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(labsRoot, entry.name, "index.md")))
    .map((entry) => entry.name)
    .sort();
}

async function generateLabPdf(browser, labId, outDir) {
  const labRoot = join(labsRoot, labId);
  const indexPath = join(labRoot, "index.md");
  if (!existsSync(indexPath)) {
    throw new Error(`Lab not found: ${labId}`);
  }

  const markdown = readFileSync(indexPath, "utf8");
  if (!markdown.trim()) {
    console.log(`[${labId}] Skipped empty markdown.`);
    return null;
  }

  const title = getTitle(markdown, labId);
  const rendered = renderMarkdown(markdown);
  const processed = processImages(rendered.html, labRoot, labId);
  const documentHtml = buildDocument({
    labId,
    title,
    contentHtml: processed.html,
    toc: rendered.toc,
    screenshots: processed.screenshots,
  });

  const page = await browser.newPage();
  await page.setContent(documentHtml, { waitUntil: "load" });
  const outputPath = join(outDir, `${labId}-walkthrough.pdf`);
  await page.pdf({
    path: outputPath,
    format: "Letter",
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: `<div style="font-family: Segoe UI, sans-serif; font-size: 8px; color: #64748b; width: 100%; padding: 0 0.7in; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;">${escapeHtml(title)}</div>`,
    footerTemplate: `<div style="font-family: Segoe UI, sans-serif; font-size: 8px; color: #64748b; width: 100%; padding: 0 0.7in; display: flex; justify-content: space-between;"><span>CopilotStudioLabs</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
    margin: { top: "0.6in", bottom: "0.6in", left: "0.7in", right: "0.7in" },
  });
  await page.close();

  const size = statSync(outputPath).size;
  console.log(`[${labId}] ${outputPath} (${formatBytes(size)}) — screenshots embedded: ${processed.stats.embedded}, missing: ${processed.stats.missing}`);
  return { labId, outputPath, size, ...processed.stats };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (args.lab === "") throw new Error("--lab requires a lab id.");

  mkdirSync(args.out, { recursive: true });
  const labIds = args.lab ? [args.lab] : discoverLabIds();
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  const results = [];

  try {
    for (const labId of labIds) {
      const result = await generateLabPdf(browser, labId, args.out);
      if (result) results.push(result);
    }
  } finally {
    await browser.close();
  }

  console.log("\nSummary");
  for (const result of results) {
    console.log(`- ${result.labId}: ${relative(repoRoot, result.outputPath)} (${formatBytes(result.size)}), embedded ${result.embedded}, missing ${result.missing}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
