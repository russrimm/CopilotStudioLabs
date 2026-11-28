/* "Add another Microsoft product from Learn": pick a documentation hub from a reviewed list, or search Microsoft Learn,
 * and it joins the Product step. Saved on the server (see portal/lib/lab-builder/user-products.js).
 * Also the one place a product you added is explained and removed: its card in the Product step (lbProdCardNotesHtml and
 * lbProdCardActionsHtml, called by the wizard's lbRenderProducts) and the Products you added list below both end in lbProdRemove.
 * Loaded after lab-builder-wizard.js; it reuses the wizard's product list, refresh, and escapeHtml helpers. */

const lbProd = { busy: false, picklist: [], added: [], groups: [], hidden: null, chosen: {}, loaded: false, confirming: null, undo: null, notice: null };

function lbProdEl(id) {
  return document.getElementById(id);
}

function lbProdSetStatus(text, isError) {
  const status = lbProdEl("lb-addprod-status");
  if (!status) return;
  status.textContent = text || "";
  status.classList.toggle("lb-error", Boolean(isError));
}

/** A product's name ready to end a sentence: it gets a period unless it already ends in punctuation ("What do you need help with today?"). */
function lbProdEnd(name) {
  return /[.?!]$/.test(String(name)) ? String(name) : `${name}.`;
}

/** The message under the product list: what just happened, with an Undo button when the removal can be reversed. Empty text clears it. */
function lbProdNotice(text, withUndo) {
  lbProd.notice = text ? { text, withUndo: Boolean(withUndo) } : null;
  const el = lbProdEl("lb-product-status");
  if (!el) return;
  el.innerHTML = text ? `${escapeHtml(text)}${withUndo ? ' <button type="button" class="btn btn-sm" data-prod-undo>Undo</button>' : ""}` : "";
}

/** An error about removing or restoring a product, in the Product step's own alert. */
function lbProdProductError(text) {
  const el = lbProdEl("lb-product-error");
  if (el) el.textContent = text || "";
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

// ── A product you added, on its card in the Product step ─────────────────────

/** "November 3, 2025" for the saved date, or "" when the saved entry has none. */
function lbProdDate(iso) {
  const time = Date.parse(iso || "");
  return Number.isFinite(time) ? new Date(time).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : "";
}

/**
 * What a product you added is and where it came from, as plain lines under its title: a readable name when the saved one is a
 * question or a landing page title, one sentence, and its address with the date it was added. A product whose address is not
 * product documentation (a Q&A forum, training modules) says so and puts Remove first. No boxes: these are lines of text.
 */
function lbProdCardNotesHtml(p) {
  const id = escapeHtml(p.id);
  const date = lbProdDate(p.addedAt);
  const address = p.address || String(p.learnHubUrl || "").replace(/^https:\/\//, "");
  const flag = p.notDocumentation
    ? `<div class="lb-card-flag" id="lb-prod-flag-${id}">This points to ${escapeHtml(p.notDocumentation)}, which are not product documentation, so labs built from it will not be useful. We suggest removing it.</div>${lbProdCardActionsHtml(p)}`
    : "";
  const also = p.alsoKnownAs && !p.notDocumentation ? `<div class="lb-card-also">Also known as ${escapeHtml(p.alsoKnownAs)}</div>` : "";
  return `<div class="lb-card-notes">${flag}${also}<div class="lb-card-about" id="lb-prod-about-${id}">You added this from Microsoft Learn. Its topics are read from the address below.</div><div class="lb-card-address"><span>${escapeHtml(address)}<span class="sr-only">.</span></span>${date ? `<span>Added ${escapeHtml(date)}<span class="sr-only">.</span></span>` : ""}</div></div>`;
}

/**
 * The Remove button of a product's card, or, once it was pressed, the question that replaces it: what removing does, and
 * Remove and Keep. A product that cannot be added again (its address is not product documentation) says so.
 */
function lbProdCardActionsHtml(p) {
  const id = escapeHtml(p.id);
  const name = escapeHtml(p.name);
  if (lbProd.confirming !== p.id) {
    return `<div class="lb-card-actions"><button type="button" class="btn btn-sm" data-prod-remove="${id}" data-prod-focus="remove:${id}" aria-label="Remove ${name} from my products">Remove</button></div>`;
  }
  const again = p.notDocumentation ? "It is not product documentation, so it cannot be added again." : "You can add it again from Add another Microsoft product.";
  const question = /[?]$/.test(String(p.name)) ? name : `${name}?`;
  return `<div class="lb-card-actions lb-card-confirm" role="group" aria-labelledby="lb-prod-ask-${id}"><div id="lb-prod-ask-${id}">Remove ${question} Labs you already built from it are not changed. ${again}</div><div class="lb-card-confirm-buttons"><button type="button" class="btn btn-sm" data-prod-confirm="${id}" data-prod-focus="confirm:${id}">Remove</button><button type="button" class="btn btn-sm" data-prod-keep="${id}" data-prod-focus="keep:${id}">Keep</button></div></div>`;
}

/** Put the keyboard focus on a card button (see data-prod-focus). */
function lbProdFocus(key) {
  lbProdEl("lb-product-options")?.querySelector(`[data-prod-focus="${key}"]`)?.focus();
}

/** Remove was pressed on a card: ask first, with Keep as the button the focus lands on. */
function lbProdAskRemove(id) {
  lbProdProductError("");
  lbProd.confirming = id;
  lbRenderProducts();
  lbProdFocus(`keep:${id}`);
}

/** Keep was pressed, or Escape: the question closes and the focus goes back to Remove. */
function lbProdKeep(id) {
  lbProd.confirming = null;
  lbRenderProducts();
  lbProdFocus(`remove:${id}`);
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
              `<li class="lb-mine-result"><span class="lb-mine-result-title">${escapeHtml(product.name)}</span>${product.notDocumentation ? ' <span class="lb-mine-result-note">Not product documentation.</span>' : ""} <button type="button" class="btn btn-sm" data-addprod-remove="${escapeHtml(product.id)}" aria-label="Remove ${escapeHtml(product.name)} from my products">Remove</button></li>`,
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
  if (lbProd.confirming && !labBuilder.products.some((p) => p.id === lbProd.confirming)) lbProd.confirming = null;
  lbRenderProducts();
}

/**
 * Add a product from a documentation hub. `restore` is Undo after a removal: the same address and name through the same add
 * route (so its rules, including refusing an address that is not product documentation, still apply), told under the product list
 * instead of in the closed add panel, and selected again only when it was selected before (`select`). Returns true when it was added.
 */
async function lbProdAdd(root, name, { restore = false, select = true } = {}) {
  if (lbProd.busy || !root) return false;
  lbProd.busy = true;
  const say = restore ? (text) => lbProdNotice(text, false) : (text, isError) => lbProdSetStatus(text, isError);
  say(restore ? `Adding ${name} back from Microsoft Learn...` : "Reading the documentation hub from Microsoft Learn...", false);
  try {
    const data = await lbProdCall("/api/lab-builder/products/mine", "POST", name ? { root, name } : { root });
    lbProd.groups = [];
    lbProd.hidden = null;
    lbProd.undo = null;
    lbProdRender();
    await lbProdReloadProducts();
    if (select) {
      labBuilder.selectedProducts.add(data.product.id);
      labBuilder.chosenSteps.add("product");
    }
    lbProductsChanged();
    await lbProdLoadPicklist();
    say(
      restore
        ? `${data.product.name} is back in your products. Its topics are read from Microsoft Learn again; this can take a minute.`
        : `Added "${data.product.name}" and selected it. Its topics are read from Microsoft Learn next; this can take a minute.`,
      false,
    );
    await lbRefreshLearn();
    say(restore ? `${data.product.name} is back in your products. Its Microsoft Learn topics are in the Topics step.` : `Added "${data.product.name}". Its Microsoft Learn topics are in the Topics step.`, false);
    if (restore) lbProdEl("lb-product-options")?.querySelector(`input[value="${data.product.id}"]`)?.focus();
    return true;
  } catch (err) {
    if (restore) {
      // Keep Undo so it can be tried again, and say what to do if it cannot work.
      lbProdNotice(lbProd.undo?.text || "", Boolean(lbProd.undo));
      lbProdProductError(`${lbProdMessage(err)} You can also add it again from Add another Microsoft product.`);
      lbProdEl("lb-product-status")?.querySelector("[data-prod-undo]")?.focus();
    } else lbProdSetStatus(lbProdMessage(err), true);
    return false;
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

/**
 * Remove a product you added. The one removal behind both Remove buttons, the card's (after its question) and the list's:
 * it deletes the product on the server (labs already built from it are not changed), unselects it, refreshes the
 * product list and Your lab so far, and says what happened under the product list. When the same address could be added again,
 * the message has Undo; an address that is not product documentation is refused by the add route, so it never gets one.
 */
async function lbProdRemove(id) {
  if (lbProd.busy) return;
  const product = labBuilder.products.find((p) => p.id === id) || lbProd.added.find((p) => p.id === id);
  lbProd.busy = true;
  lbProdProductError("");
  try {
    await lbProdCall(`/api/lab-builder/products/mine/${encodeURIComponent(id)}`, "DELETE");
    const wasSelected = labBuilder.selectedProducts.delete(id);
    // With nothing left selected the wizard starts at the Product step again, as when the last product is unchecked.
    if (wasSelected && !labBuilder.selectedProducts.size) {
      labBuilder.chosenSteps.clear();
      labBuilder.furthest = LB_STEP.product;
    }
    lbProd.confirming = null;
    await lbProdReloadProducts();
    lbProductsChanged();
    await lbProdLoadPicklist();
    lbProdSetStatus("", false);
    const name = product?.name || "The product";
    const text = `Removed ${lbProdEnd(name)} Labs you already built from it are not changed.`;
    const canUndo = Boolean(product?.learnHubUrl && product.name && !product.notDocumentation);
    lbProd.undo = canUndo ? { root: product.learnHubUrl, name: product.name, wasSelected, text } : null;
    lbProdNotice(text, canUndo);
    const status = lbProdEl("lb-product-status");
    (status?.querySelector?.("[data-prod-undo]") || status)?.focus?.();
  } catch (err) {
    lbProdProductError(lbProdMessage(err));
  } finally {
    lbProd.busy = false;
  }
}

/** Undo after a removal: add the same product back from the same address, selected again if it was. */
async function lbProdUndo() {
  const undo = lbProd.undo;
  if (!undo || lbProd.busy) return;
  lbProdProductError("");
  await lbProdAdd(undo.root, undo.name, { restore: true, select: undo.wasSelected });
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
  // The product cards and the message under them are outside the add panel: one listener each, for the cards' Remove question and Undo.
  const list = lbProdEl("lb-product-options");
  list?.addEventListener("click", (event) => {
    const target = event.target?.closest?.("[data-prod-remove],[data-prod-confirm],[data-prod-keep]");
    // The card is one label: a press anywhere in its Remove question must not also tick the product's checkbox.
    if (target || event.target?.closest?.(".lb-card-actions")) event.preventDefault();
    if (!target) return;
    if (target.dataset.prodRemove !== undefined) lbProdAskRemove(target.dataset.prodRemove);
    else if (target.dataset.prodConfirm !== undefined) lbProdRemove(target.dataset.prodConfirm);
    else if (target.dataset.prodKeep !== undefined) lbProdKeep(target.dataset.prodKeep);
  });
  list?.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && lbProd.confirming && event.target?.closest?.(".lb-card-confirm")) {
      event.preventDefault();
      lbProdKeep(lbProd.confirming);
    }
  });
  lbProdEl("lb-product-status")?.addEventListener("click", (event) => {
    if (event.target?.closest?.("[data-prod-undo]")) lbProdUndo();
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
