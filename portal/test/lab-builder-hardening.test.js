import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planScreenshots, copyScreenshots } from "../lib/lab-builder/screenshots.js";
import { createLinkChecker, isPublicUrl } from "../lib/lab-builder/linkcheck.js";
import { planLab } from "../lib/lab-builder/planner.js";
import { getFeatures, getFeature } from "../lib/lab-builder/catalog.js";
import { composeLab, escapeMarkdown } from "../lib/lab-builder/composer.js";
import { fetchDocPage } from "../lib/lab-builder/learn-mcp.js";
import { createRateLimiter, positiveIntFromEnv } from "../lib/rate-limit.js";
import { listGeneratedLabs, readGeneratedLab } from "../lib/lab-builder/generated-labs.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "lb-hardening-"));
}

test("screenshot refs that escape the lab assets folder are ignored", () => {
  const labsDir = tmp();
  try {
    mkdirSync(join(labsDir, "lab-a", "assets"), { recursive: true });
    writeFileSync(join(labsDir, "lab-a", "assets", "ok.png"), "x");
    writeFileSync(join(labsDir, "secret.txt"), "x");

    const plan = {
      features: [
        {
          id: "f1",
          name: "F1",
          order: 1,
          reuseScreenshots: [
            { lab: "lab-a", file: "ok.png" },
            { lab: "lab-a", file: "../../secret.txt" },
            { lab: "..", file: "secret.txt" },
            { lab: "lab-a", file: "sub/ok.png" },
            { lab: "lab-a", file: "C:\\Windows\\win.ini" },
          ],
          screenshots: [{ filename: "../escape.png" }, { filename: "capture.png" }],
        },
      ],
    };
    const out = planScreenshots(plan, { labsDir });
    assert.deepEqual(out.copies.map((c) => c.filename), ["ok.png"]);
    assert.deepEqual(out.shots.map((s) => s.filename), ["capture.png"]);
  } finally {
    rmSync(labsDir, { recursive: true, force: true });
  }
});

test("colliding screenshot names get unique suffixes, even repeatedly", () => {
  const labsDir = tmp();
  try {
    mkdirSync(join(labsDir, "lab-a", "assets"), { recursive: true });
    writeFileSync(join(labsDir, "lab-a", "assets", "shot.png"), "x");
    const ref = { lab: "lab-a", file: "shot.png" };
    const plan = {
      features: [
        { id: "f1", name: "F1", order: 1, reuseScreenshots: [ref, ref], screenshots: [{ filename: "shot.png" }] },
        { id: "f1", name: "F1b", order: 2, reuseScreenshots: [ref], screenshots: [{ filename: "shot.png" }] },
      ],
    };
    const out = planScreenshots(plan, { labsDir });
    const names = [...out.copies.map((c) => c.filename), ...out.shots.map((s) => s.filename)];
    assert.equal(new Set(names).size, names.length, `duplicate output names: ${names}`);
  } finally {
    rmSync(labsDir, { recursive: true, force: true });
  }
});

test("copyScreenshots refuses targets outside the assets folder", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "src.png"), "x");
    const assets = join(dir, "assets");
    const count = copyScreenshots(
      [
        { source: join(dir, "src.png"), filename: "../evil.png" },
        { source: join(dir, "src.png"), filename: "good.png" },
      ],
      assets,
    );
    assert.equal(count, 1);
    assert.ok(existsSync(join(assets, "good.png")));
    assert.ok(!existsSync(join(dir, "evil.png")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only public http(s) hosts are checkable", () => {
  for (const ok of ["https://learn.microsoft.com/a", "http://8.8.8.8/x", "https://example.co.uk/"]) {
    assert.equal(isPublicUrl(ok), true, ok);
  }
  for (const bad of [
    "http://localhost/",
    "http://127.0.0.1:8080/",
    "http://10.1.2.3/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://2130706433/",
    "http://intranet/",
    "http://svc.internal/",
    "file:///etc/passwd",
  ]) {
    assert.equal(isPublicUrl(bad), false, bad);
  }
});

function redirecting(map) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const hit = map[url];
    if (hit?.location) return { status: hit.status || 302, ok: false, headers: new Headers({ location: hit.location }), url };
    return { status: hit?.status ?? 200, ok: (hit?.status ?? 200) < 400, headers: new Headers(), url };
  };
  return { fetchImpl, calls };
}

test("link checker follows public redirects and records the final URL", async () => {
  const { fetchImpl, calls } = redirecting({ "https://a.example.com/old": { location: "/new" } });
  const record = await createLinkChecker({ fetchImpl })("https://a.example.com/old");
  assert.equal(record.status, 200);
  assert.equal(record.finalUrl, "https://a.example.com/new");
  assert.equal(calls.length, 2);
});

test("link checker never follows a redirect to an internal address", async () => {
  const { fetchImpl, calls } = redirecting({
    "https://a.example.com/x": { location: "http://169.254.169.254/latest/meta-data" },
  });
  const record = await createLinkChecker({ fetchImpl })("https://a.example.com/x");
  assert.equal(record.status, 0);
  assert.match(record.error, /non-public/);
  assert.deepEqual(calls, ["https://a.example.com/x"]);
});

test("link checker refuses an internal start URL and redirect loops without requesting", async () => {
  const { fetchImpl, calls } = redirecting({ "https://a.example.com/loop": { location: "/loop" } });
  const check = createLinkChecker({ fetchImpl });
  assert.equal((await check("http://127.0.0.1/admin")).status, 0);
  const loop = await check("https://a.example.com/loop");
  assert.equal(loop.status, 0);
  assert.match(loop.error, /redirects/);
  assert.ok(!calls.includes("http://127.0.0.1/admin"));
});

test("rate limiter allows the quota, then reports when to retry, per key", () => {
  let now = 1000;
  const check = createRateLimiter({ windowMs: 10_000, max: 2, now: () => now });
  assert.equal(check("a").allowed, true);
  assert.equal(check("a").allowed, true);
  const blocked = check("a");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSec, 10);
  assert.equal(check("b").allowed, true, "another user has their own quota");
  now += 10_001;
  assert.equal(check("a").allowed, true, "the window slides");
});

test("positiveIntFromEnv falls back on junk and non-positive values", () => {
  assert.equal(positiveIntFromEnv("5", 10), 5);
  for (const bad of [undefined, "", "abc", "0", "-3"]) assert.equal(positiveIntFromEnv(bad, 10), 10);
});

test("generated lab reads reject malformed ids and cannot leave the root", () => {
  const root = tmp();
  try {
    mkdirSync(join(root, "labs", "good-lab"), { recursive: true });
    writeFileSync(join(root, "labs", "good-lab", "index.md"), "# Hi");
    writeFileSync(join(root, "labs", "good-lab", "manifest.json"), JSON.stringify({ title: "Hi", modules: [{}], generatedAt: "2026-01-01" }));
    writeFileSync(join(root, "index.md"), "# outside");
    const dir = join(root, "labs");
    const render = (md) => `<p>${md}</p>`;

    assert.equal(readGeneratedLab(dir, "good-lab", render).status, 200);
    assert.equal(readGeneratedLab(dir, "..", render).status, 400);
    assert.equal(readGeneratedLab(dir, "../labs", render).status, 400);
    assert.equal(readGeneratedLab(dir, "a/b", render).status, 400);
    assert.equal(readGeneratedLab(dir, "missing-lab", render).status, 404);
    assert.equal(readGeneratedLab(dir, "labs", render).status, 404, "a directory without index.md is not a lab");

    const listed = listGeneratedLabs(dir).labs;
    assert.deepEqual(listed.map((l) => [l.labId, l.moduleCount]), [["good-lab", 1]]);
    assert.deepEqual(listGeneratedLabs(join(root, "nope")), { labs: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("user-supplied title, agent name, and audience cannot add Markdown structure", () => {
  assert.equal(escapeMarkdown("a*b_c[d](e)<f>|g`h~"), "a\\*b\\_c\\[d\\](e)\\<f\\>\\|g\\`h\\~");

  const plan = planLab({
    features: ["create-agent"],
    title: "Intro <img src=x onerror=1> [click](http://evil.example)",
    agentName: "**Bold** Bot",
    audience: "<b>staff</b> | admins",
  });
  const markdown = composeLab(plan, new Map(), new Map(), {}, { groundedFeatures: 0, llmProvider: "none" });

  assert.ok(!/(^|[^\\])<img/.test(markdown), "raw HTML from the title must not survive");
  assert.ok(!/(^|[^\\])\[click\]\(http/.test(markdown), "a link in the title must not become live");
  assert.ok(!markdown.includes("**Bold** Bot"), "emphasis in the agent name must be neutralized");
  assert.ok(markdown.includes("\\*\\*Bold\\*\\* Bot"));
  assert.ok(!/(^|[^\\])<b>staff/.test(markdown));
});
test("no time target ever removes a module or its prerequisites", () => {
  for (const feature of getFeatures()) {
    const unlimited = planLab({ features: [feature.id] });
    for (const targetMinutes of [1, 30, 60, 120]) {
      const plan = planLab({ features: [feature.id], targetMinutes });
      assert.deepEqual(
        plan.features.map((f) => f.id),
        unlimited.features.map((f) => f.id),
        `${feature.id} changed at a ${targetMinutes} minute target`,
      );
      const kept = new Set(plan.features.map((f) => f.id));
      for (const planned of plan.features) {
        for (const pre of getFeature(planned.id).prereqs || []) {
          assert.ok(kept.has(pre), `${planned.id} kept without prerequisite ${pre}`);
        }
      }
    }
  }
});
test("a failed Learn page read is retried, and only a good read is cached", async () => {
  let calls = 0;
  const session = {
    ok: true,
    endpoint: "test://learn-cache",
    call: async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient MCP failure");
      return { content: [{ type: "text", text: "# Page" }] };
    },
  };
  const url = "https://learn.microsoft.com/en-us/cache-test";

  const first = await fetchDocPage(session, url);
  assert.match(first.error, /transient/);
  const second = await fetchDocPage(session, url);
  assert.equal(second.error, null, "the retry must reach the server, not a cached failure");
  assert.equal(second.markdown, "# Page");
  await fetchDocPage(session, url);
  assert.equal(calls, 2, "the successful read is cached");
});