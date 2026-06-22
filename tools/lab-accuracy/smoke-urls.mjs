// Playwright smoke test for the documented start URLs.
//
// Authenticated Copilot Studio screenshots cannot be re-captured unattended
// (interactive sign-in + manual UI staging per shot). What we CAN automate is
// verifying that every documented entry point still loads in a real browser —
// catching renamed/retired portals before a maintainer sits down to re-capture.
//
// Loads each unique startUrl from the labs' shots.json manifests in headless
// Chromium, records the final URL + HTTP status + page title, and writes
// out/smoke.json. Login redirects are expected and treated as reachable.

import { chromium } from "playwright";
import { loadAllLabs, writeReport } from "./lib/labs.mjs";

const NAV_TIMEOUT_MS = 45000;

function collectStartUrls(labs) {
  const map = new Map(); // url -> [labNames]
  for (const lab of labs) {
    const url = lab.shots?.startUrl;
    if (!url) continue;
    if (!map.has(url)) map.set(url, []);
    map.get(url).push(lab.name);
  }
  return map;
}

async function main() {
  const labs = loadAllLabs();
  const startUrls = collectStartUrls(labs);

  const report = {
    generatedAt: new Date().toISOString(),
    summary: { urls: startUrls.size, reachable: 0, unreachable: 0 },
    urls: [],
  };

  if (startUrls.size === 0) {
    console.log("No startUrl entries found in any shots.json; nothing to smoke test.");
    writeReport("smoke.json", report);
    return;
  }

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  for (const [url, usedBy] of startUrls.entries()) {
    const record = { url, usedBy, status: null, finalUrl: null, title: null, reachable: false, error: null };
    try {
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      record.status = response ? response.status() : null;
      record.finalUrl = page.url();
      record.title = await page.title().catch(() => null);
      // A login redirect (e.g. to login.microsoftonline.com) still proves the
      // entry point is alive, so anything that loaded without an HTTP error is reachable.
      record.reachable = !record.status || record.status < 400;
    } catch (error) {
      record.error = error.message.split("\n")[0];
      record.reachable = false;
    }
    report.urls.push(record);
    if (record.reachable) report.summary.reachable += 1;
    else report.summary.unreachable += 1;
    console.log(`• ${record.reachable ? "OK " : "FAIL"} ${url} → ${record.status ?? record.error}`);
  }

  await browser.close();
  const target = writeReport("smoke.json", report);
  console.log(`\nSmoke report written to ${target}`);
  console.log(`Summary: ${report.summary.reachable} reachable, ${report.summary.unreachable} unreachable.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
