/**
 * What the person agreed to for autonomous capture, kept with the brand profile (or "default" when there is none).
 * It is the only place a job's permission comes from: the portal builds a job's `autonomy` from this record and
 * never from the request, so a request cannot ask for more than the person allowed.
 *
 * Two levels: "read-only" (the computer looks at screens and tries things that change nothing) and "practice"
 * (it may also create and use one practice agent in the practice environment named here). Revoking removes it.
 */

import path from "node:path";

import { validateTargetValue, parseCopilotStudioAddress } from "../../../tools/screenshot-capture/targets.mjs";
import { describeTiers, NEVER_LIST } from "../../../tools/screenshot-capture/guard.mjs";
import { cleanText, readJson, writeJsonAtomic } from "./store-util.js";

export const CONSENT_VERSION = 1;
export const CONSENT_LEVELS = Object.freeze(["read-only", "practice"]);
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

/** What the consent card shows: the tiers and the things that are never done, from the same source the companion enforces. */
export function describeAutonomyRules() {
  return { version: CONSENT_VERSION, tiers: describeTiers(), never: [...NEVER_LIST] };
}

/**
 * Check a consent request. `practiceEnvironmentUrl` must be a Copilot Studio environment address over https, and
 * the practice level needs one.
 * @returns {{ok: boolean, consent?: object, error?: string, field?: string}}
 */
export function validateConsent(input) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  if (src.consented !== true) return { ok: false, error: "Confirm that you agree before saving.", field: "consented" };
  const level = String(src.level ?? "read-only");
  if (!CONSENT_LEVELS.includes(level)) return { ok: false, error: "The level must be read-only or practice.", field: "level" };
  let practiceEnvironmentUrl = "";
  if (src.practiceEnvironmentUrl !== undefined && src.practiceEnvironmentUrl !== null && String(src.practiceEnvironmentUrl).trim() !== "") {
    const checked = validateTargetValue("copilotStudioUrl", src.practiceEnvironmentUrl);
    if (!checked.ok) return { ok: false, error: checked.error, field: "practiceEnvironmentUrl" };
    const parsed = parseCopilotStudioAddress(checked.value);
    if (!parsed.envBase) return { ok: false, error: "That address does not point at a Copilot Studio environment. Open the practice environment in Copilot Studio and copy the address from the address bar.", field: "practiceEnvironmentUrl" };
    practiceEnvironmentUrl = parsed.envBase;
  }
  if (level === "practice" && !practiceEnvironmentUrl) return { ok: false, error: "Add the address of the practice environment to allow a practice agent.", field: "practiceEnvironmentUrl" };
  return { ok: true, consent: { version: CONSENT_VERSION, consented: true, level, practiceEnvironmentUrl: level === "practice" ? practiceEnvironmentUrl : "" } };
}

/** Consent records in `<data dir>/capture/consent.json`, so they follow the Azure Blob mirror like the rest of the capture state. */
export function createConsentStore({ dir, now = () => Date.now() }) {
  const file = path.join(dir, "consent.json");
  const load = () => {
    const data = readJson(file, null);
    return data && typeof data.entries === "object" && !Array.isArray(data.entries) ? data : { schema: 1, entries: {} };
  };
  const keyOf = (key) => (KEY_RE.test(String(key || "")) ? String(key) : "default");
  return {
    file,
    get(key) {
      const entry = load().entries[keyOf(key)];
      return entry && entry.consented === true && entry.version === CONSENT_VERSION ? entry : null;
    },
    /** Save a validated consent. Returns the stored record. */
    put(key, consent) {
      const data = load();
      const record = { ...consent, consentedAt: new Date(now()).toISOString() };
      data.entries[keyOf(key)] = record;
      writeJsonAtomic(file, data);
      return record;
    },
    revoke(key) {
      const data = load();
      const existed = Boolean(data.entries[keyOf(key)]);
      delete data.entries[keyOf(key)];
      writeJsonAtomic(file, data);
      return existed;
    },
  };
}

/** The consent as the browser sees it: whether it exists, the level, and the practice environment (a Copilot Studio address, never a secret). */
export function describeConsent(record, { profile = null } = {}) {
  return {
    consented: Boolean(record),
    level: record?.level || null,
    practiceEnvironmentUrl: record?.practiceEnvironmentUrl || "",
    consentedAt: record?.consentedAt || null,
    profile: profile ? { id: cleanText(profile.id, 80), name: cleanText(profile.name, 80) } : null,
    rules: describeAutonomyRules(),
  };
}

/**
 * The `autonomy` a job carries, from what was stored and what this request asks for. A request can ask for less
 * (read-only) and never for more.
 * @returns {{consented: boolean, level: string, practiceEnvironmentUrl: string, version: number}|null} null without consent
 */
export function autonomyFor(record, requested = null) {
  if (!record) return null;
  const wantsReadOnly = requested?.level === "read-only";
  const practice = record.level === "practice" && !wantsReadOnly && Boolean(record.practiceEnvironmentUrl);
  return { version: CONSENT_VERSION, consented: true, level: practice ? "practice" : "read-only", practiceEnvironmentUrl: practice ? record.practiceEnvironmentUrl : "" };
}
