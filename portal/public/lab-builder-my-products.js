/* "Add another Microsoft product from Learn": pick a documentation hub from a reviewed list, or search Microsoft Learn,
 * and it joins the Product step. Saved on the server (see portal/lib/lab-builder/user-products.js).
 * Loaded after lab-builder-wizard.js; it reuses the wizard's product list, refresh, and escapeHtml helpers. */

const lbProd = { busy: false, picklist: [], added: [], results: [], loaded: false };

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
  if (results) {
    results.innerHTML = lbProd.results
      .map((item, index) => {
        const options = item.roots
          .map((root) => `<option value="${escapeHtml(root.root)}"${root.coveredBy ? " disabled" : ""}>${escapeHtml(root.root.replace("https://learn.microsoft.com", ""))}${root.coveredBy ? ` (covered by ${escapeHtml(root.coveredBy)})` : ""}</option>`)
          .join("");
        return `<li class="lb-mine-result">
          <span class="lb-mine-result-title"><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}<span class="sr-only"> (opens in a new tab)</span></a></span>
          <span class="lb-mine-result-action">
            <label for="lb-addprod-root-${index}">Use everything under</label>
            <select id="lb-addprod-root-${index}" class="lb-mine-input">${options}</select>
            <button type="button" class="btn btn-sm btn-primary" data-addprod-root="${index}">Add as a product</button>
          </span>
        </li>`;
      })
      .join("");
  }
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
    lbProd.results = [];
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
    lbProd.results = data.results || [];
    lbProdRender();
    lbProdSetStatus(lbProd.results.length ? `${lbProd.results.length} result${lbProd.results.length === 1 ? "" : "s"}. Choose where the product's documentation starts.` : "Nothing found. Try other words.", false);
  } catch (err) {
    lbProd.results = [];
    lbProdRender();
    lbProdSetStatus(lbProdMessage(err), true);
  } finally {
    lbProd.busy = false;
  }
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
    const item = lbProd.picklist[Number(lbProdEl("lb-addprod-pick")?.value)];
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
    if (target.dataset.addprodRoot !== undefined) lbProdAdd(lbProdEl(`lb-addprod-root-${target.dataset.addprodRoot}`)?.value);
    else if (target.dataset.addprodRemove !== undefined) lbProdRemove(target.dataset.addprodRemove);
  });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", lbProdBind);
  else lbProdBind();
}
