/**
 * AI writing: errors a person can read, and a log that can never carry content.
 */

export class AiError extends Error {
  /**
   * @param {string} code a short stable code (off, not-local, sign-in-required, quota, timeout, ...)
   * @param {string} message plain words for the page
   * @param {number} [status] HTTP status when a route returns it
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = "AiError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Sort a failure from the model into what to do about it. Only clearly temporary trouble is retried; a refusal, a
 * policy block or an exhausted allowance is never retried, and an exhausted allowance stops the whole run.
 */
export function classifyError(err) {
  const text = `${err?.code || ""} ${err?.message || ""}`.toLowerCase();
  if (err?.name === "AbortError" || /\baborted\b|cancell?ed/.test(text)) return { kind: "aborted", transient: false, stop: true };
  if (/premium request|quota|exceeded your|usage limit|allowance|billing|payment|402/.test(text)) return { kind: "quota", transient: false, stop: true };
  if (/401|403|unauthori[sz]ed|forbidden|not authenticated|no github|sign in|expired token|bad credentials|access denied|not enabled|policy/.test(text)) return { kind: "auth", transient: false, stop: true };
  if (/timed out|timeout|etimedout/.test(text)) return { kind: "timeout", transient: true, stop: false };
  if (/429|rate limit|too many requests|503|502|504|temporar|overloaded|econnreset|socket hang up|eai_again|enotfound|server error|500/.test(text)) {
    return { kind: "transient", transient: true, stop: false };
  }
  return { kind: "failed", transient: false, stop: false };
}

/** A sentence a person can act on, for a failure of the given kind. */
export function describeFailure(kind) {
  switch (kind) {
    case "quota":
      return "The model said this account has used its allowance, so the rest of the lab keeps the standard text.";
    case "auth":
      return "The model did not accept the sign-in, so the rest of the lab keeps the standard text.";
    case "timeout":
      return "The model took too long, so those parts keep the standard text.";
    case "aborted":
      return "AI writing was cancelled, so the rest of the lab keeps the standard text.";
    case "transient":
      return "The model service was busy, so those parts keep the standard text.";
    default:
      return "The model could not write some parts, so they keep the standard text.";
  }
}

const SAFE_FIELDS = new Set(["event", "mode", "provider", "model", "durationMs", "outcome", "blocks", "ai", "kept", "cached", "rejected", "requests", "failed", "tokens", "kind", "scope", "status"]);

/**
 * Write one line to the server log. Only counts, model ids, durations and outcomes get through: any other key is
 * dropped, and a string is cut to a short, single line, so a prompt, a source passage, a model answer, a token or a name
 * cannot be logged by mistake.
 */
export function logAi(logger, fields) {
  if (typeof logger !== "function") return;
  const parts = [];
  for (const [key, value] of Object.entries(fields || {})) {
    if (!SAFE_FIELDS.has(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) parts.push(`${key}=${Math.round(value)}`);
    else if (typeof value === "boolean") parts.push(`${key}=${value}`);
    else if (typeof value === "string") parts.push(`${key}=${value.replace(/[^A-Za-z0-9._:/-]/g, "_").slice(0, 60)}`);
  }
  if (parts.length) logger(`[ai] ${parts.join(" ")}`);
}
