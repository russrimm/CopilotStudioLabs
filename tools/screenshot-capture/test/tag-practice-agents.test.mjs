// The practice registry tagging tool: the older practice agents ("Lab screenshots - ...") have no harness recorded, and the owner confirms they are Microsoft
// Copilot harness agents. A dry run changes nothing, --apply needs the confirmation flag, backs the file up first, tags only the entries that have no harness,
// and never touches one that already has one. Everything runs on a synthetic folder under the system temp folder.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIRM_FLAG, DEFAULT_NAME_PREFIX, REGISTRY_NAME, describeResult, planTagging, tagPracticeAgents } from "../tag-practice-agents.mjs";
import { practiceRegistryPath } from "../practice.mjs";

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tag-practice-agents.mjs");
const cleanups = [];
const tempHome = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tag-practice-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
after(() => cleanups.forEach((fn) => fn()));

const entry = (name, extra = {}) => ({ envId: "00000000-0000-0000-0000-000000000000", botId: `bot-${name.length}`, name, address: "https://example.invalid/agent", key: "shared", createdAt: "2026-11-01T10:00:00.000Z", reusedCount: 0, stages: {}, ...extra });
const REGISTRY = () => ({
  schema: 2,
  agents: [
    entry("Lab screenshots - aaaaaa"),
    entry("Lab screenshots - bbbbbb", { retired: true }),
    entry("Lab screenshots - cccccc", { harness: "standard" }),
    entry("Lab screenshots - dddddd", { harness: "microsoft-copilot" }),
    entry("Classic shots - eeeeee"),
    entry("Copilot shots - ffffff", { harness: "microsoft-copilot" }),
    entry("My own agent"),
  ],
  changes: [{ name: "Lab screenshots - aaaaaa", what: "kept as it is" }],
  pending: [{ envId: "x", key: "shared", name: "Lab screenshots - pending", at: "2026-11-01T10:00:00.000Z" }],
});
const write = (home, registry = REGISTRY()) => {
  const file = path.join(home, REGISTRY_NAME);
  fs.writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`);
  return file;
};
const backups = (home) => fs.readdirSync(home).filter((n) => n.startsWith(`${REGISTRY_NAME}.bak-`));

test("the file name is the one the companion's registry uses", () => {
  assert.equal(path.join("home", REGISTRY_NAME), practiceRegistryPath("home"));
  assert.equal(DEFAULT_NAME_PREFIX, "Lab screenshots");
});

test("planning tags only entries with the prefix and no harness, and says why it leaves the others", () => {
  const plan = planTagging(REGISTRY());
  assert.deepEqual(plan.tag.map((t) => t.name), ["Lab screenshots - aaaaaa", "Lab screenshots - bbbbbb"]);
  assert.deepEqual(plan.skipped.map((s) => [s.name, s.why]), [
    ["Lab screenshots - cccccc", "already has a harness recorded (standard)"],
    ["Lab screenshots - dddddd", "already has a harness recorded (microsoft-copilot)"],
  ]);
  assert.equal(plan.total, 7);
  assert.deepEqual(planTagging(REGISTRY(), { namePrefix: "" }).tag, [], "an empty prefix would match everything, so it matches nothing");
  const named = planTagging(REGISTRY(), { namePrefix: "Classic" });
  assert.deepEqual(named.tag, [], "an agent whose name says it was built for a harness is never tagged by a prefix");
  assert.equal(named.skipped[0].why, "its name says it was built for a specific harness");
});

test("a dry run lists what would be tagged and changes nothing", () => {
  const home = tempHome();
  const file = write(home);
  const before = fs.readFileSync(file);
  const result = tagPracticeAgents({ home });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "dry-run");
  assert.equal(result.file, file);
  assert.equal(result.tag.length, 2);
  assert.match(result.message, /2 of 7 entries would be tagged as Microsoft Copilot harness agents\. Nothing was changed\./);
  assert.deepEqual(fs.readFileSync(file), before, "the file is byte for byte the same");
  assert.deepEqual(fs.readdirSync(home), [REGISTRY_NAME], "no backup, no temp file");
  const lines = describeResult(result);
  assert.match(lines, /Would tag: Lab screenshots - aaaaaa/);
  assert.match(lines, /Would tag: Lab screenshots - bbbbbb \(retired\)/);
  assert.match(lines, /Left alone: Lab screenshots - cccccc: already has a harness recorded/);
  assert.match(lines, /--apply --i-confirm-microsoft-copilot/);
  assert.doesNotMatch(lines, /https:\/\//, "no agent address is printed");
});

test("--apply without the confirmation refuses and changes nothing", () => {
  const home = tempHome();
  const file = write(home);
  const before = fs.readFileSync(file);
  const result = tagPracticeAgents({ home, apply: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, "confirmation-required");
  assert.ok(result.message.includes(CONFIRM_FLAG));
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(backups(home), []);
});

test("--apply with the confirmation backs the file up first, tags only the entries with no harness, and leaves everything else as it was", () => {
  const home = tempHome();
  const file = write(home);
  const original = fs.readFileSync(file);
  const result = tagPracticeAgents({ home, apply: true, confirmMicrosoftCopilot: true, now: () => new Date("2026-11-26T18:56:23.000Z") });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.backup, `${file}.bak-20261126185623`);
  assert.deepEqual(fs.readFileSync(result.backup), original, "the backup is identical to the file as it was");
  assert.deepEqual(result.changed.map((c) => c.name), ["Lab screenshots - aaaaaa", "Lab screenshots - bbbbbb"]);

  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  const expected = REGISTRY();
  expected.agents[0].harness = "microsoft-copilot";
  expected.agents[1].harness = "microsoft-copilot";
  assert.deepEqual(after, expected, "only those two entries gained a harness; the agents that had one, the other names, the changes and pending lists are the same");
  assert.deepEqual(after.agents.map((a) => a.harness ?? null), ["microsoft-copilot", "microsoft-copilot", "standard", "microsoft-copilot", null, "microsoft-copilot", null]);
  assert.deepEqual(fs.readdirSync(home).sort(), [REGISTRY_NAME, path.basename(result.backup)].sort(), "no temp file is left");

  // Running it again has nothing to do, and makes no second backup.
  const again = tagPracticeAgents({ home, apply: true, confirmMicrosoftCopilot: true, now: () => new Date("2026-11-26T19:00:00.000Z") });
  assert.equal(again.ok, true);
  assert.equal(again.changed.length, 0);
  assert.equal(again.backup, null);
  assert.equal(backups(home).length, 1);
});

test("when the backup cannot be written, nothing is changed", () => {
  const home = tempHome();
  const file = write(home);
  const original = fs.readFileSync(file);
  fs.writeFileSync(`${file}.bak-20261126185623`, "an earlier backup made in the same second");
  const result = tagPracticeAgents({ home, apply: true, confirmMicrosoftCopilot: true, now: () => new Date("2026-11-26T18:56:23.000Z") });
  assert.equal(result.ok, false);
  assert.equal(result.code, "backup-failed");
  assert.deepEqual(fs.readFileSync(file), original, "the list is untouched");
  assert.equal(fs.readFileSync(`${file}.bak-20261126185623`, "utf8"), "an earlier backup made in the same second", "an existing backup is never overwritten");
});

test("a missing or damaged list is refused and never rewritten", () => {
  const empty = tempHome();
  const missing = tagPracticeAgents({ home: empty });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "no-registry");
  assert.deepEqual(fs.readdirSync(empty), []);

  const damaged = tempHome();
  const file = path.join(damaged, REGISTRY_NAME);
  fs.writeFileSync(file, "{ not json");
  const result = tagPracticeAgents({ home: damaged, apply: true, confirmMicrosoftCopilot: true });
  assert.equal(result.code, "damaged-registry");
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json");
  fs.writeFileSync(file, JSON.stringify({ schema: 2 }));
  assert.equal(tagPracticeAgents({ home: damaged }).code, "damaged-registry", "no list of agents");
  assert.deepEqual(fs.readdirSync(damaged), [REGISTRY_NAME]);
});

test("the command line prints the resolved file first, is a dry run by default, and --apply needs the confirmation flag", () => {
  const home = tempHome();
  const file = write(home);
  const before = fs.readFileSync(file);
  const run = (...args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8", env: { ...process.env, COMPANION_HOME: "" } });

  const dry = run("--dry-run", `--home=${home}`);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(dry.stdout.split(/\r?\n/)[0], `Practice agent list: ${file}`);
  assert.match(dry.stdout, /2 of 7 entries would be tagged/);
  const implicit = run(`--home=${home}`);
  assert.equal(implicit.status, 0);
  assert.match(implicit.stdout, /Nothing was changed/);
  assert.deepEqual(fs.readFileSync(file), before);

  const refused = run("--apply", `--home=${home}`);
  assert.equal(refused.status, 2);
  assert.match(refused.stdout, /Refusing to change anything: --apply needs --i-confirm-microsoft-copilot/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(run("--apply", "--dry-run", `--home=${home}`).status, 2, "the two choices exclude each other");

  const json = JSON.parse(run("--dry-run", "--json", `--home=${home}`).stdout);
  assert.deepEqual([json.mode, json.ok, json.tag.length], ["dry-run", true, 2]);

  const applied = run("--apply", CONFIRM_FLAG, `--home=${home}`);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /Tagged 2 of 7 entries as Microsoft Copilot harness agents/);
  assert.equal(backups(home).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).agents[0].harness, "microsoft-copilot");
});
