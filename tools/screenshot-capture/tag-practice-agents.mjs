#!/usr/bin/env node
// Record which harness the OLDER practice agents were built for. Practice agents made before harnesses were recorded (their names start with
// "Lab screenshots") have no harness in the companion's practice list (.practice-agents.json), so the companion never reuses them for a
// harness-specific picture. The owner confirms those agents are Microsoft Copilot harness agents; this tool writes that down.
//
//   node tools/screenshot-capture/tag-practice-agents.mjs --dry-run --home=<companion home>
//                         list the entries that would be tagged; change nothing (the default)
//   node tools/screenshot-capture/tag-practice-agents.mjs --apply --i-confirm-microsoft-copilot --home=<companion home>
//                         tag them (a separate, deliberate step)
//   --name-prefix='Lab screenshots'    which agents (default: names that start with "Lab screenshots")
//   --json                             the result as JSON
//
// --home is the companion's data folder (the folder that holds .companion.json); without it the default local folder is used, the same one the
// companion uses (COMPANION_HOME is honored). The resolved file is printed first.
//
// With --apply, the file is first copied to .practice-agents.json.bak-<yyyymmddhhmmss> (UTC) beside it and the copy is read back and compared; if it
// cannot be written and read back identical, nothing else happens. Then only the entries whose name starts with the prefix and that have NO harness
// recorded get harness "microsoft-copilot". An entry that already has a harness is never touched, and neither is one whose name says it was built for
// another harness ("Classic shots - ..."). The file is written atomically. Close the companion first, so it does not write the file at the same time.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { MICROSOFT_COPILOT, harnessOfPracticeName, isSpecificHarness, normalizeHarness } from "./harness.mjs";
import { resolveHome } from "./home.mjs";

/** The file name of the companion's practice registry (the same as `practiceRegistryPath` in practice.mjs). */
export const REGISTRY_NAME = ".practice-agents.json";
export const DEFAULT_NAME_PREFIX = "Lab screenshots";
export const CONFIRM_FLAG = "--i-confirm-microsoft-copilot";

export const CONFIRM_MESSAGE = `Refusing to change anything: --apply needs ${CONFIRM_FLAG}. It says you confirm that the practice agents whose names start with the prefix are Microsoft Copilot harness agents. Run with --dry-run first to see which entries would be tagged.`;

const stampOf = (date) => date.toISOString().replace(/[-:T]/g, "").slice(0, 14);

/**
 * Which entries of a practice registry would be tagged, and which are left alone and why. Pure: reads nothing, changes nothing.
 * An entry is tagged only when its name starts with `namePrefix`, it has no harness recorded, and its name does not say it was built for another harness.
 * @param {{agents?: object[]}} registry
 * @param {{namePrefix?: string}} [options]
 * @returns {{tag: Array<{index: number, name: string, retired: boolean}>, skipped: Array<{index: number, name: string, why: string}>, total: number}}
 */
export function planTagging(registry, { namePrefix = DEFAULT_NAME_PREFIX } = {}) {
  const prefix = String(namePrefix ?? "");
  const agents = Array.isArray(registry?.agents) ? registry.agents : [];
  const tag = [];
  const skipped = [];
  agents.forEach((agent, index) => {
    const name = String(agent?.name ?? "");
    if (!prefix || !name.startsWith(prefix)) return;
    if (isSpecificHarness(agent?.harness)) {
      skipped.push({ index, name, why: `already has a harness recorded (${normalizeHarness(agent.harness)})` });
    } else if (harnessOfPracticeName(name)) {
      skipped.push({ index, name, why: "its name says it was built for a specific harness" });
    } else {
      tag.push({ index, name, retired: agent?.retired === true });
    }
  });
  return { tag, skipped, total: agents.length };
}

/**
 * Show or apply the tagging for one companion data folder.
 * @param {object} input
 * @param {string} input.home the companion's data folder
 * @param {string} [input.namePrefix]
 * @param {boolean} [input.apply] false (the default) changes nothing
 * @param {boolean} [input.confirmMicrosoftCopilot] required with `apply`
 * @param {() => Date} [input.now]
 * @returns {{ok: boolean, mode: "dry-run"|"apply", file: string, code?: string, message: string, tag: object[], skipped: object[], total: number, changed: object[], backup: string|null}}
 */
export function tagPracticeAgents({ home, namePrefix = DEFAULT_NAME_PREFIX, apply = false, confirmMicrosoftCopilot = false, now = () => new Date() } = {}) {
  const file = path.join(path.resolve(String(home || "")), REGISTRY_NAME);
  const base = { mode: apply ? "apply" : "dry-run", file, tag: [], skipped: [], total: 0, changed: [], backup: null };
  const refuse = (code, message) => ({ ...base, ok: false, code, message });
  if (!String(home || "").trim()) return refuse("no-home", "No companion data folder was given.");
  if (!String(namePrefix || "").trim()) return refuse("no-prefix", "A name prefix is needed: without one every practice agent would match.");
  if (apply && confirmMicrosoftCopilot !== true) return refuse("confirmation-required", CONFIRM_MESSAGE);

  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch (err) {
    return refuse("no-registry", err.code === "ENOENT" ? `There is no practice agent list at ${file}. Nothing to tag.` : `The practice agent list could not be read (${err.message}).`);
  }
  let registry;
  try {
    registry = JSON.parse(raw.toString("utf8"));
  } catch {
    return refuse("damaged-registry", `The practice agent list at ${file} is not valid JSON, so nothing was changed.`);
  }
  if (!registry || typeof registry !== "object" || Array.isArray(registry) || !Array.isArray(registry.agents)) {
    return refuse("damaged-registry", `The practice agent list at ${file} has no list of agents, so nothing was changed.`);
  }

  const plan = planTagging(registry, { namePrefix });
  const found = { ...base, tag: plan.tag, skipped: plan.skipped, total: plan.total };
  if (!apply) {
    return { ...found, ok: true, message: plan.tag.length ? `${plan.tag.length} of ${plan.total} entries would be tagged as Microsoft Copilot harness agents. Nothing was changed.` : `No entries need tagging (${plan.total} in the list). Nothing was changed.` };
  }
  if (!plan.tag.length) return { ...found, ok: true, message: `No entries need tagging (${plan.total} in the list). Nothing was changed.` };

  // The backup first: written beside the file, never over an existing one, and read back identical before anything is changed.
  const backup = `${file}.bak-${stampOf(now())}`;
  try {
    fs.writeFileSync(backup, raw, { flag: "wx", mode: 0o600 });
    if (!fs.readFileSync(backup).equals(raw)) throw new Error("the copy does not match the original");
  } catch (err) {
    return { ...found, ok: false, code: "backup-failed", message: `The backup ${backup} could not be written and read back identical (${err.message}), so nothing was changed.` };
  }

  for (const entry of plan.tag) registry.agents[entry.index].harness = MICROSOFT_COPILOT;
  const temp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    return { ...found, ok: false, code: "write-failed", backup, message: `The practice agent list could not be written (${err.message}). The backup is at ${backup}; the list was not changed.` };
  }
  return { ...found, ok: true, backup, changed: plan.tag, message: `Tagged ${plan.tag.length} of ${plan.total} entries as Microsoft Copilot harness agents. The list as it was is saved at ${backup}.` };
}

/** The plain lines a person reads for a result. */
export function describeResult(result) {
  const lines = [`Practice agent list: ${result.file}`, result.message];
  const listed = result.mode === "apply" && result.ok ? result.changed : result.tag;
  for (const entry of listed) lines.push(`- ${result.mode === "apply" && result.ok ? "Tagged" : "Would tag"}: ${entry.name}${entry.retired ? " (retired)" : ""}`);
  for (const entry of result.skipped) lines.push(`- Left alone: ${entry.name}: ${entry.why}`);
  if (result.mode === "dry-run" && result.ok && result.tag.length) lines.push(`Run again with --apply ${CONFIRM_FLAG} to tag them. A backup is made first.`);
  return lines.join("\n");
}

function main(argv) {
  const flag = (name) => argv.includes(`--${name}`);
  const value = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
  if (flag("help") || flag("h") || (flag("apply") && flag("dry-run"))) {
    console.error(`Usage: node tools/screenshot-capture/tag-practice-agents.mjs [--dry-run | --apply ${CONFIRM_FLAG}] [--home=<companion home folder>] [--name-prefix='${DEFAULT_NAME_PREFIX}'] [--json]`);
    return flag("help") || flag("h") ? 0 : 2;
  }
  // Only a JSON file is read and written here, so the sync check the companion does for its browser profile is not needed.
  const resolved = resolveHome({ explicit: value("home") || "", envHome: process.env.COMPANION_HOME || "", allowSynced: true, detect: () => ({ synced: false, provider: null, why: null }) });
  const file = path.join(resolved.home, REGISTRY_NAME);
  if (!flag("json")) console.log(`Practice agent list: ${file}`);
  const result = tagPracticeAgents({ home: resolved.home, namePrefix: value("name-prefix") ?? DEFAULT_NAME_PREFIX, apply: flag("apply"), confirmMicrosoftCopilot: flag("i-confirm-microsoft-copilot") });
  if (flag("json")) {
    process.stdout.write(`${JSON.stringify({ mode: result.mode, ok: result.ok, code: result.code || null, file: result.file, message: result.message, backup: result.backup, total: result.total, tag: result.tag.map(({ name, retired }) => ({ name, retired })), skipped: result.skipped.map(({ name, why }) => ({ name, why })), changed: result.changed.map(({ name, retired }) => ({ name, retired })) }, null, 2)}\n`);
  } else {
    console.log(describeResult(result).split("\n").slice(1).join("\n"));
  }
  return result.ok ? 0 : 2;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exit(main(process.argv.slice(2)));
