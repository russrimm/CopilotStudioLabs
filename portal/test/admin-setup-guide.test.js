/**
 * Administrator settings are kept out of the learner guides and live only in the Administrator setup guide and the
 * Prerequisites checklist. These tests build real labs into a throwaway folder and look at every learner-facing
 * output (Markdown, web page, Word, PowerPoint, the ZIP's module folders, the preview), at the new administrator
 * documents, at labs built before the split, and at the routes, the lab panel, and the command line.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import vm from "node:vm";

import { generateLab } from "../lib/lab-builder/generator.js";
import {
  exportGeneratedLab,
  renderGeneratedLabAdminGuide,
  renderGeneratedLabDocx,
  renderGeneratedLabHtml,
  renderGeneratedLabMarkdown,
  renderGeneratedLabPptx,
  renderGeneratedLabPrerequisites,
} from "../lib/exporter.js";
import { readGeneratedLab } from "../lib/lab-builder/generated-labs.js";
import { buildAdminPrerequisites, renderAdminPrerequisitesMarkdown } from "../lib/lab-builder/admin-prereqs.js";
import { buildAdministratorSetupGuide, renderAdministratorSetupGuideMarkdown } from "../lib/lab-builder/admin-guide.js";
import { renderAdministratorSetupGuideHtml } from "../lib/lab-builder/admin-guide-html.js";
import { renderAdministratorSetupGuidePdfMarkdown } from "../lib/lab-builder/admin-guide-pdf.js";
import { renderAdministratorSetupGuideDocxBuffer } from "../lib/lab-builder/admin-guide-docx.js";
import { leakedBuilderContent } from "../lib/lab-builder/prereq-checklist.js";
import {
  ADMIN_FOLDER_NAME,
  ADMIN_GUIDE_TITLE,
  LEARNER_SETUP_NOTE,
  hasAdminSetupSection,
  isAdminAudienceTopic,
  learnerGuideMarkdown,
  learnerSafeManifest,
} from "../lib/lab-builder/learner-guide.js";
import { buildFacilitatorGuideModel, renderFacilitatorGuideMarkdown } from "../lib/lab-builder/facilitator-guide.js";
import { capFilesystemSegment, sanitizeFilesystemTitle } from "../lib/lab-builder/module-samples.js";
import { ensureGeneratedLabTopicDocuments, TOPIC_DOCUMENTS_SCHEMA_VERSION } from "../lib/lab-builder/topic-documents.js";
import { checkDocxPackage, readZipStrict } from "../../tools/lab-builder/lib/ooxml-strict.mjs";

process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

const here = dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = resolve(here, "..");
const REPO_ROOT = resolve(PORTAL_ROOT, "..");
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const NOW = new Date("2026-11-20T12:00:00Z");
const OLD_SECTION_HEADING = "Connectors, Environment, and Tenant Prerequisites";
const cleanups = [];
const ctx = { labs: {} };

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

async function startServer(storageRoot) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let stderr = "";
  const child = spawn(process.execPath, ["server.js"], {
    cwd: PORTAL_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      PORTAL_AUTH_DISABLED: "true",
      AZURE_KEYVAULT_URL: "",
      PORTAL_STORAGE_ROOT: storageRoot,
      FEATURE_TOUR_SCREENSHOTS_DIR: "",
      LAB_BUILDER_LINK_CHECK: "off",
      LAB_BUILDER_LLM: "off",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  cleanups.push(() => child.kill());
  const deadline = Date.now() + 60000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${stderr.slice(-800)}`);
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("server did not start in time");
    await new Promise((r) => setTimeout(r, 150));
  }
  return base;
}

async function zipEntries(root, labId, options) {
  const chunks = [];
  const sink = new Writable({ write(chunk, _enc, done) { chunks.push(chunk); done(); } });
  await exportGeneratedLab(root, labId, {}, sink, options);
  const zip = readZipStrict(Buffer.concat(chunks), { opc: false });
  assert.deepEqual(zip.problems, [], "the ZIP is a clean archive");
  return zip.entries;
}

// ── Text of every kind of output ────────────────────────────────────────────

const decode = (text) => text.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'");
const compact = (text) => decode(String(text)).toLowerCase().replace(/[^a-z0-9]+/g, "");

function officeText(buffer, kind) {
  const { entries } = readZipStrict(buffer);
  const pattern = kind === "pptx" ? /^ppt\/(slides|notesSlides)\/[^/]+\.xml$/ : /^word\/(document|header\d*|footer\d*)\.xml$/;
  const tag = kind === "pptx" ? /<a:t[^>]*>([^<]*)<\/a:t>/g : /<w:t[^>]*>([^<]*)<\/w:t>/g;
  return [...entries]
    .filter(([name]) => pattern.test(name))
    .map(([, data]) => [...data.toString("utf8").matchAll(tag)].map((m) => m[1]).join(""))
    .join("\n");
}

function textOf(name, buffer) {
  if (/\.docx$/.test(name)) return officeText(buffer, "docx");
  if (/\.pptx$/.test(name)) return officeText(buffer, "pptx");
  if (/\.(md|html|json|csv|txt)$/.test(name)) return buffer.toString("utf8").replace(/<[^>]+>/g, " ");
  return "";
}

/** Strings that only the administrator model writes, so finding one in a learner output means the settings leaked. */
function adminMarkers(admin, { includePaths = true } = {}) {
  const markers = [
    "Connectors, Environment, and Tenant Prerequisites",
    "Admin Prerequisites, DLP & Guardrails",
    "Additional Admin & DLP Controls",
    "Connectors and Endpoints to Allow",
    "Admin Center & Implementation Guidance",
    "Required Role / Connector / Policy",
  ];
  for (const group of [admin.connectors, admin.dlpAndAcp, admin.environmentSettings, admin.tenantAndCloud]) {
    for (const entry of group || []) {
      if (entry.title) markers.push(entry.title);
      if (entry.details) markers.push(entry.details.slice(0, 90));
      if (includePaths && entry.adminPath && entry.adminPath.length > 40) markers.push(entry.adminPath);
    }
  }
  return markers.map((text) => ({ text, key: compact(text) })).filter((m) => m.key.length >= 20);
}

function findLeaks(files, markers) {
  const leaks = [];
  for (const [name, text] of files) {
    const haystack = compact(text);
    for (const marker of markers) if (haystack.includes(marker.key)) leaks.push(`${name}: ${marker.text}`);
  }
  return leaks;
}

function labFiles(labId, entries) {
  const out = [];
  for (const [name, data] of entries) {
    if (name.startsWith(`${ADMIN_FOLDER_NAME}/`) || name.startsWith("Send to Customer") || name.includes("/Facilitator Guide/")) continue;
    const text = textOf(name, data);
    if (text) out.push([name, text]);
  }
  assert.ok(out.length > 10, `scanned the learner files of ${labId}`);
  return out;
}

// ── Labs ────────────────────────────────────────────────────────────────────

before(async () => {
  ctx.storageRoot = join(tmp("admin-setup-"), "storage");
  ctx.generatedRoot = join(ctx.storageRoot, "generated-labs");
  mkdirSync(ctx.generatedRoot, { recursive: true });
  const build = (request) => generateLab({ industry: "retail", includeCore: false, ...request }, { outputRoot: ctx.generatedRoot, useLearnMcp: false, useLlm: false });
  ctx.labs.studio = await build({
    products: ["copilot-studio"],
    harness: "standard",
    features: ["create-agent", "knowledge-sharepoint", "custom-connectors", "mcp-servers", "knowledge-dataverse", "agent-flows"],
  });
  ctx.labs.multi = await build({
    products: ["copilot-studio", "sharepoint-ai", "ai-foundry", "m365-copilot-agent-builder"],
    harness: "standard",
    features: ["create-agent", "spai-build-agent-sharepoint-content", "fdy-create-foundry-project", "dca-agent-builder-first-agent"],
  });
  ctx.labs.foundry = await build({ industry: "healthcare", products: ["ai-foundry"], level: 200, features: ["fdy-orient-foundry", "fdy-agent-ai-search"] });
  ctx.labs.adminTopic = await build({
    products: ["copilot-studio"],
    harness: "standard",
    features: ["create-agent", "dlp-governance", "agent-inventory"],
  });
  ctx.labs.learn = await build({ products: ["power-platform-ai-hub"], features: ["learn-ai-builder-use-model"] });
});

after(async () => {
  for (const fn of cleanups.reverse()) {
    try {
      await fn();
    } catch {
      /* best effort */
    }
  }
});

const labOf = (key) => {
  const built = ctx.labs[key];
  return {
    built,
    manifest: JSON.parse(readFileSync(join(built.outputDir, "manifest.json"), "utf8")),
    markdown: readFileSync(join(built.outputDir, "index.md"), "utf8"),
  };
};

// ── Learner outputs never carry administrator settings ──────────────────────

test("no learner-facing output carries an administrator setting, and the admin documents do", async () => {
  for (const key of ["studio", "multi", "adminTopic"]) {
    const { built, manifest, markdown } = labOf(key);
    const admin = buildAdminPrerequisites({ manifest, markdown });
    const entryCount = ["connectors", "dlpAndAcp", "environmentSettings", "tenantAndCloud"].reduce((n, g) => n + admin[g].length, 0);
    assert.ok(entryCount >= 3, `${key} has administrator settings to look for`);
    const markers = adminMarkers(admin, { includePaths: key !== "adminTopic" });

    // The saved guide, the web page, and the browser preview.
    const saved = [
      ["index.md", markdown],
      ["index.html", readFileSync(join(built.outputDir, "index.html"), "utf8")],
    ];
    const read = readGeneratedLab(ctx.generatedRoot, built.labId, (md) => md);
    assert.equal(read.status, 200);
    saved.push(["preview markdown", read.body.markdown], ["preview html", read.body.html]);
    assert.deepEqual(findLeaks(saved, markers), [], `${key}: saved guide and preview`);
    assert.ok(!hasAdminSetupSection(markdown));
    assert.equal(markdown.split(LEARNER_SETUP_NOTE).length - 1, 1, "one plain line says the setup was completed");
    assert.ok(read.body.adminPrerequisites.connectors.length >= 1, "the owner's panel still gets the administrator model");

    // The on-demand exports and the per-topic documents on disk.
    const rendered = [
      ["markdown export", renderGeneratedLabMarkdown(ctx.generatedRoot, built.labId).markdown],
      ["html export", renderGeneratedLabHtml(ctx.generatedRoot, built.labId).html],
      ["word handout", officeText(renderGeneratedLabDocx(ctx.generatedRoot, built.labId).buffer, "docx")],
      ["whole-lab deck", officeText(renderGeneratedLabPptx(ctx.generatedRoot, built.labId).buffer, "pptx")],
    ];
    for (const doc of ensureGeneratedLabTopicDocuments(built.outputDir, { labId: built.labId })) {
      rendered.push([`topic ${doc.order} docx`, officeText(readFileSync(join(built.outputDir, doc.docxPath)), "docx")]);
      rendered.push([`topic ${doc.order} pptx`, officeText(readFileSync(join(built.outputDir, doc.pptxPath)), "pptx")]);
    }
    assert.deepEqual(findLeaks(rendered, markers), [], `${key}: exports and per-topic documents`);

    // The ZIP: every module folder, the overview, the root files.
    const entries = await zipEntries(ctx.generatedRoot, built.labId, { formats: "docx,pptx,html" });
    assert.deepEqual(findLeaks(labFiles(key, entries), markers), [], `${key}: ZIP`);
    const zipManifest = JSON.parse(entries.get(`${built.labId}/manifest.json`).toString("utf8"));
    assert.ok(!("adminPrerequisites" in zipManifest), "the ZIP's manifest does not carry the administrator model");

    // The administrator documents say what the learner guides do not.
    const guide = buildAdministratorSetupGuide({ manifest, markdown, now: NOW });
    const guideIds = new Set(guide.sections.flatMap((s) => s.items.map((i) => i.adminId)));
    for (const group of ["connectors", "dlpAndAcp", "environmentSettings", "tenantAndCloud"]) {
      for (const entry of admin[group]) assert.ok(guideIds.has(entry.id), `${key}: the guide covers ${entry.id}`);
    }
    const guideText = compact(renderAdministratorSetupGuideMarkdown(guide));
    assert.ok(guideText.includes(compact("Order of work")) && guideText.includes(compact(ADMIN_GUIDE_TITLE)));
    assert.equal(renderGeneratedLabPrerequisites(ctx.generatedRoot, built.labId, "md", {}, { now: NOW }).status, 200);
  }
});

test("the learner guide has one plain line, no dangling anchors, and no empty headings", () => {
  for (const key of Object.keys(ctx.labs)) {
    const { built, markdown } = labOf(key);
    assert.ok(!markdown.includes(OLD_SECTION_HEADING));
    assert.ok(!/\bRequired By\b/.test(markdown), `${key}: no Required By table`);
    const note = markdown.split("\n").find((line) => line.includes(LEARNER_SETUP_NOTE));
    assert.equal(note, LEARNER_SETUP_NOTE);
    assert.doesNotMatch(note, /\b(configure|enable|turn on|assign|register|allow)\b/i, "the line asks learners to do nothing");

    // No Markdown heading is empty, and every in-page link points at a heading that exists.
    const lines = markdown.split("\n");
    lines.forEach((line, i) => {
      const level = line.match(/^(#{2,4})\s/)?.[1].length;
      if (!level) return;
      const next = lines.slice(i + 1).find((l) => l.trim() !== "");
      const nextLevel = next?.match(/^(#+)\s/)?.[1].length || 0;
      assert.ok(next !== undefined && (!nextLevel || nextLevel > level), `${key}: heading "${line}" is not empty`);
    });
    const html = readFileSync(join(built.outputDir, "index.html"), "utf8");
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(target), `${key}: link #${target} has a target`);
    assert.doesNotMatch(html, /<h[2-4][^>]*>\s*<\/h[2-4]>/, `${key}: no empty heading in the page`);
  }
});

// ── Labs built before the split ─────────────────────────────────────────────

function oldLabCopy(key) {
  const { built, manifest, markdown } = labOf(key);
  const root = join(tmp("admin-setup-old-"), "generated-labs");
  const dir = join(root, built.labId);
  cpSync(built.outputDir, dir, { recursive: true });
  // An older lab: the administrator section at the end, no pointer line, and stale per-topic files.
  const admin = buildAdminPrerequisites({ manifest, markdown });
  const old = `${markdown.replace(`\n${LEARNER_SETUP_NOTE}\n`, "\n").trimEnd()}\n\n${renderAdminPrerequisitesMarkdown(admin)}\n`;
  writeFileSync(join(dir, "index.md"), old);
  const stale = { ...manifest, topicDocumentsVersion: TOPIC_DOCUMENTS_SCHEMA_VERSION - 1 };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(stale, null, 2));
  return { root, dir, labId: built.labId, old, manifest: stale, admin };
}

test("an older lab's saved administrator section is hidden on read, never rewritten, and hiding it twice changes nothing", async () => {
  const { root, dir, labId, old, admin } = oldLabCopy("studio");
  assert.ok(hasAdminSetupSection(old));
  const once = learnerGuideMarkdown(old);
  assert.ok(!hasAdminSetupSection(once) && !once.includes(OLD_SECTION_HEADING));
  assert.equal(once.split(LEARNER_SETUP_NOTE).length - 1, 1, "the pointer is added once");
  assert.equal(learnerGuideMarkdown(once), once, "idempotent");
  assert.equal(learnerGuideMarkdown(labOf("studio").markdown), labOf("studio").markdown, "a current guide is unchanged");
  assert.equal(learnerGuideMarkdown("# Hand-written lab\n\n## Prerequisites\n\n- A browser.\n"), "# Hand-written lab\n\n## Prerequisites\n\n- A browser.\n", "text without the section is left alone");
  // A fenced example that merely mentions the heading is not the section.
  const fenced = "# T\n\n```md\n## Connectors, Environment, and Tenant Prerequisites\n```\n\n## Next\n\nText.\n";
  assert.equal(learnerGuideMarkdown(fenced), fenced);

  const markers = adminMarkers(admin);
  const before = readFileSync(join(dir, "index.md"), "utf8");

  // The stale per-topic files are rebuilt the next time they are asked for, without the administrator slides.
  const topicsDir = join(dir, "topics");
  const staleFile = readdirSync(topicsDir).find((name) => name.endsWith(".pptx"));
  writeFileSync(join(topicsDir, staleFile), Buffer.from("Admin Prerequisites, DLP & Guardrails (stale)"));
  ensureGeneratedLabTopicDocuments(dir, { labId });
  assert.equal(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).topicDocumentsVersion, TOPIC_DOCUMENTS_SCHEMA_VERSION);
  const rebuiltDeck = readFileSync(join(topicsDir, staleFile));
  assert.equal(rebuiltDeck.subarray(0, 2).toString(), "PK");
  assert.doesNotMatch(officeText(rebuiltDeck, "pptx"), /Admin Prerequisites|DLP &/);

  const read = readGeneratedLab(root, labId, (md) => md);
  assert.equal(read.status, 200);
  assert.deepEqual(findLeaks([["markdown", read.body.markdown], ["html", read.body.html]], markers), []);
  assert.equal(readFileSync(join(dir, "index.md"), "utf8"), before, "the saved index.md is not rewritten");
  assert.ok(before.includes(OLD_SECTION_HEADING), "and still has the old section");

  const rendered = [
    ["markdown", renderGeneratedLabMarkdown(root, labId).markdown],
    ["html", renderGeneratedLabHtml(root, labId).html],
    ["docx", officeText(renderGeneratedLabDocx(root, labId).buffer, "docx")],
    ["pptx", officeText(renderGeneratedLabPptx(root, labId).buffer, "pptx")],
  ];
  assert.deepEqual(findLeaks(rendered, markers), []);
  const entries = await zipEntries(root, labId, { formats: "docx,pptx" });
  assert.deepEqual(findLeaks(labFiles(labId, entries), markers), [], "the ZIP of an older lab");

  // The administrator documents are rebuilt from the saved manifest and Markdown: the same guide as a current lab.
  const fresh = buildAdministratorSetupGuide({ manifest: labOf("studio").manifest, markdown: labOf("studio").markdown, now: NOW });
  const rebuilt = renderGeneratedLabAdminGuide(root, labId, "md", {}, { now: NOW });
  assert.equal(rebuilt.status, 200);
  assert.equal(rebuilt.model.itemCount, fresh.itemCount);
  assert.deepEqual(rebuilt.model.roles.map((r) => r.label), fresh.roles.map((r) => r.label));
});

test("the learner manifest copy drops the administrator model and older saved governance rows", () => {
  const manifest = {
    title: "T",
    adminPrerequisites: { connectors: [{ id: "x" }] },
    modules: [{ id: "a", trainingDigest: { summary: "s", governance: { rows: [["a", "b", "c"]] } } }, { id: "b" }],
  };
  const safe = learnerSafeManifest(manifest);
  assert.ok(!("adminPrerequisites" in safe));
  assert.deepEqual(safe.modules[0].trainingDigest, { summary: "s" });
  assert.deepEqual(safe.modules[1], { id: "b" });
  assert.ok("adminPrerequisites" in manifest, "the input is not changed");
});

// ── The ZIP ─────────────────────────────────────────────────────────────────

test("the ZIP has a learner overview, a 'For the administrator' folder, and the customer checklist at the top", async () => {
  const { built, manifest } = labOf("studio");
  const entries = await zipEntries(ctx.generatedRoot, built.labId, { formats: "all" });
  const names = [...entries.keys()];
  assert.ok(!names.some((name) => /Admin Prerequisites/.test(name)), "the old folder name is gone");
  for (const ext of ["docx", "pptx", "pdf", "html"]) assert.ok(entries.has(`${built.labId}/00 - Overview/Lab Overview.${ext}`), `overview .${ext}`);
  assert.doesNotMatch(officeText(entries.get(`${built.labId}/00 - Overview/Lab Overview.docx`), "docx"), /Connectors, Environment|Required By/);

  const safeTitle = capFilesystemSegment(sanitizeFilesystemTitle(manifest.title, "Lab"), 80, "Lab");
  const folder = names.filter((name) => name.startsWith(`${ADMIN_FOLDER_NAME}/`)).map((name) => name.slice(ADMIN_FOLDER_NAME.length + 1)).sort();
  const wanted = [];
  for (const ext of ["docx", "pdf", "html", "md"]) wanted.push(`Administrator setup guide.${ext}`, `Prerequisites checklist.${ext}`);
  assert.equal(folder.length, 8);
  for (const suffix of wanted) assert.ok(folder.includes(`${safeTitle} - ${suffix}`), `the folder holds ${safeTitle} - ${suffix}`);
  assert.ok(names.some((name) => /^Send to Customer - Prerequisites Checklist - .+\.docx$/.test(name)), "the customer's file is still at the top");
  assert.ok(names.filter((name) => !name.includes("/")).includes("README.md"));

  const exportManifest = JSON.parse(entries.get("export-manifest.json").toString("utf8"));
  assert.equal(exportManifest.administratorFolder, ADMIN_FOLDER_NAME);
  assert.equal(exportManifest.administratorFiles.length, 8);
  assert.equal(exportManifest.overviewFolder, `${built.labId}/00 - Overview`);
  assert.match(entries.get("README.md").toString("utf8"), /For the administrator\/` — the Administrator setup guide and the Prerequisites checklist\. Admin settings only/);
  const guideDocx = names.find((name) => name.endsWith("Administrator setup guide.docx"));
  assert.deepEqual(checkDocxPackage(entries.get(guideDocx)), []);
  assert.match(officeText(entries.get(guideDocx), "docx"), /For the administrator\. Not part of the learner guides\./);

  // The requested formats decide which Word, PDF, and web page copies are made; Markdown is always there.
  const pdfOnly = [...(await zipEntries(ctx.generatedRoot, built.labId, { formats: "pdf" })).keys()].filter((n) => n.startsWith(`${ADMIN_FOLDER_NAME}/`));
  assert.deepEqual(pdfOnly.map((n) => n.split(".").pop()).sort(), ["md", "md", "pdf", "pdf"]);
  const pptxOnly = [...(await zipEntries(ctx.generatedRoot, built.labId, { formats: "pptx" })).keys()].filter((n) => n.startsWith(`${ADMIN_FOLDER_NAME}/`));
  assert.deepEqual(pptxOnly.map((n) => n.split(".").pop()).sort(), ["docx", "docx", "md", "md"], "a PowerPoint-only request still hands over a Word guide");
});

// ── The administrator setup guide ───────────────────────────────────────────

test("the guide is grouped by role, numbered in the work order, and leaves out anything that is empty", () => {
  const { manifest, markdown } = labOf("studio");
  const guide = buildAdministratorSetupGuide({ manifest, markdown, now: NOW });
  const roleRank = ["tenant-admin", "identity-admin", "power-platform-admin", "sharepoint-admin", "security-admin", "azure-admin", "network-admin", "content-owner", "workshop-host"];
  const ranks = guide.sections.map((s) => roleRank.indexOf(s.id));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), "role sections follow the role order");
  const stageOrder = ["licenses", "tenant", "environment", "policies", "connectors", "data", "network"];
  const numbers = guide.workOrder.map((entry) => entry.n);
  assert.deepEqual(numbers, numbers.map((_, i) => i + 1), "item numbers are the order of work");
  const all = guide.sections.flatMap((s) => s.items);
  const stageRanks = [...all].sort((a, b) => a.n - b.n).map((i) => stageOrder.indexOf(i.stageId));
  assert.ok(stageRanks.every((rank, i) => i === 0 || rank >= stageRanks[i - 1]), "an earlier stage never comes after a later one");
  for (const section of guide.sections) {
    assert.ok(section.items.every((i) => i.role === section.id), "every item sits under the role that does it");
    assert.deepEqual(section.items.map((i) => i.n), [...section.items.map((i) => i.n)].sort((a, b) => a - b));
  }
  assert.equal(guide.roles.reduce((n, r) => n + r.items.length, 0), guide.itemCount);
  assert.equal(all.filter((i) => i.stageId === "network").length, 1, "the web addresses are one item for the network contact");
  assert.ok(all.every((i) => i.title && i.why), "every item names what and why");
  const dlp = all.find((i) => i.adminId === "dlp-business-group-alignment");
  assert.deepEqual(dlp.steps.slice(0, 2), ["Open the Power Platform admin center.", "Go to Policies > Data policies."], "the exact portal location is given as steps");
  assert.match(dlp.learn.url, /^https:\/\/learn\.microsoft\.com\//);

  // Nothing is padded when there is nothing to do.
  const empty = buildAdministratorSetupGuide({ manifest: { title: "Fabrikam Basics", products: ["not-a-product"], modules: [], adminPrerequisites: {} }, markdown: "# Fabrikam Basics\n\n## Prerequisites\n\n- A modern browser.\n", now: NOW });
  assert.equal(empty.itemCount, 0);
  assert.deepEqual(empty.sections, []);
  const md = renderAdministratorSetupGuideMarkdown(empty);
  const html = renderAdministratorSetupGuideHtml(empty);
  for (const absent of ["Order of work", "Who does what", "Done by / date", "role-filter"]) assert.ok(!md.includes(absent) && !html.includes(absent), `${absent} is omitted`);
  assert.deepEqual(checkDocxPackage(renderAdministratorSetupGuideDocxBuffer(empty)), []);
  assert.doesNotMatch(renderAdministratorSetupGuidePdfMarkdown(empty), /Order of work/);
});

test("every format says the same thing, with no builder content, tenant identifier, or lab step", () => {
  const { built } = labOf("multi");
  const out = (format, opts = {}) => {
    const rendered = renderGeneratedLabAdminGuide(ctx.generatedRoot, built.labId, format, {}, { now: NOW, ...opts });
    assert.equal(rendered.status, 200, rendered.error);
    return rendered;
  };
  const md = out("md");
  const html = out("html");
  const docx = out("docx");
  const pdf = out("pdf");
  assert.match(pdf.buffer.subarray(0, 8).toString("latin1"), /^%PDF-1\.4/);
  assert.deepEqual(checkDocxPackage(docx.buffer), []);
  const texts = { md: md.text, html: html.text.replace(/<[^>]+>/g, " "), docx: officeText(docx.buffer, "docx"), pdf: renderAdministratorSetupGuidePdfMarkdown(pdf.model) };
  const first = md.model.sections[0].items[0];
  for (const [format, text] of Object.entries(texts)) {
    for (const needle of [ADMIN_GUIDE_TITLE, "For the administrator. Not part of the learner guides.", "Order of work", "Who does what", "Done by / date", "Confirm and return", first.title]) {
      assert.ok(decode(text).toLowerCase().includes(needle.toLowerCase()), `${format} contains "${needle}"`);
    }
    assert.ok(!text.includes(built.labId), `${format} has no lab id`);
    assert.doesNotMatch(text, GUID, `${format} has no GUID`);
    assert.doesNotMatch(text, /Screenshot to add|Answer Key|Knowledge Check|Run-of-Show/i, `${format} has no lab, quiz, or facilitator content`);
    assert.doesNotMatch(text, /\bStep \d+\b|\bRecap \d+\b/, `${format} has no module step labels`);
    assert.deepEqual(leakedBuilderContent(text), [], `${format} leaks nothing`);
  }
  assert.equal((html.text.match(/<input type="checkbox"/g) || []).length, html.model.itemCount, "each item has a checkbox");
  assert.match(html.text, /<option value="all">Everyone \(all items\)<\/option>/, "each administrator can print only their part");
});

test("something Microsoft Learn does not confirm is phrased for an administrator", () => {
  const { manifest, markdown } = labOf("foundry");
  const guide = buildAdministratorSetupGuide({ manifest, markdown, now: NOW });
  const unconfirmed = guide.sections.flatMap((s) => s.items).filter((i) => i.confirm);
  assert.ok(unconfirmed.length >= 1, "the lab has an unconfirmed passage");
  for (const item of unconfirmed) {
    assert.match(item.confirm, /^Not confirmed in Microsoft Learn/);
    assert.match(item.confirm, /Check this in your own tenant, or with your Microsoft representative, before you rely on it\.$/);
    assert.doesNotMatch(item.confirm, /^Confirm with your Microsoft representative/);
  }
  assert.match(renderAdministratorSetupGuideMarkdown(guide), /\*\*Not confirmed in Microsoft Learn/);
  const checklist = renderGeneratedLabPrerequisites(ctx.generatedRoot, labOf("foundry").built.labId, "md", {}, { now: NOW });
  assert.match(checklist.text, /Confirm with your Microsoft representative \(not confirmed in Microsoft Learn\)/, "the customer's checklist keeps its own wording");
});

test("the brand profile reaches the guide in every format and a plain lab stays plain", () => {
  const brand = {
    companyName: "Fabrikam Learning",
    tagline: "Workshops for Fabrikam teams",
    primaryColor: "#7a1f5c",
    secondaryColor: "#c47f00",
    font: "calibri",
    coverSubtitle: "Prepared for the Fabrikam AI workshop",
    footerText: "Fabrikam Learning - Confidential",
    supportName: "Fabrikam Workshop Desk",
    supportEmail: "workshops@fabrikam.example",
  };
  const { built } = labOf("studio");
  const render = (format, opts) => renderGeneratedLabAdminGuide(ctx.generatedRoot, built.labId, format, {}, { now: NOW, ...opts });
  const html = render("html", { branding: brand });
  assert.match(html.text, /Fabrikam Learning/);
  assert.match(html.text, /--band: #7a1f5c/);
  assert.match(html.text, /Calibri/);
  assert.match(html.text, /Fabrikam Workshop Desk at workshops@fabrikam\.example/);
  assert.match(html.text, /content: "[^"]*Fabrikam Learning - Confidential/);
  const docx = render("docx", { branding: brand });
  assert.deepEqual(checkDocxPackage(docx.buffer), []);
  assert.match(readZipStrict(docx.buffer).entries.get("word/document.xml").toString("utf8"), /w:fill="7A1F5C"/);
  assert.match(officeText(docx.buffer, "docx"), /Fabrikam Learning/);
  assert.match(render("md", { branding: brand }).text, /Fabrikam Workshop Desk at workshops@fabrikam\.example/);
  assert.doesNotMatch(render("html").text, /Fabrikam/);
  assert.doesNotMatch(officeText(render("docx").buffer, "docx"), /Fabrikam/);
});

// ── A topic the person deliberately selects stays a module ──────────────────

test("a selected administrator topic stays a lab module, labeled for administrators, while lab-setup settings move out", async () => {
  const { built, manifest, markdown } = labOf("adminTopic");
  const adminModules = manifest.modules.filter((m) => isAdminAudienceTopic(m));
  assert.deepEqual(adminModules.map((m) => m.id).sort(), ["agent-inventory", "dlp-governance"]);
  for (const mod of adminModules) {
    assert.ok(markdown.includes(`### Step ${mod.stepOrder} - ${mod.name}`), `${mod.name} is still a step in the guide`);
    const section = markdown.slice(markdown.indexOf(`### Step ${mod.stepOrder} - ${mod.name}`));
    assert.match(section.split("\n")[2], /· Audience: administrators\*$/, "the module says who it is for");
    assert.match(section, /\*\*Do this\*\*/);
  }
  assert.equal(
    markdown.split("\n").filter((line) => /^\*Level \d+ · about \d+ minutes · Audience: administrators\*$/.test(line)).length,
    adminModules.length,
    "only the administrator topics are labeled",
  );

  const topicDocs = ensureGeneratedLabTopicDocuments(built.outputDir, { labId: built.labId });
  assert.equal(topicDocs.length, manifest.modules.length, "every selected topic still has its documents");
  const dlpDoc = topicDocs.find((d) => d.id === "dlp-governance");
  const dlpText = officeText(readFileSync(join(built.outputDir, dlpDoc.docxPath)), "docx");
  assert.match(dlpText, /AUDIENCE\s*Administrators/);
  assert.match(dlpText, /DLP/, "the topic that teaches data policies still teaches them");
  assert.doesNotMatch(markdown, new RegExp(OLD_SECTION_HEADING));
  assert.ok(!isAdminAudienceTopic({ id: "knowledge-sharepoint", category: "knowledge" }));

  // The lab-setup settings are in the guide, not in the learner module folders.
  const entries = await zipEntries(ctx.generatedRoot, built.labId, { formats: "docx" });
  const moduleDocs = [...entries.keys()].filter((n) => /\/Module \d+ - .+\.docx$/.test(n));
  assert.equal(moduleDocs.length, manifest.modules.length);
  const guide = buildAdministratorSetupGuide({ manifest, markdown, now: NOW });
  assert.ok(guide.sections.flatMap((s) => s.items).some((i) => i.adminId === "dlp-business-group-alignment"));
});

// ── The facilitator guide points to the administrator documents ─────────────

test("the facilitator guide keeps a short readiness pointer and none of the administrator settings", () => {
  const { built, manifest, markdown } = labOf("studio");
  const model = buildFacilitatorGuideModel({ labId: built.labId, labDir: built.outputDir, manifest, markdown });
  const md = renderFacilitatorGuideMarkdown(model);
  assert.match(md, /## 2\. Pre-Delivery Tenant, Licensing & Environment Readiness Runbook/);
  assert.match(md, /### Administrator Readiness \(Owned by the Administrator\)/);
  assert.match(md, /\*\*Administrator setup guide\*\* and the \*\*Prerequisites checklist\*\*/);
  assert.match(md, /\| \*\*Power Platform admin\*\* \|/, "who must finish what");
  assert.match(md, /Confirm the administrator has finished every item in the Administrator setup guide/);
  assert.match(md, /open each connector this workshop uses \(Microsoft Dataverse/, "the host knows which connectors to spot-check");
  assert.doesNotMatch(md, /Required Connectors & DLP Data Groups|DLP, ACP, Environment & Tenant Guardrails/);
  const admin = buildAdminPrerequisites({ manifest, markdown });
  assert.deepEqual(findLeaks([["facilitator", md]], adminMarkers(admin)), [], "no administrator setting text is repeated");
  assert.ok(!("adminPrerequisites" in model.readinessRunbook));
});

// ── Routes ──────────────────────────────────────────────────────────────────

test("the export route serves each administrator guide format, validates the format and the lab, and leaves other exports alone", async () => {
  const base = await startServer(ctx.storageRoot);
  const labId = ctx.labs.studio.labId;
  const url = (format, prefix = "/api/lab-builder/generated", id = labId) => `${base}${prefix}/${encodeURIComponent(id)}/export?format=${format}`;
  const expected = {
    "admin-guide-docx": [/wordprocessingml\.document/, "docx"],
    "admin-guide-pdf": [/application\/pdf/, "pdf"],
    "admin-guide-html": [/text\/html/, "html"],
    "admin-guide-md": [/text\/markdown/, "md"],
    "admin-guide-markdown": [/text\/markdown/, "md"],
  };
  for (const prefix of ["/api/lab-builder/generated", "/api/generated-labs"]) {
    for (const [format, [type, ext]] of Object.entries(expected)) {
      const res = await fetch(url(format, prefix));
      assert.equal(res.status, 200, `${prefix} ${format}`);
      assert.match(res.headers.get("content-type") || "", type);
      assert.match(res.headers.get("content-disposition") || "", new RegExp(`Administrator setup guide\\.${ext}`));
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      const body = Buffer.from(await res.arrayBuffer());
      if (ext === "docx") assert.deepEqual(checkDocxPackage(body), []);
      if (ext === "pdf") assert.match(body.subarray(0, 8).toString("latin1"), /^%PDF-1\.4/);
      if (ext === "html") assert.match(body.toString("utf8"), /<!DOCTYPE html>/);
      if (ext === "md") assert.match(body.toString("utf8"), /^# Administrator setup guide/);
    }
  }
  const post = await fetch(url("admin-guide-md"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ replacements: { Retail: "Fabrikam Stores" } }) });
  assert.equal(post.status, 200);
  assert.match(await post.text(), /Fabrikam Stores/);

  const bad = await fetch(url("admin-guide-xlsx"));
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /admin-guide-docx/);
  assert.equal((await fetch(url("admin-guide-"))).status, 400);
  assert.equal((await fetch(url("admin-guide-docx", "/api/lab-builder/generated", "no-such-lab"))).status, 404);
  assert.equal((await fetch(url("admin-guide-docx", "/api/lab-builder/generated", "bad%20id"))).status, 400);

  // The learner exports and the browser preview never carry the settings.
  const markers = adminMarkers(buildAdminPrerequisites({ manifest: labOf("studio").manifest, markdown: labOf("studio").markdown }));
  const learnerText = [];
  for (const format of ["md", "html"]) learnerText.push([format, await (await fetch(url(format))).text()]);
  const detail = await (await fetch(`${base}/api/lab-builder/generated/${encodeURIComponent(labId)}`)).json();
  learnerText.push(["preview markdown", detail.markdown], ["preview html", detail.html]);
  assert.deepEqual(findLeaks(learnerText, markers), []);
  assert.ok(Array.isArray(detail.adminPrerequisites.connectors), "the owner's panel is still fed");
  const docx = Buffer.from(await (await fetch(url("docx"))).arrayBuffer());
  assert.deepEqual(findLeaks([["docx", officeText(docx, "docx")]], markers), []);
  assert.equal((await fetch(url("prerequisites-docx"))).status, 200, "the checklist route is unchanged");

  // The preview.
  const preview = await fetch(`${base}/api/lab-builder/generated/${encodeURIComponent(labId)}/admin-guide`);
  assert.equal(preview.status, 200);
  const data = await preview.json();
  assert.match(data.html, /For the administrator\. Not part of the learner guides\./);
  assert.ok(data.itemCount > 10 && data.roles.length > 2 && data.sections.length > 2);
  assert.deepEqual(Object.keys(data).sort(), ["baseName", "html", "itemCount", "roles", "sections", "title"], "no internal ids in the preview");
  assert.equal((await fetch(`${base}/api/lab-builder/generated/no-such-lab/admin-guide`)).status, 404);
  assert.equal((await fetch(`${base}/api/generated-labs/${encodeURIComponent(labId)}/admin-guide`)).status, 200);
});

// ── The lab panel ───────────────────────────────────────────────────────────

function uiContext() {
  const elements = new Map();
  const el = (id, extra = {}) => {
    const node = { id, textContent: "", srcdoc: "", title: "", open: false, focus() { this.focused = true; }, showModal() { this.open = true; }, close() { this.open = false; }, addEventListener() {}, ...extra };
    elements.set(id, node);
    return node;
  };
  const toasts = [];
  const downloads = [];
  const fetches = [];
  const context = vm.createContext({
    window: {},
    document: { getElementById: (id) => elements.get(id) || null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async (url) => {
      fetches.push(String(url));
      if (/\/admin-guide$/.test(String(url))) return { ok: true, status: 200, json: async () => ({ itemCount: 27, roles: [{}, {}, {}, {}], html: "<p>For the administrator</p>" }) };
      return { ok: true, status: 200, blob: async () => new Blob(["x"], { type: "application/pdf" }), json: async () => ({}) };
    },
    escapeHtml: (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    toast: (message, kind) => toasts.push([message, kind]),
    lbDownloadText: (name, data, mime) => downloads.push([name, mime]),
    URL, Blob, console, setTimeout, clearTimeout,
  });
  vm.runInContext(readFileSync(join(PORTAL_ROOT, "public", "generated-labs.js"), "utf8"), context);
  vm.runInContext("globalThis.__ui = { lbGeneratedActionButtonsHtml, lbDownloadAdminGuide, lbPreviewAdminGuide, lbPrereq };", context);
  return { ui: context.__ui, el, toasts, downloads, fetches };
}

test("the lab panel has a 'For the administrator' group with the guide, the checklist, and a one-line reason", async () => {
  const { ui, el, toasts, downloads, fetches } = uiContext();
  const html = ui.lbGeneratedActionButtonsHtml("my-lab-slug", "Fabrikam Copilot Readiness Lab", { scopePrefix: "lb-zip-fmt-item" });
  const visible = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(html, /role="group" aria-labelledby="lb-zip-fmt-item-admin-my-lab-slug-title" aria-describedby="lb-zip-fmt-item-admin-my-lab-slug-note"/);
  assert.match(visible, /For the administrator Admin settings only\. Not part of the learner guides\./);
  assert.match(visible, /Download administrator setup guide/);
  assert.match(visible, /Download prerequisites checklist/);
  assert.equal((html.match(/data-gen-action="export-admin-guide"/g) || []).length, 1);
  assert.equal((html.match(/data-gen-action="export-prereqs"/g) || []).length, 1);
  assert.equal((html.match(/class="lb-prereq-group"/g) || []).length, 1, "the checklist group is unchanged");
  const picker = html.match(/<select[^>]*data-admin-guide-format-select[^>]*>([\s\S]*?)<\/select>/)[1];
  assert.deepEqual([...picker.matchAll(/<option value="([a-z]+)">([^<]+)<\/option>/g)].map((m) => `${m[1]}: ${m[2]}`), ["docx: Word (.docx), recommended", "pdf: PDF (.pdf)", "html: Web page (.html)", "md: Markdown (.md)"]);
  assert.match(html, /<label class="sr-only" for="lb-zip-fmt-item-admin-my-lab-slug-format">/, "the picker has a label");
  assert.doesNotMatch(html, /clipboard/i, "clipboard writes stay in screenshot-center.js and use-case-builder.js");
  assert.doesNotMatch(visible, /my-lab-slug/, "no id in the visible words");

  await ui.lbDownloadAdminGuide("my-lab-slug", "pdf");
  assert.match(fetches.at(-1), /\/my-lab-slug\/export\?format=admin-guide-pdf$/);
  assert.deepEqual(downloads.at(-1), ["Lab - Administrator setup guide.pdf", "application/pdf"]);
  assert.equal(toasts.at(-1)[1], "success");
  await ui.lbDownloadAdminGuide("my-lab-slug", "nope");
  assert.match(fetches.at(-1), /format=admin-guide-docx$/, "an unknown format falls back to Word");

  const dialog = el("lb-prereq-preview-dialog");
  const frame = el("lb-prereq-preview-frame");
  const desc = el("lb-prereq-preview-desc");
  const heading = el("lb-prereq-preview-title");
  const download = el("lb-prereq-preview-download");
  el("lb-prereq-preview-error");
  el("lb-prereq-preview-close");
  const button = { closest: () => ({ querySelector: () => ({ value: "html" }) }) };
  await ui.lbPreviewAdminGuide("my-lab-slug", button);
  assert.equal(dialog.open, true);
  assert.equal(heading.textContent, "Administrator setup guide preview");
  assert.equal(download.textContent, "Download administrator setup guide");
  assert.match(frame.srcdoc, /For the administrator/);
  assert.equal(desc.textContent, "This is the administrator's copy: 27 items across 4 roles. Admin settings only. It is not part of the learner guides.");
  assert.equal(ui.lbPrereq.kind, "admin-guide");
  assert.equal(ui.lbPrereq.format, "html");

  const page = readFileSync(join(PORTAL_ROOT, "public", "index.html"), "utf8");
  assert.match(page, /body\[data-print-target="generated"\] #lb-result-admin-prereqs,/, "printing a generated lab leaves the administrator panel out");
});

// ── Command line ────────────────────────────────────────────────────────────

test("the command line writes the guide in each format, reads older labs, and fails plainly", () => {
  const cli = join(REPO_ROOT, "tools", "lab-builder", "export-admin-guide.mjs");
  const out = tmp("admin-guide-cli-");
  const run = (args, env = {}) => execFileSync(process.execPath, [cli, ...args], { cwd: REPO_ROOT, encoding: "buffer", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const fails = (args) => {
    try {
      run(args);
    } catch (err) {
      return { status: err.status, stderr: err.stderr.toString("utf8") };
    }
    return { status: 0, stderr: "" };
  };
  const { dir, root, labId } = oldLabCopy("studio");
  const before = readFileSync(join(dir, "index.md"), "utf8");
  const docx = join(out, "guide.docx");
  run(["--lab", dir, "--out", docx]);
  assert.deepEqual(checkDocxPackage(readFileSync(docx)), []);
  assert.match(officeText(readFileSync(docx), "docx"), /Administrator setup guide/);
  run(["--lab", labId, "--root", root, "--format", "pdf", "--out", join(out, "g.pdf")]);
  assert.match(readFileSync(join(out, "g.pdf")).subarray(0, 8).toString("latin1"), /^%PDF-1\.4/);
  assert.match(run(["--lab", dir, "--format", "html", "--out", "-"]).toString("utf8"), /<!DOCTYPE html>[\s\S]*For the administrator\. Not part of the learner guides\./);
  assert.match(run(["--lab", dir, "--format", "md", "--out", "-"]).toString("utf8"), /^# Administrator setup guide/);
  run(["--lab", dir, "--format", "md", "--out", out]);
  assert.ok(readdirSync(out).some((name) => / - Administrator setup guide\.md$/.test(name)), "a folder gets a descriptive file name");
  assert.equal(readFileSync(join(dir, "index.md"), "utf8"), before, "nothing is written to the lab");

  assert.match(fails([]).stderr, /--lab is required/);
  assert.match(fails(["--lab", dir, "--format", "xlsx"]).stderr, /--format must be one of docx, pdf, html, md/);
  assert.match(fails(["--lab", "no-such-lab", "--root", root]).stderr, /No generated lab "no-such-lab"/);
  assert.match(fails(["--lab", "../x"]).stderr, /neither a lab folder nor a lab id/);
  assert.match(fails(["--nope"]).stderr, /Unknown flag --nope/);
  assert.equal(run(["--help"]).toString("utf8").includes("Export a generated lab's Administrator setup guide by itself."), true);
});
