/**
 * The Prerequisites checklist as one self-contained, print-friendly HTML file.
 *
 * A single document with an inline style sheet and one small inline script (the "Show items for"
 * filter, so an IT admin can print just their part). No external files, fonts, or images except the
 * brand logo, which is embedded as a data URI. Every string from the model is escaped.
 */

import { contrastRatio, ensureReadableColor, escapeHtmlText, getBrandFont, normalizeHexColor6 } from "./brand-theme.js";
import {
  checklistInlineSegments,
  checklistItemParts,
  checklistPlainText,
  formatItemNumbers,
} from "./prereq-checklist.js";

const esc = escapeHtmlText;
const DEFAULT_ACCENT = "#0f6cbd";

function mixWithWhite(hex, amount) {
  const color = normalizeHexColor6(hex) || DEFAULT_ACCENT;
  const channels = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const mixed = channels.map((c) => Math.round(c + (255 - c) * amount));
  return `#${mixed.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function inlineHtml(text) {
  return checklistInlineSegments(text)
    .map((seg) => {
      const safe = esc(seg.text);
      if (seg.href) return `<a href="${esc(seg.href)}" rel="noopener noreferrer" target="_blank">${safe}</a>`;
      return seg.bold ? `<strong>${safe}</strong>` : safe;
    })
    .join("");
}

function cssString(text, max = 110) {
  const clean = String(text || "").replace(/[\\"\r\n]/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const wordEnd = cut.lastIndexOf(" ");
  return `${(wordEnd > max * 0.6 ? cut.slice(0, wordEnd) : cut).trim()}\u2026`;
}

function itemRowHtml(item) {
  const parts = checklistItemParts(item);
  const label = checklistPlainText(parts.title || parts.text).slice(0, 120);
  const titleHtml = parts.title ? `<p class="item-title"><span class="num">${item.n}.</span> ${esc(parts.title)}</p>` : "";
  const textHtml = parts.text
    ? `<p class="item-text">${parts.title ? "" : `<span class="num">${item.n}.</span> `}${inlineHtml(parts.text)}</p>`
    : "";
  const lead = titleHtml || textHtml ? "" : `<p class="item-title"><span class="num">${item.n}.</span></p>`;
  const whereHtml = parts.where ? `<p class="where">${esc(parts.where)}</p>` : "";
  const condHtml = parts.condition ? `<p class="cond">${esc(parts.condition)}</p>` : "";
  const whyHtml = parts.why ? `<p>${esc(parts.why)}</p>` : "";
  const learnHtml = parts.learn
    ? `<p class="learn"><a href="${esc(parts.learn.url)}" rel="noopener noreferrer" target="_blank">${esc(parts.learn.label)}</a></p>`
    : "";
  const confirmHtml = parts.confirm ? `<p class="confirm-note">${esc(parts.confirm)}</p>` : "";
  return `<tr data-role="${esc(item.role)}">
    <td class="check"><input type="checkbox" aria-label="Done: ${esc(label)}"></td>
    <td class="what">${titleHtml}${textHtml}${lead}${condHtml}${whereHtml}</td>
    <td class="who">${esc(item.roleLabel)}</td>
    <td class="why">${whyHtml}${learnHtml}${confirmHtml}</td>
    <td class="done"><span class="fill" aria-hidden="true"></span></td>
  </tr>`;
}

function sectionHtml(section) {
  return `<section class="checklist-section" data-section="${esc(section.id)}" aria-labelledby="sec-${esc(section.id)}">
  <h2 id="sec-${esc(section.id)}">${esc(section.title)}</h2>
  ${section.intro ? `<p class="intro">${esc(section.intro)}</p>` : ""}
  <table class="checklist">
    <colgroup><col class="c-check"><col class="c-what"><col class="c-who"><col class="c-why"><col class="c-done"></colgroup>
    <thead><tr><th scope="col"><span class="sr-only">Done</span></th><th scope="col">What to have ready</th><th scope="col">Who</th><th scope="col">Why it is needed</th><th scope="col">Done by / date</th></tr></thead>
    <tbody>
${section.items.map(itemRowHtml).join("\n")}
    </tbody>
  </table>
</section>`;
}

const FILTER_SCRIPT = `(function () {
  var select = document.getElementById("role-filter");
  if (!select) return;
  var note = document.getElementById("filter-note");
  select.addEventListener("change", function () {
    var role = select.value;
    var rows = document.querySelectorAll("tr[data-role]");
    for (var i = 0; i < rows.length; i += 1) rows[i].hidden = role !== "all" && rows[i].getAttribute("data-role") !== role;
    var sections = document.querySelectorAll("[data-section]");
    for (var j = 0; j < sections.length; j += 1) sections[j].hidden = !sections[j].querySelector("tr[data-role]:not([hidden])");
    note.hidden = role === "all";
    note.textContent = role === "all" ? "" : "Showing only the items for: " + select.options[select.selectedIndex].text + ".";
  });
})();`;

/**
 * @param {object} model from `buildPrerequisitesChecklist`
 * @param {object} [options]
 * @param {object} [options.branding] `{ companyName, tagline, primaryColor, secondaryColor, font, coverSubtitle, footerText, logoUrl }`
 */
export function renderPrerequisitesChecklistHtml(model, { branding } = {}) {
  const brand = branding && typeof branding === "object" ? branding : {};
  const primary = normalizeHexColor6(brand.primaryColor) || DEFAULT_ACCENT;
  const accentText = ensureReadableColor(primary, ["#ffffff", "#f8fafc"], "#0b2a5b", 4.5);
  const bandText = contrastRatio(primary, "#ffffff") >= contrastRatio(primary, "#0b0e14") ? "#ffffff" : "#0b0e14";
  const secondary = normalizeHexColor6(brand.secondaryColor);
  const rule = secondary || "#cbd5e1";
  const tint = mixWithWhite(primary, 0.9);
  const fontStack = getBrandFont(brand.font).css || '"Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif';
  const companyName = String(brand.companyName || "").trim();
  const showCompany = companyName && companyName !== "Microsoft AI Training Generator";
  const footerLeft = cssString([model.title, model.documentTitle].filter(Boolean).join(" \u2014 "), 90);
  const footerExtra = cssString(brand.footerText || model.footerText || "", 80);
  const meta = [
    ["Products", model.products.join("; ")],
    ["Audience", model.audience],
    ["Date", model.dateText],
    ...(model.customerName ? [["Prepared for", model.customerName]] : []),
  ];

  const whoRows = model.roles
    .map(
      (role) =>
        `<tr><th scope="row">${esc(role.label)}</th><td>${esc(role.does)}</td><td class="num-list">${esc(formatItemNumbers(role.items))}</td></tr>`,
    )
    .join("\n");
  const roleOptions = model.roles.map((role) => `<option value="${esc(role.id)}">${esc(role.label)}</option>`).join("");
  const contactBits = [];
  if (model.contact?.moreInfo) {
    contactBits.push(`<p><a href="${esc(model.contact.moreInfo.url)}" rel="noopener noreferrer" target="_blank">${esc(model.contact.moreInfo.label)}</a></p>`);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(model.title)} \u2014 ${esc(model.documentTitle)}</title>
<style>
:root { --accent: ${accentText}; --band: ${primary}; --band-text: ${bandText}; --tint: ${tint}; --rule: ${rule}; --ink: #1f2937; --muted: #475569; --line: #cbd5e1; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: #f1f5f9; color: var(--ink); font: 15px/1.5 ${fontStack}; }
.page { max-width: 980px; margin: 0 auto; padding: 24px 20px 48px; background: #fff; }
[hidden] { display: none !important; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
a { color: var(--accent); overflow-wrap: anywhere; }
a:focus-visible, select:focus-visible, input:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.cover { border-top: 8px solid var(--band); padding: 18px 0 14px; margin-bottom: 8px; }
.brand { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; color: var(--ink); font-weight: 600; }
.brand img { max-height: 44px; max-width: 180px; object-fit: contain; }
.brand .tagline { color: var(--muted); font-weight: 400; }
.eyebrow { margin: 0; color: var(--accent); font-size: 13px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
h1 { margin: 4px 0 12px; font-size: 28px; line-height: 1.2; color: var(--ink); overflow-wrap: anywhere; }
.banner { display: inline-block; margin: 0 0 14px; padding: 6px 14px; border-radius: 999px; background: var(--band); color: var(--band-text); font-weight: 700; }
.meta { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; }
.meta dt { color: var(--muted); font-weight: 600; }
.meta dd { margin: 0; overflow-wrap: anywhere; }
h2 { margin: 28px 0 8px; padding-bottom: 4px; border-bottom: 2px solid var(--rule); color: var(--accent); font-size: 20px; line-height: 1.25; break-after: avoid; page-break-after: avoid; }
.summary p { margin: 0 0 8px; max-width: 72ch; }
.box { margin: 16px 0; padding: 10px 16px 12px; border: 1px solid var(--rule); border-radius: 6px; background: var(--tint); break-inside: avoid; }
.box h2 { margin: 4px 0 6px; padding: 0; border: 0; font-size: 16px; }
.box ul { margin: 0; padding-left: 20px; }
.box li { margin: 3px 0; }
.filter { margin: 16px 0 0; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.filter select { padding: 6px 8px; border: 1px solid #94a3b8; border-radius: 4px; font: inherit; background: #fff; color: var(--ink); }
#filter-note { margin: 6px 0 0; font-weight: 600; }
.intro { margin: 4px 0 8px; color: var(--muted); }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 8px 10px; border: 1px solid var(--line); vertical-align: top; text-align: left; }
thead th { background: var(--tint); font-size: 13px; color: var(--ink); }
table.checklist { table-layout: fixed; }
col.c-check { width: 6%; } col.c-what { width: 41%; } col.c-who { width: 14%; } col.c-why { width: 26%; } col.c-done { width: 13%; }
td p { margin: 0 0 4px; }
td p:last-child { margin-bottom: 0; }
td.check { text-align: center; }
.item-title { font-weight: 700; overflow-wrap: anywhere; }
.num { color: var(--muted); font-weight: 700; }
.where, .cond { color: var(--muted); font-size: 13px; }
.cond { font-style: italic; }
.who { font-size: 13px; font-weight: 600; }
.why { font-size: 13px; }
.confirm-note { padding: 4px 8px; border: 1px solid #d9a441; border-radius: 4px; background: #fef3c7; color: #5b3a06; font-weight: 600; }
.fill { display: block; height: 28px; border-bottom: 1px solid #64748b; }
tr { break-inside: avoid; page-break-inside: avoid; }
thead { display: table-header-group; }
input[type="checkbox"] { appearance: none; -webkit-appearance: none; width: 20px; height: 20px; margin: 2px 0 0; border: 2px solid #334155; border-radius: 4px; background: #fff; vertical-align: middle; cursor: pointer; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
input[type="checkbox"]:checked { background: #334155 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3 8.5l3 3 7-7' fill='none' stroke='white' stroke-width='2.2'/%3E%3C/svg%3E") center / 80% no-repeat; }
.who-table th[scope="row"] { width: 28%; background: #fff; }
.who-table .num-list { width: 20%; font-weight: 600; }
.confirm-block { margin-top: 8px; padding: 10px 16px; border: 1px solid var(--line); border-radius: 6px; break-inside: avoid; }
.sign { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 14px; }
.sign > div { border-top: 1px solid #64748b; padding-top: 4px; color: var(--muted); font-size: 13px; }
.sign-space { height: 28px; }
footer.page-footer { margin-top: 28px; padding-top: 8px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
@media (max-width: 720px) {
  table.checklist, table.checklist tbody, table.checklist tr, table.checklist td { display: block; width: 100%; }
  table.checklist thead, table.checklist colgroup { display: none; }
  table.checklist tr { margin-bottom: 10px; border: 1px solid var(--line); }
  table.checklist td { border: 0; border-bottom: 1px solid #e2e8f0; }
  td.check { text-align: left; }
}
@page { size: letter; margin: 0.7in 0.65in 0.8in; @bottom-left { content: "${footerLeft}${footerExtra ? ` \u00b7 ${footerExtra}` : ""}"; font: 8pt ${fontStack}; color: #475569; } @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8pt ${fontStack}; color: #475569; } }
@media print {
  body { background: #fff; font-size: 10.5pt; }
  .page { max-width: none; padding: 0; }
  .no-print { display: none !important; }
  .cover { padding-top: 8px; }
  h1 { font-size: 22pt; }
  .banner, .box, thead th, .confirm-note, .cover { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  a { color: var(--accent); text-decoration: none; }
  .learn a::after { content: " (" attr(href) ")"; display: block; color: #475569; font-size: 7.5pt; overflow-wrap: anywhere; word-break: break-all; }
  footer.page-footer { display: none; }
  th, td { padding: 5px 7px; }
  .who, .why, .where, .cond { font-size: 9pt; }
}
</style>
</head>
<body>
<div class="page">
<header class="cover">
${showCompany || brand.logoUrl ? `  <div class="brand">${brand.logoUrl ? `<img src="${esc(brand.logoUrl)}" alt="${esc(companyName || "Logo")}">` : ""}${showCompany ? `<span>${esc(companyName)}${brand.tagline ? ` <span class="tagline">\u2014 ${esc(brand.tagline)}</span>` : ""}</span>` : ""}</div>` : ""}
  <p class="eyebrow">${esc(model.documentTitle)}</p>
  <h1>${esc(model.title)}</h1>
  <p class="banner">${esc(model.banner)}</p>
${brand.coverSubtitle ? `  <p class="cover-subtitle">${esc(brand.coverSubtitle)}</p>\n` : ""}  <dl class="meta">
${meta.map(([k, v]) => `    <dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("\n")}
  </dl>
</header>
<main>
<section class="summary" aria-label="Summary"><p>${esc(model.summary)}</p></section>
<section class="box" aria-labelledby="howto"><h2 id="howto">How to use this checklist</h2><ul>
${model.howToUse.map((line) => `<li>${esc(line)}</li>`).join("\n")}
</ul></section>
${model.roles.length > 1 ? `<div class="filter no-print"><label for="role-filter"><strong>Show items for</strong></label><select id="role-filter"><option value="all">Everyone (all items)</option>${roleOptions}</select></div>` : ""}
<p id="filter-note" hidden></p>
${model.roles.length ? `<section aria-labelledby="who-heading"><h2 id="who-heading">Who needs to be involved</h2>
<table class="who-table"><thead><tr><th scope="col">Who</th><th scope="col">What they do</th><th scope="col">Items</th></tr></thead><tbody>
${whoRows}
</tbody></table></section>` : ""}
${model.sections.map(sectionHtml).join("\n")}
<section class="confirm-block" aria-labelledby="confirm-heading"><h2 id="confirm-heading">Confirm and return</h2>
<p>${esc(model.confirm.line)}</p>
${contactBits.join("\n")}
<div class="sign">${model.confirm.fields.map((f) => `<div><div class="sign-space"></div>${esc(f)}</div>`).join("")}</div>
</section>
</main>
<footer class="page-footer">${esc(model.title)} \u2014 ${esc(model.documentTitle)}${model.footerText ? ` \u00b7 ${esc(model.footerText)}` : ""}</footer>
</div>
<script>${FILTER_SCRIPT}</script>
</body>
</html>
`;
}
