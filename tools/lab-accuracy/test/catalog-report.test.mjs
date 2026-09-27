import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  DEFAULT_CATALOG_MAX_AGE_DAYS,
  analyzeFeature,
  buildCatalogReport,
  catalogMaxAgeDays,
  createVendorLinkChecker,
  catalogNeedsAction,
  isCatalogReport,
  renderCatalogSection,
  verificationAgeDays,
} from "../lib/catalog-report.mjs";

const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-09-27T12:00:00Z");
const PAGE = "https://learn.microsoft.com/microsoft-copilot-studio/page";
const OTHER = "https://learn.microsoft.com/microsoft-copilot-studio/other";

function feature(overrides = {}) {
  return {
    id: "demo",
    name: "Demo feature",
    docUrls: [PAGE, OTHER],
    lastVerified: "2026-09-01",
    verifiedAgainst: PAGE,
    ...overrides,
  };
}

function okResults(...urls) {
  return new Map(urls.map((url) => [url, { url, status: 200, ok: true, finalUrl: url }]));
}

test("the freshness threshold defaults to 180 days and can be overridden", () => {
  assert.equal(DEFAULT_CATALOG_MAX_AGE_DAYS, 180);
  assert.equal(catalogMaxAgeDays([], {}), 180);
  assert.equal(catalogMaxAgeDays(["--max-age-days=90"], {}), 90);
  assert.equal(catalogMaxAgeDays(["--max-age-days", "45"], {}), 45);
  assert.equal(catalogMaxAgeDays([], { CATALOG_MAX_AGE_DAYS: "30" }), 30);
  // The flag wins over the environment, and nonsense falls through to the default.
  assert.equal(catalogMaxAgeDays(["--max-age-days=60"], { CATALOG_MAX_AGE_DAYS: "30" }), 60);
  assert.equal(catalogMaxAgeDays(["--max-age-days=soon"], { CATALOG_MAX_AGE_DAYS: "-5" }), 180);
});

test("verification age is whole days since lastVerified", () => {
  assert.equal(verificationAgeDays("2026-09-27", NOW), 0);
  assert.equal(verificationAgeDays("2026-03-31", NOW), 180);
  assert.equal(verificationAgeDays("not-a-date", NOW), null);
  assert.equal(verificationAgeDays(undefined, NOW), null);
});

test("a recently verified feature with live links is clean", () => {
  const record = analyzeFeature(feature(), okResults(PAGE, OTHER), { now: NOW, maxAgeDays: 180 });
  assert.equal(record.stale, false);
  assert.equal(record.ageDays, 26);
  assert.deepEqual(record.verificationProblems, []);
  assert.deepEqual(record.brokenLinks, []);
  assert.deepEqual(record.unreachableLinks, []);
  assert.deepEqual(record.redirectedLinks, []);
  assert.equal(record.linkCount, 2);
});

test("a lastVerified older than the threshold is stale, and the threshold is exclusive", () => {
  const onTheLine = analyzeFeature(feature({ lastVerified: "2026-03-31" }), okResults(PAGE, OTHER), { now: NOW, maxAgeDays: 180 });
  assert.equal(onTheLine.ageDays, 180);
  assert.equal(onTheLine.stale, false);

  const overdue = analyzeFeature(feature({ lastVerified: "2026-03-30" }), okResults(PAGE, OTHER), { now: NOW, maxAgeDays: 180 });
  assert.equal(overdue.stale, true);
});

test("broken, unreachable, and moved links are told apart; a locale redirect is not a move", () => {
  const results = new Map([
    [PAGE, { url: PAGE, status: 200, ok: true, finalUrl: PAGE.replace("learn.microsoft.com/", "learn.microsoft.com/en-us/") }],
    [OTHER, { url: OTHER, status: 404, ok: false, finalUrl: OTHER }],
  ]);
  const moved = "https://learn.microsoft.com/microsoft-copilot-studio/moved";
  results.set(moved, { url: moved, status: 200, ok: true, finalUrl: "https://learn.microsoft.com/en-us/microsoft-copilot-studio/new-home" });
  const timeout = "https://learn.microsoft.com/microsoft-copilot-studio/slow";
  results.set(timeout, { url: timeout, status: 0, ok: false, error: "timeout" });

  const record = analyzeFeature(feature({ docUrls: [PAGE, OTHER, moved, timeout] }), results, { now: NOW });
  assert.deepEqual(record.brokenLinks.map((l) => l.url), [OTHER]);
  assert.deepEqual(record.unreachableLinks.map((l) => l.url), [timeout]);
  assert.deepEqual(record.redirectedLinks, [
    { url: moved, finalUrl: "https://learn.microsoft.com/en-us/microsoft-copilot-studio/new-home" },
  ]);
});

test("missing or foreign verification metadata is reported with the catalog's own rules", () => {
  const missing = analyzeFeature(feature({ lastVerified: undefined, verifiedAgainst: undefined }), okResults(PAGE, OTHER), { now: NOW });
  assert.equal(missing.verificationProblems.length, 2);
  assert.equal(missing.stale, false, "an unknown age is invalid, not stale");

  const foreign = "https://learn.microsoft.com/microsoft-copilot-studio/elsewhere";
  const borrowed = analyzeFeature(feature({ verifiedAgainst: foreign }), okResults(PAGE, OTHER, foreign), { now: NOW });
  assert.match(borrowed.verificationProblems[0], /not one of this feature's docUrls/);
  // verifiedAgainst is link-checked even when it is not a docUrl.
  assert.equal(borrowed.linkCount, 3);
});

test("the report checks each URL once and summarises every signal", async () => {
  const calls = [];
  const checkLink = async (url) => {
    calls.push(url);
    return url === OTHER ? { url, status: 410, ok: false } : { url, status: 200, ok: true, finalUrl: url };
  };
  const catalog = {
    features: [
      feature({ id: "fresh" }),
      feature({ id: "old", lastVerified: "2025-01-01" }),
      feature({ id: "unstamped", lastVerified: undefined }),
    ],
  };

  const report = await buildCatalogReport(catalog, { checkLink, now: NOW, maxAgeDays: 180 });
  assert.deepEqual(calls.sort(), [OTHER, PAGE]);
  assert.equal(report.maxAgeDays, 180);
  assert.equal(report.summary.features, 3);
  assert.equal(report.summary.links, 2);
  assert.equal(report.summary.brokenLinks, 3, "the dead page is reported against every feature that cites it");
  assert.equal(report.summary.staleFeatures, 1);
  assert.equal(report.summary.unverifiedFeatures, 1);
  assert.deepEqual(report.summary.oldestVerification, { id: "old", lastVerified: "2025-01-01", ageDays: 634 });
  assert.equal(isCatalogReport(report), true);
  assert.equal(catalogNeedsAction(report), true);
});

test("a clean catalog report needs no action", async () => {
  const report = await buildCatalogReport({ features: [feature()] }, {
    checkLink: async (url) => ({ url, status: 200, ok: true, finalUrl: url }),
    now: NOW,
  });
  assert.equal(catalogNeedsAction(report), false);
});

test("the catalog status fails closed", async () => {
  assert.equal(catalogNeedsAction(null), true);
  assert.equal(catalogNeedsAction({}), true);
  assert.equal(catalogNeedsAction({ summary: { features: 1 }, features: [{}] }), true);

  const empty = await buildCatalogReport({ features: [] }, { checkLink: async () => ({}), now: NOW });
  assert.equal(isCatalogReport(empty), true);
  assert.equal(catalogNeedsAction(empty), true, "an audit that checked nothing has shown nothing");

  const clean = await buildCatalogReport({ features: [feature()] }, {
    checkLink: async (url) => ({ url, status: 200, ok: true, finalUrl: url }),
    now: NOW,
  });
  for (const mutate of [
    (r) => { r.summary.brokenLinks = 1; },
    (r) => { r.summary.unreachableLinks = 1; },
    (r) => { r.summary.staleFeatures = 1; },
    (r) => { r.summary.unverifiedFeatures = 1; },
    (r) => { r.features[0].brokenLinks = "nope"; },
    (r) => { r.features.push(r.features[0]); },
    (r) => { delete r.maxAgeDays; },
  ]) {
    const copy = structuredClone(clean);
    mutate(copy);
    assert.equal(catalogNeedsAction(copy), true);
  }
});

test("the issue section lists what a maintainer has to do", async () => {
  const checkLink = async (url) => (url === OTHER ? { url, status: 404, ok: false } : { url, status: 200, ok: true, finalUrl: url });
  const report = await buildCatalogReport({ features: [feature({ id: "old", lastVerified: "2025-01-01" })] }, { checkLink, now: NOW });
  const body = renderCatalogSection(report).join("\n");

  assert.match(body, /^### 🧭 Lab-builder catalog/);
  assert.match(body, /Features checked: \*\*1\*\*/);
  assert.match(body, /Broken catalog links[\s\S]*`old` → https:\/\/learn\.microsoft\.com\/microsoft-copilot-studio\/other \(HTTP 404\)/);
  assert.match(body, /Features due for re-verification[\s\S]*`old` — last verified 2025-01-01 \(634 days ago\)/);
  assert.match(body, /docs\/lab-builder\.md#extending-the-catalog/);

  assert.match(renderCatalogSection(null).join("\n"), /No valid catalog report was produced/);
});

function runCheckCatalog(catalog, args = [], t) {
  const dir = mkdtempSync(join(tmpdir(), "lab-catalog-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const catalogPath = join(dir, "features.json");
  writeFileSync(catalogPath, JSON.stringify(catalog));
  const { GITHUB_OUTPUT: _output, CATALOG_MAX_AGE_DAYS: _age, ...env } = process.env;
  // Asynchronous on purpose: a synchronous spawn would block this process's
  // event loop, and with it the fixture HTTP server the child is requesting.
  const child = spawn(process.execPath, [join(toolRoot, "check-catalog.mjs"), ...args], {
    env: { ...env, LAB_ACCURACY_OUT_DIR: dir, LAB_CATALOG_PATH: catalogPath },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return once(child, "close").then(([status]) => ({
    run: { status, stdout, stderr },
    report: JSON.parse(readFileSync(join(dir, "catalog.json"), "utf8")),
  }));
}

test("check-catalog writes out/catalog.json and exits non-zero only under --strict", async (t) => {
  const informational = await runCheckCatalog({ features: [] }, [], t);
  assert.equal(informational.run.status, 0, informational.run.stderr);
  assert.equal(isCatalogReport(informational.report), true);
  assert.equal(informational.report.maxAgeDays, 180);

  const strict = await runCheckCatalog({ features: [] }, ["--strict", "--max-age-days=30"], t);
  assert.equal(strict.run.status, 1);
  assert.equal(strict.report.maxAgeDays, 30);
});

test("check-catalog requests every catalog link and records what it returned", async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(req.url === "/gone" ? 404 : 200, { "content-type": "text/html" });
    res.end("<html></html>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const { run, report } = await runCheckCatalog(
    { features: [feature({ docUrls: [`${base}/ok`, `${base}/gone`], verifiedAgainst: `${base}/ok` })] },
    [],
    t,
  );
  assert.equal(run.status, 0, run.stderr);
  const [record] = report.features;
  assert.deepEqual(record.brokenLinks.map((l) => [l.url, l.status]), [[`${base}/gone`, 404]]);
  // A plain-http verification page is itself a finding.
  assert.match(record.verificationProblems[0], /must be an https URL/);
  assert.match(run.stdout, /1 broken/);
});

test("the shipped catalog passes its own freshness rules", () => {
  // Offline: a threshold large enough that only metadata problems could fail.
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { readFileSync } from "node:fs";
       import { CATALOG_PATH, analyzeFeature } from ${JSON.stringify(new URL("../lib/catalog-report.mjs", import.meta.url).href)};
       const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
       const bad = catalog.features.flatMap((f) => analyzeFeature(f, new Map()).verificationProblems);
       console.log(JSON.stringify({ count: catalog.features.length, bad }));`,
    ],
    { encoding: "utf8" },
  );
  const { count, bad } = JSON.parse(output);
  assert.ok(count > 0);
  assert.deepEqual(bad, []);
});

// ── Vendor documentation (issue #39) ────────────────────────────────────────

const VENDOR = "https://docs.vendor.example.org/guide";

function vendorFeature(overrides = {}) {
  return feature({
    thirdPartySources: [{ vendor: "Vendor", title: "Vendor guide", url: VENDOR, stability: "Stable." }],
    ...overrides,
  });
}

/** A fetch stand-in: `routes` maps a URL to { status, location?, type? }. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, redirect: init?.redirect });
    const route = routes[url] || { status: 404 };
    const headers = new Map(Object.entries({
      "content-type": route.type ?? "text/html; charset=utf-8",
      ...(route.location ? { location: route.location } : {}),
      ...(route.length ? { "content-length": String(route.length) } : {}),
    }));
    return { status: route.status, ok: route.status >= 200 && route.status < 300, headers: { get: (key) => headers.get(key) ?? null }, body: null };
  };
  impl.calls = calls;
  return impl;
}

test("vendor links are checked separately and bucketed with the third-party rules", async () => {
  const learnCalls = [];
  const checkLink = async (url) => {
    learnCalls.push(url);
    return { url, status: 200, ok: true, finalUrl: url };
  };
  const statuses = { [VENDOR]: 403, "https://docs.vendor.example.org/gone": 404, "https://docs.vendor.example.org/slow": 0 };
  const checkVendorLink = async (url) => (statuses[url] ? { url, status: statuses[url], ok: false } : { url, status: 0, ok: false, error: "timeout" });

  const catalog = {
    features: [
      vendorFeature({
        thirdPartySources: [
          { vendor: "V", title: "Bot-blocked", url: VENDOR, stability: "s" },
          { vendor: "V", title: "Gone", url: "https://docs.vendor.example.org/gone", stability: "s" },
          { vendor: "V", title: "Slow", url: "https://docs.vendor.example.org/slow", stability: "s" },
        ],
      }),
    ],
  };
  const report = await buildCatalogReport(catalog, { checkLink, checkVendorLink, now: NOW });
  const [record] = report.features;

  assert.deepEqual(learnCalls.sort(), [OTHER, PAGE], "vendor URLs never go through the Learn checker");
  assert.equal(report.summary.vendorLinks, 3);
  assert.deepEqual(record.unverifiableLinks.map((l) => [l.url, l.status]), [[VENDOR, 403]], "403 is unverifiable, not broken");
  assert.deepEqual(record.brokenLinks.map((l) => l.url), ["https://docs.vendor.example.org/gone"]);
  assert.deepEqual(record.unreachableLinks.map((l) => l.url), ["https://docs.vendor.example.org/slow"]);
  assert.equal(record.brokenLinks[0].party, "third");
  assert.equal(catalogNeedsAction(report), true);

  // Unverifiable alone does not need a maintainer.
  const onlyBlocked = await buildCatalogReport({ features: [vendorFeature()] }, {
    checkLink,
    checkVendorLink: async (url) => ({ url, status: 429, ok: false }),
    now: NOW,
  });
  assert.equal(onlyBlocked.summary.unverifiableLinks, 1);
  assert.equal(catalogNeedsAction(onlyBlocked), false);
  assert.match(renderCatalogSection(onlyBlocked).join("\n"), /Vendor links a site refused to check \(HTTP 401\/403\/429, no action required\)/);
});

test("a verifiedAgainst on a vendor page is checked as a vendor link", async () => {
  const checkLink = async (url) => ({ url, status: 200, ok: true, finalUrl: url });
  const vendorCalls = [];
  const checkVendorLink = async (url) => {
    vendorCalls.push(url);
    return { url, status: 200, ok: true, finalUrl: url };
  };
  const report = await buildCatalogReport({ features: [vendorFeature({ verifiedAgainst: VENDOR })] }, { checkLink, checkVendorLink, now: NOW });
  assert.deepEqual(vendorCalls, [VENDOR]);
  assert.deepEqual(report.features[0].verificationProblems, []);
  assert.equal(catalogNeedsAction(report), false);
});

test("the vendor checker follows the lab builder's rules and never follows a redirect off the allowlist", async () => {
  const hosts = ["docs.vendor.example.org"];
  const ok = createVendorLinkChecker({
    allowedHosts: hosts,
    fetchImpl: fakeFetch({ [VENDOR]: { status: 301, location: "/guide/v2" }, "https://docs.vendor.example.org/guide/v2": { status: 200 } }),
  });
  assert.deepEqual(await ok(VENDOR), { url: VENDOR, status: 200, ok: true, finalUrl: "https://docs.vendor.example.org/guide/v2" });

  const offList = fakeFetch({ [VENDOR]: { status: 302, location: "https://tracker.example.net/login" } });
  const refused = await createVendorLinkChecker({ allowedHosts: hosts, fetchImpl: offList })(VENDOR);
  assert.equal(refused.refused, true);
  assert.equal(refused.status, 0);
  assert.match(refused.error, /tracker\.example\.net is not on the vendor allowlist/);
  assert.deepEqual(offList.calls.map((c) => c.url), [VENDOR], "the off-list destination is never requested");
  assert.ok(offList.calls.every((c) => c.redirect === "manual"));

  const unlisted = fakeFetch({});
  assert.match((await createVendorLinkChecker({ allowedHosts: [], fetchImpl: unlisted })(VENDOR)).error, /not requested/);
  assert.equal(unlisted.calls.length, 0);

  const pdf = await createVendorLinkChecker({ allowedHosts: hosts, fetchImpl: fakeFetch({ [VENDOR]: { status: 200, type: "application/pdf" } }) })(VENDOR);
  assert.match(pdf.error, /content type is application\/pdf/);

  const huge = await createVendorLinkChecker({ allowedHosts: hosts, fetchImpl: fakeFetch({ [VENDOR]: { status: 200, length: 3 * 1024 * 1024 } }) })(VENDOR);
  assert.match(huge.error, /larger than the builder's/);

  const blocked = await createVendorLinkChecker({ allowedHosts: hosts, fetchImpl: fakeFetch({ [VENDOR]: { status: 403 } }) })(VENDOR);
  assert.deepEqual(blocked, { url: VENDOR, status: 403, ok: false, finalUrl: VENDOR });
});

test("a refused vendor link needs action and says what every build will hit", async () => {
  const report = await buildCatalogReport({ features: [vendorFeature()] }, {
    checkLink: async (url) => ({ url, status: 200, ok: true, finalUrl: url }),
    checkVendorLink: async (url) => ({ url, status: 0, ok: false, refused: true, error: "redirects to https://x.example.net/, and x.example.net is not on the vendor allowlist" }),
    now: NOW,
  });
  assert.equal(report.summary.refusedLinks, 1);
  assert.equal(report.summary.unreachableLinks, 0, "a refusal is not a network blip");
  assert.equal(catalogNeedsAction(report), true);
  const body = renderCatalogSection(report).join("\n");
  assert.match(body, /Vendor links the lab builder would refuse to read/);
  assert.match(body, /vendor-docs-unavailable/);
});

test("without an injected vendor checker, the catalog's own allowlist is used", async () => {
  // docs.vendor.example.org is not in vendorHosts, so the default checker refuses without a request.
  const report = await buildCatalogReport(
    { vendorHosts: [{ host: "other.example.org", reason: "r" }], features: [vendorFeature()] },
    { checkLink: async (url) => ({ url, status: 200, ok: true, finalUrl: url }), now: NOW },
  );
  assert.equal(report.summary.refusedLinks, 1);
  assert.match(report.features[0].refusedLinks[0].error, /not on the vendor allowlist/);
});
