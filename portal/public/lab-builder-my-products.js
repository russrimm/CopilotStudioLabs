/* "Add another Microsoft product from Learn": pick a documentation hub from a reviewed list, or search Microsoft Learn,
 * and it joins the Product step. Saved on the server (see portal/lib/lab-builder/user-products.js).
 * Loaded after lab-builder-wizard.js; it reuses the wizard's product list, refresh, and escapeHtml helpers. */

const lbProd = { busy: false, picklist: [], added: [], groups: [], hidden: null, chosen: {}, loaded: false };

function lbProdEl(id) {
  return document.getElementById(id);
}

function lbProdSetStatus(text, isError) {
  const status = lbProdEl("lb-addprod-status");
  if (!status) return;
  status.textContent = text || "";
  status.classList.toggle("lb-error", Boolean(isError));
}

async function lbProdCall(path, method, body) {
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
    throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status, data, wait: res.headers?.get?.("Retry-After") });
  }
  return data;
}

/** The text of an error with one closing period and the retry hint when there is one. */
function lbProdMessage(err) {
  return `${String(err.message).replace(/[.\s]*$/, ".")}${err.wait ? ` Try again in ${err.wait} seconds.` : ""}`;
}

async function lbProdLoadPicklist() {
  try {
    const data = await lbProdCall("/api/lab-builder/products/picklist", "GET");
    lbProd.picklist = data.products || [];
    lbProd.added = data.added || [];
    lbProd.loaded = true;
    lbProdRender();
  } catch (err) {
    lbProdSetStatus("The list of Microsoft products is unavailable right now.", true);
  }
}

function lbProdRender() {
  const select = lbProdEl("lb-addprod-pick");
  if (select) {
    // The server sends the picklist A to Z; each option's value is its place in lbProd.picklist, which the add button reads back.
    const options = lbProd.picklist
      .map((item, index) => {
        const state = item.addedId ? " (added)" : item.coveredBy ? ` (already covered by ${item.coveredBy})` : "";
        return `<option value="${index}"${item.addedId || item.coveredBy ? " disabled" : ""}>${escapeHtml(item.name)}${escapeHtml(state)}</option>`;
      })
      .join("");
    select.innerHTML = `<option value="">Choose a product...</option>${options}`;
  }
  const saved = lbProdEl("lb-addprod-saved");
  if (saved) {
    saved.innerHTML = lbProd.added.length
      ? `<h4 class="lb-mine-heading">Products you added (${lbProd.added.length})</h4><ul class="lb-mine-results">${lbProd.added
          .map(
            (product) =>
              `<li class="lb-mine-result"><span class="lb-mine-result-title">${escapeHtml(product.name)}</span> <button type="button" class="btn btn-sm" data-addprod-remove="${escapeHtml(product.id)}" aria-label="Remove ${escapeHtml(product.name)} from my products">Remove</button></li>`,
          )
          .join("")}</ul>`
      : "";
  }
  const results = lbProdEl("lb-addprod-results");
  if (results) results.innerHTML = lbProdResultsHtml();
}

/** The matching pages of one group: a count, then each page title as a link that opens in a new tab. */
function lbProdPagesHtml(group, index) {
  const count = group.pages.length;
  const links = group.pages
    .map((page) => `<li><a href="${escapeHtml(page.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(page.title)}<span class="sr-only"> (opens in a new tab)</span></a></li>`)
    .join("");
  return `<p class="lb-scope-pages" id="lb-addprod-pages-${index}">${count} matching page${count === 1 ? "" : "s"}</p><ul class="lb-scope-links">${links}</ul>`;
}

/** One scope as a radio: its plain name (with Recommended when it is), what choosing it means, and its address as quiet text. */
function lbProdScopeHtml(scope, groupIndex, scopeIndex, chosen) {
  const id = `lb-addprod-scope-${groupIndex}-${scopeIndex}`;
  const covered = Boolean(scope.coveredBy);
  const badge = scope.recommended ? ' <span class="lb-scope-badge">Recommended</span>' : "";
  return `<label class="lb-scope-option${covered ? " is-covered" : ""}" for="${id}">
      <input type="radio" id="${id}" name="lb-addprod-scope-${groupIndex}" value="${escapeHtml(scope.root)}" data-addprod-scope="${groupIndex}"${scope.root === chosen ? " checked" : ""}${covered ? " disabled" : ""} aria-labelledby="${id}-name" aria-describedby="${id}-note ${id}-path">
      <span class="lb-scope-text">
        <span class="lb-scope-label" id="${id}-name">${escapeHtml(scope.label)}${badge}</span>
        <span class="lb-scope-note" id="${id}-note">${escapeHtml(scope.note)}</span>
        <span class="lb-scope-path" id="${id}-path">${escapeHtml(scope.path)}</span>
      </span>
    </label>`;
}

/** One documentation hub: its pages and its scopes, or one sentence when everything in it is already covered. */
function lbProdGroupHtml(group, index) {
  if (group.allCovered) {
    const by = group.coveredBy.length ? group.coveredBy.join(" and ") : "a product in the list";
    return `<li class="lb-mine-result lb-scope-group">
      <span class="lb-scope-name">${escapeHtml(group.name)}</span>
      <p class="lb-scope-covered">Already covered by ${escapeHtml(by)}, so there is nothing to add.</p>
      ${lbProdPagesHtml(group, index)}
    </li>`;
  }
  const chosen = lbProd.chosen[index];
  return `<li class="lb-mine-result lb-scope-group">
      <fieldset class="lb-scope-set" aria-describedby="lb-addprod-pages-${index}">
        <legend class="lb-scope-name">${escapeHtml(group.name)}</legend>
        ${lbProdPagesHtml(group, index)}
        <div class="lb-scope-options">${group.scopes.map((scope, scopeIndex) => lbProdScopeHtml(scope, index, scopeIndex, chosen)).join("")}</div>
        <p class="lb-scope-actions"><button type="button" class="btn btn-sm btn-primary" data-addprod-root="${index}">Add as a product</button></p>
      </fieldset>
    </li>`;
}

function lbProdResultsHtml() {
  const hidden = lbProd.hidden;
  const note = hidden?.count
    ? `<li class="lb-scope-hidden">Hidden: ${hidden.count} result${hidden.count === 1 ? "" : "s"} that ${hidden.count === 1 ? "is" : "are"} not product documentation${hidden.kinds?.length ? ` (${escapeHtml(hidden.kinds.join(", "))})` : ""}.</li>`
    : "";
  return lbProd.groups.map(lbProdGroupHtml).join("") + note;
}

/** Reload the product list the Product step shows, keeping what is selected. */
async function lbProdReloadProducts() {
  const res = await fetch("/api/lab-builder/features");
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  const data = await res.json();
  labBuilder.products = data.products || [];
  for (const id of [...labBuilder.selectedProducts]) if (!labBuilder.products.some((p) => p.id === id)) labBuilder.selectedProducts.delete(id);
  lbRenderProducts();
}

async function lbProdAdd(root, name) {
  if (lbProd.busy || !root) return;
  lbProd.busy = true;
  lbProdSetStatus("Reading the documentation hub from Microsoft Learn...", false);
  try {
    const data = await lbProdCall("/api/lab-builder/products/mine", "POST", name ? { root, name } : { root });
    lbProd.groups = [];
    lbProd.hidden = null;
    lbProdRender();
    await lbProdReloadProducts();
    labBuilder.selectedProducts.add(data.product.id);
    labBuilder.chosenSteps.add("product");
    lbProductsChanged();
    await lbProdLoadPicklist();
    lbProdSetStatus(`Added "${data.product.name}" and selected it. Its topics are read from Microsoft Learn next; this can take a minute.`, false);
    await lbRefreshLearn();
    lbProdSetStatus(`Added "${data.product.name}". Its Microsoft Learn topics are in the Topics step.`, false);
  } catch (err) {
    lbProdSetStatus(lbProdMessage(err), true);
  } finally {
    lbProd.busy = false;
  }
}

async function lbProdSearch() {
  const input = lbProdEl("lb-addprod-input");
  if (!input || lbProd.busy) return;
  const query = input.value.trim();
  if (!query) {
    lbProdSetStatus("Type a product or topic to search Microsoft Learn for.", true);
    return;
  }
  lbProd.busy = true;
  lbProdSetStatus("Searching Microsoft Learn...", false);
  try {
    const data = await lbProdCall("/api/lab-builder/products/mine/search", "POST", { query });
    lbProd.groups = data.groups || [];
    lbProd.hidden = data.hidden || null;
    // Each group starts on the recommended scope; a person's own choice is kept in lbProd.chosen by the change handler.
    lbProd.chosen = {};
    lbProd.groups.forEach((group, index) => {
      const pick = group.scopes?.find((scope) => scope.recommended && !scope.coveredBy);
      if (pick) lbProd.chosen[index] = pick.root;
    });
    lbProdRender();
    lbProdSetStatus(lbProdSearchMessage(), false);
  } catch (err) {
    lbProd.groups = [];
    lbProd.hidden = null;
    lbProdRender();
    lbProdSetStatus(lbProdMessage(err), true);
  } finally {
    lbProd.busy = false;
  }
}

/** One sentence about what the search found: how many places to start, or why there is nothing to add. */
function lbProdSearchMessage() {
  const open = lbProd.groups.filter((group) => !group.allCovered).length;
  const count = lbProd.groups.length;
  if (open) return `${open} documentation area${open === 1 ? "" : "s"} found. Check where its documentation starts, then add it.`;
  if (count) return "Everything found is already covered by a product in your list, so there is nothing to add.";
  if (lbProd.hidden?.count) return "Nothing to add from this search. Try the product's name.";
  return "Nothing found. Try other words.";
}

async function lbProdRemove(id) {
  if (lbProd.busy) return;
  lbProd.busy = true;
  try {
    await lbProdCall(`/api/lab-builder/products/mine/${encodeURIComponent(id)}`, "DELETE");
    labBuilder.selectedProducts.delete(id);
    await lbProdReloadProducts();
    lbProductsChanged();
    await lbProdLoadPicklist();
    lbProdSetStatus("Removed. Labs you already built for it are not changed.", false);
  } catch (err) {
    lbProdSetStatus(lbProdMessage(err), true);
  } finally {
    lbProd.busy = false;
  }
}

function lbProdBind() {
  const panel = lbProdEl("lb-addprod");
  if (!panel || panel._lbProdBound) return;
  panel._lbProdBound = true;
  panel.addEventListener("toggle", () => {
    if (panel.open && !lbProd.loaded) lbProdLoadPicklist();
  });
  lbProdEl("lb-addprod-add")?.addEventListener("click", () => {
    const chosen = lbProdEl("lb-addprod-pick")?.value;
    const item = chosen ? lbProd.picklist[Number(chosen)] : null;
    if (!item) lbProdSetStatus("Choose a product from the list first.", true);
    else lbProdAdd(item.root, item.name);
  });
  lbProdEl("lb-addprod-go")?.addEventListener("click", lbProdSearch);
  lbProdEl("lb-addprod-input")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      lbProdSearch();
    }
  });
  panel.addEventListener("click", (event) => {
    const target = event.target?.closest?.("[data-addprod-root],[data-addprod-remove]");
    if (!target) return;
    if (target.dataset.addprodRoot !== undefined) {
      const root = lbProd.chosen[target.dataset.addprodRoot];
      if (root) lbProdAdd(root);
      else lbProdSetStatus("Choose where the product's documentation starts first.", true);
    } else if (target.dataset.addprodRemove !== undefined) lbProdRemove(target.dataset.addprodRemove);
  });
  // A radio's change bubbles up here; the choice is kept per group so the add button reads it without touching the page.
  panel.addEventListener("change", (event) => {
    const input = event.target;
    if (input?.dataset?.addprodScope !== undefined && input.value) lbProd.chosen[input.dataset.addprodScope] = input.value;
  });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", lbProdBind);
  else lbProdBind();
}
