import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";

import { generateLab } from "../lib/lab-builder/generator.js";
import {
  renderGeneratedLabDocx,
  renderGeneratedLabHtml,
  renderGeneratedLabMarkdown,
  renderGeneratedLabPdf,
} from "../lib/exporter.js";
import { renderLabMarkdown } from "../lib/markdown.js";
import { recommend } from "../lib/lab-builder/recommend.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const wizardSource = readFileSync(new URL("../public/lab-builder-wizard.js", import.meta.url), "utf8");
const generatedLabsSource = readFileSync(new URL("../public/generated-labs.js", import.meta.url), "utf8");

// ── Helpers ─────────────────────────────────────────────────────────────────

function cssRule(selectorFragment) {
  const escaped = selectorFragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = indexHtml.match(new RegExp(`(?:^|\\n)\\s*${escaped}[^{}]*\\{([^}]*)\\}`));
  assert.ok(match, `CSS rule for ${selectorFragment} must exist`);
  return match[1];
}

function declaration(block, property) {
  return block.match(new RegExp(`(?:^|[\\s;])${property}:\\s*([^;]+);`))?.[1].trim();
}

function tokens(blockStart) {
  const start = indexHtml.indexOf(blockStart);
  assert.ok(start >= 0, `${blockStart} block must exist`);
  const body = indexHtml.slice(start, indexHtml.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)].map((m) => [m[1], m[2]]));
}

function luminance(hex) {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? [...value].map((c) => c + c).join("") : value;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Read one entry from a ZIP buffer using its central directory (the writer may use data descriptors). */
function readZipEntry(buffer, name) {
  let offset = buffer.length - 22;
  while (offset >= 0 && buffer.readUInt32LE(offset) !== 0x06054b50) offset -= 1;
  assert.ok(offset >= 0, "end of central directory");
  const count = buffer.readUInt16LE(offset + 10);
  let cursor = buffer.readUInt32LE(offset + 16);
  for (let i = 0; i < count; i += 1) {
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const entryName = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (entryName === name) {
      const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
      const data = buffer.subarray(dataStart, dataStart + compressedSize);
      return (method === 8 ? zlib.inflateRawSync(data) : data).toString("utf8");
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`${name} not found in ZIP`);
}

/** Inflate every Flate stream of a PDF so the text-showing operators can be read. */
function pdfStreamText(buffer) {
  const raw = buffer.toString("latin1");
  const out = [];
  for (const match of raw.matchAll(/stream\r?\n/g)) {
    if (raw.slice(Math.max(0, match.index - 3), match.index) === "end") continue;
    const end = raw.indexOf("endstream", match.index);
    try {
      out.push(zlib.inflateSync(buffer.subarray(match.index + match[0].length, end)).toString("latin1"));
    } catch {
      // Not a Flate stream (for example an image).
    }
  }
  return out.join("\n");
}

const REFERENCE_SECTION_RE = /\*\*Microsoft Learn references\*\*\s*\n\s*\n((?:- .*\n?)+)/;

// ── 3. Microsoft Learn references render as a title only ────────────────────

let labPromise;
function builtLab() {
  labPromise ||= (async () => {
    const root = mkdtempSync(join(tmpdir(), "wizard-ux-"));
    const built = await generateLab(
      { product: "copilot-studio", features: ["create-agent"], level: 100, harness: "standard", industry: "healthcare" },
      { outputRoot: root, useLearnMcp: false, useLlm: false },
    );
    return { root, labId: built.labId || built.outputDir.split(/[\\/]/).pop(), markdown: built.markdown };
  })();
  return labPromise;
}

test("Markdown references are [Title](url) links with no raw URL beside them", async () => {
  const { root, labId } = await builtLab();
  const { markdown } = renderGeneratedLabMarkdown(root, labId, {});
  const items = markdown.match(REFERENCE_SECTION_RE)?.[1].trim().split("\n");
  assert.ok(items?.length > 0, "the lab lists Microsoft Learn references");
  for (const item of items) {
    assert.match(item, /^- \[[^\]]+\]\(https:\/\/learn\.microsoft\.com\/[^)\s]+\)$/, item);
    assert.doesNotMatch(item.replace(/\]\([^)]*\)/, "]"), /https?:\/\//, "the URL appears only as the link target");
  }
});

test("HTML references are anchors whose text is the title and whose URL is only the href", async () => {
  const { root, labId } = await builtLab();
  const { html } = renderGeneratedLabHtml(root, labId, {}, {});
  const list = html.match(/Microsoft Learn references<\/strong><\/p>\s*<ul>([\s\S]*?)<\/ul>/)?.[1];
  assert.ok(list, "the standalone HTML has a references list");
  const anchors = [...list.matchAll(/<a href="(https:\/\/[^"]+)"[^>]*>([^<]+)<\/a>/g)];
  assert.ok(anchors.length > 0);
  for (const [, href, text] of anchors) {
    assert.doesNotMatch(text, /https?:\/\//, `link text for ${href} is the title`);
  }
  assert.equal(list.replace(/<[^>]+>/g, "").match(/https?:\/\//g), null, "no URL is visible text");
  assert.doesNotMatch(html, /attr\(href\)/, "print CSS never appends the URL");
});

test("the in-app preview opens reference links in a new tab and shows only the title", () => {
  const html = renderLabMarkdown(
    "**Microsoft Learn references**\n\n- [Create a new agent (Microsoft Copilot)](https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/build-new-agent)\n",
  );
  const anchor = html.match(/<a [^>]*>[^<]*<\/a>/)[0];
  assert.match(anchor, /target="_blank"/);
  assert.match(anchor, /rel="noopener noreferrer"/);
  assert.match(anchor, />Create a new agent \(Microsoft Copilot\)<\/a>/, "the title text is unchanged");
  assert.equal(html.replace(/<[^>]+>/g, "").match(/https?:\/\//g), null, "no URL is visible text");
});

test("same-page and relative links keep opening in place", () => {
  const html = renderLabMarkdown("[Jump](#section) and [local](page.md)");
  assert.doesNotMatch(html, /target=/);
});

test("DOCX references are hyperlinks with the title as the only visible text", async () => {
  const { root, labId } = await builtLab();
  const rendered = renderGeneratedLabDocx(root, labId, {}, {});
  const documentXml = readZipEntry(rendered.buffer, "word/document.xml");
  const rels = readZipEntry(rendered.buffer, "word/_rels/document.xml.rels");
  assert.match(documentXml, /<w:hyperlink r:id="rIdLink\d+">/);
  assert.match(rels, /Target="https:\/\/learn\.microsoft\.com\//);
  const visibleText = [...documentXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("\n");
  assert.doesNotMatch(visibleText, /https?:\/\//, "no URL is visible text");
  assert.match(visibleText, /Microsoft Learn: Authoring first bot/);
});

test("PDF references draw only the title, with the URL kept in a link annotation", async () => {
  const { root, labId } = await builtLab();
  const rendered = renderGeneratedLabPdf(root, labId, {}, {});
  const raw = rendered.buffer.toString("latin1");
  assert.match(raw, /\/URI \(https:\/\/learn\.microsoft\.com\//, "the title is a clickable link");
  const drawn = pdfStreamText(rendered.buffer);
  assert.match(drawn, /\(Authoring\) Tj/, "the page content is readable by this check");
  assert.doesNotMatch(drawn, /https?:\/\//, "no URL is drawn on the page");
  assert.doesNotMatch(drawn, /\]\(/, "no Markdown link syntax is drawn on the page");
});

test("a link inside emphasis is a link in DOCX and PDF, not raw Markdown", async () => {
  const { renderMarkdownToDocxBuffer } = await import("../lib/lab-builder/docx-builder.js");
  const { renderMarkdownToPdfBuffer } = await import("../lib/lab-builder/pdf-builder.js");
  const markdown =
    "# Lab\n\n*Checked against [the Create an agent documentation](https://learn.microsoft.com/a), not the product.*\n\n**Read [Agents overview](https://learn.microsoft.com/b) first.**\n";

  const docx = renderMarkdownToDocxBuffer(markdown, {});
  const documentXml = readZipEntry(Buffer.isBuffer(docx) ? docx : docx.buffer, "word/document.xml");
  const visible = [...documentXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");
  assert.doesNotMatch(visible, /https?:\/\/|\]\(/);
  assert.equal([...documentXml.matchAll(/<w:hyperlink /g)].length, 2);

  const pdf = renderMarkdownToPdfBuffer(markdown, {});
  const buffer = Buffer.isBuffer(pdf) ? pdf : pdf.buffer;
  assert.equal([...buffer.toString("latin1").matchAll(/\/URI \(/g)].length, 2);
  assert.doesNotMatch(pdfStreamText(buffer), /https?:\/\/|\]\(/);
});

test("the in-app print view never appends a link's URL", () => {
  const printStart = indexHtml.indexOf("@media print");
  assert.ok(printStart > 0);
  const printCss = indexHtml.slice(printStart);
  assert.doesNotMatch(printCss, /content:\s*["'][^"']*\(["']?\s*attr\(href\)/);
  assert.match(printCss, /\.preview-frame a\[href\]::after\s*\{\s*content:\s*none\s*!important/);
});

test.after(async () => {
  if (labPromise) rmSync((await labPromise).root, { recursive: true, force: true });
});

// ── 1. Group titles stand out ───────────────────────────────────────────────

test("group titles are larger and heavier than the topic cards beneath them", () => {
  const title = cssRule(".lb-category-name,");
  const size = Number.parseFloat(declaration(title, "font-size"));
  const cardSize = Number.parseFloat(declaration(cssRule(".lb-feature-name"), "font-size"));
  assert.ok(size >= 18, `group title font-size ${size}px must be at least 18px`);
  assert.ok(size > cardSize + 3, "the group title is clearly larger than the card title");
  assert.ok(Number(declaration(title, "font-weight")) >= 700);
  assert.equal(declaration(title, "color"), "var(--text)", "title text uses the high-contrast text token");
  assert.match(indexHtml, /\.lb-category-name::before[\s\S]*?background:\s*var\(--accent\)/, "accent leading bar");
  assert.match(indexHtml, /legend\.lb-category-title\s*\{[^}]*border-bottom:\s*2px solid/, "clear divider");
  assert.match(indexHtml, /@media \(max-width: 480px\)\s*\{\s*\.lb-concept\s*\{[^}]*\}\s*\.lb-category-name[\s\S]*?font-size:\s*16px/, "narrow screens scale the title down");
});

test("group title colors meet contrast in both themes", () => {
  const themes = {
    dark: tokens(":root {"),
    light: tokens(':root[data-theme="light"]'),
  };
  for (const [name, t] of Object.entries(themes)) {
    for (const surface of [t["--surface"], t["--lb-concept-active-bg"]]) {
      assert.ok(contrast(t["--text"], surface) >= 4.5, `${name}: title text on ${surface}`);
      assert.ok(contrast(t["--accent"], surface) >= 3, `${name}: accent bar on ${surface}`);
    }
  }
});

function loadWizard(extra = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        innerHTML: "",
        textContent: "",
        hidden: false,
        disabled: false,
        style: {},
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {},
        setAttribute() {},
        removeAttribute() {},
        classList: {
          set: new Set(),
          toggle(name, on) {
            if (on) this.set.add(name);
            else this.set.delete(name);
          },
          add() {},
          remove() {},
        },
      });
    }
    return elements.get(id);
  };
  const context = {
    document: { getElementById: element, querySelector: () => null, querySelectorAll: () => [], activeElement: { dataset: {} } },
    CSS: { escape: (s) => s },
    escapeHtml: (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]),
    toast: () => {},
    setTimeout,
    console,
    ...extra,
  };
  vm.createContext(context);
  vm.runInContext(wizardSource, context);
  return { run: (code) => vm.runInContext(code, context), element, context };
}

test("every topic group renders its name as a heading inside the fieldset legend", () => {
  const { run, element } = loadWizard();
  const rec = recommend({ harness: "standard", level: 100 });
  run(`labBuilder.selectedProducts = new Set([LB_DEFAULT_PRODUCT]); labBuilder.levels = [{ level: 100, label: "Beginner" }]; labBuilder.harnesses = [{ id: "standard", name: "Standard harness" }]; labBuilder.level = 100; labBuilder.rec = ${JSON.stringify(rec)};`);
  run("lbRenderTopics()");
  const html = element("lb-topic-groups").innerHTML;
  const legends = [...html.matchAll(/<legend class="lb-category-title"><h4 class="lb-category-name">([^<]+)<\/h4>\s*<span class="lb-concept-count[^"]*">([^<]+)<\/span>\s*<\/legend>/g)];
  assert.ok(legends.length >= 3, "several groups render");
  for (const [, , count] of legends) assert.match(count, /^\d+ of \d+ selected/, "the selected-count pill stays");
  assert.equal([...html.matchAll(/<fieldset class="lb-concept">/g)].length, legends.length, "no group lost its heading");
});

// ── 2. One copy of each action ──────────────────────────────────────────────

function pane(id) {
  const start = indexHtml.indexOf(`id="lb-pane-${id}"`);
  const end = indexHtml.indexOf('<div class="panel lb-pane"', start + 1);
  return indexHtml.slice(start, end === -1 ? indexHtml.indexOf('id="lb-result-panel"', start) : end);
}

test("each wizard step has one footer, and no action appears twice inside it", () => {
  for (let step = 1; step <= 8; step += 1) {
    const html = pane(step);
    assert.equal([...html.matchAll(/data-lb-step-footer/g)].length, 1, `step ${step} has one footer`);
    const footer = html.slice(html.indexOf("data-lb-step-footer"));
    const handlers = [...footer.matchAll(/<button\b[^>]*onclick="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(handlers).size, handlers.length, `step ${step} footer repeats an action: ${handlers}`);
    assert.doesNotMatch(
      html.slice(0, html.indexOf("data-lb-step-footer")),
      /onclick="lb(NextStep|PrevStep|Generate)\(\)"/,
      `step ${step} has no Back, Next, or Generate button outside its footer`,
    );
  }
  assert.equal([...indexHtml.matchAll(/id="lb-generate-btn"/g)].length, 1, "Generate Lab exists once");
});

test("the step footer stays reachable and the sticky bar copy yields to it", () => {
  assert.match(cssRule("[data-lb-step-footer]"), /position:\s*sticky;[\s\S]*bottom:\s*0/);
  assert.match(indexHtml, /\.tab-content:has\(#panel-labbuilder\.active\)\s*\{\s*overflow:\s*visible/, "sticky is not defeated by a scroll container");
  assert.match(indexHtml, /\.lb-sticky-nav-covered \.lb-nav-back,\s*\.lb-sticky-nav-covered \.lb-nav-next\s*\{\s*display:\s*none/);
  assert.match(indexHtml, /\.lb-wizard-sticky\s*\{[^}]*position:\s*sticky;\s*top:\s*var\(--lb-header-h/, "the summary bar sits under the header");
  assert.match(indexHtml, /@media \(max-width: 720px\), \(max-height: 759px\)\s*\{\s*\.lb-wizard-sticky\s*\{\s*position:\s*static/, "and stays out of the way on small screens");
  assert.match(indexHtml, /id="lb-sticky-nav"/);
});

test("the sticky bar's Back and Next are covered exactly while the step footer is on screen", () => {
  const observed = [];
  let notify;
  class FakeObserver {
    constructor(callback) {
      notify = callback;
    }
    observe(target) {
      observed.push(target);
    }
    disconnect() {}
  }
  const footer = { tag: "footer" };
  const { run, element, context } = loadWizard({ IntersectionObserver: FakeObserver });
  context.document.getElementById = (id) => (id === "lb-pane-1" ? { querySelector: () => footer } : element(id));
  context.document.querySelector = () => ({ getBoundingClientRect: () => ({ bottom: 84 }) });
  run("labBuilder.step = 1; lbSyncNavControls();");
  assert.deepEqual(observed, [footer], "the active step's footer is observed");

  const group = element("lb-sticky-nav").classList;
  notify([{ isIntersecting: true }]);
  assert.equal(group.set.has("lb-sticky-nav-covered"), true, "footer on screen: only the footer copy shows");
  notify([{ isIntersecting: false }]);
  assert.equal(group.set.has("lb-sticky-nav-covered"), false, "footer off screen: the sticky copy takes over");
  run("lbSyncNavControls();");
  assert.equal(observed.length, 1, "an unchanged footer is not observed again");
});

test("without IntersectionObserver the sticky bar keeps its buttons", () => {
  const { run, element } = loadWizard();
  element("lb-sticky-nav").classList.set.add("lb-sticky-nav-covered");
  run("labBuilder.step = 1; lbSyncNavControls();");
  assert.equal(element("lb-sticky-nav").classList.set.has("lb-sticky-nav-covered"), false);
});

function loadGeneratedLabs() {
  const context = {
    labBuilder: { industries: [], levels: [], harnesses: [], products: [] },
    escapeHtml: (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]),
    lbFormatMinutes: (m) => `${m} min`,
    document: { getElementById: () => null },
  };
  vm.createContext(context);
  vm.runInContext(generatedLabsSource, context);
  return (code) => vm.runInContext(code, context);
}

test("a lab shown in the result panel is not offered a second time in the generated list", () => {
  const run = loadGeneratedLabs();
  const lab = `{ labId: "demo-lab", title: "Demo lab", generatedAt: "2026-01-01T00:00:00Z", totalMinutes: 60, moduleCount: 3, selections: {} }`;
  const actionsOf = (html) => [...html.matchAll(/data-gen-action="([^"]+)"/g)].map((m) => m[1]);

  const closedRow = actionsOf(run(`lbGen.opened = null; lbGenItemHtml(${lab})`));
  assert.deepEqual(
    ["open", "export-zip", "export-html", "download", "print", "validate"].filter((a) => !closedRow.includes(a)),
    [],
    "other labs keep every action",
  );

  const resultPanel = actionsOf(run('lbGeneratedActionButtonsHtml("demo-lab", "Demo lab")'));
  const openRow = actionsOf(run(`lbGen.opened = "demo-lab"; lbGenItemHtml(${lab})`));
  for (const action of resultPanel) {
    assert.ok(!openRow.includes(action), `"${action}" is already in the result panel`);
  }
  assert.ok(openRow.includes("close"), "the open lab's row can close the preview");
  for (const action of ["edit", "rename", "delete"]) assert.ok(openRow.includes(action), `${action} stays on the row`);
  assert.equal(new Set(openRow).size, openRow.length, "no action repeats within the row");
});
