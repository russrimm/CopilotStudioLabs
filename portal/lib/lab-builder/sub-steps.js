/**
 * Lettered sub-steps.
 *
 * A Microsoft Learn step often ends in a list of choices ("Choose from:" and then two or more bullets). The lab shows
 * each choice on its own line under the step, lettered a, b, c, instead of squeezing them into one long sentence.
 *
 * Data shape. A step stays a plain string, so every place that stores or compares steps keeps working. A step with
 * sub-steps is a newline-separated block: the lead sentence, then one `a. ...`, `b. ...` line per choice (in order,
 * starting at a), then, when Learn lists more choices than the lab shows, a final line with `SUB_STEP_NOTE`.
 *
 *     On the Home page or on the Agents page, enter a description. Choose from:
 *     a. On the Home page, select **Agent** under **Start building from scratch**.
 *     b. On the Agents page, select **Create blank agent**.
 *
 * Markdown shape. The block is written under its number, indented to the width of the number marker. Each line but the
 * last ends in two spaces (a hard line break), so a viewer that does not know lettered lists, such as GitHub, still
 * shows every choice on its own line. The lab's own renderers (HTML, Word, PDF, PowerPoint) read the same lines and
 * draw a real nested list.
 *
 *     5. On the Home page or on the Agents page, enter a description. Choose from:␣␣
 *        a. On the Home page, select **Agent** under **Start building from scratch**.␣␣
 *        b. On the Agents page, select **Create blank agent**.
 *
 * Dependency-free: the Markdown renderers, the Office builders, and the lab gate all import it.
 */

/** The last line of a step whose choices were cut at the cap. Its own line, never part of a letter. */
export const SUB_STEP_NOTE = "More choices are in the linked article.";

const LEGACY_MORE = "more in the linked article";

/** "a" for 0 through "z" for 25, then "aa", "ab", and so on. */
export function subStepLabel(index) {
  let n = Math.max(0, Math.floor(Number(index) || 0));
  let label = "";
  do {
    label = String.fromCharCode(97 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

const SUB_LINE = /^([ \t]*)([a-z]{1,2})\.[ \t]+(\S.*?)[ \t]*$/;

/**
 * Read a run of lettered lines (a, b, c, ...) starting at `lines[start]`.
 *
 * The run must begin at "a" and follow the alphabet, so a line such as "a. Smith wrote this" in ordinary prose is
 * never mistaken for a sub-step. In Markdown the lines are indented under their step (`indented: true`) and at least
 * two are required (`min: 2`); in a step string they are flush left and one is enough.
 *
 * @returns {{items: string[], note: string, next: number}} `next` is the index after the run (and its note); with no
 *          run, `items` is empty and `next` equals `start`.
 */
export function takeSubSteps(lines, start, { indented = true, min = 2 } = {}) {
  const items = [];
  let i = start;
  while (i < lines.length) {
    const match = SUB_LINE.exec(String(lines[i] ?? ""));
    if (!match || match[2] !== subStepLabel(items.length)) break;
    if (indented && !match[1]) break;
    items.push(match[3]);
    i += 1;
  }
  if (items.length < min) return { items: [], note: "", next: start };
  let note = "";
  if (i < lines.length && String(lines[i]).trim() === SUB_STEP_NOTE) {
    note = SUB_STEP_NOTE;
    i += 1;
  }
  return { items, note, next: i };
}

/** True when a run of lettered sub-steps starts at `lines[index]` (used by list parsers to stop a step's text). */
export function isSubStepStart(lines, index) {
  return takeSubSteps(lines, index).items.length > 0;
}

/** Split a step string into its lead sentence, sub-steps, and the optional "more choices" note. */
export function splitStep(step) {
  const lines = String(step ?? "").split(/\r?\n/);
  if (lines.length > 1) {
    const run = takeSubSteps(lines, 1, { indented: false, min: 1 });
    if (run.items.length && run.next === lines.length) {
      return { lead: lines[0].trim(), subSteps: run.items, note: run.note };
    }
  }
  return { lead: lines.map((line) => line.trim()).filter(Boolean).join(" "), subSteps: [], note: "" };
}

/** Build a step string from its parts; the inverse of `splitStep`. */
export function joinStep(lead, subSteps = [], note = "") {
  if (!subSteps.length) return String(lead);
  return [lead, ...subSteps.map((text, index) => `${subStepLabel(index)}. ${text}`), ...(note ? [SUB_STEP_NOTE] : [])].join("\n");
}

/** A step's lines as plain text: the lead, then `a. ...` lines. For lists of instructions that show one line each. */
export function stepPlainLines(step) {
  const { lead, subSteps, note } = splitStep(step);
  return [lead, ...subSteps.map((text, index) => `${subStepLabel(index)}. ${text}`), ...(note ? [note] : [])].filter(Boolean);
}

/** The lead of a step that has exactly one sub-step, folded into one sentence: a one-item list is not a list. */
function foldSingle(lead, only, note) {
  const chooser = /\s*Choose from:$/i;
  const sentence = `${lead.replace(chooser, "")} ${only}`;
  return note ? `${sentence} ${note}` : sentence;
}

/** A step's lead as one closed sentence, for a line that quotes the step without its sub-steps. */
export function closeLead(lead) {
  return String(lead ?? "").replace(/\s*Choose from:$/i, "").replace(/:$/, ".");
}

export function stepLeadSentence(step) {
  return closeLead(splitStep(step).lead);
}

/**
 * A step as Markdown lines under its number.
 * @param {string} step a step string (see the file comment)
 * @param {number} number the step's number in its list
 * @returns {string} one line for an ordinary step; several, indented under the number, for a step with sub-steps
 */
export function stepToMarkdown(step, number) {
  const marker = `${number}. `;
  const { lead, subSteps, note } = splitStep(step);
  if (!subSteps.length) return `${marker}${lead}`;
  if (subSteps.length === 1) return `${marker}${foldSingle(lead, subSteps[0], note)}`;
  const pad = " ".repeat(marker.length);
  const lines = [`${marker}${lead}`, ...subSteps.map((text, index) => `${pad}${subStepLabel(index)}. ${text}`), ...(note ? [`${pad}${note}`] : [])];
  return lines.map((line, index) => (index < lines.length - 1 ? `${line}  ` : line)).join("\n");
}

/**
 * The one-sentence form this module replaced: `lead (a) X; (b) Y; more in the linked article.`
 *
 * Learn-change detection hashes a module's steps. Hashing this form keeps the hash of an unchanged Learn page equal to
 * the one recorded in labs built before sub-steps had their own lines, so the change of layout is never reported as a
 * change of Learn.
 */
export function flattenStepLegacy(step) {
  const { lead, subSteps, note } = splitStep(step);
  if (!subSteps.length) return String(step ?? "");
  const pieces = subSteps.map((text, index) => `(${subStepLabel(index)}) ${text.replace(/[.;]+\s*$/, "")}`);
  return `${lead} ${pieces.join("; ")}${note ? `; ${LEGACY_MORE}` : ""}.`;
}

const RUN_ON_LEAD = /^(.*?(?::|\bcan|\bChoose from))\s+\(a\)\s+(\S[\s\S]*)$/;

/** A run-on `(a) ...; (b) ...` sentence anywhere in a line (the lab gate's test). */
export const RUN_ON_SUB_STEPS = /\(a\)\s.*;\s+\(b\)\s/;

/** A sub-step as a clean sentence: trailing semicolons and periods are normalized to one closing period. */
export function endSubStep(text) {
  const clean = String(text ?? "").replace(/[.;]+\s*$/, "").trim();
  return /[!?]$/.test(clean) ? clean : `${clean}.`;
}

/**
 * Turn the one-sentence form back into a step string: `lead: (a) X; (b) Y; (c) Z.` becomes a lead and three sub-steps.
 *
 * Guard rails: the choices must follow a lead that ends with a colon, "can", or "Choose from", they must start at (a),
 * follow the alphabet, and be separated by semicolons, and there must be at least two of them. An ordinary
 * parenthetical such as "(a) cat" in other text is left alone.
 *
 * @returns {string|null} the step string, or null when the text is not a run-on list
 */
export function repairRunOnStep(text) {
  const source = String(text ?? "");
  if (!source.includes("(a)")) return null;
  const match = RUN_ON_LEAD.exec(source.replace(/\s+/g, " ").trim());
  if (!match) return null;
  const rest = match[2];
  const pieces = [];
  let from = 0;
  for (;;) {
    const marker = `; (${subStepLabel(pieces.length + 1)}) `;
    const at = rest.indexOf(marker, from);
    if (at < 0) break;
    pieces.push(rest.slice(from, at));
    from = at + marker.length;
  }
  if (!pieces.length) return null;
  let last = rest.slice(from).replace(/[.\s]+$/, "");
  let note = "";
  const more = `; ${LEGACY_MORE}`;
  if (last.endsWith(more)) {
    last = last.slice(0, -more.length);
    note = SUB_STEP_NOTE;
  }
  pieces.push(last);
  if (pieces.some((piece) => !piece.replace(/[.;\s]/g, ""))) return null;
  const lead = /:$/.test(match[1]) ? match[1] : `${match[1]}:`;
  return joinStep(lead, pieces.map(endSubStep), note);
}

/**
 * The Markdown the renderers and Office builders read: run-on steps repaired (`repairRunOnSteps`), and the hard-break
 * spaces that only help GitHub taken off the lines of each sub-step block, so no builder carries them into its text.
 */
export function normalizeSubSteps(markdown) {
  const text = repairRunOnSteps(markdown);
  if (!/^[ \t]+a\.[ \t]/m.test(text)) return text;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  let changed = false;
  for (let i = 1; i < lines.length; i += 1) {
    const run = takeSubSteps(lines, i);
    if (!run.items.length) continue;
    for (let j = i - 1; j < run.next; j += 1) {
      const trimmed = lines[j].replace(/[ \t]+$/, "");
      if (trimmed !== lines[j]) {
        lines[j] = trimmed;
        changed = true;
      }
    }
    i = run.next - 1;
  }
  return changed ? lines.join(eol) : text;
}

const NUMBERED_LINE = /^(\s*)(\d+)\.\s+(\S.*)$/;

/**
 * Split every run-on `(a) ...; (b) ...` numbered step in a lab's Markdown into a lead and lettered sub-steps.
 *
 * Labs built after sub-steps got their own lines already have them, and the call changes nothing there (it is safe to
 * apply more than once). Labs built while the one-sentence form was in use are repaired as they are read, so the file
 * on disk is never rewritten. Fenced code is left alone.
 */
export function repairRunOnSteps(markdown) {
  const text = String(markdown ?? "");
  if (!text.includes("(a)")) return text;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  let fence = null;
  let changed = false;
  const out = lines.map((line) => {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      return line;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      return line;
    }
    const numbered = NUMBERED_LINE.exec(line);
    if (!numbered) return line;
    const repaired = repairRunOnStep(numbered[3]);
    if (!repaired) return line;
    changed = true;
    const indent = numbered[1];
    return stepToMarkdown(repaired, Number(numbered[2]))
      .split("\n")
      .map((blockLine) => `${indent}${blockLine}`)
      .join(eol);
  });
  return changed ? out.join(eol) : text;
}
