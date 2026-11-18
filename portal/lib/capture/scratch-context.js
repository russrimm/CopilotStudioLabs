/**
 * What a generated lab says about the agent it builds, for "Build the agent from scratch": the agent's short name, the
 * lab's own description and instructions text, its sample questions, and a public website taken from the lab's Microsoft
 * Learn links. The companion types these into the practice agent, so each one is checked again before it is used
 * (see `sanitizeScratchContext`): nothing here is read from the product, and nothing is a file upload.
 */

import fs from "node:fs";
import path from "node:path";

import { checkPublicWebsite } from "../../../tools/screenshot-capture/guard.mjs";
import { sanitizeScratchContext, scratchAgentName, scratchKey } from "../../../tools/screenshot-capture/walkthrough.mjs";

const MAX_LAB_BYTES = 3 * 1024 * 1024;

function readText(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size <= MAX_LAB_BYTES ? fs.readFileSync(file, "utf8") : "";
  } catch {
    return "";
  }
}

function readJson(file) {
  try {
    return JSON.parse(readText(file) || "null");
  } catch {
    return null;
  }
}

/** The "Sample input" blocks of a lab's Markdown, each with the sentence that introduces it. */
export function sampleInputsFromMarkdown(markdown) {
  const out = [];
  const re = /\*\*Sample input\.\*\*([^\n]*)\n+```text\n([\s\S]*?)```/g;
  for (const match of String(markdown || "").matchAll(re)) out.push({ label: match[1].trim(), text: match[2].trim() });
  return out;
}

/** The questions the finished agent should answer, as the lab's Scenario section lists them. */
export function scenarioQuestions(markdown) {
  const at = String(markdown || "").indexOf("**Questions the finished agent should answer**");
  if (at < 0) return [];
  const block = String(markdown).slice(at, at + 1200).split("\n").slice(1);
  const questions = [];
  for (const line of block) {
    const item = line.match(/^\s*-\s*[“"]([^”"]{6,200})[”"]\s*$/);
    if (item) questions.push(item[1].trim());
    else if (questions.length && !line.trim().startsWith("-")) break;
  }
  return questions;
}

/** The first Microsoft Learn address a knowledge module of the lab lists, when it is a safe public website. */
export function knowledgeWebsite(manifest) {
  const modules = Array.isArray(manifest?.modules) ? manifest.modules : [];
  const ordered = [...modules.filter((m) => /knowledge/i.test(String(m?.id || ""))), ...modules];
  for (const mod of ordered) {
    for (const source of Array.isArray(mod?.sources) ? mod.sources : []) {
      const checked = checkPublicWebsite(source?.url || source?.finalUrl);
      if (checked.ok) return checked.url;
    }
  }
  return "";
}

/**
 * The context of a lab, ready for a job. Without a lab (a shared-library job) the agent is a plain training agent.
 * @param {string|null} labDir the generated lab's folder
 */
export function readLabScratchContext(labDir, { labId = "", title = "" } = {}) {
  const markdown = labDir ? readText(path.join(labDir, "index.md")) : "";
  const manifest = labDir ? readJson(path.join(labDir, "manifest.json")) : null;
  const built = String(markdown).match(/\byou build \*\*([^*]{2,60})\*\*/);
  const shortTitle = String(manifest?.options?.agentName || built?.[1] || title || manifest?.title || "").trim();
  const samples = sampleInputsFromMarkdown(markdown);
  const pick = (re) => samples.find((s) => re.test(s.label))?.text || "";
  const questions = scenarioQuestions(markdown);
  const raw = {
    key: scratchKey(labId || "shared"),
    labTitle: title || manifest?.title || "",
    shortTitle,
    agentName: scratchAgentName(shortTitle),
    description: pick(/describe/i),
    instructions: pick(/instruction/i),
    questions,
    website: knowledgeWebsite(manifest),
    sharepointUrl: typeof manifest?.sharepointSite === "string" ? manifest.sharepointSite : manifest?.sharepointSite?.url || "",
  };
  return sanitizeScratchContext(raw);
}
