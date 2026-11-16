import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderStandaloneLabHtml } from "../lib/lab-builder/html-lab.js";
import { prependBrandingBanner } from "../lib/branding.js";
import { renderLabMarkdown } from "../lib/markdown.js";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("visible form controls have an accessible name", () => {
  const explicitLabels = new Set(
    [...html.matchAll(/<label\b[^>]*\bfor=["']([^"']+)["']/gi)].map((match) => match[1]),
  );
  const missing = [];

  for (const match of html.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
    const attributes = match[2];
    const id = attributes.match(/\bid=["']([^"']+)["']/i)?.[1];
    if (!id || /\btype=["']hidden["']/i.test(attributes)) continue;
    if (/\baria-label(?:ledby)?=/i.test(attributes) || explicitLabels.has(id)) continue;

    const precedingHtml = html.slice(0, match.index);
    const isWrappedByLabel =
      precedingHtml.lastIndexOf("<label") > precedingHtml.lastIndexOf("</label>");
    if (!isWrappedByLabel) missing.push(id);
  }

  assert.deepEqual(missing, []);
});

test("tabs and tab panels reference each other", () => {
  const tabs = [...html.matchAll(/<button\b[^>]*\bid=["']([^"']+)["'][^>]*\brole=["']tab["'][^>]*>/gi)];
  assert.ok(tabs.length > 0);

  for (const [, tabId] of tabs) {
    const tab = tabs.find((match) => match[1] === tabId)[0];
    const panelId = tab.match(/\baria-controls=["']([^"']+)["']/i)?.[1];
    assert.ok(panelId, `${tabId} must identify its tab panel`);
    assert.match(
      html,
      new RegExp(
        `<[^>]+id=["']${panelId}["'][^>]+role=["']tabpanel["'][^>]+aria-labelledby=["']${tabId}["']`,
        "i",
      ),
    );
  }
});

test("keyboard users can skip navigation and see focus", () => {
  assert.match(html, /<a\b[^>]*class=["']skip-link["'][^>]*href=["']#portal-main["']/i);
  assert.match(html, /<main\b[^>]*id=["']portal-main["'][^>]*tabindex=["']-1["']/i);
  assert.match(html, /:focus-visible\s*\{/);
});

test("small screens keep portal tabs reachable", () => {
  assert.match(html, /@media \(max-width: 900px\)[\s\S]*?\.tabs\s*\{[\s\S]*?overflow-x:\s*auto/);
  assert.match(html, /@media \(max-width: 560px\)/);
});

test("initialization defers hidden-tab API requests", () => {
  const initBody = appSource.match(
    /document\.addEventListener\("DOMContentLoaded", \(\) => \{(?<body>[\s\S]*?)\n\}\);/,
  )?.groups?.body;

  assert.ok(initBody, "DOMContentLoaded initialization must exist");
  for (const hiddenTabLoader of [
    "loadScenarios",
    "loadConfig",
    "loadResourceManifest",
    "ppLoadApprovalConfig",
    "ppLoadApprovalRequests",
    "loadAgentChatConfig",
  ]) {
    assert.doesNotMatch(initBody, new RegExp(`\\b${hiddenTabLoader}\\(`));
  }
});

test("Mermaid is lazy-loaded only for previews that need it", () => {
  assert.doesNotMatch(html, /<script[^>]+src=["']vendor\/mermaid\.min\.js["']/i);
  assert.match(appSource, /function loadMermaid\(\)/);
  assert.match(appSource, /const mermaid = await loadMermaid\(\)/);
});

test("a paused lab build announces itself and is answerable by keyboard", () => {
  // The container is static; the controls are built in app.js, so the
  // accessible-name scan above stays clean only if it holds no inputs.
  const container = html.match(/<div\b[^>]*\bid=["']lb-decisions["'][^>]*>[\s\S]*?<\/div>/i)?.[0];
  assert.ok(container, "the decision container must exist in the wizard");
  assert.doesNotMatch(container, /<input\b/i);

  const render = appSource.match(
    /function lbRenderDecisions\(blockers\) \{(?<body>[\s\S]*?)\n\}/,
  )?.groups?.body;
  assert.ok(render, "lbRenderDecisions function must exist");

  // Announced to a screen reader when the build stops.
  assert.match(render, /setAttribute\("role", "alert"\)/);
  // Grouped, so the blocker title is read with each option.
  assert.match(render, /createElement\("fieldset"\)/);
  assert.match(render, /createElement\("legend"\)/);
  // Native radios give arrow-key navigation and "n of m" for free.
  assert.match(render, /input\.type = "radio"/);
  assert.match(render, /label\.htmlFor = inputId/);
  // The tradeoff is read out with the option it belongs to.
  assert.match(render, /setAttribute\("aria-describedby", tradeoffId\)/);
  // "recommended" is in the accessible name, not conveyed by colour alone.
  assert.match(render, /\(recommended\)/);
  // Keyboard focus lands on the decision instead of staying where it was.
  assert.match(render, /firstLegend\?\.focus\(\)/);
});

test("themes: light and dark tokens exist, honor the OS setting, and have a persisted toggle", () => {
  const themeSource = readFileSync(new URL("../public/theme.js", import.meta.url), "utf8");
  assert.match(html, /<script src="theme\.js"><\/script>/);
  assert.match(html, /:root\[data-theme="light"\]/);
  assert.match(html, /@media \(prefers-color-scheme: light\)/);
  assert.match(html, /id="theme-toggle"[^>]*aria-label=/);
  assert.match(themeSource, /localStorage\.setItem/);
  assert.doesNotMatch(html, /backdrop-filter:\s*blur/);
});

// ── Generated labs management and the removed left pane ─────────────────────
const generatedSource = readFileSync(new URL("../public/generated-labs.js", import.meta.url), "utf8");
const wizardSource = readFileSync(new URL("../public/lab-builder-wizard.js", import.meta.url), "utf8");

test("the legacy left navigation pane is gone and the wizard Level step is the only level picker", () => {
  assert.doesNotMatch(html, /class=["']sidebar["']/);
  assert.doesNotMatch(html, /\.sidebar\b/);
  assert.doesNotMatch(html, /sidebar-header|sidebar-actions/);
  assert.doesNotMatch(html, /from the sidebar|in the sidebar/i);
  assert.doesNotMatch(appSource, /sidebar/i);
  assert.equal([...html.matchAll(/id=["']lb-pane-4["']/g)].length, 1);
  assert.equal([...html.matchAll(/id=["']lb-level-options["']/g)].length, 1);
  assert.match(html, /Step 4 of 8: What level should the lab be\?/);
  assert.match(appSource, /const DEFAULT_TAB = "labbuilder"/);
});

test("the chapter picker moved into the Lab setup panel with named controls", () => {
  const provision = html.match(/<div class="tab-panel" id="panel-provision"[\s\S]*?<div class="panel">/)?.[0] || "";
  assert.match(provision, /id=["']lab-list["']/);
  assert.equal([...html.matchAll(/id=["']lab-list["']/g)].length, 1);
  assert.match(provision, /aria-labelledby=["']chapters-heading["']/);
  assert.match(provision, /Include all labs/);
  assert.match(provision, /id=["']chapter-summary["'][^>]*aria-live=["']polite["']/);
  assert.match(appSource, /aria-pressed="\$\{included\}"/);
  assert.match(appSource, /aria-label="Preview Lab/);
  assert.match(html, /<label for=["']preview-lab-select["']>/);
});

test("the generated-labs list is searchable, sortable, and announces results", () => {
  const panel = html.match(/aria-labelledby=["']lb-generated-heading["'][\s\S]*?<\/section>/)?.[0] || "";
  assert.ok(panel, "the generated labs section must be labelled by its heading");
  assert.match(panel, /<label for=["']lb-gen-search["']>/);
  assert.match(panel, /<label for=["']lb-gen-sort["']>/);
  assert.match(panel, /id=["']lb-gen-count["'][^>]*role=["']status["'][^>]*aria-live=["']polite["']/);
  assert.match(panel, /<h3 id=["']lb-generated-heading["'] tabindex=["']-1["']/);
});

test("delete asks for confirmation in a named alert dialog and rename in a labelled dialog", () => {
  const del = html.match(/<dialog id=["']lb-gen-delete-dialog["'][^>]*>/)?.[0] || "";
  assert.match(del, /role=["']alertdialog["']/);
  assert.match(del, /aria-labelledby=["']lb-gen-delete-title["']/);
  assert.match(del, /aria-describedby=["']lb-gen-delete-desc["']/);
  const rename = html.match(/<dialog id=["']lb-gen-rename-dialog["'][^>]*>/)?.[0] || "";
  assert.match(rename, /aria-labelledby=["']lb-gen-rename-heading["']/);
  assert.match(html, /id=["']lb-gen-rename-error["'] class=["']lb-error["'] role=["']alert["']/);
  // Safe default focus, and focus is not left on a removed row.
  assert.match(generatedSource, /showModal\(\);\s*document\.getElementById\("lb-gen-delete-cancel"\)\.focus\(\)/);
  assert.match(generatedSource, /lbGenFocusAfterRemoval/);
  assert.match(generatedSource, /lb-generated-heading/);
});

test("each row action is a real button with a name that includes the lab", () => {
  for (const action of ["open", "edit", "rename", "delete"]) {
    assert.match(generatedSource, new RegExp(`<button type="button" class="btn btn-sm" data-gen-action="${action}" aria-label="[^"]*\\$\\{title\\}"`));
  }
  assert.doesNotMatch(generatedSource, /\bon(click|change|input)=/);
  assert.match(generatedSource, /addEventListener\("click"/);
  // Escapes every stored value it renders.
  assert.match(generatedSource, /escapeHtml\(lab\.title/);
  assert.match(generatedSource, /escapeHtml\(lab\.notes\)/);
});

test("validation status is spelled out, not colour alone", () => {
  assert.match(generatedSource, /Checks: all \$\{Number\(lab\.validation\.passed\)\} passed/);
  assert.match(generatedSource, /Checks: \$\{Number\(lab\.validation\.failed\)\} failed/);
  assert.match(generatedSource, /Checks not recorded/);
});

test("legacy labs explain why selections cannot be edited", () => {
  assert.match(generatedSource, /built before its choices were saved/);
  assert.match(generatedSource, /lab\.selections/);
});

test("editing never overwrites silently", () => {
  assert.match(html, /name=["']lb-save-mode["'] value=["']new["'] checked/);
  assert.match(html, /name=["']lb-save-mode["'] value=["']replace["']/);
  assert.match(wizardSource, /=== "replace" \? labBuilder\.editing\.labId : undefined/);
  assert.match(appSource, /replaceLabId: lbReplaceTarget\(\)/);
  assert.match(html, /<script src=["']generated-labs\.js["'] defer><\/script>/);
});

// ── Dark, light, and print theme consistency & WCAG AA contrast ──────────────

function hexToRgb(hex) {
  const raw = String(hex).trim().replace(/^#/, "");
  const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

function mixRgb(fgRgb, bgRgb, fgWeight) {
  return fgRgb.map((c, idx) => Math.round(c * fgWeight + bgRgb[idx] * (1 - fgWeight)));
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fg, bg) {
  const l1 = luminance(Array.isArray(fg) ? fg : hexToRgb(fg));
  const l2 = luminance(Array.isArray(bg) ? bg : hexToRgb(bg));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function parseCssCustomProperties(cssBlock) {
  const vars = {};
  for (const match of cssBlock.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    vars[match[1]] = match[2].trim();
  }
  return vars;
}

test("generated lab result body separates outer panels from preview-frame and avoids hardcoded light colors", () => {
  // #lb-result-body must not carry .preview-frame so sibling validation, QA, admin-prereq, and source panels do not inherit preview overrides.
  assert.match(html, /<div id="lb-result-body" class="lb-result-body"><\/div>/);
  assert.doesNotMatch(html, /id="lb-result-body"[^>]*class="[^"]*preview-frame/);
  assert.match(appSource, /id="lb-result-preview" class="preview-frame"/);
  assert.match(generatedSource, /id="lb-result-preview" class="preview-frame"/);

  const styleContent = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] || "";
  const screenCss = styleContent.split("@media print")[0];
  const printCss = styleContent.split("@media print")[1] || "";

  for (const selector of [
    "\\.lab-pagination-controls",
    "\\.lab-pagination-status",
    "\\.lab-page-select",
    "\\.lab-page-btn",
    "\\.lab-page-btn-primary",
    "\\.lab-complete-badge",
    "\\.lb-admin-prereqs",
    "\\.lb-card-footer",
    "\\.lb-stat-chip",
    "\\.lb-stat-chip-total",
    "\\.lb-stat-chip-recap",
    "\\.lb-card-meta-note",
    "\\.lb-topic-scorebar",
    "\\.lb-topic-toolbar",
    "\\.lb-badge",
    "\\.lb-badge-product",
    "\\.lb-badge-ga",
    "\\.lb-badge-required",
    "\\.lb-concept-count",
    "\\.lb-topic-reason",
    "\\.preview-toc",
    "\\.preview-frame",
  ]) {
    const rule = screenCss.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))?.[1] || "";
    assert.ok(rule, `screen CSS rule for ${selector} must exist`);
    assert.doesNotMatch(
      rule,
      /#(?:1a1a2e|f0f0f5|f4f6fb|f8f8fc|fafafe|1e293b|1f2937|3d4560|1d4ed8|ffffff|fff)\b|\bwhite\b/i,
      `${selector} must use theme custom properties instead of hardcoded light colors`,
    );
  }

  for (const descendant of [
    /\.preview-frame\s+th\s*\{([^}]*)\}/,
    /\.preview-frame\s+code\s*\{([^}]*)\}/,
    /\.preview-frame\s+pre\s*\{([^}]*)\}/,
    /\.preview-frame\s+details\s*\{([^}]*)\}/,
    /\.preview-frame\s+blockquote\s*\{([^}]*)\}/,
    /\.preview-frame\s+\.mermaid\s*\{([^}]*)\}/,
  ]) {
    const body = screenCss.match(descendant)?.[1] || "";
    assert.ok(body, `expected rule ${descendant}`);
    assert.match(body, /var\(--/);
    assert.doesNotMatch(body, /#(?:1a1a2e|f0f0f5|f4f6fb|fafafe|3d4560|1d4ed8)\b/i);
  }

  // Print stylesheet preserves generated-lab print target and ink-on-white rules.
  assert.match(printCss, /body\[data-print-target="generated"\]\s+#lb-result-preview/);
  assert.match(printCss, /\.preview-frame\s+\.lab-page\s*\{\s*display:\s*block !important;/);
  assert.match(printCss, /\.lb-admin-prereqs[\s\S]*?background:\s*#fff !important;/);
  assert.match(printCss, /\.lb-stat-chip-recap[\s\S]*?background:\s*#fff !important;/);
  assert.match(printCss, /\.lb-topic-reason[\s\S]*?background:\s*#fff !important;/);

  // Mermaid diagrams adapt to dark/light themes and re-render on theme toggle.
  const themeSource = readFileSync(new URL("../public/theme.js", import.meta.url), "utf8");
  assert.match(themeSource, /portal-theme-change/);
  assert.match(appSource, /function getMermaidThemeConfig\(/);
  assert.match(appSource, /async function renderMermaidNodes\(/);
  assert.match(appSource, /addEventListener\("portal-theme-change"/);

  // Branded preview banners avoid hardcoded low-contrast #666 taglines.
  const brandedHtml = renderLabMarkdown(prependBrandingBanner("# Sample Lab"));
  assert.match(brandedHtml, /class="lab-branding-tagline"/);
  assert.doesNotMatch(brandedHtml, /color:\s*#666/i);
});

test("portal dark and light theme tokens meet WCAG AA contrast across previews, pagination, code chips, and admin prerequisites", () => {
  const styleContent = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] || "";
  const darkBlock = styleContent.match(/:root\s*\{([^}]*)\}/)?.[1] || "";
  const lightBlock = styleContent.match(/:root\[data-theme="light"\],\s*body\[data-theme="light"\]\s*\{([^}]*)\}/)?.[1] || "";

  const dark = parseCssCustomProperties(darkBlock);
  const light = parseCssCustomProperties(lightBlock);

  for (const [themeName, tokens] of [
    ["dark", dark],
    ["light", light],
  ]) {
    const surfaces = [
      tokens["--bg"],
      tokens["--surface"],
      tokens["--surface-hover"],
      tokens["--preview-bg"],
      tokens["--preview-muted-bg"],
      tokens["--code-bg"],
    ];

    for (const bg of surfaces) {
      assert.ok(
        contrastRatio(tokens["--text"], bg) >= 4.5,
        `${themeName}: --text (${tokens["--text"]}) on ${bg} must be >= 4.5:1`,
      );
      assert.ok(
        contrastRatio(tokens["--text-muted"], bg) >= 4.5,
        `${themeName}: --text-muted (${tokens["--text-muted"]}) on ${bg} must be >= 4.5:1`,
      );
      assert.ok(
        contrastRatio(tokens["--link-color"], bg) >= 4.5,
        `${themeName}: --link-color (${tokens["--link-color"]}) on ${bg} must be >= 4.5:1`,
      );
    }

    assert.ok(
      contrastRatio(tokens["--accent-contrast"], tokens["--accent"]) >= 4.5,
      `${themeName}: --accent-contrast on --accent must be >= 4.5:1`,
    );
    assert.ok(
      contrastRatio(tokens["--accent-hover-contrast"], tokens["--accent-hover"]) >= 4.5,
      `${themeName}: --accent-hover-contrast on --accent-hover must be >= 4.5:1`,
    );
    assert.ok(
      contrastRatio(tokens["--complete-text"], tokens["--complete-bg"]) >= 4.5,
      `${themeName}: .lab-complete-badge text on background must be >= 4.5:1`,
    );

    // .tag, .tag-success, .tag-warning, .tag-danger use 15% tint over --bg / --surface.
    for (const [label, tintHex, fgHex] of [
      [".tag", tokens["--accent"], tokens["--link-color"]],
      [".tag-success", tokens["--success"], tokens["--success"]],
      [".tag-warning", tokens["--warning"], tokens["--warning"]],
      [".tag-danger", tokens["--danger"], tokens["--danger"]],
    ]) {
      for (const hostBg of [tokens["--bg"], tokens["--surface"]]) {
        const pillBg = mixRgb(hexToRgb(tintHex), hexToRgb(hostBg), 0.15);
        assert.ok(
          contrastRatio(hexToRgb(fgHex), pillBg) >= 4.5,
          `${themeName}: ${label} (${fgHex}) over 15% tint on ${hostBg} must be >= 4.5:1`,
        );
      }
    }

    // UI component borders (--border-strong) on preview and pagination surfaces meet >= 3:1.
    for (const hostBg of [tokens["--surface"], tokens["--preview-bg"], tokens["--preview-muted-bg"]]) {
      assert.ok(
        contrastRatio(tokens["--border-strong"], hostBg) >= 3.0,
        `${themeName}: --border-strong (${tokens["--border-strong"]}) on ${hostBg} must be >= 3.0:1`,
      );
    }

    // Wizard product, level, and harness card stat chips & checked card surfaces meet WCAG AA contrast.
    for (const cardBg of [tokens["--bg"], tokens["--lb-card-checked-bg"], tokens["--surface-hover"]]) {
      assert.ok(
        contrastRatio(tokens["--text"], cardBg) >= 4.5,
        `${themeName}: --text (${tokens["--text"]}) on card surface ${cardBg} must be >= 4.5:1`,
      );
      assert.ok(
        contrastRatio(tokens["--text-muted"], cardBg) >= 4.5,
        `${themeName}: --text-muted (${tokens["--text-muted"]}) on card surface ${cardBg} must be >= 4.5:1`,
      );
      assert.ok(
        contrastRatio(tokens["--link-color"], cardBg) >= 4.5,
        `${themeName}: --link-color (${tokens["--link-color"]}) on card surface ${cardBg} must be >= 4.5:1`,
      );
      for (const [borderName, borderToken] of [
        ["--stat-total-border", tokens["--stat-total-border"]],
        ["--stat-chip-border", tokens["--stat-chip-border"]],
        ["--stat-warn-border", tokens["--stat-warn-border"]],
      ]) {
        assert.ok(
          contrastRatio(borderToken, cardBg) >= 3.0,
          `${themeName}: ${borderName} (${borderToken}) on card surface ${cardBg} must be >= 3.0:1`,
        );
      }
    }

    for (const [chipLabel, fgToken, bgToken] of [
      [".lb-stat-chip-total text", tokens["--stat-total-text"], tokens["--stat-total-bg"]],
      [".lb-stat-chip-total strong", tokens["--stat-total-strong"], tokens["--stat-total-bg"]],
      [".lb-stat-chip text", tokens["--stat-chip-text"], tokens["--stat-chip-bg"]],
      [".lb-stat-chip strong", tokens["--stat-chip-strong"], tokens["--stat-chip-bg"]],
      [".lb-card-meta-note text", tokens["--stat-warn-text"], tokens["--stat-warn-bg"]],
      [".lb-stat-chip-recap / .lb-badge-recap", tokens["--arch-recap-text"], tokens["--arch-recap-bg"]],
      [".lb-topic-reason text", tokens["--lb-reason-text"], tokens["--lb-reason-bg"]],
    ]) {
      assert.ok(
        contrastRatio(fgToken, bgToken) >= 4.5,
        `${themeName}: ${chipLabel} (${fgToken}) on ${bgToken} must be >= 4.5:1`,
      );
    }

    // Active Step 6 concept group surface preserves WCAG AA text and link contrast.
    for (const fg of [tokens["--text"], tokens["--text-muted"], tokens["--link-color"]]) {
      assert.ok(
        contrastRatio(fg, tokens["--lb-concept-active-bg"]) >= 4.5,
        `${themeName}: ${fg} on --lb-concept-active-bg (${tokens["--lb-concept-active-bg"]}) must be >= 4.5:1`,
      );
    }
  }

  // OS prefers-color-scheme: light block defines the same stat chip and Step 6 tokens as explicit light theme.
  const mediaLightBlock =
    styleContent.match(/@media \(prefers-color-scheme: light\)\s*\{\s*:root:not\(\[data-theme="dark"\]\)\s*\{([^}]*)\}/)?.[1] || "";
  const mediaLight = parseCssCustomProperties(mediaLightBlock);
  for (const key of [
    "--lb-card-checked-bg",
    "--stat-total-bg",
    "--stat-total-border",
    "--stat-total-text",
    "--stat-total-strong",
    "--stat-chip-bg",
    "--stat-chip-border",
    "--stat-chip-text",
    "--stat-chip-strong",
    "--stat-warn-bg",
    "--stat-warn-border",
    "--stat-warn-text",
    "--lb-reason-bg",
    "--lb-reason-border",
    "--lb-reason-text",
    "--lb-concept-active-bg",
    "--lb-concept-active-border",
  ]) {
    assert.equal(mediaLight[key], light[key], `prefers-color-scheme light must match explicit light token ${key}`);
  }
});

test("standalone exported HTML labs maintain WCAG AA contrast in both light and dark themes", () => {
  const sampleMd = [
    "# Sample Lab",
    "## Overview",
    "Read the [documentation](https://learn.microsoft.com/) and use `*.crm.dynamics.com`.",
    "## Module 1",
    "| Connector | Tier |",
    "| --- | --- |",
    "| Dataverse | Standard |",
  ].join("\n\n");

  for (const [label, branding] of [
    ["unbranded", undefined],
    ["dark-brand", { companyName: "Contoso", primaryColor: "#107c41" }],
    ["bright-brand", { companyName: "Fabrikam", primaryColor: "#f59e0b" }],
    ["portal-default-brand", { companyName: "Northwind", primaryColor: "#4f8ff7" }],
  ]) {
    const doc = renderStandaloneLabHtml(sampleMd, { branding });
    const lightVars = parseCssCustomProperties(doc.match(/:root\s*\{([^}]*)\}/)?.[1] || "");
    const darkVars = parseCssCustomProperties(doc.match(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/)?.[1] || "");

    for (const [mode, vars] of [
      ["light", lightVars],
      ["dark", darkVars],
    ]) {
      for (const bg of [vars["--bg"], vars["--surface"], vars["--surface-muted"], vars["--code-bg"]]) {
        assert.ok(
          contrastRatio(vars["--text"], bg) >= 4.5,
          `${label} (${mode}): --text on ${bg} must be >= 4.5:1`,
        );
        assert.ok(
          contrastRatio(vars["--text-muted"], bg) >= 4.5,
          `${label} (${mode}): --text-muted on ${bg} must be >= 4.5:1`,
        );
        assert.ok(
          contrastRatio(vars["--link"], bg) >= 4.5,
          `${label} (${mode}): --link (${vars["--link"]}) on ${bg} must be >= 4.5:1`,
        );
      }
      assert.ok(
        contrastRatio(vars["--accent-contrast"], vars["--accent"]) >= 4.5,
        `${label} (${mode}): primary button (${vars["--accent-contrast"]} on ${vars["--accent"]}) must be >= 4.5:1`,
      );
      assert.ok(
        contrastRatio(vars["--success-text"], vars["--success-bg"]) >= 4.5,
        `${label} (${mode}): complete badge must be >= 4.5:1`,
      );
    }

    assert.match(doc, /@media print[\s\S]*?\.lab-article\s*\{\s*background:\s*#ffffff !important;\s*color:\s*#111111 !important;/);
    assert.match(doc, /@media print[\s\S]*?\.lab-page\s*\{\s*display:\s*block !important;/);
  }
});

