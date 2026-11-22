/**
 * Guard for the pre-lab training decks: they are concepts and orientation only. No lab steps, no click paths,
 * no "Screenshot to add" cards, no administrator settings, no tenant-specific values.
 *
 * `findLabStepLeaks` is used three ways: the library check refuses curated text that reads like a step, the deck
 * builder drops catalog sentences that read like a step before they reach a slide, and the tests scan every
 * finished deck with the same patterns.
 */

const LEAK_PATTERNS = [
  ["lab step", /(?:^|(?<!\b[A-Za-z0-9])[.!?]\s+)(?:Select|Click|Choose|Open|Go to|Navigate to|Type|Enter|Press|Tap|Sign in to|Sign in with|Log in to|Turn on|Turn off|Toggle|Paste|Copy|Browse to|Scroll to|Expand)\b/],
  ["bold interface label", /\*\*[^*]{1,60}\*\*/],
  ["click path", /\b[A-Za-z][\w ]{0,40}\s>\s[A-Za-z]/],
  ["screenshot card", /Screenshot to add|Screenshot pending|Capture this screenshot|How to capture/i],
  ["step heading", /\bDo this\b|\bStep-by-step\b|\bCheck your work\b/i],
  ["admin setting", /\b(?:Global Administrator|PowerShell|Set-[A-Z]\w+|Conditional Access polic(?:y|ies)|tenant-wide setting)\b/],
  ["tenant value", /\.sharepoint\.com|\.crm\d*\.dynamics\.com|onmicrosoft\.com|\.powerplatform\.com\/environments/i],
  ["guid", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ["account name", /\b[\w.+-]+@(?!contoso\.|fabrikam\.|example\.)[\w-]+\.[a-z]{2,}\b/i],
];

/** Names of the leak patterns `text` matches (empty when it is clean). */
export function findLabStepLeaks(text) {
  const source = String(text || "");
  const found = [];
  for (const [name, pattern] of LEAK_PATTERNS) {
    if (pattern.test(source)) found.push(name);
  }
  return found;
}

/** True when a sentence from the catalog is safe to put on a slide: it states a fact and does not tell the learner what to click. */
export function isConceptSentence(sentence) {
  const text = String(sentence || "").trim();
  if (text.length < 20) return false;
  if (/\[Unverified\]/i.test(text)) return false;
  return findLabStepLeaks(text).length === 0;
}
