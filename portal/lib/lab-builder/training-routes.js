/**
 * Routes for the pre-lab training decks, kept out of server.js so that file only registers them.
 *
 *   GET /api/lab-builder/generated/:labId/training                  list: titles, minutes, flags (and the same under /api/generated-labs/)
 *   GET /api/lab-builder/generated/:labId/training/:deck            the deck as PowerPoint
 *   GET /api/lab-builder/generated/:labId/training/:deck/:format    `pptx` (a file) or `outline` (slide titles, minutes, notes as JSON)
 *
 * `:deck` is a topic number (the module's order in the lab), `complete`, `foundations` (when the lab has one product),
 * or `foundations-<product id>`. Errors are JSON `{error}`: 400 for a bad lab id, deck, or format, 404 for a lab or
 * deck that does not exist.
 */

import { existsSync, readFileSync } from "node:fs";
import { createExportZip } from "../export-zip.js";
import { zipDownloadName } from "../export-names.js";
import { getBrandingLogoAbsolutePath } from "../branding.js";
import { resolveLabBrand } from "../branding-profiles.js";
import { isCustomBranding, resolveSafeGeneratedLabDir } from "../exporter.js";
import { buildAttachmentContentDisposition } from "./topic-documents.js";
import {
  TRAINING_DECK_FORMATS,
  TRAINING_MIME_TYPES,
  describeTrainingDecks,
  ensureGeneratedLabTrainingDecks,
  readCachedTrainingDeck,
  renderTrainingDeckBuffer,
  resolveDeckKey,
  trainingDeckOutline,
  trainingZipEntries,
} from "./training-decks.js";
import { TRAINING_SCHEMA_VERSION } from "./training-plan.js";

/** Branding options the way the topic document route builds them: only a customized brand is applied. */
export function brandingFor(manifest) {
  const branding = resolveLabBrand(manifest);
  const custom = isCustomBranding(branding);
  if (!custom) return { custom: false, branding: null };
  const logoPath = getBrandingLogoAbsolutePath(branding.logo);
  const logoBuffer = logoPath && existsSync(logoPath) ? readFileSync(logoPath) : null;
  return {
    custom: true,
    branding: {
      companyName: branding.companyName,
      tagline: branding.tagline,
      primaryColor: branding.primaryColor,
      secondaryColor: branding.secondaryColor,
      font: branding.font,
      coverSubtitle: branding.coverSubtitle,
      footerText: branding.footerText,
      logoBuffer,
    },
  };
}

/** The list for one lab: what the lab panel and the wizard's last step show. */
export function listLabTrainingDecks(generatedLabsDir, rawLabId) {
  const found = resolveSafeGeneratedLabDir(generatedLabsDir, rawLabId);
  if (found.status !== 200) return { status: found.status, body: { error: found.error } };
  try {
    const { summary, plan } = ensureGeneratedLabTrainingDecks(found.labDir, { labId: found.labId });
    const described = describeTrainingDecks(found.labDir, summary, plan);
    return {
      status: 200,
      body: {
        labId: found.labId,
        labTitle: described.labTitle,
        schemaVersion: TRAINING_SCHEMA_VERSION,
        totalMinutes: described.totalMinutes,
        handsOnMinutes: described.handsOnMinutes,
        foundationsCount: described.foundationsCount,
        topicCount: described.topicCount,
        decks: described.decks.map((d) => ({
          key: d.key,
          kind: d.kind,
          order: d.order,
          productId: d.productId,
          stepLabel: d.stepLabel,
          title: d.title,
          minutes: d.minutes,
          slideCount: d.slideCount,
          unreviewed: d.unreviewed,
          thin: d.thin,
          learnChanged: d.learnChanged,
          stale: d.stale,
          fileName: d.fileName,
        })),
      },
    };
  } catch (err) {
    return { status: 500, body: { error: `Could not prepare the training decks: ${err.message}` } };
  }
}

/** One deck: the file, or its outline. */
export function readLabTrainingDeck(generatedLabsDir, rawLabId, rawDeck, rawFormat = "pptx") {
  const format = String(rawFormat || "pptx").trim().toLowerCase().replace(/^\./, "");
  if (!TRAINING_DECK_FORMATS.includes(format)) {
    return { status: 400, body: { error: "Unsupported training deck format. Use 'pptx' or 'outline'." } };
  }
  const found = resolveSafeGeneratedLabDir(generatedLabsDir, rawLabId);
  if (found.status !== 200) return { status: found.status, body: { error: found.error } };
  try {
    const { summary, plan, uncached } = ensureGeneratedLabTrainingDecks(found.labDir, { labId: found.labId });
    const resolved = resolveDeckKey(rawDeck, summary);
    if (resolved.error) return { status: resolved.status, body: { error: resolved.error } };
    const descriptor = summary.decks.find((d) => d.key === resolved.key);

    if (format === "outline") {
      return { status: 200, json: trainingDeckOutline(plan, resolved.key), fileName: `${descriptor.fileName.replace(/\.pptx$/i, "")}.json` };
    }

    const brand = brandingFor(found.manifest);
    let buffer = null;
    if (!brand.custom && !uncached) buffer = readCachedTrainingDeck(found.labDir, descriptor.fileName);
    if (!buffer) {
      const rendered = renderTrainingDeckBuffer(plan, resolved.key, { branding: brand.branding });
      buffer = rendered?.buffer || null;
    }
    if (!buffer) return { status: 404, body: { error: "Training deck file not found." } };
    return {
      status: 200,
      labId: found.labId,
      deck: descriptor,
      fileName: descriptor.fileName,
      contentType: TRAINING_MIME_TYPES.pptx,
      contentDisposition: buildAttachmentContentDisposition(descriptor.fileName),
      buffer,
    };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

/** `format` values of the lab export route that deliver training decks: the whole folder as a ZIP, or one deck. */
export const TRAINING_EXPORT_FORMAT = /^training(?:-complete|-foundations)?$/;

/**
 * Answer an export request for `training`, `training-complete`, or `training-foundations`. The ZIP holds the same
 * folder the full lab package carries: `1 - Training decks (deliver first)/`.
 */
export async function sendTrainingExport(res, { generatedLabsDir, labId, format }) {
  const found = resolveSafeGeneratedLabDir(generatedLabsDir, labId);
  if (found.status !== 200) return res.status(found.status).json({ error: found.error });
  let direct = format === "training-complete";
  if (format === "training-foundations") {
    const ensured = ensureGeneratedLabTrainingDecks(found.labDir, { labId: found.labId });
    direct = ensured.summary.decks.filter((d) => d.kind === "foundations").length === 1;
  }
  if (direct) {
    const result = readLabTrainingDeck(generatedLabsDir, labId, format === "training-complete" ? "complete" : "foundations");
    if (result.status !== 200) return res.status(result.status).json(result.body);
    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Content-Disposition", result.contentDisposition);
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.send(result.buffer);
  }
  try {
    const brand = brandingFor(found.manifest);
    const built = trainingZipEntries(found.labDir, { labId: found.labId, branding: brand.branding, live: brand.custom });
    // Deck names inside the ZIP are the short ones ("Training 00 Foundations <product>.pptx"); see export-names.js.
    const wanted = format === "training-foundations" ? built.entries.filter((e) => /\/Training 00 Foundations /.test(e.name)) : built.entries;
    const title = String(found.manifest?.title || found.labId);
    const zipName = zipDownloadName(title, { kind: format === "training-foundations" ? "Foundations decks" : "Training decks" });
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", buildAttachmentContentDisposition(zipName));
    res.setHeader("X-Content-Type-Options", "nosniff");
    const zip = createExportZip({ level: 6 });
    const archive = zip.archive;
    const finished = new Promise((resolve, reject) => {
      archive.on("error", reject);
      res.on("close", resolve);
    });
    archive.pipe(res);
    for (const entry of wanted) {
      const isDeck = entry.name.endsWith(".pptx");
      zip.add(entry.name, entry.data, { group: "training", kind: isDeck ? "Training deck" : "Training notes", format: isDeck ? "pptx" : "md", title: entry.title, minutes: entry.minutes ?? null, order: entry.order ?? null });
    }
    await archive.finalize();
    return finished;
  } catch (err) {
    if (!res.headersSent) return res.status(500).json({ error: err.message });
    return res.destroy(err);
  }
}

/** Register the routes on an Express app. `generatedLabsDir` is the folder that holds the generated labs. */
export function registerTrainingDeckRoutes(app, { generatedLabsDir }) {
  const list = (req, res) => {
    const result = listLabTrainingDecks(generatedLabsDir, req.params.labId);
    res.status(result.status).json(result.body);
  };
  const read = (req, res) => {
    const result = readLabTrainingDeck(generatedLabsDir, req.params.labId, req.params.deck, req.params.format);
    if (result.status !== 200) return res.status(result.status).json(result.body);
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (result.json) return res.status(200).json(result.json);
    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Content-Disposition", result.contentDisposition);
    return res.send(result.buffer);
  };
  for (const base of ["/api/lab-builder/generated", "/api/generated-labs"]) {
    app.get(`${base}/:labId/training`, list);
    app.get(`${base}/:labId/training/:deck`, read);
    app.get(`${base}/:labId/training/:deck/:format`, read);
  }
}
