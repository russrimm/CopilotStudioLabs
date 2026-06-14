#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const ORPHAN_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);
const EXCLUDED_DIRS = new Set(['node_modules', '.git', '.squad', '.auth']);
const args = process.argv.slice(2);
const emitJson = args.includes('--json');
const strict = args.includes('--strict');
const labArg = args.find((arg) => arg.startsWith('--lab='));
const scopedLab = labArg ? labArg.slice('--lab='.length) : null;

const report = {
  ok: true,
  strict,
  scopedLab,
  root: repoRoot,
  summary: { critical: 0, warning: 0, labs: 0, shotFiles: 0 },
  labs: {},
  shotFiles: []
};

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function relativeToRoot(value) {
  return toPosix(path.relative(repoRoot, value));
}

function ensureLab(lab) {
  const key = lab || 'repo';
  if (!report.labs[key]) {
    report.labs[key] = { findings: [], markdownImages: [], shotFiles: [], assetsDir: null };
  }
  return report.labs[key];
}

function addFinding(lab, severity, code, message, details = {}) {
  const finding = { severity, code, message, ...details };
  ensureLab(lab).findings.push(finding);
  report.summary[severity] += 1;
}

function walk(dir, predicate = () => true, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, predicate, results);
    } else if (predicate(fullPath, entry)) {
      results.push(fullPath);
    }
  }
  return results;
}

function findShotFiles() {
  const matches = new Set();
  const toolsDir = path.join(repoRoot, 'tools', 'screenshot-capture');
  const labsDir = path.join(repoRoot, 'labs');
  for (const file of walk(toolsDir, (fullPath) => path.basename(fullPath) === 'shots.json')) {
    matches.add(file);
  }
  for (const file of walk(labsDir, (fullPath) => path.basename(fullPath) === 'shots.json')) {
    matches.add(file);
  }
  return [...matches].sort();
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateShotFile(filePath) {
  const relPath = relativeToRoot(filePath);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    addFinding('repo', 'critical', 'shots-json-invalid-json', `${relPath} is not valid JSON.`, { file: relPath, error: error.message });
    return null;
  }

  const lab = typeof parsed.lab === 'string' ? parsed.lab : 'repo';
  const fileRecord = { file: relPath, lab, valid: true, shots: [] };
  report.shotFiles.push(fileRecord);
  ensureLab(lab).shotFiles.push(relPath);

  if (!isNonEmptyString(parsed.lab)) {
    fileRecord.valid = false;
    addFinding(lab, 'critical', 'shots-json-schema', `${relPath} must have top-level string key "lab".`, { file: relPath, key: 'lab' });
  }
  if (!isNonEmptyString(parsed.assetsDir) || path.isAbsolute(parsed.assetsDir)) {
    fileRecord.valid = false;
    addFinding(lab, 'critical', 'shots-json-schema', `${relPath} must have top-level relative string key "assetsDir".`, { file: relPath, key: 'assetsDir' });
  } else {
    ensureLab(lab).assetsDir = parsed.assetsDir;
  }
  if (!Array.isArray(parsed.shots)) {
    fileRecord.valid = false;
    addFinding(lab, 'critical', 'shots-json-schema', `${relPath} must have top-level array key "shots".`, { file: relPath, key: 'shots' });
    return { filePath, relPath, lab, assetsDir: parsed.assetsDir, shots: [] };
  }

  const ids = new Set();
  const filenames = new Set();
  parsed.shots.forEach((shot, index) => {
    const shotLabel = `${relPath} shots[${index}]`;
    if (!shot || typeof shot !== 'object' || Array.isArray(shot)) {
      fileRecord.valid = false;
      addFinding(lab, 'critical', 'shots-json-schema', `${shotLabel} must be an object.`, { file: relPath, index });
      return;
    }

    if (typeof shot.id !== 'number' || !Number.isFinite(shot.id)) {
      fileRecord.valid = false;
      addFinding(lab, 'critical', 'shots-json-schema', `${shotLabel} must have numeric id.`, { file: relPath, index, key: 'id' });
    } else if (ids.has(shot.id)) {
      fileRecord.valid = false;
      addFinding(lab, 'critical', 'shots-json-duplicate-id', `${relPath} has duplicate shot id ${shot.id}.`, { file: relPath, id: shot.id });
    } else {
      ids.add(shot.id);
    }

    if (!isNonEmptyString(shot.filename) || !IMAGE_EXTENSIONS.has(path.extname(shot.filename).toLowerCase())) {
      fileRecord.valid = false;
      addFinding(lab, 'critical', 'shots-json-schema', `${shotLabel} must have an image filename ending in .png, .jpg, .jpeg, .gif, or .webp.`, { file: relPath, index, key: 'filename' });
    } else if (filenames.has(shot.filename)) {
      fileRecord.valid = false;
      addFinding(lab, 'critical', 'shots-json-duplicate-filename', `${relPath} has duplicate filename ${shot.filename}.`, { file: relPath, filename: shot.filename });
    } else {
      filenames.add(shot.filename);
    }

    if (!isNonEmptyString(shot.section)) {
      fileRecord.valid = false;
      addFinding(lab, 'critical', 'shots-json-schema', `${shotLabel} must have a non-empty section.`, { file: relPath, index, key: 'section' });
    }
    if (!Array.isArray(shot.instructions) || shot.instructions.length === 0 || shot.instructions.some((item) => !isNonEmptyString(item))) {
      fileRecord.valid = false;
      addFinding(lab, 'critical', 'shots-json-schema', `${shotLabel} must have non-empty instructions strings.`, { file: relPath, index, key: 'instructions' });
    }

    fileRecord.shots.push({ id: shot.id, filename: shot.filename, section: shot.section });
  });

  return { filePath, relPath, lab: parsed.lab, assetsDir: parsed.assetsDir, shots: parsed.shots };
}

function parseMarkdownImages(indexPath) {
  if (!fs.existsSync(indexPath)) return [];
  const markdown = fs.readFileSync(indexPath, 'utf8');
  const images = [];
  const imageRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = imageRegex.exec(markdown)) !== null) {
    let target = match[1].trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    target = target.split(/\s+/)[0].replace(/^['"]|['"]$/g, '');
    if (!target || /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue;
    const noHash = target.split('#')[0].split('?')[0];
    const ext = path.extname(noHash).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) continue;
    let decoded = noHash;
    try {
      decoded = decodeURIComponent(noHash);
    } catch {
      // Keep the original path if it is not URI-encoded cleanly.
    }
    const diskPath = path.resolve(path.dirname(indexPath), decoded);
    const relativeFromLab = toPosix(path.relative(path.dirname(indexPath), diskPath));
    images.push({ markdownTarget: target, path: diskPath, relativeFromLab, filename: path.basename(decoded), line: lineForOffset(markdown, match.index) });
  }
  return images;
}

function lineForOffset(text, offset) {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function imageSignature(buffer, ext) {
  if (ext === '.png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (ext === '.jpg' || ext === '.jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (ext === '.gif') return buffer.length >= 6 && (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a');
  if (ext === '.webp') return buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

function validateMarkdownImage(lab, image) {
  const relPath = relativeToRoot(image.path);
  if (!fs.existsSync(image.path)) {
    addFinding(lab, 'critical', 'missing-image-file', `${image.markdownTarget} is referenced in ${lab}/index.md but ${relPath} does not exist.`, { path: relPath, markdownTarget: image.markdownTarget, line: image.line });
    return;
  }

  const stat = fs.statSync(image.path);
  if (stat.size === 0) {
    addFinding(lab, 'critical', 'zero-byte-image', `${relPath} is zero bytes.`, { path: relPath, line: image.line });
    return;
  }

  const header = Buffer.alloc(Math.min(12, stat.size));
  const fd = fs.openSync(image.path, 'r');
  try {
    fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }

  const ext = path.extname(image.path).toLowerCase();
  if (!imageSignature(header, ext)) {
    addFinding(lab, 'critical', 'invalid-image-signature', `${relPath} does not have a valid ${ext.slice(1).toUpperCase()} signature.`, { path: relPath, line: image.line });
  }

  // TODO: Add image fingerprinting for known placeholder pixel hashes if drift recurs.
  if (ext === '.png' && stat.size <= 2048) {
    addFinding(lab, 'warning', 'tiny-suspect-placeholder', `${relPath} is ${stat.size} bytes; real Copilot Studio screenshots are usually much larger.`, { path: relPath, bytes: stat.size, line: image.line });
  }
}

function listLabs() {
  const labsDir = path.join(repoRoot, 'labs');
  if (!fs.existsSync(labsDir)) return [];
  return fs.readdirSync(labsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((lab) => !scopedLab || lab === scopedLab)
    .sort();
}

function listAssetImages(lab) {
  const assetsDir = path.join(repoRoot, 'labs', lab, 'assets');
  return walk(assetsDir, (fullPath) => ORPHAN_EXTENSIONS.has(path.extname(fullPath).toLowerCase()))
    .sort();
}

const shotFiles = findShotFiles().filter((file) => {
  if (!scopedLab) return true;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed.lab === scopedLab || file.includes(`${path.sep}labs${path.sep}${scopedLab}${path.sep}`);
  } catch {
    return file.includes(`${path.sep}labs${path.sep}${scopedLab}${path.sep}`);
  }
});
const shotCatalogs = shotFiles.map(validateShotFile).filter(Boolean);
report.summary.shotFiles = report.shotFiles.length;
const catalogsByLab = new Map();
for (const catalog of shotCatalogs) {
  if (!catalog.lab) continue;
  if (!catalogsByLab.has(catalog.lab)) catalogsByLab.set(catalog.lab, []);
  catalogsByLab.get(catalog.lab).push(catalog);
}

for (const lab of listLabs()) {
  const labRecord = ensureLab(lab);
  const indexPath = path.join(repoRoot, 'labs', lab, 'index.md');
  const images = parseMarkdownImages(indexPath);
  labRecord.markdownImages = images.map((image) => ({ path: image.relativeFromLab, filename: image.filename, line: image.line }));
  for (const image of images) validateMarkdownImage(lab, image);

  const referencedPaths = new Set(images.map((image) => image.relativeFromLab));
  for (const assetPath of listAssetImages(lab)) {
    const relativeFromLab = toPosix(path.relative(path.join(repoRoot, 'labs', lab), assetPath));
    if (!referencedPaths.has(relativeFromLab)) {
      addFinding(lab, 'warning', 'orphan-asset', `${relativeToRoot(assetPath)} is under the lab assets folder but is not referenced by index.md.`, { path: relativeToRoot(assetPath) });
    }
  }
}

for (const [lab, catalogs] of catalogsByLab.entries()) {
  if (scopedLab && lab !== scopedLab) continue;
  const indexPath = path.join(repoRoot, 'labs', lab, 'index.md');
  if (!fs.existsSync(indexPath)) {
    addFinding(lab, 'critical', 'missing-lab-index', `shots.json declares lab ${lab}, but labs/${lab}/index.md does not exist.`, { lab });
    continue;
  }
  const images = parseMarkdownImages(indexPath);
  const markdownFilenames = new Set(images.map((image) => image.filename));
  const allShotFilenames = new Set();
  for (const catalog of catalogs) {
    for (const shot of Array.isArray(catalog.shots) ? catalog.shots : []) {
      if (isNonEmptyString(shot.filename)) allShotFilenames.add(shot.filename);
    }
  }

  for (const image of images) {
    if (!allShotFilenames.has(image.filename)) {
      addFinding(lab, 'critical', 'markdown-image-not-in-shots', `${image.filename} is referenced in index.md but has no matching shots.json entry.`, { filename: image.filename, line: image.line });
    }
  }
  for (const filename of allShotFilenames) {
    if (!markdownFilenames.has(filename)) {
      addFinding(lab, 'critical', 'shot-not-in-markdown', `${filename} is listed in shots.json but is not referenced by labs/${lab}/index.md.`, { filename });
    }
  }
}

report.summary.labs = Object.keys(report.labs).filter((lab) => lab !== 'repo').length;
report.ok = report.summary.critical === 0 && (!strict || report.summary.warning === 0);

if (emitJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  printHumanReport();
}

process.exit(report.ok ? 0 : 1);

function printHumanReport() {
  console.log('Screenshot consistency report');
  console.log(`Root: ${repoRoot}`);
  console.log(`Mode: ${strict ? 'strict' : 'default'}${scopedLab ? `, lab=${scopedLab}` : ''}`);
  console.log(`Summary: ${report.summary.critical} critical, ${report.summary.warning} warnings, ${report.summary.shotFiles} shots.json file(s)`);
  const labs = Object.keys(report.labs).sort();
  if (labs.length === 0) {
    console.log('\nNo labs found.');
    return;
  }
  for (const lab of labs) {
    const labReport = report.labs[lab];
    const critical = labReport.findings.filter((finding) => finding.severity === 'critical').length;
    const warning = labReport.findings.filter((finding) => finding.severity === 'warning').length;
    console.log(`\n[${lab}] ${critical} critical, ${warning} warnings`);
    if (labReport.markdownImages.length > 0) console.log(`  markdown images: ${labReport.markdownImages.length}`);
    if (labReport.shotFiles.length > 0) console.log(`  shots.json: ${labReport.shotFiles.join(', ')}`);
    if (labReport.findings.length === 0) {
      console.log('  OK');
      continue;
    }
    for (const finding of labReport.findings) {
      const line = finding.line ? ` line ${finding.line}` : '';
      console.log(`  ${finding.severity.toUpperCase()} ${finding.code}${line}: ${finding.message}`);
    }
  }
}
