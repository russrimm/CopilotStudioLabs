// Resolves feature tour callouts to rectangles on a captured page, and writes
// the sidecar file the site reads to draw numbered hotspots. Rectangles are
// fractions of the viewport (0 to 1), so they line up at any image size.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

export function sidecarName(filename) {
  return `${filename.replace(/\.[^.]+$/, "")}.callouts.json`;
}

const round = (n) => Math.round(n * 10000) / 10000;

// Returns null when the box is missing, empty, or entirely outside the viewport.
export function normalizeRect(box, viewport) {
  if (!box || !viewport?.width || !viewport?.height) return null;
  const left = Math.max(0, box.x);
  const top = Math.max(0, box.y);
  const right = Math.min(viewport.width, box.x + box.width);
  const bottom = Math.min(viewport.height, box.y + box.height);
  if (right - left < 1 || bottom - top < 1) return null;
  return {
    x: round(left / viewport.width),
    y: round(top / viewport.height),
    w: round((right - left) / viewport.width),
    h: round((bottom - top) / viewport.height),
  };
}

export function buildSidecar(filename, viewport, results) {
  return {
    schema: 1,
    filename,
    viewport: { width: viewport.width, height: viewport.height },
    callouts: results.map(({ n, label, rect }) => ({ n, label, rect: rect ?? null })),
  };
}

async function firstVisibleBox(locator) {
  const count = Math.min(await locator.count().catch(() => 0), 8);
  for (let i = 0; i < count; i += 1) {
    const item = locator.nth(i);
    if (await item.isVisible().catch(() => false)) {
      const box = await item.boundingBox().catch(() => null);
      if (box) return box;
    }
  }
  return null;
}

// Tries an exact text match first, then a looser one, because Copilot Studio
// labels often sit inside larger controls.
export async function resolveCallouts(page, callouts, viewport) {
  const results = [];
  for (const callout of callouts ?? []) {
    let box = await firstVisibleBox(page.getByText(callout.text, { exact: true }));
    if (!box) box = await firstVisibleBox(page.getByText(callout.text, { exact: false }));
    results.push({ n: callout.n, label: callout.label, rect: normalizeRect(box, viewport) });
  }
  return results;
}

export function writeSidecar(assetsDir, filename, viewport, results) {
  const file = join(assetsDir, sidecarName(filename));
  writeFileSync(file, `${JSON.stringify(buildSidecar(filename, viewport, results), null, 2)}\n`);
  return file;
}
