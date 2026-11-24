import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { getFeatures, getFeaturesByCategory, getHarnesses } from "../lib/lab-builder/catalog.js";
import { defaultDifferencesFor } from "../lib/lab-builder/differences.js";
import {
  extractFeatureLearnLinks,
  formatLearnSlugTitle,
  strictHttpsLearnUrl,
} from "../lib/lab-builder/learn-citations.js";
import { planLab } from "../lib/lab-builder/planner.js";
import { getProducts, productHasHarnesses, productOf } from "../lib/lab-builder/products.js";
import { recommend } from "../lib/lab-builder/recommend.js";
import { topicToFeature } from "../lib/lab-builder/topic-feature.js";
import { getIndustries, getRoles } from "../lib/scenarios.js";

function extractAnchors(fragment) {
  const anchors = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(fragment))) {
    const attrs = match[1];
    const inner = match[2];
    const attr = (name) => {
      const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
      return m ? m[1] : null;
    };
    anchors.push({
      className: attr("class") || "",
      href: attr("href"),
      target: attr("target"),
      rel: attr("rel"),
      ariaLabel: attr("aria-label"),
      text: inner.replace(/<[^>]+>/g, "").trim(),
    });
  }
  return anchors;
}

function previewPayloadFromPlan(request) {
  const plan = planLab(request);
  return {
    title: plan.title,
    slug: plan.slug,
    difficulty: plan.difficulty,
    duration: plan.duration,
    totalMinutes: plan.totalMinutes,
    estimate: plan.estimate,
    agentName: plan.profile.agentName,
    scenario: {
      problem: plan.profile.problem,
      outcome: plan.profile.outcome,
      sampleQuestions: plan.profile.sampleQuestions,
    },
    modules: plan.features.map((f) => ({
      id: f.id,
      order: f.order,
      stepOrder: f.stepOrder ?? null,
      recapOrder: f.recapOrder ?? null,
      stepLabel: f.stepLabel,
      name: f.name,
      category: f.category,
      level: f.level,
      role: f.prerequisite ? "prerequisite" : "level",
      minutes: f.minutes,
      summary: f.summary,
      docUrls: f.docUrls || [],
      learnLinks: f.learnLinks || [],
    })),
    level: plan.level,
    products: plan.products,
    productNames: plan.productNames,
    harness: plan.harness,
    includeKnowledgeCheck: Boolean(plan.includeKnowledgeCheck),
    requiresSharepointSite: Boolean(plan.requiresSharepointSite),
    sharepointSite: plan.sharepointSite
      ? {
          name: plan.sharepointSite.name,
          url: plan.sharepointSite.url,
          label: plan.sharepointSite.label,
          configured: Boolean(plan.sharepointSite.configured),
        }
      : { name: null, url: null, label: null, configured: false },
    warnings: plan.warnings,
  };
}

function createWizardHarness({ extraTopics = [], now = "2026-04-16T12:00:00Z" } = {}) {
  const elements = new Map();
  const recommendCalls = [];
  const previewCalls = [];

  const stepButtons = [1, 2, 3, 4].map((n) => {
    const li = { hidden: false };
    const span = { textContent: String(n) };
    return {
      dataset: { lbStep: String(n) },
      disabled: n > 1,
      closest: (sel) => (sel === "li" ? li : null),
      querySelector: (sel) => (sel === "span[aria-hidden]" ? span : null),
      setAttribute() {},
      removeAttribute() {},
      classList: { toggle() {}, add() {}, remove() {} },
    };
  });

  const makeContainer = (id) => {
    const captureListeners = new Map();
    const bubbleListeners = new Map();
    const node = {
      id,
      innerHTML: "",
      textContent: id.startsWith("lb-heading-") ? `Step ${id.slice(-1)} of 4: Heading` : "",
      value: "",
      type: id === "lb-use-learn" || id === "lb-use-llm" ? "checkbox" : "text",
      checked: id === "lb-use-learn" || id === "lb-use-llm",
      hidden: false,
      disabled: false,
      open: false,
      style: {},
      contains: () => false,
      focus() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: (type, handler, options) => {
        const isCapture = options === true || Boolean(options && options.capture);
        const map = isCapture ? captureListeners : bubbleListeners;
        if (!map.has(type)) map.set(type, []);
        map.get(type).push(handler);
      },
      dispatchClick: (target) => {
        let defaultPrevented = false;
        let propagationStopped = false;
        let immediateStopped = false;
        const event = {
          type: "click",
          target,
          get defaultPrevented() {
            return defaultPrevented;
          },
          preventDefault() {
            defaultPrevented = true;
          },
          stopPropagation() {
            propagationStopped = true;
          },
          stopImmediatePropagation() {
            immediateStopped = true;
            propagationStopped = true;
          },
        };
        for (const handler of captureListeners.get("click") || []) {
          handler(event);
          if (immediateStopped) break;
        }
        if (!propagationStopped) {
          for (const handler of bubbleListeners.get("click") || []) {
            handler(event);
            if (immediateStopped) break;
          }
        }
        return event;
      },
      dispatchChange: async (target) => {
        const results = [];
        for (const handler of captureListeners.get("change") || []) {
          results.push(await handler({ type: "change", target }));
        }
        for (const handler of bubbleListeners.get("change") || []) {
          results.push(await handler({ type: "change", target }));
        }
        return results;
      },
    };
    return node;
  };

  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, makeContainer(id));
    }
    return elements.get(id);
  };

  const summaryMirror = { innerHTML: "" };
  const document = {
    activeElement: null,
    getElementById: element,
    querySelector: (sel) => (sel === ".lb-stepper" ? { setAttribute() {} } : null),
    querySelectorAll: (sel) => {
      if (sel === "[data-lb-step]") return stepButtons;
      if (sel === "[data-lb-summary]") return [summaryMirror];
      if (sel === ".lb-pane") return [1, 2, 3, 4].map((n) => element(`lb-pane-${n}`));
      return [];
    },
  };

  const differenceDefaults = Object.fromEntries(getHarnesses().map((h) => [h.id, defaultDifferencesFor(h.id)]));

  const fetch = async (url, init = {}) => {
    if (url === "/api/scenarios") {
      return { ok: true, status: 200, json: async () => ({ industries: getIndustries(), roles: getRoles() }) };
    }
    if (url === "/api/lab-builder/features") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          products: getProducts(),
          categories: getFeaturesByCategory(),
          harnesses: getHarnesses(),
          differenceDefaults,
        }),
      };
    }
    if (url === "/api/lab-builder/learn-topics") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          refreshedAt: now,
          topics: extraTopics.map((t) => ({
            ...t,
            source: "learn",
          })),
          checks: [],
        }),
      };
    }
    if (url === "/api/lab-builder/recommend") {
      const body = JSON.parse(init.body || "{}");
      recommendCalls.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => recommend(body, { topics: extraTopics, now }),
      };
    }
    if (url === "/api/lab-builder/preview") {
      const body = JSON.parse(init.body || "{}");
      previewCalls.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => previewPayloadFromPlan(body),
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const context = vm.createContext({
    console,
    document,
    window: { scrollTo() {} },
    fetch,
    CSS: { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&") },
    URL,
    Set,
    Map,
    Promise,
    Symbol,
    Date,
    Math,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    Error,
    encodeURIComponent,
    decodeURIComponent,
    escapeHtml: (s) =>
      String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;"),
  });

  const code = fs.readFileSync(new URL("../public/lab-builder-wizard.js", import.meta.url), "utf8");
  vm.runInContext(code, context, { filename: "lab-builder-wizard.js" });

  context.__seed = {
    products: getProducts(),
    harnesses: getHarnesses(),
    categories: getFeaturesByCategory(),
    industries: getIndustries(),
    roles: getRoles(),
    differenceDefaults,
  };
  vm.runInContext(
    `
    labBuilder.products = __seed.products;
    labBuilder.harnesses = __seed.harnesses;
    labBuilder.categories = __seed.categories;
    labBuilder.industries = __seed.industries;
    labBuilder.roles = __seed.roles;
    labBuilder.differenceDefaults = __seed.differenceDefaults;
    labBuilder.selectedProducts = new Set([LB_DEFAULT_PRODUCT]);
    labBuilder.chosenSteps = new Set(["product", "tailor", "topics"]);
    labBuilder.loaded = true;
    lbBindTopicEvents();
  `,
    context,
  );

  return { context, element, recommendCalls, previewCalls };
}

test("all 195 catalog features across all 6 products resolve canonical Microsoft Learn links in catalog, recommend(), and planLab()", () => {
  const products = getProducts();
  assert.equal(products.length, 6);

  const rawFeatures = getFeatures();
  assert.equal(rawFeatures.length, 195);

  const byCategoryFeatures = getFeaturesByCategory().flatMap((c) => c.features);
  assert.equal(byCategoryFeatures.length, 195);

  for (const catFeature of byCategoryFeatures) {
    assert.ok(Array.isArray(catFeature.learnLinks), `Expected learnLinks array on ${catFeature.id}`);
    assert.ok(catFeature.learnLinks.length >= 1, `Expected >= 1 Microsoft Learn link on ${catFeature.id}`);
    const seenUrls = new Set();
    const seenTitles = new Set();
    for (const link of catFeature.learnLinks) {
      assert.match(link.url, /^https:\/\/learn\.microsoft\.com\/.+/);
      assert.ok(link.title && link.title.length >= 2, `Expected readable title on ${catFeature.id}`);
      assert.ok(!seenUrls.has(link.url.toLowerCase()), `Duplicate URL on ${catFeature.id}: ${link.url}`);
      assert.ok(!seenTitles.has(link.title.toLowerCase()), `Duplicate title on ${catFeature.id}: ${link.title}`);
      seenUrls.add(link.url.toLowerCase());
      seenTitles.add(link.title.toLowerCase());
    }
  }

  // Verify every single catalog feature resolves learnLinks through recommend() AND planLab().
  const seenInRecommend = new Set();
  for (const product of products) {
    const harnesses = productHasHarnesses(product.id)
      ? getHarnesses()
          .filter((h) => (h.product || "copilot-studio") === product.id)
          .map((h) => h.id)
      : [null];
    for (const level of [100, 200, 300]) {
      for (const harness of harnesses) {
        const rec = recommend({
          products: [product.id],
          level,
          ...(harness ? { harness } : {}),
        });
        for (const topic of rec.concepts.flatMap((c) => c.topics)) {
          assert.ok(topic.learnLinks?.length >= 1, `recommend() topic ${topic.id} missing learnLinks`);
          for (const link of topic.learnLinks) {
            assert.match(link.url, /^https:\/\/learn\.microsoft\.com\/.+/);
          }
          seenInRecommend.add(topic.id);
        }
      }
    }
  }
  assert.equal(seenInRecommend.size, 195, "Every catalog feature must appear in recommend() with learnLinks");

  for (const feature of rawFeatures) {
    const pid = productOf(feature);
    const harness = productHasHarnesses(pid) ? feature.harness?.[0] || "standard" : undefined;
    const plan = planLab({
      products: [pid],
      features: [feature.id],
      level: feature.level,
      ...(harness ? { harness } : {}),
      includeCore: false,
    });
    const planned = plan.features.find((f) => f.id === feature.id);
    assert.ok(planned, `planLab() missing ${feature.id}`);
    assert.ok(planned.learnLinks?.length >= 1, `planLab() module ${feature.id} missing learnLinks`);
    for (const mod of plan.features) {
      assert.ok(mod.learnLinks?.length >= 1, `planLab() prerequisite/module ${mod.id} missing learnLinks`);
      for (const link of mod.learnLinks) {
        assert.match(link.url, /^https:\/\/learn\.microsoft\.com\/.+/);
      }
    }
  }
});

test("extractFeatureLearnLinks deduplicates canonical Learn URLs, formats US English titles/acronyms, and strips unsafe schemes or hosts", () => {
  assert.equal(strictHttpsLearnUrl("javascript:alert(1)"), null);
  assert.equal(strictHttpsLearnUrl("data:text/html,<script>alert(1)</script>"), null);
  assert.equal(strictHttpsLearnUrl("http://learn.microsoft.com/microsoft-copilot-studio/authoring-first-bot"), null);
  assert.equal(strictHttpsLearnUrl("https://docs.microsoft.com/microsoft-copilot-studio/authoring-first-bot"), null);
  assert.equal(strictHttpsLearnUrl("https://learn.microsoft.com.evil.example/microsoft-copilot-studio/x"), null);
  assert.equal(strictHttpsLearnUrl("https://user:pass@learn.microsoft.com/microsoft-copilot-studio/x"), null);
  assert.equal(strictHttpsLearnUrl("https://learn.microsoft.com:8443/microsoft-copilot-studio/x"), null);
  assert.equal(strictHttpsLearnUrl("https://modelcontextprotocol.io/introduction"), null);
  assert.equal(strictHttpsLearnUrl("https://learn.microsoft.com/"), null);

  const links = extractFeatureLearnLinks(
    {
      id: "test-feature",
      name: "Test Feature",
      docUrls: [
        "https://learn.microsoft.com/en-us/microsoft-copilot-studio/add-knowledge-sharepoint/?wt.mc_id=copilot&tabs=new",
        "https://learn.microsoft.com/microsoft-copilot-studio/add-knowledge-sharepoint#configure",
        "https://learn.microsoft.com/microsoft-copilot-studio/add-knowledge-sharepoint?view=mcs-2026",
        "http://learn.microsoft.com/microsoft-copilot-studio/insecure-http",
        "javascript:alert('xss')",
        "https://evil.example/https://learn.microsoft.com/phish",
        "https://learn.microsoft.com/microsoft-copilot-studio/mcp-api-sso-dlp-rbac-alm-m365-rest-oauth-http-json-sql-url-ui-cli-sdk-ide-pr",
      ],
      verifiedAgainst: "https://shopify.dev/docs/apps/build/authentication",
    },
    {
      title: "Connect to Microsoft Copilot Studio with MCP | Microsoft Learn",
      urls: [
        "https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/copilot-studio-mcp/",
        "https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/copilot-studio-mcp-configure",
      ],
      subtopics: [
        {
          id: "learn-mcp-configure",
          title: "Configure access to Copilot Studio MCP",
          url: "https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/copilot-studio-mcp-configure#steps",
        },
      ],
    },
  );

  assert.deepEqual(links, [
    {
      url: "https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/copilot-studio-mcp",
      title: "Connect to Microsoft Copilot Studio with MCP",
    },
    {
      url: "https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/copilot-studio-mcp-configure",
      title: "Configure access to Copilot Studio MCP",
    },
    {
      url: "https://learn.microsoft.com/microsoft-copilot-studio/add-knowledge-sharepoint?view=mcs-2026",
      title: "Add Knowledge SharePoint",
    },
    {
      url: "https://learn.microsoft.com/microsoft-copilot-studio/mcp-api-sso-dlp-rbac-alm-m365-rest-oauth-http-json-sql-url-ui-cli-sdk-ide-pr",
      title: "MCP API SSO DLP RBAC ALM M365 REST OAuth HTTP JSON SQL URL UI CLI SDK IDE PR",
    },
  ]);

  assert.equal(
    formatLearnSlugTitle("https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/overview"),
    "Agents Experience: Overview",
  );
});

test("Topics renders clickable Microsoft Learn links on catalog topics, dynamic multi-URL Learn topics, prerequisites, and level-unknown topics (checked and unchecked)", async () => {
  const dynamicMulti = {
    id: "learn-mcp-multi",
    status: "new",
    title: "Connect to Microsoft Copilot Studio with MCP",
    summary: "Connect developer tools to Copilot Studio agents over MCP.",
    urls: [
      "https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/copilot-studio-mcp",
      "https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/copilot-studio-mcp-configure",
    ],
    subtopics: [
      {
        id: "learn-mcp-multi-config",
        title: "Configure access to Copilot Studio MCP",
        url: "https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/copilot-studio-mcp-configure",
      },
    ],
    harnesses: ["standard"],
    conceptId: "mcp",
    level: 200,
    levelBasis: "estimated",
    steps: ["1. Open **Settings** and enable **Copilot Studio MCP**."],
    lastSeen: "2026-04-16",
    changedAt: "2026-04-16",
  };

  const dynamicUnknown = {
    id: "learn-mystery-feature",
    status: "new",
    title: "Experimental Mystery Capability",
    summary: "An uncategorized capability discovered on Microsoft Learn.",
    urls: ["https://learn.microsoft.com/microsoft-copilot-studio/mystery-capability"],
    harnesses: ["standard"],
    conceptId: null,
    level: null,
    steps: [],
    lastSeen: "2026-04-16",
    changedAt: "2026-04-16",
  };

  const { context, element } = createWizardHarness({ extraTopics: [dynamicMulti, dynamicUnknown] });

  // Select Level 200 + healthcare + standard harness so we get checked catalog topics, unchecked catalog topics,
  // checked lower-level prerequisites, dynamic multi-URL Learn topic, and level-unknown topic.
  await vm.runInContext(
    `
    labBuilder.industry = "healthcare";
    labBuilder.level = 200;
    labBuilder.harness = "standard";
    labBuilder.prereqOpen = true;
    labBuilder.unknownOpen = true;
    labBuilder.step = LB_STEP.topics;
    lbRefresh()
  `,
    context,
  );

  let html = element("lb-topic-groups").innerHTML;

  // Each topic is a compact row: a label (checkbox, title, time, one chip), a Details button, and a details panel.
  // The Microsoft Learn links live in the details, outside the label, so following one can never toggle the checkbox.
  const rowOf = (chunk) => {
    const cls = chunk.slice(0, chunk.indexOf('">'));
    const body = chunk.slice(chunk.indexOf('">') + 2).split("</details>")[0];
    const label = body.slice(0, body.indexOf("</label>"));
    const detailsAt = body.indexOf('<div class="lb-row-details"');
    const details = detailsAt >= 0 ? body.slice(detailsAt) : "";
    const [ownHtml, subtopicHtml = ""] = details.split('<fieldset class="lb-subtopics"');
    const learn = (fragment) => extractAnchors(fragment).filter((a) => a.className.includes("lb-learn-source"));
    return {
      isChecked: /\bchecked\b/.test(cls),
      topicId: body.match(/data-topic="([^"]+)"/)?.[1] || null,
      prereqId: body.match(/data-prerequisite="([^"]+)"/)?.[1] || null,
      label,
      hasDetails: detailsAt >= 0,
      hidden: /^<div class="lb-row-details" id="[^"]+" hidden>/.test(details),
      anchors: learn(ownHtml),
      subtopicAnchors: learn(subtopicHtml),
      visibleAnchors: extractAnchors(label),
      body,
    };
  };
  const cards = html.split('<div class="lb-feature lb-row').slice(1).map(rowOf);

  const checkedCatalog = cards.filter((c) => c.topicId && !c.topicId.startsWith("learn-") && c.isChecked);
  const uncheckedCatalog = cards.filter((c) => c.topicId && !c.topicId.startsWith("learn-") && !c.isChecked);
  const checkedPrereqs = cards.filter((c) => c.prereqId && c.isChecked);
  const multiLearnCard = cards.find((c) => c.topicId === "learn-mcp-multi");
  const unknownCard = cards.find((c) => c.topicId === "learn-mystery-feature");

  assert.ok(checkedCatalog.length >= 1, "Expected checked catalog topics in Topics");
  assert.ok(uncheckedCatalog.length >= 1, "Expected unchecked catalog topics in Topics");
  assert.ok(checkedPrereqs.length >= 1, "Expected checked lower-level prerequisite cards in Topics");
  assert.ok(multiLearnCard, "Expected dynamic multi-URL Learn topic card in Topics");
  assert.ok(unknownCard, "Expected level-unknown Learn topic card in Topics");

  // Every single row in Topics (checked & unchecked, catalog, learn, prereq, level-unknown) must render valid Learn links in its details!
  for (const card of cards) {
    const id = card.topicId || card.prereqId;
    assert.ok(card.hasDetails, `Expected a details panel on Topics row ${id}`);
    assert.equal(card.visibleAnchors.length, 0, `The visible row ${id} holds no link; they sit in its details`);
    assert.ok(card.anchors.length >= 1, `Expected >= 1 .lb-learn-source link in the details of Topics row ${id}`);
    const hrefs = new Set();
    for (const anchor of [...card.anchors, ...card.subtopicAnchors]) {
      assert.match(anchor.href, /^https:\/\/learn\.microsoft\.com\/.+/);
      assert.equal(anchor.target, "_blank");
      assert.equal(anchor.rel, "noopener noreferrer");
      assert.ok(anchor.text.length >= 2);
      // A sub-topic's link reads "Microsoft Learn" beside its checkbox, and its name says which sub-topic.
      const ownLink = card.anchors.includes(anchor);
      assert.ok(ownLink ? anchor.ariaLabel?.startsWith(anchor.text) : anchor.ariaLabel?.includes(anchor.text), `WCAG 2.5.3 Label in Name on ${id}: ${anchor.ariaLabel}`);
      assert.ok(!hrefs.has(anchor.href), `Duplicate Learn link ${anchor.href} on Topics row ${id}`);
      hrefs.add(anchor.href);
    }
  }
  assert.ok(cards.filter((c) => c.hasDetails && c.hidden).length >= 1, "the details start closed, so the links are one Details click away");

  // A topic with sub-topics lists its own page in its details; each companion page is a nested, individually checkable
  // sub-topic with its own Learn link beside the checkbox, so no link repeats.
  assert.deepEqual(
    multiLearnCard.anchors.map((a) => ({ href: a.href, text: a.text })),
    [
      {
        href: "https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/copilot-studio-mcp",
        text: "Connect to Microsoft Copilot Studio with MCP",
      },
    ],
  );
  const subtopicRow = html.match(/<li class="lb-subtopic[^"]*">(?:(?!<\/li>)[\s\S])*data-subtopic="learn-mcp-multi-config"[\s\S]*?<\/li>/)?.[0];
  assert.ok(subtopicRow, "Expected the companion page as a nested sub-topic row");
  assert.deepEqual(
    extractAnchors(subtopicRow)
      .filter((a) => a.className.includes("lb-learn-source"))
      .map((a) => ({ href: a.href, target: a.target, rel: a.rel })),
    [
      {
        href: "https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/copilot-studio-mcp-configure",
        target: "_blank",
        rel: "noopener noreferrer",
      },
    ],
  );

  // Now uncheck a prerequisite in Topics and verify unchecked refresher rows STILL render Microsoft Learn links in their details!
  const firstPrereqId = checkedPrereqs[0].prereqId;
  await vm.runInContext(`lbSetPrerequisite(${JSON.stringify(firstPrereqId)}, false)`, context);
  await new Promise((resolve) => setTimeout(resolve, 25));
  html = element("lb-topic-groups").innerHTML;
  const uncheckedPrereq = html
    .split('<div class="lb-feature lb-row')
    .slice(1)
    .map(rowOf)
    .find((row) => row.prereqId === firstPrereqId);
  assert.ok(uncheckedPrereq, `Expected unchecked refresher row for ${firstPrereqId}`);
  assert.equal(uncheckedPrereq.isChecked, false);
  assert.ok(uncheckedPrereq.anchors.length >= 1, "Unchecked refresher row must still show Microsoft Learn links");
  assert.match(uncheckedPrereq.label, /<span class="lb-badge lb-badge-recap">Refresher<\/span>/);
});

test("Review and build renders clickable Microsoft Learn links on included outline rows and excluded Removed from curriculum items", async () => {
  const { context, element } = createWizardHarness();

  await vm.runInContext(
    `
    labBuilder.industry = "healthcare";
    labBuilder.level = 200;
    labBuilder.harness = "standard";
    lbRefresh()
  `,
    context,
  );
  await vm.runInContext("labBuilder.step = LB_STEP.review; lbPreview()", context);

  // The outline starts compact: include checkbox, module, and time. Descriptions and Learn links come with Edit order.
  let previewHtml = element("lb-preview").innerHTML;
  const outlineRows = () => [...element("lb-preview").innerHTML.matchAll(/<tr><td class="lb-outline-include-cell">[\s\S]*?<\/tr>/g)];
  const learnLinksIn = (html) => extractAnchors(html).filter((a) => a.className.includes("lb-learn-source"));
  assert.ok(outlineRows().length >= 2, "Expected included outline rows in Review and build");
  for (const [rowHtml] of outlineRows()) assert.equal(learnLinksIn(rowHtml).length, 0, "no Learn link in a compact outline row");
  assert.match(previewHtml, /<button type="button" class="lb-link-btn" data-outline-action="toggle-edit" aria-expanded="false">Edit order<\/button>/);
  assert.doesNotMatch(previewHtml, /lb-outline-desc-/);

  // Edit order shows the descriptions and Microsoft Learn links, with the Step column and the move buttons.
  const pressEditOrder = async () => {
    element("lb-preview").dispatchClick({
      closest: (sel) => (sel === "button[data-outline-action]" ? { dataset: { outlineAction: "toggle-edit" } } : null),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  await pressEditOrder();
  assert.equal(vm.runInContext("labBuilder.editOrder", context), true);
  previewHtml = element("lb-preview").innerHTML;
  assert.match(previewHtml, /data-outline-action="toggle-edit" aria-expanded="true">Done<\/button>/);
  assert.match(previewHtml, /<th scope="col" class="lb-outline-order-col">Order<\/th><th scope="col">Part<\/th>/);

  for (const [rowHtml] of outlineRows()) {
    const modId = rowHtml.match(/data-outline-module="([^"]+)"/)?.[1];
    assert.match(rowHtml, /<td>(Part|Refresher) \d+<\/td>/, `Expected a part label on outline row ${modId}`);
    const anchors = learnLinksIn(rowHtml);
    assert.ok(anchors.length >= 1, `Expected Microsoft Learn links on Review and build outline row ${modId} in Edit order`);
    for (const anchor of anchors) {
      assert.match(anchor.href, /^https:\/\/learn\.microsoft\.com\/.+/);
      assert.equal(anchor.target, "_blank");
      assert.equal(anchor.rel, "noopener noreferrer");
    }
  }
  previewHtml = element("lb-preview").innerHTML;
  // Uncheck both a prerequisite recap and a Level 200 module in Review and build so both move to Removed from curriculum.
  const firstRecapId = previewHtml.match(/data-outline-module="([^"]+)"\s+data-outline-role="prerequisite"/)?.[1];
  const firstLevelModId = previewHtml.match(/data-outline-module="([^"]+)"\s+data-outline-role="level"/)?.[1];
  assert.ok(firstRecapId,   "Expected a prerequisite recap row in Review and build");
    assert.ok(firstLevelModId, "Expected a level module row in Review and build");

  await vm.runInContext(`lbSetOutlineModule(${JSON.stringify(firstRecapId)}, false)`, context);
  await vm.runInContext(`lbSetOutlineModule(${JSON.stringify(firstLevelModId)}, false)`, context);

  previewHtml = element("lb-preview").innerHTML;
  assert.match(previewHtml, /Removed from curriculum/);

  const removedCards = [...previewHtml.matchAll(/<label class="lb-removed-item[^"]*">([\s\S]*?)<\/label>/g)];
  assert.equal(removedCards.length, 2);

  for (const [, cardInner] of removedCards) {
    const modId = cardInner.match(/data-outline-module="([^"]+)"/)?.[1];
    const anchors = extractAnchors(cardInner).filter((a) => a.className.includes("lb-learn-source"));
    assert.ok(anchors.length >= 1, `Expected Microsoft Learn links on Review and build removed card ${modId}`);
    for (const anchor of anchors) {
      assert.match(anchor.href, /^https:\/\/learn\.microsoft\.com\/.+/);
      assert.equal(anchor.target, "_blank");
      assert.equal(anchor.rel, "noopener noreferrer");
    }
  }
});

test("clicking a .lb-learn-source link inside a <label> preserves native link navigation and never toggles checkboxes in Topics or Review and build", async () => {
  const { context, element, recommendCalls, previewCalls } = createWizardHarness();

  await vm.runInContext(
    `
    labBuilder.industry = "healthcare";
    labBuilder.level = 200;
    labBuilder.harness = "standard";
    labBuilder.prereqOpen = true;
    labBuilder.step = LB_STEP.topics;
    lbRefresh()
  `,
    context,
  );

  const topicGroups = element("lb-topic-groups");
  const initialSelectedCount = vm.runInContext("labBuilder.rec.selectedIds.length", context);
  const initialPrereqCount = vm.runInContext("labBuilder.rec.prerequisites.selectedIds.length", context);
  const recCallsBefore = recommendCalls.length;

  // Topic rows keep their links in the details, outside the label. The guard still covers a link inside a <label> (the Removed
  // list, and any markup that puts one there): simulate a hostile/legacy DOM that attempts to synthesize a click + change on the
  // sibling checkbox!
  const topicCheckbox = {
    type: "checkbox",
    checked: true,
    dataset: { topic: "knowledge-sources", required: "false" },
    closest: (sel) => (sel === "input[data-topic]" ? topicCheckbox : null),
  };
  const topicLabel = {
    querySelector: (sel) => (sel === 'input[type="checkbox"]' ? topicCheckbox : null),
  };
  const topicLink = {
    href: "https://learn.microsoft.com/microsoft-copilot-studio/knowledge-copilot-studio",
    closest: (sel) => {
      if (sel === "a.lb-learn-source") return topicLink;
      if (sel === "label") return topicLabel;
      return null;
    },
  };

  const linkClickEvent = topicGroups.dispatchClick(topicLink);
  assert.equal(
    linkClickEvent.defaultPrevented,
    false,
    "Clicking .lb-learn-source must NOT call preventDefault() so target=_blank navigation works",
  );

  // Even if a non-standard DOM flips checkbox.checked and dispatches synthetic click + change synchronously:
  topicCheckbox.checked = false;
  const syntheticCheckboxClick = topicGroups.dispatchClick(topicCheckbox);
  assert.equal(syntheticCheckboxClick.defaultPrevented, true);
  assert.equal(topicCheckbox.checked, true, "Checkbox state must remain unchanged after clicking Learn link");
  await topicGroups.dispatchChange(topicCheckbox);
  assert.equal(topicCheckbox.checked, true);
  assert.equal(recommendCalls.length, recCallsBefore, "lbSetTopic must not run when a Learn link was clicked");
  assert.equal(vm.runInContext("labBuilder.rec.selectedIds.length", context), initialSelectedCount);

  // Wait a microtask so the synchronous click guard clears, then test Topics prerequisite link click too.
  await Promise.resolve();

  const prereqCheckbox = {
    type: "checkbox",
    checked: true,
    dataset: { prerequisite: "create-agent" },
    closest: (sel) => (sel === "input[data-prerequisite]" ? prereqCheckbox : null),
  };
  const prereqLabel = {
    querySelector: (sel) => (sel === 'input[type="checkbox"]' ? prereqCheckbox : null),
  };
  const prereqLink = {
    href: "https://learn.microsoft.com/microsoft-copilot-studio/authoring-first-bot",
    closest: (sel) => {
      if (sel === "a.lb-learn-source") return prereqLink;
      if (sel === "label") return prereqLabel;
      return null;
    },
  };

  const prereqLinkClick = topicGroups.dispatchClick(prereqLink);
  assert.equal(prereqLinkClick.defaultPrevented, false);
  prereqCheckbox.checked = false;
  await topicGroups.dispatchChange(prereqCheckbox);
  assert.equal(prereqCheckbox.checked, true);
  assert.equal(vm.runInContext("labBuilder.rec.prerequisites.selectedIds.length", context), initialPrereqCount);

  await Promise.resolve();

  // Clicking non-link whitespace/prefix inside `.lb-learn-links` prevents accidental `<label>` toggle.
  const linksWrapperSpan = {
    closest: (sel) => (sel === ".lb-learn-links" ? linksWrapperSpan : null),
  };
  const wrapperClick = topicGroups.dispatchClick(linksWrapperSpan);
  assert.equal(wrapperClick.defaultPrevented, true);

  // Verify normal direct checkbox toggling STILL works right afterward!
  topicCheckbox.checked = false;
  await topicGroups.dispatchChange(topicCheckbox);
  assert.equal(recommendCalls.length, recCallsBefore + 1, "Direct checkbox change must still toggle topic selection");

  // Now verify Review and build (`#lb-preview`) Removed from curriculum `<label>` link clicks also never re-include the module!
  await vm.runInContext("labBuilder.step = LB_STEP.review; lbPreview()", context);
  await vm.runInContext('lbSetOutlineModule("create-agent", false)', context);
  const previewEl = element("lb-preview");
  const previewCallsBefore = previewCalls.length;

  const removedCheckbox = {
    type: "checkbox",
    checked: false,
    dataset: { outlineModule: "create-agent", outlineRole: "prerequisite" },
    closest: (sel) => (sel === "input[data-outline-module]" ? removedCheckbox : null),
  };
  const removedLabel = {
    querySelector: (sel) => (sel === 'input[type="checkbox"]' ? removedCheckbox : null),
  };
  const removedLink = {
    href: "https://learn.microsoft.com/microsoft-copilot-studio/authoring-first-bot",
    closest: (sel) => {
      if (sel === "a.lb-learn-source") return removedLink;
      if (sel === "label") return removedLabel;
      return null;
    },
  };

  const removedLinkClick = previewEl.dispatchClick(removedLink);
  assert.equal(removedLinkClick.defaultPrevented, false);
  removedCheckbox.checked = true;
  await previewEl.dispatchChange(removedCheckbox);
  assert.equal(removedCheckbox.checked, false);
  assert.equal(previewCalls.length, previewCallsBefore, "lbSetOutlineModule must not run when clicking a Learn link");
  assert.equal(vm.runInContext('labBuilder.excluded.has("create-agent")', context), true);
});

test("topicToFeature dynamic Learn features also carry learnLinks through planLab()", () => {
  const dynFeature = topicToFeature({
    id: "learn-custom-topic",
    title: "Build Autonomous Triggers in Copilot Studio",
    summary: "Configure event-driven triggers.",
    urls: [
      "https://learn.microsoft.com/microsoft-copilot-studio/authoring-triggers-overview",
      "https://learn.microsoft.com/microsoft-copilot-studio/authoring-triggers-payload",
    ],
    subtopics: [
      {
        id: "learn-custom-topic-payload",
        title: "Customize Trigger Payloads with Power Fx",
        url: "https://learn.microsoft.com/microsoft-copilot-studio/authoring-triggers-payload",
      },
    ],
    harnesses: ["standard"],
    conceptId: "tools",
    level: 200,
    steps: ["1. Open **Triggers** and add an event trigger."],
  });

  const links = extractFeatureLearnLinks(dynFeature);
  assert.deepEqual(links, [
    {
      url: "https://learn.microsoft.com/microsoft-copilot-studio/authoring-triggers-overview",
      title: "Build Autonomous Triggers in Copilot Studio",
    },
    {
      url: "https://learn.microsoft.com/microsoft-copilot-studio/authoring-triggers-payload",
      title: "Customize Trigger Payloads with Power Fx",
    },
  ]);
});
