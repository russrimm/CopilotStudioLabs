/**
 * Lab step parser.
 *
 * Splits a lab's index.md into the individual steps a learner follows. Labs are
 * written in several shapes, so the parser tries them from most to least
 * specific and records which one matched (`source`):
 *
 *   step-headings      "### Step 2 — Classify connectors"
 *   numbered-headings  "### 1.1 Use natural language to create an agent"
 *   use-cases          "## 🧪 Use Case #3 — Add SharePoint metadata filters (10 min)"
 *   bold-numbered      "**2. Clone the starter template**" (inside a use case)
 *   none               no recognizable step structure; reported as `no-steps`,
 *                      never as a pass
 *
 * Pure and deterministic: no I/O, no network.
 */

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const STEP_TITLE_RE = /^(?:step|task|exercise|part|section|module)\s*#?\s*(\d+)\b[\s—–:.)-]*(.*)$/i;
const USE_CASE_TITLE_RE = /^(?:optional\s+)?(?:use\s*case|lab)\s*#?\s*(\d+)\b[\s—–:.)-]*(.*)$/i;
const NUMBERED_TITLE_RE = /^(\d+(?:\.\d+)+)[\s—–:.)-]+(.*)$/;
const BOLD_NUMBERED_RE = /^\s*\*\*(\d+)[.)]\s+(.+?)\*\*\s*$/;
const PREREQ_TITLE_RE = /^prerequisites?\b/i;
const OVERVIEW_TITLE_RE = /^overview\b/i;
// Trailing summary, appendix, and wrap-up containers hold review worksheets or next-lab links, not lab steps.
const NON_INSTRUCTION_SECTION_RE =
  /^(?:appendix\b|summary\b|lab complete\b|related labs\b|suggested next labs\b|next steps\b|further reading\b|references\b)/i;
// Sub-sections inside a step that hold text to type or outcomes, not instructions.
const SKIPPED_SUBSECTION_RE =
  /^(?:sample prompts?|prompts?|test prompts?|quick verification|expected(?: results?| output)?|validation(?: checklist)?|troubleshooting|summary)\b/i;

/** Remove leading emoji/symbols and markdown emphasis from a heading. */
export function cleanHeading(text) {
  return String(text || "")
    .replace(/[*_`]/g, "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTimeSuffix(title) {
  return title.replace(/\s*\(\s*\d+\s*(?:min|minutes?)\b[^)]*\)\s*$/i, "").trim();
}

function closesFence(marker, fence) {
  return marker && marker[1][0] === fence[0] && marker[1].length >= fence.length;
}

function parseHeadings(lines) {
  const headings = [];
  let fence = null;
  lines.forEach((line, index) => {
    const marker = line.match(FENCE_RE);
    if (fence) {
      if (closesFence(marker, fence)) fence = null;
      return;
    }
    if (marker) {
      fence = marker[1];
      return;
    }
    const match = line.match(HEADING_RE);
    if (!match) return;
    const title = cleanHeading(match[2]);
    let kind = "other";
    let ordinal = null;
    let name = title;
    let m;
    // The H1 is the lab title ("Lab 01: ..."), never a step.
    if (match[1].length === 1) {
      kind = "other";
    } else if ((m = title.match(STEP_TITLE_RE))) {
      kind = "step";
      ordinal = m[1];
      name = m[2] || title;
    } else if ((m = title.match(NUMBERED_TITLE_RE))) {
      kind = "numbered";
      ordinal = m[1];
      name = m[2] || title;
    } else if ((m = title.match(USE_CASE_TITLE_RE))) {
      kind = "useCase";
      ordinal = m[1];
      name = m[2] || title;
    }
    headings.push({
      index,
      level: match[1].length,
      title,
      kind,
      ordinal,
      name: stripTimeSuffix(name),
      skipped: kind === "other" && SKIPPED_SUBSECTION_RE.test(title),
    });
  });
  return headings;
}

/** Turn the lines of one step into instruction items. Code fences are never captured. */
function collectItems(lines, from, to, headings) {
  const items = [];
  let fence = null;
  let current = null;
  let skipUntilHeading = false;
  const headingAt = new Map(headings.map((h) => [h.index, h]));

  for (let i = from; i < to; i += 1) {
    const raw = lines[i];
    const marker = raw.match(FENCE_RE);
    if (fence) {
      if (closesFence(marker, fence)) fence = null;
      continue;
    }
    if (marker) {
      fence = marker[1];
      current = null;
      continue;
    }
    const heading = headingAt.get(i);
    if (heading) {
      skipUntilHeading = heading.skipped;
      current = null;
      continue;
    }
    if (skipUntilHeading) continue;

    let line = raw;
    let isNote = false;
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      line = quote[1];
      isNote = true;
    }
    if (!line.trim()) {
      current = null;
      continue;
    }
    if (/^\s*(?:<!--.*-->|!\[[^\]]*\]\([^)]*\)\s*)$/.test(line)) continue;
    if (/^[\s|:-]+$/.test(line) && /-{2,}/.test(line)) continue;
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      current = null;
      continue;
    }

    const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    const bullet = line.match(/^\s*[-*+]\s+(?:\[[ xX]\]\s+)?(.*)$/);
    if (numbered) {
      current = { n: Number(numbered[1]), kind: "numbered", text: numbered[2].trim(), line: i + 1 };
      items.push(current);
    } else if (bullet) {
      current = { n: null, kind: "bullet", text: bullet[1].trim(), line: i + 1 };
      items.push(current);
    } else if (line.trim().startsWith("|")) {
      const cells = line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean);
      if (cells.length) items.push({ n: null, kind: "table", text: cells.join(" | "), line: i + 1 });
      current = null;
    } else if (current && /^\s+\S/.test(raw) && !isNote) {
      current.text += ` ${line.trim()}`;
    } else if (current && current.kind === (isNote ? "note" : "text")) {
      current.text += ` ${line.trim()}`;
    } else {
      current = { n: null, kind: isNote ? "note" : "text", text: line.trim(), line: i + 1 };
      items.push(current);
    }
  }
  return items;
}

function endOfRegion(headings, position, lineCount) {
  const start = headings[position];
  for (let i = position + 1; i < headings.length; i += 1) {
    if (headings[i].level <= start.level) return headings[i].index;
  }
  return lineCount;
}

/** A step ends at the next step-like heading or the next heading of the same or higher level. */
function endOfUnit(headings, position, lineCount, unitIndexes) {
  const start = headings[position];
  for (let i = position + 1; i < headings.length; i += 1) {
    if (headings[i].level <= start.level || unitIndexes.has(headings[i].index)) return headings[i].index;
  }
  return lineCount;
}

function boldNumberedMarks(lines, from, to) {
  const marks = [];
  let fence = null;
  for (let i = from; i < to; i += 1) {
    const marker = lines[i].match(FENCE_RE);
    if (fence) {
      if (closesFence(marker, fence)) fence = null;
      continue;
    }
    if (marker) {
      fence = marker[1];
      continue;
    }
    const m = lines[i].match(BOLD_NUMBERED_RE);
    if (m) marks.push({ index: i, ordinal: m[1], title: cleanHeading(m[2]) });
  }
  return marks;
}

function nearestUseCase(headings, position) {
  const level = headings[position].level;
  for (let i = position - 1; i >= 0; i -= 1) {
    if (headings[i].kind === "useCase" && headings[i].level < level) return headings[i].name || headings[i].title;
  }
  return null;
}

const DIFFERENCE_NOTE_RE = /<details>\s*<summary>\s*How this differs on[\s\S]*?<\/details>/gi;

/**
 * The expandable "How this differs on the <other> harness" notes describe a
 * different harness than the lab's steps, so their wording is not a claim about
 * the steps. Drop them before claims are extracted.
 */
export function withoutDifferenceNotes(markdown) {
  return String(markdown || "").replace(DIFFERENCE_NOTE_RE, "");
}

/**
 * @param {string} markdown a lab's index.md
 * @returns {{source:string, steps:Array, prerequisites:object|null, stats:{steps:number, items:number}}}
 */
export function parseLabSteps(markdown) {
  const lines = withoutDifferenceNotes(markdown).split(/\r?\n/);
  const headings = parseHeadings(lines);
  const lineCount = lines.length;

  let overview = null;
  const overviewPos = headings.findIndex((h) => h.kind === "other" && h.level === 2 && OVERVIEW_TITLE_RE.test(h.title));
  if (overviewPos >= 0) {
    const items = collectItems(lines, headings[overviewPos].index + 1, endOfRegion(headings, overviewPos, lineCount), headings);
    if (items.length) {
      overview = {
        id: "overview",
        index: 0,
        kind: "overview",
        ordinal: null,
        title: "Lab overview",
        heading: headings[overviewPos].title,
        group: null,
        line: headings[overviewPos].index + 1,
        items,
      };
    }
  }

  let prerequisites = null;
  const prereqPos = headings.findIndex((h) => h.kind === "other" && h.level === 2 && PREREQ_TITLE_RE.test(h.title));
  if (prereqPos >= 0) {
    const items = collectItems(lines, headings[prereqPos].index + 1, endOfRegion(headings, prereqPos, lineCount), headings);
    if (items.length) {
      prerequisites = {
        id: "prerequisites",
        index: 0,
        kind: "prerequisites",
        ordinal: null,
        title: "Prerequisites",
        heading: headings[prereqPos].title,
        group: null,
        line: headings[prereqPos].index + 1,
        items,
      };
    }
  }

  const nonInstructionRanges = headings
    .map((h, i) => (h.kind === "other" && NON_INSTRUCTION_SECTION_RE.test(h.title) ? [h.index, endOfRegion(headings, i, lineCount), h.level] : null))
    .filter(Boolean);
  const inNonInstructionSection = (pos) => {
    const h = headings[pos];
    return nonInstructionRanges.some(([start, end, level]) => h.index > start && h.index < end && h.level > level);
  };

  const at = (kind) => headings.map((h, i) => (h.kind === kind && !inNonInstructionSection(i) ? i : -1)).filter((i) => i >= 0);
  const stepPositions = at("step");
  const numberedPositions = at("numbered");
  const useCasePositions = at("useCase");

  let source = "none";
  if (stepPositions.length) source = "step-headings";
  else if (numberedPositions.length) source = "numbered-headings";
  else if (useCasePositions.length) source = "use-cases";

  const chosen = new Set(source === "numbered-headings" ? numberedPositions : [...stepPositions, ...numberedPositions]);
  const stepStarts = [...chosen].map((i) => headings[i].index);
  // A use case that contains step headings is only their group; otherwise it is itself a step.
  for (const i of useCasePositions) {
    const end = endOfRegion(headings, i, lineCount);
    if (!stepStarts.some((idx) => idx > headings[i].index && idx < end)) chosen.add(i);
  }

  const ordered = [...chosen].sort((a, b) => a - b);
  const unitIndexes = new Set(ordered.map((i) => headings[i].index));
  const steps = [];

  for (const position of ordered) {
    const heading = headings[position];
    const end = endOfUnit(headings, position, lineCount, unitIndexes);
    const group = nearestUseCase(headings, position);

    if (heading.kind === "useCase") {
      const marks = boldNumberedMarks(lines, heading.index + 1, end);
      if (marks.length >= 2) {
        if (source === "use-cases") source = "bold-numbered";
        marks.forEach((mark, k) => {
          const stop = k + 1 < marks.length ? marks[k + 1].index : end;
          steps.push({
            kind: "boldNumbered",
            ordinal: mark.ordinal,
            title: mark.title,
            heading: mark.title,
            group: heading.name || heading.title,
            line: mark.index + 1,
            items: collectItems(lines, mark.index + 1, stop, headings),
          });
        });
        continue;
      }
    }

    steps.push({
      kind: heading.kind,
      ordinal: heading.ordinal,
      title: heading.name || heading.title,
      heading: heading.title,
      group,
      line: heading.index + 1,
      items: collectItems(lines, heading.index + 1, end, headings),
    });
  }

  const numbered = steps.map((step, i) => ({ ...step, id: `step-${i + 1}`, index: i + 1 }));
  return {
    source: numbered.length ? source : "none",
    steps: numbered,
    prerequisites,
    overview,
    stats: { steps: numbered.length, items: numbered.reduce((sum, step) => sum + step.items.length, 0) },
  };
}
