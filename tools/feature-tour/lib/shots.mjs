// Generates the capture-tool shot list (feature-shots.json) from the catalog
// and the overlay. One or more entries per feature, so adding a feature to
// features.json cannot leave it without a shot entry.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NAV_SECTIONS, SECTION_LABELS, TOUR_PRODUCT, boldTerms, stripMarkdown } from "./model.mjs";
import { FEATURE_ASSETS_DIR as ASSETS_DIR, labIdFor, readCaptureConfig, sectionConfig } from "./products.mjs";

// The lab builder keeps reviewed alt text and a caption for every screenshot slot, keyed by
// filename. The tour uses the same text so a lab and the tour describe each image alike.
const SLOT_META_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "portal", "lib", "lab-builder", "screenshot-slots.json");
let slotMeta;
function slotMetaFor(filename) {
  if (slotMeta === undefined) {
    try {
      slotMeta = JSON.parse(fs.readFileSync(SLOT_META_PATH, "utf8")).slots ?? {};
    } catch {
      slotMeta = {};
    }
  }
  return slotMeta[filename];
}

export const FEATURE_SHOTS_ASSETS_DIR = ASSETS_DIR;
export const COPILOT_STUDIO_URL = "https://copilotstudio.microsoft.com/";
export const ADMIN_CENTER_URL = "https://admin.powerplatform.microsoft.com/";
const MAX_DERIVED_CALLOUTS = 4;
const GENERIC_HINT = "Follow the setup steps; the location depends on the feature.";

export function navHintFor(section, sectionSettings = {}, product = TOUR_PRODUCT) {
  if (sectionSettings.hint) return sectionSettings.hint;
  if (product !== TOUR_PRODUCT) return GENERIC_HINT;
  if (section === "home") return "Start on the Copilot Studio Home page.";
  if (section === "admin") return "Start in the Power Platform admin center.";
  if (section === "custom" || section === "solutions") return GENERIC_HINT;
  if (["build", "preview", "test", "evaluate", "monitor", "deploy"].includes(section)) {
    return `Open your agent, then go to the ${SECTION_LABELS[section]}.`;
  }
  const label = SECTION_LABELS[section] ?? section;
  return `Open your agent, then go to ${label}.`;
}

function truncate(text, max = 160) {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

// Callouts derived only from bold UI names in the catalog text. The capture
// tool resolves each one to a rectangle, so nothing here is a guess at layout.
export function deriveCallouts(instructions, steps) {
  const callouts = [];
  const seen = new Set();
  const take = (lines) => {
    for (const line of lines) {
      for (const term of boldTerms(line)) {
        if (seen.has(term) || callouts.length >= MAX_DERIVED_CALLOUTS) continue;
        seen.add(term);
        callouts.push({ label: term, text: term, note: truncate(stripMarkdown(line)) });
      }
    }
  };
  take(instructions);
  if (callouts.length === 0) take(steps);
  return callouts.map((c, i) => ({ n: i + 1, ...c }));
}

export function defaultShot(feature) {
  return {
    filename: `${feature.id}-main.png`,
    section: "custom",
    caption: `${feature.name}: the screen where the main setting or result is visible`,
    instructions: [
      `Follow the steps for ${feature.name} until the main setting or result is on screen.`,
      "Show the controls the steps name. Add a curated shot for this feature in tools/feature-tour/overlay.json to replace this default.",
    ],
  };
}

function numberCallouts(callouts) {
  return callouts.map((c, i) => ({ n: i + 1, label: c.label, text: c.text, ...(c.note ? { note: c.note } : {}) }));
}

function makeEntry({ feature, raw, section, caption, alt, instructions, callouts, product, settings }) {
  const entry = {
    feature: feature.id,
    featureName: feature.name,
    product,
  };
  if (product === TOUR_PRODUCT) entry.harness = feature.harnessGroup;
  Object.assign(entry, {
    filename: raw.filename,
    section,
    caption,
    ...(alt ? { alt } : {}),
    navHint: navHintFor(section, settings, product),
  });
  if (product === TOUR_PRODUCT) {
    if (section === "home") entry.url = COPILOT_STUDIO_URL;
    if (section === "admin") entry.url = ADMIN_CENTER_URL;
    if (NAV_SECTIONS.has(section)) entry.navSection = section;
  } else {
    if (settings.url) entry.url = settings.url;
    if (settings.urlEnv) entry.urlEnv = settings.urlEnv;
  }
  if (raw.manual ?? settings.manual) entry.manual = true;
  entry.prerequisites = feature.prereqs.map((p) => p.name);
  entry.setup = feature.steps.map(stripMarkdown);
  entry.instructions = instructions;
  entry.callouts = callouts;
  return entry;
}

export function buildShotList(catalog, model, overlay = {}, captureConfig = readCaptureConfig()) {
  const product = model.productId ?? TOUR_PRODUCT;
  const productConfig = captureConfig.products[product];
  if (!productConfig) throw new Error(`capture-products.json has no entry for product ${product}.`);
  const known = new Set([
    ...catalog.features.flatMap((f) => (f.screenshots ?? []).map((s) => s.filename)),
    ...Object.values(overlay.shots ?? {}).flat().map((s) => s.filename),
  ]);
  for (const filename of Object.keys(overlay.shotOverrides ?? {})) {
    if (!known.has(filename)) throw new Error(`overlay.shotOverrides has unknown shot filename: ${filename}`);
  }
  const catalogById = new Map(catalog.features.map((f) => [f.id, f]));
  const shots = [];
  for (const feature of model.features) {
    const source = catalogById.get(feature.id);
    const overlayShots = overlay.shots?.[feature.id] ?? [];
    const raws = [...(source.screenshots ?? []), ...overlayShots];
    // A feature added to the catalog with no shots still gets a slot, so it can
    // never silently drop out of the site or the capture list.
    if (raws.length === 0) raws.push(defaultShot(feature));
    for (const base of raws) {
      // Tune a catalog shot (for example its callouts) without editing the catalog.
      const raw = { ...base, ...(overlay.shotOverrides?.[base.filename] ?? {}) };
      const hasExplicit = Array.isArray(raw.callouts) && raw.callouts.length > 0;
      const callouts = hasExplicit
        ? numberCallouts(raw.callouts)
        : deriveCallouts(raw.instructions ?? [], source.steps ?? []);
      const meta = slotMetaFor(raw.filename);
      const caption = raw.caption ?? meta?.caption ?? stripMarkdown((raw.instructions ?? [])[0] ?? feature.name);
      shots.push(
        makeEntry({
          feature,
          raw,
          section: raw.section,
          caption,
          alt: raw.alt ?? meta?.alt,
          instructions: (raw.instructions ?? []).map(stripMarkdown),
          callouts,
          product,
          settings: sectionConfig(captureConfig, product, raw.section),
        }),
      );
    }
  }
  return {
    $comment:
      "Generated by tools/feature-tour/build.mjs from the lab builder catalog, tools/feature-tour/overlay.json, and tools/feature-tour/capture-products.json. Do not edit by hand; edit those files and run npm run feature-tour:build. Consumed by tools/screenshot-capture/capture.js (--product, --manifest) and verify-shots.js. Callout 'text' is the visible UI text the capture tool searches for to place each numbered hotspot. 'urlEnv' names an optional environment variable that holds a tenant-specific address for the shot; 'manual' marks a screen outside the browser that you capture with an OS screenshot tool.",
    lab: labIdFor(product),
    kind: "feature-tour",
    product,
    authProfile: productConfig.authProfile,
    assetsDir: FEATURE_SHOTS_ASSETS_DIR,
    startUrl: productConfig.startUrl,
    startUrlEnv: productConfig.startUrlEnv,
    shots: shots.map((s, i) => ({ id: i + 1, ...s })),
  };
}
