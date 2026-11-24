/**
 * The Administrator setup guide as one self-contained, print-friendly HTML file.
 *
 * Same cover, colors, and footer as the Prerequisites checklist page so the two read as a pair. A role has its
 * own section and each item is a card with a checkbox, where to make the change, the steps, and a "Done by" line.
 * A small inline script offers a "Show items for" filter so each administrator can print only their part.
 * No external files, fonts, or images except the brand logo (a data URI). Every string from the model is escaped.
 */

import { contrastRatio, ensureReadableColor, escapeHtmlText, getBrandFont, normalizeHexColor6 } from "./brand-theme.js";
import { isDefaultCompanyName } from "../product-name.js";
import { adminGuideItemParts } from "./admin-guide.js";
import { checklistInlineSegments, checklistPlainText, formatItemNumbers } from "./prereq-checklist.js";

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

function itemHtml(item) {
  const parts = adminGuideItemParts(item);
  const label = checklistPlainText(parts.title).slice(0, 120);
  const stepsHtml = parts.steps.length ? `<ol class="steps">${parts.steps.map((step) => `<li>${esc(step)}</li>`).join("")}</ol>` : "";
  return `<article class="item" id="item-${item.n}" data-role="${esc(item.role)}">
  <div class="item-check"><input type="checkbox" aria-label="Done: ${esc(label)}"></div>
  <div class="item-body">
    <h3><span class="num">${item.n}.</span> ${esc(parts.title)}</h3>
    <p class="stage">${esc(parts.stage)}${parts.condition ? ` <span class="cond">\u00b7 ${esc(parts.condition)}</span>` : ""}</p>
    ${stepsHtml}
    ${parts.text ? `<p><strong>${esc(parts.whatLabel)}:</strong> ${inlineHtml(parts.text)}</p>` : ""}
    ${parts.check ? `<p class="check"><strong>How to check:</strong> ${inlineHtml(parts.check)}</p>` : ""}
    ${parts.detail ? `<p class="detail"><strong>Details:</strong> ${esc(parts.detail)}</p>` : ""}
    ${parts.endpoints ? `<p class="endpoints">${esc(parts.endpoints)}</p>` : ""}
    ${parts.why ? `<p class="why"><strong>Why:</strong> ${esc(parts.why)}</p>` : ""}
    ${parts.learn ? `<p class="learn"><a href="${esc(parts.learn.url)}" rel="noopener noreferrer" target="_blank">${esc(parts.learn.label)}</a></p>` : ""}
    ${parts.confirm ? `<p class="confirm-note">${esc(parts.confirm)}</p>` : ""}
  </div>
  <div class="item-done"><span class="done-label">Done by / date</span><span class="fill" aria-hidden="true"></span></div>
</article>`;
}

function sectionHtml(section) {
  return `<section class="role-section" data-section="${esc(section.id)}" aria-labelledby="role-${esc(section.id)}">
  <h2 id="role-${esc(section.id)}">${esc(section.title)}</h2>
  ${section.intro ? `<p class="intro">${esc(section.intro)}</p>` : ""}
${section.items.map(itemHtml).join("\n")}
</section>`;
}

const FILTER_SCRIPT = `(function () {
  var select = document.getElementById("role-filter");
  if (!select) return;
  var note = document.getElementById("filter-note");
  select.addEventListener("change", function () {
    var role = select.value;
    var items = document.querySelectorAll("article[data-role]");
    for (var i = 0; i < items.length; i += 1) items[i].hidden = role !== "all" && items[i].getAttribute("data-role") !== role;
    var sections = document.querySelectorAll("[data-section]");
    for (var j = 0; j < sections.length; j += 1) sections[j].hidden = !sections[j].querySelector("article[data-role]:not([hidden])");
    note.hidden = role === "all";
    note.textContent = role === "all" ? "" : "Showing only the items for: " + select.options[select.selectedIndex].text + ".";
  });
})();`;

/**
 * @param {object} model from `buildAdministratorSetupGuide`
 * @param {object} [options]
 * @param {object} [options.branding] `{ companyName, tagline, primaryColor, secondaryColor, font, coverSubtitle, footerText, logoUrl }`
 */
export function renderAdministratorSetupGuideHtml(model, { branding } = {}) {
  const brand = branding && typeof branding === "object" ? branding : {};
  const primary = normalizeHexColor6(brand.primaryColor) || DEFAULT_ACCENT;
  const accentText = ensureReadableColor(primary, ["#ffffff", "#f8fafc"], "#0b2a5b", 4.5);
  const bandText = contrastRatio(primary, "#ffffff") >= contrastRatio(primary, "#0b0e14") ? "#ffffff" : "#0b0e14";
  const secondary = normalizeHexColor6(brand.secondaryColor);
  const rule = secondary || "#cbd5e1";
  const tint = mixWithWhite(primary, 0.9);
  const fontStack = getBrandFont(brand.font).css || '"Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif';
  const companyName = String(brand.companyName || "").trim();
  const showCompany = companyName && !isDefaultCompanyName(companyName);
  const footerLeft = cssString([model.title, model.documentTitle].filter(Boolean).join(" \u2014 "), 90);
  const footerExtra = cssString(brand.footerText || model.footerText || "", 80);
  const meta = [
    ["Products", model.products.join("; ")],
    ["Audience", model.audience],
    ["Date", model.dateText],
    ...(model.customerName ? [["Prepared for", model.customerName]] : []),
  ];

  const workOrderRows = model.workOrder
    .map(
      (entry) =>
        `<tr><td class="num-cell"><a href="#item-${entry.n}">${entry.n}</a></td><td>${esc(entry.title)}</td><td class="muted">${esc(entry.stageTitle)}</td><td>${esc(entry.roleLabel)}</td></tr>`,
    )
    .join("\n");
  const whoRows = model.roles
    .map(
      (role) =>
        `<tr><th scope="row">${esc(role.label)}</th><td>${esc(role.does)}</td><td class="num-list">${esc(formatItemNumbers(role.items))}</td></tr>`,
    )
    .join("\n");
  const roleOptions = model.roles.map((role) => `<option value="${esc(role.id)}">${esc(role.label)}</option>`).join("");
  const contactBits = model.contact?.moreInfo
    ? `<p><a href="${esc(model.contact.moreInfo.url)}" rel="noopener noreferrer" target="_blank">${esc(model.contact.moreInfo.label)}</a></p>`
    : "";

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
.cover-subtitle { margin: 0 0 12px; color: var(--muted); font-style: italic; }
.meta { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; }
.meta dt { color: var(--muted); font-weight: 600; }
.meta dd { margin: 0; overflow-wrap: anywhere; }
h2 { margin: 28px 0 8px; padding-bottom: 4px; border-bottom: 2px solid var(--rule); color: var(--accent); font-size: 20px; line-height: 1.25; break-after: avoid; page-break-after: avoid; }
.summary p { margin: 0 0 8px; max-width: 72ch; }
.box { margin: 16px 0; padding: 10px 16px 12px; border: 1px solid var(--rule); border-radius: 6px; background: var(--tint); break-inside: avoid; }
.box h2 { margin: 4px 0 6px; padding: 0; border: 0; font-size: 16px; }
.box ul { margin: 0; padding-left: 20px; }
.box li { margin: 3px 0; }
.box p { margin: 4px 0; }
.filter { margin: 16px 0 0; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.filter select { padding: 6px 8px; border: 1px solid #94a3b8; border-radius: 4px; font: inherit; background: #fff; color: var(--ink); }
#filter-note { margin: 6px 0 0; font-weight: 600; }
.intro { margin: 4px 0 8px; color: var(--muted); }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 8px 10px; border: 1px solid var(--line); vertical-align: top; text-align: left; }
thead th { background: var(--tint); font-size: 13px; color: var(--ink); }
.who-table th[scope="row"] { width: 28%; background: #fff; }
.who-table .num-list { width: 20%; font-weight: 600; }
.order-table .num-cell { width: 44px; font-weight: 700; }
.muted { color: var(--muted); font-size: 13px; }
tr { break-inside: avoid; page-break-inside: avoid; }
thead { display: table-header-group; }
.item { display: grid; grid-template-columns: 40px 1fr 150px; gap: 0 12px; margin: 0 0 12px; padding: 12px; border: 1px solid var(--line); border-radius: 6px; break-inside: avoid; page-break-inside: avoid; }
.item-check { padding-top: 2px; }
.item-body > * { margin: 0 0 6px; }
.item-body > *:last-child { margin-bottom: 0; }
.item h3 { font-size: 17px; line-height: 1.3; color: var(--ink); overflow-wrap: anywhere; }
.num { color: var(--muted); }
.stage { color: var(--muted); font-size: 13px; font-weight: 700; }
.stage .cond { font-weight: 400; font-style: italic; }
.where { color: var(--muted); font-size: 13px; }
.steps { padding-left: 22px; }
.steps li { margin: 2px 0; }
.detail, .why, .endpoints { font-size: 14px; }
.detail { color: var(--muted); }
.confirm-note { padding: 6px 10px; border: 1px solid #d9a441; border-radius: 4px; background: #fef3c7; color: #5b3a06; font-weight: 600; }
.item-done { display: flex; flex-direction: column; justify-content: flex-end; }
.done-label { color: var(--muted); font-size: 12px; }
.fill { display: block; height: 30px; border-bottom: 1px solid #64748b; }
input[type="checkbox"] { appearance: none; -webkit-appearance: none; width: 22px; height: 22px; margin: 2px 0 0; border: 2px solid #334155; border-radius: 4px; background: #fff; vertical-align: middle; cursor: pointer; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
input[type="checkbox"]:checked { background: #334155 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3 8.5l3 3 7-7' fill='none' stroke='white' stroke-width='2.2'/%3E%3C/svg%3E") center / 80% no-repeat; }
.confirm-block { margin-top: 8px; padding: 10px 16px; border: 1px solid var(--line); border-radius: 6px; break-inside: avoid; }
.sign { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 14px; }
.sign > div { border-top: 1px solid #64748b; padding-top: 4px; color: var(--muted); font-size: 13px; }
.sign-space { height: 28px; }
footer.page-footer { margin-top: 28px; padding-top: 8px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
@media (max-width: 720px) {
  .item { grid-template-columns: 32px 1fr; }
  .item-done { grid-column: 2; }
}
@page { size: letter; margin: 0.7in 0.65in 0.8in; @bottom-left { content: "${footerLeft}${footerExtra ? ` \u00b7 ${footerExtra}` : ""}"; font: 8pt ${fontStack}; color: #475569; } @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8pt ${fontStack}; color: #475569; } }
@media print {
  body { background: #fff; font-size: 10.5pt; }
  .page { max-width: none; padding: 0; }
  .no-print { display: none !important; }
  .cover { padding-top: 8px; }
  h1 { font-size: 22pt; }
  .banner, .box, thead th, .confirm-note, .cover, .item { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  a { color: var(--accent); text-decoration: none; }
  .learn a::after { content: " (" attr(href) ")"; display: block; color: #475569; font-size: 7.5pt; overflow-wrap: anywhere; word-break: break-all; }
  footer.page-footer { display: none; }
  th, td { padding: 5px 7px; }
  .item { padding: 8px; }
  .where, .detail, .why, .endpoints, .stage { font-size: 9pt; }
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
<section class="box" aria-labelledby="howto"><h2 id="howto">How to use this guide</h2><ul>
${model.howToUse.map((line) => `<li>${esc(line)}</li>`).join("\n")}
</ul></section>
${model.notes.length ? `<section class="box" aria-labelledby="good-to-know"><h2 id="good-to-know">Good to know</h2>${model.notes.map((note) => `<p>${esc(note)}</p>`).join("")}</section>` : ""}
${model.roles.length > 1 ? `<div class="filter no-print"><label for="role-filter"><strong>Show items for</strong></label><select id="role-filter"><option value="all">Everyone (all items)</option>${roleOptions}</select></div>` : ""}
<p id="filter-note" hidden></p>
${model.workOrder.length ? `<section aria-labelledby="order-heading"><h2 id="order-heading">Order of work</h2>
<table class="order-table"><thead><tr><th scope="col">#</th><th scope="col">Setting</th><th scope="col">Stage</th><th scope="col">Who</th></tr></thead><tbody>
${workOrderRows}
</tbody></table></section>` : ""}
${model.roles.length ? `<section aria-labelledby="who-heading"><h2 id="who-heading">Who does what</h2>
<table class="who-table"><thead><tr><th scope="col">Who</th><th scope="col">What they do</th><th scope="col">Items</th></tr></thead><tbody>
${whoRows}
</tbody></table></section>` : ""}
${model.sections.map(sectionHtml).join("\n")}
<section class="confirm-block" aria-labelledby="confirm-heading"><h2 id="confirm-heading">Confirm and return</h2>
<p>${esc(model.confirm.line)}</p>
${contactBits}
<div class="sign">${model.confirm.fields.map((f) => `<div><div class="sign-space"></div>${esc(f)}</div>`).join("")}</div>
</section>
</main>
<footer class="page-footer">${esc(model.title)} \u2014 ${esc(model.documentTitle)}${model.footerText ? ` \u00b7 ${esc(model.footerText)}` : ""}</footer>
</div>
<script>${model.roles.length > 1 ? FILTER_SCRIPT : ""}</script>
</body>
</html>
`;
}
