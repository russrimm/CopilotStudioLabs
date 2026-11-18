// When a sign-in loops or never finishes, say why in plain language. Everything here works from facts that are not
// secrets: the sequence of hosts and paths the browser visited, how long each stayed, an AADSTS error code (a public
// Microsoft error number), and a few settings of this computer. It never reads other page text, cookies' values, or
// account names.

import { classifyUrl, currentAddress } from "./signin-url.mjs";

// ── Reading an error code ──────────────────────────────────────────────────

const AADSTS_RE = /\bAADSTS\d{3,7}\b/i;

/** The first AADSTS code in some text, upper case, or null. The text itself is not kept. */
export function extractAadstsCode(text) {
  const match = AADSTS_RE.exec(String(text ?? ""));
  return match ? match[0].toUpperCase() : null;
}

/** The AADSTS code in an address's error parameters (`error_description`), or null. Nothing else in the query is read. */
export function aadstsFromUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl ?? ""));
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
    for (const params of [url.searchParams, fragment]) {
      for (const name of ["error_description", "error", "error_subcode", "errorDescription"]) {
        const code = extractAadstsCode(params.get(name));
        if (code) return code;
      }
    }
  } catch {
    // Not an address.
  }
  return null;
}

/**
 * The AADSTS code the browser is showing, if any: from the address's error parameters, or (only on a sign-in page)
 * from the page text. The page text is matched in the page and only the code leaves it.
 */
export async function readAadstsCode(page, { timeoutMs = 1500 } = {}) {
  const address = currentAddress(page);
  const fromAddress = aadstsFromUrl(address);
  if (fromAddress) return fromAddress;
  if (classifyUrl(address).kind !== "sign-in" || typeof page?.evaluate !== "function") return null;
  try {
    const found = await Promise.race([
      page.evaluate(() => {
        const text = (document.body && document.body.innerText) || "";
        const match = text.match(/AADSTS\d{3,7}/i);
        return match ? match[0] : null;
      }),
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs).unref?.()),
    ]);
    return extractAadstsCode(found);
  } catch {
    return null;
  }
}

/** What some common codes mean, and which cause they point to. Numbers are public Microsoft error codes. */
export const AADSTS_INFO = Object.freeze({
  AADSTS50196: { cause: "client-loop", meaning: "Microsoft stopped a sign-in that kept repeating." },
  AADSTS50058: { cause: "cookies-blocked", meaning: "The sign-in page could not find your signed-in session. Cookies may be blocked." },
  AADSTS50097: { cause: "conditional-access", meaning: "Your organization requires the sign-in to come from a registered device." },
  AADSTS50074: { cause: "mfa", meaning: "A second step (multi-factor authentication) is required." },
  AADSTS50076: { cause: "mfa", meaning: "A second step (multi-factor authentication) is required." },
  AADSTS50079: { cause: "mfa", meaning: "You must register for multi-factor authentication." },
  AADSTS50133: { cause: "stale-session", meaning: "The saved session expired." },
  AADSTS50173: { cause: "stale-session", meaning: "The saved sign-in is no longer valid." },
  AADSTS53000: { cause: "conditional-access", meaning: "Your organization requires a compliant device." },
  AADSTS53001: { cause: "conditional-access", meaning: "Your organization requires a domain-joined device." },
  AADSTS53002: { cause: "conditional-access", meaning: "Your organization has not approved this app." },
  AADSTS53003: { cause: "conditional-access", meaning: "A Conditional Access policy blocked the sign-in." },
  AADSTS530003: { cause: "conditional-access", meaning: "Your organization requires a managed device." },
  AADSTS500133: { cause: "clock-skew", meaning: "This computer's clock is too far from the real time." },
  AADSTS700082: { cause: "stale-session", meaning: "The saved sign-in expired." },
  AADSTS16000: { cause: "mfa", meaning: "Pick an account to continue." },
});

// ── Ping-pong detection ────────────────────────────────────────────────────

/**
 * Notice a browser bouncing between a product and a sign-in host. A bounce is a short visit to a sign-in page that
 * follows a product page. Three bounces within 90 seconds, with no visit to a sign-in page that lasted long enough for
 * a person to type, is a loop. A long visit (a person typing, an approval on a phone) clears the count.
 */
export function createPingPongDetector({ windowMs = 90_000, minBounces = 3, inputMs = 8_000 } = {}) {
  let current = null;
  let sawApp = false;
  let bounces = [];
  const hops = [];
  const closeVisit = (visit, at) => {
    if (visit.kind !== "sign-in") return;
    if (at - visit.start >= inputMs || visit.input) bounces = [];
    else if (visit.afterApp) bounces.push(visit.start);
  };
  return {
    /** Record where the browser is. `info` is `classifyUrl(address)`; `at` is a time in ms that only has to increase. */
    hop(info, at) {
      const kind = info?.kind === "sign-in" ? "sign-in" : info?.kind === "app" ? "app" : null;
      if (!kind) return;
      if (current && current.kind === kind) {
        if (info.host !== current.host || info.path !== current.path) {
          current.host = info.host;
          current.path = info.path;
          hops.push({ at, kind, host: info.host, path: info.path });
        }
        if (kind === "sign-in" && at - current.start >= inputMs) current.input = true;
        return;
      }
      if (current) closeVisit(current, at);
      current = { kind, start: at, host: info.host, path: info.path, afterApp: sawApp, input: false };
      if (kind === "app") sawApp = true;
      hops.push({ at, kind, host: info.host, path: info.path });
      if (hops.length > 80) hops.shift();
    },
    /** Let a visit that is still going count as a person typing once it has lasted long enough. */
    tick(at) {
      if (current?.kind === "sign-in" && at - current.start >= inputMs && !current.input) {
        current.input = true;
        bounces = [];
      }
    },
    result(at) {
      const recent = bounces.filter((start) => at - start <= windowMs);
      return { detected: recent.length >= minBounces, bounces: recent.length, windowMs };
    },
    /** The hops so far: host and path only, for a trace and a report. */
    hops: () => hops.map((h) => ({ at: h.at, kind: h.kind, host: h.host, path: h.path })),
    reset() {
      current = null;
      sawApp = false;
      bounces = [];
      hops.length = 0;
    },
  };
}

// ── The diagnosis ──────────────────────────────────────────────────────────

const CAUSES = Object.freeze({
  "waiting-for-you": {
    title: "The sign-in page was waiting for you",
    text: "The sign-in page stayed open and nothing changed, so it was probably waiting for a password, an approval, or for someone to look at the window.",
    fix: "Switch to the companion's browser window, finish the sign-in there (choose Yes on 'Stay signed in?'), and leave the window alone until the product opens. Use --sign-in-wait=<seconds> to allow more time.",
  },
  "synced-profile": {
    title: "The sign-in files are in a synced folder",
    text: "The companion's data folder is inside OneDrive or another synced folder, which can lock or lose the browser's sign-in files.",
    fix: "Use a local folder: run the companion with --home set to the local folder it prints (the default is local from version 1.4.0), then sign in once.",
  },
  "cookies-blocked": {
    title: "Cookies are blocked",
    text: "The browser blocks cookies, or third-party cookies, for the Microsoft sign-in or the product, so the sign-in cannot be remembered.",
    fix: "In the companion's browser window open edge://settings/content/cookies (or chrome://settings/cookies) and allow cookies for login.microsoftonline.com and the product's site.",
  },
  "conditional-access": {
    title: "Your organization restricts how you can sign in",
    text: "A Conditional Access policy may require a compliant or managed device, or a specific browser, and this browser does not meet it.",
    fix: "Use the installed Microsoft Edge with your work account on a managed computer, or ask your administrator whether this sign-in is allowed. Run --check-signin and share the verdict if you ask them.",
  },
  "clock-skew": {
    title: "The clock on this computer is off",
    text: "Sign-in fails when this computer's clock differs from the real time by more than a few minutes.",
    fix: "Turn on automatic date and time (and the time zone), then try again.",
  },
  "stale-session": {
    title: "The saved sign-in is stale",
    text: "A sign-in saved earlier may have expired or been revoked, and it can send the browser around in circles.",
    fix: "Run: node companion.mjs --forget-signin=<product> (or all), then sign in once more.",
  },
  "popups-tracking": {
    title: "Pop-ups or tracking prevention interfere",
    text: "Blocked pop-ups, or a strict tracking-prevention setting, can break the Microsoft sign-in hand-off.",
    fix: "In the companion's browser window allow pop-ups and redirects for login.microsoftonline.com, and set tracking prevention to Balanced.",
  },
  "automation-browser": {
    title: "The browser was started by automation",
    text: "A browser started with automation switches can look different to device-based sign-in, so a managed device may not be recognized.",
    fix: "Use the default launch (--launch=attach), which starts your normal Edge or Chrome, and sign in there.",
  },
  "client-loop": {
    title: "Microsoft stopped a repeating sign-in",
    text: "The sign-in service detected the same request repeating and stopped it.",
    fix: "Close the companion's browser window, run --forget-signin=<product>, and sign in once more without reloading the page.",
  },
  mfa: {
    title: "A second step is needed",
    text: "Your organization asks for an extra approval (multi-factor authentication) that was not completed.",
    fix: "Complete the approval in the browser window (for example on your phone) and leave the window alone until the product opens.",
  },
});

export const SIGN_IN_CAUSE_IDS = Object.freeze(Object.keys(CAUSES));

/**
 * Turn what is known into a diagnosis: a list of checks (most likely first) and the one next step.
 * @param {object} facts
 * @param {string} facts.code why sign-in stopped: "ping-pong", "timeout", "bounced", "loop", ...
 * @param {string|null} [facts.aadsts] a visible AADSTS code
 * @param {{synced?: boolean, provider?: string}|null} [facts.synced]
 * @param {"attach"|"playwright"|null} [facts.launch]
 * @param {{blocked?: boolean|null}|null} [facts.cookies]
 * @param {{joined?: boolean|null, prt?: boolean|null}|null} [facts.device]
 * @param {number|null} [facts.skewSec]
 * @param {boolean} [facts.savedSession]
 * @param {number} [facts.bounces]
 * @param {string} [facts.product]
 */
export function diagnoseSignIn(facts = {}) {
  const info = facts.aadsts ? AADSTS_INFO[String(facts.aadsts).toUpperCase()] || null : null;
  const status = new Map();
  const mark = (id, level) => {
    const order = { unknown: 0, possible: 1, likely: 2 };
    if ((order[level] ?? 0) > (order[status.get(id)] ?? -1)) status.set(id, level);
  };
  for (const id of Object.keys(CAUSES)) status.set(id, id === "waiting-for-you" ? "ruled-out" : "possible");
  if (facts.code === "timeout" && !facts.aadsts && !(facts.bounces > 0)) mark("waiting-for-you", "likely");
  if (facts.synced?.synced) mark("synced-profile", "likely");
  else if (facts.synced && facts.synced.synced === false) status.set("synced-profile", "ruled-out");
  if (info) mark(info.cause, "likely");
  if (facts.cookies?.blocked === true) mark("cookies-blocked", "likely");
  else if (facts.cookies?.blocked === false && !(info && info.cause === "cookies-blocked")) status.set("cookies-blocked", "ruled-out");
  if (facts.device && (facts.device.joined === true || facts.device.prt === true) && facts.launch === "playwright") mark("automation-browser", "likely");
  if (facts.device && facts.device.joined === true && facts.code === "ping-pong") mark("conditional-access", "likely");
  if (typeof facts.skewSec === "number") {
    if (Math.abs(facts.skewSec) >= 180) mark("clock-skew", "likely");
    else status.set("clock-skew", "ruled-out");
  }
  if (facts.savedSession && facts.code !== "timeout") mark("stale-session", "likely");
  if (facts.launch === "playwright" && !facts.device) mark("automation-browser", "possible");
  if (facts.code === "timeout") status.set("popups-tracking", "possible");
  if (facts.code === "ping-pong" && status.get("popups-tracking") !== "likely") mark("popups-tracking", "possible");

  const rank = { likely: 0, possible: 1, unknown: 2, "ruled-out": 3 };
  const checks = [...status.entries()]
    .map(([id, level]) => ({ id, level, title: CAUSES[id].title, text: CAUSES[id].text, fix: CAUSES[id].fix }))
    .sort((a, b) => rank[a.level] - rank[b.level]);
  const likely = checks.filter((c) => c.level === "likely");
  const lead = likely[0] || checks.find((c) => c.level === "possible") || null;

  const what = {
    "ping-pong": `The browser went back and forth between the product and the Microsoft sign-in page${facts.bounces ? ` ${facts.bounces} times` : " several times"} without waiting for you to sign in.`,
    bounced: "You signed in, but the browser was sent back to the sign-in page right away.",
    loop: "The browser kept returning to the sign-in page.",
    timeout: "The sign-in was not finished in time.",
    "sign-in-page": "The product showed a sign-in page after sign-in.",
  }[facts.code] || "Sign-in did not finish.";
  const code = facts.aadsts ? ` Microsoft reported ${String(facts.aadsts).toUpperCase()}${info ? `: ${info.meaning}` : "."}` : "";
  const product = facts.product || "<product>";
  return {
    code: String(facts.code || "sign-in"),
    aadsts: facts.aadsts ? String(facts.aadsts).toUpperCase() : null,
    summary: `${what}${code}`.trim(),
    nextStep: lead ? lead.fix.replace(/<product>/g, product) : `Run: node companion.mjs --check-signin=${product} and send the result.`,
    checks: checks.map((c) => ({ ...c, fix: c.fix.replace(/<product>/g, product) })),
  };
}

/** The diagnosis as lines for the companion's window: the summary, then each check that is likely or possible. */
export function diagnosisLines(diagnosis) {
  if (!diagnosis) return [];
  const lines = [diagnosis.summary, "Things that can cause this (the first ones are the most likely here):"];
  const mark = { likely: "likely", possible: "possible", unknown: "unknown", "ruled-out": "not the cause" };
  for (const check of diagnosis.checks.filter((c) => c.level !== "ruled-out")) lines.push(`  - ${check.title} (${mark[check.level]}): ${check.fix}`);
  lines.push(`Next step: ${diagnosis.nextStep}`);
  return lines;
}

/** What the portal receives about a failed sign-in: plain sentences and ids, bounded. No addresses, names, or codes beyond AADSTS. */
export function signInReport(diagnosis, { product = "" } = {}) {
  if (!diagnosis) return null;
  const word = (value, max) => String(value ?? "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, max);
  return {
    product: /^[a-z0-9-]{1,60}$/i.test(String(product)) ? String(product) : "",
    code: word(diagnosis.code, 24),
    aadsts: /^AADSTS\d{3,7}$/.test(String(diagnosis.aadsts || "")) ? diagnosis.aadsts : null,
    summary: word(diagnosis.summary, 400),
    nextStep: word(diagnosis.nextStep, 300),
    checks: (diagnosis.checks || [])
      .filter((c) => c.level === "likely" || c.level === "possible")
      .slice(0, 8)
      .map((c) => ({ id: SIGN_IN_CAUSE_IDS.includes(c.id) ? c.id : "other", level: c.level === "likely" ? "likely" : "possible", title: word(c.title, 100), fix: word(c.fix, 260) })),
  };
}
