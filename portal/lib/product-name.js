/**
 * The product's name, in one place.
 *
 * Labs, brand profiles and drafts saved before a rename carry an earlier name as their default
 * company name and as the manifest's `generator` field. `currentProductName` maps exactly those
 * earlier names to the current one when something is read, so older saved data renders under the
 * current name without anyone rewriting a file.
 */

export const PRODUCT_NAME = "Dynamic Microsoft Training and Lab Generator";

const EARLIER_PRODUCT_NAMES = Object.freeze(["Microsoft AI Training Generator", "Agentic Microsoft Training and Lab Generator"]);

/** The current name when `value` is exactly an earlier product name; anything else comes back unchanged. */
export function currentProductName(value) {
  return typeof value === "string" && EARLIER_PRODUCT_NAMES.includes(value.trim()) ? PRODUCT_NAME : value;
}

/** True for a company name that is just the product's own name (current or earlier): not a customer brand. */
export function isDefaultCompanyName(value) {
  const text = String(value ?? "").trim();
  return text === PRODUCT_NAME || EARLIER_PRODUCT_NAMES.includes(text);
}
