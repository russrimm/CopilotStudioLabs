#!/usr/bin/env node
/**
 * Check that the GitHub Copilot SDK is installed and its runtime starts on this machine.
 *
 *   node tools/lab-builder/ai-smoke.mjs            starts the runtime and pings it. No sign-in, no network, no model, no cost.
 *   node tools/lab-builder/ai-smoke.mjs --models   also lists the models your Copilot sign-in offers (contacts GitHub as YOU).
 *   node tools/lab-builder/ai-smoke.mjs --say "Reply with the single word ready."
 *                                  also runs ONE short generation (--model <id>): uses YOUR Copilot allowance (a handful of
 *                                  premium requests at most). It never runs unless you pass --say.
 *
 * It uses the same adapter the portal uses (portal/lib/ai/copilot-client.js), so what works here works there.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const lib = (name) => import(pathToFileURL(path.join(REPO_ROOT, "portal", "lib", name)).href);

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 ? args[i + 1] : undefined;
};

const { readAiConfig } = await lib("ai/config.js");
const { createCopilotBackend } = await lib("ai/copilot-client.js");

const config = readAiConfig({ ...process.env, AI_GENERATION: "local-user" });
const backend = createCopilotBackend({ config, env: process.env, logger: (line) => console.log(line) });

try {
  const sdk = await backend.availability();
  console.log(`SDK package: ${sdk.ok ? "installed" : `not available (${sdk.message})`}`);
  if (!sdk.ok) process.exit(1);

  // Starting the runtime is local: it spawns the bundled runtime process and talks to it over stdin and stdout.
  const { CopilotClient, RuntimeConnection } = await import("@microsoft/copilot-sdk").catch(() => import(pathToFileURL(path.join(REPO_ROOT, "portal", "node_modules", "@microsoft", "copilot-sdk", "dist", "index.js")).href));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-smoke-home-"));
  const client = new CopilotClient({
    mode: "empty",
    runtime: RuntimeConnection.forSpawnedStdio({ env: { COPILOT_TELEMETRY_DISABLED: "true", PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, baseDirectory: home }),
    github: { useLoggedInUser: false },
  });
  await client.start();
  const pong = await client.ping("hello");
  console.log(`Runtime: started, ping answered (${pong?.message ?? "ok"}).`);
  await client.stop();
  fs.rmSync(home, { recursive: true, force: true });

  if (flag("models") || flag("say")) {
    console.log("\nContacting GitHub Copilot with this PC's own sign-in...");
    const models = await backend.listModels();
    for (const m of models) console.log(`  ${m.id.padEnd(28)} ${m.name}  (${m.cost})`);
  }
  if (flag("say")) {
    const model = value("model");
    if (!model) throw new Error("--say needs --model <id> (see --models).");
    const reply = await backend.complete({
      model,
      system: "You answer in one short sentence.",
      prompt: String(value("say")),
      schema: undefined,
    });
    console.log(`\nModel answer: ${reply.text.slice(0, 300)}`);
    console.log(`Tokens: ${reply.usage.inputTokens} in, ${reply.usage.outputTokens} out. Permission requests refused: ${backend.tally.denied}.`);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
} finally {
  await backend.stop();
}
