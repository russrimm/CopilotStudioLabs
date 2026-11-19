import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

import { COMPANION_FILES } from "../lib/capture/companion-zip.js";

// Proves the container image is complete. Only what portal/Dockerfile COPYs, minus what .dockerignore
// excludes, is staged. The staged server must boot, serve the Screenshot Center and the readiness hub,
// and build a companion download that carries everything the companion needs to run, and nothing secret.

const portalRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = path.resolve(portalRoot, "..");

// ── .dockerignore, as Docker reads it ───────────────────────────────────────

function globToRegex(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        if (pattern[i + 1] === "/") {
          i += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

function dockerignoreRules(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const negate = line.startsWith("!");
      const pattern = (negate ? line.slice(1) : line).replace(/^\/+/, "").replace(/\/+$/, "");
      return { negate, regex: globToRegex(pattern) };
    });
}

/** A path is excluded when a rule matches it or one of its parent folders; the last matching rule wins. */
function isIgnored(rel, rules) {
  const parts = rel.split("/");
  let ignored = false;
  for (const rule of rules) {
    let matched = false;
    for (let n = 1; n <= parts.length && !matched; n += 1) matched = rule.regex.test(parts.slice(0, n).join("/"));
    if (matched) ignored = !rule.negate;
  }
  return ignored;
}

const RULES = dockerignoreRules(readFileSync(path.join(repoRoot, ".dockerignore"), "utf8"));

// ── A small ZIP reader, so the download can be inspected and unpacked ───────

function readZip(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, "the download is a ZIP archive");
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(p), 0x02014b50, "central directory entry");
    const method = buffer.readUInt16LE(p + 10);
    const compressed = buffer.readUInt32LE(p + 20);
    const nameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    const local = buffer.readUInt32LE(p + 42);
    const name = buffer.toString("utf8", p + 46, p + 46 + nameLength);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + compressed);
    entries.push({ name, data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw) });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// ── Staging exactly what the Dockerfile copies ──────────────────────────────

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

function stageDockerContext(stageRoot) {
  const copied = [];
  const dockerfile = readFileSync(path.join(portalRoot, "Dockerfile"), "utf8");
  for (const rawLine of dockerfile.split(/\r?\n/)) {
    const match = /^COPY\s+([^\s]+)\s+([^\s]+)\s*$/.exec(rawLine.trim());
    if (!match) continue;
    const [, srcSpec, dstSpec] = match;
    if (srcSpec.includes("*")) continue; // package*.json is covered by the portal/ copy
    const srcPath = path.resolve(repoRoot, srcSpec);
    assert.ok(existsSync(srcPath), `Dockerfile COPY source missing: ${srcSpec}`);
    const isDirectory = statSync(srcPath).isDirectory();
    const dstPath = !isDirectory && dstSpec.endsWith("/") ? path.resolve(stageRoot, dstSpec, path.basename(srcPath)) : path.resolve(stageRoot, dstSpec);
    const keep = (candidate) => !isIgnored(path.relative(repoRoot, candidate).replace(/\\/g, "/"), RULES);
    if (isDirectory) {
      cpSync(srcPath, dstPath, { recursive: true, filter: keep });
    } else if (keep(srcPath)) {
      mkdirSync(path.dirname(dstPath), { recursive: true });
      cpSync(srcPath, dstPath);
    }
    copied.push(srcSpec);
  }
  return copied;
}

async function waitForServer(base, child) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.status > 0) return;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error("server did not start in time");
}

/** Every relative module a file imports, followed through the whole graph. */
function importGraph(entry, root) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^"'\n]*?from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
      visit(path.resolve(path.dirname(file), match[1]));
    }
  };
  visit(path.resolve(root, entry));
  return [...seen].map((file) => path.relative(root, file).replace(/\\/g, "/"));
}

// ── The .dockerignore rules themselves ──────────────────────────────────────

test(".dockerignore keeps secrets and tests out of the image, and keeps every companion file in", () => {
  for (const secret of [
    "tools/screenshot-capture/.companion.json",
    "tools/screenshot-capture/.auth/copilot-studio/state.json",
    "tools/screenshot-capture/.captures/job_1/shot.png",
    "tools/feature-tour/.auth/x",
    "portal/.env",
    "portal/.env.local",
    ".env.production",
    "portal/data/brand-profiles.json",
    "portal/node_modules/express/index.js",
    "portal/test/readiness-hub.test.js",
    "tools/screenshot-capture/test/companion.test.mjs",
    "tools/feature-tour/test/x.test.mjs",
    "generated-labs/lab/index.md",
  ]) {
    assert.equal(isIgnored(secret, RULES), true, `${secret} must stay out of the image`);
  }
  for (const needed of [
    "portal/.env.template",
    "portal/server.js",
    "portal/public/readiness-hub.js",
    "portal/lib/capture/companion-zip.js",
    "tools/screenshot-capture/package.json",
    "docs/feature-tour/screenshots/README.md",
    ...COMPANION_FILES,
  ]) {
    assert.equal(isIgnored(needed, RULES), false, `${needed} must be in the image`);
    assert.ok(existsSync(path.join(repoRoot, ...needed.split("/"))) || needed === "docs/feature-tour/screenshots/README.md" || needed === "portal/.env.template", `${needed} exists in the repository`);
  }
});

test("the Dockerfile copies the folders the companion download and the Screenshot Center need", () => {
  const dockerfile = readFileSync(path.join(portalRoot, "Dockerfile"), "utf8");
  for (const folder of ["portal/", "labs/", "docs/feature-tour/screenshots/", "tools/feature-tour/", "tools/screenshot-capture/"]) {
    assert.match(dockerfile, new RegExp(`^COPY ${folder.replace(/[./]/g, "\\$&")} `, "m"), `COPY ${folder}`);
  }
});

// ── The staged image boots and serves everything ────────────────────────────

test("a container built from only the Dockerfile COPY paths boots, serves the app, and builds a safe companion download", async () => {
  const stageRoot = mkdtempSync(path.join(tmpdir(), "portal-container-readiness-"));
  const unpackRoot = mkdtempSync(path.join(tmpdir(), "portal-companion-unpack-"));
  try {
    stageDockerContext(stageRoot);

    // What .dockerignore removes really is missing from the stage.
    assert.equal(existsSync(path.join(stageRoot, "portal", "test")), false, "tests are not in the image");
    assert.equal(existsSync(path.join(stageRoot, "tools", "screenshot-capture", "test")), false, "companion tests are not in the image");
    assert.equal(existsSync(path.join(stageRoot, "tools", "screenshot-capture", ".companion.json")), false);
    assert.equal(existsSync(path.join(stageRoot, "tools", "screenshot-capture", ".auth")), false);
    assert.equal(existsSync(path.join(stageRoot, "tools", "screenshot-capture", "node_modules")), false);
    assert.ok(existsSync(path.join(stageRoot, "tools", "screenshot-capture", "companion.mjs")), "the companion is in the image");

    symlinkSync(path.join(portalRoot, "node_modules"), path.join(stageRoot, "portal", "node_modules"), process.platform === "win32" ? "junction" : "dir");

    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    let stderr = "";
    const child = spawn(process.execPath, ["server.js"], {
      cwd: path.join(stageRoot, "portal"),
      env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", PORTAL_AUTH_DISABLED: "true", AZURE_KEYVAULT_URL: "", PORTAL_STORAGE_ROOT: path.join(stageRoot, "portal-storage") },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    try {
      // (a) boots
      await waitForServer(base, child);
      const health = await fetch(`${base}/healthz`);
      assert.equal(health.status, 200, stderr);
      assert.equal((await health.json()).status, "ok");

      // (c) the capture status, the brand profile routes, and the app shell
      const capture = await fetch(`${base}/api/capture/status`);
      assert.equal(capture.status, 200, stderr);
      const status = await capture.json();
      assert.equal(status.companion.connected, false);
      assert.equal(status.companion.downloadUrl, "/api/capture/companion.zip");
      assert.ok(status.sharedLibrary.total > 0, "the shared library knows its slots");

      const profiles = await fetch(`${base}/api/branding/profiles`);
      assert.equal(profiles.status, 200);
      const brand = await profiles.json();
      assert.ok(Array.isArray(brand.profiles) && brand.profiles.length >= 1);
      assert.ok(brand.profiles.some((p) => p.id === brand.activeProfileId));

      const pair = await fetch(`${base}/api/capture/pair`, { method: "POST" });
      assert.equal(pair.status, 201, "a pairing code can be issued");
      assert.match((await pair.json()).code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

      const shell = await fetch(`${base}/`);
      assert.equal(shell.status, 200);
      const html = await shell.text();
      assert.match(html, /<section class="panel rh-card" id="readiness-hub"/, "the Setup checklist is in the page");
      assert.match(html, /id="rh-banner"/, "the first-run banner is in the page");

      // (c) every script and stylesheet index.html references exists in the image and is served
      const assets = [...html.matchAll(/<script[^>]+src="([^"#?]+)"/g), ...html.matchAll(/<link[^>]+href="([^"#?]+\.css)"/g)].map((m) => m[1]).filter((src) => !/^(?:https?:)?\/\//.test(src));
      assert.ok(assets.length >= 10, "index.html loads its scripts");
      for (const required of ["readiness-hub.js", "screenshot-center.js", "screenshot-center-core.js", "screenshot-center-command.js", "screenshot-center-jobs.js", "lab-checklist.js", "lab-customize.js", "brand-ui.js", "app.js"]) {
        assert.ok(assets.includes(required), `${required} is referenced by index.html`);
      }
      for (const asset of assets) {
        const onDisk = path.join(stageRoot, "portal", "public", ...asset.split("/"));
        assert.ok(existsSync(onDisk), `${asset} is in the image`);
        const res = await fetch(`${base}/${asset}`);
        assert.equal(res.status, 200, `${asset} is served`);
        assert.match(res.headers.get("content-type") || "", asset.endsWith(".css") ? /css/ : /javascript/, `${asset} has the right content type`);
        assert.ok((await res.text()).length > 100, `${asset} is not empty`);
      }

      // (b) the companion download
      const zipRes = await fetch(`${base}/api/capture/companion.zip`);
      assert.equal(zipRes.status, 200, stderr);
      assert.match(zipRes.headers.get("content-type") || "", /application\/zip/);
      assert.match(zipRes.headers.get("content-disposition") || "", /copilot-studio-labs-capture-companion\.zip/);
      assert.equal(zipRes.headers.get("cache-control"), "no-store");
      const entries = readZip(Buffer.from(await zipRes.arrayBuffer()));
      const names = entries.map((entry) => entry.name);
      const inZip = (rel) => names.includes(`capture-companion/${rel}`);

      for (const required of [
        "tools/screenshot-capture/companion.mjs",
        "tools/screenshot-capture/lab-runner.mjs",
        "tools/screenshot-capture/package.json",
        "tools/screenshot-capture/README.md",
        "tools/screenshot-capture/start-companion.cmd",
        "tools/screenshot-capture/start-companion.ps1",
        "tools/screenshot-capture/start-companion.sh",
        "tools/feature-tour/capture-products.json",
        "README-FIRST.txt",
      ]) {
        assert.ok(inZip(required), `the download contains ${required}`);
      }
      const stagedTools = path.join(stageRoot, "tools");
      const needed = importGraph(path.join(stagedTools, "screenshot-capture", "companion.mjs"), stageRoot);
      assert.ok(needed.length >= 6, `the companion imports ${needed.join(", ")}`);
      for (const rel of needed) assert.ok(inZip(rel), `the download contains ${rel}, which the companion imports`);
      assert.ok(inZip("tools/feature-tour/lib/products.mjs"), "the module that reads capture-products.json is included");

      for (const entry of entries) {
        assert.ok(!/(^|\/)(node_modules|\.auth|\.captures|test|tests)(\/|$)/.test(entry.name), `${entry.name} must not be in the download`);
        assert.ok(!/(^|\/)(\.companion\.json|\.env[^/]*|devices\.json)$/.test(entry.name), `${entry.name} must not be in the download`);
        assert.ok(!/\.(pem|key|pfx|png|jpe?g|webp)$/i.test(entry.name), `${entry.name} must not be in the download`);
        const text = entry.data.toString("utf8");
        assert.ok(!/\bcap_[A-Za-z0-9_-]{20,}/.test(text), `${entry.name} holds no capture token`);
        assert.ok(!/BEGIN (?:RSA |EC )?PRIVATE KEY|AccountKey=|client_secret\s*[:=]/i.test(text), `${entry.name} holds no secret`);
      }
      const launcher = entries.find((entry) => entry.name.endsWith("start-companion.sh"));
      assert.ok(!launcher.data.includes("\r"), "the shell launcher keeps Unix line endings");

      // The unpacked download really runs: every import resolves and the help text prints.
      for (const entry of entries) {
        const target = path.join(unpackRoot, ...entry.name.split("/"));
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, entry.data);
      }
      const run = spawnSync(process.execPath, [path.join(unpackRoot, "capture-companion", "tools", "screenshot-capture", "companion.mjs"), "--help"], { encoding: "utf8", timeout: 20000 });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /Local Capture Companion/);
      assert.match(run.stdout, /--portal=<address> --code=<pairing code>/);
    } finally {
      child.kill();
    }
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
    rmSync(unpackRoot, { recursive: true, force: true });
  }
});
