// Shared helpers for the monthly lab-accuracy automation.
// Discovers every labs/NN-* folder, parses its index.md metadata table,
// reference links (Microsoft Learn and third-party), screenshot manifest, and
// start URL.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const repoRoot = path.resolve(__dirname, "..", "..", "..");
export const labsDir = path.join(repoRoot, "labs");

export function getReportsDir() {
  return process.env.LAB_ACCURACY_OUT_DIR
    ? path.resolve(process.env.LAB_ACCURACY_OUT_DIR)
    : path.join(__dirname, "..", "out");
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export function toPosix(value) {
  return value.split(path.sep).join("/");
}

export function relativeToRoot(value) {
  return toPosix(path.relative(repoRoot, value));
}

/** Return sorted labs/NN-* directory names that contain an index.md. */
export function discoverLabs() {
  if (!fs.existsSync(labsDir)) return [];
  return fs
    .readdirSync(labsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{2}-/.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(labsDir, name, "index.md")))
    .sort();
}

/** Extract the H1 title from a lab's index.md. */
function parseTitle(markdown) {
  const match = markdown.match(/^#\s+(.+?)\s*$/m);
  return match ? match[1].replace(/[*`]/g, "").trim() : null;
}

/** Pull the value cell from a metadata row like `| 🧩 **PRODUCTS** | ... |`. */
function parseMetadataRow(markdown, label) {
  const re = new RegExp(`\\*\\*${label}\\*\\*\\s*\\|\\s*([^|\\n]+)`, "i");
  const match = markdown.match(re);
  return match ? match[1].trim() : null;
}

function splitList(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.replace(/`/g, "").trim())
    .filter(Boolean);
}

/**
 * Hosts whose links count as first-party documentation. Only these gate pull
 * requests, and only these feed the Learn drift check.
 */
export const FIRST_PARTY_HOSTS = Object.freeze(["learn.microsoft.com"]);

/**
 * The Markdown a reader sees as prose: fenced code blocks and inline code spans
 * are blanked, so a URL that is a value to type (a redirect URI, an API
 * endpoint, `http://localhost:5173`) is never mistaken for a reference.
 */
function proseOnly(markdown) {
  const out = [];
  let fence = null;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && /^\s*[`~]+\s*$/.test(line)) {
        fence = null;
      }
      out.push("");
      continue;
    }
    if (marker) {
      fence = marker[1];
      out.push("");
      continue;
    }
    out.push(line.replace(/(`+)[^`]*?\1/g, " "));
  }
  return out.join("\n");
}

function trimUrl(url) {
  return url.replace(/[).,;:!?'"*_]+$/, "");
}

/**
 * Collect every unique reference link a reader can follow in a lab, tagged as
 * first-party (Microsoft Learn) or third-party (everything else).
 *
 * A reference is an inline link, an autolink, a reference definition, an HTML
 * `href`, or a bare URL — all outside code. Image sources are not references.
 *
 * @returns {Array<{url:string, host:string, party:"first"|"third"}>} sorted by url
 */
export function parseReferenceLinks(markdown) {
  let text = proseOnly(String(markdown || "")).replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, " ");
  const found = [];
  const take = (re) => {
    text = text.replace(re, (match, url) => {
      found.push(url);
      return match.startsWith("]") ? "]( )" : " ";
    });
  };
  take(/\]\(\s*<?(https?:\/\/[^\s)>]+)[^)\n]*\)/gi);
  take(/^ {0,3}\[[^\]\n]+\]:\s*<?(https?:\/\/[^\s>]+)>?/gim);
  take(/href\s*=\s*"(https?:\/\/[^"\s]+)"/gi);
  take(/<(https?:\/\/[^>\s]+)>/gi);
  take(/(https?:\/\/[^\s<>()[\]"'`]+)/gi);

  const links = new Map();
  for (const raw of found) {
    const url = trimUrl(raw);
    if (links.has(url)) continue;
    let host;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    links.set(url, { url, host, party: FIRST_PARTY_HOSTS.includes(host) ? "first" : "third" });
  }
  return [...links.values()].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

/** Collect markdown image references (lab screenshots). */
function parseImages(markdown, labDir) {
  const images = [];
  const imageRe = /!\[[^\]]*\]\(([^)\s]+)/g;
  let match;
  while ((match = imageRe.exec(markdown)) !== null) {
    let target = match[1].trim();
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue;
    const noQuery = target.split("#")[0].split("?")[0];
    const ext = path.extname(noQuery).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) continue;
    let decoded = noQuery;
    try {
      decoded = decodeURIComponent(noQuery);
    } catch {
      /* keep raw */
    }
    images.push(relativeToRoot(path.resolve(labDir, decoded)));
  }
  return [...new Set(images)].sort();
}

/** Read a lab's shots.json manifest if present.
 *  Looks first at labs/<name>/shots.json, then falls back to the shared
 *  tools/screenshot-capture/shots.json when its `lab` field matches. */
function parseShots(labDir, name) {
  const candidates = [
    path.join(labDir, "shots.json"),
    path.join(repoRoot, "tools", "screenshot-capture", "shots.json"),
  ];
  for (const shotsPath of candidates) {
    if (!fs.existsSync(shotsPath)) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(shotsPath, "utf8"));
    } catch (error) {
      return { path: relativeToRoot(shotsPath), error: error.message, shots: [] };
    }
    const isLabDirManifest = shotsPath.startsWith(labDir + path.sep);
    if (!isLabDirManifest && parsed.lab !== name) continue;
    return {
      path: relativeToRoot(shotsPath),
      startUrl: typeof parsed.startUrl === "string" ? parsed.startUrl : null,
      shots: Array.isArray(parsed.shots) ? parsed.shots : [],
    };
  }
  return null;
}

/** Build a structured model for a single lab. */
export function loadLab(name) {
  const labDir = path.join(labsDir, name);
  const indexPath = path.join(labDir, "index.md");
  const markdown = fs.readFileSync(indexPath, "utf8");
  const referenceLinks = parseReferenceLinks(markdown);
  return {
    name,
    dir: relativeToRoot(labDir),
    indexPath: relativeToRoot(indexPath),
    title: parseTitle(markdown),
    products: splitList(parseMetadataRow(markdown, "PRODUCTS")),
    tags: splitList(parseMetadataRow(markdown, "TAGS")),
    referenceLinks,
    learnLinks: referenceLinks.filter((link) => link.party === "first").map((link) => link.url),
    images: parseImages(markdown, labDir),
    shots: parseShots(labDir, name),
  };
}

export function loadAllLabs() {
  return discoverLabs().map(loadLab);
}

/** Write a JSON artifact to the lab-accuracy output dir. */
export function writeReport(filename, data) {
  const outDir = getReportsDir();
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, filename);
  fs.writeFileSync(target, JSON.stringify(data, null, 2));
  return target;
}

/** Read a previously written JSON artifact, or null if missing. */
export function readReport(filename) {
  const target = path.join(getReportsDir(), filename);
  if (!fs.existsSync(target)) return null;
  try {
    return JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    return null;
  }
}
