/**
 * AI writing is off in the Azure deployment: the infra files default it to off, never carry a key or secret in plain text,
 * and only raise the app's size when a mode is turned on. Read from the source files, so it needs no Azure tooling.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

test("the Azure deployment turns AI writing off by default and hands it to the app as AI_GENERATION", () => {
  const main = read("infra/main.bicep");
  const app = read("infra/modules/container-app.bicep");
  for (const source of [main, app]) assert.match(source, /param aiGeneration string = 'off'/);
  assert.match(app, /name: 'AI_GENERATION'\s+value: aiGeneration/);
  assert.match(main, /aiGeneration: aiGeneration/);
  assert.equal(JSON.parse(read("infra/main.parameters.json")).parameters.aiGeneration.value, "off");
  // local-user is for a portal on the owner's own PC; a reachable server never offers it.
  assert.match(main, /@allowed\(\[\s+'off'\s+'per-user'\s+'byok'\s+\]\)/);
});

test("the provider key and the GitHub App secret are secure parameters kept as Container Apps secrets", () => {
  for (const rel of ["infra/main.bicep", "infra/modules/container-app.bicep"]) {
    const source = read(rel);
    assert.match(source, /@secure\(\)\s+@description\([^\n]*\)\s+param aiGithubClientSecret string = ''/);
    assert.match(source, /@secure\(\)\s+@description\([^\n]*\)\s+param aiByokApiKey string = ''/);
  }
  const app = read("infra/modules/container-app.bicep");
  assert.match(app, /secretRef: 'ai-github-client-secret'/);
  assert.match(app, /secretRef: 'ai-byok-api-key'/);
  assert.doesNotMatch(app, /name: 'AI_GITHUB_CLIENT_SECRET'\s+value: aiGithubClientSecret/);
  assert.doesNotMatch(app, /name: 'AI_BYOK_API_KEY'\s+value: aiByokApiKey/);
  // The app is only made bigger when AI is on.
  assert.match(app, /cpu: json\(aiOn \? '1\.0' : '0\.5'\)/);
  assert.match(app, /memory: aiOn \? '2Gi' : '1Gi'/);
});

test("the env template and the docs name the same off-by-default setting", () => {
  assert.match(read("portal/.env.template"), /^AI_GENERATION=off$/m);
  assert.match(read("docs/ai-writing.md"), /`AI_GENERATION`/);
});
