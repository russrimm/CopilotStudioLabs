/**
 * HTTP routes for the screenshot capture platform.
 *
 *   Browser-facing (normal portal sign-in, rate limited):
 *     POST   /api/capture/pair                       one-time pairing code
 *     GET    /api/capture/status                     companion, server browser, tenant URLs, library persistence
 *     GET    /api/capture/devices                    paired computers
 *     DELETE /api/capture/devices/:id                disconnect a computer
 *     POST   /api/capture/jobs                       queue a capture job
 *     GET    /api/capture/jobs                       recent jobs
 *     GET    /api/capture/jobs/:id                   one job with per-shot status and events
 *     GET    /api/capture/jobs/:id/events            server-sent events (polling works too)
 *     POST   /api/capture/jobs/:id/cancel            stop a job between shots
 *     GET    /api/capture/companion.zip              the companion download (no secrets)
 *     GET    /api/capture/library                    shared library slots
 *     PUT|POST accept|DELETE|GET staged              paste, upload, review, and retake (library and per lab)
 *
 *   Companion (a capture token, never an Entra token; the ONLY routes that skip portal sign-in):
 *     POST /api/capture/companion/pair               trade a pairing code for a token
 *     POST /api/capture/companion/heartbeat
 *     GET  /api/capture/companion/next               claim the next job
 *     POST /api/capture/companion/jobs/:id/progress
 *     PUT  /api/capture/companion/jobs/:id/shots/:filename
 *     POST /api/capture/companion/jobs/:id/complete
 *
 * See docs/lab-builder.md for payload shapes.
 */

import express from "express";
import multer from "multer";

import { createRateLimiter, positiveIntFromEnv } from "../rate-limit.js";
import { buildCompanionZip, COMPANION_ZIP_NAME } from "./companion-zip.js";
import { createCapturePlatform } from "./index.js";
import { isJobId } from "./jobs.js";
import { TOKEN_PREFIX } from "./pairing.js";
import { MAX_UPLOAD_BYTES } from "./verify-upload.js";
import { parseRecipeKey } from "../../../tools/screenshot-capture/recipes.mjs";

const SAFE_LAB_ID = /^[a-z0-9][a-z0-9-]{0,99}$/i;
const DEVICE_ID_RE = /^dev_[a-f0-9]{12}$/;
const IMAGE_BODY_TYPE = /^(?:image\/(?:png|jpe?g|webp)|application\/octet-stream)(?:\s*;|$)/i;
const COMPANION_PREFIX = "/api/capture/companion";
const SSE_MAX_MS = 30 * 60 * 1000;
const MAX_EVIDENCE_BYTES = 64 * 1024;

function userKey(req) {
  return String(req.user?.oid || req.user?.upn || req.ip || "anonymous").toLowerCase();
}

function actor(req) {
  return req.user?.upn || req.user?.oid || null;
}

function parseJsonField(value) {
  if (value === undefined || value === null || value === "") return null;
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  if (text.length > MAX_EVIDENCE_BYTES) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function parseEvidenceHeader(value) {
  if (!value || typeof value !== "string" || value.length > 16 * 1024) return null;
  try {
    return parseJsonField(Buffer.from(value, "base64url"));
  } catch {
    return null;
  }
}

/**
 * Register every capture route on `app`. Call it once, after the portal's
 * `requireAuth()` and Blob write-through middleware and before the SPA fallback.
 *
 * @param {import("express").Express} app
 * @param {object} deps
 * @param {string} deps.generatedRoot folder that holds generated labs
 * @param {() => void} [deps.scheduleBlobSync] Azure Blob write-through after a change
 * @param {(req: object, res: object) => boolean} [deps.manageRateLimited] the portal's lab-management limiter
 * @returns the capture platform (also used by the older capture and generate endpoints)
 */
export function registerCaptureRoutes(app, deps = {}) {
  const platform = deps.platform ?? createCapturePlatform(deps);
  const { pairing, jobs, screenshots, sharedRecipes } = platform;
  const scheduleBlobSync = typeof deps.scheduleBlobSync === "function" ? deps.scheduleBlobSync : () => {};
  const env = deps.env ?? process.env;

  const pairRate = createRateLimiter({ windowMs: positiveIntFromEnv(env.CAPTURE_PAIR_RATE_WINDOW_MS, 3600000), max: positiveIntFromEnv(env.CAPTURE_PAIR_RATE_MAX, 20) });
  const manageRate = createRateLimiter({ windowMs: positiveIntFromEnv(env.CAPTURE_MANAGE_RATE_WINDOW_MS, 3600000), max: positiveIntFromEnv(env.CAPTURE_MANAGE_RATE_MAX, 120) });
  const uploadRate = createRateLimiter({ windowMs: positiveIntFromEnv(env.CAPTURE_UPLOAD_RATE_WINDOW_MS, 3600000), max: positiveIntFromEnv(env.CAPTURE_UPLOAD_RATE_MAX, 600) });
  const exchangeRate = createRateLimiter({ windowMs: positiveIntFromEnv(env.CAPTURE_EXCHANGE_RATE_WINDOW_MS, 600000), max: positiveIntFromEnv(env.CAPTURE_EXCHANGE_RATE_MAX, 10) });
  const companionRate = createRateLimiter({ windowMs: 60000, max: positiveIntFromEnv(env.CAPTURE_COMPANION_RATE_MAX, 600) });
  const recipeRate = createRateLimiter({ windowMs: positiveIntFromEnv(env.CAPTURE_RECIPE_RATE_WINDOW_MS, 3600000), max: positiveIntFromEnv(env.CAPTURE_RECIPE_RATE_MAX, 30) });

  function limited(check, key, message) {
    return (req, res) => {
      const rate = check(typeof key === "function" ? key(req) : key);
      if (rate.allowed) return false;
      res.setHeader("Retry-After", String(rate.retryAfterSec));
      res.status(429).json({ error: `${message} Try again in ${rate.retryAfterSec}s.` });
      return true;
    };
  }
  const pairLimited = limited(pairRate, userKey, "Too many pairing codes requested.");
  const uploadLimited = limited(uploadRate, userKey, "Too many screenshot uploads.");
  const manageLimited = typeof deps.manageRateLimited === "function" ? deps.manageRateLimited : limited(manageRate, userKey, "Too many capture changes.");

  /** Run the Azure Blob write-through after a handler that changed stored state. */
  const syncAfter = (res) => res.once("finish", () => scheduleBlobSync());

  // ── Body parsing for image uploads ────────────────────────────────────────

  const multipart = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 6, fieldSize: MAX_EVIDENCE_BYTES, parts: 10 },
  }).single("file");
  const rawImage = express.raw({ type: (req) => IMAGE_BODY_TYPE.test(String(req.headers["content-type"] || "")), limit: MAX_UPLOAD_BYTES + 4096 });

  /** Read one image from a raw body or a multipart form into `req.upload`. */
  function readUpload(req, res, next) {
    const type = String(req.headers["content-type"] || "").toLowerCase();
    if (type.startsWith("multipart/form-data")) {
      multipart(req, res, (err) => {
        if (err) {
          const tooLarge = err.code === "LIMIT_FILE_SIZE";
          return res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? `The image is larger than ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB.` : "The upload could not be read." });
        }
        req.upload = { bytes: req.file?.buffer || null, evidence: parseJsonField(req.body?.evidence), callouts: parseJsonField(req.body?.callouts) };
        return next();
      });
      return;
    }
    rawImage(req, res, (err) => {
      if (err) return next(err);
      const bytes = Buffer.isBuffer(req.body) && req.body.length ? req.body : null;
      req.upload = { bytes, evidence: parseEvidenceHeader(req.get("x-capture-evidence")), callouts: null };
      next();
    });
  }

  function requireUploadBytes(req, res) {
    if (req.upload?.bytes) return true;
    res.status(415).json({ error: "Send the image as image/png, image/jpeg, image/webp, application/octet-stream, or multipart/form-data with a \"file\" field." });
    return false;
  }

  // ── Browser-facing routes ─────────────────────────────────────────────────

  app.post("/api/capture/pair", (req, res) => {
    if (pairLimited(req, res)) return;
    const issued = pairing.createCode({ createdBy: actor(req) });
    syncAfter(res);
    const portalUrl = `${req.protocol}://${req.get("host")}`;
    res.status(201).json({ ...issued, portalUrl, command: `start-companion --portal=${portalUrl} --code=${issued.code}` });
  });

  app.get("/api/capture/status", async (_req, res) => {
    try {
      res.json(await platform.statusPayload());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/capture/devices", (_req, res) => {
    res.json({ devices: pairing.listDevices() });
  });

  app.delete("/api/capture/devices/:id", (req, res) => {
    if (manageLimited(req, res)) return;
    if (!DEVICE_ID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid device id." });
    syncAfter(res);
    if (!pairing.revokeDevice(req.params.id)) return res.status(404).json({ error: "Device not found or already disconnected." });
    return res.json({ revoked: true, id: req.params.id });
  });

  app.post("/api/capture/jobs", (req, res) => {
    if (manageLimited(req, res)) return;
    syncAfter(res);
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    try {
      const result = platform.queueJob(body, { createdBy: actor(req) });
      res.status(result.status).json(result.body);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/capture/jobs", (req, res) => {
    const limit = Number.parseInt(String(req.query.limit ?? "25"), 10);
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const labId = typeof req.query.labId === "string" && SAFE_LAB_ID.test(req.query.labId) ? req.query.labId : null;
    res.json({ jobs: jobs.list({ limit: Number.isFinite(limit) ? limit : 25, status, labId }) });
  });

  app.get("/api/capture/jobs/:id", (req, res) => {
    if (!isJobId(req.params.id)) return res.status(400).json({ error: "Invalid job id." });
    const job = jobs.get(req.params.id);
    return job ? res.json({ job }) : res.status(404).json({ error: "Job not found." });
  });

  app.get("/api/capture/jobs/:id/events", (req, res) => {
    if (!isJobId(req.params.id)) return res.status(400).json({ error: "Invalid job id." });
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found." });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const finished = (status) => status === "done" || status === "failed" || status === "cancelled";
    let ping = null;
    let limit = null;
    let off = () => {};
    const close = () => {
      clearInterval(ping);
      clearTimeout(limit);
      off();
      if (!res.writableEnded) res.end();
    };
    send("snapshot", { job });
    if (finished(job.status)) {
      send("end", { status: job.status });
      return close();
    }
    off = jobs.subscribe(job.id, ({ job: summary, event }) => {
      send("update", { job: summary, event });
      if (finished(summary.status)) {
        send("end", { status: summary.status });
        close();
      }
    });
    ping = setInterval(() => res.write(": ping\n\n"), 15000);
    limit = setTimeout(close, SSE_MAX_MS);
    ping.unref?.();
    limit.unref?.();
    req.on("close", close);
    return undefined;
  });

  app.post("/api/capture/jobs/:id/cancel", (req, res) => {
    if (manageLimited(req, res)) return;
    if (!isJobId(req.params.id)) return res.status(400).json({ error: "Invalid job id." });
    syncAfter(res);
    // "Pause" stops after the current screenshot and keeps the rest for Resume; plain cancel drops them.
    const result = jobs.cancel(req.params.id, { pause: req.body?.pause === true });
    return result.ok ? res.json({ job: result.job }) : res.status(result.status).json({ error: result.error, job: result.job });
  });

  // ── Automatic capture: what the person agreed to, and the recipes people shared ──

  app.get("/api/capture/consent", (req, res) => {
    const brandProfileId = typeof req.query.brandProfileId === "string" ? req.query.brandProfileId : undefined;
    return res.json(platform.consentPayload({ body: { brandProfileId } }));
  });

  app.put("/api/capture/consent", (req, res) => {
    if (manageLimited(req, res)) return;
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    syncAfter(res);
    try {
      const result = platform.saveConsent(body, { body: { brandProfileId: typeof body.brandProfileId === "string" ? body.brandProfileId : undefined } });
      return res.status(result.status).json(result.body);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/capture/consent", (req, res) => {
    if (manageLimited(req, res)) return;
    const brandProfileId = typeof req.query.brandProfileId === "string" ? req.query.brandProfileId : undefined;
    syncAfter(res);
    return res.json(platform.revokeConsent({ body: { brandProfileId } }).body);
  });

  app.get("/api/capture/recipes", (_req, res) => {
    res.json({ recipes: sharedRecipes.list() });
  });

  app.delete("/api/capture/recipes", (req, res) => {
    if (manageLimited(req, res)) return;
    const parsed = parseRecipeKey(typeof req.query.key === "string" ? req.query.key : "");
    if (!parsed) return res.status(400).json({ error: "That is not a recipe key." });
    syncAfter(res);
    return sharedRecipes.remove(parsed) ? res.json({ removed: true }) : res.status(404).json({ error: "No shared recipe with that key." });
  });

  // ── Capture settings: where should we capture? ────────────────────────────

  app.get("/api/capture/targets", (req, res) => {
    const labId = typeof req.query.labId === "string" && req.query.labId ? req.query.labId : null;
    if (labId && !SAFE_LAB_ID.test(labId)) return res.status(400).json({ error: "Invalid lab id." });
    try {
      return res.json(platform.targetsPayload({ labId }));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/capture/targets", (req, res) => {
    if (manageLimited(req, res)) return;
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    syncAfter(res);
    try {
      const result = platform.saveProfileTargets(body.targets, { profileId: typeof body.profileId === "string" ? body.profileId : null });
      return res.status(result.status).json(result.body);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  for (const prefix of ["/api/lab-builder/generated/:labId", "/api/generated-labs/:labId"]) {
    app.get(`${prefix}/capture-targets`, (req, res) => {
      if (!SAFE_LAB_ID.test(req.params.labId)) return res.status(400).json({ error: "Invalid lab id." });
      try {
        return res.json(platform.targetsPayload({ labId: req.params.labId }));
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    });
    app.put(`${prefix}/capture-targets`, (req, res) => {
      if (manageLimited(req, res)) return;
      if (!SAFE_LAB_ID.test(req.params.labId)) return res.status(400).json({ error: "Invalid lab id." });
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      syncAfter(res);
      try {
        const result = platform.saveLabTargets(req.params.labId, body.targets, { alsoProfile: body.alsoProfile === true });
        return res.status(result.status).json(result.body);
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    });
  }

  app.get("/api/capture/companion.zip", async (_req, res) => {
    try {
      const { buffer } = await buildCompanionZip(deps.repoRoot ? { repoRoot: deps.repoRoot } : undefined);
      res.set({ "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${COMPANION_ZIP_NAME}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.send(buffer);
    } catch (err) {
      res.status(500).json({ error: `Could not build the companion download: ${err.message}` });
    }
  });

  // ── Paste, upload, review, and retake (shared by labs and the library) ───

  function targetHandlers(prefixes, resolveTargetRaw) {
    const base = (suffix = "") => prefixes.map((p) => `${p}/screenshots/:filename${suffix}`);
    const resolveTarget = (req, res) => {
      try {
        return resolveTargetRaw(req, res);
      } catch (err) {
        res.status(500).json({ error: err.message });
        return null;
      }
    };

    app.put(base(), readUpload, (req, res) => {
      if (uploadLimited(req, res)) return;
      if (!requireUploadBytes(req, res)) return;
      const target = resolveTarget(req, res);
      if (!target) return;
      syncAfter(res);
      const acceptWarnings = String(req.query.acceptWarnings || "").toLowerCase() === "true";
      try {
        const result = screenshots.submit(target, req.params.filename, req.upload.bytes, { evidence: req.upload.evidence, source: "manual-upload", acceptWarnings, callouts: req.upload.callouts });
        res.status(result.status).json(result.body);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    app.post(base("/accept"), (req, res) => {
      if (uploadLimited(req, res)) return;
      const target = resolveTarget(req, res);
      if (!target) return;
      syncAfter(res);
      try {
        const result = screenshots.accept(target, req.params.filename);
        res.status(result.status).json(result.body);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    app.delete(base(), (req, res) => {
      if (manageLimited(req, res)) return;
      const target = resolveTarget(req, res);
      if (!target) return;
      syncAfter(res);
      try {
        const result = screenshots.reset(target, req.params.filename);
        res.status(result.status).json(result.body);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    app.get(base("/staged"), (req, res) => {
      const target = resolveTarget(req, res);
      if (!target) return;
      const staged = screenshots.readStaged(target, req.params.filename);
      if (!staged) return res.status(404).json({ error: "Nothing is waiting for review for this screenshot." });
      const type = /\.png$/i.test(req.params.filename) ? "image/png" : /\.webp$/i.test(req.params.filename) ? "image/webp" : "image/jpeg";
      res.set({ "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" });
      return res.send(staged.bytes);
    });
  }

  targetHandlers(["/api/lab-builder/generated/:labId", "/api/generated-labs/:labId"], (req, res) => {
    const target = screenshots.lab(req.params.labId);
    if (target.error) {
      res.status(target.error.status).json(target.error.body);
      return null;
    }
    return target;
  });
  targetHandlers(["/api/capture/library"], () => screenshots.library());

  app.get("/api/capture/library", (req, res) => {
    const products = typeof req.query.products === "string" ? req.query.products.split(",").map((p) => p.trim()).filter(Boolean) : [];
    res.json(screenshots.libraryState({ products }));
  });

  // ── Companion routes (capture token) ──────────────────────────────────────

  app.use(COMPANION_PREFIX, (req, res, next) => {
    const limitedKey = req.headers.authorization ? `token:${String(req.headers.authorization).slice(-24)}` : `ip:${req.ip}`;
    const rate = companionRate(limitedKey);
    if (!rate.allowed) {
      res.setHeader("Retry-After", String(rate.retryAfterSec));
      return res.status(429).json({ error: `Slow down. Try again in ${rate.retryAfterSec}s.` });
    }
    if (req.method === "POST" && req.path === "/pair") return next();
    const header = String(req.headers.authorization || "");
    const [scheme, token] = header.split(" ");
    if (!token || !/^Bearer$/i.test(scheme) || !token.startsWith(TOKEN_PREFIX)) {
      res.set("WWW-Authenticate", 'Bearer realm="capture"');
      return res.status(401).json({ error: "A capture token is required.", code: "token-missing" });
    }
    const auth = pairing.authenticate(token);
    if (!auth.ok) {
      res.set("WWW-Authenticate", 'Bearer realm="capture", error="invalid_token"');
      const messages = {
        revoked: "This computer was disconnected in the portal. Pair it again with a new code.",
        expired: "This computer's connection expired. Pair it again with a new code.",
        invalid: "The capture token is not valid. Pair this computer again with a new code.",
        missing: "A capture token is required.",
      };
      return res.status(401).json({ error: messages[auth.reason] || messages.invalid, code: `token-${auth.reason}` });
    }
    req.captureDevice = auth.device;
    return next();
  });

  app.post(`${COMPANION_PREFIX}/pair`, (req, res) => {
    const rate = exchangeRate(`ip:${req.ip}`);
    if (!rate.allowed) {
      res.setHeader("Retry-After", String(rate.retryAfterSec));
      return res.status(429).json({ error: `Too many pairing attempts. Try again in ${rate.retryAfterSec}s.`, code: "pair-rate-limited" });
    }
    const body = req.body && typeof req.body === "object" ? req.body : {};
    syncAfter(res);
    const result = pairing.exchangeCode(body.code, { deviceName: body.deviceName, platform: body.platform, companionVersion: body.companionVersion });
    if (!result.ok) {
      const messages = {
        invalid: "That pairing code is not valid. Get a new code in the portal.",
        expired: "That pairing code expired. Get a new code in the portal.",
        locked: "Too many wrong codes. Wait a few minutes and try again.",
      };
      const status = result.reason === "locked" ? 429 : 401;
      if (result.retryAfterSec) res.setHeader("Retry-After", String(result.retryAfterSec));
      return res.status(status).json({ error: messages[result.reason] || messages.invalid, code: `pair-${result.reason}` });
    }
    return res.status(201).json({ token: result.token, device: result.device });
  });

  app.post(`${COMPANION_PREFIX}/heartbeat`, (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    pairing.heartbeat(req.captureDevice.id, body);
    const touched = typeof body.jobId === "string" && isJobId(body.jobId) ? jobs.touch(body.jobId, req.captureDevice.id) : { cancelRequested: false };
    res.json({ ok: true, cancelRequested: touched.cancelRequested, serverTime: new Date().toISOString(), tokenExpiresAt: new Date(req.captureDevice.expiresAt).toISOString() });
  });

  app.get(`${COMPANION_PREFIX}/next`, (req, res) => {
    pairing.heartbeat(req.captureDevice.id, { signedInProducts: undefined, busy: false, companionVersion: req.get("x-companion-version") });
    const claimed = jobs.claimNext(req.captureDevice);
    if (!claimed) return res.status(204).end();
    scheduleBlobSync();
    const { job, plan, resumed } = claimed;
    const pending = new Set(job.shots.filter((s) => s.status === "pending" || s.status === "running").map((s) => s.filename));
    return res.json({
      // The practice environment (when the person allowed a practice agent) travels only here, never in the job the browser reads.
      job: { id: job.id, target: job.target, scope: job.scope, options: { ...job.options, ...(plan?.autonomy ? { autonomy: plan.autonomy } : {}) }, createdAt: job.createdAt, resumed },
      env: plan?.env || {},
      targets: plan?.targets || {},
      shots: (plan?.shots || []).filter((shot) => pending.has(shot.filename)),
    });
  });

  app.post(`${COMPANION_PREFIX}/jobs/:id/progress`, (req, res) => {
    if (!isJobId(req.params.id)) return res.status(400).json({ error: "Invalid job id." });
    syncAfter(res);
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const result = jobs.reportProgress(req.params.id, req.captureDevice.id, { shot: body.shot || null, message: typeof body.message === "string" ? body.message : null });
    return result.ok ? res.json({ ok: true, cancelRequested: result.cancelRequested }) : res.status(result.status).json({ error: result.error });
  });

  app.put(`${COMPANION_PREFIX}/jobs/:id/shots/:filename`, readUpload, (req, res) => {
    if (!isJobId(req.params.id)) return res.status(400).json({ error: "Invalid job id." });
    if (!requireUploadBytes(req, res)) return;
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found." });
    if (job.claim?.deviceId !== req.captureDevice.id || !["claimed", "running"].includes(job.status)) {
      return res.status(409).json({ error: "This job is not assigned to this companion or has already finished." });
    }
    if (!job.shots.some((s) => s.filename === req.params.filename)) return res.status(404).json({ error: "That screenshot is not part of this job." });

    let target;
    if (job.target.type === "lab") {
      target = screenshots.lab(job.target.labId);
      if (target.error) return res.status(target.error.status).json(target.error.body);
    } else {
      target = screenshots.library();
    }
    syncAfter(res);
    // What the plan expects of this screen is the portal's own: it never comes from the companion's report.
    const plannedShot = jobs.getPlan(job.id)?.shots?.find((s) => s.filename === req.params.filename) || null;
    try {
      const result = screenshots.submit(target, req.params.filename, req.upload.bytes, {
        evidence: req.upload.evidence,
        callouts: req.upload.callouts,
        source: "companion",
        defer: true,
        requireEvidence: true,
        requireRedaction: job.options?.redact !== false,
        jobId: job.id,
        expect: plannedShot?.capture?.expect || null,
        expectedLabels: plannedShot?.capture?.version ? plannedShot.expectedLabels : null,
      });
      const outcome = result.body.outcome;
      const recorded = jobs.recordShotResult(job.id, req.captureDevice.id, req.params.filename, {
        status: outcome === "accepted" ? "captured" : outcome === "needs-review" ? "needs-review" : "failed",
        verification: result.body.verification || null,
        message: outcome === "accepted" ? "Captured and verified." : outcome === "needs-review" ? "Saved for review in the portal." : null,
        error: outcome === "rejected" || result.status >= 400 ? result.body.message || result.body.error : null,
      });
      res.status(result.status).json({ ...result.body, cancelRequested: Boolean(recorded.cancelRequested) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // A recipe the person chose to share: validated here again, anonymous, and rate limited.
  app.post(`${COMPANION_PREFIX}/recipes`, (req, res) => {
    const rate = recipeRate(`token:${String(req.headers.authorization || "").slice(-24)}`);
    if (!rate.allowed) {
      res.setHeader("Retry-After", String(rate.retryAfterSec));
      return res.status(429).json({ error: `Too many recipes shared. Try again in ${rate.retryAfterSec}s.` });
    }
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    syncAfter(res);
    const result = sharedRecipes.put(body.recipe);
    if (!result.ok) return res.status(422).json({ error: result.errors[0] || "The recipe was not accepted.", errors: result.errors, code: "recipe-rejected" });
    return res.status(result.replaced ? 200 : 201).json({ shared: true, replaced: result.replaced === true });
  });

  app.post(`${COMPANION_PREFIX}/jobs/:id/complete`, (req, res) => {
    if (!isJobId(req.params.id)) return res.status(400).json({ error: "Invalid job id." });
    syncAfter(res);
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const result = jobs.complete(req.params.id, req.captureDevice.id, { message: body.message, fatalError: body.fatalError, paused: body.paused, created: body.created, signIn: body.signIn });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    if (result.job.target.type === "lab") screenshots.flushLab(result.job.target.labId);
    else void screenshots.flushLibrary().catch(() => {});
    return res.json({ job: result.job });
  });

  app.all(`${COMPANION_PREFIX}/*rest`, (_req, res) => res.status(404).json({ error: "Unknown companion endpoint." }));

  return platform;
}
