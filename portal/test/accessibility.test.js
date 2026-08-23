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
