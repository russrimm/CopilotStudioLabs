import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Boots the real server so framework upgrades (for example Express 5 route
// syntax) fail here instead of at runtime.

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

async function waitForServer(base, child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(`${base}/api/config`);
      if (res.status > 0) return;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error("server did not start in time");
}

test("the server boots, serves the app shell for unknown paths, and tolerates body-less POSTs", async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      PORTAL_AUTH_DISABLED: "true",
      AZURE_KEYVAULT_URL: "",
    },
    stdio: "ignore",
  });
  try {
    await waitForServer(base, child);

    const shell = await fetch(`${base}/some/client/route`);
    assert.equal(shell.status, 200);
    assert.match(await shell.text(), /<html/i);

    // No Content-Type and no body: handlers destructure req.body and must not throw.
    const res = await fetch(`${base}/api/provision/deploy`, { method: "POST" });
    assert.equal(res.status, 400);
    assert.ok((await res.json()).error);
  } finally {
    child.kill();
  }
});

test("portal/Dockerfile COPY directives include every runtime module needed to boot server.js", async () => {
  const portalRoot = fileURLToPath(new URL("..", import.meta.url));
  const repoRoot = path.resolve(portalRoot, "..");
  const dockerfile = readFileSync(path.join(portalRoot, "Dockerfile"), "utf8");
  const stageRoot = mkdtempSync(path.join(tmpdir(), "portal-dockerfile-boot-"));

  try {
    for (const rawLine of dockerfile.split(/\r?\n/)) {
      const match = /^COPY\s+([^\s]+)\s+([^\s]+)\s*$/.exec(rawLine.trim());
      if (!match) continue;
      const [, srcSpec, dstSpec] = match;
      if (srcSpec.includes("*")) continue; // package*.json is covered by portal/ copy + node_modules link
      const srcPath = path.resolve(repoRoot, srcSpec);
      assert.ok(existsSync(srcPath), `Dockerfile COPY source missing: ${srcSpec}`);
      const srcStat = statSync(srcPath);
      const dstPath = !srcStat.isDirectory() && dstSpec.endsWith("/")
        ? path.resolve(stageRoot, dstSpec, path.basename(srcPath))
        : path.resolve(stageRoot, dstSpec);
      if (srcStat.isDirectory()) {
        cpSync(srcPath, dstPath, {
          recursive: true,
          filter: (candidate) => {
            const rel = path.relative(repoRoot, candidate).replace(/\\/g, "/");
            return (
              !rel.includes("/node_modules") &&
              !rel.startsWith("portal/test") &&
              !rel.startsWith("portal/data") &&
              !rel.startsWith("portal/public/uploads")
            );
          },
        });
      } else {
        mkdirSync(path.dirname(dstPath), { recursive: true });
        cpSync(srcPath, dstPath);
      }
    }

    symlinkSync(
      path.join(portalRoot, "node_modules"),
      path.join(stageRoot, "portal", "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const storageRoot = path.join(stageRoot, "portal-storage");
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    let stderr = "";
    const child = spawn(process.execPath, ["server.js"], {
      cwd: path.join(stageRoot, "portal"),
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        PORTAL_AUTH_DISABLED: "true",
        AZURE_KEYVAULT_URL: "",
        PORTAL_STORAGE_ROOT: storageRoot,
        PORTAL_STORAGE_BACKEND: "azure-blob",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    try {
      await waitForServer(base, child);
      const healthRes = await fetch(`${base}/healthz`);
      assert.equal(healthRes.status, 200, stderr);
      const health = await healthRes.json();
      assert.equal(health.status, "ok");
      assert.equal(health.storage?.backend, "azure-blob");

      const driftRes = await fetch(`${base}/api/lab-builder/learn-drift`);
      assert.equal(driftRes.status, 200);
    } finally {
      child.kill();
    }
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
});

