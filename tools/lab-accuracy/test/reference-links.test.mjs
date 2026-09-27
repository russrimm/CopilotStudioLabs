import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { FIRST_PARTY_HOSTS, loadAllLabs, parseReferenceLinks, repoRoot } from "../lib/labs.mjs";
import {
  checkThirdPartyLinks,
  classifyThirdParty,
  loadLinkPolicy,
  parseLinkPolicy,
  policySkip,
  referenceSummaryLines,
} from "../lib/reference-links.mjs";

const SAMPLE = [
  "# Lab",
  "",
  "Read [Create an agent](https://learn.microsoft.com/microsoft-copilot-studio/fundamentals-get-started).",
  "The spec lives at <https://modelcontextprotocol.io/specification/latest>.",
  "Use Microsoft Support (https://support.microsoft.com) for product issues.",
  "See [the explorer][explorer] and [the SDK](https://github.com/microsoft/Agents \"Agents SDK\").",
  "",
  "[explorer]: https://adaptivecards.microsoft.com/",
  "",
  "![Architecture](https://example.org/diagram.png)",
  '<a href="https://nodejs.org/">Node.js</a>',
  "Configure `http://localhost:5173` as the redirect URI.",
  "",
  "```text",
  "https://login.microsoftonline.com/{tenantID}/.well-known/openid-configuration",
  "```",
  "",
  "1. Add another website:",
  "",
  "    ~~~",
  "   https://code-only.example.org/inside-an-indented-fence",
  "    ~~~",
  "",
  "Duplicate [again](https://learn.microsoft.com/microsoft-copilot-studio/fundamentals-get-started).",
].join("\n");

test("reference links are classified as first-party (Learn) or third-party", () => {
  const links = parseReferenceLinks(SAMPLE);
  assert.deepEqual(
    links.map((link) => [link.url, link.party]),
    [
      ["https://adaptivecards.microsoft.com/", "third"],
      ["https://github.com/microsoft/Agents", "third"],
      ["https://learn.microsoft.com/microsoft-copilot-studio/fundamentals-get-started", "first"],
      ["https://modelcontextprotocol.io/specification/latest", "third"],
      ["https://nodejs.org/", "third"],
      ["https://support.microsoft.com", "third"],
    ],
  );
  assert.equal(links.find((link) => link.party === "first").host, "learn.microsoft.com");
  assert.deepEqual(FIRST_PARTY_HOSTS, ["learn.microsoft.com"]);
});

test("URLs in code, inline code, and image sources are not references", () => {
  const urls = parseReferenceLinks(SAMPLE).map((link) => link.url);
  for (const excluded of ["localhost", "login.microsoftonline.com", "code-only.example.org", "diagram.png"]) {
    assert.ok(!urls.some((url) => url.includes(excluded)), `${excluded} must not be a reference`);
  }
});

test("the Learn links used for drift are unchanged for every lab", () => {
  // Before issue #39 only Markdown inline links to Learn were collected. The
  // drift baseline was triaged against that set, so it must not move.
  const legacy = (markdown) => {
    const links = new Set();
    const re = /\]\((https?:\/\/learn\.microsoft\.com\/[^)\s]+)\)/gi;
    let match;
    while ((match = re.exec(markdown)) !== null) links.add(match[1].replace(/[).,]+$/, ""));
    return [...links].sort();
  };
  const labs = loadAllLabs();
  assert.ok(labs.length > 30);
  for (const lab of labs) {
    const markdown = readFileSync(`${repoRoot}/${lab.indexPath}`, "utf8");
    assert.deepEqual(lab.learnLinks, legacy(markdown), lab.name);
    assert.ok(lab.referenceLinks.every((link) => ["first", "third"].includes(link.party)));
  }
});

test("third-party check results are bucketed so bot blocks are not called broken", () => {
  assert.equal(classifyThirdParty({ status: 200 }), "ok");
  assert.equal(classifyThirdParty({ status: 301 }), "ok");
  for (const status of [401, 403, 429]) assert.equal(classifyThirdParty({ status }), "unverifiable");
  for (const status of [404, 410, 400, 500, 503]) assert.equal(classifyThirdParty({ status }), "broken");
  assert.equal(classifyThirdParty({ status: 0, error: "timeout" }), "unreachable");
});

test("the shipped link policy is valid and every skip has a reason", () => {
  const policy = loadLinkPolicy();
  assert.ok(policy.skip.length > 0);
  for (const entry of policy.skip) assert.ok(entry.reason.length > 20, entry.host);
  assert.equal(policySkip(policy, "learn.microsoft.com"), null);
  assert.ok(policySkip(policy, "copilotstudio.microsoft.com"));
  assert.ok(policySkip(policy, "your-tunnel.example"));
  // Portals that answer a bad path with 404 can be checked, so they are not skipped.
  assert.equal(policySkip(policy, "portal.azure.com"), null);
});

test("wildcards match subdomains only", () => {
  const policy = parseLinkPolicy({ skip: [{ host: "*.example", reason: "placeholder" }] });
  assert.ok(policySkip(policy, "your-tunnel.example"));
  assert.ok(policySkip(policy, "a.b.example"));
  assert.equal(policySkip(policy, "example"), null);
  assert.equal(policySkip(policy, "example.com"), null);
});

test("a malformed link policy is rejected rather than read loosely", () => {
  for (const [raw, expected] of [
    [{}, /skip array/],
    [{ skip: [{ host: "portal.azure.com" }] }, /needs a reason/],
    [{ skip: [{ host: "learn.microsoft.com", reason: "no" }] }, /first-party/],
    [{ skip: [{ host: "*.microsoft.com", reason: "too wide" }] }, /first-party/],
    [{ skip: [{ host: "https://x.example/", reason: "a URL" }] }, /not a host name/],
    [{ skip: [{ host: "a.example", reason: "one" }, { host: "a.example", reason: "two" }] }, /duplicate/],
  ]) {
    assert.throws(() => parseLinkPolicy(raw), expected);
  }
});

test("third-party links are checked once each, and skipped hosts are never requested", async () => {
  const policy = parseLinkPolicy({ skip: [{ host: "copilotstudio.microsoft.com", reason: "sign-in portal" }] });
  const links = parseReferenceLinks(
    [
      "[Learn](https://learn.microsoft.com/a)",
      "[Portal](https://copilotstudio.microsoft.com/)",
      "[Gone](https://vendor.example.org/gone)",
      "[Blocked](https://www.npmjs.com/package/x)",
      "[Slow](https://slow.example.org/)",
      "[Fine](https://ok.example.org/)",
    ].join("\n"),
  );
  const requested = [];
  const statuses = {
    "https://vendor.example.org/gone": 404,
    "https://www.npmjs.com/package/x": 403,
    "https://slow.example.org/": 0,
  };
  const result = await checkThirdPartyLinks(links, {
    policy,
    check: async (urls) => {
      requested.push(...urls);
      return urls.map((url) => ({ url, status: statuses[url] ?? 200, ...(statuses[url] === 0 ? { error: "timeout" } : {}) }));
    },
  });

  assert.ok(!requested.includes("https://learn.microsoft.com/a"), "first-party links are checked elsewhere");
  assert.ok(!requested.includes("https://copilotstudio.microsoft.com/"));
  assert.equal(result.checked, 4);
  assert.deepEqual(result.broken.map((r) => [r.url, r.status, r.party]), [["https://vendor.example.org/gone", 404, "third"]]);
  assert.deepEqual(result.unverifiable.map((r) => r.url), ["https://www.npmjs.com/package/x"]);
  assert.deepEqual(result.unreachable.map((r) => r.url), ["https://slow.example.org/"]);
  assert.deepEqual(result.skipped, [
    { url: "https://copilotstudio.microsoft.com/", host: "copilotstudio.microsoft.com", party: "third", reason: "sign-in portal" },
  ]);
});

test("broken third-party links become pull request annotations, not failures", () => {
  const references = {
    firstParty: { checked: 10, broken: 0, unreachable: 0 },
    thirdParty: { checked: 5, broken: 1, unreachable: 0, unverifiable: 1, skipped: 2 },
  };
  const warnings = [{ lab: { name: "18-x", indexPath: "labs/18-x/index.md" }, link: { url: "https://v.example.org/gone", status: 404 } }];

  const ci = referenceSummaryLines(references, warnings, { GITHUB_ACTIONS: "true" });
  assert.match(ci[0], /Microsoft Learn 10 checked \(0 broken, 0 unreachable\); third-party 5 checked \(1 broken, 0 unreachable, 1 unverifiable\), 2 skipped/);
  assert.match(ci[1], /^::warning file=labs\/18-x\/index\.md::Third-party link https:\/\/v\.example\.org\/gone returned HTTP 404\. This does not fail the pull request/);

  const local = referenceSummaryLines(references, warnings, {});
  assert.match(local[1], /^⚠ 18-x: /);
});
