import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

const tabs = [...html.matchAll(/<button class="tab[^"]*" id="tab-([a-z]+)"[^>]*data-tab="([a-z]+)" data-group="([a-z]+)"([^>]*)>([^<]+)</g)].map(
  (m) => ({ id: m[1], tab: m[2], group: m[3], hidden: /\bhidden\b/.test(m[4]), label: m[5].trim() }),
);

test("no panel was removed: all ten tabs still exist with their original ids", () => {
  assert.deepEqual(
    tabs.map((t) => t.tab).sort(),
    ["agent", "azure", "config", "email", "labbuilder", "powerplatform", "preview", "provision", "scenarios", "validate"],
  );
  for (const t of tabs) {
    assert.equal(t.id, t.tab);
    assert.match(html, new RegExp(`id="panel-${t.tab}" role="tabpanel" aria-labelledby="tab-${t.tab}"`));
  }
});

test("the ten tabs are grouped into four areas plus the header assistant", () => {
  const groups = Object.groupBy(tabs, (t) => t.group);
  assert.deepEqual(Object.keys(groups).sort(), ["assistant", "build", "check", "deploy", "settings"]);
  assert.deepEqual(groups.build.map((t) => t.tab), ["labbuilder", "scenarios"]);
  assert.deepEqual(groups.check.map((t) => t.tab), ["preview", "validate"]);
  assert.deepEqual(groups.deploy.map((t) => t.tab), ["provision", "azure", "powerplatform", "email"]);
  assert.deepEqual(groups.settings.map((t) => t.tab), ["config"]);
  assert.deepEqual(groups.assistant.map((t) => t.tab), ["agent"]);

  const primary = [...html.matchAll(/<button type="button" class="tab-group" data-group="([a-z]+)" data-first-tab="([a-z]+)">([^<]+)</g)];
  assert.deepEqual(primary.map((m) => m[1]), ["build", "check", "deploy", "settings"]);
  for (const [, group, first] of primary) assert.equal(tabs.find((t) => t.tab === first).group, group);
  assert.match(html, /<nav class="tab-groups" aria-label="Portal areas">/);
  assert.match(html, /onclick="setActiveTab\('agent'\)"[^>]*>🤖 Assistant</);
});

test("Build a Lab is the landing tab and only its area's tabs show first", () => {
  assert.match(html, /<button class="tab active" id="tab-labbuilder"[^>]*aria-selected="true"/);
  assert.match(html, /<div class="tab-panel active" id="panel-labbuilder"[^>]*aria-hidden="false"/);
  assert.doesNotMatch(html, /<div class="tab-panel active" id="panel-provision"/);
  for (const t of tabs) assert.equal(t.hidden, t.group !== "build", `${t.tab} initial visibility`);
});

test("confusing names are plain: Provision is Lab setup, Email is Email labs, Agent Chat is the Assistant", () => {
  const label = (id) => tabs.find((t) => t.tab === id).label;
  assert.match(label("provision"), /Lab setup/);
  assert.match(label("azure"), /Azure resources/);
  assert.match(label("email"), /Email labs/);
  assert.match(label("agent"), /Assistant/);
  assert.doesNotMatch(html, /🚀 Provision</);
});

test("navigation code keeps the keyboard model, deep links, and one hint per area", () => {
  assert.match(app, /function visibleTabs\(\)/);
  assert.match(app, /const tabs = visibleTabs\(\)/, "arrow keys move among the visible tabs only");
  assert.match(app, /window\.addEventListener\("hashchange"/);
  assert.match(app, /history\.replaceState/);
  assert.match(app, /const DEFAULT_TAB = "labbuilder"/);
  for (const group of ["build", "check", "deploy", "settings", "assistant"]) assert.match(app, new RegExp(`${group}: \\{ label:`));
  assert.match(app, /setAttribute\("aria-current", "page"\)/);
});

test("old links still work because panel ids are unchanged", () => {
  for (const name of ["provision", "scenarios", "azure", "powerplatform", "validate", "email", "agent", "config"]) {
    assert.match(html, new RegExp(`id="panel-${name}"`));
  }
  assert.match(app, /document\.getElementById\(`panel-\$\{fromHash\}`\) \? fromHash : DEFAULT_TAB/);
});
