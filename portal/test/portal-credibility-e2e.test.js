import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import vm from "node:vm";

import { getCatalog, getFeature, getFeatures } from "../lib/lab-builder/catalog.js";
import { getProducts } from "../lib/lab-builder/products.js";
import { recommend } from "../lib/lab-builder/recommend.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import { resolveGeneratedAsset } from "../lib/lab-builder/generated-labs.js";
import { DEFAULT_BRANDING } from "../lib/branding.js";
import {
  exportGeneratedLab,
  isCustomBranding,
  renderGeneratedLabMarkdown,
  resolveSafeGeneratedLabDir,
} from "../lib/exporter.js";
import { validateGeneratedLab } from "../lib/validator.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

const repoRoot = resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

function tempDir(prefix = "portal-credibility-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function collectStream(fn) {
  return new Promise((resolvePromise, rejectPromise) => {
    const out = new PassThrough();
    const chunks = [];
    out.on("data", (chunk) => chunks.push(chunk));
    out.on("end", () => resolvePromise(Buffer.concat(chunks)));
    out.on("error", rejectPromise);
    Promise.resolve(fn(out)).catch(rejectPromise);
  });
}

function listZipEntries(buffer) {
  // Read central-directory file headers (signature 0x02014b50) without external unzip deps.
  const entries = [];
  let offset = 0;
  while (offset + 46 <= buffer.length) {
    const idx = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), offset);
    if (idx === -1 || idx + 46 > buffer.length) break;
    const nameLen = buffer.readUInt16LE(idx + 28);
    const extraLen = buffer.readUInt16LE(idx + 30);
    const commentLen = buffer.readUInt16LE(idx + 32);
    const name = buffer.subarray(idx + 46, idx + 46 + nameLen).toString("utf8");
    entries.push(name);
    offset = idx + 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const srv = createServer();
    srv.once("error", rejectPort);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });
}

async function bootServer(extraEnv = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      PORTAL_AUTH_DISABLED: "true",
      AZURE_KEYVAULT_URL: "",
      LAB_BUILDER_LINK_CHECK: "off",
      LAB_BUILDER_VENDOR_DOCS: "off",
      ...extraEnv,
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${child.exitCode}`);
    try {
      const r = await fetch(`${base}/api/config`);
      if (r.ok) break;
    } catch {
      // retry
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error("server failed to start in time");
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { base, stop: () => child.kill() };
}

test("generated-lab path safety rejects traversal, malformed slugs, and missing labs", () => {
  const { dir, cleanup } = tempDir("gen-safety-");
  try {
    for (const bad of ["", ".", "../portal", "..\\portal", "a/b", "bad spaces", "-leading"]) {
      const res = resolveSafeGeneratedLabDir(dir, bad);
      assert.equal(res.status, 400, `expected 400 for ${bad}`);
      assert.equal(validateGeneratedLab(dir, bad).status, 400);
    }
    assert.equal(resolveSafeGeneratedLabDir(dir, "missing-lab").status, 404);
    assert.equal(validateGeneratedLab(dir, "missing-lab").status, 404);
  } finally {
    cleanup();
  }
});

test("generated-lab export and structural validation support unbranded and custom-branded Markdown + ZIP", async () => {
  const { dir: genRoot, cleanup: cleanGen } = tempDir("gen-export-");
  const { dir: assetRoot, cleanup: cleanAssets } = tempDir("gen-assets-");
  try {
    const built = await generateLab(
      {
        product: "copilot-studio",
        features: ["create-agent"],
        level: 100,
        harness: "standard",
        industry: "healthcare",
        title: "Healthcare Triage Lab",
        agentName: "Clinical Intake Assistant",
      },
      { outputRoot: genRoot, useLearnMcp: false, useLlm: false },
    );

    // Structural validation passes on the generated lab.
    const valRes = validateGeneratedLab(genRoot, built.labId);
    assert.equal(valRes.status, 200);
    assert.equal(valRes.body.failed, 0);
    assert.ok(valRes.body.passed > 0);

    // Place a placeholder SVG under <labDir>/assets/ and a real captured PNG in assetRoot to verify resolution.
    const capturedPng = join(assetRoot, "sample-shot.png");
    writeFileSync(capturedPng, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    mkdirSync(join(built.outputDir, "assets"), { recursive: true });
    writeFileSync(join(built.outputDir, "assets", "sample-shot.png"), Buffer.from([0x00]), "utf8");

    // Default branding is NOT treated as custom branding so generated labs keep their own organization context.
    assert.equal(isCustomBranding({ ...DEFAULT_BRANDING }), false);

    const unbrandedMd = renderGeneratedLabMarkdown(
      genRoot,
      built.labId,
      { "Healthcare Triage Lab": "Customized Healthcare Lab" },
      { branding: { ...DEFAULT_BRANDING } },
    );
    assert.equal(unbrandedMd.status, 200);
    assert.doesNotMatch(unbrandedMd.markdown, /Provisioning Portal/);
    assert.match(unbrandedMd.markdown, /Customized Healthcare Lab/);

    // Custom branding adds header banner + bundles logo and captured screenshot into the ZIP.
    const logoPath = join(assetRoot, "brand-logo.png");
    writeFileSync(logoPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const customBrand = {
      companyName: "Northwind Health",
      tagline: "Clinical AI Academy",
      primaryColor: "#107c41",
      logo: "/uploads/brand-logo.png",
    };
    assert.equal(isCustomBranding(customBrand), true);

    const brandedMd = renderGeneratedLabMarkdown(genRoot, built.labId, {}, { branding: customBrand });
    assert.equal(brandedMd.status, 200);
    assert.match(brandedMd.markdown, /Northwind Health/);
    assert.match(brandedMd.markdown, /Clinical AI Academy/);

    const zipBuffer = await collectStream((out) =>
      exportGeneratedLab(genRoot, built.labId, {}, out, {
        branding: customBrand,
        logoSourcePath: logoPath,
        resolveAsset: (_root, _id, file) =>
          file === "sample-shot.png" ? { status: 200, path: capturedPng } : resolveGeneratedAsset(genRoot, built.labId, file),
      }),
    );
    assert.equal(zipBuffer[0], 0x50);
    assert.equal(zipBuffer[1], 0x4b);
    const entries = listZipEntries(zipBuffer);
    assert.ok(entries.includes(`${built.labId}/index.md`), `missing index.md in ${entries}`);
    assert.ok(entries.includes(`${built.labId}/manifest.json`), `missing manifest.json in ${entries}`);
    assert.ok(entries.includes("_branding/logo.png"), `missing _branding/logo.png in ${entries}`);
    assert.ok(entries.includes(`${built.labId}/assets/sample-shot.png`), `missing screenshot in ${entries}`);
    assert.ok(entries.includes("export-manifest.json"), `missing export-manifest.json in ${entries}`);
  } finally {
    cleanGen();
    cleanAssets();
  }
});

test("HTTP generated-lab export and validate endpoints work on canonical and alias routes without auto-selecting chapters", async () => {
  const { dir: genRoot, cleanup } = tempDir("gen-http-");
  let srv;
  try {
    const built = await generateLab(
      { product: "ai-foundry", features: ["fdy-orient-foundry"], level: 100, industry: "financial-services" },
      { outputRoot: genRoot, useLearnMcp: false, useLlm: false },
    );
    srv = await bootServer({ LAB_BUILDER_OUTPUT_DIR: genRoot });

    for (const prefix of ["/api/lab-builder/generated", "/api/generated-labs"]) {
      const val = await fetch(`${srv.base}${prefix}/${built.labId}/validate`);
      assert.equal(val.status, 200);
      const valBody = await val.json();
      assert.equal(valBody.labId, built.labId);
      assert.equal(valBody.failed, 0);

      const md = await fetch(`${srv.base}${prefix}/${built.labId}/export?format=md`);
      assert.equal(md.status, 200);
      assert.match(md.headers.get("content-type") || "", /text\/markdown/);
      assert.match(md.headers.get("content-disposition") || "", new RegExp(`${built.labId}\\.md`));
      assert.match(await md.text(), /^#\s+/m);

      const zip = await fetch(`${srv.base}${prefix}/${built.labId}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format: "zip" }),
      });
      assert.equal(zip.status, 200);
      assert.match(zip.headers.get("content-type") || "", /application\/zip/);
      const buf = Buffer.from(await zip.arrayBuffer());
      assert.equal(buf[0], 0x50);
      assert.equal(buf[1], 0x4b);
    }

    const bad = await fetch(`${srv.base}/api/lab-builder/generated/missing-slug/export`);
    assert.equal(bad.status, 404);
    const badFormat = await fetch(`${srv.base}/api/lab-builder/generated/${built.labId}/export?format=exe`);
    assert.equal(badFormat.status, 400);
  } finally {
    if (srv) srv.stop();
    cleanup();
  }
});

test("unchecking a required prerequisite explains which selected topic depends on it before second-click exclusion", async () => {
  const wizardSrc = readFileSync(new URL("../public/lab-builder-wizard.js", import.meta.url), "utf8");
  const warningsEl = { innerHTML: "" };
  const dummyEl = () => ({
    innerHTML: "",
    textContent: "",
    hidden: false,
    disabled: false,
    value: "",
    style: {},
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {},
    querySelectorAll: () => [],
  });
  const elements = new Map([["lb-topic-warnings", warningsEl]]);
  const toasts = [];

  // Pick a real same-level Copilot Studio capability pair where `dependent` requires `prereq`.
  const allCs = getFeatures().filter((f) => (!f.product || f.product === "copilot-studio") && (f.harness || []).includes("standard"));
  const dependent = allCs.find((f) => (f.prereqs || []).some((pid) => getFeature(pid)?.level === f.level));
  assert.ok(dependent, "expected at least one same-level prerequisite pair in catalog");
  const prereq = getFeature(dependent.prereqs.find((pid) => getFeature(pid)?.level === dependent.level));

  const context = {
    console,
    Set,
    Map,
    Array,
    Object,
    Number,
    String,
    Boolean,
    Promise,
    RegExp,
    Symbol,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
    escapeHtml: (s) =>
      String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;"),
    toast: (msg, type) => toasts.push({ msg, type }),
    document: {
      getElementById: (id) => elements.get(id) || dummyEl(),
      querySelectorAll: () => [],
    },
    fetch: async (_url, opts) => ({
      ok: true,
      json: async () => recommend(JSON.parse(opts.body)),
    }),
  };

  vm.createContext(context);
  vm.runInContext(
    `${wizardSrc}\nglobalThis.__wizard = { LB_STEP, labBuilder, lbSetTopic, lbSetPrerequisite, lbRefresh };`,
    context,
  );

  const { LB_STEP, labBuilder, lbSetTopic, lbSetPrerequisite, lbRefresh } = context.__wizard;
  labBuilder.catalog = getCatalog();
  labBuilder.products = ["copilot-studio"];
  labBuilder.harness = "standard";
  labBuilder.level = dependent.level;
  labBuilder.step = LB_STEP.topics;
  labBuilder.picked = new Set([prereq.id, dependent.id]);
  await lbRefresh();

  // First uncheck of prereq while dependent still requires it:
  // planner keeps prereq checked as a prerequisite, and the UI explains which topic requires it!
  lbSetTopic(prereq.id, false);
  await new Promise((r) => setTimeout(r, 20));
  assert.match(warningsEl.innerHTML, /lb-prereq-notice/);
  assert.ok(warningsEl.innerHTML.includes(context.escapeHtml(prereq.name)), `expected "${prereq.name}" in ${warningsEl.innerHTML}`);
  assert.ok(warningsEl.innerHTML.includes(context.escapeHtml(dependent.name)), `expected "${dependent.name}" in ${warningsEl.innerHTML}`);
  assert.ok(toasts.some((t) => t.msg.includes(dependent.name)));

  // Second uncheck (now marked required=true) intentionally excludes the prerequisite and clears the notice.
  lbSetTopic(prereq.id, false, true);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(labBuilder.excluded.has(prereq.id));
  assert.doesNotMatch(warningsEl.innerHTML, /lb-prereq-notice/);
});

test("repo docs and portal UI stay accurate on 195 capabilities across 6 products, lab numbers, print rules, and registry hygiene", () => {
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  const features = getFeatures();
  const products = getProducts();
  assert.equal(features.length, 195, "catalog feature count changed — update README.md capability count");
  assert.equal(products.length, 6, "product count changed — update README.md product count");
  assert.match(readme, new RegExp(`The catalog\\s+covers ${features.length} capabilities across ${products.length} products`));
  assert.doesNotMatch(readme, /128 capabilities/i);
  assert.match(readme, /\[Computer Use — Production Readiness & Governance \(Preview\)\]\(\.\/labs\/29-computer-use-ga\/index\.md\)/);
  assert.doesNotMatch(readme, /\[Computer Use \(GA\)\]/i);
  assert.doesNotMatch(readme, /generally available desktop automation patterns/i);

  const ownedDocs = [
    "README.md",
    "portal/README.md",
    "docs/codespaces.md",
    "docs/app-registration-setup.md",
    "docs/step-validation.md",
    "docs/feature-tour.md",
  ];
  for (const rel of ownedDocs) {
    const content = readFileSync(join(repoRoot, rel), "utf8");
    assert.doesNotMatch(content, /packagefeedproxy/i, `${rel} leaked internal npm proxy`);
    assert.doesNotMatch(content, /GitHub Copilot harness/i, `${rel} used wrong harness name`);
    assert.doesNotMatch(content, /Azure AI Studio/i, `${rel} used retired Azure AI Studio name`);
    assert.doesNotMatch(content, /Power Virtual Agents/i, `${rel} used retired Power Virtual Agents name`);
  }

  const indexHtml = readFileSync(join(repoRoot, "portal/public/index.html"), "utf8");
  assert.match(indexHtml, /Lab 04: IT Operations Agent/);
  assert.match(indexHtml, /Lab 18: Account Orchestration/);
  assert.match(indexHtml, /Lab 06: Energy Operations Weather Agent/);
  assert.doesNotMatch(indexHtml, /Lab 01: IT Operations Agent/);
  assert.doesNotMatch(indexHtml, /Lab 15: Account Orchestration/);
  assert.match(indexHtml, /body\[data-print-target="generated"\]\s+#lb-result-preview/);
  assert.match(indexHtml, /:root\[data-theme="light"\],\s*body\[data-theme="light"\]/);
});
