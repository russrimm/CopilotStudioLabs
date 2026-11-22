/**
 * Reusable brand profiles (for example one per customer) plus the per-lab
 * customization that sits on top of them.
 *
 * Profiles live in `<portal data dir>/brand-profiles.json`, so the existing
 * Azure Blob write-through sync (which mirrors the whole `data/` prefix) keeps
 * them durable with no extra wiring. The legacy single-brand `branding.json`
 * is migrated into a "default" profile the first time it is read and is kept
 * in step with the active profile so older readers and rollbacks keep working.
 *
 * Resolution order everywhere a lab is rendered:
 *   per-lab overrides > lab profile snapshot > active profile > defaults.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, copyFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { writeJsonAtomic } from "./concurrency/atomic-file.js";
import { withLockedFileSync } from "./concurrency/json-update.js";
import { resolveGeneratedLabsDir, resolvePortalDataDir, resolvePortalUploadsDir } from "./storage-config.js";
import { validateTargets } from "../../tools/screenshot-capture/targets.mjs";
import { normalizeAgentSource } from "../../tools/screenshot-capture/walkthrough.mjs";
import {
  BRAND_FONTS,
  CAPTURE_ENV_MAP,
  DEFAULT_BRAND,
  ENVIRONMENT_URL_FIELDS,
  OVERRIDE_FIELDS,
  TEXT_FIELD_LIMITS,
  COLOR_FIELDS,
  URL_FIELDS,
  EMAIL_FIELDS,
  applyBrandOverrides,
  cleanText,
  describeBrandContrast,
  isSafeUploadPath,
  normalizeBrand,
  validateBrandFields,
  validateHttpsUrl,
} from "./lab-builder/brand-theme.js";

export const BRAND_PROFILE_STORE_FILE = "brand-profiles.json";
export const LEGACY_BRANDING_FILE = "branding.json";
export const DEFAULT_PROFILE_ID = "default";
export const MAX_PROFILES = 50;
export const MAX_PROFILE_NAME_LENGTH = 60;
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

const PROFILE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const LOGO_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.(?:png|jpe?g)$/;

/** Fields stored on a profile besides id, name, and timestamps. */
export const PROFILE_BRAND_FIELDS = Object.freeze([
  ...Object.keys(TEXT_FIELD_LIMITS),
  ...COLOR_FIELDS,
  "font",
  ...URL_FIELDS,
  ...EMAIL_FIELDS,
]);

export class BrandProfileError extends Error {
  constructor(message, status = 400, errors = null) {
    super(message);
    this.name = "BrandProfileError";
    this.status = status;
    this.errors = errors;
  }
}

// ── Paths and storage ───────────────────────────────────────────────────────

function dataDir(env) {
  return resolvePortalDataDir(env);
}

function uploadsDir(env) {
  return resolvePortalUploadsDir(env);
}

export function getBrandProfileStorePath(env = process.env) {
  return resolve(dataDir(env), BRAND_PROFILE_STORE_FILE);
}

function legacyBrandingPath(env) {
  return resolve(dataDir(env), LEGACY_BRANDING_FILE);
}

function ensureStorageDirs(env) {
  mkdirSync(dataDir(env), { recursive: true });
  mkdirSync(uploadsDir(env), { recursive: true });
}

/**
 * Run `work` while holding the profile store's cross-process lock, so a change read from the store is written back
 * before another process (a second portal, or a command-line tool) can change it. Reentrant, so a locked function may
 * call another locked function. Reads never take it.
 */
export function withBrandProfileStoreLock(env, work) {
  return withLockedFileSync(getBrandProfileStorePath(env), work);
}

export function isValidProfileId(value) {
  return typeof value === "string" && PROFILE_ID_RE.test(value);
}

function slugify(value) {
  const slug = String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "profile";
}

function uniqueProfileId(base, store) {
  const taken = new Set(store.profiles.map((p) => p.id));
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) {
    const suffix = `-${n}`;
    candidate = `${base.slice(0, 40 - suffix.length).replace(/-+$/g, "")}${suffix}`;
    n += 1;
  }
  return candidate;
}

function profileNameTaken(store, name, exceptId = null) {
  const wanted = name.toLowerCase();
  return store.profiles.some((p) => p.id !== exceptId && p.name.toLowerCase() === wanted);
}

function uniqueProfileName(store, base) {
  let candidate = base.slice(0, MAX_PROFILE_NAME_LENGTH);
  let n = 2;
  while (profileNameTaken(store, candidate)) {
    const suffix = ` ${n}`;
    candidate = `${base.slice(0, MAX_PROFILE_NAME_LENGTH - suffix.length)}${suffix}`;
    n += 1;
  }
  return candidate;
}

function nowIso() {
  return new Date().toISOString();
}

// ── Profile normalization ───────────────────────────────────────────────────

function pickProfileBrandFields(brand) {
  const out = {};
  for (const key of PROFILE_BRAND_FIELDS) out[key] = brand[key];
  out.logo = brand.logo || null;
  return out;
}

/** Normalize a stored profile record; tolerant so a hand-edited file never crashes the portal. */
function sanitizeStoredProfile(raw, fallbackId) {
  const src = raw && typeof raw === "object" ? raw : {};
  const id = isValidProfileId(src.id) ? src.id : fallbackId;
  const name = cleanText(src.name).slice(0, MAX_PROFILE_NAME_LENGTH) || cleanText(src.companyName).slice(0, MAX_PROFILE_NAME_LENGTH) || "Profile";
  const brand = normalizeBrand(src);
  const createdAt = typeof src.createdAt === "string" ? src.createdAt : nowIso();
  return {
    id,
    name,
    ...pickProfileBrandFields(brand),
    createdAt,
    updatedAt: typeof src.updatedAt === "string" ? src.updatedAt : createdAt,
  };
}

function defaultProfile() {
  const now = nowIso();
  return {
    id: DEFAULT_PROFILE_ID,
    name: "Default",
    ...pickProfileBrandFields(normalizeBrand({})),
    createdAt: now,
    updatedAt: now,
  };
}

function sanitizeStore(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const profiles = [];
  const seen = new Set();
  const list = Array.isArray(src.profiles) ? src.profiles : [];
  for (const [index, entry] of list.entries()) {
    if (profiles.length >= MAX_PROFILES) break;
    const profile = sanitizeStoredProfile(entry, `profile-${index + 1}`);
    if (seen.has(profile.id)) continue;
    seen.add(profile.id);
    profiles.push(profile);
  }
  if (!profiles.length) profiles.push(defaultProfile());
  const activeProfileId = profiles.some((p) => p.id === src.activeProfileId) ? src.activeProfileId : profiles[0].id;
  return { version: 1, activeProfileId, profiles };
}

function readLegacyBranding(env) {
  const file = legacyBrandingPath(env);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Load the profile store. When no store exists yet, a legacy `branding.json`
 * is migrated into the "default" profile (written once); otherwise an
 * in-memory default store is returned and only persisted on the first change.
 */
export function loadProfileStore(env = process.env) {
  ensureStorageDirs(env);
  const file = getBrandProfileStorePath(env);
  if (existsSync(file)) {
    try {
      return sanitizeStore(JSON.parse(readFileSync(file, "utf-8")));
    } catch {
      return sanitizeStore(null);
    }
  }

  const legacy = readLegacyBranding(env);
  const store = sanitizeStore({
    activeProfileId: DEFAULT_PROFILE_ID,
    profiles: [{ ...defaultProfile(), ...(legacy ? pickProfileBrandFields(normalizeBrand(legacy)) : {}) }],
  });
  if (legacy) {
    try {
      // Another process may have saved a real store since the check above; never replace it with the migrated copy.
      withBrandProfileStoreLock(env, () => {
        if (!existsSync(file)) writeJsonAtomic(file, store);
      });
    } catch {
      // Read-only storage: keep serving the migrated in-memory profile.
    }
  }
  return store;
}

function classicBrandingOf(profile) {
  return {
    companyName: profile.companyName,
    logo: profile.logo || null,
    primaryColor: profile.primaryColor,
    tagline: profile.tagline,
  };
}

/** Persist the store and mirror the active profile into the legacy `branding.json`. */
function saveProfileStore(store, env) {
  ensureStorageDirs(env);
  const sanitized = sanitizeStore(store);
  writeJsonAtomic(getBrandProfileStorePath(env), sanitized);
  const active = sanitized.profiles.find((p) => p.id === sanitized.activeProfileId) || sanitized.profiles[0];
  writeJsonAtomic(legacyBrandingPath(env), classicBrandingOf(active));
  return sanitized;
}

function toPublicProfile(profile, store) {
  return {
    ...profile,
    isActive: profile.id === store.activeProfileId,
    contrast: describeBrandContrast(profile),
  };
}

function requireProfile(store, id) {
  const profile = isValidProfileId(id) ? store.profiles.find((p) => p.id === id) : null;
  if (!profile) throw new BrandProfileError("Brand profile not found.", 404);
  return profile;
}

// ── Logo handling ───────────────────────────────────────────────────────────

/** Identify a PNG or JPEG by its magic bytes; returns ".png", ".jpg", or null. */
export function detectRasterLogoExtension(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return ".jpg";
  return null;
}

export function resolveLogoAbsolutePath(logoPath, env = process.env) {
  if (!isSafeUploadPath(logoPath)) return null;
  const fileName = logoPath.slice("/uploads/".length);
  if (!fileName || fileName === "." || fileName === "..") return null;
  const dir = uploadsDir(env);
  const target = resolve(dir, fileName);
  const rel = relative(dir, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return target;
}

function labSnapshotLogos(env) {
  const logos = new Set();
  let root;
  try {
    root = resolveGeneratedLabsDir(env);
    if (!existsSync(root)) return logos;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const manifest = JSON.parse(readFileSync(resolve(root, entry.name, "manifest.json"), "utf-8"));
        const logo = manifest?.customization?.profileSnapshot?.logo;
        if (typeof logo === "string") logos.add(logo);
      } catch {
        // Not a lab folder or unreadable manifest.
      }
    }
  } catch {
    // Missing labs directory: nothing references the logo.
  }
  return logos;
}

/**
 * Remove an uploaded logo only when no other profile and no lab snapshot still
 * uses it, so labs keep their look after a profile logo is replaced.
 */
function removeLogoIfUnreferenced(logoPath, store, env) {
  if (!logoPath) return;
  if (store.profiles.some((p) => p.logo === logoPath)) return;
  if (labSnapshotLogos(env).has(logoPath)) return;
  const abs = resolveLogoAbsolutePath(logoPath, env);
  if (abs && existsSync(abs)) {
    try {
      unlinkSync(abs);
    } catch {
      // Best effort: a locked file is not worth failing the request.
    }
  }
}

/** Build a collision-free upload file name for a profile logo. */
export function buildProfileLogoFileName(profileId, extension) {
  return `logo-${profileId}-${Date.now()}${extension}`;
}

// ── Public store API ────────────────────────────────────────────────────────

export function listProfiles(env = process.env) {
  const store = loadProfileStore(env);
  return {
    activeProfileId: store.activeProfileId,
    profiles: store.profiles.map((p) => toPublicProfile(p, store)),
    fonts: Object.entries(BRAND_FONTS).map(([id, font]) => ({ id, label: font.label })),
    limits: {
      maxProfiles: MAX_PROFILES,
      maxNameLength: MAX_PROFILE_NAME_LENGTH,
      maxLogoBytes: MAX_LOGO_BYTES,
      text: { ...TEXT_FIELD_LIMITS },
    },
  };
}

export function getProfile(id, env = process.env) {
  const store = loadProfileStore(env);
  return toPublicProfile(requireProfile(store, id), store);
}

export function findProfile(id, env = process.env) {
  const store = loadProfileStore(env);
  const profile = isValidProfileId(id) ? store.profiles.find((p) => p.id === id) : null;
  return profile ? toPublicProfile(profile, store) : null;
}

export function getActiveProfileId(env = process.env) {
  return loadProfileStore(env).activeProfileId;
}

export function getActiveProfile(env = process.env) {
  const store = loadProfileStore(env);
  return toPublicProfile(requireProfile(store, store.activeProfileId), store);
}

function validateName(input, store, exceptId = null) {
  if (typeof input !== "string" || !cleanText(input)) {
    throw new BrandProfileError("Profile name is required.", 400, { name: "Profile name is required." });
  }
  const name = cleanText(input);
  if (name.length > MAX_PROFILE_NAME_LENGTH) {
    const message = `Profile name must be at most ${MAX_PROFILE_NAME_LENGTH} characters.`;
    throw new BrandProfileError(message, 400, { name: message });
  }
  if (profileNameTaken(store, name, exceptId)) {
    const message = `A brand profile named "${name}" already exists.`;
    throw new BrandProfileError(message, 409, { name: message });
  }
  return name;
}

function throwFieldErrors(errors) {
  const first = Object.values(errors)[0];
  throw new BrandProfileError(first || "Invalid brand profile.", 400, errors);
}

export function createProfile(input = {}, env = process.env) {
  return withBrandProfileStoreLock(env, () => createProfileLocked(input, env));
}

function createProfileLocked(input, env) {
  const store = loadProfileStore(env);
  if (store.profiles.length >= MAX_PROFILES) {
    throw new BrandProfileError(`You can create at most ${MAX_PROFILES} brand profiles.`, 409);
  }
  const name = validateName(input?.name, store);
  const withDefaults = { ...input };
  if (!Object.prototype.hasOwnProperty.call(withDefaults, "companyName")) withDefaults.companyName = name;
  const { values, errors } = validateBrandFields(withDefaults, PROFILE_BRAND_FIELDS);
  if (Object.keys(errors).length) throwFieldErrors(errors);

  const now = nowIso();
  const profile = sanitizeStoredProfile(
    {
      ...DEFAULT_BRAND,
      ...values,
      id: uniqueProfileId(isValidProfileId(input?.id) ? input.id : slugify(name), store),
      name,
      logo: null,
      createdAt: now,
      updatedAt: now,
    },
    "profile",
  );
  store.profiles.push(profile);
  const saved = saveProfileStore(store, env);
  return toPublicProfile(saved.profiles.find((p) => p.id === profile.id), saved);
}

export function updateProfile(id, patch = {}, env = process.env) {
  return withBrandProfileStoreLock(env, () => updateProfileLocked(id, patch, env));
}

function updateProfileLocked(id, patch, env) {
  const store = loadProfileStore(env);
  const current = requireProfile(store, id);
  const next = { ...current };
  const errors = {};

  if (Object.prototype.hasOwnProperty.call(patch ?? {}, "name")) {
    try {
      next.name = validateName(patch.name, store, current.id);
    } catch (err) {
      if (!(err instanceof BrandProfileError)) throw err;
      if (err.status === 409) throw err;
      Object.assign(errors, err.errors || { name: err.message });
    }
  }
  const checked = validateBrandFields(patch, PROFILE_BRAND_FIELDS);
  Object.assign(errors, checked.errors);
  if (Object.keys(errors).length) throwFieldErrors(errors);

  Object.assign(next, checked.values);
  next.updatedAt = nowIso();
  store.profiles = store.profiles.map((p) => (p.id === current.id ? next : p));
  const saved = saveProfileStore(store, env);
  return toPublicProfile(saved.profiles.find((p) => p.id === current.id), saved);
}

export function activateProfile(id, env = process.env) {
  return withBrandProfileStoreLock(env, () => activateProfileLocked(id, env));
}

function activateProfileLocked(id, env) {
  const store = loadProfileStore(env);
  requireProfile(store, id);
  store.activeProfileId = id;
  const saved = saveProfileStore(store, env);
  return toPublicProfile(saved.profiles.find((p) => p.id === id), saved);
}

/**
 * Delete a profile. The last remaining profile cannot be deleted; deleting the
 * active profile activates the first remaining one. Labs that used the profile
 * keep their snapshot and look unchanged.
 */
export function deleteProfile(id, env = process.env) {
  return withBrandProfileStoreLock(env, () => deleteProfileLocked(id, env));
}

function deleteProfileLocked(id, env) {
  const store = loadProfileStore(env);
  const target = requireProfile(store, id);
  if (store.profiles.length <= 1) {
    throw new BrandProfileError("You cannot delete the last brand profile. Edit it or create another profile first.", 409);
  }
  store.profiles = store.profiles.filter((p) => p.id !== target.id);
  if (store.activeProfileId === target.id) {
    store.activeProfileId = (store.profiles.find((p) => p.id === DEFAULT_PROFILE_ID) || store.profiles[0]).id;
  }
  const saved = saveProfileStore(store, env);
  removeLogoIfUnreferenced(target.logo, saved, env);
  return { deletedId: target.id, activeProfileId: saved.activeProfileId };
}

export function duplicateProfile(id, { name } = {}, env = process.env) {
  return withBrandProfileStoreLock(env, () => duplicateProfileLocked(id, name, env));
}

function duplicateProfileLocked(id, name, env) {
  const store = loadProfileStore(env);
  const source = requireProfile(store, id);
  if (store.profiles.length >= MAX_PROFILES) {
    throw new BrandProfileError(`You can create at most ${MAX_PROFILES} brand profiles.`, 409);
  }
  const requested = typeof name === "string" && cleanText(name) ? validateName(name, store) : uniqueProfileName(store, `${source.name} (copy)`);
  const newId = uniqueProfileId(slugify(requested), store);
  let logo = null;
  const sourceLogo = resolveLogoAbsolutePath(source.logo, env);
  if (sourceLogo && existsSync(sourceLogo)) {
    const ext = /\.png$/i.test(sourceLogo) ? ".png" : ".jpg";
    const fileName = buildProfileLogoFileName(newId, ext);
    copyFileSync(sourceLogo, resolve(uploadsDir(env), fileName));
    logo = `/uploads/${fileName}`;
  }
  const now = nowIso();
  const copy = sanitizeStoredProfile({ ...source, id: newId, name: requested, logo, createdAt: now, updatedAt: now }, newId);
  store.profiles.push(copy);
  const saved = saveProfileStore(store, env);
  return toPublicProfile(saved.profiles.find((p) => p.id === newId), saved);
}

/** Attach an already-validated, already-written upload file to a profile. */
export function setProfileLogo(id, fileName, env = process.env) {
  return withBrandProfileStoreLock(env, () => setProfileLogoLocked(id, fileName, env));
}

function setProfileLogoLocked(id, fileName, env) {
  if (!LOGO_NAME_RE.test(String(fileName ?? ""))) {
    throw new BrandProfileError("Invalid logo file name.", 400);
  }
  const store = loadProfileStore(env);
  const current = requireProfile(store, id);
  const previous = current.logo;
  const updated = { ...current, logo: `/uploads/${fileName}`, updatedAt: nowIso() };
  store.profiles = store.profiles.map((p) => (p.id === current.id ? updated : p));
  const saved = saveProfileStore(store, env);
  if (previous && previous !== updated.logo) removeLogoIfUnreferenced(previous, saved, env);
  return toPublicProfile(saved.profiles.find((p) => p.id === current.id), saved);
}

export function clearProfileLogo(id, env = process.env) {
  return withBrandProfileStoreLock(env, () => clearProfileLogoLocked(id, env));
}

function clearProfileLogoLocked(id, env) {
  const store = loadProfileStore(env);
  const current = requireProfile(store, id);
  const previous = current.logo;
  const updated = { ...current, logo: null, updatedAt: nowIso() };
  store.profiles = store.profiles.map((p) => (p.id === current.id ? updated : p));
  const saved = saveProfileStore(store, env);
  removeLogoIfUnreferenced(previous, saved, env);
  return toPublicProfile(saved.profiles.find((p) => p.id === current.id), saved);
}

/** The active profile as a render-ready brand (classic fields plus every extended field). */
export function getActiveBrand(env = process.env) {
  const store = loadProfileStore(env);
  const profile = requireProfile(store, store.activeProfileId);
  return { ...normalizeBrand(profile), profileId: profile.id, profileName: profile.name };
}

/**
 * Apply the classic four fields (used by the legacy single-brand API) to the
 * active profile, persisting through the profile store.
 */
export function updateActiveProfileClassicFields(fields, env = process.env) {
  return withBrandProfileStoreLock(env, () => updateActiveProfileClassicFieldsLocked(fields, env));
}

function updateActiveProfileClassicFieldsLocked(fields, env) {
  const store = loadProfileStore(env);
  const current = requireProfile(store, store.activeProfileId);
  const next = { ...current, ...fields, updatedAt: nowIso() };
  store.profiles = store.profiles.map((p) => (p.id === current.id ? next : p));
  const saved = saveProfileStore(store, env);
  const previous = current.logo;
  if (previous && previous !== next.logo) removeLogoIfUnreferenced(previous, saved, env);
  const active = saved.profiles.find((p) => p.id === saved.activeProfileId);
  return { ...normalizeBrand(active), profileId: active.id, profileName: active.name };
}

// ── Per-lab customization ───────────────────────────────────────────────────

const SNAPSHOT_FIELDS = ["id", "name", ...PROFILE_BRAND_FIELDS, "logo"];

function snapshotOf(profile) {
  const snapshot = {};
  for (const key of SNAPSHOT_FIELDS) snapshot[key] = profile[key] ?? (key === "logo" ? null : "");
  snapshot.snapshotAt = nowIso();
  return snapshot;
}

/**
 * Validate per-lab overrides. Blank values mean "inherit from the profile" and
 * are dropped; unknown keys are ignored.
 *
 * @returns {{ values: Record<string,string>, errors: Record<string,string> }}
 */
export function sanitizeOverrides(input) {
  if (input === undefined || input === null) return { values: {}, errors: {} };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { values: {}, errors: { overrides: "Overrides must be an object." } };
  }
  const { values, errors } = validateBrandFields(input, OVERRIDE_FIELDS);
  const kept = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string" && value) kept[key] = value;
  }
  return { values: kept, errors };
}

/**
 * Build the `manifest.customization` record for a lab: a snapshot of the
 * chosen profile (the active one when `profileId` is omitted) plus overrides.
 */
export function buildCustomization({ profileId, overrides } = {}, env = process.env) {
  const store = loadProfileStore(env);
  const id = profileId === undefined || profileId === null || profileId === "" ? store.activeProfileId : profileId;
  const profile = requireProfile(store, id);
  const { values, errors } = sanitizeOverrides(overrides);
  if (Object.keys(errors).length) throwFieldErrors(errors);
  return {
    version: 1,
    profileId: profile.id,
    profileName: profile.name,
    profileSnapshot: snapshotOf(profile),
    overrides: values,
    updatedAt: nowIso(),
  };
}

/** Per-lab capture settings (addresses and names) stored with the lab's customization. Invalid entries are dropped. */
function sanitizeCaptureTargets(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const checked = validateTargets(input);
  return Object.fromEntries(Object.entries(checked.values).filter(([, value]) => value));
}

/** Read and sanitize `manifest.customization`; returns null when the lab has none. */
export function readCustomization(manifest) {
  const raw = manifest && typeof manifest === "object" ? manifest.customization : null;
  if (!raw || typeof raw !== "object") return null;
  const snapshot = raw.profileSnapshot && typeof raw.profileSnapshot === "object" ? raw.profileSnapshot : null;
  const overrides = sanitizeOverrides(raw.overrides).values;
  const captureTargets = sanitizeCaptureTargets(raw.captureTargets);
  const captureAgentSource = normalizeAgentSource(raw.captureAgentSource);
  return {
    version: 1,
    profileId: isValidProfileId(raw.profileId) ? raw.profileId : snapshot && isValidProfileId(snapshot.id) ? snapshot.id : null,
    profileName: cleanText(raw.profileName || snapshot?.name || ""),
    profileSnapshot: snapshot ? { ...pickProfileBrandFields(normalizeBrand(snapshot)), id: snapshot.id, name: cleanText(snapshot.name), snapshotAt: snapshot.snapshotAt || null } : null,
    overrides,
    ...(Object.keys(captureTargets).length ? { captureTargets } : {}),
    ...(captureAgentSource ? { captureAgentSource } : {}),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
  };
}

function siteFromManifest(manifest) {
  const options = manifest?.options && typeof manifest.options === "object" ? manifest.options : {};
  const request = manifest?.request && typeof manifest.request === "object" ? manifest.request : {};
  const site = manifest?.sharepointSite && typeof manifest.sharepointSite === "object" ? manifest.sharepointSite : {};
  const name = String(options.sharepointSiteName ?? request.sharepointSiteName ?? site.name ?? "");
  const rawUrl = String(options.sharepointSiteUrl ?? request.sharepointSiteUrl ?? site.url ?? "");
  const url = validateHttpsUrl(rawUrl);
  return { name: cleanText(name), url: url.valid ? url.url : "" };
}

/**
 * Resolve the brand a lab renders with:
 * per-lab overrides > lab profile snapshot > active profile > defaults.
 * The lab's own SharePoint site (Step 7) wins over the profile default.
 *
 * @param {object|null} manifest lab manifest (or null for a non-generated lab)
 * @param {{ env?: object, brand?: object }} [options] `brand` replaces the active-profile layer
 */
export function resolveLabBrand(manifest, { env = process.env, brand } = {}) {
  const customization = readCustomization(manifest);
  let base;
  let profileId;
  let profileName;
  if (customization?.profileSnapshot) {
    base = customization.profileSnapshot;
    profileId = customization.profileId;
    profileName = customization.profileName;
  } else if (customization?.profileId && !brand && findProfile(customization.profileId, env)) {
    const live = findProfile(customization.profileId, env);
    base = live;
    profileId = live.id;
    profileName = live.name;
  } else if (brand) {
    base = brand;
    profileId = brand.profileId;
    profileName = brand.profileName;
  } else {
    base = getActiveBrand(env);
    profileId = base.profileId;
    profileName = base.profileName;
  }
  const merged = applyBrandOverrides(base, customization?.overrides);
  const site = siteFromManifest(manifest);
  if (site.name) merged.labSiteName = site.name;
  if (site.url) merged.labSiteUrl = site.url;
  if (profileId) merged.profileId = profileId;
  if (profileName) merged.profileName = profileName;
  return merged;
}

/** Resolve only a customization record (for example from the generate request). */
export function resolveCustomizationBrand(customization, options = {}) {
  return resolveLabBrand({ customization }, options);
}

function readManifestFile(labDir) {
  const file = resolve(labDir, "manifest.json");
  return { file, manifest: JSON.parse(readFileSync(file, "utf-8")) };
}

function mutateManifest(labDir, mutate, { touch = true } = {}) {
  const file = resolve(labDir, "manifest.json");
  // Read, change, and write under the manifest's lock so another process cannot change it in between.
  return withLockedFileSync(file, () => {
    const { manifest } = readManifestFile(labDir);
    mutate(manifest);
    if (touch) manifest.updatedAt = nowIso();
    writeJsonAtomic(file, manifest);
    return manifest;
  });
}

/** Describe a lab's customization for the API and the UI. */
export function describeLabCustomization(labDir, env = process.env) {
  const { manifest } = readManifestFile(labDir);
  const customization = readCustomization(manifest);
  const effective = resolveLabBrand(manifest, { env });
  const liveProfile = customization?.profileId ? findProfile(customization.profileId, env) : null;
  const snapshot = customization?.profileSnapshot || null;
  const drifted = Boolean(
    snapshot &&
      liveProfile &&
      (PROFILE_BRAND_FIELDS.some((key) => String(snapshot[key] ?? "") !== String(liveProfile[key] ?? "")) ||
        (snapshot.logo || null) !== (liveProfile.logo || null)),
  );
  return {
    customized: Boolean(customization),
    profileId: customization?.profileId || null,
    profileName: customization?.profileName || null,
    profileExists: Boolean(liveProfile),
    profileChangedSinceSnapshot: drifted,
    snapshotAt: snapshot?.snapshotAt || null,
    overrides: customization?.overrides || {},
    effective,
    contrast: describeBrandContrast(effective),
    activeProfileId: getActiveProfileId(env),
  };
}

/**
 * Update a lab's customization. Supports switching profile, replacing the
 * overrides, and the explicit `update-from-profile` and `reset` actions.
 *
 * - `update-from-profile`: re-snapshot the lab's profile, keep overrides.
 * - `reset`: re-snapshot the lab's profile and clear all overrides.
 */
export function updateLabCustomization(labDir, patch = {}, env = process.env) {
  const body = patch && typeof patch === "object" ? patch : {};
  const action = body.action === undefined ? null : String(body.action);
  if (action !== null && action !== "update-from-profile" && action !== "reset") {
    throw new BrandProfileError("action must be 'update-from-profile' or 'reset'.", 400);
  }
  const hasProfileId = Object.prototype.hasOwnProperty.call(body, "profileId");
  const hasOverrides = Object.prototype.hasOwnProperty.call(body, "overrides");
  if (!action && !hasProfileId && !hasOverrides) {
    throw new BrandProfileError("Provide profileId, overrides, or an action.", 400);
  }

  const { manifest: current } = readManifestFile(labDir);
  const existing = readCustomization(current);

  let profileId = existing?.profileId || undefined;
  if (hasProfileId) profileId = body.profileId ? String(body.profileId) : undefined;
  let overrides = existing?.overrides || {};
  if (hasOverrides) {
    const checked = sanitizeOverrides(body.overrides);
    if (Object.keys(checked.errors).length) throwFieldErrors(checked.errors);
    overrides = checked.values;
  }
  if (action === "reset") overrides = {};

  // Refreshing from a profile that was deleted cannot succeed silently.
  if (action && !hasProfileId && existing?.profileId && !findProfile(existing.profileId, env)) {
    throw new BrandProfileError("The brand profile this lab used no longer exists. Choose another profile instead.", 404);
  }

  // Changing only the overrides keeps the lab's snapshot; switching profile or an explicit action re-snapshots.
  const keepSnapshot = Boolean(existing?.profileSnapshot) && !action && (!hasProfileId || profileId === existing.profileId);
  const customization = keepSnapshot
    ? { ...existing, version: 1, overrides, updatedAt: nowIso() }
    : { ...buildCustomization({ profileId, overrides }, env), ...(existing?.captureTargets ? { captureTargets: existing.captureTargets } : {}), ...(existing?.captureAgentSource ? { captureAgentSource: existing.captureAgentSource } : {}) };
  const manifest = mutateManifest(labDir, (m) => {
    m.customization = customization;
  });
  return { manifest, customization: describeLabCustomization(labDir, env) };
}

/** Persist a newly built customization onto a freshly generated lab (does not bump `updatedAt`). */
export function writeLabCustomization(labDir, customization) {
  return mutateManifest(
    labDir,
    (m) => {
      m.customization = customization;
    },
    { touch: false },
  );
}

/**
 * Save a lab's own capture settings (where its screenshots are captured). An empty value clears a setting.
 * Only valid settings are stored; invalid ones are reported by field and nothing is written.
 * @returns {{ok: boolean, errors: Record<string, string>, captureTargets: Record<string, string>}}
 */
export function updateLabCaptureTargets(labDir, patch = {}) {
  const checked = validateTargets(patch);
  if (!checked.ok) return { ok: false, errors: checked.errors, captureTargets: {} };
  let saved = {};
  mutateManifest(labDir, (manifest) => {
    const existing = readCustomization(manifest);
    const next = { ...(existing?.captureTargets || {}) };
    for (const [id, value] of Object.entries(checked.values)) {
      if (value) next[id] = value;
      else delete next[id];
    }
    saved = next;
    const base = manifest.customization && typeof manifest.customization === "object" ? manifest.customization : { version: 1, overrides: {} };
    const customization = { ...base, updatedAt: nowIso() };
    if (Object.keys(next).length) customization.captureTargets = next;
    else delete customization.captureTargets;
    manifest.customization = customization;
  });
  return { ok: true, errors: {}, captureTargets: saved };
}

/**
 * Remember which agent a lab's screenshots use: "created" (the practice agent the computer creates first in the capture, the default) or "own"
 * (an agent the person chose). It is a word kept next to the lab's capture settings; no address or id is ever kept here.
 * @returns {{ok: boolean, error?: string, agentSource?: string}}
 */
export function updateLabAgentSource(labDir, source) {
  const value = normalizeAgentSource(source);
  if (!value) return { ok: false, error: 'The agent choice must be "created" or "own".' };
  mutateManifest(labDir, (manifest) => {
    const base = manifest.customization && typeof manifest.customization === "object" ? manifest.customization : { version: 1, overrides: {} };
    manifest.customization = { ...base, captureAgentSource: value, updatedAt: nowIso() };
  });
  return { ok: true, agentSource: value };
}

// ── Capture environment ─────────────────────────────────────────────────────

function looksLikeCustomization(value) {
  return Boolean(value && typeof value === "object" && ("profileSnapshot" in value || ("overrides" in value && !("companyName" in value))));
}

function looksLikeManifest(value) {
  return Boolean(value && typeof value === "object" && (value.customization || value.sharepointSite || Array.isArray(value.modules) || value.slug));
}

/**
 * Map a profile, resolved brand, lab manifest, or `customization` record to the
 * CAPTURE_* environment variables the screenshot capture tool already reads.
 * Only https values are emitted and blanks are omitted. The lab's own
 * SharePoint site wins for CAPTURE_SHAREPOINT_SITE_URL, then the tenant
 * SharePoint site URL, then the profile's default SharePoint site.
 * A lab manifest is read whole, so the lab's own SharePoint site (Step 7) is used even
 * when the lab has no customization.
 *
 * @returns {Record<string, string>}
 */
export function buildCaptureEnv(profileOrCustomization, { env = process.env } = {}) {
  let brand;
  const input = profileOrCustomization;
  if (looksLikeManifest(input)) {
    brand = resolveLabBrand(input, { env });
  } else if (looksLikeCustomization(input)) {
    brand = resolveCustomizationBrand(input, { env });
  } else {
    brand = normalizeBrand(input || {});
  }

  const out = {};
  for (const field of ENVIRONMENT_URL_FIELDS) {
    const value = brand[field];
    if (typeof value === "string" && value && /^https:\/\//i.test(value)) out[CAPTURE_ENV_MAP[field]] = value;
  }
  const site = brand.labSiteUrl || brand.sharepointSiteUrl || brand.defaultSharepointSiteUrl;
  if (site && /^https:\/\//i.test(site)) out[CAPTURE_ENV_MAP.sharepointSiteUrl] = site;
  return out;
}
