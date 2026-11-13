// Joins the feature model with the shot list and the screenshots found on
// disk, so every page and the tour read from one assembled structure.

import { inspectScreenshot } from "./screenshots.mjs";

export function assemble(model, shotList, screenshotsDir, { shotsPrefix = "" } = {}) {
  const byFeature = new Map();
  for (const shot of shotList.shots) {
    if (!byFeature.has(shot.feature)) byFeature.set(shot.feature, []);
    byFeature.get(shot.feature).push(shot);
  }

  const features = model.features.map((feature) => {
    const shots = (byFeature.get(feature.id) ?? []).map((shot) => {
      const info = inspectScreenshot(screenshotsDir, shot.filename);
      const ready = info.status === "ready";
      return {
        id: shot.id,
        filename: shot.filename,
        caption: shot.caption,
        alt: shot.alt ?? null,
        section: shot.section,
        navHint: shot.navHint,
        instructions: shot.instructions,
        status: info.status,
        reason: info.reason ?? null,
        src: ready ? `${shotsPrefix}screenshots/${shot.filename}` : null,
        width: ready ? info.width : null,
        height: ready ? info.height : null,
        callouts: shot.callouts.map((c) => ({
          n: c.n,
          label: c.label,
          note: c.note ?? "",
          rect: ready ? (info.rects?.get(c.n) ?? c.region ?? null) : null,
        })),
      };
    });
    const ready = shots.filter((s) => s.status === "ready").length;
    const screenshotStatus = shots.length === 0 || ready === 0 ? "pending" : ready === shots.length ? "ready" : "partial";
    return { ...feature, shots, screenshotStatus };
  });

  const totals = {
    features: features.length,
    shots: features.reduce((n, f) => n + f.shots.length, 0),
    shotsReady: features.reduce((n, f) => n + f.shots.filter((s) => s.status === "ready").length, 0),
  };
  return { ...model, features, totals };
}
