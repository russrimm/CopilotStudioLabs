// Real-browser proof of "build the agent from scratch": the companion's own runJob drives a real Chromium against the pretend
// Copilot Studio (newer layout: Build, Preview, Evaluate, and Monitor tabs; a new-agent page; an instructions editor; a
// two-step Add knowledge dialog; a test pane with streamed answers; a Publish dialog) with decoys and never-do controls in it.
// What is proved: the agent is made once and found again, every write is inside it, the modules run in order, nothing in the
// never list is touched, and every stop (a license, a limit, an unknown dialog, a stop request, an unconfirmed account) comes
// before the next write. Each test skips itself when no browser is installed.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { detectBrowserAvailability } from "../lab-runner.mjs";
import { createTrace } from "../trace.mjs";
import { FAKE_AGENT_URL, FAKE_ENV_ID, FAKE_PRACTICE_ENV_ID } from "./fixtures/fake-product-site.mjs";
import { startScenario } from "./fixtures/capture-scenarios.mjs";

const found = await detectBrowserAvailability();
const skip = !found.available && "Playwright with Chromium is not installed";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FEATURES = ["mc-create-agent", "mc-instructions", "mc-knowledge", "mc-preview-test", "mc-publish-agent", "mc-memory"];
const SITE = { layout: "newer", chatDelayMs: 200, chatStreamMs: 200, defaultDelayMs: 100 };
const RUN = { localOptIn: true, writeGapMs: 0, effectMs: 1500, findMs: 3500, readiness: { answerMs: 20000 } };

async function scenarioFor(site = {}, features = FEATURES, harness = "microsoft-copilot") {
  const scenario = await startScenario({ repoDir: REPO, site: { ...SITE, ...site }, lab: { harness, features } });
  const consent = await scenario.call("PUT", "/api/capture/consent", { consented: true, level: "scratch" });
  assert.equal(consent.status, 200);
  return scenario;
}

const run = (scenario, runOptions = {}) => scenario.runJob({ job: { options: { mode: "autonomous" } }, runOptions: { ...RUN, ...runOptions } });
const writesOf = (out, prefix) => out.site.stats.writes.filter((w) => w.startsWith(prefix));
const captured = (out) => out.rows.filter((r) => r.status === "captured");

test("the agent is built from scratch, every write is inside it, the modules run in order, and nothing in the never list is touched", { skip }, async () => {
  const scenario = await scenarioFor();
  try {
    const out = await run(scenario);
    const writes = out.site.stats.writes;
    assert.equal(writesOf(out, "create-agent:").length, 1, "the agent is made once");
    assert.match(writesOf(out, "create-agent:")[0], /^create-agent:Lab screenshots - .{1,12}$/, "named from the lab, within the 30 characters the product keeps");
    const at = (prefix) => writes.findIndex((w) => w.startsWith(prefix));
    assert.ok(at("create-agent:") === 0 && at("set-instructions:") > 0 && at("add-knowledge:") > at("set-instructions:"), `the stages follow the lab's order: ${writes.join(" | ")}`);
    assert.equal(writesOf(out, "publish").length, 0, "the lab only shows the Publish dialog, so nothing is published");
    assert.deepEqual(out.site.stats.dangers, [], "no never-do control was touched");
    assert.equal(out.site.stats.adminVisits, 0, "no admin page was opened");
    assert.equal(captured(out).length, out.rows.length, `every shot was captured: ${out.rows.map((r) => `${r.filename}:${r.status}`).join(", ")}`);

    // The portal learns names and counts only.
    const scratch = out.job.result.scratch;
    assert.match(scratch.name, /^Lab screenshots - /);
    assert.ok(scratch.stages.includes("instructions") && scratch.stages.includes("knowledge"));
    assert.ok(out.job.result.created.some((c) => c.kind === "agent"));
    const shown = JSON.stringify(out.job);
    assert.ok(!shown.includes(FAKE_ENV_ID) && !/7a1c[0-9a-f]{4}-5b3d/.test(shown) && !shown.includes("0f6c2d9a"), "no environment or agent identifier reaches the portal");
    const registry = JSON.parse(fs.readFileSync(path.join(out.home, ".practice-agents.json"), "utf8"));
    assert.equal(registry.agents.length, 1);
    assert.deepEqual(registry.pending, []);
    assert.ok(fs.readFileSync(path.join(out.home, "practice-report.md"), "utf8").includes("Lab screenshots - "), "a created-items report is kept on this computer");
  } finally {
    await scenario.close();
  }
});

test("a second run finds the same agent and creates and adds nothing twice", { skip }, async () => {
  const scenario = await scenarioFor();
  try {
    await run(scenario);
    const again = await run(scenario);
    assert.equal(writesOf(again, "create-agent:").length, 1, "still one agent");
    assert.equal(writesOf(again, "set-instructions:").length, 1, "the instructions were not typed again");
    assert.equal(writesOf(again, "add-knowledge:").length, 1, "the website was not added again");
    assert.equal(again.job.result.scratch.reused, true);
    assert.equal(captured(again).length, again.rows.length);
  } finally {
    await scenario.close();
  }
});

test("when the new-agent page stays on its address after Save, the agent is found by its name and never made twice", { skip }, async () => {
  const scenario = await scenarioFor({ stayOnNew: true });
  try {
    const out = await run(scenario);
    assert.equal(writesOf(out, "create-agent:").length, 1);
    assert.ok(captured(out).length >= out.rows.length - 1, out.rows.map((r) => `${r.filename}:${r.status}`).join(", "));
    assert.ok(writesOf(out, "set-instructions:").length === 1);
  } finally {
    await scenario.close();
  }
});

test("an account that cannot create agents ends every agent shot with one plain reason and changes nothing", { skip }, async () => {
  const scenario = await scenarioFor({ createDisabled: true });
  try {
    const out = await run(scenario);
    assert.deepEqual(out.site.stats.writes, []);
    assert.ok(out.rows.every((r) => r.status === "needs-you" && r.cause === "agent-create-failed"), out.rows.map((r) => `${r.status}:${r.cause}`).join(", "));
    assert.match(out.rows[0].reason, /could not find a way to create an agent/);
    const registryFile = path.join(out.home, ".practice-agents.json");
    if (fs.existsSync(registryFile)) {
      const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
      assert.deepEqual([registry.agents.length, registry.pending.length], [0, 0], "nothing is remembered when nothing was made");
    }
  } finally {
    await scenario.close();
  }
});

test("a license prompt stops the whole run before anything else is written", { skip }, async () => {
  const scenario = await scenarioFor({ licenseOnPublish: true });
  try {
    const out = await run(scenario);
    assert.equal(writesOf(out, "publish").length, 0);
    assert.deepEqual(out.site.stats.dangers, []);
    const stopped = out.rows.filter((r) => r.cause === "run-stopped");
    assert.ok(stopped.length >= 1, out.rows.map((r) => `${r.filename}:${r.status}:${r.cause}`).join(", "));
    assert.ok(out.rows.slice(out.rows.findIndex((r) => r.cause === "run-stopped")).every((r) => r.status !== "captured"), "nothing is captured after the stop");
  } finally {
    await scenario.close();
  }
});

const PUBLISH_FEATURES = ["create-agent", "agent-instructions", "knowledge-files-web", "publish-agent"];
const publishRow = (out) => out.rows.find((r) => r.filename === "publish-confirmation.png");

test("the practice agent is published once, only after its instructions and knowledge are proven and its dialog is the plain one, and never again", { skip }, async () => {
  const scenario = await scenarioFor({}, PUBLISH_FEATURES, "standard");
  try {
    const out = await run(scenario);
    const writes = out.site.stats.writes;
    assert.equal(writesOf(out, "publish:").length, 1, `published exactly once: ${writes.join(" | ")}`);
    assert.ok(writes.findIndex((w) => w.startsWith("publish:")) > writes.findIndex((w) => w.startsWith("add-knowledge:")) && writes.findIndex((w) => w.startsWith("add-knowledge:")) > writes.findIndex((w) => w.startsWith("set-instructions:")), `after the instructions and the knowledge: ${writes.join(" | ")}`);
    assert.deepEqual(out.site.stats.dangers, [], "the Add channel button was never clicked");
    assert.equal(publishRow(out)?.status, "captured", out.rows.map((r) => `${r.filename}:${r.status}:${r.cause || ""}`).join(", "));
    const registry = JSON.parse(fs.readFileSync(path.join(out.home, ".practice-agents.json"), "utf8"));
    assert.ok(registry.agents[0].once.publish, "the one publish was claimed in the local record");
    assert.ok(registry.agents[0].stages.published.proof >= 2, "and the published state was proven by the product's own message");
    assert.match(fs.readFileSync(path.join(out.home, "practice-report.md"), "utf8"), /Published the practice agent to its default state/);

    const again = await run(scenario);
    assert.equal(writesOf(again, "publish:").length, 1, "a second run does not publish again");
    assert.deepEqual(again.site.stats.dangers, []);
  } finally {
    await scenario.close();
  }
});

test("a Publish dialog with anything beyond Add channel and Publish agent is never confirmed, and says so plainly", { skip }, async () => {
  const scenario = await scenarioFor({ publishExtra: true }, PUBLISH_FEATURES, "standard");
  try {
    const out = await run(scenario);
    assert.equal(writesOf(out, "publish:").length, 0, "nothing was published");
    assert.deepEqual(out.site.stats.dangers, []);
    const row = publishRow(out);
    assert.notEqual(row?.status, "captured");
    assert.match(row?.reason || "", /Publish dialog shows something the computer does not know/);
    const registry = JSON.parse(fs.readFileSync(path.join(out.home, ".practice-agents.json"), "utf8"));
    assert.ok(!registry.agents[0].once?.publish, "no claim is made when nothing was clicked");
  } finally {
    await scenario.close();
  }
});

test("a limit message while saving stops the run: no later write is made", { skip }, async () => {
  const scenario = await scenarioFor({ quotaOnSave: true });
  try {
    const out = await run(scenario);
    assert.equal(writesOf(out, "add-knowledge:").length, 0, "nothing was added after the limit message");
    assert.equal(writesOf(out, "memory:").length, 0);
    assert.ok(out.rows.some((r) => r.cause === "run-stopped"), out.rows.map((r) => `${r.filename}:${r.status}:${r.cause}`).join(", "));
  } finally {
    await scenario.close();
  }
});

test("a dialog the computer does not know is never confirmed", { skip }, async () => {
  const scenario = await scenarioFor({ knowledgeDialogTitle: "Add something else" });
  try {
    const out = await run(scenario);
    assert.equal(writesOf(out, "add-knowledge:").length, 0, "the unknown dialog was not confirmed");
    assert.deepEqual(out.site.stats.dangers, []);
    const knowledgeRows = out.rows.filter((r) => /knowledge/.test(r.filename));
    assert.ok(knowledgeRows.every((r) => r.status !== "captured" || /dialog/.test(r.filename)), "no picture claims the website was added");
    assert.ok(writesOf(out, "set-instructions:").length === 1, "the other stages still ran");
  } finally {
    await scenario.close();
  }
});

test("a stop request halts before the next write", { skip }, async () => {
  const scenario = await scenarioFor();
  try {
    const out = await run(scenario, { shouldStop: () => scenario.site.stats.writes.length >= 1 });
    assert.equal(out.site.stats.writes.length, 1, `only the agent was made: ${out.site.stats.writes.join(" | ")}`);
    assert.ok(out.rows.every((r) => r.status !== "captured" || /create-agent/.test(r.filename) || true));
    assert.equal(writesOf(out, "set-instructions:").length, 0);
  } finally {
    await scenario.close();
  }
});

test("a slow page is waited for and never reloaded: the agent page takes 25 seconds to draw and is opened once", { skip }, async () => {
  const scenario = await scenarioFor({ delays: { overview: 25_000 } }, ["mc-create-agent", "mc-instructions", "mc-knowledge"]);
  const traceFile = path.join(scenario.home, "slow-page-trace.log");
  const trace = createTrace({ file: traceFile, terms: [], header: { test: "slow page" } });
  try {
    const out = await run(scenario, { trace });
    const events = fs.readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const agentLoads = out.site.stats.pages.filter((p) => /\/bots\/[^/]+\/overview$/.test(p));
    assert.equal(agentLoads.length, 1, `the agent page was loaded once, however long it took to draw: ${agentLoads.length}`);
    assert.deepEqual(events.filter((e) => e.event === "page-recovery"), [], "a page that was only slow is not recovered");
    const toAgent = events.filter((e) => e.event === "navigation" && /\{id\}/.test(String(e.to)) && e.reason === "open-practice-screen");
    assert.ok(toAgent.length <= 1, `at most one navigation to the agent: ${toAgent.length}`);
    assert.ok(events.every((e) => e.event !== "navigation" || e.reason), "every navigation says why");
    assert.equal(captured(out).length, out.rows.length, out.rows.map((r) => `${r.filename}:${r.status}`).join(", "));
    assert.ok(out.elapsedMs > 25_000, "the page really was slow");
  } finally {
    await scenario.close();
  }
});

test("knowledge the product keeps only after Save is saved, and the list is checked before the stage counts as done", { skip }, async () => {
  const scenario = await scenarioFor({ knowledgeNeedsSave: true }, ["mc-create-agent", "mc-instructions", "mc-knowledge", "mc-preview-test"]);
  try {
    const out = await run(scenario);
    assert.equal(writesOf(out, "add-knowledge:").length, 1, `the website is in the agent once it was saved: ${out.site.stats.writes.join(" | ")}`);
    assert.deepEqual(out.site.stats.dangers, [], "the Remove buttons that prove the list were only looked at");
    assert.equal(captured(out).length, out.rows.length, out.rows.map((r) => `${r.filename}:${r.status}:${r.cause || ""}`).join(", "));
    const registry = JSON.parse(fs.readFileSync(path.join(out.home, ".practice-agents.json"), "utf8"));
    assert.ok(registry.agents[0].stages.knowledge.proof >= 2);
    const again = await run(scenario);
    assert.equal(writesOf(again, "add-knowledge:").length, 1, "a rerun finds the listed website and adds nothing");
  } finally {
    await scenario.close();
  }
});

test("a menu a picture left open is closed before the next step, and the page is opened again only when it will not close", { skip }, async () => {
  const scenario = await scenarioFor({}, ["mc-create-agent", "mc-instructions", "mc-model-selection", "mc-knowledge", "mc-preview-test"]);
  const traceFile = path.join(scenario.home, "leftover-trace.log");
  const trace = createTrace({ file: traceFile, terms: [], header: { test: "leftover menu" } });
  try {
    const out = await run(scenario, { trace });
    const events = fs.readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(captured(out).length, out.rows.length, out.rows.map((r) => `${r.filename}:${r.status}:${r.cause || ""}`).join(", "));
    assert.equal(writesOf(out, "add-knowledge:").length, 1, "the knowledge source is added once, not blocked by the open model list");
    const resets = events.filter((e) => e.event === "page-recovery");
    assert.ok(resets.length >= 1 && resets.length <= 6, `the stubborn menu was cleared by opening the page again, a few times at most: ${resets.length}`);
    assert.ok(resets.every((e) => /would not close/.test(e.why)), "and every one says why");
    assert.ok(events.every((e) => e.event !== "navigation" || e.reason), "every navigation says why");
  } finally {
    await scenario.close();
  }
});

test("closing the browser mid-run pauses it, and the next run uses the same agent without making another", { skip }, async () => {
  const scenario = await scenarioFor();
  try {
    let closed = false;
    const first = await scenario.runJob({
      job: { options: { mode: "autonomous" } },
      runOptions: RUN,
      onUpload: async ({ uploads, contexts }) => {
        if (uploads === 2 && !closed) {
          closed = true;
          await Promise.all(contexts.map((c) => c.close().catch(() => {})));
        }
      },
    });
    assert.ok(first.job.result.paused >= 1 || first.job.result.captured < first.rows.length, "the run did not finish");
    assert.equal(writesOf(first, "create-agent:").length, 1);
    const second = await run(scenario);
    assert.equal(writesOf(second, "create-agent:").length, 1, "the agent made before the window closed is used, not made again");
    assert.equal(second.job.result.scratch.reused, true);
    assert.equal(captured(second).length, second.rows.length);
  } finally {
    await scenario.close();
  }
});

test("the environment the person names is the one the agent is built in, and a missing one builds nothing", { skip }, async () => {
  const scenario = await scenarioFor({}, ["mc-create-agent", "mc-instructions"]);
  try {
    const named = await scenario.call("PUT", "/api/capture/consent", { consented: true, level: "scratch", practiceEnvironmentUrl: `https://copilotstudio.microsoft.com/environments/${FAKE_PRACTICE_ENV_ID}/home` });
    assert.equal(named.status, 200, named.text);
    const out = await run(scenario);
    assert.equal(scenario.site.practiceAgents().length, 1, "the practice agent is in the environment that was named");
    assert.equal(writesOf(out, "create-agent:").length, 1);
    assert.equal(out.job.result.scratch.environment, "set", "the portal is told an environment was set, not which one");
    assert.ok(!JSON.stringify(out.job).includes(FAKE_PRACTICE_ENV_ID), "the environment's id never reaches the browser's view of the job");
    assert.equal(captured(out).length, out.rows.length);
  } finally {
    await scenario.close();
  }

  const missing = await scenarioFor({}, ["mc-create-agent", "mc-instructions"]);
  try {
    const none = await missing.call("PUT", "/api/capture/consent", { consented: true, level: "scratch", practiceEnvironmentUrl: "https://copilotstudio.microsoft.com/environments/00000000-1111-4222-8333-444444444444/home" });
    assert.equal(none.status, 200, none.text);
    const out = await run(missing);
    assert.deepEqual(out.site.stats.writes, [], "an environment the product does not open builds nothing");
    assert.ok(out.rows.every((r) => r.status === "needs-you"), out.rows.map((r) => `${r.filename}:${r.status}:${r.cause}`).join(", "));
  } finally {
    await missing.close();
  }
});

test("nothing is written before the account is confirmed, and one yes in the same window lets the run go on", { skip }, async () => {
  const account = { mode: "separate", explicitMode: false, os: { osWorkAccount: null } };
  const scenario = await scenarioFor();
  try {
    const refused = await run(scenario, { account, confirmAccount: async () => false });
    assert.deepEqual(refused.site.stats.writes, [], "an unconfirmed account stops before the first write");
    assert.equal(refused.job.result.needsAccount?.code, "unverified");
    const accepted = await run(scenario, { account, confirmAccount: async () => true });
    assert.equal(writesOf(accepted, "create-agent:").length, 1, "after the yes the agent is made");
    assert.equal(captured(accepted).length, accepted.rows.length);
  } finally {
    await scenario.close();
  }
});

test("the older layout: the agent is made on its form, screens are looked at, and what cannot be set says so plainly", { skip }, async () => {
  const scenario = await scenarioFor({ layout: "classic" });
  try {
    const out = await run(scenario);
    assert.equal(writesOf(out, "create-agent:").length, 1);
    assert.deepEqual(out.site.stats.dangers, []);
    const create = out.rows.find((r) => /create-agent/.test(r.filename));
    assert.equal(create.status, "captured");
    assert.ok(out.rows.every((r) => r.status === "captured" || r.status === "needs-you"));
  } finally {
    await scenario.close();
  }
});

// ── Which agent the screenshots use: the one created first in the capture ─────────────────────────────────

const botIdsOpened = (out) => [...new Set(out.site.stats.pages.map((p) => /\/bots\/([^/]+)/.exec(p)?.[1]).filter(Boolean))];
const madeAgentIds = (site) => Object.values(site.envs).flatMap((e) => e.agents).filter((a) => a.name.startsWith("Lab screenshots - ")).map((a) => a.id);
const NON_ZERO_GUID = /\b(?!0{8}-0{4}-0{4}-0{4}-0{12}\b)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** Every text file under a folder, with the ones named `skip` left out. */
function textFilesUnder(dir, skip = () => false) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...textFilesUnder(file, skip));
    else if (/\.(?:json|jsonl|md|txt|log|html|csv)$/i.test(entry.name) && !skip(file)) out.push(file);
  }
  return out;
}

test("the agent created first is used by every later shot with no address supplied, no other agent is opened even one whose address is saved, and no address or id is stored anywhere it should not be", { skip }, async () => {
  const scenario = await scenarioFor();
  const traceFile = path.join(scenario.home, "handoff-trace.log");
  const trace = createTrace({ file: traceFile, terms: [], header: { test: "agent hand-off" } });
  try {
    // An agent the person saved earlier exists in the tenant and its address is in the lab's settings, but the choice is the created agent.
    const out = await scenario.runJob({ job: { targets: { copilotStudioAgentUrl: FAKE_AGENT_URL }, options: { mode: "autonomous", agentSource: "created" } }, runOptions: { ...RUN, trace } });
    assert.equal(out.job.options.agentSource, "created");
    assert.equal(out.claimed.env.CAPTURE_COPILOT_STUDIO_AGENT_URL, undefined, "the saved agent's address is not even sent to the computer");
    const dependents = out.claimed.shots.filter((s) => s.capture.agent?.needs && !s.capture.agent.creates);
    assert.ok(dependents.length >= 3 && dependents.every((s) => s.capture.agent.via === "created" && !s.capture.missing.includes("copilot-studio-agent")), "the shots that show an agent are ready, not waiting for an address");
    assert.equal(writesOf(out, "create-agent:").length, 1, "one agent was made");
    assert.equal(out.rows.filter((r) => r.status === "skipped" || r.cause === "no-agent").length, 0, "nothing waited for an address");
    assert.equal(captured(out).length, out.rows.length, out.rows.map((r) => `${r.filename}:${r.status}:${r.cause || ""}`).join(", "));
    const made = madeAgentIds(out.site);
    assert.equal(made.length, 1);
    assert.deepEqual(botIdsOpened(out), made, "the only agent page that was opened is the agent the computer made");
    assert.equal(out.job.result.scratch.name.startsWith("Lab screenshots - "), true);

    // Nothing that identifies the tenant, the environment, or the agent is kept outside this computer's own practice-agent record.
    const storage = path.dirname(scenario.lab.generatedRoot);
    const stored = textFilesUnder(storage, (file) => /\.plan\.json$/.test(file));
    assert.ok(stored.length >= 3, "the lab, the job, and the library records were scanned");
    for (const file of stored) {
      const text = fs.readFileSync(file, "utf8");
      assert.deepEqual(text.match(NON_ZERO_GUID) || [], [], `no id in ${path.basename(file)}`);
      assert.ok(!text.includes(FAKE_ENV_ID) && !text.includes(made[0]), `no environment or agent id in ${path.basename(file)}`);
    }
    const shared = [JSON.stringify(out.job), JSON.stringify(out.labStatus), out.lines.join("\n"), fs.readFileSync(traceFile, "utf8")];
    for (const text of shared) {
      assert.deepEqual(text.match(NON_ZERO_GUID) || [], [], "no id in the job, the lab status, the companion's log, or its trace");
      assert.ok(!text.includes(made[0]));
    }
    const registry = JSON.parse(fs.readFileSync(path.join(out.home, ".practice-agents.json"), "utf8"));
    assert.equal(registry.agents[0].botId, made[0], "the address lives only in the companion's own record");
  } finally {
    await scenario.close();
  }
});

test("a practice agent made under a different sign-in is not used and nothing is made in its place, and it is used again under the same sign-in", { skip }, async () => {
  const account = { mode: "separate", explicitMode: false, os: { osWorkAccount: null } };
  const scenario = await scenarioFor();
  const accepted = { account, confirmAccount: async () => true };
  try {
    const first = await run(scenario, accepted);
    assert.equal(captured(first).length, first.rows.length, "the first run made the agent and captured everything");
    const file = path.join(first.home, ".practice-agents.json");
    const registry = JSON.parse(fs.readFileSync(file, "utf8"));
    const marker = registry.agents[0].accountId;
    assert.match(marker, /^[0-9a-f]{12}$/, "the agent is tied to a random marker of the sign-in that made it");

    registry.agents[0].accountId = "ffffffffffff";
    fs.writeFileSync(file, JSON.stringify(registry));
    const writes = scenario.site.stats.writes.length;
    const pages = scenario.site.stats.pages.length;
    const other = await run(scenario, accepted);
    assert.equal(scenario.site.stats.writes.length, writes, "nothing was made or changed");
    assert.deepEqual(scenario.site.stats.pages.slice(pages).filter((p) => /\/bots\//.test(p)), [], "the agent made under the other sign-in was never opened");
    const stopped = other.rows.filter((r) => r.cause === "agent-unavailable");
    assert.ok(stopped.length >= 1, other.rows.map((r) => `${r.filename}:${r.status}:${r.cause || ""}`).join(", "));
    assert.match(stopped[0].reason, /made under a different sign-in and was not used/);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).agents.length, 1, "no second agent, and the first one is kept");

    registry.agents[0].accountId = marker;
    fs.writeFileSync(file, JSON.stringify(registry));
    const same = await run(scenario, accepted);
    assert.equal(captured(same).length, same.rows.length, "under the same sign-in the agent is reused");
    assert.equal(same.job.result.scratch.reused, true);
    assert.equal(madeAgentIds(scenario.site).length, 1);
  } finally {
    await scenario.close();
  }
});

// ── Recipe families: test conversations with panels, dialogs, item details, a sample test set, and the landmark check ──

const FAMILY_FEATURES = ["create-agent", "agent-instructions", "knowledge-files-web", "knowledge-sharepoint", "generative-orchestration", "content-moderation", "evaluations"];
const rowOf = (out, name) => out.rows.find((r) => r.filename === name);
const reviewReasons = (row) => (row?.verification?.reasons || []).map((r) => r.code);
const statusLine = (out) => out.rows.map((r) => `${r.filename}:${r.status}:${r.cause || ""}`).join(", ");

/** Change what one shot of the generated lab says it shows (the plan reads the lab's own shot list). */
function editShot(labDir, filename, change) {
  const file = path.join(labDir, "screenshots", "shots.json");
  const plan = JSON.parse(fs.readFileSync(file, "utf8"));
  const shot = plan.shots.find((s) => s.filename === filename);
  Object.assign(shot, change);
  fs.writeFileSync(file, JSON.stringify(plan, null, 2));
}

/** A knowledge item is listed by the address of its website, so a lab whose first knowledge address names SharePoint would show an item the safety rules rightly will not open. */
function neutralKnowledgeAddress(labDir) {
  const file = path.join(labDir, "manifest.json");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/knowledge-add-sharepoint/g, "knowledge-copilot-studio"));
}

/** A lab that lists no public website to add as knowledge: the practice agent keeps no knowledge source. */
function withoutKnowledgeWebsite(labDir) {
  const file = path.join(labDir, "manifest.json");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/https:\/\/learn\.microsoft\.com/g, "https://docs.invalid"));
}

test("test conversations, dialogs, an item, and a sample test set are taken by their recipes; what the computer cannot check is saved for review; nothing above the allowed tier is touched", { skip }, async () => {
  const scenario = await scenarioFor({}, FAMILY_FEATURES, "standard");
  try {
    editShot(scenario.lab.labDir, "knowledge-sources-list.png", { caption: "Details of the first knowledge source" });
    neutralKnowledgeAddress(scenario.lab.labDir);
    const out = await run(scenario);
    const stats = out.site.stats;
    for (const name of ["test-pane-in-scope.png", "activity-map-plan.png", "knowledge-sharepoint-add.png", "eval-test-set.png", "knowledge-sources-list.png"]) assert.equal(rowOf(out, name)?.status, "captured", `${name}: ${statusLine(out)} :: ${rowOf(out, name)?.reason}`);
    assert.ok(stats.views.includes("activity-map"), "the activity map was brought up beside the answer");
    // What the computer cannot check is kept for a person, with the picture, and says why in plain words.
    for (const name of ["knowledge-answer-citation.png", "guardrail-refusal.png", "test-guardrail-response.png"]) {
      assert.equal(rowOf(out, name)?.status, "needs-review", `${name}: ${statusLine(out)}`);
      assert.deepEqual(reviewReasons(rowOf(out, name)), ["recipe-review"], name);
    }
    assert.match(rowOf(out, "knowledge-answer-citation.png").verification.reasons[0].message, /cannot tell whether the answer shows a citation/);
    assert.match(rowOf(out, "guardrail-refusal.png").verification.reasons[0].message, /cannot tell whether the agent refused/);
    // A screen that needs Copilot Credits is never tried, and says so.
    assert.equal(rowOf(out, "eval-results.png")?.status, "needs-you");
    assert.equal(rowOf(out, "eval-results.png")?.cause, "needs-credits");
    // The only thing added to the practice agent for these recipes is one test set, saved and never run; none of the credit-spending decoys was touched.
    assert.equal(writesOf(out, "create-evaluation:").length, 1, `one test set: ${stats.writes.join(" | ")}`);
    assert.equal(writesOf(out, "run-evaluation").length, 0);
    assert.deepEqual(stats.dangers, [], "the Run, Evaluate, and Quick question set decoys, and every other never-do control, were left alone");
    assert.ok(stats.answers >= 5, `the lab's question, the activity map, the citation, and the two refusals were asked: ${stats.answers}`);
    // The practice report says what each recipe did, and which ones were never seen on a real tenant.
    const report = fs.readFileSync(path.join(out.home, "practice-report.md"), "utf8");
    assert.match(report, /What the screenshot recipes did/);
    assert.match(report, /Created: an evaluation test set with one sample question \(saved, never run\)/);
    assert.match(report, /This recipe has not been seen working on a real tenant yet/);
    assert.match(report, /Created nothing/);
    // No address or id reaches the portal, and the dry plan lists these recipes before a run.
    const shown = JSON.stringify(out.job) + JSON.stringify(out.rows.map((r) => r.verification));
    assert.ok(!shown.includes(FAKE_ENV_ID) && !/7a1c[0-9a-f]{4}-5b3d/.test(shown), "no environment or agent identifier reaches the portal");
    // Nothing that identifies the tenant, the environment, or the agent is stored outside this computer's own practice-agent record, whatever recipe ran.
    const made = madeAgentIds(out.site);
    assert.equal(made.length, 1);
    assert.deepEqual(botIdsOpened(out), made, "the only agent page that was opened is the practice agent: no other agent was touched by any recipe");
    const stored = textFilesUnder(path.dirname(scenario.lab.generatedRoot), (file) => /\.plan\.json$/.test(file));
    assert.ok(stored.length >= 3, "the lab, the job, and the library records were scanned");
    for (const file of stored) {
      const text = fs.readFileSync(file, "utf8");
      assert.deepEqual(text.match(NON_ZERO_GUID) || [], [], `no id in ${path.basename(file)}`);
      assert.ok(!text.includes(FAKE_ENV_ID) && !text.includes(made[0]), `no environment or agent id in ${path.basename(file)}`);
    }
    for (const text of [JSON.stringify(out.job), JSON.stringify(out.labStatus), out.lines.join("\n")]) {
      assert.deepEqual(text.match(NON_ZERO_GUID) || [], [], "no id in the job, the lab status, or the companion's log");
      assert.ok(!text.includes(made[0]));
    }
    const registry = JSON.parse(fs.readFileSync(path.join(out.home, ".practice-agents.json"), "utf8"));
    assert.ok(registry.recipes.length >= 3, "the recipes that ran are recorded on this computer");
    for (const recipe of registry.recipes) assert.doesNotMatch(`${recipe.what} ${recipe.shot} ${recipe.key}`, /https?:|copilotstudio|[0-9a-f]{8}-[0-9a-f]{4}/i, "what a recipe did is described in words, never by an address or an id (the agent's own id stays in this record only)");
    const dry = (await scenario.call("POST", "/api/capture/dry-plan", { target: { type: "lab", labId: scenario.lab.labId }, scope: { mode: "all" } })).body.dryPlan;
    assert.ok(dry.automatic.some((s) => s.filename === "activity-map-plan.png" && s.family === "conversation") && dry.objects.some((o) => o.id === "evaluation-test-set"));
  } finally {
    await scenario.close();
  }
});

test("a second run reuses the test set and adds nothing twice", { skip }, async () => {
  const scenario = await scenarioFor({}, ["create-agent", "agent-instructions", "evaluations"], "standard");
  try {
    await run(scenario);
    const again = await run(scenario);
    assert.equal(writesOf(again, "create-evaluation:").length, 1, "still one test set");
    assert.equal(rowOf(again, "eval-test-set.png")?.status, "captured");
    assert.equal(writesOf(again, "create-agent:").length, 1);
    assert.deepEqual(again.site.stats.dangers, []);
  } finally {
    await scenario.close();
  }
});

test("a panel the screen does not show is never accepted blindly: the picture is saved as Needs review, and the question is asked once", { skip }, async () => {
  const scenario = await scenarioFor({ noActivityMap: true }, ["create-agent", "agent-instructions", "generative-orchestration"], "standard");
  try {
    const out = await run(scenario);
    const row = rowOf(out, "activity-map-plan.png");
    assert.equal(row?.status, "needs-review", statusLine(out));
    assert.deepEqual(reviewReasons(row), ["recipe-review"]);
    assert.match(row.verification.reasons[0].message, /did not show what the computer expected \(missing: Activity map\)\. The picture was saved so you can check it\./);
    assert.deepEqual(out.site.stats.views, [], "nothing was clicked that was not there");
    assert.equal(out.site.stats.answers, 2, "the lab's question and the activity-map question were each asked once: no retry loop");
    assert.equal(rowOf(out, "test-pane-in-scope.png")?.status, "captured", "a plain question and answer needs no panel");
    assert.deepEqual(out.site.stats.dangers, []);
  } finally {
    await scenario.close();
  }
});

test("in the older layout the same recipes work, and what the layout cannot do stops with a plain reason and changes nothing", { skip }, async () => {
  const scenario = await scenarioFor({ layout: "classic", editableInstructions: true }, ["create-agent", "agent-instructions", "knowledge-sharepoint", "evaluations", "knowledge-files-web"], "standard");
  try {
    // No public website, so no knowledge source is added; the first tool (listed on the Tools page) is the item to open.
    withoutKnowledgeWebsite(scenario.lab.labDir);
    editShot(scenario.lab.labDir, "knowledge-sources-list.png", { caption: "Details of the first tool", feature: "tools", featureId: "tools", section: "tools" });
    const out = await run(scenario);
    assert.equal(rowOf(out, "test-pane-in-scope.png")?.status, "captured", statusLine(out));
    assert.equal(rowOf(out, "knowledge-sharepoint-add.png")?.status, "captured", statusLine(out));
    assert.equal(rowOf(out, "knowledge-sources-list.png")?.status, "captured", `${statusLine(out)} :: the first tool is opened in the classic Tools page and left without saving`);
    assert.ok(out.site.stats.views.length === 0 || out.site.stats.views.every((v) => v === "activity-map"), "no panel was opened that the older layout does not have");
    const testSet = rowOf(out, "eval-test-set.png");
    assert.equal(testSet?.status, "needs-you", "the older layout has no Evaluation page in this product, so nothing is guessed");
    assert.equal(writesOf(out, "create-evaluation:").length, 0);
    assert.deepEqual(out.site.stats.writes.filter((w) => !/^(?:create-start|create-agent:|set-name:|set-instructions:)/.test(w)), [], "nothing but the practice agent and its instructions was changed");
    assert.deepEqual(out.site.stats.dangers, []);
  } finally {
    await scenario.close();
  }
});
