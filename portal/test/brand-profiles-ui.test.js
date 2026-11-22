import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { selectionsFromManifest } from "../lib/lab-builder/generated-labs.js";

const read = (name) => readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");
const html = read("index.html");
const brandUiSource = read("brand-ui.js");
const wizardSource = read("lab-builder-wizard.js");
const customizeSource = read("lab-customize.js");

// ── Static markup: labels, live regions, structure, and theme-safe CSS ──────

function idsOf(markup, pattern) {
  return [...markup.matchAll(pattern)].map((m) => m[1]);
}

function sectionBetween(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  assert.ok(start >= 0, `missing ${startMarker}`);
  const end = html.indexOf(endMarker, start);
  assert.ok(end > start, `missing ${endMarker}`);
  return html.slice(start, end);
}

test("the Brand profiles manager groups every field, labels every control, and announces status", () => {
  const panel = sectionBetween('id="brand-profiles-panel"', "Deployment Configuration");
  for (const legend of ["Identity", "Colors &amp; fonts", "Links &amp; contact", "Default SharePoint site", "Tenant environment URLs"]) {
    assert.match(panel, new RegExp(`<legend>${legend}</legend>`), `fieldset legend ${legend}`);
  }

  // Every editable control has a visible <label for> (or an aria-label for the color pickers).
  const controls = idsOf(panel, /<(?:input|select)\b[^>]*\bid="(bp-[A-Za-z0-9-]+|branding-logo-file)"/g);
  assert.ok(controls.length >= 22, `expected the full field set, found ${controls.length}`);
  for (const id of controls) {
    const labeled = new RegExp(`<label[^>]*\\bfor="${id}"`).test(panel) || new RegExp(`id="${id}"[^>]*aria-label=`).test(panel);
    assert.ok(labeled, `${id} needs a label`);
  }

  // Inline validation targets exist for every text field and are announced as alerts.
  for (const key of ["name", "companyName", "moreInfoUrl", "supportEmail", "communityUrl", "defaultSharepointSiteUrl", "foundryProjectUrl", "primaryColor", "secondaryColor"]) {
    assert.match(panel, new RegExp(`id="bp-${key}-error" role="alert"`), `${key} error region`);
  }

  // Status and contrast regions are polite live regions.
  assert.match(panel, /id="branding-status" role="status" aria-live="polite"/);
  assert.match(panel, /id="bp-contrast" class="bp-contrast" role="status" aria-live="polite"/);

  // Everything is operable from the keyboard: native buttons for the list and actions, no click-only divs.
  assert.doesNotMatch(panel, /<(?:div|span)\b[^>]*\bonclick=/);
  for (const id of ["bp-new", "bp-activate", "bp-duplicate", "bp-delete", "bp-reset", "bp-save", "branding-remove-logo"]) {
    assert.match(panel, new RegExp(`<button\\b[^>]*\\bid="${id}"`), `${id} is a button`);
  }
  assert.match(panel, /<form id="bp-form" novalidate>/);
  assert.match(panel, /<ul id="bp-list" class="bp-list"><\/ul>/);
  assert.match(panel, /id="bp-preview-heading"/);
  assert.match(panel, /aria-describedby="bp-primaryColor-error bp-contrast"/);
});

test("the Review and build Customize card and brand line are labeled, and the card is a disclosure opened by Change", () => {
  const card = sectionBetween('id="lb-customize-card"', '<details class="lb-advanced">');
  assert.match(card, /aria-labelledby="lb-customize-heading"/);
  const inputs = idsOf(card, /<(?:input|select)\b[^>]*\bid="(lb-[A-Za-z0-9-]+)"/g);
  assert.ok(inputs.length >= 8);
  for (const id of inputs) assert.match(card, new RegExp(`<label[^>]*\\bfor="${id}"`), `${id} needs a label`);
  for (const key of ["companyName", "tagline", "moreInfoUrl", "moreInfoLabel", "supportName", "supportEmail", "footerText"]) {
    assert.match(card, new RegExp(`id="lb-ov-${key}"[^>]*data-lb-ov="${key}"`));
    assert.match(card, new RegExp(`id="lb-ov-${key}-error" role="alert"`));
  }
  assert.match(card, /id="lb-customize-site"[^>]*aria-live="polite"/);
  assert.match(card, /id="lb-customize-preview" aria-labelledby="lb-customize-preview-heading"/);
  assert.match(card, /id="lb-manage-profiles"/, "links to the profile manager");
  const reviewPane = sectionBetween('id="lb-pane-4"', 'id="lb-result-panel"');
  assert.match(reviewPane, /<p id="lb-brand-summary"[^>]*role="status" aria-live="polite">Brand: Default<\/p>/);
  assert.match(reviewPane, /<button[^>]*id="lb-brand-change"[^>]*aria-expanded="false" aria-controls="lb-customize-card">Change<\/button>/);
  assert.match(reviewPane, /<section id="lb-customize-card"[^>]*aria-labelledby="lb-customize-heading" hidden>/, "the card is collapsed until Change is pressed");
  assert.doesNotMatch(html, /id="lb-step8-customize-summary"/, "the brand line replaces the old Step 8 summary");
  assert.match(html, /id="lb-summary" class="lb-summary" role="status" aria-live="polite"/);
});

test("scripts load in dependency order and the new CSS follows the theme conventions", () => {
  const order = ["brand-ui.js", "app.js", "lab-builder-wizard.js", "generated-labs.js", "lab-customize.js"].map((name) => html.indexOf(`src="${name}"`));
  assert.ok(order.every((index) => index > 0), "all scripts are referenced");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "brand-ui.js loads first and lab-customize.js after generated-labs.js");

  const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const screenCss = style.split("@media print")[0];
  const printCss = style.slice(style.indexOf("@media print"));
  assert.match(screenCss, /:where\(a, button, input, select, textarea, summary, \[tabindex\]\):focus-visible/);

  // The list, editor, card, and chip use theme tokens only; the "paper" preview is intentionally fixed light.
  for (const selector of ["\\.bp-item", "\\.bp-fieldset", "\\.bp-contrast", "\\.bp-error", "\\.bp-badge", "\\.lb-customize-card", "\\.lb-brand-chip", "\\.lb-brand-summary"]) {
    const rule = screenCss.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))?.[1] || "";
    assert.ok(rule, `${selector} rule exists`);
    assert.doesNotMatch(rule, /#[0-9a-f]{3,8}\b/i, `${selector} must use theme custom properties`);
  }
  assert.match(screenCss, /\.bp-fieldset input\[aria-invalid="true"\]/);
  assert.match(screenCss, /\.bp-pv\s*\{[^}]*background:\s*#ffffff/, "the preview mimics a printed page in both themes");

  // Print: controls are hidden and the cards render as plain bordered blocks.
  assert.match(printCss, /\.bp-sidebar,[\s\S]*?\.gl-customize \.btn\s*\{[^}]*display:\s*none !important/);
  assert.match(printCss, /\.lb-customize-card,[\s\S]*?\.bp-fieldset[^{]*\{[^}]*background:\s*#fff !important/);
  assert.match(printCss, /\.bp-pv\s*\{[^}]*break-inside:\s*avoid/);
});

function parseProps(block) {
  const props = {};
  for (const [, name, value] of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) props[name] = value.trim();
  return props;
}

function channel(hex, offset) {
  return parseInt(hex.slice(offset, offset + 2), 16);
}

function luminance(hex) {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => {
    const s = channel(h, i) / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function blend(fg, bg, weight) {
  const f = fg.replace("#", "");
  const g = bg.replace("#", "");
  return `#${[0, 2, 4].map((i) => Math.round(channel(f, i) * weight + channel(g, i) * (1 - weight)).toString(16).padStart(2, "0")).join("")}`;
}

test("brand UI text colors meet WCAG AA in the dark and light themes", () => {
  const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const dark = parseProps(style.match(/:root\s*\{([^}]*)\}/)[1]);
  const light = { ...dark, ...parseProps(style.match(/:root\[data-theme="light"\],\s*body\[data-theme="light"\]\s*\{([^}]*)\}/)[1]) };

  for (const [name, theme] of [["dark", dark], ["light", light]]) {
    const checks = [
      ["body text on the card background", theme["--text"], theme["--bg"]],
      ["hint and muted text on the panel", theme["--text-muted"], theme["--surface"]],
      ["hint and muted text on the page", theme["--text-muted"], theme["--bg"]],
      ["inline validation errors on the panel", theme["--danger-text"], theme["--surface"]],
      ["inline validation errors on the card", theme["--danger-text"], theme["--bg"]],
      ["Active badge on its tinted background", theme["--success"], blend(theme["--success"], theme["--surface"], 0.16)],
      ["chip text on the summary bar", theme["--text"], theme["--surface"]],
      ["links on the card", theme["--link-color"] || theme["--accent"], theme["--bg"]],
    ];
    for (const [label, fg, bg] of checks) {
      assert.ok(fg && bg, `${name}: tokens for ${label}`);
      assert.ok(ratio(fg, bg) >= 4.5, `${name} theme: ${label} is ${ratio(fg, bg).toFixed(2)}:1`);
    }
  }
  // The fixed light preview page keeps its own text readable.
  assert.ok(ratio("#1a1d27", "#ffffff") >= 4.5);
  assert.ok(ratio("#3b4660", "#f4f6fb") >= 4.5);
  assert.ok(ratio("#123f9a", "#ffffff") >= 4.5);
});

// ── brand-ui.js: validation, contrast, and the escaped preview ──────────────

function loadBrandUi() {
  const context = vm.createContext({ URL, console });
  vm.runInContext(brandUiSource, context);
  return (code) => vm.runInContext(code, context);
}

test("brand-ui validation mirrors the server rules", () => {
  const run = loadBrandUi();
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "http://insecure.example.com", "//evil.example.com", "https://user:pw@example.com", "ftp://x.example.com", "https://no-dot"]) {
    assert.notEqual(run(`brandValidateUrl(${JSON.stringify(bad)})`), "", `${bad} is rejected`);
  }
  assert.equal(run('brandValidateUrl("")'), "");
  assert.equal(run('brandValidateUrl("learn.contoso.com/help")'), "", "bare domains are accepted and normalized by the server");
  assert.equal(run('brandValidateUrl("https://contoso.sharepoint.com/sites/AI")'), "");
  assert.match(run('brandValidateField("moreInfoUrl", "http://x.example.com")'), /More information URL: URLs must start with https/);
  assert.match(run('brandValidateField("supportEmail", "nope")'), /valid email/);
  assert.equal(run('brandValidateField("supportEmail", "help@contoso.com")'), "");
  assert.match(run('brandValidateField("primaryColor", "blue")'), /hex color/);
  assert.equal(run('brandValidateField("secondaryColor", "")'), "");
  assert.match(run('brandValidateField("footerText", "x".repeat(201))'), /at most 200 characters/);
  assert.match(run('brandValidateField("companyName", "  ")'), /required/);
});

test("brand-ui reports contrast ratios and warns below WCAG AA", () => {
  const run = loadBrandUi();
  const yellow = JSON.parse(run('JSON.stringify(brandContrastReport("#ffff00"))'));
  assert.equal(yellow.aaOnWhite, false);
  assert.equal(yellow.aaOnDark, true);
  assert.ok(yellow.onWhite < 2);
  const warnings = JSON.parse(run('JSON.stringify(brandContrastWarnings("#ffff00", "#0b3d91"))'));
  assert.equal(warnings.filter((w) => /Primary/.test(w)).length, 1);
  assert.ok(warnings.some((w) => /on white/.test(w)));
  assert.equal(run('brandContrastWarnings("#0b3d91", "").length'), 1, "a dark brand color only warns on dark backgrounds");
  assert.equal(run('brandContrastRatio("#000000", "#ffffff")').toFixed(1), "21.0");
});

test("the live preview escapes values, drops unsafe URLs, and keeps its title readable", () => {
  const run = loadBrandUi();
  const hostile = {
    companyName: "<script>alert(1)</script>",
    tagline: '"><img src=x onerror=alert(1)>',
    coverSubtitle: "</div><b>x</b>",
    footerText: "<i>footer</i>",
    primaryColor: "#ffff00",
    secondaryColor: 'red" onmouseover="alert(1)',
    font: "default",
    moreInfoUrl: "javascript:alert(1)",
    communityUrl: "data:text/html,<script>1</script>",
    supportName: "<u>Name</u>",
    supportEmail: 'bad"@example.com',
    logo: "/uploads/../../secret.png",
  };
  const out = run(`renderBrandPreviewHtml(${JSON.stringify(hostile)})`);
  assert.doesNotMatch(out, /<script|<img src=x|<b>|<i>|<u>|onmouseover=|javascript:|data:text|\.\.\//);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(out, /<img/, "an unsafe logo path renders no image");

  const good = run(`renderBrandPreviewHtml(${JSON.stringify({
    companyName: "Contoso Ltd",
    primaryColor: "#ffff00",
    secondaryColor: "#c2410c",
    font: "georgia",
    moreInfoLabel: "Contoso portal",
    moreInfoUrl: "learn.contoso.com/ai",
    supportName: "Ada",
    supportEmail: "ai-help@contoso.com",
    communityUrl: "https://teams.microsoft.com/l/team/x",
    footerText: "Internal use",
    logo: "/uploads/logo-contoso-1.png",
  })}, { labTitle: "My lab" })`);
  assert.match(good, /--pv-secondary:#c2410c/);
  assert.match(good, /font-family:Georgia/);
  assert.match(good, /href="https:\/\/learn\.contoso\.com\/ai"[^>]*rel="noopener noreferrer"/);
  assert.match(good, /href="mailto:ai-help@contoso\.com"/);
  assert.match(good, /<img class="bp-pv-logo" src="\/uploads\/logo-contoso-1\.png" alt="" \/>/);
  assert.match(good, /class="bp-pv-footer">Internal use</);
  assert.match(good, /My lab/);
  const title = good.match(/--pv-title:(#[0-9a-f]{6})/)[1];
  assert.ok(ratio(title, "#ffffff") >= 4.5, "the preview title is darkened to stay readable on the white page");

  const merged = JSON.parse(run('JSON.stringify(brandMergeOverrides({ companyName: "A", tagline: "Profile" }, { tagline: "  Lab  ", companyName: "" }))'));
  assert.equal(merged.tagline, "Lab");
  assert.equal(merged.companyName, "A", "blank overrides inherit");
  assert.equal(run('brandOverrideNames({ tagline: "x", supportEmail: " " }).join(",")'), "tagline");
});

// ── Wizard Review and build integration ─────────────────────────────────────

function loadBrandWizard({ profiles, activeProfileId }) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      const listeners = new Map();
      elements.set(id, {
        id,
        innerHTML: "",
        textContent: "",
        value: "",
        placeholder: "",
        checked: false,
        hidden: false,
        style: {},
        attrs: new Map(),
        listeners,
        contains: () => false,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener(type, fn) {
          listeners.set(type, fn);
        },
        setAttribute(name, value) {
          this.attrs.set(name, value);
        },
        removeAttribute(name) {
          this.attrs.delete(name);
        },
        classList: { toggle() {}, add() {}, remove() {} },
      });
    }
    return elements.get(id);
  };
  const spy = { tabs: [], fetches: [] };
  const context = {
    document: { getElementById: element, querySelector: () => null, querySelectorAll: () => [], activeElement: { dataset: {} } },
    CSS: { escape: (s) => s },
    URL,
    escapeHtml: (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]),
    toast: () => {},
    setActiveTab: (tab) => spy.tabs.push(tab),
    fetch: async (url) => {
      spy.fetches.push(url);
      return { ok: true, json: async () => ({}) };
    },
    setTimeout,
    console,
  };
  vm.createContext(context);
  vm.runInContext(brandUiSource, context);
  vm.runInContext(wizardSource, context);
  vm.runInContext(
    `const brandProfiles = { loaded: true, activeProfileId: ${JSON.stringify(activeProfileId)}, profiles: ${JSON.stringify(profiles)}, fonts: [] };
     function bpEnsureLoaded() { return Promise.resolve(brandProfiles); }
     labBuilder.selectedProducts = new Set([LB_DEFAULT_PRODUCT]);`,
    context,
  );
  return { run: (code) => vm.runInContext(code, context), element, spy };
}

const PROFILES = [
  { id: "default", name: "Default", companyName: "Agentic Microsoft Training and Lab Generator", tagline: "Provisioning Portal", primaryColor: "#4f8ff7", secondaryColor: "", font: "default", supportEmail: "", footerText: "" },
  {
    id: "contoso",
    name: "Contoso <EU>",
    companyName: "Contoso Ltd",
    tagline: "AI Academy",
    primaryColor: "#0b3d91",
    secondaryColor: "#c2410c",
    font: "georgia",
    moreInfoUrl: "https://learn.contoso.com/ai",
    moreInfoLabel: "Contoso portal",
    supportEmail: "ai-help@contoso.com",
    footerText: "Contoso Internal Training",
    defaultSharepointSiteName: "Contoso AI Hub",
    defaultSharepointSiteUrl: "https://contoso.sharepoint.com/sites/AIHub",
  },
];

test("Review and build renders the profile picker, pre-fills the SharePoint site, and previews the cover", () => {
  const { run, element } = loadBrandWizard({ profiles: PROFILES, activeProfileId: "default" });
  run("lbSyncCustomizeCard()");

  const options = element("lb-brand-profile").innerHTML;
  assert.match(options, /<option value="default" selected>Default \(active\)<\/option>/);
  assert.match(options, /<option value="contoso">Contoso &lt;EU&gt;<\/option>/, "profile names are escaped");
  assert.equal(element("lb-brand-profile").value, "default");
  assert.equal(JSON.stringify(run("lbBrandRequestFields()")), JSON.stringify({ brandProfileId: "default", overrides: {} }));

  // Switching profile pre-fills the SharePoint site, shows placeholders from the profile, and updates the preview and chip.
  const select = element("lb-brand-profile");
  select.value = "contoso";
  select.listeners.get("change")();
  assert.equal(element("lb-sharepoint-site-name").value, "Contoso AI Hub");
  assert.equal(element("lb-sharepoint-site-url").value, "https://contoso.sharepoint.com/sites/AIHub");
  assert.equal(run("labBuilder.sharepointSiteUrl"), "https://contoso.sharepoint.com/sites/AIHub");
  assert.equal(element("lb-ov-tagline").placeholder, "AI Academy");
  assert.equal(element("lb-ov-supportEmail").placeholder, "ai-help@contoso.com");
  assert.match(element("lb-customize-preview").innerHTML, /Contoso Ltd/);
  assert.match(element("lb-customize-preview").innerHTML, /font-family:Georgia/);
  assert.match(element("lb-summary").innerHTML, /<span class="lb-brand-chip">Brand: Contoso &lt;EU&gt;<\/span>/);
  assert.equal(run("lbBrandRequestFields().brandProfileId"), "contoso");

  // A SharePoint site the learner typed is never replaced; the profile default only fills blanks or its own earlier default.
  element("lb-sharepoint-site-name").value = "My own site";
  select.value = "default";
  select.listeners.get("change")();
  assert.equal(element("lb-sharepoint-site-name").value, "My own site");
  assert.equal(element("lb-sharepoint-site-url").value, "", "the previous default URL is cleared when the new profile has none");
});

test("per-lab overrides validate inline, reach the generate request, and show in the brand line", () => {
  const { run, element } = loadBrandWizard({ profiles: PROFILES, activeProfileId: "contoso" });
  run("lbSyncCustomizeCard()");

  const type = (key, value) => {
    const input = element(`lb-ov-${key}`);
    input.value = value;
    input.listeners.get("input")();
    return input;
  };

  type("tagline", "Spring cohort");
  type("supportName", "  Grace  ");
  assert.deepEqual(JSON.parse(run("JSON.stringify(lbBrandRequestFields())")), {
    brandProfileId: "contoso",
    overrides: { tagline: "Spring cohort", supportName: "Grace" },
  });
  assert.match(element("lb-customize-preview").innerHTML, /Spring cohort/);

  const bad = type("moreInfoUrl", "javascript:alert(1)");
  assert.match(element("lb-ov-moreInfoUrl-error").textContent, /More information URL/);
  assert.equal(bad.attrs.get("aria-invalid"), "true");
  type("moreInfoUrl", "https://learn.contoso.com/lab");
  assert.equal(element("lb-ov-moreInfoUrl-error").textContent, "");
  assert.equal(bad.attrs.has("aria-invalid"), false);

  const xss = type("companyName", "<script>alert(1)</script>");
  assert.doesNotMatch(element("lb-customize-preview").innerHTML, /<script/);
  assert.ok(xss);
  type("companyName", "");

  run("lbSyncCustomizeSummary()");
  const summary = element("lb-brand-summary");
  assert.equal(summary.hidden, false);
  assert.equal(summary.textContent, "Brand: Contoso <EU> (changed for this lab: tagline, more information url, support contact name)");

  // Blank overrides inherit from the profile and are not sent.
  type("tagline", "");
  type("moreInfoUrl", "");
  type("supportName", "");
  assert.deepEqual(JSON.parse(run("JSON.stringify(lbBrandRequestFields().overrides)")), {});
  run("lbSyncCustomizeSummary()");
  assert.equal(summary.textContent, "Brand: Contoso <EU>", "no overrides: the line names only the profile");

  // Starting a new lab goes back to the active profile with no overrides.
  type("tagline", "Temporary");
  run("lbResetAnswers()");
  assert.equal(run("labBuilder.brand.profileId"), null);
  assert.deepEqual(JSON.parse(run("JSON.stringify(labBuilder.brand.overrides)")), {});
});

test("the Change button expands and collapses the Customize card, and the brand line names the profile", () => {
  const { run, element } = loadBrandWizard({ profiles: PROFILES, activeProfileId: "contoso" });
  run("lbSyncCustomizeCard()");
  run("lbBindBrandToggle()");
  assert.equal(element("lb-brand-summary").textContent, "Brand: Contoso <EU>");

  const card = element("lb-customize-card");
  const button = element("lb-brand-change");
  card.hidden = true;
  button.listeners.get("click")();
  assert.equal(card.hidden, false);
  assert.equal(button.attrs.get("aria-expanded"), "true");
  assert.equal(button.textContent, "Hide");
  button.listeners.get("click")();
  assert.equal(card.hidden, true);
  assert.equal(button.attrs.get("aria-expanded"), "false");
  assert.equal(button.textContent, "Change");
});

test("the Brand chip in the summary bar shows only for a non-default profile or Default with overrides, and never on Review and build", () => {
  const { run, element } = loadBrandWizard({ profiles: PROFILES, activeProfileId: "default" });
  run("lbSyncCustomizeCard()");
  const select = element("lb-brand-profile");
  const choose = (id) => {
    select.value = id;
    select.listeners.get("change")();
  };
  const override = (key, value) => {
    element(`lb-ov-${key}`).value = value;
    element(`lb-ov-${key}`).listeners.get("input")();
  };
  const onStep = (step) => {
    run(`labBuilder.step = LB_STEP.${step}; lbRenderSummary()`);
    return { chip: run("lbBrandSummaryChip()"), summary: element("lb-summary").innerHTML };
  };
  const CHIP = (name) => `<span class="lb-brand-chip">Brand: ${name}</span>`;
  const OFF_REVIEW = ["product", "tailor", "topics"];

  // The built-in Default with no overrides says nothing: it is what every lab gets.
  for (const step of [...OFF_REVIEW, "review"]) {
    const { chip, summary } = onStep(step);
    assert.equal(chip, "", `Default adds no chip on ${step}`);
    assert.doesNotMatch(summary, /lb-brand-chip/);
  }

  // A profile the person chose shows on every step but Review and build, where the brand line is already on screen.
  choose("contoso");
  for (const step of OFF_REVIEW) {
    const { chip, summary } = onStep(step);
    assert.equal(chip, CHIP("Contoso &lt;EU&gt;"), `the chosen profile shows on ${step}`);
    assert.ok(summary.endsWith(CHIP("Contoso &lt;EU&gt;")), "and sits at the end of the line");
  }
  const review = onStep("review");
  assert.equal(review.chip, "", "Review and build has its own brand line");
  assert.doesNotMatch(review.summary, /lb-brand-chip/);
  assert.equal(element("lb-brand-summary").textContent, "Brand: Contoso <EU>", "and that line still names the profile");

  // Default with a change for this lab is no longer plain Default, so it shows (off Review and build) until the change is cleared.
  choose("default");
  override("tagline", "Spring cohort");
  for (const step of OFF_REVIEW) assert.equal(onStep(step).chip, CHIP("Default"), `Default with an override shows on ${step}`);
  assert.equal(onStep("review").chip, "");
  override("tagline", "   ");
  assert.equal(onStep("tailor").chip, "", "a blank override is no override");
});

test("the Manage brand profiles link opens the Configuration tab, and nothing breaks before profiles load", () => {
  const { run, element, spy } = loadBrandWizard({ profiles: PROFILES, activeProfileId: "default" });
  run("lbSyncCustomizeCard()");
  let prevented = false;
  element("lb-manage-profiles").listeners.get("click")({ preventDefault: () => (prevented = true) });
  assert.equal(prevented, true);
  assert.deepEqual(spy.tabs, ["config"]);

  const bare = vm.createContext({ document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], activeElement: { dataset: {} } }, escapeHtml: String, toast() {}, console, setTimeout });
  vm.runInContext(wizardSource, bare);
  assert.equal(vm.runInContext("lbBrandSummaryChip()", bare), "");
  assert.equal(JSON.stringify(vm.runInContext("lbBrandRequestFields()", bare)), "{}");
  assert.equal(vm.runInContext("lbSyncCustomizeCard()", bare), undefined);
  assert.equal(vm.runInContext("lbSyncCustomizeSummary()", bare), undefined);
});

test("re-opening a customized lab restores its profile and overrides", () => {
  const manifest = {
    request: { features: ["create-agent"], level: 100, products: ["copilot-studio"] },
    customization: { profileId: "contoso", overrides: { tagline: "Lab-only" } },
  };
  const selections = selectionsFromManifest(manifest);
  assert.equal(selections.brandProfileId, "contoso");
  assert.deepEqual(selections.brandOverrides, { tagline: "Lab-only" });
  assert.equal("brandProfileId" in selectionsFromManifest({ request: manifest.request }), false, "labs without customization add nothing");
});

// ── Saved-lab Customize section ─────────────────────────────────────────────

function loadCustomize() {
  const fetches = [];
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { id, value: "", textContent: "", attrs: new Map(), focus() {}, setAttribute(n, v) { this.attrs.set(n, v); }, removeAttribute(n) { this.attrs.delete(n); } });
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: element },
    escapeHtml: (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]),
    toast() {},
    console,
    fetch: async (url, init) => {
      fetches.push({ url, init });
      if (init?.method === "PATCH") return { ok: true, status: 200, json: async () => ({ customized: true }) };
      return { ok: false, status: 404, json: async () => ({ error: "Generated lab not found" }) };
    },
  });
  vm.runInContext(brandUiSource, context);
  vm.runInContext(customizeSource, context);
  return { run: (code) => vm.runInContext(code, context), element, fetches };
}

test("the saved-lab Customize section is a labeled disclosure with Update and Reset actions", () => {
  const { run } = loadCustomize();
  const data = {
    customized: true,
    profileId: "contoso",
    profileName: "Contoso",
    profileExists: true,
    profileChangedSinceSnapshot: true,
    activeProfileId: "default",
    overrides: { tagline: '"><script>x</script>' },
    effective: { companyName: "Contoso Ltd", tagline: "AI Academy", primaryColor: "#0b3d91" },
  };
  const out = run(`lbRenderLabCustomizeHtml(${JSON.stringify(data)}, ${JSON.stringify(PROFILES)})`);
  assert.match(out, /^<summary>Customize this lab \(branding\)<\/summary>/);
  assert.match(out, /<label for="gl-brand-profile">Brand profile<\/label>/);
  assert.match(out, /<option value="contoso" selected>Contoso &lt;EU&gt;<\/option>/);
  assert.match(out, /<option value="default">Default \(active\)<\/option>/);
  for (const key of ["companyName", "tagline", "moreInfoUrl", "moreInfoLabel", "supportName", "supportEmail", "footerText", "defaultSharepointSiteName", "defaultSharepointSiteUrl"]) {
    assert.match(out, new RegExp(`<label for="gl-ov-${key}">`));
    assert.match(out, new RegExp(`id="gl-ov-${key}-error" role="alert"`));
  }
  assert.doesNotMatch(out, /<script>x/, "override values are escaped");
  assert.match(out, /data-gl-customize="update-from-profile">Update from profile/);
  assert.match(out, /data-gl-customize="reset">Reset to profile/);
  assert.match(out, /The profile changed after this lab was built/);
  assert.match(out, /id="gl-customize-status" role="status" aria-live="polite"/);

  const fresh = run(`lbRenderLabCustomizeHtml({ customized: false, overrides: {}, effective: {} }, ${JSON.stringify(PROFILES)})`);
  assert.match(fresh, /Follows the active profile/);
  assert.match(fresh, /data-gl-customize="reset" disabled>/, "nothing to reset before the lab is customized");

  const deleted = run(`lbRenderLabCustomizeHtml({ customized: true, profileId: "gone", profileName: "Gone", profileExists: false, overrides: {}, effective: {} }, ${JSON.stringify(PROFILES)})`);
  assert.match(deleted, /Gone \(deleted\)/);
  assert.match(deleted, /was deleted\. The lab keeps its saved copy/);
});

test("saving or refreshing a saved lab sends the right PATCH and validates overrides first", async () => {
  const { run, element, fetches } = loadCustomize();
  run('lbCustomizeState.labId = "lab-1"');

  element("gl-brand-profile").value = "contoso";
  element("gl-ov-tagline").value = "  Lab tagline ";
  element("gl-ov-moreInfoUrl").value = "http://insecure.example.com";
  await run('lbSubmitCustomize("lab-1", "save")');
  assert.equal(fetches.length, 0, "an invalid override is blocked before any request");
  assert.match(element("gl-ov-moreInfoUrl-error").textContent, /More information URL/);
  assert.equal(element("gl-ov-moreInfoUrl").attrs.get("aria-invalid"), "true");
  assert.match(element("gl-customize-status").textContent, /Fix the highlighted fields/);

  element("gl-ov-moreInfoUrl").value = "";
  await run('lbSubmitCustomize("lab-1", "save")');
  const save = fetches.find((f) => f.init?.method === "PATCH");
  assert.equal(save.url, "/api/lab-builder/generated/lab-1/customization");
  assert.deepEqual(JSON.parse(save.init.body), { overrides: { tagline: "Lab tagline" }, profileId: "contoso" });

  fetches.length = 0;
  await run('lbSubmitCustomize("lab-1", "update-from-profile")');
  assert.deepEqual(JSON.parse(fetches.find((f) => f.init?.method === "PATCH").init.body), { action: "update-from-profile" });
  fetches.length = 0;
  await run('lbSubmitCustomize("lab-1", "reset")');
  assert.deepEqual(JSON.parse(fetches.find((f) => f.init?.method === "PATCH").init.body), { action: "reset" });
});
