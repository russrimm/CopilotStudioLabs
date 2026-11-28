/**
 * Add another Microsoft product, search side: what a search for a product returns and how the panel shows it.
 *
 * A search hit is one Learn page, and a product is "everything under" an address. The panel used to show a raw path dropdown
 * per hit. When every path of a hit was already covered by a product (every /sharepoint page, because SharePoint AI features
 * covers /sharepoint), every option was disabled, a select with only disabled options selects nothing, and the person saw an
 * empty box. These tests pin the replacement: results grouped by documentation hub, a plain name and one-line consequence for
 * every scope, one recommended and preselected scope per group, covered scopes disabled with a reason, and pages that are not
 * product documentation left out. Microsoft Learn is a fake client here; the real search results of the owner's "sharepoint"
 * search (Learn, 2026-11) are the fixture.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import express from "express";

import { readPicklist, registerProductRoutes } from "../lib/lab-builder/product-api.js";
import { candidateRoots, createNamer, humanizeSegment, nonDocumentationKind, pickRecommended } from "../lib/lab-builder/product-scopes.js";
import { getBuiltInProducts, getProducts, setCustomProducts } from "../lib/lab-builder/products.js";
import { createRateLimiter, positiveIntFromEnv } from "../lib/rate-limit.js";

const LEARN = "https://learn.microsoft.com";

/** What Learn returned for "sharepoint": a Q&A thread, another product's page, and five SharePoint pages (one twice, with an anchor). */
const SHAREPOINT_HITS = [
  ["What is sharepoint - Microsoft Q&A", `${LEARN}/answers/a/12804744`],
  ["SharePoint as a data source - HIS", `${LEARN}/host-integration-server/core/sharepoint1#overview`],
  ["Intro to file collaboration in Microsoft 365, powered by SharePoint", `${LEARN}/sharepoint/intro-to-file-collaboration#key-features`],
  ["SharePoint Add-ins", `${LEARN}/sharepoint/dev/sp-add-ins/sharepoint-add-ins#two-types-of-sharepoint-add-ins-sharepoint-hosted-and-provider-hosted`],
  ["Step 2: Review Microsoft 365 communication tools", `${LEARN}/sharepoint/review-communication-apps#sharepoint-engage,-learn,-and-collaborate`],
  ["Programming models in SharePoint", `${LEARN}/sharepoint/dev/general-development/programming-models-in-sharepoint#sharepoint-framework`],
  ["Host webs, add-in webs, and SharePoint components in SharePoint", `${LEARN}/sharepoint/dev/sp-add-ins/host-webs-add-in-webs-and-sharepoint-components-in-sharepoint`],
  ["SharePoint Add-ins", `${LEARN}/sharepoint/dev/sp-add-ins/sharepoint-add-ins`],
].map(([title, url]) => ({ title, url, excerpt: "An excerpt that is long enough to count as a page of text." }));

const DYNAMICS_HITS = [
  ["Overview of Dynamics 365 Sales Professional - Training", `${LEARN}/training/modules/overview-d365-sales-professional/`],
  ["Learn the basics of Dynamics 365 Sales", `${LEARN}/dynamics365/sales/user-guide-learn-basics`],
  ["Explore the fundamentals of Microsoft Dynamics 365 Sales - Training", `${LEARN}/training/paths/learn-fundamentals-of-microsoft-dynamics-365-sales/`],
].map(([title, url]) => ({ title, url, excerpt: "An excerpt that is long enough to count as a page of text." }));

async function startRoutes(t, hits) {
  const dir = mkdtempSync(join(tmpdir(), "product-scopes-"));
  setCustomProducts([]);
  t.after(() => {
    setCustomProducts(undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  const service = { config: { userProductsPath: join(dir, "user-products.json"), cachePath: join(dir, "c.json"), snapshotPath: join(dir, "s.json") } };
  const pages = [];
  const learn = {
    search: async () => hits,
    page: async (url) => {
      pages.push(url);
      const title = url.includes("host-integration-server") ? "Host Integration Server" : "Dynamics 365 Sales";
      return { url, error: null, markdown: `# ${title} documentation\n\nLearn about the product and how to use it every day.\n` };
    },
  };
  const app = express();
  app.use(express.json());
  registerProductRoutes(app, { getService: () => service, createRateLimiter, positiveIntFromEnv, learn });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (route, method = "GET", body) => fetch(`${base}${route}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { base, call, pages };
}

const search = async (ctx, query = "sharepoint") => (await ctx.call("/api/lab-builder/products/mine/search", "POST", { query })).json();

// ── The addresses and names ─────────────────────────────────────────────────

test("a page offers its folders as scopes, never its own article; a folder start page and a one-level address offer themselves", () => {
  assert.deepEqual(candidateRoots(`${LEARN}/dynamics365/sales/get-started`), [`${LEARN}/dynamics365`, `${LEARN}/dynamics365/sales`], "an article is not a hub");
  assert.deepEqual(candidateRoots(`${LEARN}/en-us/dynamics365/sales/get-started#overview?x=1`), [`${LEARN}/dynamics365`, `${LEARN}/dynamics365/sales`], "locale, anchor, and query are not part of a scope");
  assert.deepEqual(candidateRoots(`${LEARN}/training/modules/overview-d365-sales-professional/`), [`${LEARN}/training`, `${LEARN}/training/modules`, `${LEARN}/training/modules/overview-d365-sales-professional`], "a trailing slash means the page starts a folder");
  assert.deepEqual(candidateRoots(`${LEARN}/power-bi`), [`${LEARN}/power-bi`], "a one-level address is its own hub");
  assert.deepEqual(candidateRoots(`${LEARN}/a/b/c/d/e/f/g`), [`${LEARN}/a`, `${LEARN}/a/b`, `${LEARN}/a/b/c`, `${LEARN}/a/b/c/d`], "at most four, shortest first");
  assert.deepEqual(candidateRoots("http://learn.microsoft.com/a/b"), []);
  assert.deepEqual(candidateRoots("https://example.com/a/b"), []);
  assert.deepEqual(candidateRoots(""), []);
});

test("a path segment reads as words, with the casing and acronyms a person expects", () => {
  const cases = {
    "host-integration-server": "Host Integration Server",
    core: "Core",
    sharepoint: "SharePoint",
    dynamics365: "Dynamics 365",
    "microsoft-365": "Microsoft 365",
    "power-bi": "Power BI",
    "sp-add-ins": "SharePoint Add-ins",
    "word-add-ins": "Word Add-ins",
    "get-started-with-ai": "Get Started with AI",
    sharepoint1: "SharePoint 1",
    "rest-api": "Rest API",
    "document%20intelligence": "Document Intelligence",
  };
  for (const [segment, words] of Object.entries(cases)) assert.equal(humanizeSegment(segment), words, segment);
  assert.doesNotThrow(() => humanizeSegment("%E0%A4%A"), "an address that cannot be decoded is kept as written, never thrown");
});

test("a scope is named for the reviewed hub, built-in product, or product you added it is, and otherwise for its path", () => {
  const added = { name: "Contoso Docs", learnRoots: [`${LEARN}/contoso`], custom: true, learnHubUrl: `${LEARN}/contoso` };
  const products = [...getBuiltInProducts(), added];
  const picklist = readPicklist();
  const nameOf = createNamer({ named: [...picklist, { name: added.name, root: added.learnHubUrl }], products });
  assert.equal(nameOf(`${LEARN}/dynamics365/sales`), "Dynamics 365 Sales", "a reviewed hub");
  assert.equal(nameOf(`${LEARN}/dynamics365/sales/administer`), "Dynamics 365 Sales > Administer", "under a reviewed hub");
  assert.equal(nameOf(`${LEARN}/sharepoint`), "SharePoint AI features", "a built-in product, for itself only");
  assert.equal(nameOf(`${LEARN}/sharepoint/dev`), "SharePoint > Dev", "not named after the built-in product");
  assert.equal(nameOf(`${LEARN}/contoso/guides`), "Contoso Docs > Guides", "under a product you added");
  assert.equal(nameOf(`${LEARN}/host-integration-server/core`), "Host Integration Server > Core", "any other address reads as its path");
  assert.equal(nameOf(`${LEARN}/azure`), "Azure");
});

test("the recommended scope is the shallowest one that no product covers and that is not a one-level umbrella, and a reviewed hub wins", () => {
  const scope = (root, coveredBy = null) => ({ root: `${LEARN}${root}`, depth: root.split("/").length - 1, coveredBy });
  const hubs = new Set([`${LEARN}/azure/ai-services/document-intelligence`, `${LEARN}/power-automate`]);
  const rec = (scopes, reviewed = hubs) => pickRecommended(scopes, reviewed)?.root.replace(LEARN, "") ?? null;
  assert.equal(rec([scope("/dynamics365"), scope("/dynamics365/sales")]), "/dynamics365/sales", "an umbrella such as /dynamics365 is skipped");
  assert.equal(rec([scope("/host-integration-server"), scope("/host-integration-server/core")]), "/host-integration-server", "the widest real hub, not the deeper folder");
  assert.equal(rec([scope("/azure"), scope("/azure/ai-services"), scope("/azure/ai-services/document-intelligence"), scope("/azure/ai-services/document-intelligence/prebuilt")]), "/azure/ai-services/document-intelligence", "a reviewed hub beats a shallower guess");
  assert.equal(rec([scope("/power-automate")]), "/power-automate", "a one-level umbrella that is a reviewed hub is a hub");
  assert.equal(rec([scope("/power-platform"), scope("/power-platform/admin")], new Set()), "/power-platform/admin");
  assert.equal(rec([scope("/microsoft-365", "A"), scope("/microsoft-365/admin", "A"), scope("/microsoft-365/admin/x"), scope("/microsoft-365/admin/x/y")], new Set()), "/microsoft-365/admin/x", "a covered scope is never recommended");
  assert.equal(rec([scope("/entra")], new Set()), "/entra", "when only an umbrella is left, it is the only honest answer");
  assert.equal(rec([scope("/azure"), scope("/azure/search")].map((s) => ({ ...s, coveredBy: "Z" }))), null, "every scope covered: nothing to recommend");
});

test("only first path segments that are not product documentation are hidden", () => {
  for (const [address, kind] of [
    [`${LEARN}/answers/a/12804744`, "Microsoft Q&A threads"],
    [`${LEARN}/en-us/training/modules/x/`, "training modules and learning paths"],
    [`${LEARN}/samples/azure-samples/x`, "code samples"],
    [`${LEARN}/shows/azure-friday`, "videos and shows"],
    [`${LEARN}/events/x`, "events"],
  ]) assert.equal(nonDocumentationKind(address), kind, address);
  for (const address of [`${LEARN}/sharepoint/dev`, `${LEARN}/azure/answers-guide`, `${LEARN}/microsoft-copilot-studio`, `${LEARN}/power-platform/training`, "not a url"]) assert.equal(nonDocumentationKind(address), null, address);
});

// ── The search route, with the owner's "sharepoint" search ──────────────────

test("a sharepoint search: Q&A hidden, other products named, covered pages said so, every scope named, one recommended per group", async (t) => {
  const ctx = await startRoutes(t, SHAREPOINT_HITS);
  const data = await search(ctx);

  assert.deepEqual(data.hidden, { count: 1, kinds: ["Microsoft Q&A threads"] });
  assert.deepEqual(
    data.groups.map((group) => [group.name, group.allCovered, group.pages.length]),
    [
      ["Host Integration Server", false, 1],
      ["SharePoint AI features", true, 5],
    ],
    "the group with a choice first, then the group with nothing to add; the repeated page is listed once",
  );

  const [his, covered] = data.groups;
  assert.deepEqual(
    his.scopes.map((scope) => [scope.label, scope.path, scope.kind, scope.recommended, scope.coveredBy]),
    [
      ["Host Integration Server", "/host-integration-server", "recommended", true, null],
      ["Host Integration Server > Core", "/host-integration-server/core", "narrower", false, null],
    ],
    "the article /host-integration-server/core/sharepoint1 is not a scope, and the widest real hub is recommended",
  );
  assert.deepEqual(his.pages, [{ title: "SharePoint as a data source - HIS", url: `${LEARN}/host-integration-server/core/sharepoint1` }]);

  // The cause of the blank dropdowns: every address under /sharepoint overlaps SharePoint AI features, so a select of them
  // had nothing it could select.
  assert.deepEqual(covered.coveredBy, ["SharePoint AI features"]);
  assert.ok(covered.scopes.length >= 3 && covered.scopes.every((scope) => scope.coveredBy === "SharePoint AI features" && !scope.recommended && scope.kind === "covered"));
  assert.ok(covered.scopes.every((scope) => scope.note === "Already covered by SharePoint AI features."));
  assert.deepEqual(covered.pages.map((page) => page.title).slice(0, 2), ["Intro to file collaboration in Microsoft 365, powered by SharePoint", "SharePoint Add-ins"]);

  for (const group of data.groups) {
    for (const scope of group.scopes) {
      assert.match(scope.label, /\S/, `${scope.root} has a name`);
      assert.match(scope.note, /\S/, `${scope.root} says what choosing it means`);
      assert.ok(scope.path.startsWith("/") && !scope.path.includes("learn.microsoft.com"), "the raw address is the path only");
      assert.ok(!/^\//.test(scope.label), "the label is never the raw path");
      if (scope.coveredBy) assert.equal(scope.recommended, false, "a covered scope is never the recommended one");
    }
    const recommended = group.scopes.filter((scope) => scope.recommended);
    assert.equal(recommended.length, group.allCovered ? 0 : 1, `${group.name}: exactly one recommended scope unless everything is covered`);
  }
});

test("a search that returns mostly training modules keeps the one documentation page and says what it hid", async (t) => {
  const ctx = await startRoutes(t, DYNAMICS_HITS);
  const data = await search(ctx, "dynamics 365 sales");
  assert.deepEqual(data.hidden, { count: 2, kinds: ["training modules and learning paths"] });
  assert.equal(data.groups.length, 1);
  const [group] = data.groups;
  assert.equal(group.name, "Dynamics 365 Sales", "a reviewed hub is named for itself");
  assert.deepEqual(group.scopes.map((scope) => [scope.label, scope.kind, scope.recommended]), [
    ["Dynamics 365", "broad", false],
    ["Dynamics 365 Sales", "recommended", true],
  ]);
  assert.match(group.scopes[0].note, /^Very broad: .*many separate products/);

  const none = await startRoutes(t, [DYNAMICS_HITS[0], DYNAMICS_HITS[2]]);
  assert.deepEqual(await search(none), { query: "sharepoint", groups: [], hidden: { count: 2, kinds: ["training modules and learning paths"] } });
});

test("a product you added makes its scopes covered, and a group with nothing left to add offers no choice", async (t) => {
  const ctx = await startRoutes(t, DYNAMICS_HITS.slice(1, 2));
  assert.equal((await ctx.call("/api/lab-builder/products/mine", "POST", { root: `${LEARN}/dynamics365/sales` })).status, 201);
  const data = await search(ctx, "dynamics 365 sales");
  assert.equal(data.groups.length, 1);
  const [group] = data.groups;
  assert.equal(group.allCovered, true);
  assert.deepEqual(group.coveredBy, ["Dynamics 365 Sales"]);
  assert.deepEqual(group.scopes.map((scope) => scope.coveredBy), ["Dynamics 365 Sales", "Dynamics 365 Sales"], "the umbrella above it overlaps too");
  assert.equal(group.scopes.filter((scope) => scope.recommended).length, 0);
});

test("adding the recommended or a narrower scope posts that address, and the product is named from its hub page", async (t) => {
  const ctx = await startRoutes(t, SHAREPOINT_HITS);
  const [his] = (await search(ctx)).groups;
  const narrower = his.scopes.find((scope) => !scope.recommended).root;
  const added = await ctx.call("/api/lab-builder/products/mine", "POST", { root: narrower });
  assert.equal(added.status, 201);
  assert.deepEqual(ctx.pages, [narrower], "the page that is read is the address that was chosen");
  assert.equal((await added.json()).product.name, "Host Integration Server");
  const again = (await search(ctx)).groups.find((group) => group.pages.some((page) => page.title.includes("HIS")));
  assert.ok(again.scopes.every((scope) => scope.coveredBy), "the whole hub overlaps the product just added");
  assert.ok(getProducts().some((product) => product.custom));
});

// ── The panel script, in a small fake page ──────────────────────────────────

function loadPanel(base) {
  const source = readFileSync(new URL("../public/lab-builder-my-products.js", import.meta.url), "utf8");
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { id, innerHTML: "", textContent: "", value: "", listeners: {}, classList: { toggle() {} }, addEventListener(type, fn) { this.listeners[type] = fn; } });
    return elements.get(id);
  };
  const posts = [];
  const context = {
    document: { readyState: "complete", getElementById: element },
    escapeHtml: (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    labBuilder: { products: [], selectedProducts: new Set(), chosenSteps: new Set() },
    lbRenderProducts() {},
    lbProductsChanged() {},
    lbRefreshLearn: async () => {},
    fetch: async (path, init) => {
      if (path === "/api/lab-builder/features") return { ok: true, json: async () => ({ products: [] }) };
      if (init?.method === "POST" && path.endsWith("/products/mine")) posts.push(JSON.parse(init.body));
      return fetch(`${base}${path}`, init);
    },
    setTimeout,
    console,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const panel = element("lb-addprod");
  const search = async (query) => {
    element("lb-addprod-input").value = query;
    await vm.runInContext("lbProdSearch()", context);
  };
  const html = () => element("lb-addprod-results").innerHTML;
  const status = () => element("lb-addprod-status").textContent;
  /** The fake click of an "Add as a product" button, and the fake change of a scope radio. */
  const clickAdd = (group) => panel.listeners.click({ target: { closest: () => ({ dataset: { addprodRoot: String(group) } }) } });
  const choose = (group, root) => panel.listeners.change({ target: { dataset: { addprodScope: String(group) }, value: root } });
  const redraw = () => vm.runInContext("lbProdRender()", context);
  /** Wait until the add that was started has finished: its last status line says the topics are in the Topics step. */
  const finished = async () => {
    for (let waited = 0; waited < 5000 && !/Topics step\.$/.test(status()); waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
  };
  return { html, status, search, clickAdd, choose, redraw, finished, posts };
}

const text = (fragment) => fragment.replace(/<[^>]+>/g, " ").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** The rendered groups: each with its radios (id, root, checked, disabled, the text a person hears as its name) and its buttons. */
function readGroups(html) {
  return html
    .split('<li class="lb-mine-result lb-scope-group">')
    .slice(1)
    .map((chunk) => {
      const radios = [...chunk.matchAll(/<input type="radio" id="([^"]+)" name="([^"]+)" value="([^"]+)" data-addprod-scope="(\d+)"([^>]*)>/g)].map((m) => ({
        id: m[1],
        name: m[2],
        root: m[3],
        group: m[4],
        checked: /\schecked(\s|$)/.test(m[5]),
        disabled: /\sdisabled(\s|$)/.test(m[5]),
        label: text(chunk.split(`id="${m[1]}-name">`)[1].split('<span class="lb-scope-note"')[0]),
        note: text(chunk.split(`id="${m[1]}-note">`)[1].split("</span>")[0]),
      }));
      return { chunk, radios, buttons: [...chunk.matchAll(/data-addprod-root="(\d+)"/g)].map((m) => m[1]), legend: text((chunk.match(/<legend[^>]*>([\s\S]*?)<\/legend>/) || [])[1] || "") };
    });
}

test("the panel shows every scope with a visible name and one preselected recommended choice, covered groups say so and offer no button", async (t) => {
  const ctx = await startRoutes(t, SHAREPOINT_HITS);
  const panel = loadPanel(ctx.base);
  await panel.search("sharepoint");
  const html = panel.html();
  assert.ok(!/<select|<option/.test(html), "no dropdown: a select of covered options is what showed empty");
  assert.ok(!html.includes("Use everything under"));

  const groups = readGroups(html);
  assert.equal(groups.length, 2);
  const [his, covered] = groups;
  assert.equal(his.legend, "Host Integration Server", "the radios sit in a fieldset named for the hub");
  assert.ok(his.chunk.includes("<fieldset") && his.chunk.includes('aria-describedby="lb-addprod-pages-0"'));
  assert.deepEqual(his.radios.map((r) => r.label), ["Host Integration Server Recommended", "Host Integration Server > Core"]);
  assert.deepEqual(his.radios.map((r) => r.checked), [true, false], "the recommended scope is preselected");
  assert.deepEqual(his.radios.map((r) => r.root), [`${LEARN}/host-integration-server`, `${LEARN}/host-integration-server/core`]);
  assert.ok(his.radios.every((r) => r.label.length > 0 && !/^\//.test(r.label) && r.note.length > 0), "every option has a name and a consequence");
  assert.equal(new Set(his.radios.map((r) => r.name)).size, 1, "one radio group");
  assert.ok(his.chunk.includes('<span class="lb-scope-path" id="lb-addprod-scope-0-0-path">/host-integration-server</span>'), "the raw address is quiet secondary text");
  assert.deepEqual(his.buttons, ["0"]);
  assert.match(his.chunk, /<a href="https:\/\/learn\.microsoft\.com\/host-integration-server\/core\/sharepoint1" target="_blank" rel="noopener noreferrer">SharePoint as a data source - HIS<span class="sr-only"> \(opens in a new tab\)<\/span><\/a>/);

  assert.deepEqual([covered.radios.length, covered.buttons.length], [0, 0], "nothing to choose and no button when everything is covered");
  assert.match(text(covered.chunk), /^SharePoint AI features Already covered by SharePoint AI features, so there is nothing to add\. 5 matching pages /);
  assert.equal((covered.chunk.match(/<a href=/g) || []).length, 5, "the five matching pages are links");

  assert.match(html, /<li class="lb-scope-hidden">Hidden: 1 result that is not product documentation \(Microsoft Q&amp;A threads\)\.<\/li>/);
  assert.match(panel.status(), /^1 documentation area found\./);
});

test("Add as a product posts the recommended scope, or the scope the person chose, and keeps a choice when the list is drawn again", async (t) => {
  const ctx = await startRoutes(t, SHAREPOINT_HITS);
  const panel = loadPanel(ctx.base);
  await panel.search("sharepoint");
  panel.clickAdd(0);
  await panel.finished();
  assert.deepEqual(panel.posts, [{ root: `${LEARN}/host-integration-server` }], "no choice made: the recommended scope");

  const second = await startRoutes(t, SHAREPOINT_HITS);
  const other = loadPanel(second.base);
  await other.search("sharepoint");
  other.choose(0, `${LEARN}/host-integration-server/core`);
  other.redraw();
  const radios = readGroups(other.html())[0].radios;
  assert.deepEqual(radios.map((r) => r.checked), [false, true], "the chosen scope stays selected when the panel is drawn again");
  other.clickAdd(0);
  await other.finished();
  assert.deepEqual(other.posts, [{ root: `${LEARN}/host-integration-server/core` }], "the chosen scope is what is posted");
  assert.match(other.status(), /^Added "Host Integration Server"\./);
  assert.equal(other.html(), "", "the results go away once the product is added");
});

test("the messages say what the search found, or why there is nothing to add", async (t) => {
  const covered = await startRoutes(t, SHAREPOINT_HITS.slice(2));
  const a = loadPanel(covered.base);
  await a.search("sharepoint");
  assert.equal(a.status(), "Everything found is already covered by a product in your list, so there is nothing to add.");
  assert.ok(!a.html().includes("<input"));

  const training = await startRoutes(t, [DYNAMICS_HITS[0]]);
  const b = loadPanel(training.base);
  await b.search("dynamics sales training");
  assert.equal(b.status(), "Nothing to add from this search. Try the product's name.");
  assert.match(b.html(), /Hidden: 1 result that is not product documentation \(training modules and learning paths\)\./);

  const nothing = await startRoutes(t, []);
  const c = loadPanel(nothing.base);
  await c.search("zzz nothing");
  assert.equal(c.status(), "Nothing found. Try other words.");
  assert.equal(c.html(), "");
});
