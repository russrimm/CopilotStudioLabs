/**
 * The real portal with many people at once: lab builds wait in a fair line instead of failing, the page can ask where it
 * stands, a person who leaves the line frees their place, and limits count each visitor separately even when the ingress
 * shows every visitor from one address. The portal runs in a child process with throwaway folders, sign-in off, no
 * language model, and no Learn (useLearnMcp is false), on ports 3131 to 3139.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORTAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cleanups = [];
const ctx = {};

after(() => {
  for (const clean of cleanups.reverse()) {
    try {
      clean();
    } catch {
      /* best effort */
    }
  }
});

async function freePort() {
  const probe = (port) =>
    new Promise((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(0));
      server.listen(port, "127.0.0.1", () => {
        const { port: bound } = server.address();
        server.close(() => resolve(bound));
      });
    });
  for (let port = 3131; port <= 3139; port += 1) {
    const got = await probe(port);
    if (got) return got;
  }
  return probe(0);
}

async function startPortal(env) {
  const root = mkdtempSync(path.join(tmpdir(), "lb-queue-server-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const dirs = { storage: path.join(root, "storage"), localAppData: path.join(root, "localappdata") };
  mkdirSync(dirs.localAppData, { recursive: true });
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: PORTAL_ROOT,
    env: {
      ...process.env,
      LOCALAPPDATA: dirs.localAppData,
      PORT: String(port),
      HOST: "127.0.0.1",
      PORTAL_AUTH_DISABLED: "true",
      AZURE_KEYVAULT_URL: "",
      AZURE_STORAGE_BLOB_ENDPOINT: "",
      PORTAL_STORAGE_ROOT: dirs.storage,
      PORTAL_DATA_DIR: path.join(dirs.storage, "data"),
      LAB_BUILDER_OUTPUT_DIR: path.join(dirs.storage, "generated-labs"),
      FEATURE_TOUR_SCREENSHOTS_DIR: path.join(dirs.storage, "screenshots"),
      LAB_BUILDER_LINK_CHECK: "off",
      LAB_BUILDER_LLM: "off",
      LAB_BUILDER_VENDOR_DOCS: "off",
      LAB_BUILDER_TOPICS_DISABLED: "1",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr = (stderr + c).slice(-1500)));
  cleanups.push(() => child.kill());
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`The portal exited early (${child.exitCode}): ${stderr}`);
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`The portal did not start: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return { base, child };
}

const BIG = { products: ["copilot-studio"], features: ["create-agent", "agent-instructions", "topics", "power-fx", "knowledge-sharepoint"], harness: "standard", includeCore: false, useLearnMcp: false, useLlm: false };
const id = (letter) => `${letter}`.repeat(22).slice(0, 22);

function person(base, clientId, address = "10.2.0.1") {
  const headers = (extra = {}) => ({ "Content-Type": "application/json", "X-Client-Id": clientId, "X-Forwarded-For": address, ...extra });
  return {
    generate: (body = BIG, { ticket, signal } = {}) => fetch(`${base}/api/lab-builder/generate`, { method: "POST", headers: headers(ticket ? { "X-Build-Ticket": ticket } : {}), body: JSON.stringify(body), signal }),
    queue: (ticket) => fetch(`${base}/api/lab-builder/build-queue/${ticket}`, { headers: headers() }).then((r) => r.json()),
  };
}

before(async () => {
  ctx.one = await startPortal({ LAB_BUILDER_MAX_ACTIVE: "1", LAB_BUILDER_MAX_PER_PERSON: "2", LAB_BUILDER_MAX_WAITING: "50", LAB_BUILDER_QUEUE_WAIT_MS: "120000" });
});

test("builds wait in a fair line instead of failing: the page sees its place, and everyone's lab is built in order", async () => {
  const { base } = ctx.one;
  const ann = person(base, id("a"), "10.2.0.1");
  const ben = person(base, id("b"), "10.2.0.2");
  const cy = person(base, id("c"), "10.2.0.3");

  const first = ann.generate(BIG, { ticket: "ticket-ann-000001" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const second = ben.generate(BIG, { ticket: "ticket-ben-000002" });
  const third = cy.generate(BIG, { ticket: "ticket-cy-0000003" });

  let sawBen = null;
  let sawCy = null;
  for (let i = 0; i < 20 && !(sawBen && sawCy); i += 1) {
    const [b, c] = await Promise.all([ben.queue("ticket-ben-000002"), cy.queue("ticket-cy-0000003")]);
    if (b.state === "queued") sawBen ||= b;
    if (c.state === "queued") sawCy ||= c;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(sawBen, "Ben was shown as waiting");
  assert.equal(sawBen.position, 1);
  assert.equal(sawBen.ahead, 0, "Ben is next in line");
  assert.ok(sawCy, "Cy was shown as waiting");
  assert.equal(sawCy.position, 2);
  assert.equal(sawCy.running, 1);

  const results = await Promise.all([first, second, third].map(async (p) => ({ status: (await p).status, body: await (await p).clone().json() })));
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200], "nobody was turned away");
  assert.ok(results.every((r) => r.body.status === "complete"));
  assert.equal(new Set(results.map((r) => r.body.labId)).size, 3, "three distinct labs");
  const after = await ann.queue("ticket-cy-0000003");
  assert.ok(["finished", "unknown"].includes(after.state));
});

test("one person may hold two places; a third is refused at once with a plain message and a Retry-After", async () => {
  const { base } = ctx.one;
  const dan = person(base, id("d"), "10.2.0.4");
  const slow = [dan.generate(BIG, { ticket: "ticket-dan-000001" }), dan.generate(BIG, { ticket: "ticket-dan-000002" })];
  await new Promise((resolve) => setTimeout(resolve, 150));
  const refused = await dan.generate(BIG, { ticket: "ticket-dan-000003" });
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get("retry-after")) > 0);
  const body = await refused.json();
  assert.equal(body.code, "owner-limit");
  assert.match(body.error, /You already have 2 labs building or waiting/);
  assert.deepEqual((await Promise.all(slow)).map((r) => r.status), [200, 200]);
});

test("a person who leaves the line frees their place and the next build starts", async () => {
  const { base } = ctx.one;
  const eve = person(base, id("e"), "10.2.0.5");
  const fay = person(base, id("f"), "10.2.0.6");
  const gus = person(base, id("g"), "10.2.0.7");
  const running = eve.generate(BIG, { ticket: "ticket-eve-000001" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const controller = new AbortController();
  const leaver = fay.generate(BIG, { ticket: "ticket-fay-000001", signal: controller.signal }).catch((err) => err);
  const staying = gus.generate(BIG, { ticket: "ticket-gus-000001" });
  let before = null;
  for (let i = 0; i < 20 && before?.state !== "queued"; i += 1) {
    before = await gus.queue("ticket-gus-000001");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(before.state, "queued");
  assert.equal(before.position, 2, "Gus is behind Fay");
  controller.abort();
  const gone = await leaver;
  assert.equal(gone.name, "AbortError");
  let moved = null;
  for (let i = 0; i < 20; i += 1) {
    moved = await gus.queue("ticket-gus-000001");
    if (moved.state !== "queued" || moved.position === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(moved.state === "running" || moved.position === 1, "Gus moved up when Fay left");
  assert.equal((await running).status, 200);
  assert.equal((await staying).status, 200);
});

test("limits count each visitor separately even when the ingress shows everyone from one address", async () => {
  const limited = await startPortal({ LAB_BUILDER_RATE_MAX: "2", LAB_BUILDER_RATE_ADDRESS_MULTIPLIER: "3" });
  const office = "203.0.113.77";
  const attempt = (who) => who.generate({ ...BIG, replaceLabId: "no-such-lab" }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const ann = person(limited.base, id("h"), office);
  const ben = person(limited.base, id("i"), office);
  const cy = person(limited.base, id("j"), office);

  // The cheap way to spend rate-limit hits: a request that is refused for a lab that does not exist, after the limit check.
  assert.equal((await attempt(ann)).status, 400);
  assert.equal((await attempt(ann)).status, 400);
  const third = await attempt(ann);
  assert.equal(third.status, 429, "Ann is over her own limit of 2");
  assert.match(third.body.error, /Lab generation rate limit exceeded/);
  assert.equal((await attempt(ben)).status, 400, "Ben, from the same address, still has his own");
  assert.equal((await attempt(ben)).status, 400);
  // 2 + 2 = 4 of the address's 6 hits used (limit 2 x multiplier 3): two more people fit, then the address is full.
  assert.equal((await attempt(cy)).status, 400);
  assert.equal((await attempt(cy)).status, 400);
  const flood = person(limited.base, id("k"), office);
  assert.equal((await attempt(flood)).status, 429, "a new id from the same address cannot flood past the address cap");
  assert.equal((await attempt(person(limited.base, id("l"), "203.0.113.78"))).status, 400, "another address is unaffected");
});

test("the connection limits are set on purpose, and a stop signal ends the portal cleanly", async () => {
  const { base, child } = ctx.one;
  const res = await fetch(`${base}/healthz`, { headers: { "X-Forwarded-For": "10.2.0.9" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("keep-alive"), "timeout=65", "keep-alive outlasts the ingress's idle timer");
  if (process.platform !== "win32") {
    child.kill("SIGTERM");
    const code = await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(code, 0);
  }
});
