// Build a Lab: the "Training decks: deliver these first" group in the lab panel and on the wizard's last step.
// Loaded after generated-labs.js, whose lbGeneratedActionButtonsHtml puts the group above the lab downloads.
// It lists the pre-lab training decks (a complete deck, foundations, and one per topic with time estimates) and
// downloads them. No modals and no copy buttons; every control is a real link or button.

const lbTraining = { lists: new Map(), bound: false };

function lbTrainingEscape(value) {
  if (typeof escapeHtml === "function") return escapeHtml(value);
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function lbTrainingMinutes(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  if (typeof lbFormatMinutes === "function") return lbFormatMinutes(total);
  if (total < 60) return `${total} minutes`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${hours} hour${hours === 1 ? "" : "s"} ${rest} minutes` : `${hours} hour${hours === 1 ? "" : "s"}`;
}

function lbTrainingScope(labId, scopePrefix) {
  return `${scopePrefix || "lb-zip-fmt-result"}-training-${String(labId).replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/** The group: a heading, one calm line, the two main downloads, and a button that lists the decks by topic. */
function lbTrainingDecksGroupHtml(labId, title, scopePrefix) {
  if (!labId) return "";
  const safeId = lbTrainingEscape(labId);
  const encodedId = encodeURIComponent(labId);
  const displayTitle = String(title || "Lab").trim() || "Lab";
  const safeTitle = lbTrainingEscape(displayTitle);
  const base = lbTrainingScope(labId, scopePrefix);
  return `
    <section class="lb-training-group" aria-labelledby="${base}-heading" data-lab-id="${safeId}">
      <h4 id="${base}-heading" class="lb-training-heading">Training decks: deliver these first</h4>
      <p class="lb-training-note">For people who are new to this. No lab steps.</p>
      <div class="lb-training-actions">
        <a class="btn btn-sm btn-primary lb-download-link" href="/api/lab-builder/generated/${encodedId}/training/complete/pptx" download="Training deck - Complete.pptx" aria-label="Download complete training deck for ${safeTitle}">Download complete training deck</a>
        <a class="btn btn-sm lb-download-link" href="/api/lab-builder/generated/${encodedId}/export?format=training-foundations" download aria-label="Download foundations training deck for ${safeTitle}">Download foundations</a>
        <button type="button" class="btn btn-sm" data-training-action="toggle" data-lab-id="${safeId}" aria-expanded="false" aria-controls="${base}-list">Show training decks by topic</button>
      </div>
      <div id="${base}-list" class="lb-training-list" data-lab-id="${safeId}" hidden></div>
    </section>`;
}

/** The decks by topic, with a time on each and a plain "Unreviewed" or "Learn page changed" chip where one applies. */
function lbTrainingListHtml(labId, data) {
  const encodedId = encodeURIComponent(labId);
  const decks = Array.isArray(data?.decks) ? data.decks : [];
  if (!decks.length) return `<p class="lb-training-empty" role="status">No training decks yet for this lab.</p>`;
  const label = (deck) => {
    if (deck.kind === "foundations") return "Foundations";
    if (deck.kind === "complete") return "All parts";
    const raw = String(deck.stepLabel || `Step ${deck.order}`);
    return typeof lbGenModuleLabel === "function" ? lbGenModuleLabel(raw) : raw;
  };
  const row = (deck) => {
    const shown = label(deck);
    const name = String(deck.title || shown);
    const chips = [];
    if (deck.unreviewed) chips.push(`<span class="tag lb-training-chip">Unreviewed: check before you present</span>`);
    if (deck.learnChanged) chips.push(`<span class="tag lb-training-chip lb-training-chip-changed">Learn page changed</span>`);
    const href = `/api/lab-builder/generated/${encodedId}/training/${encodeURIComponent(deck.key)}/pptx`;
    return `
        <li class="lb-training-item">
          <div class="lb-training-item-info">
            <span class="lb-prereq-req-badge${deck.kind === "foundations" ? "" : /^recap\b/i.test(String(deck.stepLabel || "")) ? " lb-prereq-req-badge-recap" : ""}">${lbTrainingEscape(shown)}</span>
            <strong class="lb-training-item-title">${lbTrainingEscape(name)}</strong>
            <span class="lb-training-time">about ${Number(deck.minutes) || 0} min</span>
            ${chips.join("")}
          </div>
          <a class="btn btn-sm lb-training-item-btn" href="${href}" download="${lbTrainingEscape(deck.fileName || "Training deck.pptx")}" aria-label="Download training deck for ${lbTrainingEscape(shown)}: ${lbTrainingEscape(name)}">Download</a>
        </li>`;
  };
  const foundations = decks.filter((d) => d.kind === "foundations");
  const topics = decks.filter((d) => d.kind === "topic");
  const section = (heading, rows) =>
    rows.length ? `<h5 class="lb-training-subheading">${heading}</h5><ul class="lb-training-items" aria-label="${heading}">${rows.map(row).join("")}</ul>` : "";
  return `
      <p class="lb-training-summary">About ${lbTrainingEscape(lbTrainingMinutes(data.totalMinutes))} of training, then about ${lbTrainingEscape(lbTrainingMinutes(data.handsOnMinutes))} hands-on.</p>
      ${section("Foundations", foundations)}
      ${section("Topics", topics)}`;
}

/** Fetch the list once per open lab and show it. A failure says so and can be retried by pressing the button again. */
async function lbTrainingLoadList(labId, host, { force = false } = {}) {
  if (!host) return null;
  if (!force && lbTraining.lists.has(labId)) {
    host.innerHTML = lbTrainingListHtml(labId, lbTraining.lists.get(labId));
    return lbTraining.lists.get(labId);
  }
  host.innerHTML = `<p class="lb-training-empty" role="status">Loading the training decks...</p>`;
  try {
    const res = await fetch(`/api/lab-builder/generated/${encodeURIComponent(labId)}/training`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    lbTraining.lists.set(labId, data);
    host.innerHTML = lbTrainingListHtml(labId, data);
    return data;
  } catch (err) {
    host.innerHTML = `<p class="lb-training-empty" role="alert">Could not load the training decks: ${lbTrainingEscape(err.message)}</p>`;
    return null;
  }
}

async function lbTrainingToggle(button) {
  const labId = button.getAttribute("data-lab-id");
  const list = document.getElementById(button.getAttribute("aria-controls"));
  if (!labId || !list) return;
  const opening = button.getAttribute("aria-expanded") !== "true";
  button.setAttribute("aria-expanded", opening ? "true" : "false");
  button.textContent = opening ? "Hide training decks by topic" : "Show training decks by topic";
  list.hidden = !opening;
  if (opening) await lbTrainingLoadList(labId, list, { force: true });
}

function lbTrainingBind() {
  if (lbTraining.bound || typeof document === "undefined" || !document.addEventListener) return;
  lbTraining.bound = true;
  document.addEventListener("click", (event) => {
    const target = event.target;
    const button = target && typeof target.closest === "function" ? target.closest("[data-training-action]") : null;
    if (!button) return;
    if (button.getAttribute("data-training-action") === "toggle") {
      event.preventDefault?.();
      lbTrainingToggle(button);
    }
  });
}

lbTrainingBind();
