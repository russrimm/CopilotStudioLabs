// `--setup-account[=product]`: the person chooses which account the screenshots come from.
//
// It opens the browser on the dedicated profile at the product's start page and tells the person, in plain language, to sign
// in with the account they want (for example a demo tenant). If the browser shows a list of accounts, or "Use another
// account", the PERSON uses it: the companion never clicks, types, or picks an account. It only watches the address
// (the same passive sign-in gate every capture uses), then checks that the page landed in a place that fits the person's
// own addresses, records how the account was chosen, keeps the sign-in on this computer, and closes the browser.
//
// It starts from a clean profile for the account mode in use, so the person is shown a sign-in page instead of the
// account that was saved before. Nothing else on the computer is touched.

import fs from "node:fs";

import { verifyProductAccount, describeAccount } from "./account-guard.mjs";
import { writeAccountRecord } from "./account-source.mjs";
import { acquireProfileLock } from "./attach.mjs";
import { createAuthGate, productLabel, profileDir, profileNamespace, saveSession } from "./auth.mjs";
import { readProductConfig, startUrlFor } from "./check-signin.mjs";
import { BrowserClosedError, classifyBrowserError } from "./lifecycle.mjs";
import { createSurfaceWatch } from "./surface-watch.mjs";

const noop = () => {};

/** Remove a profile's saved sign-in so the person chooses again. A profile another companion is using is left alone. */
export function clearProfile(dir, { acquire = acquireProfileLock } = {}) {
  if (!fs.existsSync(dir)) return { cleared: false, existed: false };
  const lock = acquire(dir);
  lock.release();
  fs.rmSync(dir, { recursive: true, force: true });
  return { cleared: true, existed: true };
}

/** The lines that tell the person what to do in the browser window. */
export function setupInstructions({ label, kind, inPrivate }) {
  return [
    `A browser window is opening for ${label}${inPrivate ? " (InPrivate)" : ""}. Sign in with the account you want your screenshots to come from, for example your demo tenant.`,
    "If the browser shows a list of accounts, choose the one you want, or choose “Use another account” and sign in. You do this yourself: the computer never clicks anything for you.",
    `When you see ${label}, this computer remembers the sign-in and closes the window. ${kind === "edge" && !inPrivate ? "Microsoft Edge may offer your Windows work account: only use it if you want screenshots from that account." : "If you do not see the window, it may be behind other windows: look for the new browser window on the taskbar."}`,
  ];
}

/**
 * Run the account setup for one product.
 * @param {object} options
 * @param {string} options.home the companion's data folder
 * @param {string} options.product
 * @param {object} options.playwright
 * @param {string[]} options.kinds browsers to try, best first
 * @param {object} options.account `{mode, explicitMode, os}`
 * @param {Function} options.open `openProfile` (passed in to avoid a circular import)
 * @param {object} [options.values] the capture settings of the job or lab, so the landing can be checked against the person's own addresses
 * @param {(state: {state: string, message: string}) => void} [options.onState] progress for the portal
 * @returns {Promise<{ok: boolean, account: object|null, message: string, decision: object|null}>}
 */
export async function runSetupAccount({ home, product, playwright, kinds, launch = "auto", account, open, values = {}, log = console.log, signInWaitSec = 600, sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)), trace = null, onState = noop, deps = {} }) {
  const label = productLabel(product);
  const namespace = profileNamespace({ mode: account.mode, osWorkAccount: account.os?.osWorkAccount ?? null });
  const config = await readProductConfig();
  const startUrl = startUrlFor(product, config);
  log(`Choosing the account for ${label}. Nothing is captured.`);
  trace?.event("setup-account-start", { product, mode: account.mode });

  for (const kind of kinds) {
    try {
      const cleared = (deps.clear || clearProfile)(profileDir(home, kind, product, namespace));
      if (cleared.cleared) log(`  Started from a clean ${browserWord(kind)} sign-in so you can choose the account.`);
    } catch (err) {
      if (err?.code === "PROFILE_IN_USE") {
        const message = String(err.message);
        log(message);
        onState({ state: "failed", message });
        return { ok: false, account: null, message, decision: null };
      }
    }
  }

  let opened;
  try {
    opened = await open({ playwright, home, profile: product, kinds, headless: false, log, trace, launch, account });
  } catch (err) {
    const message = String(err?.message || err).split("\n")[0];
    log(message);
    onState({ state: "failed", message });
    return { ok: false, account: null, message, decision: null };
  }

  let surfaceWatch = null;
  try {
    for (const line of setupInstructions({ label, kind: opened.kind, inPrivate: opened.inPrivate === true })) log(line);
    onState({ state: "waiting-for-you", message: `Sign in to ${label} in the browser window on your computer, with the account you want.` });
    const gate = createAuthGate({
      product,
      waitMs: signInWaitSec * 1000,
      pollMs: 250,
      settleMs: 1000,
      graceMs: 2500,
      confirmMs: 6000,
      firstLoadMs: 10_000,
      sleep: sleepFn,
      notify: ({ message }) => {
        log(message);
        if (surfaceWatch?.isCovered?.()) log("The sign-in window is behind other windows right now. Click the new browser window's icon on the taskbar to bring it forward.");
      },
      trace,
      ...(deps.gate || {}),
    });
    surfaceWatch = deps.surface === false ? null : createSurfaceWatch({ context: opened.context, pid: opened.context.companionPid, trace, ...(deps.surface || {}) });
    surfaceWatch?.start();
    const page = opened.context.pages()[0] || (await opened.context.newPage());
    // Once, before sign-in begins; never again while the person signs in.
    await page.bringToFront?.().catch(() => {});
    trace?.event("window-raise", { reason: "setup-account", times: 1 });

    let check;
    try {
      check = await verifyProductAccount({ page, gate, product, values, startUrl, ctx: { mode: account.mode, explicitMode: account.explicitMode === true, os: account.os, kind: opened.kind, inPrivate: opened.inPrivate === true }, dir: opened.dir, autonomous: false, trace, log, sleep: sleepFn });
    } catch (err) {
      if (err instanceof BrowserClosedError || classifyBrowserError(err) === "browser-closed") {
        const message = "The browser window was closed before the sign-in finished. Run this again when you are ready.";
        log(message);
        onState({ state: "failed", message });
        return { ok: false, account: null, message, decision: null };
      }
      throw err;
    }
    if (check.signIn) {
      const message = gate.describeFailure(1).replace(/ then retry the 1 screenshot\.$/, ".");
      log(message);
      onState({ state: "failed", message });
      return { ok: false, account: check.account, message, decision: null };
    }
    if (check.decision.action === "stop") {
      log(check.decision.message);
      trace?.event("setup-account-stopped", { product, code: check.decision.code });
      onState({ state: "needs-account", message: check.decision.message });
      return { ok: false, account: check.account, message: check.decision.message, decision: check.decision };
    }
    // The person chose this account on purpose, so it counts as confirmed even when no address of theirs could check it.
    writeAccountRecord(opened.dir, { source: check.source, confirmed: true, verified: check.decision.verified, verifiedFor: check.verifiedFor, inOsTenant: check.account.inOsTenant });
    await saveSession({ context: opened.context, dir: opened.dir, product, browser: opened.kind, captured: false }).catch(() => {});
    const account2 = { ...check.account, verified: check.decision.verified };
    const note = check.decision.verified ? "It fits your address." : "No address of yours was set to check it against, so it is confirmed because you chose it.";
    log(`Account chosen: ${describeAccount({ ...account2, verified: true })} ${note}`);
    log("The sign-in is saved on this computer. The saved files in the .auth folder give access to your account: keep them private.");
    trace?.event("setup-account-done", { product, source: check.source, verified: check.decision.verified });
    onState({ state: "done", message: "The account is chosen and saved." });
    return { ok: true, account: account2, message: "The account is chosen and saved.", decision: check.decision };
  } finally {
    await surfaceWatch?.stop?.().catch(() => {});
    await opened.context.close().catch(() => {});
  }
}

function browserWord(kind) {
  return kind === "edge" ? "Microsoft Edge" : kind === "chrome" ? "Google Chrome" : "Chromium";
}
