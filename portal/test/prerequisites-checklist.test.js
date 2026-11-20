import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { generateLab } from "../lib/lab-builder/generator.js";
import { exportGeneratedLab, normalizePrerequisitesFormat, renderGeneratedLabPrerequisites } from "../lib/exporter.js";
import {
  buildPrerequisitesChecklist,
  formatItemNumbers,
  leakedBuilderContent,
  renderPrerequisitesChecklistMarkdown,
} from "../lib/lab-builder/prereq-checklist.js";
import { renderPrerequisitesChecklistHtml } from "../lib/lab-builder/prereq-checklist-html.js";
import { renderPrerequisitesChecklistPdfMarkdown } from "../lib/lab-builder/prereq-checklist-pdf.js";
import { checkDocxPackage, readZipStrict } from "../../tools/lab-builder/lib/ooxml-strict.mjs";
import { makePng } from "../../tools/lab-builder/lib/office-matrix.mjs";
import { Writable } from "node:stream";

process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

const here = dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = resolve(here, "..");
const REPO_ROOT = resolve(PORTAL_ROOT, "..");
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const NOW = new Date("2026-11-20T12:00:00Z");
const cleanups = [];
const ctx = {};

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
  const deadline = Date.now() + 30000;
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

/** The visible words of a .docx: the text of every run in the body, header, and footer. */
function docxText(buffer) {
  const { entries } = readZipStrict(buffer);
  return [...entries]
    .filter(([name]) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(name))
    .map(([, data]) => [...data.toString("utf8").matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(""))
    .join("\n")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stepLines(markdown) {
  const start = markdown.indexOf("## Step-by-Step");
  const end = markdown.indexOf("\n## ", start + 5);
  return markdown
    .slice(start, end === -1 ? undefined : end)
    .split("\n")
    .map((line) => line.match(/^\d+\.\s+(.{40,})$/)?.[1])
    .filter(Boolean)
    .slice(0, 8);
}

before(async () => {
  ctx.storageRoot = join(tmp("prereq-checklist-"), "storage");
  ctx.generatedRoot = join(ctx.storageRoot, "generated-labs");
  mkdirSync(ctx.generatedRoot, { recursive: true });
  const build = (request) => generateLab({ industry: "manufacturing", includeCore: false, includeKnowledgeCheck: true, ...request }, { outputRoot: ctx.generatedRoot, useLearnMcp: false, useLlm: false });
  ctx.multi = await build({
    products: ["copilot-studio", "sharepoint-ai", "ai-foundry", "m365-copilot-agent-builder"],
    harness: "standard",
    features: ["create-agent", "spai-build-agent-sharepoint-content", "fdy-create-foundry-project", "dca-agent-builder-first-agent"],
  });
  ctx.minimal = await build({ products: ["copilot-studio"], harness: "standard", features: ["create-agent"] });
  ctx.learn = await build({ products: ["power-platform-ai-hub"], features: ["learn-ai-builder-use-model"] });
  ctx.logo = join(tmp("prereq-logo-"), "logo.png");
  writeFileSync(ctx.logo, makePng(240, 80, [122, 31, 92]));
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

const render = (built, format, opts = {}, replacements = {}) => {
  const out = renderGeneratedLabPrerequisites(ctx.generatedRoot, built.labId, format, replacements, { now: NOW, ...opts });
  assert.equal(out.status, 200, out.error);
  return out;
};

// ── The document says only what the customer must prepare ───────────────────

test("every format holds the prerequisite sections and none of the lab, quiz, facilitator, or builder content", () => {
  const built = ctx.multi;
  const index = readFileSync(join(built.outputDir, "index.md"), "utf8");
  assert.match(index, /Knowledge check/i, "the lab itself has a quiz, so its absence below means something");
  const steps = stepLines(index);
  assert.ok(steps.length >= 3, "the lab has step text to look for");
  const manifest = JSON.parse(readFileSync(join(built.outputDir, "manifest.json"), "utf8"));

  const md = render(built, "md");
  const html = render(built, "html");
  const docx = render(built, "docx");
  const pdf = render(built, "pdf");
  assert.match(pdf.buffer.subarray(0, 8).toString("latin1"), /^%PDF-1\.4/);

  const texts = {
    md: md.text,
    html: html.text,
    docx: docxText(docx.buffer),
    pdf: renderPrerequisitesChecklistPdfMarkdown(pdf.model),
  };
  const sectionTitles = md.model.sections.map((s) => s.title);
  for (const expected of ["Licenses and subscriptions", "Connectors and connections", "Data and content for the workshop", "What each attendee needs"]) {
    assert.ok(sectionTitles.includes(expected), `model has ${expected}`);
  }
  for (const [format, text] of Object.entries(texts)) {
    for (const needle of ["Please complete before the workshop", "How to use this checklist", "Who needs to be involved", "Done by / date", ...sectionTitles]) {
      assert.ok(text.includes(needle), `${format} contains "${needle}"`);
    }
    assert.ok(!text.includes(built.labId), `${format} has no lab id`);
    assert.ok(!text.includes("manifest.json"), `${format} has no builder file names`);
    assert.doesNotMatch(text, GUID, `${format} has no GUID`);
    assert.doesNotMatch(text, /Screenshot to add|Pending screenshot|SHOTLIST/i, `${format} has no screenshot placeholders`);
    assert.doesNotMatch(text, /Answer Key|Knowledge check|Check your work|Expected result/i, `${format} has no quiz or step checks`);
    assert.doesNotMatch(text, /Facilitator|Run-of-Show|Talk track|Time Estimate/i, `${format} has no facilitator or timing content`);
    assert.doesNotMatch(text, /\bStep \d+\b|\bRecap \d+\b/i, `${format} has no module step labels`);
    assert.doesNotMatch(text, /grounded modules|Lab quality|generatedAt|Learn-grounded/i, `${format} has no generation metadata`);
    for (const id of manifest.request.features) assert.ok(!text.includes(id), `${format} has no manifest id ${id}`);
    for (const line of steps) assert.ok(!text.includes(line.slice(0, 40)), `${format} has no module step text: ${line.slice(0, 40)}`);
    assert.deepEqual(leakedBuilderContent(text), [], `${format} leaks nothing`);
  }
  // The same facts reach every format.
  for (const item of md.model.sections.flatMap((s) => s.items)) {
    const anchor = (item.title || item.text).slice(0, 30).replace(/\s+/g, " ");
    assert.ok(texts.md.includes(anchor.replace(/([*_[\]\\|])/g, "\\$1")) || texts.md.includes(anchor), `md lists item ${item.n}`);
  }
});

test("each item has a checkbox, a role, a reason, and a Done by / date column, sorted by who does it", () => {
  const html = render(ctx.multi, "html");
  const rows = (html.text.match(/<tr data-role="[^"]+">/g) || []).length;
  assert.equal(rows, html.model.itemCount);
  assert.equal((html.text.match(/<input type="checkbox"/g) || []).length, rows);
  assert.match(html.text, /<th scope="col">Who<\/th><th scope="col">Why it is needed<\/th><th scope="col">Done by \/ date<\/th>/);

  const roleOrder = ["tenant-admin", "identity-admin", "power-platform-admin", "sharepoint-admin", "security-admin", "azure-admin", "network-admin", "content-owner", "workshop-host", "attendee"];
  for (const section of html.model.sections) {
    const ranks = section.items.map((i) => roleOrder.indexOf(i.role));
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), `${section.title} is sorted by role`);
    for (const item of section.items) {
      assert.ok(item.roleLabel && item.why, `item ${item.n} names who and why`);
      assert.ok(item.title || item.text, `item ${item.n} says what to have ready`);
    }
  }
  const roles = html.model.roles;
  assert.ok(roles.length >= 4);
  assert.equal(roles.reduce((n, r) => n + r.items.length, 0), html.model.itemCount, "every item belongs to one role");
  assert.equal(formatItemNumbers([1, 2, 3, 5, 7, 8]), "1\u20133, 5, 7, 8");
  assert.match(html.text, /<option value="all">Everyone \(all items\)<\/option>/, "an admin can show only their own part");
});

test("a section with nothing in it is left out, and nothing is padded", () => {
  const model = buildPrerequisitesChecklist({
    manifest: { title: "Tiny workshop", products: ["ai-foundry"], adminPrerequisites: { connectors: [], dlpAndAcp: [], environmentSettings: [], tenantAndCloud: [] } },
    markdown: "# Tiny workshop\n\n## Prerequisites\n\n- Access to the Microsoft Foundry portal at https://ai.azure.com.\n",
    now: NOW,
  });
  assert.deepEqual(model.sections.map((s) => s.id), ["licenses", "attendees"], "the product license note and the one prerequisite, and nothing else");
  assert.ok(model.sections.every((s) => s.items.length > 0));
  const md = renderPrerequisitesChecklistMarkdown(model);
  const html = renderPrerequisitesChecklistHtml(model);
  for (const absent of ["Tenant, identity, and cloud admin settings", "Connectors and connections", "Network and allow-list needs", "What attendees should already know"]) {
    assert.ok(!md.includes(absent) && !html.includes(absent), `${absent} is omitted`);
  }
  assert.ok(md.includes("What each attendee needs"));

  const empty = buildPrerequisitesChecklist({ manifest: { title: "Nothing", products: ["not-a-product"], adminPrerequisites: {} }, markdown: "# Nothing\n", now: NOW });
  assert.equal(empty.sections.length, 0);
  assert.equal(empty.roles.length, 0);
  assert.doesNotMatch(renderPrerequisitesChecklistMarkdown(empty), /Who needs to be involved/);

  const minimal = render(ctx.minimal, "md").model;
  assert.ok(minimal.sections.every((s) => s.items.length > 0));
  assert.ok(!minimal.sections.some((s) => s.id === "knowledge"), "a lab with no recaps has no 'already know' section");
});

test("something Microsoft Learn does not confirm is phrased for the customer, and checked Learn pages are linked", () => {
  const model = buildPrerequisitesChecklist({
    manifest: { title: "Wording check", products: ["m365-copilot-hub"], adminPrerequisites: { tenantAndCloud: [{ id: "purview-dlp-dspm-roles", title: "x", adminPath: "Microsoft Purview portal", status: "Required", details: "x", requiredBy: ["Step 4 - Protect Copilot data"] }] } },
    markdown: "# Wording check\n\n## Prerequisites\n\n- Access to the Microsoft 365 admin center at https://admin.microsoft.com. Roles for Microsoft Purview and the SharePoint admin center: Not confirmed in Microsoft Learn.\n",
    now: NOW,
  });
  const items = model.sections.flatMap((s) => s.items);
  const unconfirmed = items.find((i) => i.confirm);
  assert.ok(unconfirmed, "the unconfirmed sentence became a confirm line");
  assert.match(unconfirmed.confirm, /^Confirm with your Microsoft representative \(not confirmed in Microsoft Learn\): roles for Microsoft Purview/);
  assert.doesNotMatch(unconfirmed.text, /Not confirmed in Microsoft Learn/);
  assert.match(renderPrerequisitesChecklistHtml(model), /class="confirm-note">Confirm with your Microsoft representative/);

  const purview = items.find((i) => i.role === "security-admin");
  assert.deepEqual(purview.neededFor, ["Protect Copilot data"], "the step label is removed and only the topic name stays");
  assert.match(purview.learn.url, /^https:\/\/learn\.microsoft\.com\/purview\//);
});

// ── Brand profile ───────────────────────────────────────────────────────────

test("the lab's brand (name, colors, font, logo, support contact) is applied to every format", () => {
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
  const opts = { branding: brand, logoSourcePath: ctx.logo };
  const html = render(ctx.multi, "html", opts);
  assert.match(html.text, /Fabrikam Learning/);
  assert.match(html.text, /--band: #7a1f5c/);
  assert.match(html.text, /<img src="data:image\/png;base64,/);
  assert.match(html.text, /Calibri/);
  assert.match(html.text, /Prepared for the Fabrikam AI workshop/);
  assert.match(html.text, /Fabrikam Workshop Desk at workshops@fabrikam\.example/);
  assert.match(html.text, /content: "[^"]*Fabrikam Learning - Confidential/, "the print footer carries the brand's footer text");

  const docx = render(ctx.multi, "docx", opts);
  assert.deepEqual(checkDocxPackage(docx.buffer), []);
  const entries = readZipStrict(docx.buffer).entries;
  assert.ok(entries.has("word/media/image1.png"), "the logo is embedded");
  assert.match(entries.get("word/document.xml").toString("utf8"), /w:fill="7A1F5C"/);
  assert.match(docxText(docx.buffer), /Fabrikam Learning/);
  assert.match(docxText(docx.buffer), /Fabrikam Workshop Desk at workshops@fabrikam\.example/);

  const pdf = render(ctx.multi, "pdf", opts);
  assert.match(pdf.buffer.toString("latin1"), /\/XObject/, "the logo is drawn in the PDF");
  assert.match(render(ctx.multi, "md", opts).text, /\*\*Prepared for:\*\* Fabrikam Learning/);

  const plain = render(ctx.multi, "html");
  assert.doesNotMatch(plain.text, /Fabrikam|<img /);
  assert.doesNotMatch(docxText(render(ctx.multi, "docx").buffer), /Fabrikam/);
});

// ── Labs built before this document existed ─────────────────────────────────

test("a lab without a saved administrator model, or even without module records, still produces the document", () => {
  const original = render(ctx.multi, "md").model;
  const root = tmp("prereq-old-labs-");
  const copy = (name, edit) => {
    cpSync(ctx.multi.outputDir, join(root, name), { recursive: true });
    const file = join(root, name, "manifest.json");
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    edit(manifest);
    writeFileSync(file, JSON.stringify(manifest));
  };
  copy("no-admin-model", (m) => {
    delete m.adminPrerequisites;
    delete m.topicDocuments;
    delete m.customization;
  });
  copy("markdown-only", (m) => {
    delete m.adminPrerequisites;
    delete m.modules;
    delete m.customization;
    delete m.request;
  });
  const titles = (model) => model.sections.flatMap((s) => s.items.map((i) => i.title || i.text.slice(0, 40)));

  const rebuilt = renderGeneratedLabPrerequisites(root, "no-admin-model", "md", {}, { now: NOW });
  assert.equal(rebuilt.status, 200);
  assert.deepEqual(titles(rebuilt.model), titles(original), "the same document is rebuilt from the manifest's modules");

  const markdownOnly = renderGeneratedLabPrerequisites(root, "markdown-only", "docx", {}, { now: NOW });
  assert.equal(markdownOnly.status, 200);
  assert.deepEqual(checkDocxPackage(markdownOnly.buffer), []);
  assert.ok(markdownOnly.model.itemCount > 0);
  assert.ok(markdownOnly.model.sections.some((s) => s.id === "attendees"), "the lab's own Prerequisites block is still read");

  const bare = buildPrerequisitesChecklist({ manifest: {}, markdown: "", now: NOW });
  assert.equal(bare.title, "Workshop");
  assert.ok(renderPrerequisitesChecklistHtml(bare).includes("Prerequisites checklist"));
});

test("term replacements and customer tokens reach the checklist, and no tenant address or id gets in", () => {
  // Built at run time so no address or identifier-shaped value is written in this file.
  const site = `https://${["contoso", "sharepoint", "com"].join(".")}/sites/workshop`;
  const environmentId = ["11111111", "2222", "3333", "4444", "555555555555"].join("-");
  const out = render(ctx.minimal, "md", {}, { Manufacturing: "Fabrikam Precision" });
  assert.match(out.text, /Fabrikam Precision/);
  assert.doesNotMatch(out.text, /Manufacturing/);

  const model = buildPrerequisitesChecklist({
    manifest: { title: "Tenant check", products: ["sharepoint-ai"], sharepointSite: { name: "Workshop Site", url: site } },
    markdown: [
      "# Tenant check",
      "",
      "## Prerequisites",
      "",
      `- Target SharePoint site: [${site}](${site}) — confirm you can open this site before starting.`,
      `- Open ${site} and the environment ${environmentId} before you start.`,
      "",
    ].join("\n"),
    now: NOW,
  });
  const all = renderPrerequisitesChecklistMarkdown(model) + renderPrerequisitesChecklistHtml(model);
  assert.ok(!all.includes(new URL(site).hostname), "no tenant address");
  assert.ok(!all.includes(environmentId), "no environment id");
  assert.doesNotMatch(all, GUID);
  assert.match(all, /The SharePoint site for the workshop/);
});

// ── Routes ──────────────────────────────────────────────────────────────────

test("the export route serves each prerequisites format, validates the format and the lab, and leaves the other exports alone", async () => {
  const base = await startServer(ctx.storageRoot);
  const labId = ctx.multi.labId;
  const url = (format, prefix = "/api/lab-builder/generated", id = labId) => `${base}${prefix}/${encodeURIComponent(id)}/export?format=${format}`;
  const expected = {
    "prerequisites-docx": [/wordprocessingml\.document/, "docx"],
    "prerequisites-pdf": [/application\/pdf/, "pdf"],
    "prerequisites-html": [/text\/html/, "html"],
    "prerequisites-md": [/text\/markdown/, "md"],
    "prerequisites-markdown": [/text\/markdown/, "md"],
  };
  for (const prefix of ["/api/lab-builder/generated", "/api/generated-labs"]) {
    for (const [format, [type, ext]] of Object.entries(expected)) {
      const res = await fetch(url(format, prefix));
      assert.equal(res.status, 200, `${prefix} ${format}`);
      assert.match(res.headers.get("content-type") || "", type);
      assert.match(res.headers.get("content-disposition") || "", new RegExp(`Prerequisites checklist\\.${ext}`));
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      const body = Buffer.from(await res.arrayBuffer());
      if (ext === "docx") assert.deepEqual(checkDocxPackage(body), []);
      if (ext === "pdf") assert.match(body.subarray(0, 8).toString("latin1"), /^%PDF-1\.4/);
      if (ext === "html") assert.match(body.toString("utf8"), /<!DOCTYPE html>/);
      if (ext === "md") assert.match(body.toString("utf8"), /^# Prerequisites checklist/);
    }
  }

  const post = await fetch(url("prerequisites-md"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ replacements: { Manufacturing: "Fabrikam Precision" } }) });
  assert.equal(post.status, 200);
  assert.match(await post.text(), /Fabrikam Precision/);

  const badFormat = await fetch(url("prerequisites-xlsx"));
  assert.equal(badFormat.status, 400);
  assert.match((await badFormat.json()).error, /prerequisites-docx/);
  assert.equal((await fetch(url("prerequisites-"))).status, 400);
  assert.equal((await fetch(url("prerequisites-docx", "/api/lab-builder/generated", "no-such-lab"))).status, 404);
  assert.equal((await fetch(url("prerequisites-docx", "/api/lab-builder/generated", "..%2F..%2Fetc"))).status >= 400, true);
  assert.equal((await fetch(url("prerequisites-docx", "/api/lab-builder/generated", "bad%20id"))).status, 400);

  // The existing exports behave as before.
  const lab = await fetch(url("docx"));
  assert.equal(lab.status, 200);
  assert.doesNotMatch(lab.headers.get("content-disposition") || "", /Prerequisites checklist/);
  assert.equal((await fetch(url("exe"))).status, 400);
  assert.equal((await fetch(url("facilitator-docx"))).status, 200);

  // The preview is the same document, as one page of HTML, with a count.
  const preview = await fetch(`${base}/api/lab-builder/generated/${encodeURIComponent(labId)}/prerequisites`);
  assert.equal(preview.status, 200);
  const data = await preview.json();
  assert.match(data.html, /Please complete before the workshop/);
  assert.ok(data.itemCount > 5 && data.roles.length > 2 && data.sections.length > 2);
  assert.deepEqual(Object.keys(data).sort(), ["baseName", "html", "itemCount", "roles", "sections", "title"], "no internal ids in the preview");
  assert.equal((await fetch(`${base}/api/lab-builder/generated/no-such-lab/prerequisites`)).status, 404);
  assert.equal((await fetch(`${base}/api/generated-labs/${encodeURIComponent(labId)}/prerequisites`)).status, 200);
});

test("the workshop ZIP carries the customer checklist as one extra top-level file and keeps its other contents", async () => {
  const collect = async (options) => {
    const chunks = [];
    const sink = new Writable({ write(chunk, _enc, done) { chunks.push(chunk); done(); } });
    await exportGeneratedLab(ctx.generatedRoot, ctx.multi.labId, {}, sink, options);
    return readZipStrict(Buffer.concat(chunks), { opc: false }).entries;
  };
  const all = await collect({ formats: "all" });
  const topLevel = [...all.keys()].filter((name) => !name.includes("/"));
  const checklist = topLevel.filter((name) => /^Send to Customer - Prerequisites Checklist - .+\.docx$/.test(name));
  assert.equal(checklist.length, 1, `one customer file at the top: ${topLevel}`);
  assert.deepEqual(checkDocxPackage(all.get(checklist[0])), []);
  const manifest = JSON.parse(all.get("export-manifest.json").toString("utf8"));
  assert.equal(manifest.customerPrerequisitesChecklist, checklist[0]);
  assert.ok(all.has(`${ctx.multi.labId}/index.md`) && all.has("README.md"));
  assert.match(all.get("README.md").toString("utf8"), /only the prerequisites, safe to send to the customer/);
  assert.ok([...all.keys()].some((name) => name.includes("/Facilitator Guide/")), "the facilitator guide stays where it was");

  const pdfOnly = await collect({ formats: "pdf" });
  assert.ok([...pdfOnly.keys()].some((name) => /^Send to Customer - Prerequisites Checklist - .+\.pdf$/.test(name)));
  assert.ok(![...pdfOnly.keys()].some((name) => /^Send to Customer .+\.docx$/.test(name)));
});

// ── The page: button, format picker, preview ────────────────────────────────

function uiContext() {
  const elements = new Map();
  const el = (id, extra = {}) => {
    const node = { id, textContent: "", srcdoc: "", open: false, focus() { this.focused = true; }, showModal() { this.open = true; }, close() { this.open = false; }, addEventListener() {}, ...extra };
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
      if (/\/prerequisites$/.test(String(url))) return { ok: true, status: 200, json: async () => ({ itemCount: 12, roles: [{}, {}, {}], html: "<p>Please complete before the workshop</p>" }) };
      return { ok: true, status: 200, blob: async () => new Blob(["x"], { type: "application/pdf" }), json: async () => ({}) };
    },
    escapeHtml: (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    toast: (message, kind) => toasts.push([message, kind]),
    lbDownloadText: (name, data, mime) => downloads.push([name, mime]),
    URL, Blob, console, setTimeout, clearTimeout,
  });
  vm.runInContext(readFileSync(join(PORTAL_ROOT, "public", "generated-labs.js"), "utf8"), context);
  vm.runInContext("globalThis.__ui = { lbGeneratedActionButtonsHtml, lbDownloadPrerequisites, lbPreviewPrerequisites, lbPrerequisitesGroupHtml, lbPrereq };", context);
  return { ui: context.__ui, el, toasts, downloads, fetches };
}

test("the lab panel offers one Download prerequisites checklist button, a format picker, a one-line reason, and a preview", async () => {
  const { ui, el, toasts, downloads, fetches } = uiContext();
  const html = ui.lbGeneratedActionButtonsHtml("my-lab-slug", "Fabrikam Copilot Readiness Lab", { scopePrefix: "lb-zip-fmt-item" });
  const visible = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.equal((html.match(/data-gen-action="export-prereqs"/g) || []).length, 1);
  assert.match(visible, /Download prerequisites checklist/);
  assert.match(visible, /Only the prerequisites, safe to send to the customer\./);
  const picker = html.match(/<select[^>]*data-prereq-format-select[^>]*>([\s\S]*?)<\/select>/)[1];
  assert.deepEqual([...picker.matchAll(/<option value="([a-z]+)">([^<]+)<\/option>/g)].map((m) => `${m[1]}: ${m[2]}`), ["docx: Word (.docx), recommended", "pdf: PDF (.pdf)", "html: Web page (.html)", "md: Markdown (.md)"]);
  assert.match(html, /<label class="sr-only" for="lb-zip-fmt-item-prereq-my-lab-slug-format">/, "the picker has a label");
  assert.match(html, /aria-describedby="lb-zip-fmt-item-prereq-my-lab-slug-note"/);
  assert.match(html, /data-gen-action="preview-prereqs"/);
  assert.doesNotMatch(visible, /my-lab-slug/, "no id in the visible words");
  assert.doesNotMatch(html, /clipboard/i);

  // Downloading uses the chosen format and names the file for the customer.
  const button = { closest: () => ({ querySelector: () => ({ value: "pdf" }) }) };
  assert.equal(ui.lbPrereq.format, "docx");
  await ui.lbDownloadPrerequisites("my-lab-slug", "pdf");
  assert.match(fetches.at(-1), /\/my-lab-slug\/export\?format=prerequisites-pdf$/);
  assert.deepEqual(downloads.at(-1), ["Lab - Prerequisites checklist.pdf", "application/pdf"]);
  assert.equal(toasts.at(-1)[1], "success");
  await ui.lbDownloadPrerequisites("my-lab-slug", "not-a-format");
  assert.match(fetches.at(-1), /format=prerequisites-docx$/, "an unknown format falls back to Word");

  // The preview fills a dialog with exactly what the customer gets.
  const dialog = el("lb-prereq-preview-dialog");
  const frame = el("lb-prereq-preview-frame");
  const desc = el("lb-prereq-preview-desc");
  el("lb-prereq-preview-error");
  el("lb-prereq-preview-close");
  await ui.lbPreviewPrerequisites("my-lab-slug", button);
  assert.equal(dialog.open, true);
  assert.match(frame.srcdoc, /Please complete before the workshop/);
  assert.equal(desc.textContent, "This is what the customer gets: 12 items across 3 roles, and nothing else from the lab.");
  assert.equal(ui.lbPrereq.format, "pdf", "the download in the dialog uses the format that was picked");
});

test("the page keeps the wizard and the lab panel in step, adds no copy buttons, and the dialog is accessible", () => {
  const source = readFileSync(join(PORTAL_ROOT, "public", "generated-labs.js"), "utf8");
  const page = readFileSync(join(PORTAL_ROOT, "public", "index.html"), "utf8");
  assert.doesNotMatch(source, /clipboard/i, "clipboard writes stay in screenshot-center.js and use-case-builder.js");
  assert.match(page, /<dialog id="lb-prereq-preview-dialog"[^>]*aria-labelledby="lb-prereq-preview-title"[^>]*aria-describedby="lb-prereq-preview-desc"/);
  assert.match(page, /<iframe id="lb-prereq-preview-frame"[^>]*title="Preview of the prerequisites checklist"[^>]*sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"/, "the preview runs in its own sandbox with no access to the page");
  const app = readFileSync(join(PORTAL_ROOT, "public", "app.js"), "utf8");
  assert.match(app, /lbGeneratedActionButtonsHtml\(data\.labId, labTitle\)/, "the final wizard step uses the same download group");
});

// ── Command line ────────────────────────────────────────────────────────────

test("the command line writes the checklist in each format, reads older labs, and fails plainly", () => {
  const cli = join(REPO_ROOT, "tools", "lab-builder", "export-prerequisites.mjs");
  const out = tmp("prereq-cli-");
  const run = (args, env = {}) => execFileSync(process.execPath, [cli, ...args], { cwd: REPO_ROOT, encoding: "buffer", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const fails = (args) => {
    try {
      run(args);
    } catch (err) {
      return { status: err.status, stderr: err.stderr.toString("utf8") };
    }
    return null;
  };

  const docxFile = join(out, "checklist.docx");
  run(["--lab", ctx.multi.labId, "--root", ctx.generatedRoot, "--out", docxFile]);
  assert.deepEqual(checkDocxPackage(readFileSync(docxFile)), []);
  run(["--lab", ctx.multi.outputDir, "--format", "pdf", "--out", out]);
  const pdfName = readdirSync(out).find((name) => name.endsWith(" - Prerequisites checklist.pdf"));
  assert.ok(pdfName, "a folder as --out gets a descriptive file name");
  assert.match(readFileSync(join(out, pdfName)).subarray(0, 8).toString("latin1"), /^%PDF-1\.4/);
  const md = run(["--lab", ctx.minimal.labId, "--root", ctx.generatedRoot, "--format", "md", "--out", "-"]).toString("utf8");
  assert.match(md, /^# Prerequisites checklist/);
  assert.match(run(["--lab", ctx.minimal.labId, "--root", ctx.generatedRoot, "--format", "html", "--out", "-"]).toString("utf8"), /<!DOCTYPE html>/);

  assert.equal(fails(["--lab", "no-such-lab", "--root", ctx.generatedRoot]).status, 1);
  assert.match(fails(["--lab", "no-such-lab", "--root", ctx.generatedRoot]).stderr, /No generated lab "no-such-lab" was found/);
  assert.match(fails(["--lab", ctx.minimal.labId, "--root", ctx.generatedRoot, "--format", "xlsx"]).stderr, /--format must be one of docx, pdf, html, md/);
  assert.match(fails([]).stderr, /--lab is required/);
  assert.match(fails(["--nope"]).stderr, /Unknown flag --nope/);
  assert.match(run(["--help"]).toString("utf8"), /--lab <id\|folder>/);
  assert.equal(normalizePrerequisitesFormat("Markdown"), "md");
  assert.equal(normalizePrerequisitesFormat("exe"), null);
});
