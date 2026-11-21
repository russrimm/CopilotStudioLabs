// The practice agent: the one agent the companion may change, and only after the person opted in. It is created
// by the companion itself in the practice environment the person chose, named "Lab screenshots - <code>", and
// recorded in a local registry so the next job reuses it. The companion never deletes anything: after a run it
// writes a plain-language report of everything it created, so the person can delete the practice agent themselves.
//
// The registry and the report stay on this computer, under the companion folder. They hold the agent's address,
// which is why they are never uploaded and never part of the companion download.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { parseCopilotStudioAddress } from "./targets.mjs";

export const PRACTICE_PREFIX = "Lab screenshots - ";
const REGISTRY_NAME = ".practice-agents.json";
const REPORT_NAME = "practice-report.md";

/** A new practice agent name: the fixed prefix and a short code, so two runs never collide. */
export function practiceName(random = () => crypto.randomBytes(3).toString("hex")) {
  return `${PRACTICE_PREFIX}${random()}`;
}

/** Whether a name is one the companion made itself. */
export function isPracticeName(name) {
  return String(name || "").startsWith(PRACTICE_PREFIX);
}

export function practiceRegistryPath(home) {
  return path.join(home, REGISTRY_NAME);
}

export function practiceReportPath(home) {
  return path.join(home, REPORT_NAME);
}

const STAGE_PROOF = 2;
const emptyRegistry = () => ({ schema: 2, agents: [], changes: [], pending: [] });
// What the practice report calls the things a recipe may add to the practice agent (see OBJECTS in automation.mjs).
const OBJECT_NAMES = Object.freeze({ "evaluation-test-set": "an evaluation test set with one sample question (saved, never run)" });

/**
 * Whether a recorded practice agent was made under the sign-in that is active now: "same", "different", or "unknown" when either side
 * has no marker (a record from before markers, or a run with no account check). Only "different" keeps the agent from being used.
 */
export function agentAccountState(entry, accountId) {
  if (!entry?.accountId || !accountId) return "unknown";
  return entry.accountId === accountId ? "same" : "different";
}

/** Why a practice agent that was made under another sign-in is not used (a clause, so it reads on its own and inside a longer sentence). */
export const AGENT_ACCOUNT_REASON = "The practice agent for this lab was made under a different sign-in and was not used";

/** The plain sentence for it, with what to do next. */
export const AGENT_ACCOUNT_MESSAGE = `${AGENT_ACCOUNT_REASON}. Sign in with the account that made it, or choose Start fresh to build a new practice agent.`;

/**
 * The local record of what was created. `agents` hold the practice agents (environment id, agent id, name, address, the
 * lab it was built for, and which stages of the walkthrough are done); `changes` hold what was done inside them, in order;
 * `pending` holds a create that was started and not yet written down, so a second agent is never made by mistake.
 */
export function createPracticeRegistry(home, { now = () => Date.now() } = {}) {
  const file = practiceRegistryPath(home);
  const iso = () => new Date(now()).toISOString();
  const load = () => {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      return data && Array.isArray(data.agents) ? { ...emptyRegistry(), ...data, pending: Array.isArray(data.pending) ? data.pending : [] } : emptyRegistry();
    } catch {
      return emptyRegistry();
    }
  };
  const save = (data) => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  };
  const live = (a) => !a.retired && isPracticeName(a.name);
  return {
    file,
    load,
    /** What a job did in the practice environment (in memory, for the job's report): the agent made or reused, and each change. */
    jobLog: [],
    /**
     * The practice agent for an environment, or null. Only an agent whose name has the prefix counts, and one that was
     * retired by "Start fresh" does not. With a `key` (the lab it was built for) only that lab's agent matches.
     */
    find(envId, key) {
      return load().agents.find((a) => a.envId === envId && live(a) && (key === undefined || (a.key || "shared") === key)) || null;
    },
    /** Remember a created practice agent. A second record for the same environment and lab replaces the first. `accountId` is the sign-in marker it was made under (see `agentAccountState`). */
    recordAgent({ envId, botId, name, address, key = "shared", accountId = null }) {
      const data = load();
      data.agents = data.agents.filter((a) => !(a.envId === envId && (a.key || "shared") === key && !a.retired));
      data.agents.push({ envId, botId, name, address, key, ...(accountId ? { accountId } : {}), createdAt: iso(), reusedCount: 0, stages: {} });
      data.pending = data.pending.filter((p) => !(p.envId === envId && p.key === key));
      save(data);
      this.jobLog.push({ kind: "agent", name, what: `Created the practice agent “${name}”`, reused: false });
    },
    recordReuse(envId, key, { accountId = null } = {}) {
      const data = load();
      const found = data.agents.find((a) => a.envId === envId && live(a) && (key === undefined || (a.key || "shared") === key));
      if (found) {
        found.reusedCount = (found.reusedCount || 0) + 1;
        found.lastUsedAt = iso();
        // An agent recorded before sign-in markers existed is tied to the sign-in that reuses it first.
        if (accountId && !found.accountId) found.accountId = accountId;
        save(data);
        this.jobLog.push({ kind: "agent", name: found.name, what: `Reused the practice agent “${found.name}”`, reused: true });
      }
    },
    /** A create is about to be clicked. Written first, so a crash between the click and the next write cannot lead to a second agent. */
    markPending({ envId, key = "shared", name }) {
      const data = load();
      data.pending = data.pending.filter((p) => !(p.envId === envId && p.key === key));
      data.pending.push({ envId, key, name, at: iso() });
      save(data);
    },
    pending(envId, key = "shared") {
      return load().pending.find((p) => p.envId === envId && p.key === key) || null;
    },
    clearPending(envId, key = "shared") {
      const data = load();
      data.pending = data.pending.filter((p) => !(p.envId === envId && p.key === key));
      save(data);
    },
    /** "Start fresh": the next job makes a new practice agent. The old one is only set aside in this record; nothing is deleted. */
    retire(envId, key) {
      const data = load();
      let count = 0;
      for (const agent of data.agents) {
        if (agent.envId === envId && !agent.retired && (key === undefined || (agent.key || "shared") === key)) {
          agent.retired = true;
          agent.retiredAt = iso();
          count += 1;
        }
      }
      data.pending = data.pending.filter((p) => !(p.envId === envId && (key === undefined || p.key === key)));
      if (count || data.pending.length !== load().pending.length) save(data);
      return count;
    },
    /**
     * Which stages of the walkthrough are done on an agent (instructions set, knowledge added, published), remembered so a rerun skips them.
     * Only a stage that was marked after the product proved it (a saved check, `proof` 2) counts: earlier builds wrote a plain date for a
     * step that had only been tried, and that is not trusted any more.
     */
    stageDone(botId, stage) {
      const agent = load().agents.find((a) => a.botId === botId);
      return Number(agent?.stages?.[stage]?.proof) >= STAGE_PROOF;
    },
    markStage(botId, stage) {
      const data = load();
      const agent = data.agents.find((a) => a.botId === botId);
      if (!agent) return;
      agent.stages = { ...(agent.stages || {}), [stage]: { at: iso(), proof: STAGE_PROOF } };
      save(data);
    },
    /**
     * A step that must never be clicked twice on one agent (publishing). The claim is written before the click and is never undone, so a
     * crash, a slow confirmation, or a later run cannot lead to a second click: the permission is for this agent, once.
     * @returns {boolean} true only for the first claim.
     */
    claimOnce(botId, key) {
      const data = load();
      const agent = data.agents.find((a) => a.botId === botId);
      if (!agent || agent.once?.[key]) return false;
      agent.once = { ...(agent.once || {}), [key]: iso() };
      save(data);
      return true;
    },
    onceClaimed(botId, key) {
      return Boolean(load().agents.find((a) => a.botId === botId)?.once?.[key]);
    },
    /** Something done inside a practice agent (a step that saved, added, or published). */
    recordChange({ botId, what, shot }) {
      const data = load();
      data.changes.push({ botId, what: String(what || "").slice(0, 120), shot: String(shot || "").slice(0, 128), at: iso() });
      data.changes = data.changes.slice(-200);
      save(data);
      const agent = data.agents.find((a) => a.botId === botId);
      if (!/^Created the practice agent/.test(String(what || ""))) this.jobLog.push({ kind: "change", name: agent?.name || "", what: String(what || "").slice(0, 120), reused: false });
    },
    /**
     * What a recipe family did on a shot (it asked a question, opened a dialog, opened an item, added a test set), kept for the practice report so a
     * person can see what each recipe touched, and whether it is one that was not seen on a real tenant yet. Names and plain sentences only.
     */
    recordRecipe({ botId, family, key = "", shot = "", what = "", created = [], verified = true }) {
      const data = load();
      data.recipes = [...(Array.isArray(data.recipes) ? data.recipes : []), { botId, family: String(family || "").slice(0, 20), key: String(key || "").slice(0, 40), shot: String(shot || "").slice(0, 128), what: String(what || "").slice(0, 160), created: (Array.isArray(created) ? created : []).map((c) => String(c).slice(0, 40)).slice(0, 4), verified: verified !== false, at: iso() }].slice(-200);
      save(data);
    },
    items() {
      return load();
    },
  };
}

/**
 * The plain-language report of what the companion created, as Markdown. It names where each item is and what was
 * done in it, and says how to delete it: the companion never does.
 */
export function buildPracticeReport(registry, { jobCreated = [], now = () => new Date() } = {}) {
  const lines = [
    "# Practice agent report",
    "",
    `Written ${now().toISOString()} by the Local Capture Companion.`,
    "",
    "The companion created the items below so it could take screenshots that need an agent in a certain state. It never deletes anything, not even its own practice agent. When you no longer need them, delete them yourself in Copilot Studio.",
    "",
  ];
  const agents = registry.agents || [];
  if (!agents.length) lines.push("No practice agent has been created.", "");
  for (const agent of agents) {
    lines.push(`## ${agent.name}${agent.retired ? " (set aside by Start fresh)" : ""}`, "", `- Where: your practice environment in Copilot Studio`, `- Link: ${agent.address || "(not recorded)"}`, `- Created: ${agent.createdAt}`, `- Reused in later jobs: ${agent.reusedCount || 0} time${agent.reusedCount === 1 ? "" : "s"}`);
    const stages = Object.entries(agent.stages || {}).filter(([, value]) => Number(value?.proof) >= STAGE_PROOF);
    if (stages.length) lines.push(`- Steps of the lab walkthrough done on it: ${stages.map(([id]) => id).join(", ")}`);
    const changes = (registry.changes || []).filter((c) => c.botId === agent.botId);
    if (changes.length) {
      lines.push("- What the companion did inside it:");
      for (const change of changes.slice(-20)) lines.push(`  - ${change.what} (${change.at})`);
    } else {
      lines.push("- What the companion did inside it: nothing yet");
    }
    // The recipes that took the other screens (a question asked, a dialog opened and canceled, an item opened): what each one touched, and what it added.
    const recipes = (registry.recipes || []).filter((r) => r.botId === agent.botId);
    if (recipes.length) {
      lines.push("- What the screenshot recipes did (nothing is saved to the agent unless it says it created something):");
      for (const recipe of recipes.slice(-30)) {
        const made = recipe.created?.length ? ` Created: ${recipe.created.map((c) => OBJECT_NAMES[c] || c).join(", ")}.` : " Created nothing.";
        lines.push(`  - ${recipe.what || recipe.family} for ${recipe.shot || "a screenshot"}.${made}${recipe.verified === false ? " This recipe has not been seen working on a real tenant yet." : ""} (${recipe.at})`);
      }
    }
    lines.push("");
  }
  if (jobCreated.length) lines.push("## This job", "", ...jobCreated.map((item) => `- ${item.what}`), "");
  lines.push("To remove an agent: open its link, then use Delete in the agent's settings or in the Agents list. The companion never does this for you.", "To let the companion build a new practice agent next time without deleting the old one, choose Start fresh in the Screenshot Center.", "");
  return lines.join("\n");
}

/** Write the report next to the registry and return its path. */
export function writePracticeReport(home, registry, options = {}) {
  const file = practiceReportPath(home);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(file, buildPracticeReport(registry.items ? registry.items() : registry, options), { mode: 0o600 });
  return file;
}

/** What the portal is told about a job's practice work: names and what was done, never an address or an id. */
export function summarizeCreated(entries) {
  return (Array.isArray(entries) ? entries : []).slice(0, 20).map((e) => ({ kind: String(e.kind || "change").slice(0, 20), name: String(e.name || "").slice(0, 80), what: String(e.what || "").slice(0, 120), reused: e.reused === true }));
}

/** The practice environment's base address, or null when the address is not a Copilot Studio environment. */
export function practiceEnvironment(url) {
  const parsed = parseCopilotStudioAddress(url);
  return parsed.ok && parsed.envBase ? { envBase: parsed.envBase, envId: parsed.envId, origin: parsed.origin } : null;
}

/**
 * Find the practice agent for the job's practice environment, or make it. Everything here is a tier 2 action
 * that happens only in the practice environment, only for an agent whose name has the prefix, and only because the
 * job (and this companion) allowed it.
 * @returns {Promise<{ok: boolean, agentBase?: string, envBase?: string, botId?: string, name?: string, reused?: boolean, error?: string, cause?: string}>}
 */
export async function ensurePracticeAgent({ page, autonomy, registry, session, executorFor, go, trace = null, log = null, random }) {
  const env = practiceEnvironment(autonomy.practiceEnvironmentUrl);
  if (autonomy.maxTier < 2 || !env) return { ok: false, cause: "needs-practice-agent", error: "A practice agent is not allowed for this job." };
  if (session.practiceAgent?.envId === env.envId) return { ...session.practiceAgent, reused: true };
  // When the agent is handed over from the creation step (`agentSource: "created"`), a failure is remembered for the rest of the job: every later
  // shot that needs the agent gets the same plain reason, and the Create control is never clicked again and again.
  if (session.agentSource === "created" && session.practiceFailure?.envId === env.envId) return session.practiceFailure.result;
  const failed = (result) => {
    if (session.agentSource === "created") session.practiceFailure = { envId: env.envId, result };
    return result;
  };

  const existing = registry.find(env.envId);
  if (existing) {
    // An agent made while another account was signed in is not used, and nothing is made in its place.
    if (agentAccountState(existing, session.accountId) === "different") {
      trace?.event("practice-agent-account", { state: "different" });
      log?.("  The practice agent from an earlier job was made under a different sign-in, so it is not used.");
      return failed({ ok: false, cause: "agent-unavailable", error: AGENT_ACCOUNT_REASON });
    }
    const target = `${env.envBase}/bots/${existing.botId}/overview`;
    await go(target, "your practice agent");
    if (String(page.url()).includes(existing.botId)) {
      registry.recordReuse(env.envId, undefined, { accountId: session.accountId });
      session.practiceAgent = { ok: true, envBase: env.envBase, envId: env.envId, botId: existing.botId, agentBase: `${env.envBase}/bots/${existing.botId}`, name: existing.name, reused: true };
      trace?.event("practice-agent", { reused: true });
      log?.("  Reusing your practice agent.");
      return session.practiceAgent;
    }
    trace?.event("practice-agent-missing", {});
    log?.("  The practice agent from an earlier job could not be opened, so a new one will be created.");
  }

  const name = practiceName(random);
  await go(`${env.envBase}/agents`, "the list of agents in your practice environment");
  const practice = { agentId: null, creating: (url) => String(url || "").startsWith(env.envBase) };
  const executor = executorFor(practice);
  const result = await executor.run([
    { id: "create-open", action: "create", intent: "confirm", tier: 2, target: { role: "button", name: "Create blank agent", alt: ["Create agent", "New agent", "Create an agent"], within: "main" }, expect: { text: ["Name"] } },
    { id: "create-name", action: "type", intent: "type", tier: 2, target: { role: "textbox", name: "Name", alt: ["Agent name", "Name your agent"], within: "main" }, text: { literal: name } },
    { id: "create-confirm", action: "create", intent: "confirm", tier: 2, target: { role: "button", name: "Create", alt: ["Create agent"], within: "main" }, expect: { urlPath: "/bots/" } },
  ].map((s) => ({ ...s, note: s.id === "create-name" ? "Named the practice agent" : "Created the practice agent" })));
  if (!result.ok) return failed({ ok: false, cause: "automation-failed", error: `The practice agent could not be created (${result.failed?.why || "a step failed"}).`, setup: result });
  const created = parseCopilotStudioAddress(page.url());
  if (!created.botId) return failed({ ok: false, cause: "automation-failed", error: "The practice agent was created, but its address could not be read." });
  registry.recordAgent({ envId: env.envId, botId: created.botId, name, address: `${env.envBase}/bots/${created.botId}/overview`, accountId: session.accountId || null });
  registry.recordChange({ botId: created.botId, what: `Created the practice agent “${name}”`, shot: "" });
  session.practiceAgent = { ok: true, envBase: env.envBase, envId: env.envId, botId: created.botId, agentBase: `${env.envBase}/bots/${created.botId}`, name, reused: false };
  trace?.event("practice-agent", { reused: false });
  log?.(`  Created the practice agent “${name}”. It is listed in the report at the end of the job.`);
  return session.practiceAgent;
}
