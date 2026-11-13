// Capture settings for each product: where to start, which browser profile to
// use, and where each kind of screen lives. The data is in capture-products.json
// so adding a product or fixing a URL never needs a code change.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const CAPTURE_CONFIG_PATH = path.resolve(here, "..", "capture-products.json");
export const DEFAULT_PRODUCT = "copilot-studio";
export const FEATURE_ASSETS_DIR = "docs/feature-tour/screenshots";

export function readCaptureConfig(file = CAPTURE_CONFIG_PATH) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Product ids in capture order. */
export function productIds(config) {
  return Object.entries(config.products)
    .sort((a, b) => a[1].order - b[1].order)
    .map(([id]) => id);
}

/** Copilot Studio keeps the original file name so existing commands and links keep working. */
export function manifestFileName(product) {
  return product === DEFAULT_PRODUCT ? "feature-shots.json" : `feature-shots.${product}.json`;
}

export function labIdFor(product) {
  return product === DEFAULT_PRODUCT ? "feature-tour" : `feature-tour-${product}`;
}

export function isFeatureManifestName(name) {
  return name === "feature-shots.json" || /^feature-shots\.[a-z0-9-]+\.json$/.test(name);
}

/** The section's capture settings, or an empty object for a section the config does not know. */
export function sectionConfig(config, product, section) {
  return config.products[product]?.sections?.[section] ?? {};
}

/**
 * Check capture-products.json against the catalog's products. Returns problem
 * strings; an empty list means the file is usable.
 */
export function validateCaptureConfig(config, { products = [], sectionsByProduct = {} } = {}) {
  const problems = [];
  const https = (v) => typeof v === "string" && /^https:\/\/[^\s]+$/.test(v);
  const envName = (v) => typeof v === "string" && /^CAPTURE_[A-Z0-9_]+$/.test(v);
  for (const id of products) {
    if (!config.products?.[id]) problems.push(`capture-products.json has no entry for product ${id}.`);
  }
  const orders = new Set();
  for (const [id, p] of Object.entries(config.products ?? {})) {
    if (!/^[a-z0-9-]+$/.test(id)) problems.push(`product id ${id} must use lowercase letters, digits, and hyphens.`);
    if (!Number.isInteger(p.order) || orders.has(p.order)) problems.push(`${id}: order must be a unique integer.`);
    orders.add(p.order);
    if (!p.label) problems.push(`${id}: label is required.`);
    if (!/^[a-z0-9-]+$/.test(p.authProfile ?? "")) problems.push(`${id}: authProfile must use lowercase letters, digits, and hyphens.`);
    if (!https(p.startUrl)) problems.push(`${id}: startUrl must be an https URL.`);
    if (!envName(p.startUrlEnv)) problems.push(`${id}: startUrlEnv must be an environment variable name starting with CAPTURE_.`);
    for (const [section, s] of Object.entries(p.sections ?? {})) {
      if (s.url !== undefined && !https(s.url)) problems.push(`${id}/${section}: url must be an https URL.`);
      if (s.urlEnv !== undefined && !envName(s.urlEnv)) problems.push(`${id}/${section}: urlEnv must start with CAPTURE_.`);
      if (s.hint !== undefined && !String(s.hint).trim()) problems.push(`${id}/${section}: hint must not be empty.`);
    }
    for (const section of sectionsByProduct[id] ?? []) {
      if (id !== DEFAULT_PRODUCT && !p.sections?.[section]) problems.push(`${id}: no capture settings for section "${section}". Add it to capture-products.json.`);
    }
  }
  return problems;
}
