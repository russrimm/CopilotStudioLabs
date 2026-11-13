import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { build, makePng, tmpDir } from "./helpers.mjs";
import { DEFAULTS } from "../lib/build.mjs";
import { getFeatures } from "../../../portal/lib/lab-builder/catalog.js";

const css = fs.readFileSync(path.join(DEFAULTS.assetsDir, "styles.css"), "utf8");
const scripts = Object.fromEntries(
  ["theme.js", "filter.js", "tour.js"].map((n) => [n, fs.readFileSync(path.join(DEFAULTS.assetsDir, n), "utf8")]),
);

// Pages rendered with one real-looking screenshot so image markup is covered too.
const dir = tmpDir();
const first = build(dir).shotList.shots[0];
fs.writeFileSync(path.join(dir, first.filename), makePng());
const { pages } = build(dir);
const htmlPages = [...pages].filter(([name]) => name.endsWith(".html"));

const attr = (tag, name) => new RegExp(`\\b${name}=["']([^"']*)["']`, "i").exec(tag)?.[1];

test("every page has the document basics", () => {
  for (const [name, html] of htmlPages) {
    assert.match(html, /<html lang="en">/, name);
    assert.match(html, /<title>[^<]+<\/title>/, name);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/, name);
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1, `${name} has one h1`);
    assert.match(html, /<a class="skip-link" href="#main">/, name);
    assert.match(html, /<main id="main" tabindex="-1">/, name);
    assert.match(html, /<nav aria-label="Primary"/, name);
  }
});

test("heading levels never skip", () => {
  for (const [name, html] of htmlPages) {
    let last = 0;
    for (const m of html.matchAll(/<h([1-6])\b/g)) {
      const level = Number(m[1]);
      assert.ok(level <= last + 1, `${name}: h${level} after h${last}`);
      last = level;
    }
  }
});

test("ids are unique and aria references resolve", () => {
  for (const [name, html] of htmlPages) {
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, `${name} has duplicate ids`);
    for (const m of html.matchAll(/\saria-(?:labelledby|describedby|controls)="([^"]+)"/g)) {
      for (const ref of m[1].split(/\s+/)) assert.ok(ids.includes(ref), `${name}: missing id ${ref}`);
    }
    for (const m of html.matchAll(/<a\b[^>]*href="#([^"]+)"/g)) assert.ok(ids.includes(m[1]), `${name}: broken anchor #${m[1]}`);
  }
});

test("images have alt text and form controls have accessible names", () => {
  for (const [name, html] of htmlPages) {
    for (const m of html.matchAll(/<img\b[^>]*>/g)) assert.ok(attr(m[0], "alt")?.length > 10, `${name}: img alt`);
    const labels = new Set([...html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]));
    for (const m of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
      const id = attr(m[2], "id");
      assert.ok(id && (labels.has(id) || attr(m[2], "aria-label")), `${name}: unlabeled ${m[1]} ${id}`);
    }
    for (const m of html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)) {
      assert.ok(m[2].trim() || attr(m[1], "aria-label"), `${name}: button without a name`);
    }
  }
});

test("the page shows a visible placeholder for a pending screenshot and an image for a captured one", () => {
  const withImage = pages.get(`features/${first.feature}.html`);
  assert.match(withImage, /<img src="\.\.\/screenshots\//);
  const other = htmlPages.find(([n]) => n.startsWith("features/") && !n.includes(first.feature));
  assert.match(other[1], /class="shot-placeholder"/);
  assert.match(other[1], /Screenshot pending/);
  assert.doesNotMatch(other[1], /<img\b/);
});

test("tour page has progress, status, keyboard help, and a no-script fallback", () => {
  const html = pages.get("tour.html");
  assert.match(html, new RegExp(`role="progressbar"[^>]*aria-valuemin="1"[^>]*aria-valuemax="${getFeatures().length}"`));
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(html, /<label for="tour-jump">/);
  assert.match(html, /<noscript>/);
  assert.match(html, /Left and Right arrow keys/);
  assert.match(scripts["tour.js"], /ArrowRight/);
  assert.match(scripts["tour.js"], /hashchange/);
  assert.match(scripts["tour.js"], /prefers-reduced-motion/);
});

test("the overview filter exposes a live result count", () => {
  const html = pages.get("index.html");
  for (const id of ["f-q", "f-harness", "f-level", "f-category", "f-availability", "f-shots"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /id="results-status"[^>]*aria-live="polite"/);
});

test("nothing loads from outside the site and scripts never touch the network", () => {
  for (const [name, html] of htmlPages) {
    for (const m of html.matchAll(/<(?:script|link|img|iframe|source)\b[^>]*\s(?:src|href)="([^"]+)"/g)) {
      assert.doesNotMatch(m[1], /^(?:https?:)?\/\//, `${name} loads ${m[1]}`);
    }
  }
  assert.doesNotMatch(css, /@import|url\(\s*["']?https?:/i);
  for (const [name, source] of Object.entries(scripts)) {
    assert.doesNotMatch(source, /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket)\b|innerHTML|insertAdjacentHTML|document\.write|eval\(/, name);
  }
});

test("CSS covers focus, reduced motion, responsive layout, and both themes", () => {
  assert.match(css, /:focus-visible\s*\{/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(max-width: \d+rem\)/);
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /:root\[data-theme="dark"\]/);
  assert.match(css, /\.visually-hidden/);
});

function tokens(block) {
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
}
function luminance(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("text and control colors meet WCAG AA in the light and dark themes", () => {
  const light = tokens(/:root\s*\{([\s\S]*?)\n\}/.exec(css)[1]);
  const darkMedia = tokens(/:root:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)\n\s*\}/.exec(css)[1]);
  const darkAttr = tokens(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/.exec(css)[1]);
  assert.deepEqual(darkMedia, darkAttr, "dark theme tokens match in both selectors");
  const themes = { light, dark: { ...light, ...darkAttr } };
  const textPairs = [
    ["fg", "bg"], ["fg", "surface"], ["muted", "bg"], ["muted", "surface"], ["accent", "bg"], ["accent", "surface"],
    ["accent-fg", "accent"], ["callout-fg", "callout"],
    ["badge-standard-fg", "badge-standard-bg"], ["badge-microsoft-copilot-fg", "badge-microsoft-copilot-bg"],
    ["badge-both-fg", "badge-both-bg"], ["badge-level-fg", "badge-level-bg"], ["badge-preview-fg", "badge-preview-bg"],
    ["badge-ga-fg", "badge-ga-bg"], ["badge-unflagged-fg", "badge-unflagged-bg"], ["badge-retired-fg", "badge-retired-bg"],
  ];
  const uiPairs = [["border", "bg"], ["border", "surface"], ["focus", "bg"], ["focus", "surface"]];
  for (const [theme, t] of Object.entries(themes)) {
    for (const [fg, bg] of textPairs) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${theme}: ${fg} on ${bg} is ${ratio(t[fg], t[bg]).toFixed(2)}`);
    for (const [fg, bg] of uiPairs) assert.ok(ratio(t[fg], t[bg]) >= 3, `${theme}: ${fg} on ${bg} is ${ratio(t[fg], t[bg]).toFixed(2)}`);
  }
});
