/**
 * Microsoft Learn sometimes says, in the first lines of an article, that it does not apply to the kind of agent a lab
 * builds ("This article applies to classic chatbots only", "This feature isn't available for ... the standard harness").
 * A topic found only on Learn carries that sentence as its summary, so the lab can see it and tell the person before
 * they teach the module, instead of presenting a module that cannot work as if it could.
 */

const CLASSIC_ONLY = /\bapplies to classic (?:chatbots?|agents?|bots?) only\b|\bclassic (?:chatbots?|agents?|bots?) only\b/i;
const NOT_AVAILABLE = /\b(?:isn't|is not|aren't|are not)\s+(?:available|supported)\b/i;
const HARNESS_WORDS = {
  standard: /\bstandard\b[^.]*\bharness\b/i,
  "microsoft-copilot": /\bmicrosoft copilot\b[^.]*\bharness\b/i,
  "customer-conversation": /\bcustomer conversation\b/i,
};

/**
 * @param {string} text a summary or the first lines of an article
 * @param {string|null} harness the lab's harness id, when it has one
 * @returns {{kind: "classic-only"|"harness-limit", sentences: string[]}|null} up to two sentences, as Learn wrote them
 */
export function scopeProblem(text, harness = null) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  const sentences = flat.match(/[^.!?]+[.!?]+(?=\s|$)/g) || [flat];
  const classic = [];
  const limits = [];
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (CLASSIC_ONLY.test(sentence)) classic.push(sentence);
    else if (harness && HARNESS_WORDS[harness] && NOT_AVAILABLE.test(sentence) && HARNESS_WORDS[harness].test(sentence)) limits.push(sentence);
  }
  if (classic.length) return { kind: "classic-only", sentences: [...classic, ...limits].slice(0, 2) };
  if (limits.length) return { kind: "harness-limit", sentences: limits.slice(0, 2) };
  return null;
}
