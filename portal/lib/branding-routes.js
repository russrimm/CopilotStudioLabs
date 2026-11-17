/**
 * Express routes for brand profiles and per-lab customization.
 *
 * Registered with a single `registerBrandingRoutes(app)` call from `server.js`.
 * The legacy `/api/branding` routes stay in `server.js` and keep working: they
 * now read and write the active profile.
 *
 * All routes sit behind the portal's `requireAuth()` middleware. Mutating
 * `/api` requests already trigger the Azure Blob write-through sync, so no
 * extra wiring is needed here.
 */

import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import multer from "multer";
import {
  BrandProfileError,
  MAX_LOGO_BYTES,
  activateProfile,
  buildProfileLogoFileName,
  clearProfileLogo,
  createProfile,
  deleteProfile,
  describeLabCustomization,
  detectRasterLogoExtension,
  duplicateProfile,
  getProfile,
  listProfiles,
  setProfileLogo,
  updateLabCustomization,
  updateProfile,
} from "./branding-profiles.js";
import { resolveSafeGeneratedLabDir } from "./exporter.js";
import { createRateLimiter, positiveIntFromEnv } from "./rate-limit.js";
import { resolveGeneratedLabsDir, resolvePortalUploadsDir } from "./storage-config.js";

/** JSON bodies for these routes are small; `server.js` mounts a parser with this limit ahead of the global 10 MB one. */
export const BRANDING_JSON_BODY_LIMIT = process.env.BRANDING_BODY_LIMIT || "64kb";
export const BRANDING_JSON_PATHS = Object.freeze([
  "/api/branding/profiles",
  /^\/api\/generated-labs\/[^/]+\/customization\/?$/,
]);

function rateKey(req) {
  return String(req.user?.oid || req.user?.upn || req.ip || "anonymous").toLowerCase();
}

function sendError(res, err) {
  if (err instanceof BrandProfileError) {
    return res.status(err.status).json({ error: err.message, ...(err.errors ? { errors: err.errors } : {}) });
  }
  return res.status(500).json({ error: err?.message || "Unexpected error." });
}

function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      sendError(res, err);
    }
  };
}

/**
 * @param {import("express").Express} app
 * @param {{ generatedLabsDir?: string, env?: object }} [deps]
 */
export function registerBrandingRoutes(app, deps = {}) {
  const env = deps.env || process.env;
  const generatedLabsDir = deps.generatedLabsDir || resolveGeneratedLabsDir(env);

  const manageRateCheck = createRateLimiter({
    windowMs: positiveIntFromEnv(env.BRANDING_RATE_WINDOW_MS, 3600000),
    max: positiveIntFromEnv(env.BRANDING_RATE_MAX, 120),
  });
  const logoRateCheck = createRateLimiter({
    windowMs: positiveIntFromEnv(env.BRANDING_RATE_WINDOW_MS, 3600000),
    max: positiveIntFromEnv(env.BRANDING_LOGO_RATE_MAX, 30),
  });

  function rateLimited(req, res, check = manageRateCheck) {
    const rate = check(rateKey(req));
    if (rate.allowed) return false;
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: `Too many branding changes. Try again in ${rate.retryAfterSec}s.` });
    return true;
  }

  const logoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_LOGO_BYTES, files: 1, fields: 4 },
    fileFilter: (_req, file, cb) => {
      // SVG is intentionally excluded: it can embed script that would run same-origin from /uploads.
      if (file.mimetype === "image/png" || file.mimetype === "image/jpeg") {
        cb(null, true);
        return;
      }
      cb(new Error("Only PNG and JPG logos are supported."));
    },
  });

  // ── Brand profiles ────────────────────────────────────────────────────────

  /** GET /api/branding/profiles — List profiles, the active profile id, fonts, and limits */
  app.get("/api/branding/profiles", wrap((_req, res) => res.json(listProfiles(env))));

  /** POST /api/branding/profiles — Create a profile */
  app.post(
    "/api/branding/profiles",
    wrap((req, res) => {
      if (rateLimited(req, res)) return;
      res.status(201).json(createProfile(req.body, env));
    }),
  );

  /** GET /api/branding/profiles/:id — Read one profile */
  app.get("/api/branding/profiles/:id", wrap((req, res) => res.json(getProfile(req.params.id, env))));

  /** PATCH /api/branding/profiles/:id — Update profile fields */
  app.patch(
    "/api/branding/profiles/:id",
    wrap((req, res) => {
      if (rateLimited(req, res)) return;
      res.json(updateProfile(req.params.id, req.body, env));
    }),
  );

  /** DELETE /api/branding/profiles/:id — Delete a profile (never the last one) */
  app.delete(
    "/api/branding/profiles/:id",
    wrap((req, res) => {
      if (rateLimited(req, res)) return;
      res.json(deleteProfile(req.params.id, env));
    }),
  );

  /** POST /api/branding/profiles/:id/activate — Make a profile the active one */
  app.post(
    "/api/branding/profiles/:id/activate",
    wrap((req, res) => {
      if (rateLimited(req, res)) return;
      res.json(activateProfile(req.params.id, env));
    }),
  );

  /** POST /api/branding/profiles/:id/duplicate — Copy a profile (including its logo) */
  app.post(
    "/api/branding/profiles/:id/duplicate",
    wrap((req, res) => {
      if (rateLimited(req, res)) return;
      res.status(201).json(duplicateProfile(req.params.id, { name: req.body?.name }, env));
    }),
  );

  /** POST /api/branding/profiles/:id/logo — Upload a PNG/JPG logo (max 2 MB) */
  app.post("/api/branding/profiles/:id/logo", (req, res) => {
    if (rateLimited(req, res, logoRateCheck)) return;
    logoUpload.single("logo")(req, res, (err) => {
      if (err) {
        const tooLarge = err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE";
        res.status(tooLarge || /Only PNG/.test(err.message) || err instanceof multer.MulterError ? 400 : 500).json({
          error: tooLarge ? "Logo must be 2 MB or smaller." : err.message,
        });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: "Logo file is required." });
        return;
      }

      let writtenPath = null;
      try {
        getProfile(req.params.id, env);
        const extension = detectRasterLogoExtension(req.file.buffer);
        if (!extension) {
          res.status(400).json({ error: "The file is not a valid PNG or JPG image." });
          return;
        }
        const fileName = buildProfileLogoFileName(req.params.id, extension);
        writtenPath = resolve(resolvePortalUploadsDir(env), fileName);
        writeFileSync(writtenPath, req.file.buffer);
        res.json(setProfileLogo(req.params.id, fileName, env));
      } catch (uploadErr) {
        if (writtenPath && existsSync(writtenPath)) {
          try {
            unlinkSync(writtenPath);
          } catch {
            // Best effort cleanup of an orphaned upload.
          }
        }
        sendError(res, uploadErr);
      }
    });
  });

  /** DELETE /api/branding/profiles/:id/logo — Remove a profile logo */
  app.delete(
    "/api/branding/profiles/:id/logo",
    wrap((req, res) => {
      if (rateLimited(req, res)) return;
      res.json(clearProfileLogo(req.params.id, env));
    }),
  );

  // ── Per-lab customization ─────────────────────────────────────────────────

  function locateLab(req, res) {
    const found = resolveSafeGeneratedLabDir(generatedLabsDir, req.params.labId);
    if (found.status !== 200) {
      res.status(found.status).json({ error: found.error });
      return null;
    }
    return found;
  }

  /** GET /api/lab-builder/generated/:labId/customization — Profile, overrides, and the effective brand for a lab */
  const getLabCustomization = wrap((req, res) => {
    const found = locateLab(req, res);
    if (!found) return;
    res.json(describeLabCustomization(found.labDir, env));
  });

  /**
   * PATCH /api/lab-builder/generated/:labId/customization — Change profile or overrides.
   * Body: `{ profileId?, overrides? }` or `{ action: "update-from-profile" | "reset" }`.
   */
  const patchLabCustomization = wrap((req, res) => {
    if (rateLimited(req, res)) return;
    const found = locateLab(req, res);
    if (!found) return;
    const { customization } = updateLabCustomization(found.labDir, req.body, env);
    res.json(customization);
  });

  for (const base of ["/api/lab-builder/generated", "/api/generated-labs"]) {
    app.get(`${base}/:labId/customization`, getLabCustomization);
    app.patch(`${base}/:labId/customization`, patchLabCustomization);
  }
}
