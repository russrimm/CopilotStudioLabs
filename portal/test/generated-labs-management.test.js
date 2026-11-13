import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deleteGeneratedLab,
  generatedLabExists,
  listGeneratedLabs,
  normalizeMetaPatch,
  replaceGeneratedLab,
  selectionsFromManifest,
  updateGeneratedLabMeta,
} from "../lib/lab-builder/generated-labs.js";
import { generateLab } from "../lib/lab-builder/generator.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

function library() {
  const root = mkdtempSync(join(tmpdir(), "generated-labs-"));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

function writeLab(root, id, manifest, markdown = "# Original title\n\nBody\n") {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.md"), markdown);
  if (manifest) writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  return dir;
}

const modern = {
  title: "Original title",
  generatedAt: "2026-11-01T10:00:00.000Z",
  difficulty: "Beginner",
  totalMinutes: 90,
  modules: [{ id: "a" }, { id: "b" }],
  industry: "healthcare",
  request: { industry: "healthcare", roles: ["it"], features: ["a", "b"], excluded: ["c"], harness: "standard", level: 200, differencesFor: ["microsoft-copilot"], targetMinutes: 120 },
  options: { customTitle: "Mine", agentName: "Ava", useLearnMcp: false, useLlm: true },
  validation: { passed: 20, failed: 0, checkedAt: "2026-11-01T10:00:01.000Z" },
};
// A manifest written before choices and validation were recorded.
const legacy = { title: "Old lab", generatedAt: "2026-01-01T00:00:00.000Z", difficulty: "Advanced", totalMinutes: 30, modules: [{ id: "x" }] };

test("the list carries chips, validation, and saved selections, and tolerates legacy manifests", () => {
  const { root, done } = library();
  try {
    writeLab(root, "modern-lab", modern);
    writeLab(root, "old-lab", legacy);
    mkdirSync(join(root, "no-manifest"));
    mkdirSync(join(root, "bad id with spaces"));
    const { labs } = listGeneratedLabs(root);
    assert.deepEqual(labs.map((l) => l.labId), ["modern-lab", "old-lab"]);
    const [m, o] = labs;
    assert.equal(m.vertical, "healthcare");
    assert.equal(m.level, 200);
    assert.equal(m.harness, "standard");
    assert.equal(m.moduleCount, 2);
    assert.deepEqual(m.validation, { status: "passed", passed: 20, failed: 0, checkedAt: "2026-11-01T10:00:01.000Z" });
    assert.deepEqual(m.selections.features, ["a", "b"]);
    assert.equal(m.selections.customTitle, "Mine");
    assert.equal(m.selections.useLearnMcp, false);
    assert.equal(o.selections, null);
    assert.equal(o.validation, null);
    assert.equal(o.vertical, null);
  } finally {
    done();
  }
});

test("selectionsFromManifest rejects manifests without usable choices", () => {
  assert.equal(selectionsFromManifest(null), null);
  assert.equal(selectionsFromManifest({}), null);
  assert.equal(selectionsFromManifest({ request: { features: [] } }), null);
  assert.equal(selectionsFromManifest({ request: { features: "a" } }), null);
  assert.equal(selectionsFromManifest({ request: { features: ["a"], level: 999 } }).level, null);
});

test("delete removes one generated lab and nothing else", () => {
  const { root, done } = library();
  try {
    writeLab(root, "keep-me", modern);
    writeLab(root, "drop-me", modern);
    const result = deleteGeneratedLab(root, "drop-me");
    assert.equal(result.status, 200);
    assert.equal(existsSync(join(root, "drop-me")), false);
    assert.equal(existsSync(join(root, "keep-me", "manifest.json")), true);
  } finally {
    done();
  }
});

test("delete of a lab that does not exist is a 404", () => {
  const { root, done } = library();
  try {
    assert.equal(deleteGeneratedLab(root, "ghost").status, 404);
    assert.equal(deleteGeneratedLab(join(root, "missing-root"), "ghost").status, 404);
  } finally {
    done();
  }
});

test("delete rejects bad ids and traversal attempts before touching the disk", () => {
  const { root, done } = library();
  try {
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "manifest.json"), "{}");
    const library_ = join(root, "library");
    writeLab(library_, "inside", modern);
    for (const id of ["..", "../outside", "..\\outside", "%2e%2e", "a/b", "", " ", "x".repeat(101), "inside/../../outside", "C:\\Windows", "/etc", "inside\u0000", undefined, null, ["inside"], { toString: () => "inside" }]) {
      const result = deleteGeneratedLab(library_, id);
      assert.equal(result.status, 400, `expected 400 for ${JSON.stringify(id)}`);
    }
    assert.equal(existsSync(join(outside, "manifest.json")), true);
    assert.equal(existsSync(join(library_, "inside", "manifest.json")), true);
  } finally {
    done();
  }
});

test("delete only removes folders that are generated labs", () => {
  const { root, done } = library();
  try {
    const dir = join(root, "plain-folder");
    mkdirSync(dir);
    writeFileSync(join(dir, "index.md"), "# Hand written\n");
    assert.equal(deleteGeneratedLab(root, "plain-folder").status, 404);
    assert.equal(existsSync(join(dir, "index.md")), true);
  } finally {
    done();
  }
});

test("delete does not follow a symlink out of the library", (t) => {
  const { root, done } = library();
  try {
    const target = join(root, "target");
    mkdirSync(target);
    writeFileSync(join(target, "manifest.json"), "{}");
    const lib = join(root, "lib");
    mkdirSync(lib);
    try {
      symlinkSync(target, join(lib, "link"), "junction");
    } catch {
      t.skip("symlinks are not available here");
      return;
    }
    assert.equal(deleteGeneratedLab(lib, "link").status, 404);
    assert.equal(existsSync(join(target, "manifest.json")), true);
  } finally {
    done();
  }
});

test("rename validation accepts only a bounded title and notes", () => {
  assert.match(normalizeMetaPatch(null).error, /JSON object/);
  assert.match(normalizeMetaPatch([]).error, /JSON object/);
  assert.match(normalizeMetaPatch({}).error, /title, notes, or both/);
  assert.match(normalizeMetaPatch({ title: 5 }).error, /string/);
  assert.match(normalizeMetaPatch({ title: "   " }).error, /empty/);
  assert.match(normalizeMetaPatch({ title: "x".repeat(161) }).error, /160/);
  assert.match(normalizeMetaPatch({ title: "two\nlines" }).error, /line breaks/);
  assert.match(normalizeMetaPatch({ notes: "x".repeat(1001) }).error, /1000/);
  assert.match(normalizeMetaPatch({ notes: "bell\u0007" }).error, /control/);
  assert.match(normalizeMetaPatch({ title: "ok", labId: "other" }).error, /labId/);
  assert.match(normalizeMetaPatch({ title: "ok", generatedAt: "now" }).error, /generatedAt/);
  assert.deepEqual(normalizeMetaPatch({ title: "  New  ", notes: "line one\nline two" }).patch, { title: "New", notes: "line one\nline two" });
  assert.deepEqual(normalizeMetaPatch({ notes: "" }).patch, { notes: "" });
});

test("rename updates the manifest and the H1, and escapes Markdown in the title", () => {
  const { root, done } = library();
  try {
    const dir = writeLab(root, "lab-one", modern, "# Original title\n\n## Overview\n\nBody\n");
    const result = updateGeneratedLabMeta(root, "lab-one", { title: "Q4 *roll-out* <b>", notes: "For the pilot" });
    assert.equal(result.status, 200);
    assert.equal(result.body.lab.title, "Q4 *roll-out* <b>");
    assert.equal(result.body.lab.notes, "For the pilot");
    assert.ok(result.body.lab.updatedAt);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    assert.equal(manifest.title, "Q4 *roll-out* <b>");
    assert.equal(manifest.generatedAt, modern.generatedAt);
    assert.deepEqual(manifest.request, modern.request);
    const md = readFileSync(join(dir, "index.md"), "utf8");
    assert.equal(md.split("\n")[0], "# Q4 \\*roll-out\\* \\<b\\>");
    assert.match(md, /## Overview/);
  } finally {
    done();
  }
});

test("a renamed title is what 'Edit selections' prefills, so a rebuild or replacement does not silently revert it", () => {
  const { root, done } = library();
  try {
    writeLab(root, "lab-one", { ...modern, options: { ...modern.options, customTitle: null } });
    assert.equal(listGeneratedLabs(root).labs[0].selections.customTitle, null);
    updateGeneratedLabMeta(root, "lab-one", { title: "Pilot rollout" });
    assert.equal(listGeneratedLabs(root).labs[0].selections.customTitle, "Pilot rollout");
    assert.equal(listGeneratedLabs(root).labs[0].selections.agentName, "Ava", "other saved options are kept");
    updateGeneratedLabMeta(root, "lab-one", { notes: "notes only" });
    assert.equal(listGeneratedLabs(root).labs[0].selections.customTitle, "Pilot rollout", "a notes-only change leaves the title choice alone");
  } finally {
    done();
  }
});

test("rename works on a legacy lab and keeps it legacy", () => {
  const { root, done } = library();
  try {
    writeLab(root, "old-lab", legacy);
    const result = updateGeneratedLabMeta(root, "old-lab", { title: "Renamed" });
    assert.equal(result.status, 200);
    assert.equal(result.body.lab.selections, null);
    assert.equal(listGeneratedLabs(root).labs[0].title, "Renamed");
  } finally {
    done();
  }
});

test("rename rejects bad ids, missing labs, and bad bodies without writing", () => {
  const { root, done } = library();
  try {
    const dir = writeLab(root, "lab-one", modern);
    const before = readFileSync(join(dir, "manifest.json"), "utf8");
    assert.equal(updateGeneratedLabMeta(root, "../lab-one", { title: "x" }).status, 400);
    assert.equal(updateGeneratedLabMeta(root, "nope", { title: "x" }).status, 404);
    assert.equal(updateGeneratedLabMeta(root, "lab-one", { title: "" }).status, 400);
    assert.equal(updateGeneratedLabMeta(root, "lab-one", { title: "x", extra: 1 }).status, 400);
    assert.equal(readFileSync(join(dir, "manifest.json"), "utf8"), before);
  } finally {
    done();
  }
});

test("replace removes the old lab only after the new one exists and keeps its notes", () => {
  const { root, done } = library();
  try {
    writeLab(root, "old-one", { ...modern, notes: "keep these" });
    writeLab(root, "new-one", modern);
    assert.equal(generatedLabExists(root, "old-one"), true);
    assert.equal(generatedLabExists(root, "ghost"), false);
    assert.deepEqual(replaceGeneratedLab(root, "old-one", "old-one"), { replaced: false });
    assert.equal(existsSync(join(root, "old-one")), true);
    assert.deepEqual(replaceGeneratedLab(root, "ghost", "new-one"), { replaced: false });
    assert.deepEqual(replaceGeneratedLab(root, "old-one", "new-one"), { replaced: true });
    assert.equal(existsSync(join(root, "old-one")), false);
    assert.equal(listGeneratedLabs(root).labs[0].notes, "keep these");
  } finally {
    done();
  }
});

test("a generated lab records its choices and validation, and they round-trip into the list", async () => {
  const { root, done } = library();
  try {
    const request = { features: ["create-agent"], level: 100, harness: "standard", industry: "healthcare", title: "Custom name", agentName: "Ava" };
    const result = await generateLab(request, { outputRoot: root, useLearnMcp: false, useLlm: false });
    const manifest = JSON.parse(readFileSync(join(result.outputDir, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.options, { customTitle: "Custom name", agentName: "Ava", useLearnMcp: false, useLlm: false });
    assert.equal(manifest.validation.failed, 0);
    assert.ok(manifest.validation.passed > 0);
    const [lab] = listGeneratedLabs(root).labs;
    assert.equal(lab.selections.customTitle, "Custom name");
    assert.equal(lab.selections.level, 100);
    assert.deepEqual(lab.selections.features, ["create-agent"]);
    assert.equal(lab.validation.status, "passed");
  } finally {
    done();
  }
});

// ── HTTP: the real server against a throwaway library ───────────────────────
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function boot(env) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", AZURE_KEYVAULT_URL: "", ...env },
    stdio: "ignore",
  });
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      await fetch(`${base}/api/config`);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("server did not start in time");
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  return { base, stop: () => child.kill() };
}

test("generated-lab routes require auth and never touch the library without it", async () => {
  const { root, done } = library();
  const server = await boot({ LAB_BUILDER_OUTPUT_DIR: root, AZURE_TENANT_ID: "test-tenant", PORTAL_API_AUDIENCE: "api://test" });
  try {
    writeLab(root, "lab-one", modern);
    const url = `${server.base}/api/lab-builder/generated/lab-one`;
    assert.equal((await fetch(url, { method: "DELETE" })).status, 401);
    assert.equal((await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "x" }) })).status, 401);
    assert.equal((await fetch(`${server.base}/api/lab-builder/generated`)).status, 401);
    assert.equal((await fetch(url, { method: "DELETE", headers: { Authorization: "Bearer not-a-token" } })).status, 401);
    assert.equal(existsSync(join(root, "lab-one", "manifest.json")), true);
  } finally {
    server.stop();
    done();
  }
});

test("generated-lab routes list, rename, delete, and refuse bad requests", async () => {
  const { root, done } = library();
  const server = await boot({ LAB_BUILDER_OUTPUT_DIR: root, PORTAL_AUTH_DISABLED: "true", LAB_BUILDER_MANAGE_RATE_MAX: "12" });
  const call = (path, init = {}) =>
    fetch(`${server.base}/api/lab-builder/generated${path}`, {
      ...init,
      headers: { "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  try {
    writeLab(root, "lab-one", modern);
    writeLab(root, "old-lab", legacy);
    const listed = await (await call("")).json();
    assert.deepEqual(listed.labs.map((l) => l.labId), ["lab-one", "old-lab"]);
    assert.equal(listed.labs[1].selections, null);

    // Raw paths a client could send; none may reach outside the library.
    for (const raw of ["..", "%2e%2e", "..%2f..", "%2e%2e%2f%2e%2e%2fpackage.json", "lab-one%2f..%2f..", "a%5cb"]) {
      const res = await fetch(`${server.base}/api/lab-builder/generated/${raw}`, { method: "DELETE" });
      assert.ok([400, 404].includes(res.status), `${raw} gave ${res.status}`);
    }
    assert.equal(existsSync(join(root, "lab-one", "manifest.json")), true);

    assert.equal((await call("/ghost", { method: "DELETE" })).status, 404);
    assert.equal((await call("/lab-one", { method: "PATCH", body: { title: "" } })).status, 400);
    assert.equal((await call("/lab-one", { method: "PATCH", body: { title: "ok", labId: "x" } })).status, 400);
    assert.equal((await call("/lab-one", { method: "PATCH", body: [] })).status, 400);

    const renamed = await call("/lab-one", { method: "PATCH", body: { title: "Renamed", notes: "n" } });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).lab.title, "Renamed");

    const gone = await call("/lab-one", { method: "DELETE" });
    assert.equal(gone.status, 200);
    assert.equal(existsSync(join(root, "lab-one")), false);
    assert.equal((await call("/lab-one", { method: "DELETE" })).status, 404);
    assert.equal(existsSync(join(root, "old-lab", "manifest.json")), true);

    const missing = await fetch(`${server.base}/api/lab-builder/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ features: ["create-agent"], replaceLabId: "ghost", useLearnMcp: false, useLlm: false }),
    });
    assert.equal(missing.status, 400);
    assert.equal(existsSync(join(root, "old-lab", "manifest.json")), true);
  } finally {
    server.stop();
    done();
  }
});

test("replaceLabId swaps in the new lab, and a failed build leaves the original alone", async () => {
  const { root, done } = library();
  const server = await boot({ LAB_BUILDER_OUTPUT_DIR: root, PORTAL_AUTH_DISABLED: "true", LAB_BUILDER_LINK_CHECK: "off", LAB_BUILDER_VENDOR_DOCS: "off" });
  const generate = (body) =>
    fetch(`${server.base}/api/lab-builder/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ useLearnMcp: false, useLlm: false, includeCore: false, ...body }),
    });
  try {
    writeLab(root, "old-one", { ...modern, notes: "carry me" });
    const failed = await generate({ features: ["create-agent"], level: 999, replaceLabId: "old-one" });
    assert.equal(failed.status, 400);
    assert.equal(existsSync(join(root, "old-one", "manifest.json")), true);

    const built = await generate({ features: ["create-agent"], replaceLabId: "old-one" });
    assert.equal(built.status, 200);
    const body = await built.json();
    assert.equal(body.status, "complete");
    assert.equal(body.replacedLabId, "old-one");
    assert.equal(existsSync(join(root, "old-one")), false);
    const [lab] = listGeneratedLabs(root).labs;
    assert.equal(lab.labId, body.labId);
    assert.equal(lab.notes, "carry me");
  } finally {
    server.stop();
    done();
  }
});

test("changing generated labs is rate limited", async () => {
  const { root, done } = library();
  const server = await boot({ LAB_BUILDER_OUTPUT_DIR: root, PORTAL_AUTH_DISABLED: "true", LAB_BUILDER_MANAGE_RATE_MAX: "3" });
  try {
    const statuses = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await fetch(`${server.base}/api/lab-builder/generated/ghost`, { method: "DELETE" });
      statuses.push(res.status);
      if (res.status === 429) assert.ok(res.headers.get("retry-after"));
    }
    assert.deepEqual(statuses, [404, 404, 404, 429, 429]);
  } finally {
    server.stop();
    done();
  }
});
