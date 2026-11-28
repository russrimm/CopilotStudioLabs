/**
 * Reads the "Your lab so far" list in the Lab Builder wizard header, for tests that run the real wizard script.
 *
 * The summary is a title and a list: one item per selected product (inside the Products item) and one item per other
 * choice, each a short label and its value. `readSummary` takes the markup string the script wrote (for tests whose
 * stand-in element only keeps `innerHTML`); `readSummaryElement` takes a live element from the fake DOM.
 */

const UNESCAPES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const unescapeHtml = (text) => String(text).replace(/&(amp|lt|gt|quot|#39);/g, (entity) => UNESCAPES[entity]);

/** @returns {{title: string, empty: string, products: string[], choices: string[]}} choices read "Label: value". */
export function readSummary(html) {
  const title = /<p class="lb-summary-title">(.*?)<\/p>/s.exec(html)?.[1] ?? "";
  const empty = /<p class="lb-summary-empty">(.*?)<\/p>/s.exec(html)?.[1] ?? "";
  const productList = /<ul class="lb-summary-values" role="list">(.*?)<\/ul>/s.exec(html)?.[1] ?? "";
  const products = [...productList.matchAll(/<li>(.*?)<\/li>/gs)].map((match) => unescapeHtml(match[1]));
  const choices = [...html.matchAll(/<li class="lb-summary-item"><span class="lb-summary-label">(.*?)<\/span><span class="sr-only">: <\/span><span class="lb-summary-value">(.*?)<\/span><\/li>/gs)].map(
    (match) => `${unescapeHtml(match[1])}: ${unescapeHtml(match[2])}`,
  );
  return { title: unescapeHtml(title), empty: unescapeHtml(empty), products, choices };
}

export function readSummaryElement(element) {
  return {
    title: element.querySelector(".lb-summary-title")?.textContent ?? "",
    empty: element.querySelector(".lb-summary-empty")?.textContent ?? "",
    products: [...element.querySelectorAll(".lb-summary-values li")].map((item) => item.textContent),
    choices: [...element.querySelectorAll(".lb-summary-item")].filter((item) => !item.classList.contains("lb-summary-products")).map((item) => item.textContent),
  };
}
