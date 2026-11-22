import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync, inflateSync } from "node:zlib";

import { createProfile, activateProfile, buildCustomization, setProfileLogo, writeLabCustomization } from "../lib/branding-profiles.js";
import { loadBranding, prependBrandingBanner, renderBrandingBannerHtml } from "../lib/branding.js";
import { renderBrandInfoHtml } from "../lib/lab-builder/brand-theme.js";
import {
  HTML_BLOCK_BEGIN,
  HTML_BLOCK_END,
  compactHtml,
  embedHtmlBlock,
  normalizeEmbeddedHtml,
  stripEmbeddedHtml,
} from "../lib/lab-builder/html-fragments.js";
import { condense } from "../lib/lab-builder/composer.js";
import { renderLabMarkdown } from "../lib/markdown.js";
import { renderStandaloneLabHtml } from "../lib/lab-builder/html-lab.js";
import { tidyMetaTable } from "../lib/lab-builder/meta-table.js";
import { renderMarkdownToDocxBuffer } from "../lib/lab-builder/docx-builder.js";
import { renderMarkdownToPdfBuffer } from "../lib/lab-builder/pdf-builder.js";
import { renderMarkdownToPptxBuffer } from "../lib/lab-builder/pptx-builder.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import { readGeneratedLab, readGeneratedLabTopicDocument } from "../lib/lab-builder/generated-labs.js";
import { splitGeneratedLabModules } from "../lib/lab-builder/module-samples.js";
import {
  exportGeneratedLab,
  isCustomBranding,
  renderGeneratedLabDocx,
  renderGeneratedLabFacilitatorDocx,
  renderGeneratedLabFacilitatorHtml,
  renderGeneratedLabFacilitatorMarkdown,
  renderGeneratedLabFacilitatorPdf,
  renderGeneratedLabHtml,
  renderGeneratedLabMarkdown,
  renderGeneratedLabPdf,
  renderGeneratedLabPptx,
} from "../lib/exporter.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** The banner exactly as main emitted it before the fix: indented, with a whitespace-only line when there is no logo. */
const LEGACY_BROKEN_BANNER = [
  '<div class="lab-branding-banner" style="margin: 0 0 24px; border: 1px solid #4f8ff7; border-radius: 14px; padding: 18px 20px; background: rgba(79, 143, 247, 0.08);">',
  '  <div style="display: flex; align-items: center; gap: 16px; flex-wrap: wrap;">',
  "    ",
  "    <div>",
  '      <div class="lab-branding-title" style="font-size: 28px; font-weight: 700; color: #4f8ff7;">Agentic Microsoft Training and Lab Generator</div>',
  '      <div class="lab-branding-tagline" style="font-size: 14px;">Provisioning Portal</div>',
  "    </div>",
  "  </div>",
  "</div>",
].join("\n");

const LONG_WORD = "Longword".repeat(10);

const BRANDS = {
  default: { companyName: "Agentic Microsoft Training and Lab Generator", tagline: "Provisioning Portal", logo: null, primaryColor: "#4f8ff7" },
  "custom without logo": { companyName: "Contoso Ltd", tagline: "AI Academy", logo: null, primaryColor: "#0b3d91" },
  "custom with logo": { companyName: "Contoso Ltd", tagline: "AI Academy", logo: "/uploads/logo-1.png", primaryColor: "#0b3d91" },
  "all optional fields": {
    companyName: "Contoso Ltd",
    tagline: "AI Academy",
    logo: "/uploads/logo-1.png",
    primaryColor: "#0b3d91",
    secondaryColor: "#c2410c",
    font: "georgia",
    coverSubtitle: "Spring cohort",
    footerText: "Contoso Internal Training",
    moreInfoLabel: "Contoso AI portal",
    moreInfoUrl: "https://learn.contoso.com/ai",
    supportName: "Ada Lovelace",
    supportEmail: "ai-help@contoso.com",
    communityUrl: "https://teams.microsoft.com/l/team/contoso-ai",
  },
  "special characters and long values": {
    companyName: `A & B "Quotes" 'x' <Co> ${LONG_WORD}`.slice(0, 80),
    tagline: `Tag & "line" <b>bold</b> ${LONG_WORD}`.slice(0, 120),
    coverSubtitle: `Sub & <i>x</i> ${LONG_WORD}`.slice(0, 160),
    footerText: `Footer & "text" ${LONG_WORD}`.slice(0, 200),
    primaryColor: "#000000",
    secondaryColor: "#ffffff",
  },
  "light accent": { companyName: "Fabrikam", tagline: "Light accent", logo: null, primaryColor: "#ffffff" },
  "dark accent": { companyName: "Fabrikam", tagline: "Dark accent", logo: "/uploads/logo-1.png", primaryColor: "#000000" },
};

const SAMPLE_MD = "# Sample Lab\n\n**Bold** intro with `code`.\n\n## Overview\n\n- [ ] First task\n- [x] Done task\n\n## Step 1\n\nDo the thing.\n";

// ── Helpers ─────────────────────────────────────────────────────────────────

function readZipFiles(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.notEqual(eocd, -1, "expected a ZIP end-of-central-directory record");
  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < total; i += 1) {
    const method = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + compSize);
    files.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/** Every XML part of a DOCX or PPTX, which is where its text lives. */
function officeXml(buffer) {
  return [...readZipFiles(buffer).entries()]
    .filter(([name]) => name.endsWith(".xml"))
    .map(([, data]) => data.toString("utf8"))
    .join("\n");
}

function pdfText(buffer) {
  const parts = [];
  for (const match of buffer.toString("latin1").matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      parts.push(inflateSync(Buffer.from(match[1], "latin1")).toString("latin1"));
    } catch {
      // Binary image streams are not text.
    }
  }
  return parts.join("\n");
}

function collectStream(fn) {
  return new Promise((resolve, reject) => {
    const out = new PassThrough();
    const chunks = [];
    out.on("data", (chunk) => chunks.push(chunk));
    out.on("end", () => resolve(Buffer.concat(chunks)));
    out.on("error", reject);
    Promise.resolve(fn(out)).catch(reject);
  });
}

/** Text that means banner markup reached a reader as words instead of a styled element. */
const BANNER_TEXT_LEAK = /lab-branding|lab-html:|&lt;\/?div|<div[\s>]/i;
const CODE_BLOCK_LEAK = /<pre\b|<code\b|&lt;\/?div/i;

/** Lines inside an HTML fragment that Markdown would split on or turn into code. */
function htmlBlockProblems(fragment) {
  const problems = [];
  String(fragment)
    .split("\n")
    .forEach((line, index) => {
      if (!line.trim()) problems.push(`line ${index} is blank or whitespace only`);
      else if (/^( {4,}|\t)/.test(line)) problems.push(`line ${index} is indented four or more spaces`);
    });
  return problems;
}

function bannerRegion(html) {
  const end = html.search(/<h1\b/);
  return end < 0 ? html : html.slice(0, end);
}

function visibleText(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ");
}

// ── Fragment hygiene ────────────────────────────────────────────────────────

test("every HTML fragment builder emits blank-free, left-aligned lines for every brand shape", () => {
  for (const [name, brand] of Object.entries(BRANDS)) {
    for (const logoPath of [brand.logo, null, "../_branding/logo.png"]) {
      const banner = renderBrandingBannerHtml(brand, logoPath);
      assert.deepEqual(htmlBlockProblems(banner), [], `banner for "${name}" (logo ${logoPath})`);
      assert.deepEqual(htmlBlockProblems(embedHtmlBlock(banner)), [], `embedded banner for "${name}"`);
    }
    // The info blocks are single-line HTML; the property still has to hold.
    const info = renderBrandInfoHtml(brand);
    if (info) assert.deepEqual(htmlBlockProblems(info), [], `brand info for "${name}"`);
  }

  assert.equal(compactHtml("  <div>\n\n    \n      <p>x</p>\r\n\t\n  </div>  "), "<div>\n<p>x</p>\n</div>");
  assert.equal(embedHtmlBlock(" \n \n"), "", "an empty fragment disappears instead of leaving markers");
});

test("an empty logo, tagline, or subtitle slot leaves no blank line and no empty element", () => {
  const banner = renderBrandingBannerHtml({ companyName: "Solo Co", tagline: "", primaryColor: "#0f6cbd" }, null);
  assert.deepEqual(htmlBlockProblems(banner), []);
  assert.doesNotMatch(banner, /<img|lab-branding-subtitle/);
  assert.match(banner, /class="lab-branding-title"[^>]*>Solo Co<\/div>/);
});

// ── The reported bug: banner HTML shown as a code block ─────────────────────

for (const [name, brand] of Object.entries(BRANDS)) {
  test(`the "${name}" banner renders as a styled banner, never as code, in the viewer and the standalone page`, () => {
    const markdown = prependBrandingBanner(SAMPLE_MD, brand);
    assert.deepEqual(htmlBlockProblems(markdown.slice(0, markdown.indexOf("# Sample Lab")).replace(/\n\n$/, "")), [], "the embedded banner has no blank or indented lines");

    const viewer = renderLabMarkdown(markdown);
    const region = bannerRegion(viewer);
    assert.doesNotMatch(region, CODE_BLOCK_LEAK, "no <pre>, <code>, or escaped <div> in the banner region");
    assert.match(region, /^<div class="lab-branding-banner"/);
    assert.match(region, /<div class="lab-branding-title"[^>]*>[^<]+<\/div>/, "the title is a real element");
    assert.match(region, /<div class="lab-branding-tagline"[^>]*>[^<]+<\/div>/, "the tagline is a real element");
    assert.doesNotMatch(viewer, /lab-html:/, "markers never reach the page");

    const titleText = visibleText(region);
    assert.ok(titleText.includes(visibleText(brand.companyName).trim()) || brand.companyName.length > 40, "the company name is readable text");
    if (brand.logo) assert.match(region, /<img src="\/uploads\/logo-1\.png"/);
    else assert.doesNotMatch(region, /<img/);
    assert.doesNotMatch(viewer, /<script|\sonerror=|\sonclick=|<b>bold|<i>x/i);

    // Markdown after the banner still works.
    assert.match(viewer, /<h1[^>]*>Sample Lab<\/h1>/);
    assert.match(viewer, /<strong>Bold<\/strong>/);
    assert.match(viewer, /<h2[^>]*>Step 1<\/h2>/);
    assert.match(viewer, /task-list-item-checkbox/);

    const page = renderStandaloneLabHtml(markdown, { title: "Sample Lab", renderMarkdown: renderLabMarkdown });
    assert.doesNotMatch(page, /&lt;div|lab-html:|<pre><code>&lt;/);
    assert.match(page, /<section class="lab-page active"[^>]*>\s*<div class="lab-branding-banner"/);

    // The zero-dependency fallback has no sanitizer, so it drops the fragment instead of printing it.
    const fallback = renderStandaloneLabHtml(markdown, { title: "Sample Lab" });
    assert.doesNotMatch(fallback, /&lt;div|lab-html:|<div class="lab-branding-banner"/);
    assert.match(fallback, /<h1[^>]*>Sample Lab<\/h1>/);
  });
}

test("a stored banner written by the old code (blank line, indentation) renders correctly after the fix", () => {
  const stored = `${LEGACY_BROKEN_BANNER}\n\n${SAMPLE_MD}`;
  const html = renderLabMarkdown(stored);
  assert.doesNotMatch(bannerRegion(html), CODE_BLOCK_LEAK);
  assert.match(html, /<div class="lab-branding-title"[^>]*>Agentic Microsoft Training and Lab Generator<\/div>/);
  assert.match(html, /<h1[^>]*>Sample Lab<\/h1>/);
  assert.equal(stripEmbeddedHtml(stored).trim(), SAMPLE_MD.trim());
});

// ── Safety properties stay intact ───────────────────────────────────────────

test("markers only fix whitespace: the sanitizer still removes scripts, handlers, and unsafe URLs", () => {
  const hostile = embedHtmlBlock(
    [
      '<div class="lab-branding-banner" onclick="alert(1)" style="background: url(javascript:alert(1)); color: #123456">',
      "",
      '    <script>alert("x")</script>',
      '    <a href="javascript:alert(2)">link</a><img src="x" onerror="alert(3)" />',
      '    <iframe src="https://evil.example"></iframe>',
      "</div>",
    ].join("\n"),
  );
  const html = renderLabMarkdown(`${hostile}\n\n# Title\n`);
  assert.doesNotMatch(html, /<script|alert\(|onclick|onerror|javascript:|<iframe|url\(/i);
  assert.match(html, /<div class="lab-branding-banner"/);
  assert.match(html, /<h1[^>]*>Title<\/h1>/);

  // Unmarked raw HTML in Markdown keeps going through the same sanitizer.
  const plain = renderLabMarkdown('<div onclick="alert(1)">hi</div>\n\n[x](javascript:alert(1))\n');
  assert.doesNotMatch(plain, /onclick|javascript:/i);
});

test("a marker block tolerates blank lines and indentation, and markers inside code fences are left alone", () => {
  const messy = `${HTML_BLOCK_BEGIN}\n<div class="lab-branding-banner">\n\n      <div class="lab-branding-title">Messy</div>\n\n    <div class="lab-branding-tagline">Block</div>\n</div>\n${HTML_BLOCK_END}\n\n# After\n`;
  const html = renderLabMarkdown(messy);
  assert.doesNotMatch(html, CODE_BLOCK_LEAK);
  assert.match(html, /<div class="lab-branding-title">Messy<\/div>/);
  assert.match(html, /<h1[^>]*>After<\/h1>/);

  const fenced = `~~~\n${HTML_BLOCK_BEGIN}\n<div>kept</div>\n${HTML_BLOCK_END}\n~~~\n`;
  assert.equal(normalizeEmbeddedHtml(fenced), fenced);
  assert.match(renderLabMarkdown(fenced), /<pre><code>[\s\S]*lab-html:begin/);

  // An unterminated marker degrades to plain Markdown instead of swallowing the page.
  assert.match(renderLabMarkdown(`${HTML_BLOCK_BEGIN}\n# Heading\n`), /<h1[^>]*>Heading<\/h1>/);
});

test("placeholders such as <site-name> stay visible while real HTML and unsafe tags behave as before", () => {
  const html = renderLabMarkdown("Paste the site path (.../sites/<site-name>/...) here.\n\nLine<br>break and <script>alert(1)</script>done.\n");
  assert.match(html, /\.\.\.\/sites\/&lt;site-name&gt;\/\.\.\./);
  assert.match(html, /Line<br \/>break|Line<br>break/);
  assert.doesNotMatch(html, /<script|alert\(1\)/);
});

test("the lab details table is shown without its header, its keyword row, and a difficulty that repeats the level", () => {
  const md = [
    "# A lab",
    "",
    "| Field | Details |",
    "|---|---|",
    "| ⭐ **DIFFICULTY** | Beginner |",
    "| 🎚️ **LEVEL** | Level 100 (Beginner) |",
    "| ⏱️ **TIME** | About 1 hour |",
    "| 🏷️ **TAGS** | foundations, knowledge |",
    "| 🏭 **INDUSTRIES** | Retail |",
    "",
    "## Overview",
    "",
    "Text.",
    "",
    "| Step | Module |",
    "|---|---|",
    "| Step 1 | Create an agent |",
  ].join("\n");
  for (const html of [renderStandaloneLabHtml(md, { title: "A lab", renderMarkdown: renderLabMarkdown }), renderStandaloneLabHtml(md, { title: "A lab" })]) {
    assert.ok(html.includes('<table class="lab-meta">'));
    assert.ok(!/<th>Field<\/th>/.test(html), "no Field | Details header");
    assert.ok(!html.includes("TAGS") && !html.includes("foundations, knowledge"), "keywords are not shown");
    assert.ok(!html.includes("DIFFICULTY"), "difficulty repeated the level");
    for (const kept of ["LEVEL", "TIME", "INDUSTRIES", "Level 100 (Beginner)", "Retail"]) assert.ok(html.includes(kept), kept);
    assert.match(html, /<th scope="row">[^<]*<strong>LEVEL<\/strong><\/th>/);
    assert.ok(html.includes("<th>Step</th>"), "other tables keep their headers");
  }
  const handWritten = tidyMetaTable('<table><thead><tr><th>Field</th><th>Details</th></tr></thead><tbody><tr><td>⭐ <strong>DIFFICULTY</strong></td><td>Beginner</td></tr></tbody></table>');
  assert.ok(handWritten.includes("DIFFICULTY"), "without a LEVEL row the difficulty stays");
  const untouched = "<table><thead><tr><th>Step</th><th>Module</th></tr></thead><tbody><tr><td>1</td><td>A</td></tr></tbody></table>";
  assert.equal(tidyMetaTable(untouched), untouched);
});

test("the Learn pull quote drops callout labels and the space a removed link leaves before a comma", () => {
  const quote = condense("Note This article applies to classic chatbots only. Important This article includes information about Azure Bot Service skills , a code-based way to extend an agent. Note that lowercase prose stays.");
  assert.ok(!/(?:^|\.\s)(?:Note|Important)\s+This/.test(quote), quote);
  assert.match(quote, /^This article applies to classic chatbots only\./);
  assert.match(quote, /skills, a code-based way/);
  assert.match(quote, /Note that lowercase prose stays/);
});

test("the Learn pull quote drops table markup instead of leaving a stray '<br'", () => {
  const quote = condense("Output: The list of purchased items <br>- Name : Name of the purchased item<br />- Price : Price <p>Done</p> with <your-env-url> kept");
  assert.doesNotMatch(quote, /<br|<p|<\/p/);
  assert.match(quote, /Name : Name of the purchased item/);
  assert.match(quote, /<your-env-url/);
});

// ── Document formats never print banner markup ──────────────────────────────

for (const [name, brand] of [["default", BRANDS.default], ["custom without logo", BRANDS["custom without logo"]], ["all optional fields", BRANDS["all optional fields"]]]) {
  test(`DOCX, PDF, and PPTX never print the "${name}" banner markup`, () => {
    const markdown = `${prependBrandingBanner(SAMPLE_MD, brand)}`;
    const legacy = `${LEGACY_BROKEN_BANNER}\n\n${SAMPLE_MD}`;
    for (const source of [markdown, legacy]) {
      const docx = officeXml(renderMarkdownToDocxBuffer(source, { title: "Sample Lab" }));
      assert.doesNotMatch(docx, BANNER_TEXT_LEAK);
      assert.match(docx, /Do the thing/);
      const pdf = pdfText(renderMarkdownToPdfBuffer(source, { title: "Sample Lab" }));
      assert.doesNotMatch(pdf, BANNER_TEXT_LEAK);
      assert.match(pdf, /\(thing\.\) Tj/, "the PDF draws each word as its own text run");
      const pptx = officeXml(renderMarkdownToPptxBuffer(source, { title: "Sample Lab" }));
      assert.doesNotMatch(pptx, BANNER_TEXT_LEAK);
      assert.match(pptx, /Sample Lab/);
    }
  });
}

// ── A real generated lab, every output path ─────────────────────────────────

let labRoot;
let builtLab;

before(async () => {
  labRoot = mkdtempSync(join(tmpdir(), "html-fragments-lab-"));
  builtLab = await generateLab(
    {
      product: "copilot-studio",
      features: ["create-agent"],
      level: 100,
      harness: "standard",
      industry: "healthcare",
      title: "Banner Safety Lab",
      agentName: "Clinical Intake Assistant",
    },
    { outputRoot: labRoot, useLearnMcp: false, useLlm: false },
  );
});

after(() => {
  if (labRoot) rmSync(labRoot, { recursive: true, force: true });
});

function useProfileEnv(t) {
  const root = mkdtempSync(join(tmpdir(), "html-fragments-env-"));
  const env = { PORTAL_DATA_DIR: join(root, "data"), PORTAL_UPLOADS_DIR: join(root, "uploads"), LAB_BUILDER_OUTPUT_DIR: join(root, "labs") };
  mkdirSync(env.PORTAL_UPLOADS_DIR, { recursive: true });
  writeFileSync(join(env.PORTAL_UPLOADS_DIR, "logo-1.png"), ONE_PIXEL_PNG);
  const saved = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    process.env[key] = env[key];
  }
  const manifestPath = join(builtLab.outputDir, "manifest.json");
  const originalManifest = readFileSync(manifestPath, "utf8");
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    writeFileSync(manifestPath, originalManifest);
    rmSync(root, { recursive: true, force: true });
  });
  return env;
}

function customize(env, profile, { logo = false } = {}) {
  const created = createProfile(profile, env);
  if (logo) setProfileLogo(created.id, "logo-1.png", env);
  activateProfile(created.id, env);
  writeLabCustomization(builtLab.outputDir, buildCustomization({ profileId: created.id }, env));
}

const LAB_VARIANTS = [
  ["default branding", null, false],
  ["custom brand without a logo", { name: "No Logo", companyName: "Contoso Ltd" }, false],
  ["custom brand with a logo", { name: "With Logo", companyName: "Contoso Ltd", tagline: "AI Academy", coverSubtitle: "Spring cohort" }, true],
  [
    "custom brand with every optional field",
    {
      name: "Everything",
      companyName: 'Contoso & "Sons" Ltd',
      tagline: "AI Academy",
      primaryColor: "#0b3d91",
      secondaryColor: "#c2410c",
      font: "georgia",
      coverSubtitle: "Spring cohort",
      footerText: "Contoso Internal Training",
      moreInfoLabel: "Contoso AI portal",
      moreInfoUrl: "https://learn.contoso.com/ai",
      supportName: "Ada Lovelace",
      supportEmail: "ai-help@contoso.com",
      communityUrl: "https://teams.microsoft.com/l/team/contoso-ai",
    },
    true,
  ],
  [
    "custom brand with special characters and long values",
    {
      name: "Long",
      companyName: `Fabrikam & <Co> ${LONG_WORD}`.slice(0, 80),
      tagline: `Tag "line" ${LONG_WORD}`.slice(0, 120),
      coverSubtitle: `Subtitle ${LONG_WORD}`.slice(0, 160),
      footerText: `Footer ${LONG_WORD}`.slice(0, 200),
      primaryColor: "#ffffff",
    },
    false,
  ],
];

for (const [name, profile, logo] of LAB_VARIANTS) {
  test(`${name}: every viewer, download, export, and bundle path is free of banner markup`, async (t) => {
    const env = useProfileEnv(t);
    if (profile) customize(env, profile, { logo });
    const id = builtLab.labId;
    const brand = loadBranding(env);

    // Paged viewer and Step 8 preview: the server prepends the banner to the lab Markdown at request time.
    const viewer = readGeneratedLab(labRoot, id, (markdown) =>
      renderLabMarkdown(isCustomBranding(brand) ? prependBrandingBanner(markdown, brand) : markdown),
    );
    assert.equal(viewer.status, 200);
    assert.doesNotMatch(viewer.body.html.slice(0, 2000), CODE_BLOCK_LEAK);
    if (profile) assert.match(viewer.body.html, /<div class="lab-branding-title"/);
    // The Preview tab lab picker always shows the banner.
    assert.doesNotMatch(bannerRegion(renderLabMarkdown(prependBrandingBanner(SAMPLE_MD, brand))), CODE_BLOCK_LEAK);

    // Markdown download, read the way GitHub or an editor preview would.
    const download = renderGeneratedLabMarkdown(labRoot, id).markdown;
    assert.doesNotMatch(bannerRegion(renderLabMarkdown(download)), CODE_BLOCK_LEAK);
    assert.doesNotMatch(download.split("\n").slice(0, 14).join("\n"), /^ {4,}\S/m, "no indented banner lines in index.md");

    const html = renderGeneratedLabHtml(labRoot, id).html;
    assert.doesNotMatch(html, /&lt;div|lab-html:|<pre><code>&lt;/);

    assert.doesNotMatch(officeXml(renderGeneratedLabDocx(labRoot, id).buffer), BANNER_TEXT_LEAK);
    assert.doesNotMatch(pdfText(renderGeneratedLabPdf(labRoot, id).buffer), BANNER_TEXT_LEAK);
    assert.doesNotMatch(officeXml(renderGeneratedLabPptx(labRoot, id).buffer), BANNER_TEXT_LEAK);

    const facilitatorMd = renderGeneratedLabFacilitatorMarkdown(labRoot, id).markdown;
    assert.doesNotMatch(bannerRegion(renderLabMarkdown(facilitatorMd)), CODE_BLOCK_LEAK);
    assert.doesNotMatch(renderGeneratedLabFacilitatorHtml(labRoot, id).html, /&lt;div|lab-html:/);
    assert.doesNotMatch(officeXml(renderGeneratedLabFacilitatorDocx(labRoot, id).buffer), BANNER_TEXT_LEAK);
    assert.doesNotMatch(pdfText(renderGeneratedLabFacilitatorPdf(labRoot, id).buffer), BANNER_TEXT_LEAK);

    for (const format of ["docx", "pptx"]) {
      const doc = readGeneratedLabTopicDocument(labRoot, id, 1, format, profile ? { branding: brand, customBranding: isCustomBranding(brand) } : {});
      assert.equal(doc.status, 200);
      assert.doesNotMatch(officeXml(doc.buffer), BANNER_TEXT_LEAK);
    }

    const zip = readZipFiles(
      await collectStream((out) => exportGeneratedLab(labRoot, id, {}, out, { formats: ["docx", "pdf", "html", "pptx"] })),
    );
    assert.ok(zip.size > 10);
    for (const [fileName, data] of zip) {
      if (/\.md$/i.test(fileName)) {
        const text = data.toString("utf8");
        assert.doesNotMatch(bannerRegion(renderLabMarkdown(text)), CODE_BLOCK_LEAK, fileName);
        assert.doesNotMatch(text.split("\n").slice(0, 14).join("\n"), /^ {4,}\S/m, `${fileName} has an indented banner line`);
      } else if (/\.html$/i.test(fileName)) {
        assert.doesNotMatch(data.toString("utf8"), /&lt;div|lab-html:|<pre><code>&lt;/, fileName);
      } else if (/\.(docx|pptx)$/i.test(fileName)) {
        assert.doesNotMatch(officeXml(data), BANNER_TEXT_LEAK, fileName);
      } else if (/\.pdf$/i.test(fileName)) {
        assert.doesNotMatch(pdfText(data), BANNER_TEXT_LEAK, fileName);
      }
    }
  });
}

test("a generated lab's own Markdown never turns embedded HTML into a code block", () => {
  const markdown = readFileSync(join(builtLab.outputDir, "index.md"), "utf8");
  for (const line of markdown.split("\n")) {
    if (/^\s*<\/?(?:details|summary|div|figure|section)\b/i.test(line)) assert.doesNotMatch(line, /^ {4,}/, `indented HTML line: ${line}`);
  }
  const html = renderLabMarkdown(markdown);
  assert.doesNotMatch(html, /<pre><code>(?!\s*$)[^]*?&lt;(?:div|details|summary|figure)\b/);
  assert.doesNotMatch(html, /&lt;\/?(?:details|summary|div|figure)\b/);
});

// ── Labs built before the fix ───────────────────────────────────────────────

test("a lab whose stored index.md carries the old broken banner renders and exports cleanly without a rebuild", (t) => {
  const env = useProfileEnv(t);
  void env;
  const indexPath = join(builtLab.outputDir, "index.md");
  const original = readFileSync(indexPath, "utf8");
  t.after(() => writeFileSync(indexPath, original));
  writeFileSync(indexPath, `${LEGACY_BROKEN_BANNER}\n\n${original}`);

  const viewer = readGeneratedLab(labRoot, builtLab.labId, renderLabMarkdown);
  assert.equal(viewer.status, 200);
  assert.doesNotMatch(viewer.body.html.slice(0, 2000), CODE_BLOCK_LEAK);
  assert.match(viewer.body.html, /<div class="lab-branding-title"[^>]*>Agentic Microsoft Training and Lab Generator<\/div>/);
  assert.doesNotMatch(viewer.body.html, /<pre><code>&lt;/);

  const split = splitGeneratedLabModules(`${LEGACY_BROKEN_BANNER}\n\n${original}`, {}, { labId: builtLab.labId });
  assert.doesNotMatch(split.overview.markdown, /lab-branding/);
  assert.ok(split.modules.length > 0);

  assert.doesNotMatch(officeXml(renderGeneratedLabDocx(labRoot, builtLab.labId).buffer), BANNER_TEXT_LEAK);
  assert.doesNotMatch(renderGeneratedLabHtml(labRoot, builtLab.labId).html, /&lt;div|<pre><code>&lt;/);
});
