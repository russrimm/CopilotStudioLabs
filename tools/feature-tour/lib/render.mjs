// Renders the static pages. Output is plain HTML with relative URLs only, so
// the site works from a GitHub Pages project path (/<repo>/) or any local
// server, and it loads nothing from outside the site.

export const REPO_URL = "https://github.com/russrimm/CopilotStudioLabs";

export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Catalog text marks UI names with **bold** and literals with `code`.
export function inline(text) {
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

export function learnTitle(url) {
  let slug = "";
  try {
    slug = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
  } catch {
    slug = url;
  }
  const words = slug.replace(/[-_]+/g, " ").trim();
  return words ? `Microsoft Learn: ${words.charAt(0).toUpperCase()}${words.slice(1)}` : "Microsoft Learn";
}

function harnessBadge(model, feature) {
  const group = model.harnesses.find((h) => h.id === feature.harnessGroup);
  return `<span class="badge badge-harness-${esc(group.id)}">${esc(group.short === "Both" ? "Both harnesses" : group.name)}</span>`;
}

function badges(model, feature) {
  const availability = model.availability.find((a) => a.id === feature.availability);
  return [
    harnessBadge(model, feature),
    `<span class="badge badge-level">${esc(feature.levelLabel)}</span>`,
    `<span class="badge badge-availability-${esc(availability.id)}">${esc(availability.label)}</span>`,
  ].join(" ");
}

function layout({ title, description, root, active, body, scripts = [], bodyClass = "" }) {
  const nav = [
    ["index.html", "Overview", "overview"],
    ["tour.html", "Guided tour", "tour"],
  ]
    .map(
      ([href, label, id]) =>
        `<a href="${root}${href}"${active === id ? ' aria-current="page"' : ""}>${label}</a>`,
    )
    .join("\n        ");
  const scriptTags = ["theme.js", ...scripts]
    .map((s) => `<script src="${root}assets/${s}" defer></script>`)
    .join("\n  ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <meta name="color-scheme" content="light dark">
  <link rel="icon" href="data:,">
  <link rel="stylesheet" href="${root}assets/styles.css">
  ${scriptTags}
</head>
<body class="${esc(bodyClass)}">
  <a class="skip-link" href="#main">Skip to main content</a>
  <header class="site-header">
    <div class="wrap header-row">
      <a class="brand" href="${root}index.html">Microsoft AI Training Generator feature tour</a>
      <nav aria-label="Primary" class="primary-nav">
        ${nav}
        <a href="${REPO_URL}/blob/main/docs/feature-tour.md">About and refresh guide</a>
      </nav>
      <button type="button" class="theme-toggle" id="theme-toggle" aria-pressed="false">Dark theme</button>
    </div>
  </header>
  <main id="main" tabindex="-1">
${body}
  </main>
  <footer class="site-footer">
    <div class="wrap">
      <p>Generated from the <a href="${REPO_URL}/blob/main/portal/lib/lab-builder/features.json">Microsoft AI Training Generator feature catalog</a>. This tour covers the Copilot Studio features; the other products in the catalog are not part of the tour yet. Explanations follow Microsoft Learn; check the linked pages for the latest steps. Screenshots marked pending have not been captured yet.</p>
    </div>
  </footer>
</body>
</html>
`;
}

function placeholder(shot) {
  const planned = shot.callouts.length
    ? `<p class="placeholder-label">Planned callouts</p><ol class="placeholder-callouts">${shot.callouts
        .map((c) => `<li>${esc(c.label)}</li>`)
        .join("")}</ol>`
    : "";
  return `<div class="shot-placeholder" data-pending>
          <p class="placeholder-title"><span aria-hidden="true">◌ </span>Screenshot pending</p>
          <p>${esc(shot.caption)}</p>
          <p class="placeholder-label">Where this screen is</p>
          <p>${esc(shot.navHint)}</p>
          <p class="placeholder-label">What the screenshot will show</p>
          <ul>${shot.instructions.map((i) => `<li>${inline(i)}</li>`).join("")}</ul>
          ${planned}
          <p class="placeholder-file">Planned file: <code>${esc(shot.filename)}</code></p>
        </div>`;
}

function shotFigure(feature, shot, root) {
  const label = `${feature.name}: ${shot.caption}`;
  let media;
  if (shot.status === "ready") {
    const size = shot.width && shot.height ? ` width="${shot.width}" height="${shot.height}"` : "";
    const hotspots = shot.callouts
      .filter((c) => c.rect)
      .map((c) => {
        const r = c.rect;
        return `<span class="hotspot" style="left:${(r.x * 100).toFixed(2)}%;top:${(r.y * 100).toFixed(2)}%;width:${(r.w * 100).toFixed(2)}%;height:${(r.h * 100).toFixed(2)}%"><span class="hotspot-n" aria-hidden="true">${c.n}</span></span>`;
      })
      .join("");
    media = `<div class="shot-frame"><img src="${root}${esc(shot.src)}" alt="${esc(label)}. The numbered callouts are listed below the image."${size} loading="lazy">${hotspots}</div>`;
  } else {
    media = placeholder(shot);
  }
  const callouts = shot.callouts.length
    ? `<ol class="callout-list">${shot.callouts
        .map(
          (c) =>
            `<li><span class="callout-n" aria-hidden="true">${c.n}</span><span><strong>${esc(c.label)}</strong>${c.note ? ` — ${esc(c.note)}` : ""}</span></li>`,
        )
        .join("")}</ol>`
    : "";
  return `<figure class="shot" id="shot-${esc(shot.filename.replace(/\.[^.]+$/, ""))}">
        ${media}
        <figcaption>${esc(shot.caption)}${shot.status === "ready" ? "" : " (screenshot pending)"}</figcaption>
        ${callouts}
      </figure>`;
}

function list(items, tag = "ul") {
  return items.length ? `<${tag}>${items.map((i) => `<li>${inline(i)}</li>`).join("")}</${tag}>` : "";
}

export function renderFeaturePage(model, feature, repoUrl = REPO_URL) {
  const root = "../";
  const idx = model.features.findIndex((f) => f.id === feature.id);
  const prev = model.features[idx - 1];
  const next = model.features[idx + 1];
  const category = model.categories.find((c) => c.id === feature.category);
  const group = model.harnesses.find((h) => h.id === feature.harnessGroup);

  const prereqs = feature.prereqs.length
    ? `<section aria-labelledby="h-prereq"><h2 id="h-prereq">Prerequisites</h2><ul>${feature.prereqs
        .map((p) => `<li><a href="${esc(p.id)}.html">${esc(p.name)}</a></li>`)
        .join("")}</ul></section>`
    : "";
  const caveats = feature.caveats.length
    ? `<section aria-labelledby="h-caveats"><h2 id="h-caveats">Caveats</h2>${list(feature.caveats)}</section>`
    : "";
  const ui = feature.uiPath.length
    ? `<p class="ui-path"><span class="ui-path-label">UI elements you will use:</span> ${feature.uiPath
        .map((t) => `<kbd>${esc(t)}</kbd>`)
        .join(" ")}</p>`
    : "";
  const labs = feature.relatedLabs.length
    ? `<section aria-labelledby="h-labs"><h2 id="h-labs">Hands-on labs</h2><ul>${feature.relatedLabs
        .map((l) => `<li><a href="${esc(repoUrl)}/tree/main/labs/${esc(l)}">${esc(l)}</a></li>`)
        .join("")}</ul></section>`
    : "";

  const body = `    <div class="wrap feature-page">
      <nav aria-label="Breadcrumb" class="breadcrumb"><a href="${root}index.html">Overview</a> <span aria-hidden="true">/</span> <span>${esc(group.name)}</span> <span aria-hidden="true">/</span> <span>${esc(category.name)}</span></nav>
      <h1>${esc(feature.name)}</h1>
      <p class="badges">${badges(model, feature)} <span class="badge badge-minutes">About ${esc(feature.minutes)} min</span></p>
      <p class="lede">${esc(feature.summary)}</p>
      <p class="tour-link"><a class="button" href="${root}tour.html#${esc(feature.id)}">View in the guided tour (step ${feature.order} of ${model.features.length})</a></p>

      <section aria-labelledby="h-why"><h2 id="h-why">Why it matters</h2><p>${esc(feature.whyItMatters)}</p></section>

      <section aria-labelledby="h-shots"><h2 id="h-shots">Screenshots</h2>
      ${feature.shots.map((s) => shotFigure(feature, s, root)).join("\n      ")}
      </section>

      <section aria-labelledby="h-where"><h2 id="h-where">Where to find it and what to click</h2>
        ${ui}
        ${list(feature.steps, "ol")}
        <p class="source-note">Steps follow <a href="${esc(feature.verifiedAgainst)}">${esc(learnTitle(feature.verifiedAgainst))}</a>, last compared with the live page on ${esc(feature.lastVerified)}.</p>
      </section>

      <section aria-labelledby="h-concepts"><h2 id="h-concepts">What to know</h2>${list(feature.concepts)}</section>
      ${prereqs}
      ${caveats}
      <section aria-labelledby="h-check"><h2 id="h-check">Check your work</h2>${list(feature.validation)}</section>
      <section aria-labelledby="h-learn"><h2 id="h-learn">Microsoft Learn</h2><ul>${feature.learn
        .map((l) => `<li><a href="${esc(l.url)}">${esc(learnTitle(l.url))}</a></li>`)
        .join("")}</ul></section>
      ${labs}

      <nav aria-label="Feature navigation" class="pager">
        ${prev ? `<a rel="prev" href="${esc(prev.id)}.html"><span class="pager-dir">Previous</span> ${esc(prev.name)}</a>` : "<span></span>"}
        ${next ? `<a rel="next" href="${esc(next.id)}.html"><span class="pager-dir">Next</span> ${esc(next.name)}</a>` : "<span></span>"}
      </nav>
    </div>`;

  return layout({
    title: `${feature.name} | Microsoft AI Training Generator feature tour`,
    description: feature.summary,
    root,
    active: "overview",
    body,
  });
}

function filterSelect(id, label, options) {
  return `<div class="field"><label for="${id}">${esc(label)}</label><select id="${id}" name="${id}"><option value="">All</option>${options
    .map(([value, text]) => `<option value="${esc(value)}">${esc(text)}</option>`)
    .join("")}</select></div>`;
}

function card(model, feature) {
  const category = model.categories.find((c) => c.id === feature.category);
  const group = model.harnesses.find((h) => h.id === feature.harnessGroup);
  const search = [feature.name, feature.summary, category.name, group.name, feature.levelLabel, feature.id]
    .join(" ")
    .toLowerCase();
  const shotLabel =
    feature.screenshotStatus === "ready"
      ? "Screenshots ready"
      : feature.screenshotStatus === "partial"
        ? "Some screenshots pending"
        : "Screenshot pending";
  return `<li class="card" data-harness="${esc(feature.harnessGroup)}" data-level="${feature.level}" data-category="${esc(feature.category)}" data-availability="${esc(feature.availability)}" data-shots="${esc(feature.screenshotStatus)}" data-search="${esc(search)}">
          <h3><a href="features/${esc(feature.id)}.html">${esc(feature.name)}</a></h3>
          <p class="badges">${badges(model, feature)}</p>
          <p class="card-summary">${esc(feature.summary)}</p>
          <p class="card-meta">${esc(category.name)} · ${esc(shotLabel)}</p>
        </li>`;
}

export function renderIndex(model) {
  const t = model.totals;
  const groups = model.harnesses
    .map((g) => {
      const items = model.features.filter((f) => f.harnessGroup === g.id);
      if (!items.length) return "";
      return `      <section class="group" data-group="${esc(g.id)}" aria-labelledby="g-${esc(g.id)}">
        <h2 id="g-${esc(g.id)}">${esc(g.name)} <span class="count">(<span data-group-count>${items.length}</span>)</span></h2>
        <p class="group-desc">${esc(g.description)}</p>
        <ul class="cards">
        ${items.map((f) => card(model, f)).join("\n        ")}
        </ul>
      </section>`;
    })
    .join("\n");

  const body = `    <div class="wrap">
      <section class="hero" aria-labelledby="page-title">
        <h1 id="page-title">Every Copilot Studio feature in the lab catalog, explained</h1>
        <p class="lede">${t.features} features across the Standard harness, the Microsoft Copilot harness, and the Customer Conversation harness. Each one has an explanation, the path to follow in Copilot Studio, prerequisites, caveats, Microsoft Learn links, and a screenshot slot. ${t.shotsReady} of ${t.shots} screenshots are captured so far.</p>
        <p><a class="button" href="tour.html">Start the guided tour</a></p>
      </section>

      <form class="filters" id="filters" role="search" aria-label="Filter features">
        <div class="field field-search"><label for="f-q">Search features</label><input id="f-q" name="q" type="search" autocomplete="off" placeholder="For example: MCP, knowledge, publish"></div>
        ${filterSelect("f-harness", "Harness", model.harnesses.map((h) => [h.id, h.name]))}
        ${filterSelect("f-level", "Level", model.levels.map((l) => [String(l.value), l.label]))}
        ${filterSelect("f-category", "Category", model.categories.map((c) => [c.id, c.name]))}
        ${filterSelect("f-availability", "Availability", model.availability.map((a) => [a.id, a.label]))}
        ${filterSelect("f-shots", "Screenshot", [["ready", "Captured"], ["partial", "Partly captured"], ["pending", "Pending"]])}
        <div class="field field-reset"><button type="button" id="f-reset">Reset filters</button></div>
      </form>
      <p id="results-status" class="results-status" role="status" aria-live="polite">Showing all ${t.features} features.</p>
      <p id="no-results" class="no-results" hidden>No features match these filters. Reset the filters to see everything.</p>

${groups}
    </div>`;

  return layout({
    title: "Microsoft AI Training Generator feature tour",
    description: "Screenshots, explanations, and a guided tour for every Copilot Studio feature in the Microsoft AI Training Generator catalog.",
    root: "",
    active: "overview",
    body,
    scripts: ["filter.js"],
  });
}

export function renderTour(model) {
  const total = model.features.length;
  const options = model.harnesses
    .map((g) => {
      const items = model.features.filter((f) => f.harnessGroup === g.id);
      if (!items.length) return "";
      return `<optgroup label="${esc(g.name)}">${items
        .map((f) => `<option value="${esc(f.id)}">${f.order}. ${esc(f.name)}</option>`)
        .join("")}</optgroup>`;
    })
    .join("");

  const data = JSON.stringify({
    total,
    harnesses: model.harnesses,
    categories: model.categories,
    availability: model.availability,
    features: model.features,
  }).replace(/</g, "\\u003c");

  const body = `    <div class="wrap tour" id="tour" aria-labelledby="tour-title">
      <h1 id="tour-title">Guided tour</h1>
      <p class="tour-help" id="tour-help">Step through every feature in order: by harness, then category, then level. Use the Previous and Next buttons or the Left and Right arrow keys. Home and End jump to the first and last step.</p>
      <div class="tour-controls" role="group" aria-label="Tour controls" aria-describedby="tour-help">
        <button type="button" id="tour-prev">Previous</button>
        <div class="field field-jump"><label for="tour-jump">Jump to step</label><select id="tour-jump">${options}</select></div>
        <button type="button" id="tour-next">Next</button>
      </div>
      <div class="progress">
        <div class="progress-track" id="tour-progress" role="progressbar" aria-label="Tour progress" aria-valuemin="1" aria-valuemax="${total}" aria-valuenow="1"><span class="progress-bar" id="tour-bar"></span></div>
        <p id="tour-progress-text" class="progress-text">Step 1 of ${total}</p>
      </div>
      <div id="tour-status" class="visually-hidden" role="status" aria-live="polite"></div>
      <article id="tour-step" class="tour-step" tabindex="-1"></article>
      <noscript><p class="no-script">The guided tour needs JavaScript. You can read every feature without it from the <a href="index.html">overview</a>.</p></noscript>
    </div>
    <script type="application/json" id="tour-data">${data}</script>`;

  return layout({
    title: "Guided tour | Microsoft AI Training Generator feature tour",
    description: "Step through every Copilot Studio feature in the lab catalog with screenshots and callouts.",
    root: "",
    active: "tour",
    body,
    scripts: ["tour.js"],
    bodyClass: "page-tour",
  });
}
