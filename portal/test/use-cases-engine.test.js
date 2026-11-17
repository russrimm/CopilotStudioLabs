/**
 * Use Case Builder: the data, the generator, and the optional AI wording pass.
 * Hermetic: no network, no language model, no browser.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { getFeatures } from "../lib/lab-builder/catalog.js";
import { extractFeatureLearnLinks } from "../lib/lab-builder/learn-citations.js";
import { productOf } from "../lib/lab-builder/products.js";
import { getIndustries, getRoles } from "../lib/scenarios.js";
import {
  applyPolish,
  generateUseCases,
  getUseCaseData,
  normalizeRequest,
  polishUseCases,
  rejectionReason,
  resolvePattern,
  UseCaseRequestError,
  validateUseCaseData,
} from "../lib/use-cases/index.js";

const CS = "copilot-studio";
const AB = "m365-copilot-agent-builder";
const catalog = new Map(getFeatures().map((f) => [f.id, f]));
const industries = getIndustries().map((i) => i.id);
const departments = getRoles().map((d) => d.id);
const countOf = (response, product) => response.useCases.filter((u) => u.product === product).length;

// ── The data ────────────────────────────────────────────────────────────────

test("the shipped data is sound: ids, templates, products, harnesses, and US English all check out", () => {
  assert.deepEqual(validateUseCaseData(), []);
});

test("every pattern resolves against the catalog and never claims what its product or harness lacks", () => {
  const data = getUseCaseData();
  assert.ok(data.patterns.length >= 60);
  for (const pattern of data.patterns) {
    const resolved = resolvePattern(pattern);
    assert.equal(resolved.ok, true, `${pattern.id}: ${resolved.problems.join("; ")}`);
    for (const feature of resolved.features) {
      assert.ok(catalog.has(feature.id), `${pattern.id}: ${feature.id} is not in the catalog`);
      assert.equal(productOf(feature), pattern.product, `${pattern.id}: ${feature.id} belongs to another product`);
      assert.notEqual(feature.availability, "retired", `${pattern.id}: ${feature.id} is retired`);
      if (pattern.product === CS) assert.ok(feature.harness.includes(pattern.harness), `${pattern.id}: ${feature.id} is not on the ${pattern.harness} harness`);
      else assert.equal(feature.harness, undefined);
    }
  }
});

test("Agent Builder patterns use only what Agent Builder supports: no Dataverse or line-of-business data, no Copilot Studio capability", () => {
  const data = getUseCaseData();
  const allowedSources = new Set(["sharepoint", "web", "teams", "email", "none"]);
  for (const pattern of data.patterns.filter((p) => p.product === AB)) {
    for (const source of pattern.dataSources) assert.ok(allowedSources.has(source), `${pattern.id} lists ${source}`);
    for (const need of pattern.needs) assert.notEqual(data.capabilities[need].forcesCopilotStudio, true, `${pattern.id} needs ${need}`);
    assert.equal(pattern.harness, undefined, `${pattern.id} must not name a harness`);
  }
  // Every capability that needs an external system, a workflow, or a channel belongs to Copilot Studio.
  for (const id of ["agent-flows", "connector-tools", "custom-connectors", "servicenow", "web-sdk", "voice", "authentication", "mc-triggers"]) {
    assert.equal(data.capabilities[id].product, CS, id);
    assert.equal(data.capabilities[id].forcesCopilotStudio, true, id);
  }
});

test("industries read differently: no industry and department share the same example, knowledge, or KPI wording", () => {
  const data = getUseCaseData();
  for (const department of departments) {
    for (const key of ["who", "topic", "docs", "work", "data", "kpi", "ask"]) {
      const values = industries.map((id) => data.contexts.get(id).departments[department][key]);
      assert.equal(new Set(values).size, values.length, `${department}.${key} repeats across industries`);
    }
  }
});

// ── Coverage ────────────────────────────────────────────────────────────────

test("every industry and department gets at least 3 Copilot Studio and 3 Agent Builder use cases, and a single platform gets only its own", () => {
  for (const industry of industries) {
    for (const department of departments) {
      const both = generateUseCases({ industry, departments: [department] });
      assert.ok(countOf(both, CS) >= 3, `${industry}/${department}: ${countOf(both, CS)} Copilot Studio use cases`);
      assert.ok(countOf(both, AB) >= 3, `${industry}/${department}: ${countOf(both, AB)} Agent Builder use cases`);
    }
    const studio = generateUseCases({ industry, departments: ["finance"], platform: "copilot-studio" });
    assert.ok(studio.useCases.length >= 3 && studio.useCases.every((u) => u.product === CS));
    assert.deepEqual(Object.keys(studio.groups), [CS]);
    const builder = generateUseCases({ industry, departments: ["finance"], platform: "agent-builder" });
    assert.ok(builder.useCases.length >= 3 && builder.useCases.every((u) => u.product === AB));
    assert.deepEqual(Object.keys(builder.groups), [AB]);
  }
});

test("an industry alone still gives a varied, capped list, and broader selections give more", () => {
  for (const industry of industries) {
    const alone = generateUseCases({ industry });
    assert.ok(alone.useCases.length >= 30, `${industry}: ${alone.useCases.length}`);
    assert.ok(alone.useCases.length <= 40);
    assert.ok(countOf(alone, CS) >= 10 && countOf(alone, AB) >= 10, "both products are well represented");
    assert.ok(new Set(alone.useCases.flatMap((u) => u.departments)).size >= 6, "spread across departments");
    assert.ok(new Set(alone.useCases.map((u) => u.patternId)).size >= 15, "spread across ideas");
    assert.equal(alone.summary.capped, alone.summary.matched > alone.useCases.length);
  }
  const one = generateUseCases({ industry: "healthcare", departments: ["hr"] });
  const three = generateUseCases({ industry: "healthcare", departments: ["hr", "it", "finance"] });
  assert.ok(three.summary.matched > one.summary.matched);
});

test("the list is deterministic, de-duplicated, and independent of the order of the choices", () => {
  const a = generateUseCases({ industry: "retail", departments: ["sales", "marketing", "finance"], goals: ["grow-revenue", "reduce-cost"], dataSources: ["sharepoint", "web"] });
  const b = generateUseCases({ dataSources: ["web", "sharepoint"], goals: ["reduce-cost", "grow-revenue"], departments: ["finance", "sales", "marketing"], industry: "retail", platform: "both", level: null });
  assert.deepEqual(a, b);
  assert.deepEqual(a, generateUseCases(a.query));
  for (const industry of industries) {
    const response = generateUseCases({ industry });
    const ids = response.useCases.map((u) => u.id);
    const titles = response.useCases.map((u) => u.title.toLowerCase());
    assert.equal(new Set(ids).size, ids.length, "ids are unique");
    assert.equal(new Set(titles).size, titles.length, "titles are unique");
    for (const u of response.useCases) assert.match(u.id, /^[a-z-]+\.[a-z-]+\.[a-z0-9-]+$/);
  }
});

test("no two industries produce the same text for the same idea and department", () => {
  const seen = new Map();
  for (const industry of industries) {
    for (const u of generateUseCases({ industry, departments: ["customer-service"] }).useCases) {
      for (const field of ["title", "description", "instructions"]) {
        const key = `${u.patternId}|${field}|${u[field]}`;
        if (seen.has(key) && seen.get(key) !== industry) assert.fail(`${u.patternId} ${field} is identical in ${seen.get(key)} and ${industry}`);
        seen.set(key, industry);
      }
    }
  }
  const retail = generateUseCases({ industry: "retail", departments: ["finance"], platform: "agent-builder" }).useCases.find((u) => u.patternId === "ab-sharepoint-guide");
  const health = generateUseCases({ industry: "healthcare", departments: ["finance"], platform: "agent-builder" }).useCases.find((u) => u.patternId === "ab-sharepoint-guide");
  assert.match(retail.description, /markdown|vendor|shrink/i);
  assert.match(health.description, /claims|denial|payer|billing/i);
});

// ── Accuracy ────────────────────────────────────────────────────────────────

test("every use case is built from the catalog: topics, levels, harnesses, flags, and Learn links all match it", () => {
  for (const industry of industries) {
    const response = generateUseCases({ industry, departments: [], platform: "both" });
    for (const u of response.useCases) {
      assert.ok(u.labTopics.length >= 2, u.id);
      for (const topic of u.labTopics) {
        const feature = catalog.get(topic.id);
        assert.ok(feature, `${u.id}: ${topic.id} is not in the catalog`);
        assert.equal(productOf(feature), u.product);
        assert.equal(topic.level, feature.level);
        if (u.product === CS) assert.ok(feature.harness.includes(u.harness), `${u.id}: ${topic.id} is not on ${u.harness}`);
      }
      assert.equal(u.level, Math.max(...u.labTopics.map((t) => t.level)), `${u.id} level is its hardest topic`);
      assert.equal(u.levelLabel, { 100: "Beginner", 200: "Intermediate", 300: "Advanced" }[u.level]);
      assert.equal(u.flags.preview, u.labTopics.some((t) => catalog.get(t.id).availability === "preview"));
      assert.equal(u.flags.thirdParty, u.labTopics.some((t) => catalog.get(t.id).thirdPartyConnector === true));
      assert.equal(u.labMinutes, u.labTopics.reduce((sum, t) => sum + t.minutes, 0));
      if (u.product === AB) assert.equal(u.harness, null);

      assert.ok(u.learnLinks.length >= 1 && u.learnLinks.length <= 3, u.id);
      const allowed = new Set(u.labTopics.flatMap((t) => extractFeatureLearnLinks(catalog.get(t.id)).map((l) => l.url)));
      for (const link of u.learnLinks) {
        assert.match(link.url, /^https:\/\/learn\.microsoft\.com\//);
        assert.ok(allowed.has(link.url), `${u.id}: ${link.url} is not one of the catalog's own links`);
        assert.ok(link.title.length > 2);
      }
      const urls = JSON.stringify(u).match(/https?:\/\/[^\s"\\]+/g) || [];
      for (const url of urls) assert.match(url, /^https:\/\/learn\.microsoft\.com\//, `${u.id} carries ${url}`);
    }
  }
});

test("each use case explains why its product, and the explanation matches what it needs", () => {
  const response = generateUseCases({ industry: "financial-services", platform: "both" });
  const data = getUseCaseData();
  for (const u of response.useCases) {
    assert.ok(u.whyProduct.length > 60, u.id);
    const pattern = data.patterns.find((p) => p.id === u.patternId);
    const forced = pattern.needs.filter((id) => data.capabilities[id].forcesCopilotStudio);
    if (u.product === AB) {
      assert.match(u.whyProduct, /^Agent Builder is enough here/);
      assert.match(u.whyProduct, /no external-system actions, workflows, or channels/);
      assert.equal(forced.length, 0);
    } else if (forced.length) {
      assert.match(u.whyProduct, /^Copilot Studio is the right fit because this agent /);
      for (const id of forced.slice(0, 4)) assert.ok(u.whyProduct.includes(data.capabilities[id].fit), `${u.id} omits "${data.capabilities[id].fit}"`);
    } else {
      assert.ok(u.whyProduct.includes(pattern.fit), u.id);
    }
    assert.ok(u.prerequisites.length >= 1 && u.prerequisites[0].length > 20);
  }
  const preview = response.useCases.filter((u) => u.flags.preview);
  assert.ok(preview.length > 0);
  for (const u of preview) assert.ok(u.prerequisites.some((p) => /Preview capabilities/.test(p)), u.id);
  const third = generateUseCases({ industry: "manufacturing", departments: ["operations"], dataSources: ["lob"] }).useCases.filter((u) => u.flags.thirdParty);
  assert.ok(third.length > 0);
  for (const u of third) assert.ok(u.prerequisites.some((p) => /third-party connector/.test(p)), u.id);
});

test("harness notes come from the product-differences data and name the harness correctly", () => {
  const response = generateUseCases({ industry: "retail", departments: ["customer-service"], platform: "copilot-studio" });
  const withNotes = response.useCases.filter((u) => u.harnessNotes.length);
  assert.ok(withNotes.length > 0);
  for (const u of withNotes) {
    assert.ok(u.harnessNotes.length <= 2);
    for (const note of u.harnessNotes) assert.match(note, /harness/i);
  }
  const customerConversation = response.useCases.find((u) => u.harness === "customer-conversation");
  assert.ok(customerConversation);
  assert.equal(customerConversation.harnessPreview, true);
  assert.ok(customerConversation.flags.preview);
});

test("a pattern the catalog cannot support is left out and reported, never shown", () => {
  const data = getUseCaseData();
  const broken = { ...data.patterns[0], id: "cs-broken-test", needs: ["instructions", "no-such-capability"] };
  assert.equal(resolvePattern(broken).ok, false);
  const wrongHarness = { ...data.patterns.find((p) => p.id === "cs-mc-skills"), id: "cs-wrong-harness-test", harness: "standard" };
  const resolved = resolvePattern(wrongHarness);
  assert.equal(resolved.ok, false);
  assert.match(resolved.problems.join(" "), /not available on the standard harness/);
  const retired = { ...data.patterns.find((p) => p.id === "cs-knowledge-assistant"), id: "cs-retired-test" };
  const feature = catalog.get("knowledge-sharepoint");
  const original = feature.availability;
  feature.availability = "retired";
  try {
    assert.match(resolvePattern(retired).problems.join(" "), /retired/);
  } finally {
    feature.availability = original;
  }
});

// ── Level, goals, and data sources ─────────────────────────────────────────

test("the level filter is strict when enough exact matches exist, and borrows marked neighbors when it does not", () => {
  for (const level of [100, 200, 300]) {
    const response = generateUseCases({ industry: "healthcare", departments: ["customer-service"], level });
    for (const product of [CS, AB]) {
      const own = response.useCases.filter((u) => u.product === product);
      const exact = own.filter((u) => u.level === level);
      assert.ok(own.length >= 3, `${product} at ${level}`);
      assert.ok(exact.length > 0, `${product} has something at ${level}`);
      for (const u of own) assert.equal(u.match.levelFit, u.level === level ? "exact" : "nearby");
      if (exact.length >= 3) assert.equal(own.length, exact.length, "no neighbors when three exact matches exist");
      else assert.ok(response.coverage.notes.some((n) => /nearest level/.test(n)));
    }
  }
  const strict = generateUseCases({ industry: "retail", level: 200 });
  assert.ok(strict.useCases.every((u) => u.level === 200));
  assert.ok(strict.useCases.length >= 20);
  const beginner = generateUseCases({ industry: "retail", departments: ["sales"], level: 100, platform: "agent-builder" });
  assert.deepEqual(beginner.useCases.filter((u) => u.match.levelFit === "exact").map((u) => u.level), [100, 100]);
});

test("goals move matching use cases up, and the primary goal counts most", () => {
  const base = generateUseCases({ industry: "retail", departments: ["marketing", "sales"], platform: "agent-builder" });
  const goal = generateUseCases({ industry: "retail", departments: ["marketing", "sales"], platform: "agent-builder", goals: ["grow-revenue"] });
  const matching = goal.useCases.filter((u) => u.goals.includes("grow-revenue")).length;
  assert.ok(matching >= 3 && matching < goal.useCases.length);
  assert.ok(goal.useCases.slice(0, matching).every((u) => u.goals.includes("grow-revenue")), "every use case that supports the goal comes before any that does not");
  assert.ok(goal.useCases[0].match.reasons.some((r) => /Grow revenue/.test(r)));
  assert.notDeepEqual(base.useCases.map((u) => u.id), goal.useCases.map((u) => u.id));
  const scoreOf = (response, patternId) => response.useCases.find((u) => u.patternId === patternId).match.score;
  assert.ok(scoreOf(goal, "ab-public-source-watch") > scoreOf(base, "ab-public-source-watch"));
  const primary = scoreOf(goal, "ab-visual-content");
  const secondary = scoreOf(generateUseCases({ industry: "retail", departments: ["marketing"], platform: "agent-builder", goals: ["customer-experience"] }), "ab-visual-content");
  assert.ok(primary > 0 && secondary > 0);
});

test("data sources shape the ranking, and Agent Builder never pretends to reach Dataverse or line-of-business systems", () => {
  const lob = generateUseCases({ industry: "manufacturing", departments: ["it"], dataSources: ["lob"] });
  const none = generateUseCases({ industry: "manufacturing", departments: ["it"] });
  const rank = (response, patternId) => response.useCases.find((u) => u.patternId === patternId)?.match.rank;
  assert.ok(rank(lob, "cs-servicenow-tickets") < rank(none, "cs-servicenow-tickets"), "ServiceNow moves up when you have a line-of-business system");
  assert.ok(lob.useCases.find((u) => u.patternId === "cs-servicenow-tickets").match.reasons.some((r) => /ServiceNow, Salesforce, SAP/.test(r)));

  const withNote = generateUseCases({ industry: "retail", departments: ["finance"], dataSources: ["dataverse", "lob"], platform: "both" });
  assert.ok(withNote.coverage.notes.some((n) => /Agent Builder works with SharePoint and OneDrive content/.test(n) && /reached through Copilot Studio/.test(n)));
  const builderOnly = generateUseCases({ industry: "retail", departments: ["finance"], dataSources: ["dataverse"], platform: "agent-builder" });
  assert.ok(builderOnly.coverage.notes.some((n) => /None of the data you listed can be used by Agent Builder/.test(n)));
  assert.ok(builderOnly.useCases.length >= 3 && builderOnly.useCases.every((u) => u.product === AB && !u.dataSources.includes("dataverse") && !u.dataSources.includes("lob")));

  const noneYet = generateUseCases({ industry: "retail", departments: ["finance"], dataSources: ["none"] });
  const startsWithNoData = noneYet.useCases.filter((u) => u.match.rank <= 3);
  assert.ok(startsWithNoData.every((u) => u.dataSources.includes("none")), "None yet favors use cases that need no prepared data");

  const email = generateUseCases({ industry: "retail", departments: ["sales"], platform: "agent-builder", dataSources: ["email"] });
  assert.equal(email.useCases[0].patternId, "ab-email-follow-ups");
  const mismatch = generateUseCases({ industry: "retail", departments: ["sales"], platform: "agent-builder", dataSources: ["web"] }).useCases.find((u) => u.patternId === "ab-shared-team-agent");
  assert.deepEqual(mismatch.match.missingData, ["sharepoint"]);
});

test("coverage notes say what was capped, previewed, third-party, or broad", () => {
  const broad = generateUseCases({ industry: "education" });
  assert.ok(broad.coverage.notes.some((n) => /No department is selected/.test(n)));
  assert.ok(broad.coverage.notes.some((n) => /Showing the best 40 of \d+ matching use cases/.test(n)));
  const focused = generateUseCases({ industry: "education", departments: ["hr"] });
  assert.ok(!focused.coverage.notes.some((n) => /No department is selected/.test(n)));
  assert.equal(focused.coverage.excludedPatterns, 0);
  assert.equal(broad.summary.returned, broad.useCases.length);
  assert.deepEqual(Object.keys(broad.facets), ["products", "levels", "departments", "goals", "dataSources", "harnesses", "efforts"]);
  assert.equal(broad.facets.products[CS] + broad.facets.products[AB], broad.useCases.length);
  assert.ok(broad.bestMatches.length >= 4 && broad.bestMatches.every((id) => broad.useCases.some((u) => u.id === id)));
});

// ── Requests ────────────────────────────────────────────────────────────────

test("requests are validated strictly with clear messages that never echo markup", () => {
  const fails = (input, pattern) => {
    assert.throws(() => normalizeRequest(input), (err) => {
      assert.ok(err instanceof UseCaseRequestError);
      assert.equal(err.status, 400);
      assert.match(err.message, pattern);
      assert.doesNotMatch(err.message, /[<>]/);
      return true;
    });
  };
  fails(null, /must be a JSON object/);
  fails([], /must be a JSON object/);
  fails({}, /industry is required/);
  fails({ industry: 7 }, /industry is required/);
  fails({ industry: "mining" }, /Unknown industry "mining"\. Valid values: manufacturing, retail/);
  fails({ industry: "<script>alert(1)</script>" }, /Unknown industry "\(invalid value\)"/);
  fails({ industry: "retail", departments: ["finance", "wizardry"] }, /Unknown department "wizardry"/);
  fails({ industry: "retail", goals: ["win"] }, /Unknown goal "win"/);
  fails({ industry: "retail", dataSources: ["fax"] }, /Unknown data source "fax"/);
  fails({ industry: "retail", platform: "power-apps" }, /Unknown platform "power-apps"/);
  fails({ industry: "retail", level: 250 }, /level must be null, 100, 200, 300/);
  fails({ industry: "retail", level: "200" }, /level must be null, 100, 200, 300/);
  fails({ industry: "retail", polish: "yes" }, /polish must be true or false/);
  fails({ industry: "retail", departments: "finance" }, /departments must be an array/);
  fails({ industry: "retail", departments: [1] }, /departments must contain only text ids/);
  fails({ industry: "retail", departments: Array(13).fill("hr") }, /departments can include at most 12 values/);
  fails({ industry: "retail", goals: Array(8).fill("reduce-cost") }, /goals can include at most 7 values/);
  fails({ industry: "retail", dataSources: Array(8).fill("web") }, /dataSources can include at most 7 values/);
  fails({ industry: "retail", extra: true }, /Unknown field "extra"\. Allowed fields: industry, departments/);
  fails({ industry: "retail", "<img src=x>": 1 }, /Unknown field "\(invalid value\)"/);
  assert.deepEqual(normalizeRequest({ industry: "retail", departments: ["hr", "hr", "finance"] }).departments, ["finance", "hr"]);
  assert.deepEqual(normalizeRequest({ industry: "retail" }), { industry: "retail", departments: [], goals: [], dataSources: [], platform: "both", level: null, polish: false });
});

// ── Polish with AI ──────────────────────────────────────────────────────────

const fakeLlm = (reply, calls = []) => () => ({
  available: true,
  provider: { label: "Fake model" },
  async complete(system, user, options) {
    calls.push({ system, user, options });
    return typeof reply === "function" ? reply(JSON.parse(user)) : reply;
  },
});

test("polish is off by default and never asks a model unless the caller opts in", async () => {
  const response = generateUseCases({ industry: "retail", departments: ["finance"] });
  assert.equal(response.polish.requested, false);
  assert.equal(response.polish.applied, false);
  assert.ok(response.useCases.every((u) => u.polished === undefined));
  const calls = [];
  const none = await polishUseCases(response.useCases, { createLlm: () => ({ available: false, provider: { kind: "none" }, complete: async () => (calls.push(1), "") }) });
  assert.equal(none.applied, false);
  assert.match(none.note, /No language model is configured/);
  assert.equal(calls.length, 0);
});

test("polish rewrites only titles and descriptions of generated use cases and leaves everything else exactly as it was", async () => {
  const response = generateUseCases({ industry: "healthcare", departments: ["hr"], polish: true });
  const calls = [];
  const result = await polishUseCases(response.useCases, {
    createLlm: fakeLlm(
      (input) =>
        JSON.stringify({
          items: input.items.map((item, index) => ({
            id: item.id,
            title: `Reworded: ${item.title}`.slice(0, 100),
            description: index === 0 ? "A clearer description that keeps every fact and names no new product or system at all." : item.description,
          })),
        }),
      calls,
    ),
  });
  assert.equal(result.applied, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.json, true);
  assert.doesNotMatch(calls[0].user, /labTopics|learnLinks|whyProduct|"product"/, "the model sees only ids, titles, and descriptions");
  const polished = applyPolish(response, result);
  assert.equal(polished.polish.applied, true);
  assert.equal(polished.polish.provider, "Fake model");
  assert.equal(polished.useCases.length, response.useCases.length);
  polished.useCases.forEach((u, index) => {
    const before = response.useCases[index];
    assert.equal(u.polished, true);
    assert.match(u.title, /^Reworded: /);
    const { title, description, polished: flag, ...rest } = u;
    const { title: oldTitle, description: oldDescription, ...restBefore } = before;
    assert.deepEqual(rest, restBefore, "products, features, topics, links, and ranking are untouched");
    assert.ok(flag && title && description && oldTitle && oldDescription);
  });
});

test("a rewrite that adds a link, markup, another product, or the wrong length keeps the original wording", async () => {
  const [original] = generateUseCases({ industry: "retail", departments: ["finance"], platform: "agent-builder" }).useCases;
  const good = "A short, plain description that stays within the facts the original gave and adds nothing else.";
  assert.equal(rejectionReason(original, { title: "A clear and concrete title", description: good }), null);
  for (const [rewrite, why] of [
    [{ title: "Short", description: good }, "title length"],
    [{ title: "A clear and concrete title", description: "Too short." }, "description length"],
    [{ title: "See https://evil.example now", description: good }, "link or markup"],
    [{ title: "A clear and concrete title", description: `${good} <b>bold</b>` }, "link or markup"],
    [{ title: "A clear and concrete title", description: `${good} Use Copilot Studio instead.` }, "new product name"],
    [{ title: "A clear and concrete title", description: `${good}\u0007` }, "control characters"],
    [{ title: 5, description: good }, "missing text"],
  ]) assert.equal(rejectionReason(original, rewrite), why);

  const response = generateUseCases({ industry: "retail", departments: ["finance"], platform: "agent-builder" });
  const result = await polishUseCases(response.useCases, {
    createLlm: fakeLlm((input) => JSON.stringify({ items: [{ id: input.items[0].id, title: "Visit https://evil.example today", description: good }, { id: "retail.finance.not-a-real-id", title: "An invented use case", description: good }] })),
  });
  assert.equal(result.applied, false);
  assert.equal(result.rejected, 1);
  assert.match(result.note, /None of the suggested wording passed the checks/);
  const unchanged = applyPolish(response, result);
  assert.deepEqual(unchanged.useCases, response.useCases);
  const broken = await polishUseCases(response.useCases, { createLlm: fakeLlm("not json") });
  assert.equal(broken.applied, false);
  assert.match(broken.note, /did not return usable wording/);
});
