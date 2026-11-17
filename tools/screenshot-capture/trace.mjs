// A redacted trace of what the companion decided, for finding out why a sign-in did not work.
// It records step names, hosts and paths, timings, and decisions. It never records query strings,
// cookies, tokens, page text, account names, or anything typed. Turn it on with --debug or --trace.

import fs from "node:fs";
import path from "node:path";

import { scrubSensitiveText } from "./redact.mjs";

const MAX_TEXT = 240;

/** Make one piece of text safe to write: no query strings or fragments, no ids, tokens, or account names. */
export function redactTraceText(value, terms = []) {
  let text = String(value ?? "");
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, (address) => {
    try {
      const url = new URL(address);
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      return "{address}";
    }
  });
  text = text.replace(/[?#][^\s"']*/g, "");
  text = scrubSensitiveText(text, terms);
  text = text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "{id}");
  text = text.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]*)?/g, "{token}");
  text = text.replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, "{token}");
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}

function cleanValue(value, terms, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return redactTraceText(value, terms);
  if (Array.isArray(value) && depth < 2) return value.slice(0, 40).map((v) => cleanValue(v, terms, depth + 1));
  return undefined;
}

/** Where a trace goes: the file asked for with --trace (relative paths start in the companion folder), or a new file under .captures/traces. */
export function traceFilePath(home, requested, now = () => Date.now()) {
  if (requested && typeof requested === "string") return path.resolve(home, requested);
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
  return path.join(home, ".captures", "traces", `companion-${stamp}.log`);
}

/**
 * @param {object} options
 * @param {string} options.file where to write (the folder is created)
 * @param {string[]} [options.terms] extra text to hide
 */
export function createTrace({ file, terms = [], now = () => Date.now(), header = {} } = {}) {
  const started = now();
  const lines = [];
  let ready = false;
  const write = (line) => {
    lines.push(line);
    if (!file) return;
    try {
      if (!ready) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        ready = true;
      }
      fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
    } catch {
      // A trace that cannot be written never stops a capture.
    }
  };
  const trace = {
    file: file || null,
    lines,
    event(name, data = {}) {
      const entry = { t: now() - started, event: redactTraceText(name, terms) };
      for (const [key, value] of Object.entries(data || {})) {
        if (!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(key)) continue;
        const clean = cleanValue(value, terms);
        if (clean !== undefined) entry[key] = clean;
      }
      write(JSON.stringify(entry));
    },
  };
  trace.event("trace-start", { ...header, startedAt: new Date(started).toISOString() });
  return trace;
}
