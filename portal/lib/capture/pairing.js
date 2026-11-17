/**
 * Pairing and capture tokens for the Local Capture Companion.
 *
 * A signed-in portal user asks for a short-lived, one-time pairing code and types
 * it into the companion on their own machine. The companion exchanges the code
 * for a scoped capture token (`cap_...`). Only a SHA-256 hash of each code and
 * token is stored, tokens compare in constant time, and a device can be revoked
 * at any time. A token opens only the companion endpoints; it is never an Entra
 * credential and grants nothing else in the portal.
 *
 * State lives in `<data dir>/capture/devices.json`, so it follows the Azure Blob
 * mirror like the portal's other data.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";

import { cleanText, readJson, writeJsonAtomic } from "./store-util.js";

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
export const TOKEN_PREFIX = "cap_";
export const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** A companion counts as connected when it checked in this recently. */
export const COMPANION_ONLINE_MS = 90 * 1000;
const PERSIST_LAST_SEEN_MS = 5 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const MAX_ACTIVE_CODES = 5;
const MAX_FAILED_ATTEMPTS = 15;
const FAILED_WINDOW_MS = 10 * 60 * 1000;
const REVOKED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const KNOWN_PLATFORMS = new Set(["win32", "darwin", "linux"]);
const PRODUCT_ID_RE = /^[a-z0-9-]{1,60}$/;

function sha256(value) {
  return createHash("sha256").update(value).digest();
}

function hashesEqual(a, b) {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Normalize what a person typed: uppercase, drop spaces and dashes. */
export function normalizePairingCode(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function generateCode() {
  const bytes = randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i += 1) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

export function formatPairingCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function cleanProducts(list) {
  return Array.isArray(list)
    ? [...new Set(list.map((p) => String(p || "").trim().toLowerCase()).filter((p) => PRODUCT_ID_RE.test(p)))].slice(0, 20)
    : [];
}

function publicDevice(device, { now, onlineMs, live }) {
  const lastSeenAt = live?.lastSeenAt || device.lastSeenAt || null;
  const seenMs = lastSeenAt ? Date.parse(lastSeenAt) : 0;
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    companionVersion: live?.companionVersion || device.companionVersion || null,
    createdAt: device.createdAt,
    lastSeenAt,
    connected: !device.revokedAt && seenMs > 0 && now - seenMs <= onlineMs,
    busy: Boolean(live?.busy ?? device.busy),
    signedInProducts: live?.signedInProducts || device.signedInProducts || [],
    expiresAt: new Date(device.expiresAt).toISOString(),
    revokedAt: device.revokedAt || null,
    tokenHint: device.tokenHint,
  };
}

/**
 * @param {object} options
 * @param {string} options.dir folder for `devices.json` (normally `<data dir>/capture`)
 * @param {() => number} [options.now]
 */
export function createPairingStore({
  dir,
  now = () => Date.now(),
  codeTtlMs = PAIRING_CODE_TTL_MS,
  tokenTtlMs = TOKEN_TTL_MS,
  onlineMs = COMPANION_ONLINE_MS,
} = {}) {
  const file = path.join(dir, "devices.json");
  const live = new Map();
  const persistedSeen = new Map();
  let failures = [];

  const load = () => {
    const state = readJson(file, null);
    return {
      schema: 1,
      codes: Array.isArray(state?.codes) ? state.codes : [],
      devices: Array.isArray(state?.devices) ? state.devices : [],
    };
  };

  function save(state) {
    const t = now();
    state.codes = state.codes.filter((c) => c.expiresAt > t).slice(-MAX_ACTIVE_CODES);
    state.devices = state.devices.filter((d) => !d.revokedAt || t - Date.parse(d.revokedAt) < REVOKED_RETENTION_MS);
    writeJsonAtomic(file, state);
  }

  /** Create a one-time pairing code to display in the portal. */
  function createCode({ createdBy = null } = {}) {
    const state = load();
    const code = generateCode();
    const createdAt = now();
    state.codes.push({
      hash: sha256(code).toString("hex"),
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: createdAt + codeTtlMs,
      createdBy: createdBy ? cleanText(createdBy, 120) : null,
    });
    save(state);
    return {
      code: formatPairingCode(code),
      expiresAt: new Date(createdAt + codeTtlMs).toISOString(),
      expiresInSec: Math.round(codeTtlMs / 1000),
    };
  }

  /**
   * Trade a pairing code for a capture token. A valid code is deleted on first
   * use, so it can never be replayed, and repeated bad guesses lock the exchange.
   */
  function exchangeCode(rawCode, info = {}) {
    const t = now();
    failures = failures.filter((stamp) => t - stamp < FAILED_WINDOW_MS);
    if (failures.length >= MAX_FAILED_ATTEMPTS) {
      return { ok: false, reason: "locked", retryAfterSec: Math.max(1, Math.ceil((failures[0] + FAILED_WINDOW_MS - t) / 1000)) };
    }
    const presented = sha256(normalizePairingCode(rawCode)).toString("hex");
    const state = load();
    let matchIndex = -1;
    for (let i = 0; i < state.codes.length; i += 1) {
      if (hashesEqual(state.codes[i].hash, presented)) matchIndex = i;
    }
    if (matchIndex < 0) {
      failures.push(t);
      return { ok: false, reason: "invalid" };
    }
    const [matched] = state.codes.splice(matchIndex, 1);
    if (matched.expiresAt <= t) {
      save(state);
      failures.push(t);
      return { ok: false, reason: "expired" };
    }

    const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const device = {
      id: `dev_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      name: cleanText(info.deviceName, 80) || "Unnamed computer",
      platform: KNOWN_PLATFORMS.has(String(info.platform)) ? String(info.platform) : "unknown",
      companionVersion: cleanText(info.companionVersion, 40) || null,
      tokenHash: sha256(token).toString("hex"),
      tokenHint: `${token.slice(0, 8)}...`,
      scopes: ["capture:companion"],
      createdAt: new Date(t).toISOString(),
      createdBy: matched.createdBy || null,
      lastSeenAt: null,
      signedInProducts: [],
      expiresAt: t + tokenTtlMs,
      revokedAt: null,
    };
    state.devices.push(device);
    save(state);
    return { ok: true, token, device: publicDevice(device, { now: t, onlineMs, live: null }) };
  }

  /** Check a presented capture token. Never throws; says why when it fails. */
  function authenticate(token) {
    const value = String(token ?? "");
    if (!value) return { ok: false, reason: "missing" };
    if (!value.startsWith(TOKEN_PREFIX) || value.length > 200) return { ok: false, reason: "invalid" };
    const presented = sha256(value).toString("hex");
    const state = load();
    let found = null;
    for (const device of state.devices) {
      if (hashesEqual(device.tokenHash, presented)) found = device;
    }
    if (!found) return { ok: false, reason: "invalid" };
    if (found.revokedAt) return { ok: false, reason: "revoked" };
    const t = now();
    if (found.expiresAt <= t) return { ok: false, reason: "expired" };
    if (found.expiresAt - t < tokenTtlMs / 2) {
      found.expiresAt = t + tokenTtlMs;
      save(state);
    }
    return { ok: true, device: publicDevice(found, { now: t, onlineMs, live: live.get(found.id) }), scopes: found.scopes };
  }

  /** Record that a companion is alive, what it reports, and what it is signed in to. Omitted fields keep their last value. */
  function heartbeat(deviceId, info = {}) {
    const t = now();
    const previous = live.get(deviceId) || listDevices({ includeRevoked: true }).find((d) => d.id === deviceId) || {};
    const entry = {
      lastSeenAt: new Date(t).toISOString(),
      companionVersion: cleanText(info.companionVersion, 40) || previous.companionVersion || null,
      signedInProducts: info.signedInProducts === undefined ? previous.signedInProducts || [] : cleanProducts(info.signedInProducts),
      busy: info.busy === undefined ? Boolean(previous.busy) : Boolean(info.busy),
    };
    live.set(deviceId, entry);
    const lastPersisted = persistedSeen.get(deviceId) || 0;
    if (t - lastPersisted >= PERSIST_LAST_SEEN_MS) {
      const state = load();
      const device = state.devices.find((d) => d.id === deviceId);
      if (device && !device.revokedAt) {
        Object.assign(device, {
          lastSeenAt: entry.lastSeenAt,
          companionVersion: entry.companionVersion || device.companionVersion,
          signedInProducts: entry.signedInProducts,
          busy: entry.busy,
        });
        save(state);
        persistedSeen.set(deviceId, t);
      }
    }
    return entry;
  }

  function listDevices({ includeRevoked = false } = {}) {
    const t = now();
    return load()
      .devices.filter((d) => includeRevoked || !d.revokedAt)
      .map((d) => publicDevice(d, { now: t, onlineMs, live: live.get(d.id) }))
      .sort((a, b) => String(b.lastSeenAt || b.createdAt).localeCompare(String(a.lastSeenAt || a.createdAt)));
  }

  function revokeDevice(deviceId) {
    const state = load();
    const device = state.devices.find((d) => d.id === String(deviceId));
    if (!device || device.revokedAt) return false;
    device.revokedAt = new Date(now()).toISOString();
    save(state);
    live.delete(device.id);
    return true;
  }

  /** What the portal shows: is a companion connected, since when, and signed in to which products. */
  function status() {
    const devices = listDevices();
    const connected = devices.filter((d) => d.connected);
    const lastSeenAt = devices.map((d) => d.lastSeenAt).filter(Boolean).sort().pop() || null;
    return {
      connected: connected.length > 0,
      lastSeenAt,
      deviceCount: devices.length,
      connectedCount: connected.length,
      devices,
      signedInProducts: [...new Set(connected.flatMap((d) => d.signedInProducts))].sort(),
      busy: connected.some((d) => d.busy),
    };
  }

  return { createCode, exchangeCode, authenticate, heartbeat, listDevices, revokeDevice, status };
}
