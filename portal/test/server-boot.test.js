import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

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
