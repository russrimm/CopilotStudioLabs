/**
 * A product a person added from Microsoft Learn explains itself and can be removed right on its card in Step 1.
 *
 * The data half: which saved products are flagged as not product documentation (the same rule the add route refuses), and
 * which names are shown with a readable "Also known as". The client half runs the real wizard and My products scripts in a
 * node:vm context (no HTML is parsed, so the markup is checked as text) against a small stand-in for the server.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

import express from "express";

import { addedProductDetails, registerProductRoutes } from "../lib/lab-builder/product-api.js";
import { createNamer, describeAddedProduct, looksGenericName, nonDocumentationKind } from "../lib/lab-builder/product-scopes.js";
import { getProducts, setCustomProducts } from "../lib/lab-builder/products.js";
import { buildUserProduct } from "../lib/lab-builder/user-products.js";
import { recommend } from "../lib/lab-builder/recommend.js";
import { createRateLimiter, positiveIntFromEnv } from "../lib/rate-limit.js";
import { readSummary } from "./fixtures/lab-summary.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

const NOON = Date.parse("2026-03-15T12:00:00Z");
const QA = { name: "What do you need help with today?", root: "https://learn.microsoft.com/answers" };
const HUB = { name: "Power BI", root: "https://learn.microsoft.com/power-bi" };
const GENERIC = { name: "Overview", root: "https://learn.microsoft.com/power-bi/fundamentals" };

const add = ({ name, root }, now = NOON) => buildUserProduct({ name, root, now });

// ── The data: what is flagged, and what is shown as the readable name ─────────

test("a product whose address is not product documentation is flagged by the rule the add route uses, and a normal hub is not", async (t) => {
  const details = (product) => describeAddedProduct(product, createNamer());
  assert.equal(details(add(QA)).notDocumentation, "Microsoft Q&A threads", "the owner's product points at the whole Q&A forum");
  assert.equal(details(add(HUB)).notDocumentation, null);
  assert.equal(details(add({ name: "Azure AI Services", root: "https://learn.microsoft.com/azure/ai-services" })).notDocumentation, null);
  for (const area of ["training", "events", "shows", "credentials", "samples", "community", "lifecycle"]) {
    const root = `https://learn.microsoft.com/${area}/anything`;
    assert.ok(details(add({ name: "Some area", root })).notDocumentation, `${area} is flagged`);
    assert.equal(details(add({ name: "Some area", root })).notDocumentation, nonDocumentationKind(root), "the same answer as the rule itself");
  }

  // The route refuses exactly what the card flags: one list, never two.
  const dir = mkdtempSync(join(tmpdir(), "added-card-"));
  setCustomProducts([]);
  t.after(() => {
    setCustomProducts(undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  const service = { config: { userProductsPath: join(dir, "user-products.json"), cachePath: join(dir, "c.json"), snapshotPath: join(dir, "s.json") } };
  const app = express();
  app.use(express.json());
  const learn = { search: async () => [], page: async (url) => ({ url, error: null, markdown: "# Power BI documentation\n\nLearn about the product.\n" }) };
  registerProductRoutes(app, { getService: () => service, createRateLimiter, positiveIntFromEnv, learn });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const refused = await fetch(`http://127.0.0.1:${server.address().port}/api/lab-builder/products/mine`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ root: QA.root }) });
  assert.equal(refused.status, 422);
});

test("addedProductDetails describes only products a person added: address, date added when saved, flag, and a readable name for a generic one", () => {
  const dated = add(HUB);
  const undated = { ...add(GENERIC) };
  delete undated.addedAt;
  const details = addedProductDetails([...getProducts().filter((p) => !p.custom), dated, undated, add(QA)]);
  assert.deepEqual([...details.keys()], [dated.id, undated.id, add(QA).id], "reviewed products get nothing");
  assert.deepEqual(details.get(dated.id), { address: "learn.microsoft.com/power-bi", addedAt: "2026-03-15T12:00:00.000Z", notDocumentation: null, alsoKnownAs: null });
  assert.equal(details.get(undated.id).addedAt, null, "no date is invented when the saved entry has none");
  assert.equal(details.get(undated.id).alsoKnownAs, "Power BI > Fundamentals", "a landing page title is shown with its address read as words");
  assert.equal(details.get(add(QA).id).alsoKnownAs, null, "a flagged product says what it is in its flag, not twice");
  assert.deepEqual(addedProductDetails([]), new Map());
});

test("a name that is a question or a landing page title is generic; a product name is not", () => {
  for (const name of ["What do you need help with today?", "Overview", "Welcome.", "  Getting   started ", "Microsoft Learn", "Documentation"]) assert.equal(looksGenericName(name), true, name);
  for (const name of ["Power BI", "Dynamics 365 Sales", "Azure AI Services", "Overview of Power BI", "", null]) assert.equal(looksGenericName(name), false, String(name));
  const named = createNamer({ named: [{ name: "Power BI", root: HUB.root }] });
  assert.equal(describeAddedProduct(add({ name: "Home", root: HUB.root }), named).alsoKnownAs, "Power BI", "a reviewed hub is named for itself");
  assert.equal(describeAddedProduct(add({ name: "Power bi", root: HUB.root }), named).alsoKnownAs, null);
  assert.equal(describeAddedProduct(add({ name: "Power BI?", root: HUB.root }), named).alsoKnownAs, null, "never the same name twice");
});

// ── The cards, in the real scripts ───────────────────────────────────────────

const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const kebab = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** The wizard and the My products script in one context, a stand-in server behind fetch, and the keyboard focus written down. */
function loadCards(t, saved) {
  let custom = saved.map((entry) => ({ ...entry }));
  setCustomProducts(custom);
  t.after(() => setCustomProducts(undefined));
  const elements = new Map();
  const focused = [];
  const calls = [];
  const element = (id) => {
    if (!elements.has(id)) {
      const el = {
        id,
        innerHTML: "",
        textContent: "",
        value: "",
        checked: true,
        hidden: false,
        style: {},
        listeners: {},
        contains: () => false,
        // The markup is text, so a selector for a button or an input is answered from the text it holds.
        querySelector(selector) {
          const focus = /^\[data-prod-focus="([^"]+)"\]$/.exec(selector);
          const undo = selector === "[data-prod-undo]" && el.innerHTML.includes("data-prod-undo");
          const input = /^input\[value="([^"]+)"\]$/.exec(selector);
          if (focus && el.innerHTML.includes(`data-prod-focus="${focus[1]}"`)) return { focus: () => focused.push(focus[1]) };
          if (undo) return { focus: () => focused.push("undo") };
          if (input && el.innerHTML.includes(`value="${input[1]}"`)) return { focus: () => focused.push(`checkbox:${input[1]}`) };
          return null;
        },
        querySelectorAll: () => [],
        addEventListener(type, fn) {
          (el.listeners[type] ||= []).push(fn);
        },
        setAttribute() {},
        removeAttribute() {},
        focus: () => focused.push(`#${id}`),
        scrollIntoView() {},
        classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      };
      elements.set(id, el);
    }
    return elements.get(id);
  };
  const withDetails = () => {
    const details = addedProductDetails(getProducts());
    return getProducts().map((p) => ({
      id: p.id,
      name: p.name,
      shortName: p.shortName,
      summary: p.summary,
      levels: p.levels,
      hasHarnesses: p.hasHarnesses,
      learnHubUrl: p.learnHubUrl,
      custom: Boolean(p.custom),
      ...details.get(p.id),
      featureCount: p.custom ? 0 : 5,
    }));
  };
  let failAdd = null;
  let failDelete = false;
  const context = {
    document: { readyState: "complete", getElementById: element, querySelector: () => null, querySelectorAll: () => [], activeElement: { dataset: {} } },
    CSS: { escape: (s) => s },
    escapeHtml,
    toast() {},
    fetch: async (path, init = {}) => {
      const method = init.method || "GET";
      calls.push({ path, method, body: init.body ? JSON.parse(init.body) : undefined });
      const ok = (data) => ({ ok: true, status: 200, json: async () => data, headers: { get: () => null } });
      if (path === "/api/lab-builder/features") return ok({ products: withDetails() });
      if (path === "/api/lab-builder/products/picklist") return ok({ products: [], added: withDetails().filter((p) => p.custom) });
      if (path.startsWith("/api/lab-builder/products/mine/") && method === "DELETE") {
        if (failDelete) return { ok: false, status: 500, json: async () => ({ error: "The product list could not be saved" }), headers: { get: () => null } };
        const id = decodeURIComponent(path.split("/").pop());
        custom = custom.filter((p) => p.id !== id);
        setCustomProducts(custom);
        return ok({ removed: true, id });
      }
      if (path === "/api/lab-builder/products/mine" && method === "POST") {
        if (failAdd) return { ok: false, status: failAdd.status, json: async () => ({ error: failAdd.error }), headers: { get: () => null } };
        const body = JSON.parse(init.body);
        const product = buildUserProduct({ name: body.name, root: body.root, now: NOON });
        custom = [...custom, product];
        setCustomProducts(custom);
        return { ok: true, status: 201, json: async () => ({ added: true, product: { id: product.id, name: product.name } }), headers: { get: () => null } };
      }
      return ok(recommend(JSON.parse(init.body || "{}")));
    },
    setTimeout,
    console,
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL("../public/lab-builder-wizard.js", import.meta.url), "utf8"), context);
  vm.runInContext(readFileSync(new URL("../public/lab-builder-my-products.js", import.meta.url), "utf8"), context);
  const run = (code) => vm.runInContext(code, context);
  run("lbRefreshLearn = async () => {};");
  run(`labBuilder.levels = ${JSON.stringify([{ level: 100, label: "Beginner", description: "" }, { level: 200, label: "Intermediate", description: "" }, { level: 300, label: "Advanced", description: "" }])};`);
  run(`labBuilder.products = ${JSON.stringify(withDetails())};`);
  const list = element("lb-product-options");
  /** A press on a card button, as the list's one click listener sees it. */
  const press = async (kind, id) => {
    const target = { dataset: { [kind]: id }, closest: (selector) => (selector.includes(`data-${kebab(kind)}`) || selector.includes(".lb-card-actions") ? target : null) };
    const event = { type: "click", target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const fn of (kind === "prodUndo" ? element("lb-product-status") : list).listeners.click) await fn(event);
    await settle();
    return event;
  };
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const cards = () => list.innerHTML.split('<label class="scenario-role').slice(1).map((html) => `<label class="scenario-role${html}`);
  const card = (name) => cards().find((html) => html.includes(`<span class="lb-card-title"`) && html.includes(`>${escapeHtml(name)}<span class="sr-only">`));
  const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  return { run, element, list, calls, focused, press, settle, cards, card, text, failAdd: (value) => (failAdd = value), failDelete: (value) => (failDelete = value), ids: () => custom.map((p) => p.id), status: () => element("lb-product-status").innerHTML };
}

test("an Added by you card says what it is and where it came from, shows its address and date, and has a labeled Remove button", (t) => {
  const page = loadCards(t, [add(HUB), add(GENERIC), add(QA)]);
  page.run("labBuilder.learn = { products: { 'custom-power-bi': { newTopics: 201 }, 'custom-overview': { newTopics: 1 } } }");
  page.run("lbRenderProducts()");
  const hub = page.card("Power BI");
  assert.ok(hub, "the card is rendered");
  assert.match(hub, /Added by you/);
  assert.match(page.text(hub), /You added this from Microsoft Learn\. Its topics are read from the address below\./);
  assert.match(hub, /<div class="lb-card-address"><span>learn\.microsoft\.com\/power-bi<span class="sr-only">\.<\/span><\/span><span>Added March 15, 2026<span class="sr-only">\.<\/span><\/span><\/div>/);
  assert.match(page.text(hub), /201 topics read from Microsoft Learn\. Not reviewed by this tool, so labs built from them say so\./);
  assert.match(hub, /<button type="button" class="btn btn-sm" data-prod-remove="custom-power-bi" data-prod-focus="remove:custom-power-bi" aria-label="Remove Power BI from my products">Remove<\/button>/);
  assert.doesNotMatch(hub, /Also known as/, "a real product name needs no second name");
  assert.match(hub, /aria-labelledby="lb-prod-title-custom-power-bi" aria-describedby="lb-prod-about-custom-power-bi"/, "the checkbox is named for the product, not for the whole card");

  const generic = page.card("Overview");
  assert.match(page.text(generic), /Also known as Power BI > Fundamentals/);
  assert.match(page.text(generic), /1 topic read from Microsoft Learn\. Not reviewed by this tool, so labs built from it say so\./);

  const reviewed = page.cards().find((html) => !html.includes("Added by you"));
  assert.ok(reviewed && !/data-prod-remove|You added this/.test(reviewed), "a reviewed product has no Remove and no explanation");

  page.run("labBuilder.products = labBuilder.products.map((p) => (p.id === 'custom-power-bi' ? { ...p, addedAt: null } : p)); lbRenderProducts()");
  assert.doesNotMatch(page.card("Power BI"), /<span>Added /, "no date is shown when the saved entry has none");
});

test("a product that points to Q&A or another area that is not documentation says so in one plain sentence, with Remove first and no automatic change", (t) => {
  const page = loadCards(t, [add(QA), add(HUB)]);
  page.run("lbRenderProducts()");
  const flagged = page.card(QA.name);
  assert.match(page.text(flagged), /This points to Microsoft Q&A threads, which are not product documentation, so labs built from it will not be useful\. We suggest removing it\./);
  const remove = flagged.indexOf("data-prod-remove");
  assert.ok(remove > 0 && remove < flagged.indexOf("You added this") && remove < flagged.indexOf("Microsoft Learn for"), "Remove comes before everything else on the card");
  assert.equal((flagged.match(/data-prod-remove/g) || []).length, 1, "one Remove button");
  assert.doesNotMatch(flagged, /Also known as/);
  assert.doesNotMatch(page.card("Power BI"), /not product documentation/);
  assert.deepEqual(page.ids().sort(), [add(HUB).id, add(QA).id].sort(), "nothing is removed or changed for the person");
  assert.deepEqual(page.calls.filter((call) => call.method !== "GET" && call.path.startsWith("/api/lab-builder/products")), []);
});

test("Remove asks first (Keep and Escape cancel); confirming deletes the product, unselects it, refreshes the list and Your lab so far, and offers Undo", async (t) => {
  const page = loadCards(t, [add(HUB), add(QA)]);
  const hub = add(HUB).id;
  page.run(`labBuilder.selectedProducts = new Set(["sharepoint-ai", ${JSON.stringify(hub)}]); lbProductsChanged();`);
  assert.deepEqual(readSummary(page.element("lb-summary").innerHTML).products, ["SharePoint AI", "Power BI"]);

  const asked = await page.press("prodRemove", hub);
  assert.equal(asked.defaultPrevented, true);
  const confirm = page.card("Power BI");
  assert.match(confirm, /role="group" aria-labelledby="lb-prod-ask-custom-power-bi"/);
  assert.match(page.text(confirm), /Remove Power BI\? Labs you already built from it are not changed\. You can add it again from Add another Microsoft product\. Remove Keep/);
  assert.match(confirm, /data-prod-confirm="custom-power-bi"[^>]*>Remove<\/button><button[^>]*data-prod-keep="custom-power-bi"[^>]*>Keep<\/button>/);
  assert.equal(page.focused.at(-1), `keep:${hub}`, "the focus lands on the safe button");
  assert.deepEqual(page.calls.filter((call) => call.method === "DELETE"), [], "nothing is deleted by asking");

  await page.press("prodKeep", hub);
  assert.doesNotMatch(page.card("Power BI"), /data-prod-confirm/);
  assert.equal(page.focused.at(-1), `remove:${hub}`, "Keep puts the focus back on Remove");
  assert.ok(page.run("labBuilder.selectedProducts.has('custom-power-bi')"));

  await page.press("prodRemove", hub);
  const escape = { type: "keydown", key: "Escape", target: { closest: (selector) => (selector === ".lb-card-confirm" ? {} : null) }, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  for (const fn of page.list.listeners.keydown) fn(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.doesNotMatch(page.card("Power BI"), /data-prod-confirm/, "Escape cancels");
  assert.equal(page.focused.at(-1), `remove:${hub}`);
  const stray = { type: "keydown", key: "Escape", target: { closest: () => null }, preventDefault() { throw new Error("Escape outside the question is left alone"); } };
  for (const fn of page.list.listeners.keydown) fn(stray);

  await page.press("prodRemove", hub);
  await page.press("prodConfirm", hub);
  assert.deepEqual(page.calls.filter((call) => call.method === "DELETE").map((call) => call.path), [`/api/lab-builder/products/mine/${hub}`]);
  assert.equal(page.run("labBuilder.selectedProducts.has('custom-power-bi')"), false, "no longer selected");
  assert.equal(page.run("labBuilder.selectedProducts.has('sharepoint-ai')"), true, "the other product stays selected");
  assert.equal(page.card("Power BI"), undefined, "the card is gone");
  assert.deepEqual(readSummary(page.element("lb-summary").innerHTML).products, ["SharePoint AI"], "Your lab so far no longer lists it");
  assert.equal(page.status(), 'Removed Power BI. Labs you already built from it are not changed. <button type="button" class="btn btn-sm" data-prod-undo>Undo</button>');
  assert.equal(page.focused.at(-1), "undo", "the focus goes to Undo");
  assert.equal(page.element("lb-product-error").textContent, "");
  assert.match(page.element("lb-addprod-saved").innerHTML, /Products you added \(1\)/, "the list under Add another product is refreshed too");
});

test("Undo adds the same product back from the same address, selected again only if it was; when it cannot be added it says so and keeps Undo", async (t) => {
  const page = loadCards(t, [add(HUB)]);
  const hub = add(HUB).id;
  page.run(`labBuilder.selectedProducts = new Set(["sharepoint-ai", ${JSON.stringify(hub)}]); lbProductsChanged();`);
  await page.press("prodRemove", hub);
  await page.press("prodConfirm", hub);

  page.failAdd({ status: 502, error: "Microsoft Learn could not be reached: offline" });
  await page.press("prodUndo", "");
  assert.match(page.element("lb-product-error").textContent, /^Microsoft Learn could not be reached: offline\. You can also add it again from Add another Microsoft product\.$/);
  assert.match(page.status(), /Removed Power BI\..*data-prod-undo/, "Undo stays so it can be tried again");
  assert.equal(page.run("labBuilder.selectedProducts.has('custom-power-bi')"), false);

  page.failAdd(null);
  await page.press("prodUndo", "");
  const post = page.calls.filter((call) => call.method === "POST" && call.path === "/api/lab-builder/products/mine").at(-1);
  assert.deepEqual([post.path, post.body], ["/api/lab-builder/products/mine", { root: HUB.root, name: "Power BI" }], "the existing add route, with the same address and name");
  assert.equal(page.element("lb-product-error").textContent, "");
  assert.match(page.status(), /^Power BI is back in your products\. Its Microsoft Learn topics are in the Topics step\.$/);
  assert.ok(page.card("Power BI"), "the card is back");
  assert.ok(page.run("labBuilder.selectedProducts.has('custom-power-bi')"), "it was selected, so it is selected again");
  assert.equal(page.focused.at(-1), `checkbox:${hub}`);

  // A product that was not selected is not selected by Undo.
  page.run("labBuilder.selectedProducts.delete('custom-power-bi')");
  await page.press("prodRemove", hub);
  await page.press("prodConfirm", hub);
  await page.press("prodUndo", "");
  assert.equal(page.run("labBuilder.selectedProducts.has('custom-power-bi')"), false);
  assert.ok(page.card("Power BI"));
});

test("a product that cannot be added again is removed without Undo, and says so before it is removed", async (t) => {
  const page = loadCards(t, [add(QA)]);
  const qa = add(QA).id;
  page.run(`labBuilder.selectedProducts = new Set([${JSON.stringify(qa)}]); lbProductsChanged();`);
  await page.press("prodRemove", qa);
  assert.match(page.text(page.card(QA.name)), /Remove What do you need help with today\? Labs you already built from it are not changed\. It is not product documentation, so it cannot be added again\./);
  await page.press("prodConfirm", qa);
  assert.equal(page.status(), "Removed What do you need help with today? Labs you already built from it are not changed.");
  assert.doesNotMatch(page.status(), /Undo/);
  assert.equal(page.focused.at(-1), "#lb-product-status", "the focus goes to the message");
  assert.equal(page.run("labBuilder.selectedProducts.size"), 0);
  assert.equal(page.run("labBuilder.chosenSteps.size"), 0, "with nothing selected the wizard is back at the Product step");
  assert.equal(page.run("labBuilder.furthest"), page.run("LB_STEP.product"));
});

test("the Products you added list removes through the same code, and a failed removal is reported without changing anything", async (t) => {
  const page = loadCards(t, [add(HUB), add(QA)]);
  page.run("lbRenderProducts()");
  await page.run("lbProdLoadPicklist()");
  const saved = page.element("lb-addprod-saved").innerHTML;
  assert.match(saved, /Products you added \(2\)/);
  assert.match(saved, /aria-label="Remove Power BI from my products">Remove<\/button>/);
  assert.match(saved, /Not product documentation\./, "a flagged product is marked in the list too");

  const panel = page.element("lb-addprod");
  const target = { dataset: { addprodRemove: add(HUB).id }, closest: () => target };
  const pressInList = async () => {
    for (const fn of panel.listeners.click) await fn({ type: "click", target });
    await page.settle();
  };
  page.failDelete(true);
  await pressInList();
  assert.equal(page.element("lb-product-error").textContent, "The product list could not be saved.");
  assert.equal(page.status(), "", "no removal is announced");
  assert.ok(page.card("Power BI"), "the product stays");
  page.failDelete(false);
  await pressInList();
  assert.deepEqual(page.calls.filter((call) => call.method === "DELETE" && call.path.endsWith(add(HUB).id)).length, 2);
  assert.match(page.status(), /^Removed Power BI\. Labs you already built from it are not changed\. .*data-prod-undo/);
  assert.equal(page.element("lb-product-error").textContent, "");
  assert.match(page.element("lb-addprod-saved").innerHTML, /Products you added \(1\)/);
});
