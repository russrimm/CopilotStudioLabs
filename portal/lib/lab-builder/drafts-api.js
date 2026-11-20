/**
 * Routes for saved drafts of a partly configured lab: /api/lab-builder/drafts.
 *
 * They sit behind the same `requireAuth()` as every other /api/lab-builder route. With sign-in on, the signed-in
 * identity (req.user) names the person's private space; with sign-in off there is one local space. See drafts.js for
 * what is saved and where.
 */

import { createDraftStore, DraftError, draftsDirFor, ownerKeyFor, UNSAVED_ID } from "./drafts.js";

export function registerDraftRoutes(app, { dataDir, authEnabled = false, createRateLimiter, positiveIntFromEnv, now } = {}) {
  const store = createDraftStore({ dir: draftsDirFor(dataDir), ...(now ? { now } : {}) });
  const rate = createRateLimiter({
    windowMs: positiveIntFromEnv(process.env.LAB_BUILDER_DRAFTS_RATE_WINDOW_MS, 600000),
    max: positiveIntFromEnv(process.env.LAB_BUILDER_DRAFTS_RATE_MAX, 600),
  });

  const handle = (work) => (req, res) => {
    const owner = ownerKeyFor(req.user, { authEnabled });
    if (!owner) return res.status(401).json({ error: "Sign in to use saved drafts." });
    if (req.method !== "GET") {
      const result = rate(owner);
      if (!result.allowed) {
        res.setHeader("Retry-After", String(result.retryAfterSec));
        return res.status(429).json({ error: `Too many draft changes. Try again in ${result.retryAfterSec}s.` });
      }
    }
    try {
      return work(owner, req, res);
    } catch (err) {
      if (err instanceof DraftError) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error("[lab-builder] drafts:", err?.code || err?.message || err);
      return res.status(500).json({ error: "Your drafts could not be read or saved just now. Try again in a moment." });
    }
  };

  const fullDraft = (record) => ({ id: record.id, name: record.name, createdAt: record.createdAt, updatedAt: record.updatedAt, builtAt: record.builtAt || null, builtLabId: record.builtLabId || null, content: record.content });
  const unsavedView = (record) => (record ? { updatedAt: record.updatedAt, basedOn: record.basedOn || null, content: record.content } : null);

  /** GET /api/lab-builder/drafts: the person's drafts, newest first, with how many they may keep. */
  app.get("/api/lab-builder/drafts", handle((owner, _req, res) => {
    const { drafts, limit } = store.list(owner);
    const unsaved = store.getUnsaved(owner);
    res.json({ drafts, limit, unsaved: unsaved ? { updatedAt: unsaved.updatedAt, basedOn: unsaved.basedOn || null, products: unsaved.content.selections.products, step: unsaved.content.wizard.step } : null });
  }));

  /** POST /api/lab-builder/drafts: save a new draft ({ name, content }). */
  app.post("/api/lab-builder/drafts", handle((owner, req, res) => {
    res.status(201).json({ draft: fullDraft(store.create(owner, { name: req.body?.name, content: req.body?.content })) });
  }));

  /** GET /api/lab-builder/drafts/unsaved: the autosave slot, or { unsaved: null }. */
  app.get(`/api/lab-builder/drafts/${UNSAVED_ID}`, handle((owner, _req, res) => {
    res.json({ unsaved: unsavedView(store.getUnsaved(owner)) });
  }));

  /** PUT /api/lab-builder/drafts/unsaved: replace the autosave slot ({ content, basedOn? }). Never touches a named draft. */
  app.put(`/api/lab-builder/drafts/${UNSAVED_ID}`, handle((owner, req, res) => {
    res.json({ unsaved: unsavedView(store.saveUnsaved(owner, { content: req.body?.content, basedOn: req.body?.basedOn })) });
  }));

  /** DELETE /api/lab-builder/drafts/unsaved: discard the autosave slot. */
  app.delete(`/api/lab-builder/drafts/${UNSAVED_ID}`, handle((owner, _req, res) => {
    store.clearUnsaved(owner);
    res.json({ discarded: true });
  }));

  /** GET /api/lab-builder/drafts/:id: one draft with every choice in it. */
  app.get("/api/lab-builder/drafts/:id", handle((owner, req, res) => {
    res.json({ draft: fullDraft(store.get(owner, req.params.id)) });
  }));

  /** PUT /api/lab-builder/drafts/:id: rename and/or replace the content ({ name?, content? }). The last save wins. */
  app.put("/api/lab-builder/drafts/:id", handle((owner, req, res) => {
    res.json({ draft: fullDraft(store.update(owner, req.params.id, { name: req.body?.name, content: req.body?.content })) });
  }));

  /** POST /api/lab-builder/drafts/:id/duplicate: copy a draft under a new name. */
  app.post("/api/lab-builder/drafts/:id/duplicate", handle((owner, req, res) => {
    res.status(201).json({ draft: fullDraft(store.duplicate(owner, req.params.id)) });
  }));

  /** POST /api/lab-builder/drafts/:id/built: mark a draft as built into a lab ({ labId }). The draft stays listed. */
  app.post("/api/lab-builder/drafts/:id/built", handle((owner, req, res) => {
    res.json({ draft: fullDraft(store.markBuilt(owner, req.params.id, req.body?.labId)) });
  }));

  /** DELETE /api/lab-builder/drafts/:id: delete a draft. Labs already built from it are not changed. */
  app.delete("/api/lab-builder/drafts/:id", handle((owner, req, res) => {
    store.remove(owner, req.params.id);
    res.json({ removed: true, id: req.params.id });
  }));

  return store;
}
