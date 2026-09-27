import { catalogNeedsAction } from "./catalog-report.mjs";

export function isAccuracyReport(report) {
  return Boolean(
    report
      && Array.isArray(report.labs)
      && report.summary
      && Number.isFinite(report.summary.brokenLinks)
      && Number.isFinite(report.summary.mcpDriftWarnings)
      && report.labs.every((lab) => Array.isArray(lab.brokenLinks) && Array.isArray(lab.unreachableLinks)),
  );
}

export function isScreenshotReport(report) {
  return Boolean(
    report
      && Array.isArray(report.labs)
      && report.summary
      && report.verifyShots
      && typeof report.verifyShots.available === "boolean"
      && report.labs.every(
        (lab) => Array.isArray(lab.missingImages)
          && Array.isArray(lab.staleImages)
          && Array.isArray(lab.criticalFindings),
      ),
  );
}

export function isSmokeReport(report) {
  return Boolean(
    report
      && Array.isArray(report.urls)
      && report.summary
      && report.urls.every((entry) => Array.isArray(entry.usedBy)),
  );
}

export const DEFAULT_DRIFT_BASELINE_MAX_AGE_DAYS = 90;

/** Maximum age of the drift baseline before the monthly audit asks for a re-triage. */
export function driftBaselineMaxAgeDays(env = process.env) {
  const value = Number(env.DRIFT_BASELINE_MAX_AGE_DAYS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_DRIFT_BASELINE_MAX_AGE_DAYS;
}

/** True when the accuracy run compared drift against a baseline. */
export function hasDriftBaseline(accuracy) {
  return Boolean(
    accuracy?.summary?.driftBaseline
      && typeof accuracy.summary.driftBaseline === "object"
      && Number.isFinite(accuracy.summary.unexpectedDriftWarnings),
  );
}

/**
 * An acknowledged warning is only trustworthy while someone keeps re-checking
 * it. A baseline with no valid date, or one older than the limit, counts as
 * stale so it cannot quietly suppress drift forever.
 */
export function driftBaselineIsStale(accuracy, maxAgeDays = driftBaselineMaxAgeDays()) {
  if (!hasDriftBaseline(accuracy)) return false;
  const { ageDays } = accuracy.summary.driftBaseline;
  return !Number.isFinite(ageDays) || ageDays > maxAgeDays;
}

/**
 * Drift that needs a maintainer. With a baseline, only unexpected drift counts;
 * without one, every warning does (fail closed).
 */
export function actionableDriftWarnings(accuracy) {
  return hasDriftBaseline(accuracy)
    ? accuracy.summary.unexpectedDriftWarnings
    : accuracy.summary.mcpDriftWarnings;
}

export function reportsNeedAction({ accuracy, screenshots, smoke, catalog }, { maxBaselineAgeDays } = {}) {
  if (!isAccuracyReport(accuracy) || !isScreenshotReport(screenshots) || !isSmokeReport(smoke)) {
    return true;
  }
  // The lab builder's feature catalog (issue #42); fails closed on its own.
  if (catalogNeedsAction(catalog)) return true;

  return Boolean(
    accuracy.summary.brokenLinks
      || accuracy.summary.unreachableLinks
      || actionableDriftWarnings(accuracy)
      || driftBaselineIsStale(accuracy, maxBaselineAgeDays)
      || accuracy.summary.mcpUnavailable
      || !screenshots.verifyShots.available
      || screenshots.verifyShots.critical
      || screenshots.verifyShots.warning
      || screenshots.summary.labsNeedingRecapture
      || smoke.summary.unreachable
      || referenceLinksNeedAction(accuracy),
  );
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * True when the accuracy report carries the first-/third-party reference split
 * (issue #39) in a usable shape. A report without it is treated as malformed,
 * so a run that silently skipped third-party links cannot pass as clean.
 */
export function isReferenceReport(accuracy) {
  const refs = accuracy?.summary?.references;
  return Boolean(
    refs
      && refs.firstParty
      && ["checked", "broken", "unreachable"].every((key) => isCount(refs.firstParty[key]))
      && refs.thirdParty
      && ["checked", "broken", "unreachable", "unverifiable", "skipped"].every((key) => isCount(refs.thirdParty[key]))
      && Array.isArray(accuracy.labs)
      && accuracy.labs.every(
        (lab) => lab.thirdPartyLinks
          && ["broken", "unreachable", "unverifiable", "skipped"].every((key) => Array.isArray(lab.thirdPartyLinks[key])),
      ),
  );
}

/**
 * Third-party links that need a maintainer: broken or unreachable ones. Links a
 * vendor site refused to an automated client (unverifiable) and hosts skipped
 * by policy are reported but are not, on their own, a reason to open the issue.
 * Fails closed when the split is missing or malformed.
 */
export function referenceLinksNeedAction(accuracy) {
  if (!isReferenceReport(accuracy)) return true;
  const { thirdParty } = accuracy.summary.references;
  return thirdParty.broken > 0 || thirdParty.unreachable > 0;
}
