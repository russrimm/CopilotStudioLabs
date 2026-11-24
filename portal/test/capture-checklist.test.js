// The screenshot to-do list: what is left for a lab, who can capture it, and the exact steps for the shots only a person can do.
// It reads the plan the Screenshot Center runs, so these tests build a real lab (offline) and ask the list and the route.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

import { buildLabChecklist, renderChecklistMarkdown } from "../lib/capture/checklist.js";
import { registerCaptureRoutes } from "../lib/capture/routes.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import { makePng } from "../../tools/screenshot-capture/test/fixtures/png.mjs";

const cleanups = [];
const ctx = {};
const tmp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

before(async () => {
  ctx.root = tmp("capture-checklist-");
  ctx.generatedRoot = join(ctx.root, "generated-labs");
  mkdirSync(ctx.generatedRoot, { recursive: true });
  const emptyLabs = tmp("capture-checklist-labs-");
  const build = await generateLab(
    { products: ["copilot-studio"], features: ["mc-create-agent", "mc-instructions", "mc-knowledge", "mc-preview-test", "mc-publish-agent"], harness: "microsoft-copilot", includeCore: false },
    { outputRoot: ctx.generatedRoot, labsDir: emptyLabs, useLearnMcp: false, useLlm: false },
  );
  ctx.labId = build.labId;
  ctx.labDir = build.outputDir;
});

after(() => {
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {
      /* best effort */
    }
  }
});

test("every missing picture is on the list once, either for the computer or for you, with steps for the ones that need you", () => {
  const list = buildLabChecklist({ generatedRoot: ctx.generatedRoot, labId: ctx.labId });
  assert.equal(list.status, 200);
  assert.ok(list.counts.missing > 0, "a freshly built lab has pictures still to capture");
  assert.equal(list.counts.missing, list.counts.computer + list.counts.you);
  assert.equal(new Set([...list.computer, ...list.you].map((item) => item.filename)).size, list.counts.missing, "no picture is listed twice");
  assert.ok(list.you.length > 0 && list.computer.length > 0, "both groups exist for this lab");
  for (const item of list.you) {
    assert.ok(item.steps.length > 0, `${item.filename} has steps`);
    assert.ok(item.why, `${item.filename} says why it needs you`);
    assert.ok(!item.steps.some((line) => /press Capture this screen/i.test(line)), "the companion's last step is left out");
  }
  const figures = [...list.you, ...list.computer].map((item) => item.figure).filter(Boolean);
  assert.deepEqual([...list.you].map((item) => item.figure), [...list.you].map((item) => item.figure).sort((a, b) => Number(a.split(".")[0]) - Number(b.split(".")[0]) || Number(a.split(".")[1]) - Number(b.split(".")[1])), "shots come in lab order");
  assert.ok(figures.length > 0);
});

test("no step sends a person to an Overview page that the agent page does not have", () => {
  const list = buildLabChecklist({ generatedRoot: ctx.generatedRoot, labId: ctx.labId });
  const steps = [...list.you, ...list.computer].flatMap((item) => item.steps);
  assert.ok(steps.some((line) => /^Open your agent .*in Copilot Studio\.$|^Open your agent in Copilot Studio\.$/.test(line)), "the lead says which agent to open");
  assert.ok(!steps.some((line) => /then Overview/i.test(line)));
});

test("a picture that has been captured leaves the list, and an unknown lab is a clear 404", () => {
  const before = buildLabChecklist({ generatedRoot: ctx.generatedRoot, labId: ctx.labId });
  const target = before.you[0];
  const dir = join(ctx.labDir, "screenshots");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, target.filename), makePng(1280, 720, [18, 90, 160]));
  const after = buildLabChecklist({ generatedRoot: ctx.generatedRoot, labId: ctx.labId, capturedDir: dir });
  assert.ok(![...after.you, ...after.computer].some((item) => item.filename === target.filename), "the finished picture is no longer listed");
  assert.equal(after.counts.missing, before.counts.missing - 1);
  rmSync(join(dir, target.filename), { force: true });

  assert.equal(buildLabChecklist({ generatedRoot: ctx.generatedRoot, labId: "no-such-lab" }).status, 404);
});

test("the Markdown is a printable to-do list: where to start, the steps for each picture that needs you, and no raw markup", () => {
  const list = buildLabChecklist({ generatedRoot: ctx.generatedRoot, labId: ctx.labId });
  const md = renderChecklistMarkdown(list, { generatedAt: "2026-01-01" });
  assert.match(md, /^# Screenshot to-do list: /);
  assert.match(md, /## Start here/);
  assert.match(md, /## Only you can do these \(\d+\)/);
  assert.match(md, /## The computer will capture these \(\d+\)/);
  for (const item of list.you) assert.ok(md.includes(item.filename) && md.includes(item.steps[0]), `${item.filename} is written out with its first step`);
  assert.ok(!md.split("\n").some((line) => /^\s+\d+\. /.test(line) && line.includes("**")), "step lines carry no raw bold markers");
  assert.match(renderChecklistMarkdown({ ...list, counts: { missing: 0, computer: 0, you: 0 }, computer: [], you: [] }), /Nothing is left/);
});

test("the lab panel shows the list: a start line, the steps behind each picture that needs you, and no raw markup from a caption", () => {
  const ui = vm.createContext({
    window: {},
    document: { getElementById: () => null, querySelector: () => null, addEventListener: () => {} },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    escapeHtml: (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    URL: globalThis.URL,
    Blob: globalThis.Blob,
    console,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(readFileSync(new URL("../public/generated-labs.js", import.meta.url), "utf8"), ui);
  vm.runInContext("globalThis.__ui = { lbRenderChecklistHtml, lbGeneratedActionButtonsHtml };", ui);

  const list = buildLabChecklist({ generatedRoot: ctx.generatedRoot, labId: ctx.labId });
  const html = ui.__ui.lbRenderChecklistHtml({ ...list, you: [{ ...list.you[0], caption: "A <b>bold</b> caption" }, ...list.you.slice(1)] });
  assert.match(html, new RegExp(`${list.counts.missing} pictures? still to capture`));
  assert.match(html, /Only you can do these/);
  assert.ok(html.includes("<details>") && html.includes("<ol>"), "each picture that needs you opens to its steps");
  assert.ok(!html.includes("<b>bold</b>") && html.includes("A &lt;b&gt;bold&lt;/b&gt; caption"));
  assert.match(html, /data-gen-action="shot-checklist-download"/);
  assert.match(ui.__ui.lbRenderChecklistHtml({ ...list, counts: { missing: 0, computer: 0, you: 0 }, you: [], computer: [] }), /Nothing is left/);
  assert.match(ui.__ui.lbGeneratedActionButtonsHtml(ctx.labId, "A lab"), /data-gen-action="shot-checklist"[^>]*>Screenshots left/);
});

test("the route returns the list and the Markdown for a lab, and refuses a bad lab id", async (t) => {
  const root = tmp("capture-checklist-http-");
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  registerCaptureRoutes(app, { generatedRoot: ctx.generatedRoot, dataDir: root, env: { PORTAL_STORAGE_ROOT: root }, detectServerBrowser: async () => ({ available: false }) });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  for (const prefix of ["/api/lab-builder/generated", "/api/generated-labs"]) {
    const res = await fetch(`${base}${prefix}/${encodeURIComponent(ctx.labId)}/screenshots/checklist`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.labId, ctx.labId);
    assert.equal(body.counts.missing, body.counts.computer + body.counts.you);
    assert.match(body.markdown, /Screenshot to-do list/);
  }
  assert.equal((await fetch(`${base}/api/lab-builder/generated/no-such-lab/screenshots/checklist`)).status, 404);
  assert.equal((await fetch(`${base}/api/lab-builder/generated/${encodeURIComponent("../x")}/screenshots/checklist`)).status, 400);
});
