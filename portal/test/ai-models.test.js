/**
 * AI writing: the model picker's list. The recommended model leads and says why, `auto` and every other model stay, the cost
 * words are honest when GitHub reports none, and a model that can skip reasoning is asked to.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { normalizeModels, pickReasoningEffort, RECOMMENDED_MODELS, costLabel } from "../lib/ai/models.js";
import { createAi, localRequest } from "../lib/ai/index.js";
import { ESTIMATE_PARAMS } from "../lib/ai/estimate.js";
import { createFakeBackend } from "./fixtures/fake-ai.js";

// What the SDK reports on this account: no billing multiplier at all, as seen on the real service.
const SDK_MODELS = ["auto", "claude-sonnet-5.5", "claude-haiku-4.5", "gpt-5.6-luna", "mai-code-2-flash", "gpt-6.2-sol"].map((id) => ({
  id,
  name: id === "auto" ? "Auto" : id,
  policy: { state: "enabled" },
  supportedReasoningEfforts: id === "gpt-5.6-luna" ? ["none", "low", "medium"] : id === "mai-code-2-flash" ? ["low", "high"] : [],
}));
const RECOMMENDED = RECOMMENDED_MODELS[0].id;

test("the recommended model leads the list, is marked with a plain reason, and nothing else is removed or reordered", () => {
  const models = normalizeModels(SDK_MODELS);
  assert.equal(models[0].id, RECOMMENDED);
  assert.equal(models[0].recommended, true);
  assert.match(models[0].recommendedWhy, /\w+/);
  assert.doesNotMatch(models[0].recommendedWhy, /[\u{1F300}-\u{1FAFF}]/u, "no emoji");
  assert.deepEqual(models.slice(1).map((m) => m.id), SDK_MODELS.map((m) => m.id).filter((id) => id !== RECOMMENDED), "the rest keep the order the SDK gave");
  assert.equal(models.filter((m) => m.recommended).length, 1);
  assert.ok(models.some((m) => m.id === "auto"), "auto stays available");
  assert.ok(models.slice(1).every((m) => m.recommended === false && m.recommendedWhy === null));
});

test("when the recommended model is not offered, nothing is marked and the order is untouched", () => {
  const without = SDK_MODELS.filter((m) => m.id !== RECOMMENDED);
  const models = normalizeModels(without);
  assert.deepEqual(models.map((m) => m.id), without.map((m) => m.id));
  assert.ok(models.every((m) => !m.recommended));
  assert.deepEqual(normalizeModels(SDK_MODELS, { allowed: ["auto", "claude-haiku-4.5"] }).map((m) => m.id), ["auto", "claude-haiku-4.5"], "an administrator's allowlist still applies");
});

test("with no cost from GitHub the picker says so, and that each prompt counts against the allowance", () => {
  const [first] = normalizeModels(SDK_MODELS);
  assert.equal(first.multiplier, null);
  assert.equal(first.cost, "Cost not reported by GitHub; each prompt counts against your Copilot allowance");
  assert.equal(costLabel(0.33), "Uses 0.33 of a premium request for each prompt");
  assert.equal(costLabel(1), "Uses 1 premium request for each prompt");
  assert.equal(costLabel(0), "Included with your plan, no premium requests");
});

test("a model that can skip reasoning is asked to: none, else low, else nothing; a setting can turn it off or name a level", () => {
  const luna = normalizeModels(SDK_MODELS).find((m) => m.id === "gpt-5.6-luna");
  const flash = normalizeModels(SDK_MODELS).find((m) => m.id === "mai-code-2-flash");
  const haiku = normalizeModels(SDK_MODELS).find((m) => m.id === "claude-haiku-4.5");
  assert.equal(pickReasoningEffort(luna), "none");
  assert.equal(pickReasoningEffort(flash), "low");
  assert.equal(pickReasoningEffort(haiku), undefined, "a model that lists no levels gets none set");
  assert.equal(pickReasoningEffort(luna, "off"), undefined);
  assert.equal(pickReasoningEffort(luna, "medium"), "medium");
  assert.equal(pickReasoningEffort(flash, "none"), undefined, "a level the model does not list is not sent");
});

test("the status the page reads carries the numbers behind the prompt estimate", async () => {
  const ai = createAi({ env: { AI_GENERATION: "local-user" }, backend: createFakeBackend() });
  const status = await ai.service.status(localRequest());
  assert.equal(status.available, true);
  assert.deepEqual(status.estimate, ESTIMATE_PARAMS);
  const off = createAi({ env: {}, backend: createFakeBackend() });
  assert.deepEqual((await off.service.status(localRequest())).estimate, ESTIMATE_PARAMS, "the same shape when AI is off");
});

test("the writer asks for the reasoning effort the model allows, unless the setting says otherwise", async () => {
  const seen = [];
  const make = async (env, models) => {
    const backend = createFakeBackend();
    backend.listModels = async () => normalizeModels(models);
    const real = backend.complete.bind(backend);
    backend.complete = async (args) => {
      seen.push(args.reasoningEffort);
      return real(args);
    };
    const ai = createAi({ env: { AI_GENERATION: "local-user", ...env }, backend });
    const writer = await ai.service.authorize(localRequest(), { enabled: true, model: "gpt-5.6-luna", scope: ["lab"] });
    const unit = { id: "u", context: {}, blocks: [{ id: "u.why", kind: "why", type: "text", source: "Agents help the team answer questions faster and more consistently.", names: [] }] };
    await writer.run({ units: [unit] });
    writer.release();
  };
  await make({}, SDK_MODELS);
  await make({ AI_REASONING_EFFORT: "off" }, SDK_MODELS);
  await make({ AI_REASONING_EFFORT: "low" }, SDK_MODELS);
  assert.deepEqual(seen, ["none", undefined, "low"]);
});
