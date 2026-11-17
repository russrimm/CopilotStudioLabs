import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync, inflateSync } from "node:zlib";

import {
  BrandProfileError,
  MAX_PROFILES,
  activateProfile,
  buildCaptureEnv,
  buildCustomization,
  clearProfileLogo,
  createProfile,
  deleteProfile,
  describeLabCustomization,
  detectRasterLogoExtension,
  duplicateProfile,
  getActiveProfile,
  listProfiles,
  loadProfileStore,
  readCustomization,
  resolveLabBrand,
  setProfileLogo,
  updateLabCustomization,
  updateProfile,
  writeLabCustomization,
} from "../lib/branding-profiles.js";
import {
  DEFAULT_BRANDING,
  applyBrandingTokens,
  deleteBrandingLogo,
  getBrandingFilePath,
  loadBranding,
  prependBrandingBanner,
  renderBrandingBannerHtml,
  renderLabEmail,
  saveBranding,
  updateBrandingLogo,
} from "../lib/branding.js";
import {
  BRAND_FONT_IDS,
  describeBrandContrast,
  renderBrandInfoMarkdown,
  validateHttpsUrl,
} from "../lib/lab-builder/brand-theme.js";
import { renderStandaloneLabHtml } from "../lib/lab-builder/html-lab.js";
import { renderMarkdownToDocxBuffer } from "../lib/lab-builder/docx-builder.js";
import { renderMarkdownToPdfBuffer } from "../lib/lab-builder/pdf-builder.js";
import { renderMarkdownToPptxBuffer } from "../lib/lab-builder/pptx-builder.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import {
  exportGeneratedLab,
  isCustomBranding,
  renderGeneratedLabDocx,
  renderGeneratedLabFacilitatorHtml,
  renderGeneratedLabFacilitatorMarkdown,
  renderGeneratedLabHtml,
  renderGeneratedLabMarkdown,
  renderGeneratedLabPdf,
  renderGeneratedLabPptx,
} from "../lib/exporter.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function tempRoot(t, prefix = "brand-profiles-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeEnv(t) {
  const root = tempRoot(t);
  return {
    PORTAL_DATA_DIR: join(root, "data"),
    PORTAL_UPLOADS_DIR: join(root, "uploads"),
    LAB_BUILDER_OUTPUT_DIR: join(root, "labs"),
  };
}

/** Point process-wide storage at a temp area so renderers that default to process.env stay hermetic. */
function useProcessEnv(t, env) {
  const saved = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    process.env[key] = env[key];
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function readZipFiles(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.notEqual(eocd, -1, "expected a ZIP end-of-central-directory record");
  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < total; i += 1) {
    const method = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + compSize);
    files.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function pdfText(buffer) {
  const latin = buffer.toString("latin1");
  const parts = [];
  for (const match of latin.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      parts.push(inflateSync(Buffer.from(match[1], "latin1")).toString("latin1"));
    } catch {
      // Binary image streams are not text.
    }
  }
  return parts.join("\n");
}

function collectStream(fn) {
  return new Promise((resolve, reject) => {
    const out = new PassThrough();
    const chunks = [];
    out.on("data", (chunk) => chunks.push(chunk));
    out.on("end", () => resolve(Buffer.concat(chunks)));
    out.on("error", reject);
    Promise.resolve(fn(out)).catch(reject);
  });
}

const FULL_PROFILE = {
  name: "Contoso",
  companyName: "Contoso Ltd",
  tagline: "AI Academy",
  primaryColor: "#0b3d91",
  secondaryColor: "#c2410c",
  font: "georgia",
  coverSubtitle: "Spring cohort",
  footerText: "Contoso Internal Training",
  moreInfoLabel: "Contoso AI portal",
  moreInfoUrl: "https://learn.contoso.com/ai",
  supportName: "Ada Lovelace",
  supportEmail: "ai-help@contoso.com",
  communityUrl: "https://teams.microsoft.com/l/team/contoso-ai",
  defaultSharepointSiteName: "Contoso AI Hub",
  defaultSharepointSiteUrl: "https://contoso.sharepoint.com/sites/AIHub",
  copilotStudioUrl: "https://copilotstudio.microsoft.com/environments/contoso",
  powerPlatformEnvUrl: "https://make.powerapps.com/environments/contoso",
  sharepointSiteUrl: "https://contoso.sharepoint.com/sites/Labs",
  sharepointAdminUrl: "https://contoso-admin.sharepoint.com",
  m365AdminUrl: "https://admin.microsoft.com",
  foundryProjectUrl: "https://ai.azure.com/projects/contoso",
};

// ── Migration and backward compatibility ────────────────────────────────────

test("a legacy branding.json is migrated once into the default profile and keeps working", (t) => {
  const env = makeEnv(t);
  mkdirSync(env.PORTAL_DATA_DIR, { recursive: true });
  writeFileSync(
    getBrandingFilePath(env),
    JSON.stringify({ companyName: "Legacy Co", tagline: "Old tagline", primaryColor: "#0f6cbd", logo: "/uploads/logo-1.png" }),
  );

  const brand = loadBranding(env);
  assert.equal(brand.companyName, "Legacy Co");
  assert.equal(brand.tagline, "Old tagline");
  assert.equal(brand.primaryColor, "#0f6cbd");
  assert.equal(brand.logo, "/uploads/logo-1.png");

  const listed = listProfiles(env);
  assert.equal(listed.profiles.length, 1);
  assert.equal(listed.activeProfileId, "default");
  assert.equal(listed.profiles[0].companyName, "Legacy Co");
  assert.equal(existsSync(join(env.PORTAL_DATA_DIR, "brand-profiles.json")), true, "profiles live under the portal data dir");

  // The migration is one-time: later edits to the legacy file do not overwrite the profile.
  writeFileSync(getBrandingFilePath(env), JSON.stringify({ companyName: "Changed Later" }));
  assert.equal(loadBranding(env).companyName, "Legacy Co");
});

test("with no saved branding, loadBranding returns the classic defaults without writing a profile store", (t) => {
  const env = makeEnv(t);
  const brand = loadBranding(env);
  for (const [key, value] of Object.entries(DEFAULT_BRANDING)) assert.equal(brand[key], value);
  assert.equal(existsSync(join(env.PORTAL_DATA_DIR, "brand-profiles.json")), false);
  assert.equal(isCustomBranding(brand), false);
});

test("saveBranding, updateBrandingLogo, and deleteBrandingLogo operate on the active profile and mirror branding.json", (t) => {
  const env = makeEnv(t);
  createProfile({ name: "Second", companyName: "Second Co" }, env);
  const saved = saveBranding({ companyName: "Active Co", primaryColor: "#107c41", tagline: "Hello" }, env);
  assert.equal(saved.companyName, "Active Co");
  assert.equal(getActiveProfile(env).companyName, "Active Co");
  assert.equal(listProfiles(env).profiles.find((p) => p.id === "second").companyName, "Second Co");

  const mirrored = JSON.parse(readFileSync(getBrandingFilePath(env), "utf8"));
  assert.deepEqual(Object.keys(mirrored).sort(), ["companyName", "logo", "primaryColor", "tagline"]);
  assert.equal(mirrored.companyName, "Active Co");

  writeFileSync(join(env.PORTAL_UPLOADS_DIR, "logo-test.png"), ONE_PIXEL_PNG);
  assert.equal(updateBrandingLogo("logo-test.png", env).logo, "/uploads/logo-test.png");
  assert.equal(deleteBrandingLogo(env).logo, null);
  assert.equal(existsSync(join(env.PORTAL_UPLOADS_DIR, "logo-test.png")), false);
});

// ── CRUD and validation ─────────────────────────────────────────────────────

test("profiles support create, read, update, duplicate, activate, and safe delete", (t) => {
  const env = makeEnv(t);
  const created = createProfile(FULL_PROFILE, env);
  assert.equal(created.id, "contoso");
  assert.equal(created.secondaryColor, "#c2410c");
  assert.equal(created.font, "georgia");
  assert.equal(created.isActive, false);

  const updated = updateProfile("contoso", { tagline: "New tagline", footerText: "" }, env);
  assert.equal(updated.tagline, "New tagline");
  assert.equal(updated.footerText, "");
  assert.equal(updated.moreInfoUrl, FULL_PROFILE.moreInfoUrl, "unspecified fields are untouched");

  const copy = duplicateProfile("contoso", {}, env);
  assert.equal(copy.name, "Contoso (copy)");
  assert.notEqual(copy.id, "contoso");

  assert.equal(activateProfile("contoso", env).isActive, true);
  assert.equal(listProfiles(env).activeProfileId, "contoso");

  // Deleting the active profile activates another one.
  const result = deleteProfile("contoso", env);
  assert.equal(result.deletedId, "contoso");
  assert.notEqual(result.activeProfileId, "contoso");
  assert.equal(listProfiles(env).profiles.some((p) => p.id === "contoso"), false);

  // The last profile can never be deleted.
  const store = loadProfileStore(env);
  for (const profile of store.profiles.slice(1)) deleteProfile(profile.id, env);
  assert.throws(() => deleteProfile(loadProfileStore(env).profiles[0].id, env), (err) => err instanceof BrandProfileError && err.status === 409);
  assert.equal(loadProfileStore(env).profiles.length, 1);
});

test("profile validation rejects unsafe URLs, bad colors, unknown fonts, long text, and duplicate names", (t) => {
  const env = makeEnv(t);
  const reject = (input, field, status = 400) =>
    assert.throws(
      () => createProfile({ name: `P ${Math.random()}`, ...input }, env),
      (err) => err instanceof BrandProfileError && err.status === status && (!field || field in (err.errors || {})),
      `expected ${field} to be rejected`,
    );

  reject({ moreInfoUrl: "javascript:alert(1)" }, "moreInfoUrl");
  reject({ moreInfoUrl: "data:text/html,<script>alert(1)</script>" }, "moreInfoUrl");
  reject({ moreInfoUrl: "http://insecure.example.com" }, "moreInfoUrl");
  reject({ communityUrl: "//evil.example.com" }, "communityUrl");
  reject({ foundryProjectUrl: "https://user:pass@ai.azure.com" }, "foundryProjectUrl");
  reject({ copilotStudioUrl: "ftp://files.example.com" }, "copilotStudioUrl");
  reject({ primaryColor: "blue" }, "primaryColor");
  reject({ secondaryColor: "#12" }, "secondaryColor");
  reject({ font: "comic-sans-injection" }, "font");
  reject({ supportEmail: "not-an-email" }, "supportEmail");
  reject({ footerText: "x".repeat(201) }, "footerText");
  reject({ companyName: "   " }, "companyName");

  const ok = createProfile({ name: "Valid", moreInfoUrl: "learn.contoso.com/help", primaryColor: "#ABC" }, env);
  assert.equal(ok.moreInfoUrl, "https://learn.contoso.com/help", "bare domains are normalized to https");
  assert.equal(ok.primaryColor, "#aabbcc");
  assert.throws(() => createProfile({ name: "valid" }, env), (err) => err.status === 409);
  assert.ok(BRAND_FONT_IDS.includes("georgia"));
  assert.equal(validateHttpsUrl("https://ok.example.com/a b").valid, false);
  assert.ok(MAX_PROFILES >= 10);
});

test("plain-text fields drop angle brackets and control characters", (t) => {
  const env = makeEnv(t);
  const profile = createProfile({ name: "Texty", companyName: "<img src=x onerror=alert(1)>Acme\u0007\nCorp", footerText: "<b>bold</b>" }, env);
  assert.doesNotMatch(profile.companyName, /[<>\u0007\n]/);
  assert.doesNotMatch(profile.footerText, /[<>]/);
});

test("contrast ratios and warnings are computed against white and dark backgrounds", () => {
  const light = describeBrandContrast({ primaryColor: "#ffff00", secondaryColor: "#0b3d91" });
  assert.ok(light.primary.onWhite < 2, "yellow on white is low contrast");
  assert.equal(light.primary.aaOnWhite, false);
  assert.equal(light.primary.aaOnDark, true);
  assert.ok(light.warnings.some((w) => /Primary color #ffff00/.test(w) && /white/.test(w)));
  assert.equal(light.secondary.aaOnWhite, true);

  const strong = describeBrandContrast({ primaryColor: "#0b3d91" });
  assert.equal(strong.primary.aaOnWhite, true);
  assert.ok(strong.warnings.some((w) => /dark backgrounds/.test(w)));
});

// ── Logos ───────────────────────────────────────────────────────────────────

test("logo helpers only accept PNG and JPEG content and keep logos that labs still reference", async (t) => {
  const env = makeEnv(t);
  assert.equal(detectRasterLogoExtension(ONE_PIXEL_PNG), ".png");
  assert.equal(detectRasterLogoExtension(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])), ".jpg");
  assert.equal(detectRasterLogoExtension(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(detectRasterLogoExtension(Buffer.from("not an image at all")), null);

  createProfile({ name: "Logo Co" }, env);
  assert.throws(() => setProfileLogo("logo-co", "../evil.png", env), BrandProfileError);
  assert.throws(() => setProfileLogo("logo-co", "logo.svg", env), BrandProfileError);

  mkdirSync(env.PORTAL_UPLOADS_DIR, { recursive: true });
  writeFileSync(join(env.PORTAL_UPLOADS_DIR, "logo-logo-co-1.png"), ONE_PIXEL_PNG);
  const withLogo = setProfileLogo("logo-co", "logo-logo-co-1.png", env);
  assert.equal(withLogo.logo, "/uploads/logo-logo-co-1.png");

  // A copy owns its own file, so deleting one profile's logo never breaks the other.
  const copy = duplicateProfile("logo-co", { name: "Logo Copy" }, env);
  assert.notEqual(copy.logo, withLogo.logo);
  assert.equal(existsSync(join(env.PORTAL_UPLOADS_DIR, copy.logo.replace("/uploads/", ""))), true);

  // A lab snapshot that references the logo keeps the file alive after the profile drops it.
  const labDir = join(env.LAB_BUILDER_OUTPUT_DIR, "snap-lab");
  mkdirSync(labDir, { recursive: true });
  writeFileSync(join(labDir, "manifest.json"), JSON.stringify({ title: "Snap" }));
  writeLabCustomization(labDir, buildCustomization({ profileId: "logo-co" }, env));
  clearProfileLogo("logo-co", env);
  assert.equal(existsSync(join(env.PORTAL_UPLOADS_DIR, "logo-logo-co-1.png")), true, "referenced by a lab snapshot");
  assert.equal(clearProfileLogo("logo-copy", env).logo, null);
  assert.equal(existsSync(join(env.PORTAL_UPLOADS_DIR, copy.logo.replace("/uploads/", ""))), false, "unreferenced files are removed");
});

// ── Resolution order and per-lab overrides ──────────────────────────────────

test("resolution order is per-lab overrides, then lab snapshot, then active profile, then defaults", (t) => {
  const env = makeEnv(t);
  createProfile({ name: "Alpha", companyName: "Alpha Co", tagline: "Alpha tagline", footerText: "Alpha footer" }, env);
  createProfile({ name: "Beta", companyName: "Beta Co", tagline: "Beta tagline" }, env);
  activateProfile("beta", env);

  // No customization: the active profile applies, and unset fields fall back to defaults.
  const noCustom = resolveLabBrand({ title: "Plain" }, { env });
  assert.equal(noCustom.companyName, "Beta Co");
  assert.equal(noCustom.footerText, "");
  assert.equal(noCustom.primaryColor, DEFAULT_BRANDING.primaryColor);

  // A snapshot of Alpha wins over the active profile (Beta), and overrides win over the snapshot.
  const customization = buildCustomization({ profileId: "alpha", overrides: { tagline: "Lab-only tagline", moreInfoUrl: "https://example.com/lab" } }, env);
  const manifest = { customization };
  const resolved = resolveLabBrand(manifest, { env });
  assert.equal(resolved.companyName, "Alpha Co");
  assert.equal(resolved.footerText, "Alpha footer");
  assert.equal(resolved.tagline, "Lab-only tagline");
  assert.equal(resolved.moreInfoUrl, "https://example.com/lab");

  // The snapshot keeps the lab's look even when the profile changes or is deleted later.
  updateProfile("alpha", { companyName: "Alpha Renamed", footerText: "Changed" }, env);
  assert.equal(resolveLabBrand(manifest, { env }).companyName, "Alpha Co");
  deleteProfile("alpha", env);
  assert.equal(resolveLabBrand(manifest, { env }).companyName, "Alpha Co");

  // The lab's own SharePoint site (Step 7) beats the profile default.
  createProfile({ name: "Site", defaultSharepointSiteName: "Default Site", defaultSharepointSiteUrl: "https://contoso.sharepoint.com/sites/Default" }, env);
  const siteManifest = { customization: buildCustomization({ profileId: "site" }, env), options: { sharepointSiteName: "Lab Site", sharepointSiteUrl: "https://contoso.sharepoint.com/sites/Lab" } };
  const siteBrand = resolveLabBrand(siteManifest, { env });
  assert.equal(siteBrand.defaultSharepointSiteName, "Default Site");
  assert.equal(siteBrand.labSiteName, "Lab Site");
  assert.equal(applyBrandingTokens("{{SHAREPOINT_SITE_NAME}} {{SHAREPOINT_SITE_URL}}", siteBrand), "Lab Site https://contoso.sharepoint.com/sites/Lab");

  // An explicit brand (for example from a test or the CLI) replaces only the active-profile layer.
  assert.equal(resolveLabBrand({ title: "x" }, { env, brand: { companyName: "Explicit", primaryColor: "#123456" } }).companyName, "Explicit");
});

test("lab customization persists in the manifest and supports switching, overrides, update-from-profile, and reset", (t) => {
  const env = makeEnv(t);
  createProfile({ name: "One", companyName: "One Co", tagline: "First" }, env);
  createProfile({ name: "Two", companyName: "Two Co" }, env);
  const labDir = join(env.LAB_BUILDER_OUTPUT_DIR, "lab-a");
  mkdirSync(labDir, { recursive: true });
  writeFileSync(join(labDir, "manifest.json"), JSON.stringify({ title: "Lab A" }));

  assert.equal(describeLabCustomization(labDir, env).customized, false);

  let result = updateLabCustomization(labDir, { profileId: "one", overrides: { tagline: "Only here", supportEmail: "help@one.example.com" } }, env);
  assert.equal(result.customization.customized, true);
  assert.equal(result.customization.effective.tagline, "Only here");
  let manifest = JSON.parse(readFileSync(join(labDir, "manifest.json"), "utf8"));
  assert.equal(manifest.customization.profileId, "one");
  assert.equal(manifest.customization.profileSnapshot.companyName, "One Co");
  assert.deepEqual(manifest.customization.overrides, { tagline: "Only here", supportEmail: "help@one.example.com" });

  // Editing the profile does not touch the lab until "Update from profile" is requested.
  updateProfile("one", { companyName: "One Renamed", tagline: "Profile tagline" }, env);
  let described = describeLabCustomization(labDir, env);
  assert.equal(described.effective.companyName, "One Co");
  assert.equal(described.profileChangedSinceSnapshot, true);

  result = updateLabCustomization(labDir, { action: "update-from-profile" }, env);
  assert.equal(result.customization.effective.companyName, "One Renamed");
  assert.equal(result.customization.effective.tagline, "Only here", "overrides survive an update");
  assert.equal(result.customization.profileChangedSinceSnapshot, false);

  result = updateLabCustomization(labDir, { action: "reset" }, env);
  assert.deepEqual(result.customization.overrides, {});
  assert.equal(result.customization.effective.tagline, "Profile tagline");

  result = updateLabCustomization(labDir, { profileId: "two" }, env);
  assert.equal(result.customization.profileId, "two");
  assert.equal(result.customization.effective.companyName, "Two Co");

  assert.throws(() => updateLabCustomization(labDir, { overrides: { moreInfoUrl: "javascript:alert(1)" } }, env), BrandProfileError);
  assert.throws(() => updateLabCustomization(labDir, { profileId: "missing" }, env), (err) => err.status === 404);
  assert.throws(() => updateLabCustomization(labDir, {}, env), BrandProfileError);
  assert.throws(() => updateLabCustomization(labDir, { action: "explode" }, env), BrandProfileError);

  deleteProfile("two", env);
  assert.throws(() => updateLabCustomization(labDir, { action: "update-from-profile" }, env), (err) => err.status === 404);
  manifest = JSON.parse(readFileSync(join(labDir, "manifest.json"), "utf8"));
  assert.equal(readCustomization(manifest).profileSnapshot.companyName, "Two Co", "the snapshot survives profile deletion");
});

// ── Capture environment ─────────────────────────────────────────────────────

test("buildCaptureEnv maps https environment URLs to the CAPTURE_* variables and omits blanks", (t) => {
  const env = makeEnv(t);
  const captured = buildCaptureEnv(FULL_PROFILE);
  assert.deepEqual(captured, {
    CAPTURE_COPILOT_STUDIO_START_URL: FULL_PROFILE.copilotStudioUrl,
    CAPTURE_POWER_PLATFORM_START_URL: FULL_PROFILE.powerPlatformEnvUrl,
    CAPTURE_SHAREPOINT_SITE_URL: FULL_PROFILE.sharepointSiteUrl,
    CAPTURE_SHAREPOINT_ADMIN_URL: FULL_PROFILE.sharepointAdminUrl,
    CAPTURE_M365_ADMIN_URL: FULL_PROFILE.m365AdminUrl,
    CAPTURE_FOUNDRY_PROJECT_URL: FULL_PROFILE.foundryProjectUrl,
  });

  assert.deepEqual(buildCaptureEnv({ copilotStudioUrl: "http://insecure.example.com", m365AdminUrl: "javascript:alert(1)" }), {});
  assert.deepEqual(buildCaptureEnv({ defaultSharepointSiteUrl: "https://contoso.sharepoint.com/sites/Only" }), {
    CAPTURE_SHAREPOINT_SITE_URL: "https://contoso.sharepoint.com/sites/Only",
  });
  assert.deepEqual(buildCaptureEnv(null), {});

  // A lab customization (or manifest) resolves snapshot and overrides first; the lab's own site wins.
  createProfile(FULL_PROFILE, env);
  const customization = buildCustomization({ profileId: "contoso", overrides: { defaultSharepointSiteUrl: "https://contoso.sharepoint.com/sites/Override" } }, env);
  const fromCustomization = buildCaptureEnv(customization, { env });
  assert.equal(fromCustomization.CAPTURE_SHAREPOINT_SITE_URL, FULL_PROFILE.sharepointSiteUrl);
  const fromManifest = buildCaptureEnv({ customization, options: { sharepointSiteUrl: "https://contoso.sharepoint.com/sites/LabSite" } }, { env });
  assert.equal(fromManifest.CAPTURE_SHAREPOINT_SITE_URL, "https://contoso.sharepoint.com/sites/LabSite");
  assert.equal(fromManifest.CAPTURE_FOUNDRY_PROJECT_URL, FULL_PROFILE.foundryProjectUrl);
});

// ── Tokens, banner, and escaping ────────────────────────────────────────────

test("brand tokens render values, collapse empty links, and never leave raw braces for known tokens", () => {
  const brand = { ...FULL_PROFILE, logo: null };
  const out = applyBrandingTokens(
    [
      "{{COMPANY_NAME}}|{{TAGLINE}}|{{PRIMARY_COLOR}}|{{SECONDARY_COLOR}}|{{COVER_SUBTITLE}}",
      "[{{MORE_INFO_LABEL}}]({{MORE_INFO_URL}})",
      "{{SUPPORT_NAME}} <{{SUPPORT_EMAIL}}>",
      "{{FOOTER_TEXT}}|{{COMMUNITY_URL}}|{{SHAREPOINT_SITE_URL}}|{{SHAREPOINT_SITE_NAME}}",
      "{{TENANT_COPILOT_STUDIO_URL}}|{{TENANT_POWER_PLATFORM_URL}}|{{TENANT_SHAREPOINT_ADMIN_URL}}|{{TENANT_M365_ADMIN_URL}}|{{TENANT_FOUNDRY_PROJECT_URL}}",
    ].join("\n"),
    brand,
  );
  assert.match(out, /Contoso Ltd\|AI Academy\|#0b3d91\|#c2410c\|Spring cohort/);
  assert.match(out, /\[Contoso AI portal\]\(https:\/\/learn\.contoso\.com\/ai\)/);
  assert.match(out, /Ada Lovelace <ai-help@contoso\.com>/);
  assert.match(out, /Contoso Internal Training\|https:\/\/teams\.microsoft\.com\/l\/team\/contoso-ai\|https:\/\/contoso\.sharepoint\.com\/sites\/AIHub\|Contoso AI Hub/);
  assert.match(out, /https:\/\/copilotstudio\.microsoft\.com\/environments\/contoso\|https:\/\/make\.powerapps\.com\/environments\/contoso\|https:\/\/contoso-admin\.sharepoint\.com\|https:\/\/admin\.microsoft\.com\|https:\/\/ai\.azure\.com\/projects\/contoso/);
  assert.doesNotMatch(out, /\{\{/);

  const empty = applyBrandingTokens("See [{{MORE_INFO_LABEL}}]({{MORE_INFO_URL}}) or <{{COMMUNITY_URL}}>. {{SUPPORT_EMAIL}}{{FOOTER_TEXT}}{{TENANT_FOUNDRY_PROJECT_URL}}", { ...DEFAULT_BRANDING });
  assert.doesNotMatch(empty, /\{\{|\]\(\)|<>/);
  assert.match(empty, /^See\s+or\s*\./);

  assert.equal(applyBrandingTokens("keep {{SOMETHING_ELSE}} here", DEFAULT_BRANDING), "keep {{SOMETHING_ELSE}} here", "unrelated placeholders are untouched");
  assert.equal(applyBrandingTokens("{{COMPANY_NAME}}", { companyName: "" }), DEFAULT_BRANDING.companyName);
});

test("banner, info blocks, and email escape every brand value and drop unsafe URLs", () => {
  const hostile = {
    companyName: '<script>alert("x")</script>',
    tagline: "<img src=x onerror=alert(1)>",
    primaryColor: "#0b3d91\" onmouseover=\"alert(1)",
    coverSubtitle: "</div><script>1</script>",
    footerText: "<b>footer</b>",
    moreInfoUrl: "javascript:alert(1)",
    communityUrl: "data:text/html,<script>1</script>",
    supportName: "<i>Name</i>",
    supportEmail: 'bad"@example.com',
  };
  const banner = renderBrandingBannerHtml(hostile, "/uploads/logo-x.png");
  assert.doesNotMatch(banner, /<script|<img src=x|\sonmouseover=/i);
  assert.match(banner, /lab-branding-banner/);

  const info = renderBrandInfoMarkdown(hostile);
  assert.doesNotMatch(info, /javascript:|data:|<script|<b>|<i>/i);

  const html = renderStandaloneLabHtml("# Title\n\nBody", { branding: { ...hostile, logoUrl: 'x" onerror="alert(1)' } });
  assert.doesNotMatch(html, /<script>alert|onerror="alert|<b>footer|<img src=x/i);

  const email = renderLabEmail({ labCount: 1, labListHtml: "<li>Lab</li>" }, { ...FULL_PROFILE, companyName: "A & B <Co>" });
  assert.match(email.subject, /A & B Co/);
  assert.match(email.html, /A &amp; B Co/);
  assert.match(email.html, /ai-help@contoso\.com/);
  assert.match(email.html, /Contoso Internal Training/);
});

// ── Renderers ───────────────────────────────────────────────────────────────

let labRoot;
let builtLab;

before(async () => {
  labRoot = mkdtempSync(join(tmpdir(), "brand-profiles-lab-"));
  builtLab = await generateLab(
    {
      product: "copilot-studio",
      features: ["create-agent"],
      level: 100,
      harness: "standard",
      industry: "healthcare",
      title: "Brand Profile Lab",
      agentName: "Clinical Intake Assistant",
    },
    { outputRoot: labRoot, useLearnMcp: false, useLlm: false },
  );
});

after(() => {
  if (labRoot) rmSync(labRoot, { recursive: true, force: true });
});

function customizedLab(t, overrides = {}) {
  const env = makeEnv(t);
  useProcessEnv(t, env);
  createProfile(FULL_PROFILE, env);
  const customization = buildCustomization({ profileId: "contoso", overrides }, env);
  const manifestPath = join(builtLab.outputDir, "manifest.json");
  const original = readFileSync(manifestPath, "utf8");
  t.after(() => writeFileSync(manifestPath, original));
  writeLabCustomization(builtLab.outputDir, customization);
  return env;
}

test("a lab customization applies to Markdown, HTML, DOCX, PDF, and PPTX output", (t) => {
  customizedLab(t, { tagline: "Spring cohort tagline" });
  const id = builtLab.labId;

  const md = renderGeneratedLabMarkdown(labRoot, id).markdown;
  assert.match(md, /lab-branding-banner/);
  assert.match(md, /Contoso Ltd/);
  assert.match(md, /Spring cohort tagline/, "per-lab override beats the profile value");
  assert.match(md, /### More information/);
  assert.match(md, /\[Contoso AI portal\]\(https:\/\/learn\.contoso\.com\/ai\)/);
  assert.match(md, /### Need help\?/);
  assert.match(md, /\[ai-help@contoso\.com\]\(mailto:ai-help@contoso\.com\)/);
  assert.match(md, /Contoso Internal Training/);

  const html = renderGeneratedLabHtml(labRoot, id).html;
  assert.match(html, /<strong>Contoso Ltd<\/strong>/);
  assert.match(html, /--brand-secondary:/);
  assert.match(html, /font-family: Georgia/);
  assert.match(html, /class="lab-brand-footer"[^>]*><p>Contoso Internal Training<\/p>/);
  assert.match(html, /Need help\?/);

  const docx = readZipFiles(renderGeneratedLabDocx(labRoot, id).buffer);
  const docXml = docx.get("word/document.xml").toString("utf8");
  assert.match(docXml, /Contoso Ltd/);
  assert.match(docXml, /Spring cohort/);
  assert.match(docXml, /Need help\?/);
  assert.match(docx.get("word/styles.xml").toString("utf8"), /w:ascii="Georgia"/);
  assert.match(docx.get("word/styles.xml").toString("utf8"), /C2410C/i, "secondary color is used in heading styles");
  assert.match(docx.get("word/footer1.xml").toString("utf8"), /Contoso Internal Training/);
  assert.match(docx.get("[Content_Types].xml").toString("utf8"), /footer1\.xml/);

  const pdf = renderGeneratedLabPdf(labRoot, id).buffer;
  assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.match(pdf.toString("latin1"), /Times-Roman/);
  const text = pdfText(pdf);
  assert.match(text, /Contoso Ltd/);
  assert.match(text, /Contoso Internal Training/);
  assert.match(text, /0\.761 0\.255 0\.047 rg/, "secondary stripe color is drawn");

  const pptx = readZipFiles(renderGeneratedLabPptx(labRoot, id).buffer);
  const slides = [...pptx.entries()].filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).map(([, data]) => data.toString("utf8"));
  assert.ok(slides.length > 3);
  const allSlides = slides.join("\n");
  assert.match(allSlides, /CONTOSO LTD/);
  assert.match(allSlides, /Spring cohort/);
  assert.match(allSlides, /Contoso Internal Training/);
  assert.match(allSlides, /More information and support/);
  assert.match(allSlides, /typeface="Georgia"/);
  assert.match(pptx.get("ppt/theme/theme1.xml").toString("utf8"), /<a:accent2><a:srgbClr val="C2410C"\/>/);
});

test("the facilitator guide, ZIP bundle README, and manifests carry the lab's customization", async (t) => {
  customizedLab(t);
  const id = builtLab.labId;

  const facMd = renderGeneratedLabFacilitatorMarkdown(labRoot, id).markdown;
  assert.match(facMd, /Contoso Ltd/);
  assert.match(facMd, /Need help\?/);
  const facHtml = renderGeneratedLabFacilitatorHtml(labRoot, id).html;
  assert.match(facHtml, /Contoso Ltd/);
  assert.match(facHtml, /--accent2:/);
  assert.match(facHtml, /Contoso Internal Training/);
  assert.match(facHtml, /ai-help@contoso\.com/);

  const zip = await collectStream((out) => exportGeneratedLab(labRoot, id, {}, out, { formats: ["docx", "html"] }));
  const files = readZipFiles(zip);
  const readme = files.get("README.md").toString("utf8");
  assert.match(readme, /Contoso Ltd/);
  assert.match(readme, /Contoso AI portal: https:\/\/learn\.contoso\.com\/ai/);
  assert.match(readme, /ai-help@contoso\.com/);
  assert.match(readme, /Contoso Internal Training/);
  assert.match(readme, /Contoso AI Hub/);

  const manifest = JSON.parse(files.get("export-manifest.json").toString("utf8"));
  assert.equal(manifest.branding.profileId, "contoso");
  assert.equal(manifest.branding.secondaryColor, "#c2410c");
  assert.equal(manifest.customized, true);
  assert.equal(JSON.stringify(manifest).includes("ai-help@contoso.com"), false, "contact details stay out of the manifest");

  const index = files.get(`${id}/index.md`).toString("utf8");
  assert.match(index, /### Need help\?/);
  const indexHtml = files.get(`${id}/index.html`).toString("utf8");
  assert.match(indexHtml, /Contoso Internal Training/);
  const moduleDocs = [...files.keys()].filter((name) => /\.(docx|html)$/.test(name) && !name.includes("Facilitator Guide") && name !== `${id}/index.html`);
  assert.ok(moduleDocs.length >= 2);
  assert.match(files.get(moduleDocs.find((name) => name.endsWith(".html"))).toString("utf8"), /Contoso Internal Training/);
});

test("labs without a customization follow the active profile, and unbranded labs stay unbranded", (t) => {
  const env = makeEnv(t);
  useProcessEnv(t, env);
  const manifestPath = join(builtLab.outputDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.customization, undefined);

  const plain = renderGeneratedLabMarkdown(labRoot, builtLab.labId).markdown;
  assert.doesNotMatch(plain, /lab-branding-banner|More information|Need help/);

  createProfile({ name: "Live", companyName: "Live Co", tagline: "Follows the active profile" }, env);
  activateProfile("live", env);
  assert.match(renderGeneratedLabMarkdown(labRoot, builtLab.labId).markdown, /Live Co/);
  assert.deepEqual(buildCaptureEnv(readCustomization({})), {}, "a lab without customization maps to nothing");
});

test("DOCX, PDF, and PPTX builders still work with the classic branding shape", () => {
  const classic = { companyName: "Classic Co", tagline: "Classic", primaryColor: "#107c41" };
  const md = "# Lab\n\n## Step 1\n\nDo the thing.\n";
  assert.ok(readZipFiles(renderMarkdownToDocxBuffer(md, { branding: classic })).has("word/document.xml"));
  assert.equal(readZipFiles(renderMarkdownToDocxBuffer(md, { branding: classic })).has("word/footer1.xml"), false);
  assert.equal(renderMarkdownToPdfBuffer(md, { branding: classic }).subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(readZipFiles(renderMarkdownToPptxBuffer(md, { branding: classic })).has("ppt/presentation.xml"));
  assert.match(prependBrandingBanner("# T", classic), /Classic Co/);
});

// ── HTTP API ────────────────────────────────────────────────────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function bootServer(t, extraEnv = {}) {
  const root = tempRoot(t, "brand-profiles-http-");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      PORTAL_AUTH_DISABLED: "true",
      AZURE_KEYVAULT_URL: "",
      PORTAL_DATA_DIR: join(root, "data"),
      PORTAL_UPLOADS_DIR: join(root, "uploads"),
      LAB_BUILDER_OUTPUT_DIR: join(root, "labs"),
      LAB_BUILDER_LINK_CHECK: "off",
      LAB_BUILDER_VENDOR_DOCS: "off",
      LAB_BUILDER_LLM: "off",
      ...extraEnv,
    },
    stdio: "ignore",
  });
  t.after(() => child.kill());
  const deadline = Date.now() + 25000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${child.exitCode}`);
    try {
      if ((await fetch(`${base}/api/config`)).ok) break;
    } catch {
      // retry
    }
    if (Date.now() > deadline) throw new Error("server did not start in time");
    await new Promise((r) => setTimeout(r, 150));
  }
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Non-JSON error page.
    }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { base, root, call };
}

test("the profile API supports CRUD, activation, duplication, logos, and keeps /api/branding working", async (t) => {
  const { base, call } = await bootServer(t);

  const initial = await call("GET", "/api/branding/profiles");
  assert.equal(initial.status, 200);
  assert.equal(initial.json.profiles.length, 1);
  assert.equal(initial.json.activeProfileId, "default");
  assert.ok(initial.json.fonts.some((f) => f.id === "georgia"));

  const legacy = await call("GET", "/api/branding");
  assert.equal(legacy.status, 200);
  assert.equal(legacy.json.companyName, DEFAULT_BRANDING.companyName);
  assert.equal((await call("POST", "/api/branding", { companyName: "" })).status, 400);
  const legacySaved = await call("POST", "/api/branding", { companyName: "Legacy API Co", primaryColor: "#107c41", tagline: "Via legacy route" });
  assert.equal(legacySaved.status, 200);
  assert.equal(legacySaved.json.companyName, "Legacy API Co");
  assert.equal((await call("GET", "/api/branding/profiles/default")).json.companyName, "Legacy API Co", "legacy route edits the active profile");

  const created = await call("POST", "/api/branding/profiles", FULL_PROFILE);
  assert.equal(created.status, 201);
  assert.equal(created.json.id, "contoso");
  assert.ok(created.json.contrast.primary.onWhite > 4);

  assert.equal((await call("POST", "/api/branding/profiles", { name: "Bad", moreInfoUrl: "javascript:alert(1)" })).status, 400);
  const badUrl = await call("POST", "/api/branding/profiles", { name: "Bad 2", moreInfoUrl: "http://x.example.com" });
  assert.equal(badUrl.status, 400);
  assert.ok(badUrl.json.errors.moreInfoUrl);
  assert.equal((await call("POST", "/api/branding/profiles", { name: "contoso" })).status, 409);
  assert.equal((await call("GET", "/api/branding/profiles/missing")).status, 404);
  assert.equal((await call("GET", "/api/branding/profiles/..%2Fetc")).status, 404);

  const patched = await call("PATCH", "/api/branding/profiles/contoso", { tagline: "Patched" });
  assert.equal(patched.json.tagline, "Patched");
  const dup = await call("POST", "/api/branding/profiles/contoso/duplicate", { name: "Contoso EU" });
  assert.equal(dup.status, 201);
  assert.equal(dup.json.name, "Contoso EU");

  const activated = await call("POST", "/api/branding/profiles/contoso/activate");
  assert.equal(activated.json.isActive, true);
  assert.equal((await call("GET", "/api/branding")).json.companyName, "Contoso Ltd", "GET /api/branding follows the active profile");

  // Logo upload: only real PNG/JPEG content, max 2 MB, served from /uploads.
  const upload = async (id, bytes, type, name) => {
    const form = new FormData();
    form.append("logo", new Blob([bytes], { type }), name);
    return fetch(`${base}/api/branding/profiles/${id}/logo`, { method: "POST", body: form });
  };
  assert.equal((await upload("contoso", Buffer.from("<svg/>"), "image/svg+xml", "x.svg")).status, 400);
  assert.equal((await upload("contoso", Buffer.from("MZ not an image"), "image/png", "fake.png")).status, 400);
  assert.equal((await upload("contoso", Buffer.alloc(2 * 1024 * 1024 + 1024, 1), "image/png", "big.png")).status, 400);
  assert.equal((await upload("missing", ONE_PIXEL_PNG, "image/png", "x.png")).status, 404);
  const ok = await upload("contoso", ONE_PIXEL_PNG, "image/png", "logo.png");
  assert.equal(ok.status, 200);
  const withLogo = await ok.json();
  assert.match(withLogo.logo, /^\/uploads\/logo-contoso-\d+\.png$/);
  assert.equal((await fetch(`${base}${withLogo.logo}`)).status, 200);
  assert.equal((await call("GET", "/api/branding")).json.logo, withLogo.logo);
  const cleared = await call("DELETE", "/api/branding/profiles/contoso/logo");
  assert.equal(cleared.json.logo, null);
  assert.equal((await fetch(`${base}${withLogo.logo}`)).status, 404);

  // Legacy logo routes still work.
  const form = new FormData();
  form.append("logo", new Blob([ONE_PIXEL_PNG], { type: "image/png" }), "legacy.png");
  const legacyLogo = await fetch(`${base}/api/branding/logo`, { method: "POST", body: form });
  assert.equal(legacyLogo.status, 200);
  assert.match((await legacyLogo.json()).logo, /^\/uploads\/logo-\d+\.png$/);
  assert.equal((await call("DELETE", "/api/branding/logo")).json.logo, null);

  // Deleting the active profile activates another; the last one is protected.
  const deleted = await call("DELETE", "/api/branding/profiles/contoso");
  assert.equal(deleted.status, 200);
  assert.notEqual(deleted.json.activeProfileId, "contoso");
  assert.equal((await call("DELETE", "/api/branding/profiles/contoso-eu")).status, 200);
  const last = await call("DELETE", "/api/branding/profiles/default");
  assert.equal(last.status, 409);
  assert.equal((await call("GET", "/api/branding/profiles")).json.profiles.length, 1);
});

test("branding routes are rate limited and enforce a small JSON body limit", async (t) => {
  const { call } = await bootServer(t, { BRANDING_RATE_MAX: "6", BRANDING_BODY_LIMIT: "8kb" });

  const huge = await call("POST", "/api/branding/profiles", { name: "Huge", footerText: "x".repeat(20000) });
  assert.equal(huge.status, 413);

  const statuses = [];
  for (let i = 0; i < 8; i += 1) {
    statuses.push((await call("POST", "/api/branding/profiles", { name: `Rate ${i}` })).status);
  }
  assert.equal(statuses.filter((s) => s === 201).length, 6);
  assert.equal(statuses.filter((s) => s === 429).length, 2);
  const limited = await call("POST", "/api/branding/profiles", { name: "One more" });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  assert.equal((await call("GET", "/api/branding/profiles")).status, 200, "reads are not rate limited");
});

test("generate accepts brandProfileId and overrides, and the customization API manages them on canonical and alias routes", async (t) => {
  const { call } = await bootServer(t);
  await call("POST", "/api/branding/profiles", FULL_PROFILE);

  const generated = await call("POST", "/api/lab-builder/generate", {
    product: "copilot-studio",
    features: ["create-agent"],
    level: 100,
    harness: "standard",
    industry: "healthcare",
    title: "Customized Over HTTP",
    useLearnMcp: false,
    useLlm: false,
    brandProfileId: "contoso",
    overrides: { tagline: "Lab-only tagline", supportName: "Grace Hopper" },
  });
  assert.equal(generated.status, 200, generated.text);
  assert.equal(generated.json.status, "complete");
  const labId = generated.json.labId;
  assert.equal(generated.json.manifest.customization.profileId, "contoso");

  const bad = await call("POST", "/api/lab-builder/generate", { product: "copilot-studio", features: ["create-agent"], level: 100, brandProfileId: "nope" });
  assert.equal(bad.status, 400);
  const badOverride = await call("POST", "/api/lab-builder/generate", { product: "copilot-studio", features: ["create-agent"], level: 100, overrides: { moreInfoUrl: "javascript:1" } });
  assert.equal(badOverride.status, 400);
  assert.ok(badOverride.json.errors.moreInfoUrl);

  // The profile's default SharePoint site pre-fills the lab when the request has none.
  assert.equal(generated.json.manifest.options?.sharepointSiteUrl ?? generated.json.manifest.sharepointSite?.url ?? null, "https://contoso.sharepoint.com/sites/AIHub");

  for (const base of ["/api/lab-builder/generated", "/api/generated-labs"]) {
    const got = await call("GET", `${base}/${labId}/customization`);
    assert.equal(got.status, 200);
    assert.equal(got.json.profileId, "contoso");
    assert.equal(got.json.effective.tagline, "Lab-only tagline");
    assert.equal(got.json.effective.supportName, "Grace Hopper");
  }
  assert.equal((await call("GET", "/api/lab-builder/generated/missing-lab/customization")).status, 404);
  assert.equal((await call("GET", "/api/generated-labs/..%2Fx/customization")).status, 400);

  // Profile edits do not change the lab until the explicit action.
  await call("PATCH", "/api/branding/profiles/contoso", { companyName: "Contoso Renamed" });
  const md = (await call("GET", `/api/lab-builder/generated/${labId}/export?format=md`)).text;
  assert.match(md, /Contoso Ltd/);
  assert.doesNotMatch(md, /Contoso Renamed/);
  assert.match(md, /Lab-only tagline/);
  assert.match(md, /Grace Hopper/);

  const patched = await call("PATCH", `/api/generated-labs/${labId}/customization`, { overrides: { tagline: "Second tagline" } });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.effective.tagline, "Second tagline");
  assert.equal(patched.json.profileChangedSinceSnapshot, true);

  const refreshed = await call("PATCH", `/api/lab-builder/generated/${labId}/customization`, { action: "update-from-profile" });
  assert.equal(refreshed.json.effective.companyName, "Contoso Renamed");
  assert.equal(refreshed.json.effective.tagline, "Second tagline");
  const reset = await call("PATCH", `/api/lab-builder/generated/${labId}/customization`, { action: "reset" });
  assert.deepEqual(reset.json.overrides, {});
  assert.equal((await call("PATCH", `/api/lab-builder/generated/${labId}/customization`, { overrides: { supportEmail: "nope" } })).status, 400);

  const preview = await call("GET", `/api/lab-builder/generated/${labId}`);
  assert.equal(preview.status, 200);
  assert.match(preview.json.html, /Contoso Renamed/);
  assert.equal(preview.json.manifest.customization.profileId, "contoso");
});
