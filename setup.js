#!/usr/bin/env node

/**
 * Copilot Studio Labs — Template Setup Script
 *
 * Reads template.config.json and customizes the lab content:
 *   - Replaces organization names, industry, branding, and scenario references
 *   - Removes excluded labs from the file system and README
 *   - Updates the README lab table to reflect included labs only
 *
 * Usage:
 *   npm run setup                        # interactive mode (prompts for config)
 *   npm run setup -- --config my.json    # use a custom config file
 *   npm run setup -- --dry-run           # preview changes without writing
 */

import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from "fs";
import { join, resolve, relative } from "path";
import { createInterface } from "readline";

const ROOT = resolve(import.meta.dirname || ".");
const DEFAULT_CONFIG = join(ROOT, "template.config.json");

// ── Defaults (the "original" values baked into the template) ────────────────
const DEFAULTS = {
  orgName: "SDG&E",
  orgFullName: "San Diego Gas & Electric",
  parent: "Sempra",
  industry: "Energy / Utilities",
  tagline: "Delivering energy with purpose — powered by AI",
  agentName: "IT Operations Agent",
  endUsers: "field technicians",
  compliance: "NERC CIP",
};

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const configIdx = args.indexOf("--config");
const configPath = configIdx >= 0 && args[configIdx + 1]
  ? resolve(args[configIdx + 1])
  : DEFAULT_CONFIG;

// ── Helpers ─────────────────────────────────────────────────────────────────
function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a.trim()); }));
}

function walkFiles(dir, extensions) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, extensions));
    } else if (!extensions || extensions.some((ext) => entry.name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

function replaceAll(content, searchValue, replaceValue) {
  if (!searchValue || searchValue === replaceValue) return content;
  return content.split(searchValue).join(replaceValue);
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n⚡ Copilot Studio Labs — Template Setup\n");

  // Load config
  if (!existsSync(configPath)) {
    console.error(`❌ Config file not found: ${configPath}`);
    console.error(`   Copy template.config.json and customize it, then re-run.`);
    process.exit(1);
  }

  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  const org = config.organization || {};
  const branding = config.branding || {};
  const scenario = config.scenario || {};
  const knowledge = config.knowledgeSources || {};
  const labConfig = config.labs || {};

  console.log(`📄 Config file:  ${relative(ROOT, configPath)}`);
  console.log(`🏢 Organization: ${org.name || DEFAULTS.orgName}`);
  console.log(`🏭 Industry:     ${org.industry || DEFAULTS.industry}`);
  console.log(`🤖 Agent:        ${scenario.agentName || DEFAULTS.agentName}`);
  console.log(`🧪 Labs:         ${(labConfig.include || []).length} included\n`);

  if (!dryRun) {
    const confirm = await ask("Proceed with customization? (y/N) ");
    if (confirm.toLowerCase() !== "y") {
      console.log("Aborted.");
      process.exit(0);
    }
  }

  // ── 1. Build replacement map ──────────────────────────────────────────────
  const replacements = [];

  if (org.name && org.name !== DEFAULTS.orgName) {
    replacements.push([DEFAULTS.orgName, org.name]);
  }
  if (org.fullName && org.fullName !== DEFAULTS.orgFullName) {
    replacements.push([DEFAULTS.orgFullName, org.fullName]);
  }
  if (org.parent && org.parent !== DEFAULTS.parent) {
    replacements.push([DEFAULTS.parent, org.parent]);
  }
  if (org.industry && org.industry !== DEFAULTS.industry) {
    replacements.push([DEFAULTS.industry, org.industry]);
  }
  if (branding.tagline && branding.tagline !== DEFAULTS.tagline) {
    replacements.push([DEFAULTS.tagline, branding.tagline]);
  }
  if (scenario.agentName && scenario.agentName !== DEFAULTS.agentName) {
    replacements.push([DEFAULTS.agentName, scenario.agentName]);
  }
  if (scenario.endUsers && scenario.endUsers !== DEFAULTS.endUsers) {
    replacements.push([DEFAULTS.endUsers, scenario.endUsers]);
  }
  if (knowledge.complianceStandard && knowledge.complianceStandard !== DEFAULTS.compliance) {
    replacements.push([DEFAULTS.compliance, knowledge.complianceStandard]);
  }

  // ── 2. Determine which labs to keep / remove ──────────────────────────────
  const labsDir = join(ROOT, "labs");
  const allLabs = existsSync(labsDir)
    ? readdirSync(labsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : [];

  const includedLabs = labConfig.include || allLabs;
  const excludedLabs = allLabs.filter((l) => !includedLabs.includes(l));

  // ── 3. Remove excluded labs ───────────────────────────────────────────────
  if (excludedLabs.length > 0) {
    console.log(`\n🗑️  Removing ${excludedLabs.length} excluded lab(s):`);
    for (const lab of excludedLabs) {
      const labPath = join(labsDir, lab);
      console.log(`   - ${lab}`);
      if (!dryRun) {
        rmSync(labPath, { recursive: true, force: true });
      }
    }
  }

  // ── 4. Apply text replacements to all Markdown files ──────────────────────
  const mdFiles = [
    ...walkFiles(join(ROOT, "labs"), [".md"]),
    join(ROOT, "README.md"),
  ].filter((f) => existsSync(f));

  let filesModified = 0;
  let totalReplacements = 0;

  if (replacements.length > 0) {
    console.log(`\n🔄 Applying ${replacements.length} text replacement(s) across ${mdFiles.length} file(s):\n`);
    for (const [from, to] of replacements) {
      console.log(`   "${from}" → "${to}"`);
    }
    console.log();

    for (const file of mdFiles) {
      let content = readFileSync(file, "utf-8");
      let original = content;

      for (const [from, to] of replacements) {
        content = replaceAll(content, from, to);
      }

      if (content !== original) {
        const relPath = relative(ROOT, file);
        const count = replacements.reduce((n, [from]) => {
          return n + (original.split(from).length - 1);
        }, 0);
        console.log(`   ✏️  ${relPath} (${count} replacement${count > 1 ? "s" : ""})`);
        filesModified++;
        totalReplacements += count;
        if (!dryRun) {
          writeFileSync(file, content, "utf-8");
        }
      }
    }
  }

  // ── 5. Update README lab table to remove excluded labs ────────────────────
  if (excludedLabs.length > 0) {
    const readmePath = join(ROOT, "README.md");
    if (existsSync(readmePath)) {
      let readme = readFileSync(readmePath, "utf-8");
      for (const lab of excludedLabs) {
        // Remove table rows referencing excluded labs
        const tableRowRegex = new RegExp(`^\\|[^|]*\\|[^|]*\\[.*?\\]\\(\\./labs/${lab}/.*?\\).*\\|$`, "gm");
        readme = readme.replace(tableRowRegex, "");

        // Remove standalone lab sections (## Lab XX — ... through next ---)
        const sectionRegex = new RegExp(
          `## Lab \\d+.*${lab.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&")}[\\s\\S]*?(?=\\n## |\\n---\\n|$)`,
          "g"
        );
        readme = readme.replace(sectionRegex, "");
      }

      // Clean up double blank lines
      readme = readme.replace(/\n{3,}/g, "\n\n");

      if (!dryRun) {
        writeFileSync(readmePath, readme, "utf-8");
      }
      console.log(`   ✏️  README.md (removed references to ${excludedLabs.length} excluded lab(s))`);
    }
  }

  // ── 6. Summary ────────────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(60));
  console.log(`✅ Setup complete${dryRun ? " (dry run — no files were modified)" : ""}!`);
  console.log(`   📝 ${filesModified} file(s) modified with ${totalReplacements} replacement(s)`);
  console.log(`   🗑️  ${excludedLabs.length} lab(s) excluded`);
  console.log(`   🧪 ${includedLabs.length} lab(s) included`);

  if (!dryRun) {
    console.log(`\n💡 Next steps:`);
    console.log(`   1. Review the changes: git diff`);
    console.log(`   2. Update screenshots if needed: cd tools/screenshot-capture && npm run capture`);
    console.log(`   3. Commit and push: git add -A && git commit -m "Customize labs for ${org.name || "my org"}"`);
  }
  console.log();
}

main().catch((err) => {
  console.error("❌ Setup failed:", err.message);
  process.exit(1);
});
