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

export function reportsNeedAction({ accuracy, screenshots, smoke }) {
  if (!isAccuracyReport(accuracy) || !isScreenshotReport(screenshots) || !isSmokeReport(smoke)) {
    return true;
  }

  return Boolean(
    accuracy.summary.brokenLinks
      || accuracy.summary.unreachableLinks
      || accuracy.summary.mcpDriftWarnings
      || accuracy.summary.mcpUnavailable
      || !screenshots.verifyShots.available
      || screenshots.verifyShots.critical
      || screenshots.verifyShots.warning
      || screenshots.summary.labsNeedingRecapture
      || smoke.summary.unreachable,
  );
}
