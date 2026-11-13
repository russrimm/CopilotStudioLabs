// Finds the generated feature shot lists (one per product) and the settings the
// capture tool needs from each. Shared by capture.js, verify-shots.js, and status.mjs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PRODUCT, isFeatureManifestName } from "../feature-tour/lib/products.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const captureDir = here;
export const repoRoot = path.resolve(here, "..", "..");
export const FEATURE_ASSETS_DIR = "docs/feature-tour/screenshots";

/**
 * Every feature manifest in `dir`, Copilot Studio first and then the rest by
 * product id. Each entry is { product, file, path, manifest }; a file that is
 * not valid JSON has manifest null and an error message.
 */
export function listFeatureManifests(dir = captureDir) {
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter(isFeatureManifestName) : [];
  const entries = names.map((file) => {
    const full = path.join(dir, file);
    let manifest = null;
    let error = null;
    try {
      manifest = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch (e) {
      error = e.message;
    }
    const product =
      manifest?.product ?? (file === "feature-shots.json" ? DEFAULT_PRODUCT : file.replace(/^feature-shots\./, "").replace(/\.json$/, ""));
    return { product, file, path: full, manifest, error };
  });
  return entries.sort((a, b) => (a.product === DEFAULT_PRODUCT ? -1 : b.product === DEFAULT_PRODUCT ? 1 : a.product.localeCompare(b.product)));
}

/** Resolve a shot's address: a valid https environment override wins, then the shot's own url. */
export function resolveShotUrl(shot, env = process.env) {
  const override = shot.urlEnv ? env[shot.urlEnv] : undefined;
  if (override) {
    if (!/^https:\/\/[^\s]+$/.test(override)) {
      throw new Error(`${shot.urlEnv} must be an https URL (got "${override}").`);
    }
    return { url: override, source: shot.urlEnv };
  }
  return shot.url ? { url: shot.url, source: "manifest" } : { url: null, source: null };
}

/** The address the capture browser opens first: the product's environment override or its start URL. */
export function resolveStartUrl(manifest, env = process.env) {
  const override = manifest.startUrlEnv ? env[manifest.startUrlEnv] : undefined;
  if (override) {
    if (!/^https:\/\/[^\s]+$/.test(override)) {
      throw new Error(`${manifest.startUrlEnv} must be an https URL (got "${override}").`);
    }
    return override;
  }
  return manifest.startUrl;
}
