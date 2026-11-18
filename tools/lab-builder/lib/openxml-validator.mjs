/**
 * Helpers that build and run the Open XML SDK validator console project in
 * tools/lab-builder/oxml-validator. Requires the .NET SDK and NuGet access on the
 * first build; callers treat a missing SDK or a failed build as "skip".
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = fileURLToPath(new URL("../oxml-validator/", import.meta.url));

export function parseJsonLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Build the validator once into the OS temp dir.
 * @returns {{ dll: string } | { skip: string }}
 */
export function prepareOpenXmlValidator() {
  const version = spawnSync("dotnet", ["--version"], { encoding: "utf8" });
  if (version.error || version.status !== 0) return { skip: "the .NET SDK (dotnet) is not installed" };
  const outDir = join(tmpdir(), "lab-builder-oxml-validator");
  const dll = join(outDir, "OxmlValidator.dll");
  const sources = ["OxmlValidator.csproj", "Program.cs"].map((f) => join(PROJECT_DIR, f));
  const stale = !existsSync(dll) || sources.some((f) => statSync(f).mtimeMs > statSync(dll).mtimeMs);
  if (stale) {
    mkdirSync(outDir, { recursive: true });
    const build = spawnSync("dotnet", ["build", PROJECT_DIR, "-c", "Release", "-o", outDir, "--nologo", "-v", "q"], {
      encoding: "utf8",
    });
    if (build.status !== 0) {
      const tail = (build.stdout || build.stderr || "").trim().split("\n").slice(-6).join("\n");
      return { skip: `the Open XML validator project failed to build (offline NuGet?):\n${tail}` };
    }
  }
  return { dll };
}

/**
 * Validate files with the Open XML SDK.
 * @returns {Map<string, { file: string, opened: boolean, openError: string|null, errorCount: number, errors: object[] }>}
 */
export function runOpenXmlValidator(dll, files) {
  const results = new Map();
  for (let i = 0; i < files.length; i += 25) {
    const batch = files.slice(i, i + 25);
    const run = spawnSync("dotnet", [dll, ...batch], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    for (const row of parseJsonLines(run.stdout)) results.set(resolve(row.file), row);
  }
  return results;
}
