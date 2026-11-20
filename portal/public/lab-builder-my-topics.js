/* "Add a topic from Microsoft Learn": search or paste a link, add it to the Topics step, remove it later.
 * Topics are saved on the server (see portal/lib/lab-builder/user-topics.js), so they are there next time.
 * Loaded after lab-builder-wizard.js; the wizard calls lbMineRender() whenever the topic list reloads. */

const lbMine = { busy: false, results: [], message: "" };

function lbMineEl(id) {
  return document.getElementById(id);
}

function lbMineSetStatus(text, isError) {
  const status = lbMineEl("lb-mine-status");
  if (!status) return;
  status.textContent = text || "";
  status.classList.toggle("lb-error", Boolean(isError));
}

async function lbMineCall(path, method, body) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* a non-JSON failure is reported by status below */
  }
  if (!res.ok) {
    const wait = res.headers?.get?.("Retry-After");
    throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status, data, wait });
  }
  return data;
}

function lbMineLooksLikeLink(text) {
  return /^https?:\/\//i.test(String(text || "").trim());
}

/** Select a topic in the list the wizard shows, then reload it. */
async function lbMineSelect(id) {
  const rec = labBuilder.rec;
  const chosen = new Set(labBuilder.picked || rec?.selectedIds || []);
  chosen.add(id);
  labBuilder.picked = chosen;
  await lbRefresh();
}

function lbMineRenderResults() {
  const list = lbMineEl("lb-mine-results");
  if (!list) return;
  list.innerHTML = lbMine.results
    .map((item, index) => {
      const product = item.productName ? `<span class="lb-badge lb-badge-product">${escapeHtml(item.productName)}</span>` : "";
      let action;
      if (item.inList) {
        action = `<span class="lb-feature-note">Already in your list as "${escapeHtml(item.inList.title)}".</span> <button type="button" class="btn btn-sm" data-mine-select="${escapeHtml(item.inList.id)}">Select it</button>`;
      } else if (item.addable) {
        action = `<button type="button" class="btn btn-sm btn-primary" data-mine-add="${index}">Add to my topics</button>`;
      } else {
        action = '<span class="lb-feature-note">This page is not under a product the builder covers yet, so it cannot join a lab.</span>';
      }
      return `<li class="lb-mine-result">
        <span class="lb-mine-result-title"><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}<span class="sr-only"> (opens in a new tab)</span></a> ${product}</span>
        ${item.summary ? `<span class="lb-feature-summary">${escapeHtml(item.summary)}</span>` : ""}
        <span class="lb-mine-result-action">${action}</span>
      </li>`;
    })
    .join("");
}

function lbMineRenderMine() {
  const host = lbMineEl("lb-mine-saved");
  if (!host) return;
  const mine = (labBuilder.learn?.topics || []).filter((topic) => topic.userAdded);
  if (!mine.length) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML = `<h4 class="lb-mine-heading">Topics you added (${mine.length})</h4><ul class="lb-mine-results">${mine
    .map(
      (topic) =>
        `<li class="lb-mine-result"><span class="lb-mine-result-title">${escapeHtml(topic.title)}</span> <button type="button" class="btn btn-sm" data-mine-remove="${escapeHtml(topic.id)}" aria-label="Remove ${escapeHtml(topic.title)} from my topics">Remove</button></li>`,
    )
    .join("")}</ul>`;
}

/** Called by the wizard after the topic list loads or refreshes. */
function lbMineRender() {
  lbMineRenderMine();
}

async function lbMineSearch() {
  const input = lbMineEl("lb-mine-input");
  if (!input || lbMine.busy) return;
  const text = input.value.trim();
  if (!text) {
    lbMineSetStatus("Type a search or paste a learn.microsoft.com link.", true);
    return;
  }
  lbMine.busy = true;
  lbMineSetStatus(lbMineLooksLikeLink(text) ? "Checking the link..." : "Searching Microsoft Learn...", false);
  try {
    if (lbMineLooksLikeLink(text)) {
      lbMine.results = [{ title: text, url: text, summary: "", productName: null, addable: true, inList: null, link: true }];
      lbMineRenderResults();
      lbMineSetStatus("Select Add to my topics to read the page and add it.", false);
    } else {
      const data = await lbMineCall("/api/lab-builder/topics/mine/search", "POST", { query: text });
      lbMine.results = data.results || [];
      lbMineRenderResults();
      lbMineSetStatus(lbMine.results.length ? `${lbMine.results.length} result${lbMine.results.length === 1 ? "" : "s"} from Microsoft Learn.` : "Nothing found. Try other words, or paste a link.", false);
    }
  } catch (err) {
    lbMine.results = [];
    lbMineRenderResults();
    lbMineSetStatus(`${String(err.message).replace(/[.\s]*$/, ".")}${err.wait ? ` Try again in ${err.wait} seconds.` : ""}`, true);
  } finally {
    lbMine.busy = false;
  }
}

async function lbMineAdd(index) {
  const item = lbMine.results[index];
  if (!item || lbMine.busy) return;
  lbMine.busy = true;
  lbMineSetStatus("Reading the page from Microsoft Learn...", false);
  try {
    const body = { url: item.url };
    if ([100, 200, 300].includes(labBuilder.level)) body.level = labBuilder.level;
    if (labBuilder.harness) body.harness = labBuilder.harness;
    const data = await lbMineCall("/api/lab-builder/topics/mine", "POST", body);
    lbMine.results = [];
    lbMineRenderResults();
    lbMineSetStatus(`Added "${data.topic.title}". It is selected below and saved for next time.`, false);
    await lbLoadLearn();
    await lbMineSelect(data.topic.id);
  } catch (err) {
    if (err.status === 409 && err.data?.topic) {
      lbMineSetStatus(`${err.message} It is selected below.`, false);
      await lbMineSelect(err.data.topic.id);
    } else {
      lbMineSetStatus(String(err.message).replace(/[.\s]*$/, "."), true);
    }
  } finally {
    lbMine.busy = false;
  }
}

async function lbMineRemove(id) {
  if (lbMine.busy) return;
  lbMine.busy = true;
  try {
    await lbMineCall(`/api/lab-builder/topics/mine/${encodeURIComponent(id)}`, "DELETE");
    if (labBuilder.picked) labBuilder.picked.delete(id);
    lbMineSetStatus("Removed from your topics. Labs you already built from it are not changed.", false);
    await lbLoadLearn();
    await lbRefresh();
  } catch (err) {
    lbMineSetStatus(String(err.message).replace(/[.\s]*$/, "."), true);
  } finally {
    lbMine.busy = false;
  }
}

function lbMineBind() {
  const panel = lbMineEl("lb-mine");
  if (!panel || panel._lbMineBound) return;
  panel._lbMineBound = true;
  lbMineEl("lb-mine-go")?.addEventListener("click", lbMineSearch);
  lbMineEl("lb-mine-input")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      lbMineSearch();
    }
  });
  panel.addEventListener("click", (event) => {
    const target = event.target?.closest?.("[data-mine-add],[data-mine-select],[data-mine-remove]");
    if (!target) return;
    if (target.dataset.mineAdd !== undefined) lbMineAdd(Number(target.dataset.mineAdd));
    else if (target.dataset.mineSelect !== undefined) lbMineSelect(target.dataset.mineSelect);
    else if (target.dataset.mineRemove !== undefined) lbMineRemove(target.dataset.mineRemove);
  });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", lbMineBind);
  else lbMineBind();
}
