/**
 * HTTP routes for the screenshot capture platform.
 *
 *   Browser-facing (normal portal sign-in, rate limited):
 *     POST   /api/capture/pair                       one-time pairing code
 *     GET    /api/capture/status                     companion, server browser, tenant URLs, library persistence
 *     GET    /api/capture/devices                    paired computers
 *     DELETE /api/capture/devices/:id                disconnect a computer
 *     POST   /api/capture/jobs                       queue a capture job
 *     POST   /api/capture/account-setup              ask the connected computer to open the "choose the account" sign-in
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
import { createVisitorCheck, visitorKey } from "../concurrency/visitor.js";
import { buildCompanionZip, COMPANION_ZIP_NAME } from "./companion-zip.js";
import { createCapturePlatform } from "./index.js";
import { isJobId } from "./jobs.js";
import { isKeptPictureName } from "./kept-pictures.js";
import { createStreamGate, createUploadGate } from "./limits.js";
import { EXPORT_ZIP_NAME, MAX_IMPORT_ZIP_BYTES, buildLibraryExport, importLibraryZip } from "./library-transfer.js";
import { ownerOf } from "./owner.js";
import { TOKEN_PREFIX } from "./pairing.js";
import { buildPairingCommands } from "./start-command.js";
import { MAX_UPLOAD_BYTES } from "./verify-upload.js";
import { parseRecipeKey } from "../../../tools/screenshot-capture/recipes.mjs";

export { ownerOf };

const SAFE_LAB_ID = /^[a-z0-9][a-z0-9-]{0,99}$/i;
const DEVICE_ID_RE = /^dev_[a-f0-9]{12}$/;
const IMAGE_BODY_TYPE = /^(?:image\/(?:png|jpe?g|webp)|application\/octet-stream)(?:\s*;|$)/i;
const COMPANION_PREFIX = "/api/capture/companion";
const SSE_MAX_MS = 30 * 60 * 1000;
const SSE_RETRY_AFTER_SEC = 5;
const UPLOAD_RETRY_AFTER_SEC = 5;
const MAX_EVIDENCE_BYTES = 64 * 1024;

function actor(req) {
  return req.user?.upn || req.user?.oid || null;
}

/** A request from the computer that runs the portal itself (the socket's own address, never a forwarded header). */
function isLoopback(req) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(String(req.socket?.remoteAddress || ""));
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
  const sse = platform.sse ?? createStreamGate({ max: positiveIntFromEnv(env.CAPTURE_SSE_MAX, 100), perVisitorMax: positiveIntFromEnv(env.CAPTURE_SSE_PER_VISITOR_MAX, 6) });
  const uploads = platform.uploads ?? createUploadGate({ max: positiveIntFromEnv(env.CAPTURE_UPLOAD_CONCURRENCY, 4), waitMs: positiveIntFromEnv(env.CAPTURE_UPLOAD_WAIT_MS, 20000) });
  const sseMaxMs = positiveIntFromEnv(env.CAPTURE_SSE_MAX_MS, SSE_MAX_MS);

  // Each visitor (signed-in person, else browser id, else address) has their own bucket. A single address that rotates ids
  // still cannot go past this many times one visitor's limit.
  const addressMultiplier = positiveIntFromEnv(env.CAPTURE_IP_RATE_MULTIPLIER, 20);
  const visitorRate = (windowMs, max) => createVisitorCheck(createRateLimiter({ windowMs, max }), createRateLimiter({ windowMs, max: max * addressMultiplier }));
  const pairRate = visitorRate(positiveIntFromEnv(env.CAPTURE_PAIR_RATE_WINDOW_MS, 3600000), positiveIntFromEnv(env.CAPTURE_PAIR_RATE_MAX, 20));
  const manageRate = visitorRate(positiveIntFromEnv(env.CAPTURE_MANAGE_RATE_WINDOW_MS, 3600000), positiveIntFromEnv(env.CAPTURE_MANAGE_RATE_MAX, 120));
  const uploadRate = visitorRate(positiveIntFromEnv(env.CAPTURE_UPLOAD_RATE_WINDOW_MS, 3600000), positiveIntFromEnv(env.CAPTURE_UPLOAD_RATE_MAX, 600));
  const exchangeRate = createRateLimiter({ windowMs: positiveIntFromEnv(env.CAPTURE_EXCHANGE_RATE_WINDOW_MS, 600000), max: positiveIntFromEnv(env.CAPTURE_EXCHANGE_RATE_MAX, 10) });
  const companionRate = createRateLimiter({ windowMs: 60000, max: positiveIntFromEnv(env.CAPTURE_COMPANION_RATE_MAX, 600) });
  const recipeRate = createRateLimiter({ windowMs: positiveIntFromEnv(env.CAPTURE_RECIPE_RATE_WINDOW_MS, 3600000), max: positiveIntFromEnv(env.CAPTURE_RECIPE_RATE_MAX, 30) });
  const confirmRate = visitorRate(positiveIntFromEnv(env.CAPTURE_CONFIRM_RATE_WINDOW_MS, 3600000), positiveIntFromEnv(env.CAPTURE_CONFIRM_RATE_MAX, 600));

  function limited(check, message) {
    return (req, res) => {
      const rate = check(req);
      if (rate.allowed) return false;
      res.setHeader("Retry-After", String(rate.retryAfterSec));
      res.status(429).json({ error: `${message} Try again in ${rate.retryAfterSec}s.` });
      return true;
    };
  }
  const pairLimited = limited(pairRate, "Too many pairing codes requested.");
  const uploadLimited = limited(uploadRate, "Too many screenshot uploads.");
  const confirmLimited = limited(confirmRate, "Too many confirmations.");
  const manageLimited = typeof deps.manageRateLimited === "function" ? deps.manageRateLimited : limited(manageRate, "Too many capture changes.");

  /** Run the Azure Blob write-through after a handler that changed stored state. */
  const syncAfter = (res) => res.once("finish", () => scheduleBlobSync());

  /** A failed write. A picture another process is still writing is "try again in a moment" (503), never a crash. */
  function fail(res, err) {
    if (err?.code === "LOCK_TIMEOUT") {
      res.setHeader("Retry-After", "2");
      return res.status(503).json({ error: err.message });
    }
    return res.status(500).json({ error: err.message });
  }

  // ── Body parsing for image uploads ────────────────────────────────────────

  /**
   * Let only a few image bodies be read at once (each is held in memory). The others wait a short, bounded while for a place,
   * then get a plain 503. The place is given back when the response ends or the client leaves, whichever comes first.
   */
  function uploadSlot(req, res, next) {
    const waiting = uploads.acquire();
    let gone = false;
    res.once("close", () => {
      gone = true;
      waiting.cancel();
    });
    waiting.ready.then((release) => {
      if (!release) {
        res.setHeader("Retry-After", String(UPLOAD_RETRY_AFTER_SEC));
        return res.status(503).json({ error: "The portal is receiving several pictures right now. Try again in a few seconds." });
      }
      if (gone) return release();
      res.once("close", release);
      res.once("finish", release);
      try {
        return next();
      } catch (err) {
        release();
        return next(err);
      }
    });
  }

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
    // The computer paired with this code works for whoever asked for it (see owner.js).
    const issued = pairing.createCode({ createdBy: actor(req), ownerKey: ownerOf(req) });
    syncAfter(res);
    const portalUrl = `${req.protocol}://${req.get("host")}`;
    res.status(201).json({ ...issued, portalUrl, ...buildPairingCommands({ portalUrl, code: issued.code }) });
  });

  app.get("/api/capture/status", async (req, res) => {
    try {
      res.json(await platform.statusPayload({ localRequest: isLoopback(req), ownerKey: ownerOf(req) }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/capture/devices", (req, res) => {
    res.json({ devices: pairing.listDevices({ ownerKey: ownerOf(req) }) });
  });

  app.delete("/api/capture/devices/:id", (req, res) => {
    if (manageLimited(req, res)) return;
    if (!DEVICE_ID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid device id." });
    syncAfter(res);
    if (!pairing.revokeDevice(req.params.id, { ownerKey: ownerOf(req) })) return res.status(404).json({ error: "Device not found or already disconnected." });
    return res.json({ revoked: true, id: req.params.id });
  });

  app.post("/api/capture/jobs", (req, res) => {
    if (manageLimited(req, res)) return;
    syncAfter(res);
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    try {
      const result = platform.queueJob(body, { createdBy: actor(req), ownerKey: ownerOf(req) });
      res.status(result.status).json(result.body);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // The dry plan: what a capture would do, read before anything runs. It queues nothing and needs no companion.
  app.post("/api/capture/dry-plan", (req, res) => {
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    try {
      const result = platform.dryPlan(body);
      res.status(result.status).json(result.body);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/capture/dry-plan", (req, res) => {
    const labId = typeof req.query.labId === "string" && SAFE_LAB_ID.test(req.query.labId) ? req.query.labId : null;
    if (!labId) return res.status(400).json({ error: "Pass labId, the id of a generated lab." });
    const scope = req.query.scope === "all" ? { mode: "all" } : { mode: "missing" };
    try {
      const result = platform.dryPlan({ target: { type: "lab", labId }, scope });
      res.status(result.status).json(result.body);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // "Choose which account to use": ask the connected computer to open the sign-in window. The person signs in themselves.
  app.post("/api/capture/account-setup", (req, res) => {
    if (manageLimited(req, res)) return;
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    try {
      const result = platform.requestAccountSetup(body, { ownerKey: ownerOf(req) });
      res.status(result.status).json(result.body);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // A lab's progress is shared: anyone can look at it. `mine` says whether the person asking started the capture (null when either side is unknown).
  app.get("/api/capture/jobs", (req, res) => {
    const limit = Number.parseInt(String(req.query.limit ?? "25"), 10);
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const labId = typeof req.query.labId === "string" && SAFE_LAB_ID.test(req.query.labId) ? req.query.labId : null;
    res.json({ jobs: jobs.list({ limit: Number.isFinite(limit) ? limit : 25, status, labId, viewerOwnerKey: ownerOf(req) }) });
  });

  app.get("/api/capture/jobs/:id", (req, res) => {
    if (!isJobId(req.params.id)) return res.status(400).json({ error: "Invalid job id." });
    const job = jobs.get(req.params.id, { viewerOwnerKey: ownerOf(req) });
    return job ? res.json({ job }) : res.status(404).json({ error: "Job not found." });
  });

  app.get("/api/capture/jobs/:id/events", (req, res) => {
    if (!isJobId(req.params.id)) return res.status(400).json({ error: "Invalid job id." });
    const viewer = ownerOf(req);
    const job = jobs.get(req.params.id, { viewerOwnerKey: viewer });
    if (!job) return res.status(404).json({ error: "Job not found." });
    // Every progress window holds a socket and a listener, so the portal and each visitor may only keep so many open.
    const releaseSlot = sse.tryOpen(viewer || visitorKey(req));
    if (!releaseSlot) {
      res.setHeader("Retry-After", String(SSE_RETRY_AFTER_SEC));
      return res.status(429).json({ error: "Too many progress windows are open. Close one and try again." });
    }
    let ping = null;
    let limit = null;
    let off = () => {};
    let closed = false;
    // Every way the stream can end (finished, the person left, an error, the time limit) comes through here, once.
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      clearTimeout(limit);
      off();
      releaseSlot();
      if (!res.writableEnded) res.end();
    };
    const send = (event, data) => {
      if (closed || res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const finished = (status) => status === "done" || status === "failed" || status === "cancelled";
    res.on("close", close);
    res.on("error", close);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    send("snapshot", { job });
    if (finished(job.status)) {
      send("end", { status: job.status });
      return close();
    }
    off = jobs.subscribe(
      job.id,
      ({ job: summary, event }) => {
        send("update", { job: summary, event });
        if (finished(summary.status)) {
          send("end", { status: summary.status });
          close();
        }
      },
      { viewerOwnerKey: viewer },
    );
    ping = setInterval(() => {
      if (!closed && !res.writableEnded) res.write(": ping\n\n");
    }, 15000);
    limit = setTimeout(close, sseMaxMs);
    ping.unref?.();
    limit.unref?.();
    return undefined;
  });

  app.post("/api/capture/jobs/:id/cancel", (req, res) => {
    if (manageLimited(req, res)) return;
    if (!isJobId(req.params.id)) return res.status(400).json({ error: "Invalid job id." });
    syncAfter(res);
    // "Pause" stops after the current screenshot and keeps the rest for Resume; plain cancel drops them. Only the person who started a capture can stop it.
    const result = jobs.cancel(req.params.id, { pause: req.body?.pause === true, requesterOwnerKey: ownerOf(req) });
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
    app.get(`${prefix}/screenshots/checklist`, (req, res) => {
      if (!SAFE_LAB_ID.test(req.params.labId)) return res.status(400).json({ error: "Invalid lab id." });
      try {
        const list = platform.labChecklist(req.params.labId);
        return list.status === 200 ? res.json(list) : res.status(list.status).json({ error: list.error });
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
        const result = platform.saveLabTargets(req.params.labId, body.targets, { alsoProfile: body.alsoProfile === true, agentSource: typeof body.agentSource === "string" ? body.agentSource : undefined });
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

    app.put(base(), uploadSlot, readUpload, (req, res) => {
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
        fail(res, err);
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
        fail(res, err);
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
        fail(res, err);
      }
    });

    // "Mark as accurate" and "Clear confirmation": optional, tied to the picture's bytes, and never blocks anything.
    app.post(base("/confirm"), (req, res) => {
      if (confirmLimited(req, res)) return;
      const target = resolveTarget(req, res);
      if (!target) return;
      syncAfter(res);
      try {
        const result = screenshots.confirm(target, req.params.filename, { by: actor(req) });
        res.status(result.status).json(result.body);
      } catch (err) {
        fail(res, err);
      }
    });

    app.delete(base("/confirm"), (req, res) => {
      if (confirmLimited(req, res)) return;
      const target = resolveTarget(req, res);
      if (!target) return;
      syncAfter(res);
      try {
        const result = screenshots.unconfirm(target, req.params.filename);
        res.status(result.status).json(result.body);
      } catch (err) {
        fail(res, err);
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

  // Sharing a lab's own pictures with every lab: one picture ("Use this one for every lab"), or every eligible one.
  const labPrefixes = ["/api/lab-builder/generated/:labId", "/api/generated-labs/:labId"];
  const resolveLab = (req, res) => {
    const target = screenshots.lab(req.params.labId);
    if (target.error) {
      res.status(target.error.status).json(target.error.body);
      return null;
    }
    return target;
  };
  const bodyOf = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});
  app.post(
    labPrefixes.map((p) => `${p}/screenshots/:filename/share`),
    (req, res) => {
      if (manageLimited(req, res)) return;
      const target = resolveLab(req, res);
      if (!target) return;
      syncAfter(res);
      try {
        const body = bodyOf(req);
        const result = screenshots.shareLabPicture(target, req.params.filename, { confirm: body.confirm === true, replaceConfirmed: body.replaceConfirmed === true });
        res.status(result.status).json(result.body);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    },
  );
  app.post(
    labPrefixes.map((p) => `${p}/screenshots/share`),
    (req, res) => {
      if (manageLimited(req, res)) return;
      syncAfter(res);
      try {
        const result = screenshots.shareLabPictures(req.params.labId, { dryRun: bodyOf(req).dryRun === true });
        res.status(result.status).json(result.body);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // What deleting or replacing a lab would do to its pictures (for the confirmation); it changes nothing.
  app.get(
    labPrefixes.map((p) => `${p}/pictures`),
    (req, res) => {
      if (!SAFE_LAB_ID.test(req.params.labId)) return res.status(400).json({ error: "Invalid lab id." });
      try {
        const replacedBy = typeof req.query.replacedBy === "string" && SAFE_LAB_ID.test(req.query.replacedBy) ? req.query.replacedBy : null;
        const result = screenshots.previewLabPictures(req.params.labId, { newLabId: replacedBy });
        return res.status(result.status).json(result.body);
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    },
  );

  // ── Kept pictures: real pictures from deleted or replaced labs, kept for 90 days ──

  const KEPT_ENTRY_ID = /^[a-z0-9][a-z0-9-]{0,140}$/;
  const keptParams = (req, res) => {
    if (!KEPT_ENTRY_ID.test(req.params.entryId) || !isKeptPictureName(req.params.filename)) {
      res.status(400).json({ error: "Invalid kept picture." });
      return null;
    }
    return { entryId: req.params.entryId, filename: req.params.filename };
  };

  app.get("/api/capture/kept", (_req, res) => {
    try {
      res.json(screenshots.keptOverview());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/capture/kept/:entryId/:filename", (req, res) => {
    const ids = keptParams(req, res);
    if (!ids) return undefined;
    const found = screenshots.keptPicture(ids.entryId, ids.filename);
    if (!found) return res.status(404).json({ error: "That kept picture was not found." });
    const type = /\.png(\.previous)?$/i.test(ids.filename) ? "image/png" : /\.webp(\.previous)?$/i.test(ids.filename) ? "image/webp" : "image/jpeg";
    const download = String(req.query.download || "") === "1";
    res.set({
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      ...(download ? { "Content-Disposition": `attachment; filename="${ids.filename.replace(/\.previous$/i, "-earlier")}"` } : {}),
    });
    return res.send(found.bytes);
  });

  app.post("/api/capture/kept/:entryId/:filename/restore", (req, res) => {
    if (manageLimited(req, res)) return;
    const ids = keptParams(req, res);
    if (!ids) return;
    syncAfter(res);
    try {
      const body = bodyOf(req);
      const result = screenshots.restoreKept(ids.entryId, ids.filename, { to: body.to === "library" ? "library" : "lab", labId: typeof body.labId === "string" && SAFE_LAB_ID.test(body.labId) ? body.labId : null, confirm: body.confirm === true });
      res.status(result.status).json(result.body);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete forever needs the person's confirmation in the request itself, so no script removes a kept picture by accident.
  app.delete("/api/capture/kept/:entryId/:filename", (req, res) => {
    if (manageLimited(req, res)) return;
    const ids = keptParams(req, res);
    if (!ids) return;
    if (String(req.query.confirm || "") !== "true" && bodyOf(req).confirm !== true) return res.status(400).json({ error: "Confirm first: a picture deleted here cannot be restored." });
    syncAfter(res);
    try {
      const result = screenshots.removeKept(ids.entryId, ids.filename);
      return res.status(result.status).json(result.body);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/capture/kept/purge", (req, res) => {
    if (manageLimited(req, res)) return;
    syncAfter(res);
    try {
      res.json(screenshots.purgeKept());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/capture/library/notice/dismiss", (req, res) => {
    if (manageLimited(req, res)) return;
    try {
      res.json(platform.dismissLocationNotice());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Pictures that look like the wrong screen: list them, move them to the kept pictures list, or keep one ──

  app.get("/api/capture/suspect-pictures", (req, res) => {
    const labId = typeof req.query.labId === "string" && req.query.labId ? req.query.labId : null;
    if (labId && !SAFE_LAB_ID.test(labId)) return res.status(400).json({ error: "Invalid lab id." });
    try {
      const result = screenshots.suspectPictures({ labId });
      return res.status(result.status).json(result.body);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // A dry run unless the request says `dryRun: false` and `confirm: true`: nothing moves without the person's choice in the request itself.
  app.post("/api/capture/suspect-pictures/quarantine", (req, res) => {
    if (manageLimited(req, res)) return;
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const dryRun = !(body.dryRun === false && body.confirm === true);
    const items = Array.isArray(body.items) ? body.items.slice(0, 500).map((i) => ({ scope: i?.scope === "lab" ? "lab" : "library", labId: typeof i?.labId === "string" && SAFE_LAB_ID.test(i.labId) ? i.labId : null, filename: String(i?.filename || "").slice(0, 128) })).filter((i) => i.scope === "library" || i.labId) : null;
    const labId = typeof body.labId === "string" && SAFE_LAB_ID.test(body.labId) ? body.labId : null;
    if (!dryRun) syncAfter(res);
    try {
      const result = screenshots.quarantineWrongPictures({ dryRun, items, includeProbable: body.includeProbable === true, labId });
      return res.status(result.status).json(result.body);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // A shared picture for the panel's preview.
  app.get("/api/capture/library/screenshots/:filename/image", (req, res) => {
    const found = screenshots.libraryPicture(req.params.filename);
    if (!found) return res.status(404).json({ error: "That shared picture was not found." });
    const type = /\.png$/i.test(found.filename) ? "image/png" : /\.webp$/i.test(found.filename) ? "image/webp" : "image/jpeg";
    res.set({ "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" });
    return res.send(found.bytes);
  });

  // ── Move the shared library between computers: export a ZIP, import a ZIP ──

  app.get("/api/capture/library/export", async (req, res) => {
    if (manageLimited(req, res)) return;
    try {
      const { buffer, count } = await buildLibraryExport(screenshots);
      res.set({ "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${EXPORT_ZIP_NAME}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Export-Warning": "Check that no picture shows account names or customer data.", "X-Picture-Count": String(count) });
      res.send(buffer);
    } catch (err) {
      res.status(500).json({ error: `Could not build the export: ${err.message}` });
    }
  });

  const importMultipart = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMPORT_ZIP_BYTES, files: 1, fields: 4, fieldSize: 1024, parts: 6 } }).single("file");
  const importRaw = express.raw({ type: (req) => /^application\/(?:zip|x-zip-compressed|octet-stream)(?:\s*;|$)/i.test(String(req.headers["content-type"] || "")), limit: MAX_IMPORT_ZIP_BYTES + 4096 });
  const truthy = (value) => ["true", "1", "on", "yes"].includes(String(value ?? "").toLowerCase());

  app.post("/api/capture/library/import", uploadSlot, (req, res) => {
    if (manageLimited(req, res)) return;
    const run = (zip, options) => {
      syncAfter(res);
      try {
        const result = importLibraryZip(screenshots, zip, options);
        res.status(result.status).json(result.body);
      } catch (err) {
        fail(res, err);
      }
    };
    if (String(req.headers["content-type"] || "").toLowerCase().startsWith("multipart/form-data")) {
      importMultipart(req, res, (err) => {
        if (err) return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: err.code === "LIMIT_FILE_SIZE" ? `The ZIP is larger than ${Math.round(MAX_IMPORT_ZIP_BYTES / 1048576)} MB.` : "The upload could not be read." });
        return run(req.file?.buffer || null, { replace: truthy(req.body?.replace ?? req.query.replace), dryRun: truthy(req.body?.dryRun ?? req.query.dryRun) });
      });
      return;
    }
    importRaw(req, res, (err) => {
      if (err) return res.status(err.status === 413 ? 413 : 400).json({ error: err.status === 413 ? "The ZIP is too large." : "The upload could not be read." });
      return run(Buffer.isBuffer(req.body) && req.body.length ? req.body : null, { replace: truthy(req.query.replace), dryRun: truthy(req.query.dryRun) });
    });
  });

  // Who else shows the library's picture for a slot, so a retake can say who it affects.
  app.get("/api/capture/library/screenshots/:filename/usage", (req, res) => {
    const exceptLabId = typeof req.query.labId === "string" && SAFE_LAB_ID.test(req.query.labId) ? req.query.labId : null;
    try {
      const result = screenshots.libraryUsage(req.params.filename, { exceptLabId });
      res.status(result.status).json(result.body);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

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
    // The owner key stays inside the portal: it is how a job finds the computer its person paired, never something a response carries.
    req.captureDevice = { ...auth.device, ownerKey: auth.ownerKey };
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
    // A request for this computer (choose the account) is given once, on the check-in that follows the click.
    const commands = pairing.takeCommands(req.captureDevice.id);
    res.json({ ok: true, cancelRequested: touched.cancelRequested, serverTime: new Date().toISOString(), tokenExpiresAt: new Date(req.captureDevice.expiresAt).toISOString(), ...(commands.length ? { commands } : {}) });
  });

  app.get(`${COMPANION_PREFIX}/next`, (req, res) => {
    pairing.heartbeat(req.captureDevice.id, { signedInProducts: undefined, busy: false, companionVersion: req.get("x-companion-version") });
    const claimed = jobs.claimNext(req.captureDevice);
    if (!claimed) {
      // Nothing to capture. A header (ignored by older companions) tells a newer one to check in now: something is waiting for it.
      if (pairing.hasPendingCommands(req.captureDevice.id)) res.setHeader("X-Companion-Wake", "1");
      return res.status(204).end();
    }
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

  app.put(`${COMPANION_PREFIX}/jobs/:id/shots/:filename`, uploadSlot, readUpload, (req, res) => {
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
        // A companion's picture counts as captured only when its evidence proves the screen (see verifyImage `requireProof`).
        requireProof: true,
        productLabel: plannedShot?.capture?.path?.[0] || "",
        companionVersion: String(req.get("x-companion-version") || ""),
        jobId: job.id,
        retake: job.options?.retake === true,
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
      fail(res, err);
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
    const result = jobs.complete(req.params.id, req.captureDevice.id, { message: body.message, fatalError: body.fatalError, paused: body.paused, created: body.created, scratch: body.scratch, signIn: body.signIn, account: body.account, needsAccount: body.needsAccount });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    if (result.job.target.type === "lab") screenshots.flushLab(result.job.target.labId);
    else void screenshots.flushLibrary().catch(() => {});
    return res.json({ job: result.job });
  });

  app.all(`${COMPANION_PREFIX}/*rest`, (_req, res) => res.status(404).json({ error: "Unknown companion endpoint." }));

  return platform;
}
