// Validates the generated feature tour shot list and the screenshots captured
// for it. Missing screenshots are expected until someone captures them, so they
// are reported as pending, not as findings, unless strictMissing is set.

import fs from "node:fs";
import path from "node:path";
import { IMAGE_EXTENSIONS, inspectScreenshot, sidecarName } from "../feature-tour/lib/screenshots.mjs";

export const FEATURE_ASSETS_DIR = "docs/feature-tour/screenshots";
const HARNESSES = new Set(["standard", "microsoft-copilot", "both"]);
const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;

export function checkFeatureShots({ repoRoot, manifestPath, strictMissing = false }) {
  const findings = [];
  const add = (severity, code, message, details = {}) => findings.push({ severity, code, message, ...details });
  const rel = path.relative(repoRoot, manifestPath).split(path.sep).join("/");
  const result = { file: rel, total: 0, captured: 0, missing: [], findings };

  if (!fs.existsSync(manifestPath)) {
    add("critical", "feature-shots-missing-file", `${rel} does not exist. Run npm run feature-tour:build.`);
    return result;
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    add("critical", "feature-shots-invalid-json", `${rel} is not valid JSON.`, { error: error.message });
    return result;
  }

  if (manifest.kind !== "feature-tour") add("critical", "feature-shots-schema", `${rel} must have kind "feature-tour".`);
  if (!nonEmpty(manifest.lab) || !/^[a-z0-9-]+$/i.test(manifest.lab)) {
    add("critical", "feature-shots-schema", `${rel} must have a "lab" id with letters, digits, and hyphens.`);
  }
  if (manifest.assetsDir !== FEATURE_ASSETS_DIR) {
    add("critical", "feature-shots-assets-path", `${rel} assetsDir must be ${FEATURE_ASSETS_DIR}.`);
  }
  if (!Array.isArray(manifest.shots) || manifest.shots.length === 0) {
    add("critical", "feature-shots-schema", `${rel} must have a non-empty "shots" array.`);
    return result;
  }

  const assetsDir = path.resolve(repoRoot, FEATURE_ASSETS_DIR);
  const ids = new Set();
  const filenames = new Set();
  manifest.shots.forEach((shot, index) => {
    const where = `${rel} shots[${index}]`;
    if (!shot || typeof shot !== "object" || Array.isArray(shot)) {
      add("critical", "feature-shots-schema", `${where} must be an object.`);
      return;
    }
    if (!Number.isInteger(shot.id)) add("critical", "feature-shots-schema", `${where} must have an integer id.`);
    else if (ids.has(shot.id)) add("critical", "feature-shots-duplicate-id", `${where} duplicates id ${shot.id}.`);
    else ids.add(shot.id);

    if (!nonEmpty(shot.filename) || !IMAGE_EXTENSIONS.has(path.extname(shot.filename).toLowerCase()) || path.basename(shot.filename) !== shot.filename) {
      add("critical", "feature-shots-schema", `${where} needs a plain image filename (.png, .jpg, .jpeg, .webp).`);
    } else if (filenames.has(shot.filename)) {
      add("critical", "feature-shots-duplicate-filename", `${where} duplicates filename ${shot.filename}.`);
    } else {
      filenames.add(shot.filename);
    }
    for (const key of ["feature", "featureName", "section", "caption", "navHint"]) {
      if (!nonEmpty(shot[key])) add("critical", "feature-shots-schema", `${where} must have a non-empty ${key}.`);
    }
    if (!HARNESSES.has(shot.harness)) add("critical", "feature-shots-schema", `${where} harness must be standard, microsoft-copilot, or both.`);
    if (!Array.isArray(shot.instructions) || shot.instructions.length === 0 || !shot.instructions.every(nonEmpty)) {
      add("critical", "feature-shots-schema", `${where} must have non-empty instructions.`);
    }
    if (!Array.isArray(shot.setup) || !shot.setup.every(nonEmpty)) add("critical", "feature-shots-schema", `${where} setup must be an array of strings.`);
    if (!Array.isArray(shot.callouts)) {
      add("critical", "feature-shots-schema", `${where} callouts must be an array.`);
    } else {
      shot.callouts.forEach((c, i) => {
        if (c?.n !== i + 1 || !nonEmpty(c.label) || !nonEmpty(c.text)) {
          add("critical", "feature-shots-callouts", `${where} callout ${i + 1} needs n=${i + 1}, a label, and text.`);
        }
      });
    }
    if (shot.url !== undefined && !/^https:\/\//.test(shot.url)) {
      add("critical", "feature-shots-schema", `${where} url must be an https URL.`);
    }
  });
  result.total = manifest.shots.length;

  for (const shot of manifest.shots) {
    if (!nonEmpty(shot?.filename) || path.basename(shot.filename) !== shot.filename) continue;
    const info = inspectScreenshot(assetsDir, shot.filename);
    if (info.status === "ready") {
      result.captured += 1;
    } else {
      result.missing.push({ id: shot.id, feature: shot.feature, filename: shot.filename, reason: info.reason });
      if (info.reason === "too-small" || info.reason === "not-an-image") {
        add("warning", "feature-shots-invalid-image", `${FEATURE_ASSETS_DIR}/${shot.filename} exists but is not a usable screenshot (${info.reason}); the site shows it as pending.`, { filename: shot.filename });
      } else if (strictMissing) {
        add("critical", "feature-shots-pending", `${shot.filename} (${shot.feature}) has not been captured.`, { filename: shot.filename });
      }
    }
  }

  if (fs.existsSync(assetsDir)) {
    for (const name of fs.readdirSync(assetsDir)) {
      const ext = path.extname(name).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext) && !filenames.has(name)) {
        add("warning", "feature-shots-orphan", `${FEATURE_ASSETS_DIR}/${name} is not in ${rel}.`, { filename: name });
      }
      if (name.endsWith(".callouts.json")) {
        const owner = [...filenames].find((f) => sidecarName(f) === name);
        if (!owner) add("warning", "feature-shots-orphan-sidecar", `${FEATURE_ASSETS_DIR}/${name} has no matching shot.`, { filename: name });
        else {
          try {
            const parsed = JSON.parse(fs.readFileSync(path.join(assetsDir, name), "utf8"));
            if (!Array.isArray(parsed.callouts)) throw new Error("callouts must be an array");
          } catch (error) {
            add("critical", "feature-shots-sidecar", `${FEATURE_ASSETS_DIR}/${name} is invalid: ${error.message}.`, { filename: name });
          }
        }
      }
    }
  }
  return result;
}
