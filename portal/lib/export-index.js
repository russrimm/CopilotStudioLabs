/**
 * The human index of a lab ZIP. Names inside the ZIP are short on purpose (see export-names.js), so this lists what every
 * file is: its full title, kind, format, module order, and estimated minutes. It is written twice: as a table in the
 * README.md at the top of the ZIP, and as the `index` array in export-manifest.json.
 */

const PICTURE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

function extensionOf(path) {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(path);
  return match ? match[1].toLowerCase() : "";
}

function baseName(path) {
  return String(path).split("/").pop();
}

function kindOfPath(path) {
  if (PICTURE_EXT.test(path)) return "Picture";
  const ext = extensionOf(path);
  if (ext === "json" || ext === "csv") return "Data";
  if (ext === "md" || ext === "txt") return "Notes";
  return "File";
}

/** One row per entry, in the order they were added. `export-manifest.json` is left out: it cannot list itself. */
export function buildIndexRows(entries) {
  return entries
    .filter((entry) => entry.path !== "export-manifest.json")
    .map((entry) => ({
      path: entry.path,
      title: entry.title || baseName(entry.path),
      kind: entry.kind || kindOfPath(entry.path),
      format: entry.format || extensionOf(entry.path) || null,
      moduleOrder: entry.order ?? null,
      stepLabel: entry.stepLabel || null,
      minutes: entry.minutes ?? null,
      // A lab that covers two harnesses: the harness (or part) the file is for. Absent for every other lab.
      ...(entry.harnessLabel ? { harness: entry.harnessLabel } : {}),
    }));
}

function cell(text) {
  return String(text ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * The "Contents" section of the README: the modules (folder, teaching label, full title, minutes, and the files in the
 * folder), then every other document with its full title. Pictures are counted, not listed one by one.
 */
export function renderContentsMarkdown(entries, { labFolder = "" } = {}) {
  const lines = ["## Contents", ""];
  lines.push("Folder and file names in this package are short on purpose, so that it extracts on Windows. Every document keeps its full title inside. This list gives the full title of each one.", "");

  const modules = new Map();
  for (const entry of entries) {
    if (entry.group !== "module") continue;
    const key = entry.folder || String(entry.order);
    if (!modules.has(key)) modules.set(key, { folder: entry.folder, order: entry.order, stepLabel: entry.stepLabel, title: entry.moduleTitle, minutes: entry.minutes, harness: entry.harnessLabel || "", files: [], samples: [] });
    const row = modules.get(key);
    if (entry.kind === "Sample file") row.samples.push(baseName(entry.path));
    else row.files.push(baseName(entry.path));
  }
  if (modules.size) {
    const withHarness = [...modules.values()].some((mod) => mod.harness);
    lines.push("### Modules", "", withHarness ? "| Folder | Step | Harness | Full title | Minutes | Files |" : "| Folder | Step | Full title | Minutes | Files |", withHarness ? "|---|---|---|---|---|---|" : "|---|---|---|---|---|");
    for (const mod of [...modules.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
      const files = [...mod.files.map((name) => `\`${name}\``), mod.samples.length ? `\`sample-files/\`: ${mod.samples.map((name) => `\`${name}\``).join(", ")}` : null].filter(Boolean).join("; ");
      lines.push(`| \`${cell(mod.folder)}/\` | ${cell(mod.stepLabel || "")} | ${withHarness ? `${cell(mod.harness)} | ` : ""}${cell(mod.title || "")} | ${mod.minutes ? `about ${mod.minutes}` : ""} | ${files} |`);
    }
    lines.push("");
  }

  const others = entries.filter((entry) => entry.group && entry.group !== "module" && entry.group !== "picture" && entry.path !== "README.md");
  if (others.length) {
    const withHarness = others.some((entry) => entry.harnessLabel);
    lines.push("### Other files", "", withHarness ? "| File | What it is | Harness | Full title | Minutes |" : "| File | What it is | Full title | Minutes |", withHarness ? "|---|---|---|---|---|" : "|---|---|---|---|");
    for (const entry of others) {
      lines.push(`| \`${cell(entry.path)}\` | ${cell(entry.kind || kindOfPath(entry.path))} | ${withHarness ? `${cell(entry.harnessLabel || "")} | ` : ""}${cell(entry.title || baseName(entry.path))} | ${entry.minutes ? `about ${entry.minutes}` : ""} |`);
    }
    lines.push("");
  }

  const pictures = entries.filter((entry) => entry.group === "picture").length;
  if (pictures) lines.push(`${labFolder ? `\`${labFolder}/assets/\`` : "`assets/`"} holds the ${pictures} picture${pictures === 1 ? "" : "s"} the guide uses. \`export-manifest.json\` lists every file in the package under \`index\`.`, "");
  else lines.push("`export-manifest.json` lists every file in the package under `index`.", "");
  return lines.join("\n");
}
