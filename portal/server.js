/**
 * Copilot Studio Labs — Provisioning Portal Server
 */

import "dotenv/config";
import express from "express";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import multer from "multer";
import { extname, join, resolve } from "path";
import { discoverLabs, getLabContent } from "./lib/labs.js";
import { validateLab, validateAllLabs } from "./lib/validator.js";
import { exportLabs } from "./lib/exporter.js";
import { sendMail } from "./lib/mailer.js";
import {
  BRANDING_UPLOADS_DIR,
  deleteBrandingLogo,
  ensureBrandingStorage,
  loadBranding,
  prependBrandingBanner,
  saveBranding,
  updateBrandingLogo,
} from "./lib/branding.js";
import { getIndustries, getRoles, getScenario, getSuggestedConfig } from "./lib/scenarios.js";
import { marked } from "marked";

/* ── Mermaid extension for marked ───────────────────────────────────────────
 * Converts ```mermaid fenced code blocks into <div class="mermaid"> elements
 * so the client-side Mermaid library renders them as SVG diagrams.
 * GitHub also renders these blocks natively in markdown previews.           */
const mermaidExtension = {
  name: "mermaid",
  renderer: {
    code({ text, lang }) {
      if (lang === "mermaid") {
        const escaped = text
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;");
        return `<div class="mermaid">${escaped}</div>`;
      }
      return false; // fall through to default renderer
    },
  },
};
marked.use(mermaidExtension);
import {
  getAllLabResources, getLabResources, checkPrerequisites,
  provision, deprovision, getProvisioningStatus,
} from "./lib/provisioner.js";
import {
  loadSecretsFromKeyVault, getKeyVaultStatus, syncSecretsToKeyVault,
  provisionKeyVault,
} from "./lib/keyvault.js";
import {
  listEnvironments, getEnvironment, createEnvironment, deleteEnvironment,
  getSecureScore, getRecommendations, applyRemediation, getTenantSettings,
  getPendingDeviceCode,
} from "./lib/powerplatform.js";
import {
  approveRequest,
  getRequest,
  listRequests,
  loadApprovalConfig,
  rejectRequest,
  saveApprovalConfig,
  submitRequest,
} from "./lib/approvals.js";
import { getCurrentUser, clearTokens } from "./lib/auth.js";

const app = express();
const PORT = process.env.PORT || 3000;
const PROVISION_JOB_RETENTION_MS = 60 * 60 * 1000;
const LABS_ROUTE = "/labs";
const labsRoot = resolve(import.meta.dirname, "..", "labs");
const pdfRoot = resolve(import.meta.dirname, "..", "dist", "lab-pdfs");
const dataRoot = resolve(import.meta.dirname, "data");
const feedbackFilePath = resolve(dataRoot, "feedback.json");
const provisionJobs = new Map();
const BRANDING_MAX_FILE_SIZE = 2 * 1024 * 1024;

ensureBrandingStorage();

const brandingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: BRANDING_MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const allowedMimeTypes = new Set(["image/png", "image/jpeg", "image/svg+xml"]);
    if (allowedMimeTypes.has(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error("Only PNG, JPG, and SVG logos are supported."));
  },
});

function encodeUrlPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function rewriteLabAssetUrl(url, labId) {
  if (!url || /^(?:[a-z][a-z\d+.-]*:|\/\/|\/|#)/i.test(url)) {
    return url;
  }

  const [, path = "", suffix = ""] = url.match(/^([^?#]*)([?#].*)?$/) || [];
  const normalizedPath = path.replace(/\\/g, "/");
  const resolvedSegments = [];

  for (const segment of normalizedPath.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (resolvedSegments.length === 0) return url;
      resolvedSegments.pop();
      continue;
    }
    resolvedSegments.push(segment);
  }

  if (resolvedSegments.length === 0) return url;

  return `${LABS_ROUTE}/${encodeURIComponent(labId)}/${encodeUrlPath(resolvedSegments.join("/"))}${suffix}`;
}

function rewriteLabHtmlAssetUrls(html, labId) {
  return html.replace(
    /<(img|a)\b([^>]*?)\s(src|href)=(["'])(.*?)\4([^>]*)>/gi,
    (match, tag, before, attribute, quote, url, after) => {
      const tagName = tag.toLowerCase();
      const attributeName = attribute.toLowerCase();
      if ((tagName === "img" && attributeName !== "src") || (tagName === "a" && attributeName !== "href")) {
        return match;
      }

      const rewrittenUrl = rewriteLabAssetUrl(url, labId);
      return `<${tag}${before} ${attribute}=${quote}${rewrittenUrl}${quote}${after}>`;
    },
  );
}

function collectPngFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) return collectPngFiles(entryPath);
    return entry.isFile() && entry.name.toLowerCase().endsWith(".png") ? [entryPath] : [];
  });
}

function isLabPdfFresh(labId, pdfPath) {
  if (!existsSync(pdfPath)) return false;

  const indexPath = join(labsRoot, labId, "index.md");
  if (!existsSync(indexPath)) return false;

  const pdfMtime = statSync(pdfPath).mtimeMs;
  if (statSync(indexPath).mtimeMs > pdfMtime) return false;

  return collectPngFiles(join(labsRoot, labId, "assets"))
    .every((assetPath) => statSync(assetPath).mtimeMs <= pdfMtime);
}

function getBrandingLogoExtension(file) {
  if (file.mimetype === "image/png") return ".png";
  if (file.mimetype === "image/jpeg") return ".jpg";
  if (file.mimetype === "image/svg+xml") return ".svg";
  return extname(file.originalname || "").toLowerCase() || ".png";
}

function sanitizeBrandingPayload(payload = {}) {
  return {
    companyName: String(payload.companyName ?? "").trim(),
    primaryColor: String(payload.primaryColor ?? "").trim(),
    tagline: String(payload.tagline ?? "").trim(),
  };
}

function loadFeedbackEntries() {
  try {
    if (!existsSync(feedbackFilePath)) return [];
    const raw = readFileSync(feedbackFilePath, "utf8").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveFeedbackEntries(entries) {
  mkdirSync(dataRoot, { recursive: true });
  writeFileSync(feedbackFilePath, JSON.stringify(entries, null, 2));
}

function estimateProvisionSteps(labIds, subscriptionId) {
  let totalSteps = subscriptionId ? 1 : 0;
  totalSteps += 1; // bicep deployment

  for (const labId of labIds) {
    const labResources = getLabResources(labId);
    if (!labResources) continue;

    for (const resource of labResources.resources) {
      if (resource.manual || !resource.provisionable || resource.type === "sharepoint-site") {
        totalSteps += 1;
      }
    }
  }

  return Math.max(totalSteps, 1);
}

function cleanupProvisionJobs() {
  const cutoff = Date.now() - PROVISION_JOB_RETENTION_MS;
  for (const [jobId, job] of provisionJobs.entries()) {
    if (job.status !== "running" && new Date(job.updatedAt).getTime() < cutoff) {
      provisionJobs.delete(jobId);
    }
  }
}

function createProvisionJob({ labIds, location, baseName, subscriptionId }) {
  cleanupProvisionJobs();

  const now = new Date().toISOString();
  const job = {
    jobId: randomUUID(),
    labIds,
    location,
    baseName,
    subscriptionId: subscriptionId || null,
    status: "running",
    totalSteps: estimateProvisionSteps(labIds, subscriptionId),
    steps: [],
    stepIndex: new Map(),
    result: null,
    createdAt: now,
    updatedAt: now,
  };

  provisionJobs.set(job.jobId, job);
  return job;
}

function updateProvisionJob(job, step) {
  const currentIndex = job.stepIndex.get(step.step);
  const nextStep = {
    ...step,
    detail: step.detail || "",
  };

  if (currentIndex === undefined) {
    job.stepIndex.set(step.step, job.steps.length);
    job.steps.push(nextStep);
  } else {
    const currentStep = job.steps[currentIndex];
    job.steps[currentIndex] = {
      ...currentStep,
      ...nextStep,
      detail: nextStep.detail || currentStep.detail || "",
    };
  }

  job.updatedAt = new Date().toISOString();
}

function summarizeProvisionJob(job) {
  if (job.result) {
    return {
      deployed: job.result.success?.length || 0,
      skipped: job.result.skipped?.length || 0,
      failed: job.result.failed?.length || 0,
    };
  }

  return job.steps.reduce((summary, step) => {
    if (step.status === "done") summary.deployed += 1;
    if (step.status === "skipped") summary.skipped += 1;
    if (step.status === "failed") summary.failed += 1;
    return summary;
  }, { deployed: 0, skipped: 0, failed: 0 });
}

function serializeProvisionJob(job) {
  const completedSteps = job.steps.filter((step) => step.status !== "running").length;
  const currentStep = job.steps.find((step) => step.status === "running") || null;

  return {
    jobId: job.jobId,
    baseName: job.baseName,
    location: job.location,
    status: job.status,
    totalSteps: job.totalSteps,
    completedSteps,
    currentStep,
    steps: job.steps,
    summary: summarizeProvisionJob(job),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

// Load secrets from Key Vault before starting (falls back to .env)
const kvResult = await loadSecretsFromKeyVault();

app.use(express.json({ limit: "10mb" }));
app.use(express.static(resolve(import.meta.dirname, "public")));
app.use(LABS_ROUTE, express.static(labsRoot));

// ── API Routes ──────────────────────────────────────────────────────────────

/** GET /api/scenarios — List all industry and role scenarios */
app.get("/api/scenarios", (_req, res) => {
  try {
    res.json({
      industries: getIndustries(),
      roles: getRoles(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/scenarios/:type/:id — Get a single industry or role scenario */
app.get("/api/scenarios/:type/:id", (req, res) => {
  const { type, id } = req.params;

  if (!["industry", "role"].includes(type)) {
    return res.status(400).json({ error: "Scenario type must be 'industry' or 'role'" });
  }

  const scenario = getScenario(type, id);
  if (!scenario) return res.status(404).json({ error: "Scenario not found" });

  res.json(scenario);
});

/** POST /api/scenarios/configure — Build a suggested template config overlay */
app.post("/api/scenarios/configure", (req, res) => {
  const { industry, roles = [] } = req.body;
  if (!industry) return res.status(400).json({ error: "industry is required" });

  try {
    const config = getSuggestedConfig(industry, roles);
    if (!config) return res.status(404).json({ error: "Industry scenario not found" });
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/labs — List all available labs with metadata */
app.get("/api/labs", (_req, res) => {
  try {
    const labs = discoverLabs();
    res.json({ labs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/labs/:id/pdf — Download a pre-generated lab walkthrough PDF */
app.get("/api/labs/:id/pdf", (req, res) => {
  const { id } = req.params;
  const content = getLabContent(id);
  if (!content) return res.status(404).json({ error: "Lab not found" });

  const pdfPath = join(pdfRoot, `${id}-walkthrough.pdf`);
  if (!isLabPdfFresh(id, pdfPath)) {
    return res.status(503).json({
      error: `PDF not generated yet. Run \`npm run generate -- --lab=${id}\` in tools/lab-pdf/.`,
    });
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${id}-walkthrough.pdf"`);
  res.sendFile(pdfPath);
});

/** GET /api/labs/:id — Get a single lab's full content as HTML */
app.get("/api/labs/:id", (req, res) => {
  const content = getLabContent(req.params.id);
  if (!content) return res.status(404).json({ error: "Lab not found" });
  const branding = loadBranding();
  const brandedMarkdown = prependBrandingBanner(content, branding);
  const html = rewriteLabHtmlAssetUrls(marked.parse(brandedMarkdown), req.params.id);
  res.json({ id: req.params.id, html, markdown: brandedMarkdown });
});

/** POST /api/feedback — Store lab section feedback */
app.post("/api/feedback", (req, res) => {
  const labId = String(req.body?.labId ?? "").trim();
  const section = String(req.body?.section ?? "").trim();
  const rating = String(req.body?.rating ?? "").trim().toLowerCase();
  const comment = String(req.body?.comment ?? "").trim();

  if (!labId) return res.status(400).json({ error: "labId is required" });
  if (!section) return res.status(400).json({ error: "section is required" });
  if (!["up", "down"].includes(rating)) {
    return res.status(400).json({ error: "rating must be 'up' or 'down'" });
  }

  try {
    const entries = loadFeedbackEntries();
    const entry = {
      labId,
      section,
      rating,
      comment,
      timestamp: new Date().toISOString(),
    };
    entries.push(entry);
    saveFeedbackEntries(entries);
    res.status(201).json({ success: true, entry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/feedback/:labId — Return feedback for a single lab */
app.get("/api/feedback/:labId", (req, res) => {
  try {
    const feedback = loadFeedbackEntries().filter((entry) => entry.labId === req.params.labId);
    res.json({ labId: req.params.labId, feedback });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/branding — Return current branding configuration */
app.get("/api/branding", (_req, res) => {
  res.json(loadBranding());
});

/** POST /api/branding — Save branding configuration */
app.post("/api/branding", (req, res) => {
  try {
    const payload = sanitizeBrandingPayload(req.body);
    if (!payload.companyName) {
      return res.status(400).json({ error: "companyName is required" });
    }

    const current = loadBranding();
    const branding = saveBranding({
      ...current,
      ...payload,
    });
    res.json(branding);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/branding/logo — Upload a branding logo */
app.post("/api/branding/logo", (req, res) => {
  brandingUpload.single("logo")(req, res, (err) => {
    if (err) {
      const isSizeError = err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE";
      const status = isSizeError || err.message.includes("Only PNG") ? 400 : 500;
      res.status(status).json({
        error: isSizeError
          ? "Logo must be 2 MB or smaller."
          : err.message,
      });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: "Logo file is required." });
      return;
    }

    try {
      const nextFileName = `logo-${Date.now()}${getBrandingLogoExtension(req.file)}`;
      const targetPath = resolve(BRANDING_UPLOADS_DIR, nextFileName);

      writeFileSync(targetPath, req.file.buffer);
      const branding = updateBrandingLogo(nextFileName);

      res.json(branding);
    } catch (uploadErr) {
      res.status(500).json({ error: uploadErr.message });
    }
  });
});

/** DELETE /api/branding/logo — Remove the uploaded branding logo */
app.delete("/api/branding/logo", (_req, res) => {
  try {
    const branding = deleteBrandingLogo();
    res.json(branding);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/validate — Run validation against all labs */
app.get("/api/validate", (_req, res) => {
  try {
    res.json(validateAllLabs());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/validate/:labId — Run validation against a single lab */
app.get("/api/validate/:labId", (req, res) => {
  try {
    res.json(validateLab(req.params.labId));
  } catch (err) {
    if (err.message.startsWith("Lab not found:")) {
      return res.status(404).json({ error: "Lab not found" });
    }
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/export — Download a ZIP of selected labs */
app.post("/api/export", async (req, res) => {
  const { labs: labIds = [], replacements = {} } = req.body;
  if (!labIds.length) return res.status(400).json({ error: "No labs selected" });

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", "attachment; filename=copilot-studio-labs.zip");

  try {
    await exportLabs(labIds, replacements, res);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

/** POST /api/email — Email lab package to recipients */
app.post("/api/email", async (req, res) => {
  const { to = [], labs: labIds = [], subject, replacements = {} } = req.body;
  if (!to.length) return res.status(400).json({ error: "No recipients specified" });
  if (!labIds.length) return res.status(400).json({ error: "No labs selected" });

  try {
    // Build ZIP buffer in memory
    const { PassThrough } = await import("stream");
    const chunks = [];
    const passThrough = new PassThrough();
    passThrough.on("data", (chunk) => chunks.push(chunk));

    await exportLabs(labIds, replacements, passThrough);
    const zipBuffer = Buffer.concat(chunks);

    const allLabs = discoverLabs();
    const selectedLabs = allLabs.filter((l) => labIds.includes(l.id));
    const labList = selectedLabs.map((l) => `<li><strong>${l.title}</strong> — ${l.difficulty}, ${l.time}</li>`).join("\n");

    const result = await sendMail({
      to,
      subject: subject || "Your Copilot Studio Labs Package",
      html: `
        <div style="font-family: Segoe UI, Arial, sans-serif; max-width: 600px;">
          <h2>⚡ Your Copilot Studio Labs</h2>
          <p>Attached is your customized lab package containing ${labIds.length} lab(s):</p>
          <ul>${labList}</ul>
          <p>Unzip the attachment and follow each lab's <code>index.md</code> to get started.</p>
          <hr />
          <p style="color: #666; font-size: 12px;">
            Sent from the Copilot Studio Labs Provisioning Portal
          </p>
        </div>
      `,
      attachments: [{
        filename: "copilot-studio-labs.zip",
        content: zipBuffer,
        contentType: "application/zip",
      }],
    });

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/config — Return current deployment configuration (non-secret) */
app.get("/api/config", (_req, res) => {
  res.json({
    portal: {
      port: PORT,
      nodeVersion: process.version,
    },
    email: {
      transport: process.env.SMTP_HOST ? "smtp" : process.env.AZURE_TENANT_ID ? "graph" : "none",
      from: process.env.MAIL_FROM || "(not configured)",
      smtpHost: process.env.SMTP_HOST || null,
    },
    azure: {
      tenantId: process.env.AZURE_TENANT_ID ? "configured" : "not set",
      clientId: process.env.AZURE_CLIENT_ID ? "configured" : "not set",
      clientSecret: process.env.AZURE_CLIENT_SECRET ? "configured" : "not set",
    },
    keyVault: getKeyVaultStatus(),
    secretSource: kvResult.source,
    deployment: {
      webAppName: process.env.AZURE_WEBAPP_NAME || null,
      resourceGroup: process.env.AZURE_RESOURCE_GROUP || null,
      mcpEndpoint: process.env.MCP_SERVER_URL || null,
    },
  });
});

// ── Provisioning API Routes ─────────────────────────────────────────────────

/** GET /api/provision/resources — List all lab resource requirements */
app.get("/api/provision/resources", (_req, res) => {
  try {
    res.json({ labs: getAllLabResources() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/provision/resources/:labId — Resources for a specific lab */
app.get("/api/provision/resources/:labId", (req, res) => {
  const resources = getLabResources(req.params.labId);
  if (!resources) return res.status(404).json({ error: "Lab not found" });
  res.json(resources);
});

/** GET /api/provision/prerequisites — Check if provisioning prerequisites are met */
app.get("/api/provision/prerequisites", async (_req, res) => {
  try {
    const result = await checkPrerequisites();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/provision/deploy — Deploy Azure resources for selected labs */
app.post("/api/provision/deploy", async (req, res) => {
  const {
    labs: labIds = [],
    location = "eastus",
    baseName = "copilot-labs",
    subscriptionId,
    envVars = {},
  } = req.body;

  if (!labIds.length) return res.status(400).json({ error: "No labs selected" });

  try {
    const job = createProvisionJob({ labIds, location, baseName, subscriptionId });

    void (async () => {
      try {
        const result = await provision({
          labIds,
          location,
          baseName,
          subscriptionId,
          envVars,
          onProgress: (step) => updateProvisionJob(job, step),
        });

        job.result = result;
        job.status = result.failed?.length ? "failed" : "done";
        job.updatedAt = new Date().toISOString();
      } catch (err) {
        updateProvisionJob(job, {
          step: "deployment-error",
          status: "failed",
          detail: err.message,
        });
        job.result = {
          success: [],
          skipped: [],
          failed: [{ step: "deployment-error", error: err.message }],
        };
        job.status = "failed";
        job.updatedAt = new Date().toISOString();
      }
    })();

    res.status(202).json(serializeProvisionJob(job));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/provision/progress/:jobId — Current provisioning progress for a job */
app.get("/api/provision/progress/:jobId", (req, res) => {
  const job = provisionJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Provisioning job not found" });

  res.json(serializeProvisionJob(job));
});

/** POST /api/provision/destroy — De-provision (delete) Azure resources */
app.post("/api/provision/destroy", async (req, res) => {
  const { baseName = "copilot-labs" } = req.body;

  try {
    const result = await deprovision({
      baseName,
      onProgress: () => {},
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/provision/status/:baseName — Check provisioning status */
app.get("/api/provision/status/:baseName", (req, res) => {
  try {
    const status = getProvisioningStatus(req.params.baseName);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Key Vault API Routes ────────────────────────────────────────────────────

/** GET /api/keyvault/status — Key Vault configuration status */
app.get("/api/keyvault/status", (_req, res) => {
  res.json(getKeyVaultStatus());
});

/** POST /api/keyvault/provision — Create a Key Vault */
app.post("/api/keyvault/provision", async (req, res) => {
  const { baseName = "copilot-labs", resourceGroup, location = "eastus" } = req.body;
  if (!resourceGroup) return res.status(400).json({ error: "resourceGroup is required" });

  try {
    const result = await provisionKeyVault({ baseName, resourceGroup, location });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/keyvault/sync — Push current env secrets to Key Vault */
app.post("/api/keyvault/sync", async (_req, res) => {
  try {
    const results = await syncSecretsToKeyVault();
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Power Platform Admin API Routes ─────────────────────────────────────────

/** GET /api/pp/auth/status — Check auth status and pending device codes */
app.get("/api/pp/auth/status", async (_req, res) => {
  const user = await getCurrentUser();
  const pending = getPendingDeviceCode();
  res.json({ authenticated: !!user, user, pendingDeviceCode: pending });
});

/** POST /api/pp/auth/logout — Clear cached tokens */
app.post("/api/pp/auth/logout", async (_req, res) => {
  await clearTokens();
  res.json({ success: true });
});

/** GET /api/pp/environments — List all environments (triggers auth if needed) */
app.get("/api/pp/environments", async (_req, res) => {
  try {
    const environments = await listEnvironments();
    res.json({ environments });
  } catch (err) {
    const pending = getPendingDeviceCode();
    if (pending) {
      return res.status(401).json({ authRequired: true, deviceCode: pending });
    }
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/pp/environments/:id — Get environment details */
app.get("/api/pp/environments/:id", async (req, res) => {
  try {
    const env = await getEnvironment(req.params.id);
    res.json(env);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/pp/environments — Create a new environment */
app.post("/api/pp/environments", async (req, res) => {
  const { displayName, location, environmentType, currency, language, securityGroupId } = req.body;
  if (!displayName) return res.status(400).json({ error: "displayName is required" });

  try {
    const result = await createEnvironment({
      displayName, location, environmentType, currency, language, securityGroupId,
    });
    res.json({ success: true, environment: result });
  } catch (err) {
    const pending = getPendingDeviceCode();
    if (pending) return res.status(401).json({ authRequired: true, deviceCode: pending });
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/pp/approval-config — Return current approval workflow configuration */
app.get("/api/pp/approval-config", (_req, res) => {
  try {
    res.json(loadApprovalConfig());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/pp/approval-config — Save approval workflow configuration */
app.post("/api/pp/approval-config", (req, res) => {
  try {
    const config = saveApprovalConfig(req.body || {});
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/pp/approval-requests — Submit an environment request for approval */
app.post("/api/pp/approval-requests", async (req, res) => {
  const { displayName, location, environmentType, currency, language, securityGroupId } = req.body || {};
  if (!displayName) return res.status(400).json({ error: "displayName is required" });

  try {
    const user = await getCurrentUser();
    const portalUrl = `${req.protocol}://${req.get("host")}`;
    const requestRecord = await submitRequest({
      displayName,
      location,
      environmentType,
      currency,
      language,
      securityGroupId,
      portalUrl,
      requestedBy: user?.username || "unknown",
      requestedByName: user?.name || user?.username || "",
    });

    res.json({
      success: true,
      request: requestRecord,
      environment: requestRecord.environment || null,
    });
  } catch (err) {
    const pending = getPendingDeviceCode();
    if (pending) return res.status(401).json({ authRequired: true, deviceCode: pending });
    res.status(/required/i.test(err.message) ? 400 : 500).json({ error: err.message });
  }
});

/** GET /api/pp/approval-requests — List approval requests */
app.get("/api/pp/approval-requests", (req, res) => {
  try {
    const requests = listRequests({ status: req.query.status });
    res.json({ requests });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/pp/approval-requests/:id — Get a single approval request */
app.get("/api/pp/approval-requests/:id", (req, res) => {
  try {
    const requestRecord = getRequest(req.params.id);
    if (!requestRecord) return res.status(404).json({ error: "Approval request not found" });
    res.json({ request: requestRecord });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/pp/approval-requests/:id/approve — Approve and provision */
app.post("/api/pp/approval-requests/:id/approve", async (req, res) => {
  try {
    const user = await getCurrentUser();
    const requestRecord = await approveRequest(
      req.params.id,
      user?.username || req.body?.decidedBy || "portal-approver",
      req.body?.reason || "",
    );
    res.json({ success: true, request: requestRecord, environment: requestRecord.environment || null });
  } catch (err) {
    const pending = getPendingDeviceCode();
    if (pending) return res.status(401).json({ authRequired: true, deviceCode: pending });
    const status = err.message.includes("not found") ? 404 : err.message.includes("Only pending") ? 409 : 500;
    res.status(status).json({ error: err.message });
  }
});

/** POST /api/pp/approval-requests/:id/reject — Reject request */
app.post("/api/pp/approval-requests/:id/reject", async (req, res) => {
  try {
    const user = await getCurrentUser();
    const requestRecord = await rejectRequest(
      req.params.id,
      user?.username || req.body?.decidedBy || "portal-approver",
      req.body?.reason || "",
    );
    res.json({ success: true, request: requestRecord });
  } catch (err) {
    const status = err.message.includes("not found") ? 404 : err.message.includes("Only pending") ? 409 : 500;
    res.status(status).json({ error: err.message });
  }
});

/** GET /api/pp/approval-callback — Convenience callback for actionable links */
app.get("/api/pp/approval-callback", async (req, res) => {
  const { requestId, callbackToken, decision, decidedBy, reason } = req.query;
  const normalizedDecision = String(decision || "").toLowerCase();

  if (!["approved", "rejected"].includes(normalizedDecision)) {
    return res.status(400).send("decision must be approved or rejected.");
  }

  try {
    const requestRecord = getRequest(String(requestId || ""));
    if (!requestRecord) return res.status(404).send("Approval request not found.");
    if (requestRecord.callbackToken !== callbackToken) return res.status(401).send("Invalid callback token.");

    const result = normalizedDecision === "rejected"
      ? await rejectRequest(requestRecord.id, String(decidedBy || "callback"), String(reason || ""))
      : await approveRequest(requestRecord.id, String(decidedBy || "callback"), String(reason || ""));

    res.type("html").send(`
      <html><body style="font-family: Segoe UI, Arial, sans-serif; padding: 24px;">
        <h2>${result.status === "rejected" ? "Request rejected" : "Request processed"}</h2>
        <p><strong>${result.displayName}</strong> is now <strong>${result.status}</strong>.</p>
        <p>You can close this window and return to the portal.</p>
      </body></html>
    `);
  } catch (err) {
    const pending = getPendingDeviceCode();
    if (pending) return res.status(401).send("Authentication required in the portal before approving this request.");
    res.status(500).send(err.message);
  }
});

/** POST /api/pp/approval-callback — Receive external approval decisions */
app.post("/api/pp/approval-callback", async (req, res) => {
  const { requestId, callbackToken, decision, decidedBy, reason } = req.body || {};
  const normalizedDecision = String(decision || "").toLowerCase();

  if (!requestId || !callbackToken || !normalizedDecision) {
    return res.status(400).json({ error: "requestId, callbackToken, and decision are required" });
  }
  if (!["approved", "rejected"].includes(normalizedDecision)) {
    return res.status(400).json({ error: "decision must be approved or rejected" });
  }

  try {
    const requestRecord = getRequest(requestId);
    if (!requestRecord) return res.status(404).json({ error: "Approval request not found" });
    if (requestRecord.callbackToken !== callbackToken) {
      return res.status(401).json({ error: "Invalid callback token" });
    }

    const result = normalizedDecision === "rejected"
      ? await rejectRequest(requestId, decidedBy || "callback", reason || "")
      : await approveRequest(requestId, decidedBy || "callback", reason || "");

    res.json({ success: true, request: result, environment: result.environment || null });
  } catch (err) {
    const pending = getPendingDeviceCode();
    if (pending) return res.status(401).json({ authRequired: true, deviceCode: pending });
    const status = err.message.includes("not found") ? 404 : err.message.includes("Invalid callback token") ? 401 : 500;
    res.status(status).json({ error: err.message });
  }
});

/** DELETE /api/pp/environments/:id — Delete an environment */
app.delete("/api/pp/environments/:id", async (req, res) => {
  try {
    const result = await deleteEnvironment(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/pp/secure-score — Get Secure Score */
app.get("/api/pp/secure-score", async (_req, res) => {
  try {
    const score = await getSecureScore();
    res.json(score);
  } catch (err) {
    const pending = getPendingDeviceCode();
    if (pending) return res.status(401).json({ authRequired: true, deviceCode: pending });
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/pp/recommendations — Get security recommendations */
app.get("/api/pp/recommendations", async (_req, res) => {
  try {
    const recommendations = await getRecommendations();
    res.json({ recommendations });
  } catch (err) {
    const pending = getPendingDeviceCode();
    if (pending) return res.status(401).json({ authRequired: true, deviceCode: pending });
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/pp/remediate — Apply a remediation action */
app.post("/api/pp/remediate", async (req, res) => {
  const { recommendationId, action } = req.body;
  if (!recommendationId) return res.status(400).json({ error: "recommendationId is required" });

  try {
    const result = await applyRemediation(recommendationId, action);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/pp/tenant-settings — Get tenant settings */
app.get("/api/pp/tenant-settings", async (_req, res) => {
  try {
    const settings = await getTenantSettings();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SPA fallback ────────────────────────────────────────────────────────────
app.get("*", (_req, res) => {
  res.sendFile(resolve(import.meta.dirname, "public", "index.html"));
});

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n⚡ Copilot Studio Labs Portal running at http://localhost:${PORT}\n`);
});
