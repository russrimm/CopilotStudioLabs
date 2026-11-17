/**
 * "Where should we capture?": the tenant addresses and names a capture needs, resolved from every place they
 * can be set, and described for the Screenshot Center.
 *
 * Highest priority first, per setting:
 *   1. the capture request itself (`targets`, or `env` with CAPTURE_* names)
 *   2. the lab's own capture settings (`manifest.customization.captureTargets`)
 *   3. the lab's own SharePoint site (Step 7) for the SharePoint site address
 *   4. the lab's brand profile snapshot, or the active brand profile, or the profile named in the request
 *   5. this server's own CAPTURE_* environment variables
 *
 * Only https addresses and short names pass validation; nothing here logs a value.
 */

import { getActiveBrand, readCustomization, resolveLabBrand } from "../branding-profiles.js";
import { normalizeBrand } from "../lab-builder/brand-theme.js";
import {
  REQUIREMENTS,
  TARGET_FIELDS,
  TARGET_FIELD_IDS,
  targetEnvFromValues,
  targetTextFromValues,
  validateTargetValue,
} from "../../../tools/screenshot-capture/targets.mjs";

const SOURCE_LABELS = { request: "this capture", lab: "this lab", "lab-site": "the lab's SharePoint site", profile: "the brand profile", server: "the portal's settings" };

/**
 * @param {object} options
 * @param {object|null} [options.manifest] the lab manifest, for the lab's own settings and SharePoint site
 * @param {object|null} [options.profile] a stored brand profile to use instead of the lab's or the active one
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {{targets?: object, env?: object}} [options.request]
 * @returns {{values: Record<string, string>, sources: Record<string, string>, extraEnv: Record<string, string>}}
 */
export function resolveCaptureTargets({ manifest = null, profile = null, env = process.env, request = {} } = {}) {
  const values = {};
  const sources = {};
  const set = (id, value, source) => {
    if (values[id] || value === undefined || value === null || value === "") return;
    const checked = validateTargetValue(id, value);
    if (checked.ok && checked.value) {
      values[id] = checked.value;
      sources[id] = source;
    }
  };

  for (const id of TARGET_FIELD_IDS) set(id, request.targets?.[id], "request");
  const known = new Set();
  for (const field of TARGET_FIELDS) {
    if (!field.env) continue;
    known.add(field.env);
    set(field.id, request.env?.[field.env], "request");
  }

  const custom = manifest ? readCustomization(manifest) : null;
  for (const [id, value] of Object.entries(custom?.captureTargets || {})) set(id, value, "lab");

  // A profile named in the request replaces the lab's own snapshot and the active profile, but the lab's own site (Step 7) still counts.
  const brand = profile
    ? manifest
      ? resolveLabBrand({ ...manifest, customization: null }, { env, brand: normalizeBrand(profile) })
      : normalizeBrand(profile)
    : manifest
    ? resolveLabBrand(manifest, { env })
    : getActiveBrand(env);
  if (brand.labSiteUrl) set("sharepointSiteUrl", brand.labSiteUrl, "lab-site");
  for (const field of TARGET_FIELDS) {
    if (field.id === "sharepointSiteUrl") set(field.id, brand.sharepointSiteUrl || brand.defaultSharepointSiteUrl, "profile");
    else set(field.id, brand[field.id], "profile");
  }

  for (const field of TARGET_FIELDS) if (field.env) set(field.id, env?.[field.env], "server");

  // Request variables that are not capture settings (a custom CAPTURE_* address) are passed through as they are.
  const extraEnv = {};
  for (const [name, value] of Object.entries(request.env || {})) if (!known.has(name)) extraEnv[name] = value;
  return { values, sources, extraEnv };
}

/** What a job carries: addresses as CAPTURE_* variables and names as settings. */
export function jobTargetsFrom({ values, extraEnv = {} }) {
  return { env: { ...extraEnv, ...targetEnvFromValues(values) }, text: targetTextFromValues(values) };
}

/**
 * The settings, ready for the Screenshot Center: every field with whether it is set and where it came from, and
 * what is missing for the shots of the lab.
 * @param {{values: object, sources: object}} resolved
 * @param {Array<{filename: string, capture?: {mode: string, missing?: string[], needs?: string[]}}>} [shots]
 */
export function describeCaptureTargets(resolved, shots = []) {
  const fields = TARGET_FIELDS.map((field) => ({
    id: field.id,
    label: field.label,
    kind: field.kind,
    product: field.product,
    placeholder: field.placeholder,
    help: field.help,
    set: Boolean(resolved.values[field.id]),
    value: resolved.values[field.id] || "",
    source: resolved.sources[field.id] || null,
    sourceLabel: SOURCE_LABELS[resolved.sources[field.id]] || null,
  }));
  const requirements = [];
  const counts = new Map();
  for (const shot of shots) {
    for (const id of shot.capture?.needs || []) {
      if (!counts.has(id)) counts.set(id, { shots: 0, waiting: 0, filenames: [] });
      const entry = counts.get(id);
      entry.shots += 1;
      if (shot.capture?.missing?.includes(id)) {
        entry.waiting += 1;
        entry.filenames.push(shot.filename);
      }
    }
  }
  for (const [id, entry] of counts) {
    const requirement = REQUIREMENTS[id];
    if (!requirement) continue;
    requirements.push({
      id,
      label: requirement.label,
      noun: requirement.noun,
      product: requirement.product,
      fields: requirement.fields,
      prompt: requirement.prompt,
      cause: requirement.cause,
      met: entry.waiting === 0,
      shotCount: entry.shots,
      waitingCount: entry.waiting,
      filenames: entry.filenames,
      message: entry.waiting ? `${entry.waiting} screenshot${entry.waiting === 1 ? " needs" : "s need"} your ${requirement.noun}.` : `Your ${requirement.noun} is set.`,
    });
  }
  return { fields, requirements, missing: requirements.filter((r) => !r.met) };
}
