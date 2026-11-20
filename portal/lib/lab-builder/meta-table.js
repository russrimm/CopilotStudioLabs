/**
 * The metadata table at the top of a lab (Field | Details) for a person reading it.
 *
 * The Markdown keeps the whole table because tools read it: DIFFICULTY, TIME, PRODUCTS, TAGS, and INDUSTRIES are
 * required rows. A reader needs less. The "Field | Details" header says nothing, DIFFICULTY repeats LEVEL ("Beginner"
 * and "Level 100 (Beginner)"), and TAGS are search keywords, not information for someone about to do the lab. In the
 * HTML (the portal preview and the standalone lab) the table is shown without them, with each label as a row header.
 */

const META_TABLE = /<table>\s*<thead>\s*<tr>\s*<th[^>]*>\s*Field\s*<\/th>\s*<th[^>]*>\s*Details\s*<\/th>\s*<\/tr>\s*<\/thead>\s*<tbody>([\s\S]*?)<\/tbody>\s*<\/table>/i;

const labelOf = (row) => /<strong>([^<]+)<\/strong>/i.exec(row)?.[1]?.trim().toUpperCase() ?? "";

/** @param {string} html rendered lab HTML; only the first Field | Details table is touched */
export function tidyMetaTable(html) {
  return String(html).replace(META_TABLE, (whole, body) => {
    const rows = body.match(/<tr>[\s\S]*?<\/tr>/gi) || [];
    if (!rows.length) return whole;
    const labels = new Set(rows.map(labelOf));
    const kept = rows
      .filter((row) => {
        const label = labelOf(row);
        return label !== "TAGS" && !(label === "DIFFICULTY" && labels.has("LEVEL"));
      })
      .map((row) => row.replace(/<td>/i, '<th scope="row">').replace(/<\/td>/i, "</th>"));
    return kept.length ? `<table class="lab-meta"><tbody>${kept.join("")}</tbody></table>` : whole;
  });
}

export const META_TABLE_CSS = `
.lab-meta { width: auto; max-width: 100%; }
.lab-meta th[scope="row"] { white-space: nowrap; width: 1%; background: var(--surface-muted, #f6f8fa); font-weight: 600; }
.lab-meta td { min-width: 12rem; }
`;
