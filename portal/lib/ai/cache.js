/**
 * AI writing: the cache of accepted blocks.
 *
 * Key = a hash of the prompt version, the guard version, the model, the provider, the kind of block, its source text and
 * the allowed terms. A rebuild of an unchanged block therefore never calls the model again. Only text that already passed
 * the guard is stored, and nothing else: no prompt, no token, no name of a person. The file lives in the portal's own data
 * folder and holds at most `maxEntries` blocks (the oldest go first).
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { AI_PROMPT_VERSION } from "./config.js";
import { GUARD_VERSION } from "./guard.js";

export function blockCacheKey(block, { model, provider, context = "" }) {
  const body = JSON.stringify([
    AI_PROMPT_VERSION,
    GUARD_VERSION,
    provider || "",
    model || "",
    block.kind,
    block.type,
    block.source ?? block.sources ?? null,
    block.ui || [],
    block.maxChars || 0,
    block.deck ? 1 : 0,
    block.allowed || "",
    context,
  ]);
  return createHash("sha256").update(body).digest("hex");
}

export function createAiCache({ file = null, maxEntries = 3000 } = {}) {
  /** @type {Map<string, {text?: string, items?: string[]}>} */
  const entries = new Map();
  let dirty = false;

  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (saved?.version === 1 && saved.entries && typeof saved.entries === "object") {
        for (const [key, value] of Object.entries(saved.entries)) {
          if (/^[0-9a-f]{64}$/.test(key) && value && (typeof value.text === "string" || Array.isArray(value.items))) entries.set(key, value);
        }
      }
    } catch {
      /* no cache yet, or one that cannot be read: start empty */
    }
  }

  return {
    get(key) {
      const hit = entries.get(key);
      if (!hit) return null;
      entries.delete(key);
      entries.set(key, hit);
      return hit.items ? { items: [...hit.items] } : { text: hit.text };
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value.items ? { items: [...value.items] } : { text: value.text });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      dirty = true;
    },
    get size() {
      return entries.size;
    },
    /** Write the cache to disk when something changed. Never throws: a cache that cannot be saved only costs a later call. */
    flush() {
      if (!file || !dirty) return false;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: Object.fromEntries(entries) }), "utf8");
        fs.renameSync(tmp, file);
        dirty = false;
        return true;
      } catch {
        return false;
      }
    },
  };
}
