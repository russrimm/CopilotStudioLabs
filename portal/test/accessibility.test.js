import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
