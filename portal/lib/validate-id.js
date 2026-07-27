/**
 * Input validators for values that are passed as arguments to the az CLI.
 *
 * These validators are the last line of defense: even though we now invoke
 * az via execFile (no shell), we still refuse obviously malformed values
 * so an attacker cannot smuggle unexpected az flags (e.g. `--query` or
 * `--debug`) through a value slot.
 */

// Azure resource identifiers, base names, subscription IDs, etc.
// Conservative superset: letters, digits, dot, underscore, hyphen.
const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;

// Azure region names are lowercase letters + digits, e.g. "eastus", "westus2".
const REGION_RE = /^[a-z][a-z0-9-]{1,39}$/;

// Key Vault secret names per Azure spec: alphanumeric and dashes only.
const SECRET_NAME_RE = /^[A-Za-z0-9-]{1,127}$/;

// Comma-separated list of digits (used for enabledLabs bicep param).
const LAB_NUMBERS_RE = /^\d+(?:,\d+)*$/;

function guard(value, regex, label, { maxLength = 128 } = {}) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`${label} is required`);
  }
  const s = String(value);
  if (s.length > maxLength) {
    throw new Error(`${label} is too long`);
  }
  if (!regex.test(s)) {
    throw new Error(`${label} contains invalid characters`);
  }
  // Extra defense: never allow a leading dash — many CLIs would parse it as a flag.
  if (s.startsWith("-")) {
    throw new Error(`${label} must not start with '-'`);
  }
  return s;
}

export const assertId = (value, label = "identifier") => guard(value, SAFE_ID_RE, label, { maxLength: 128 });
export const assertRegion = (value, label = "location") => guard(value, REGION_RE, label, { maxLength: 40 });
export const assertSecretName = (value, label = "secret name") => guard(value, SECRET_NAME_RE, label, { maxLength: 127 });
export const assertLabNumbers = (value, label = "lab numbers") => guard(value, LAB_NUMBERS_RE, label, { maxLength: 200 });

// Secret VALUES may contain anything; we don't restrict content, only ban NULs
// (which would truncate the CLI arg on Windows) and cap the length.
export function assertSecretValue(value, label = "secret value") {
  if (value === undefined || value === null) {
    throw new Error(`${label} is required`);
  }
  const s = String(value);
  if (s.length === 0) throw new Error(`${label} must not be empty`);
  if (s.length > 25000) throw new Error(`${label} is too long`);
  if (s.includes("\u0000")) throw new Error(`${label} must not contain NUL bytes`);
  return s;
}
