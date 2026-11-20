/**
 * Products a person added from a Microsoft Learn hub page (see lab-builder/product-api.js).
 *
 * A saved product is a small definition, shaped like an entry in products.json, kept in one JSON file next to the topic
 * caches. It has no curated catalog: its topics come from Microsoft Learn discovery and from topics added by link, so
 * everything it teaches is marked as not reviewed. Entries are validated when read; a damaged file is ignored entry by
 * entry, never trusted. This module imports nothing from the catalog, so products.js can read it without a cycle.
 */

import fs from "node:fs";
import path from "node:path";

import { resolvePortalDataDir } from "../storage-config.js";

export const MAX_USER_PRODUCTS = 10;
export const USER_PRODUCTS_SCHEMA_VERSION = 1;

const LEARN_HOST = "learn.microsoft.com";
const ID = /^custom-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Where the file lives: next to the topic caches unless a deployment names it. */
export function userProductsPath(env = process.env) {
  return env.LAB_BUILDER_USER_PRODUCTS || path.join(resolvePortalDataDir(env), "lab-builder", "user-products.json");
}

function learnRoot(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && url.hostname === LEARN_HOST && !url.username && !url.password && !url.port && url.pathname.length > 1;
  } catch {
    return false;
  }
}

/** The id for a product name: `custom-` plus a slug of at most 40 characters. */
export function productIdFor(name) {
  const slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug ? `custom-${slug}` : "";
}

/**
 * The definition for a product added from a Learn hub page.
 * @param {{name: string, root: string, summary?: string, now?: number}} input
 */
export function buildUserProduct({ name, root, summary = "", now = Date.now() }) {
  const cleanName = String(name || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const id = productIdFor(cleanName);
  if (!cleanName || !id || !learnRoot(root)) return null;
  return {
    id,
    name: cleanName,
    shortName: cleanName.length > 30 ? `${cleanName.slice(0, 29).trimEnd()}…` : cleanName,
    order: 1000,
    summary: String(summary || `Hands-on labs for ${cleanName}, built from its Microsoft Learn documentation.`).slice(0, 300),
    learnHubUrl: root,
    learnRoots: [root],
    levels: [100, 200, 300],
    hasHarnesses: false,
    agentNoun: "solution",
    labPrerequisites: [
      `Access to ${cleanName} in an environment where you can try the steps. What the product requires is Not confirmed in Microsoft Learn by this builder, so read the product's documentation before you start.`,
    ],
    licenseNote: `Licensing for ${cleanName} is Not confirmed in Microsoft Learn by this builder; check the product's documentation.`,
    custom: true,
    addedAt: new Date(now).toISOString(),
  };
}

function validEntry(entry) {
  return Boolean(
    entry &&
      typeof entry === "object" &&
      ID.test(String(entry.id || "")) &&
      entry.id.length <= 48 &&
      typeof entry.name === "string" &&
      entry.name.length >= 2 &&
      entry.name.length <= 80 &&
      typeof entry.shortName === "string" &&
      Array.isArray(entry.learnRoots) &&
      entry.learnRoots.length === 1 &&
      entry.learnRoots.every(learnRoot) &&
      learnRoot(entry.learnHubUrl) &&
      entry.custom === true &&
      entry.hasHarnesses === false,
  );
}

/** The saved products that pass validation, oldest first. A missing or unreadable file is an empty list. */
export function readUserProducts(file) {
  if (!file) return [];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const seen = new Set();
  const kept = [];
  for (const entry of Array.isArray(parsed?.products) ? parsed.products : []) {
    if (!validEntry(entry) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    kept.push({ ...entry, order: 1000 + kept.length });
    if (kept.length >= MAX_USER_PRODUCTS) break;
  }
  return kept;
}

/** Save the list. Throws when it is over the limit so a full list never silently drops a product. */
export function writeUserProducts(file, products) {
  if (products.length > MAX_USER_PRODUCTS) throw new Error(`You can add up to ${MAX_USER_PRODUCTS} products of your own. Remove one first.`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ schemaVersion: USER_PRODUCTS_SCHEMA_VERSION, products }, null, 2)}\n`);
  fs.renameSync(temp, file);
}
