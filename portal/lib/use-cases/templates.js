/**
 * Template rendering for use case text.
 *
 * Patterns use {slot} for a value from the industry and department context and
 * {Slot} for the same value with its first letter capitalized. An unknown slot
 * is a data error, so it throws instead of leaking braces into the UI.
 */

const TOKEN = /\{([A-Za-z]+)\}/g;

export function templateSlots(template) {
  return [...String(template).matchAll(TOKEN)].map((match) => match[1]);
}

export function renderTemplate(template, slots) {
  return String(template).replace(TOKEN, (_match, name) => {
    const key = name[0].toLowerCase() + name.slice(1);
    const value = slots[key];
    if (value === undefined || value === null || value === "") throw new Error(`Unknown template slot {${name}}`);
    const text = String(value);
    return name[0] === name[0].toUpperCase() ? text[0].toUpperCase() + text.slice(1) : text;
  });
}

/** A small stable hash, so a pattern picks the same title variant for the same use case on every run. */
export function stableHash(text) {
  let hash = 2166136261;
  for (const ch of String(text)) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/** "a", "a and b", "a, b, and c". */
export function joinClauses(items) {
  const list = items.filter(Boolean);
  if (list.length <= 2) return list.join(" and ");
  return `${list.slice(0, -1).join(", ")}, and ${list[list.length - 1]}`;
}
