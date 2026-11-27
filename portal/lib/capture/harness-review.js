/**
 * What a picture waiting for review says about its harness, read from what was saved with it (never written back).
 *
 * A companion older than 1.8.1 sent no proof of the harness, so a Microsoft Copilot picture could be staged in a Standard (Classic) lab
 * with only unrelated reasons ("labels missing", "recipe review") and nothing said it showed the wrong harness. The address of the page it
 * was taken on is saved with it, and its shape names a harness (see `harnessReview` in tools/screenshot-capture/harness.mjs). Here that
 * is read again every time the picture is shown, so such a picture says what it is without any file being rewritten.
 *
 * Evidence order: the companion's proof (it read the tabs of the page), then the shape of the address, then nothing.
 *   wrong-harness     the picture was taken in another harness than its slot needs: it cannot be accepted (keep it in the kept pictures, or retake it)
 *   harness-unproven  nothing proves the harness: a person looks, then accepts it
 *   ok                the proof says the slot's harness
 */

import { harnessLabel, harnessReview, isSpecificHarness, normalizeHarness, pictureHarnessLabel, sanitizeHarnessProof } from "../../../tools/screenshot-capture/harness.mjs";
import { harnessUnprovenMessage } from "../../../tools/screenshot-capture/image-verify.mjs";

/** What is added to the plain sentence when someone tries to accept a picture of the wrong harness. */
export const CANNOT_ACCEPT_SUFFIX = " It cannot be accepted for this screenshot. Keep it in the kept pictures, or retake it.";

/**
 * The harness review of a staged picture, or null when its slot needs no harness (or "either").
 * @param {{slotHarness: string|null, meta: object|null}} input `meta` is what was saved beside the staged picture
 * @returns {{code: "ok"|"wrong-harness"|"harness-unproven", found: string|null, foundLabel: string, source: "proof"|"address"|null, needed: string, neededLabel: string, message: string, canAccept: boolean, addressAgrees: boolean}|null}
 */
export function reviewStagedHarness({ slotHarness, meta }) {
  const needed = normalizeHarness(slotHarness);
  if (!isSpecificHarness(needed)) return null;
  const evidence = meta?.evidence && typeof meta.evidence === "object" && !Array.isArray(meta.evidence) ? meta.evidence : null;
  const finalUrl = String(evidence?.finalUrl || meta?.verification?.finalUrl || "");
  const proof = sanitizeHarnessProof(evidence?.harness);
  const review = harnessReview({ slotHarness: needed, proof, finalUrl });
  let message = review.message;
  if (review.code === "harness-unproven") {
    message = harnessUnprovenMessage({ wanted: needed, reached: evidence?.harnessReached || null, addressAgrees: review.addressAgrees, noEvidence: !evidence && !finalUrl });
  }
  return {
    code: review.code,
    found: review.found,
    foundLabel: pictureHarnessLabel(review.found),
    source: review.source,
    needed,
    neededLabel: harnessLabel(needed),
    message,
    canAccept: review.code !== "wrong-harness",
    addressAgrees: review.addressAgrees,
  };
}

/**
 * The reasons a picture that waits for review shows because of its harness, to go in front of the reasons it was saved with. A wrong-harness
 * picture always has one. A harness-unproven one has one only for a companion's picture (a person who uploaded it by hand vouches for it
 * when accepting), and only when the saved reasons do not already say so.
 */
export function derivedHarnessReasons(review, { source = null, saved = [] } = {}) {
  if (!review) return [];
  const has = (code) => (Array.isArray(saved) ? saved : []).some((r) => r?.code === code);
  if (review.code === "wrong-harness" && !has("wrong-harness")) return [{ code: "wrong-harness", level: "warn", message: review.message, derived: true }];
  if (review.code === "harness-unproven" && source === "companion" && !has("harness-unproven")) return [{ code: "harness-unproven", level: "warn", message: review.message, derived: true }];
  return [];
}

/** The check a picture waiting for review was saved with, with its harness reasons in front (a copy: the saved check is never changed). */
export function withHarnessReasons(verification, derived) {
  if (!verification || !derived.length) return verification;
  const saved = Array.isArray(verification.reasons) ? verification.reasons : [];
  return { ...verification, level: verification.level === "fail" ? "fail" : "warn", reasons: [...derived, ...saved] };
}

/** The answer to accepting a staged picture that was taken in the wrong harness (HTTP 409); nothing was written. */
export function wrongHarnessRefusal(review, filename) {
  return { outcome: "rejected", code: "wrong-harness", message: `${review.message}${CANNOT_ACCEPT_SUFFIX}`, filename };
}
