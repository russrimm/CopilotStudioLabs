/**
 * Connector names: the display name a person knows (HTTP with Microsoft Entra ID (preauthorized)), never the internal API
 * name (shared_webcontents), in everything the lab builder produces and shows.
 *
 * Covers the curated table, the resolver, the text rewrite and its limits (code stays as written), the build-time lookup for
 * names that are not in the table, a lab built from Learn pages that print the internal name (every surface: Markdown, HTML,
 * manifest, Word and PowerPoint text, shot list, training decks, administrator guide, checklist, facilitator guide), a saved
 * older lab read through the repair, and a scan of the sample labs the other tests build. Fictional names only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import {
  CONNECTORS_DATA_PATH,
  LITERAL_NOTE_LEAD,
  collectUnknownConnectorIds,
  connectorDisplayName,
  connectorLearnUrl,
  findConnectorIds,
  findConnectorIdsInValue,
  listConnectors,
  needsConnectorRepair,
  repairConnectorNames,
  resolveConnector,
  rewriteConnectorText,
  rewriteConnectorValue,
} from "../lib/lab-builder/connector-names.js";
import { connectorPageTitle, resolveUnknownConnectors } from "../lib/lab-builder/connector-names-live.js";
import { generateLab } from "../lib/lab-builder/generator.js";
import { exportGeneratedLab } from "../lib/exporter.js";
import { scanLabMarkdown } from "../lib/lab-builder/lab-gate.js";
import { readGeneratedLab } from "../lib/lab-builder/generated-labs.js";
import { learnerGuideMarkdown, learnerSafeManifest } from "../lib/lab-builder/learner-guide.js";
import { buildAdministratorSetupGuide, renderAdministratorSetupGuideMarkdown } from "../lib/lab-builder/admin-guide.js";
import { buildPrerequisitesChecklist, renderPrerequisitesChecklistMarkdown } from "../lib/lab-builder/prereq-checklist.js";
import { buildFacilitatorGuideModel, renderFacilitatorGuideMarkdown } from "../lib/lab-builder/facilitator-guide.js";
import { ensureGeneratedLabTrainingDecks, readCachedTrainingDeck } from "../lib/lab-builder/training-decks.js";
import { ensureGeneratedLabTopicDocuments } from "../lib/lab-builder/topic-documents.js";
import { readZipEntries } from "../lib/capture/zip-read.js";
import { buildSampleLabs, readDeck } from "./fixtures/training-labs.js";

process.env.LAB_BUILDER_LINK_CHECK = "off";
process.env.LAB_BUILDER_VENDOR_DOCS = "off";

const TOKEN = /shared[_-][a-z]/i;
const cleanups = [];
const tmp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
test.after(() => cleanups.forEach((fn) => fn()));

// ── The curated table ───────────────────────────────────────────────────────

test("the connector table is verified, unique and large enough to be useful", () => {
  const table = JSON.parse(readFileSync(CONNECTORS_DATA_PATH, "utf8")).connectors;
  assert.ok(table.length >= 60, `${table.length} connectors`);
  const today = new Date().toLocaleDateString("en-CA");
  const apis = new Set();
  const keys = new Map();
  const claim = (key, apiName) => {
    const owner = keys.get(key);
    assert.ok(!owner || owner === apiName, `"${key}" is claimed by both ${owner} and ${apiName}`);
    keys.set(key, apiName);
  };
  for (const entry of table) {
    assert.match(entry.apiName, /^shared_[a-z0-9]+(?:[_-][a-z0-9]+)*$/, entry.apiName);
    assert.ok(!apis.has(entry.apiName), `duplicate ${entry.apiName}`);
    apis.add(entry.apiName);
    assert.ok(entry.displayName && entry.displayName === entry.displayName.trim() && !/\s{2,}/.test(entry.displayName), `${entry.apiName} display name`);
    assert.ok(!TOKEN.test(entry.displayName), `${entry.apiName}: a display name never holds an internal name`);
    const slug = entry.learnSlug || entry.apiName.slice("shared_".length);
    assert.equal(entry.learnUrl, `https://learn.microsoft.com/connectors/${slug}/`, `${entry.apiName} is verified against its own connector reference page`);
    assert.match(entry.verifiedAt, /^\d{4}-\d{2}-\d{2}$/, `${entry.apiName} has a verification date`);
    assert.ok(entry.verifiedAt <= today, `${entry.apiName} was not verified in the future`);
    claim(entry.apiName.toLowerCase(), entry.apiName);
    claim(entry.apiName.slice("shared_".length).toLowerCase(), entry.apiName);
    if (entry.learnSlug) claim(entry.learnSlug.toLowerCase(), entry.apiName);
  }
  for (const entry of table) {
    for (const alias of entry.aliases || []) {
      assert.ok(alias === alias.trim() && alias, `${entry.apiName} alias`);
      claim(alias.toLowerCase().replace(/^shared-/, "shared_"), entry.apiName);
    }
  }
  assert.equal(listConnectors().length, table.length);
});

test("the table covers the connectors the admin prerequisites and the catalog name", () => {
  for (const api of ["shared_commondataserviceforapps", "shared_sharepointonline", "shared_onedriveforbusiness", "shared_teams", "shared_office365", "shared_office365users", "shared_approvals", "shared_flowmanagement", "shared_webcontents", "shared_msnweather", "shared_sql", "shared_service-now", "shared_snowflakev2", "shared_saperp", "shared_sapodata", "shared_salesforce", "shared_jira", "shared_microsoftcopilotstudio"]) {
    assert.ok(resolveConnector(api), api);
  }
});

// ── The resolver ────────────────────────────────────────────────────────────

test("the resolver finds a connector by API name, path, Learn page name or alias, and keeps the Learn title exactly", () => {
  const expected = "HTTP with Microsoft Entra ID (preauthorized)";
  for (const form of ["shared_webcontents", "SHARED_WEBCONTENTS", "shared-webcontents", "/providers/Microsoft.PowerApps/apis/shared_webcontents", "webcontents", "HTTP with Azure AD (preauthorized)"]) {
    assert.equal(connectorDisplayName(form), expected, form);
  }
  assert.equal(connectorDisplayName("shared_service-now"), "ServiceNow");
  assert.equal(resolveConnector("shared_servicebus").learnUrl, "https://learn.microsoft.com/connectors/servicebus-1/", "a Learn page named differently from the API name");
  assert.equal(connectorDisplayName("Azure AD"), "Microsoft Entra ID");
  assert.equal(resolveConnector("shared_not_in_the_table"), null);
  assert.equal(connectorDisplayName(""), null);
  assert.equal(connectorLearnUrl("shared_not_in_the_table"), "https://learn.microsoft.com/connectors/not_in_the_table/", "the page that would name an unknown connector");
});

// ── Rewriting text ──────────────────────────────────────────────────────────

const ENTRA = "HTTP with Microsoft Entra ID (preauthorized)";

test("an id in prose, bold, backticks, a table cell, a list and link text becomes the display name", () => {
  const source = [
    "Select `shared_webcontents`, or search for **shared_sharepointonline** in the list.",
    "",
    "| Connector | Use |",
    "| --- | --- |",
    "| `shared_office365` | Send mail |",
    "| shared_teams | Post a message |",
    "",
    "- Add shared_approvals to the flow.",
    "- See [shared_sql docs](https://learn.microsoft.com/connectors/sql/).",
    "- Use /providers/Microsoft.PowerApps/apis/shared_webcontents as the value, or `/providers/Microsoft.PowerApps/apis/shared_office365`.",
    "- Set `connectionName: shared_sharepointonline` and see shared-webcontents.",
  ].join("\n");
  const out = rewriteConnectorText(source);
  assert.ok(!TOKEN.test(out.replace(/\(https:[^)]*\)/g, "")), out);
  assert.match(out, new RegExp(`^Select ${ENTRA.replace(/[()]/g, "\\$&")}, or search for \\*\\*SharePoint\\*\\* in the list\\.`));
  assert.match(out, /\| Office 365 Outlook \| Send mail \|/);
  assert.match(out, /\| Microsoft Teams \| Post a message \|/);
  assert.match(out, /- Add Standard approvals to the flow\./);
  assert.match(out, /\[SQL Server docs\]\(https:\/\/learn\.microsoft\.com\/connectors\/sql\/\)/, "the link target is not touched");
  assert.match(out, /Use HTTP with Microsoft Entra ID \(preauthorized\) as the value, or Office 365 Outlook\./);
  assert.match(out, /Set `connectionName: SharePoint` and see HTTP with Microsoft Entra ID \(preauthorized\)\./);
});

test("fenced code, addresses, literal code spans and ordinary words are left as written", () => {
  const source = [
    "A shared_documents folder, shared_unknown_thing and shared-identity agents stay as they are.",
    "```json",
    '{ "connectorId": "shared_excelonlinebusiness" }',
    "```",
    "The shared_excelonlinebusiness connector shows its name.",
    "Open https://learn.microsoft.com/connectors/shared_webcontents/ or <https://example.test/shared_sql>.",
    "Copy it from `.../connections/shared_microsoftcopilotstudio/{connectionId}/details` in the address bar.",
    '<img src="assets/shared_webcontents-config.png" alt="Pick shared_webcontents">',
  ].join("\n");
  const out = rewriteConnectorText(source);
  assert.match(out, /A shared_documents folder, shared_unknown_thing and shared-identity agents stay as they are\./);
  assert.match(out, /\{ "connectorId": "shared_excelonlinebusiness" \}/, "a payload example is copied exactly");
  assert.match(out, /The Excel Online \(Business\) connector shows its name\./);
  assert.match(out, /https:\/\/learn\.microsoft\.com\/connectors\/shared_webcontents\//);
  assert.match(out, /<https:\/\/example\.test\/shared_sql>/);
  assert.match(out, new RegExp(`\`\\.\\.\\./connections/shared_microsoftcopilotstudio/\\{connectionId\\}/details\`${LITERAL_NOTE_LEAD.replace(/[()]/g, "\\$&")}Microsoft Copilot Studio\\)`), "a literal keeps its text and the sentence names the connector");
  assert.match(out, /src="assets\/shared_webcontents-config\.png"/, "an attribute value is not touched");
  assert.match(out, /alt="Pick HTTP with Microsoft Entra ID \(preauthorized\)"/, "but visible text is");
});

test("rewriting is idempotent, keeps line endings, and only touches text that has an id", () => {
  const source = "Use `shared_webcontents` and `.../shared_teams/{id}/x`.\r\nSecond **shared_sql** line.\r\n";
  const once = rewriteConnectorText(source);
  assert.equal(rewriteConnectorText(once), once);
  assert.ok(once.includes("\r\n") && !/[^\r]\n/.test(once), "CRLF stays");
  const plain = "No connector id here: shared drives and shared_ alone.";
  assert.equal(rewriteConnectorText(plain), plain);
  assert.equal(repairConnectorNames(undefined), undefined);
  assert.equal(repairConnectorNames(42), 42);
});

test("an id that cannot be resolved becomes a neutral 'a connector (<id>)' once, and never a guess", () => {
  const source = "Use `shared_contoso_crm` and shared_fabrikam_hr, plus shared_teams.";
  assert.equal(rewriteConnectorText(source), "Use `shared_contoso_crm` and shared_fabrikam_hr, plus Microsoft Teams.", "without 'neutral' an unknown id is left alone");
  const neutral = rewriteConnectorText(source, { neutral: true });
  assert.equal(neutral, "Use a connector (shared_contoso_crm) and a connector (shared_fabrikam_hr), plus Microsoft Teams.");
  assert.equal(rewriteConnectorText(neutral, { neutral: true }), neutral, "idempotent");
  assert.equal(rewriteConnectorText("Plan for shared-identity agents.", { neutral: true }), "Plan for shared-identity agents.", "a hyphenated phrase is never taken for a connector");
  assert.deepEqual(findConnectorIds("Plan for shared-identity agents."), []);
  const resolved = rewriteConnectorText(source, { neutral: true, resolved: new Map([["shared_contoso_crm", { displayName: "Contoso CRM" }]]) });
  assert.equal(resolved, "Use Contoso CRM and a connector (shared_fabrikam_hr), plus Microsoft Teams.");
});

test("rewriting a whole value changes text but not addresses, file names, ids or the person's own selections", () => {
  const value = {
    title: "Add shared_webcontents",
    steps: ["Pick `shared_teams`.", { text: "Then shared_sql." }],
    url: "https://learn.microsoft.com/connectors/shared_webcontents/",
    filename: "shared_webcontents-tool.png",
    apiName: "shared_webcontents",
    request: { title: "Mine: shared_webcontents" },
    count: 3,
  };
  const out = rewriteConnectorValue(value);
  assert.equal(out.title, `Add ${ENTRA}`);
  assert.deepEqual(out.steps, ["Pick Microsoft Teams.", { text: "Then SQL Server." }]);
  assert.equal(out.url, value.url);
  assert.equal(out.filename, value.filename);
  assert.equal(out.apiName, "shared_webcontents");
  assert.deepEqual(out.request, value.request);
  assert.equal(out.count, 3);
  assert.equal(value.title, "Add shared_webcontents", "the input is never changed");
});

test("the finder reports what a person would read, and the unknown ids that need a lookup", () => {
  const text = "Select shared_webcontents. Then a connector (shared_contoso_crm) and shared_fabrikam_hr.\n```\nshared_teams\n```\nSee `.../shared_sql/{id}`.";
  const hits = findConnectorIds(text);
  assert.deepEqual(hits.map((hit) => [hit.apiName, hit.known, hit.neutral]), [
    ["shared_webcontents", true, false],
    ["shared_contoso_crm", false, true],
    ["shared_fabrikam_hr", false, false],
  ]);
  assert.deepEqual(collectUnknownConnectorIds({ a: text, url: "https://x.test/shared_other" }), ["shared_fabrikam_hr"]);
  assert.equal(findConnectorIdsInValue({ apiName: "shared_teams", technicalName: "shared_sql", note: "plain" }).length, 0);
  assert.equal(needsConnectorRepair({ markdown: "A shared_teams step." }), true);
  assert.equal(needsConnectorRepair({ markdown: "A Microsoft Teams step.", manifest: { a: "ok", apiName: "shared_teams" } }), false);
});

// ── Names that are not in the table ─────────────────────────────────────────

const CONNECTOR_PAGE = (title) => `# ${title}\n\nUse the connector.\n\nThis connector is available in the following products and regions:\n\n| Service | Class |\n| --- | --- |\n`;

test("an unknown id is looked up once on its Learn connector page, remembered, and left unresolved when the page is not one", async () => {
  const dir = tmp("connector-cache-");
  const cacheFile = join(dir, "cache.json");
  const asked = [];
  const pages = { "https://learn.microsoft.com/connectors/contoso_crm/": CONNECTOR_PAGE("Contoso CRM (preview)"), "https://learn.microsoft.com/connectors/not_a_connector/": "# Connector reference overview\n\nA list." };
  const fetchPage = async (_session, url) => {
    asked.push(url);
    if (url.includes("down_now")) return { markdown: "", error: "timed out" };
    return { markdown: pages[url] || "Page not found", error: null };
  };
  const session = { ok: true };
  const first = await resolveUnknownConnectors(["shared_contoso_crm", "shared_not_a_connector", "shared_down_now", "shared_teams"], { session, fetchPage, cacheFile });
  assert.equal(first.resolved.get("shared_contoso_crm").displayName, "Contoso CRM (preview)", "a suffix from Learn is kept exactly");
  assert.deepEqual(first.unresolved.sort(), ["shared_down_now", "shared_not_a_connector"]);
  assert.equal(asked.length, 3, "an id in the table is never looked up");

  const again = await resolveUnknownConnectors(["shared_contoso_crm", "shared_not_a_connector", "shared_down_now"], { session, fetchPage, cacheFile });
  assert.equal(again.resolved.get("shared_contoso_crm").displayName, "Contoso CRM (preview)");
  assert.deepEqual(asked.slice(3), ["https://learn.microsoft.com/connectors/down_now/"], "a known answer and a known missing page are not asked again; a failed read is");
  assert.ok(!JSON.stringify(JSON.parse(readFileSync(cacheFile, "utf8"))).includes("down_now"), "a failed read is not remembered");

  const offline = await resolveUnknownConnectors(["shared_other_crm"], { session: { ok: false }, fetchPage, cacheFile });
  assert.deepEqual(offline.unresolved, ["shared_other_crm"]);
  assert.equal(connectorPageTitle("# Title only"), null);
});

// ── A lab built from Learn pages that print the internal name ───────────────

let sessionCounter = 0;
const STEPS = (inline) => [
  "1. Select **Agents** and select the agent you want to add a connector to.",
  "2. Go to the **Tools** page of your agent and select **Add a tool**.",
  "3. Select **Connector**. You see the different services with connectors available.",
  `4. Select the service you want to connect to${inline}, or search for the service by name in the search box.`,
  "5. Select the tool you want to add. The **Add tool** pane opens.",
  "6. If the connection doesn't already exist, select **Create new connection**.",
  "7. Select **Submit** or **Create** as applicable when you're done.",
  "8. Select **Add and configure**. The configuration page for the new tool opens.",
];
const learnPage = (inline) => ["# Use Power Platform connectors as tools", "", "## Add a tool from a prebuilt connector", "", ...STEPS(inline), ""].join("\n");

/** A Learn session whose connector page prints the ids, whose search results mention them, and that serves connector reference pages. */
function learnSession({ inline, connectorPages = {}, counts = { connectorPages: 0 } }) {
  sessionCounter += 1;
  return {
    ok: true,
    endpoint: `https://learn.connector-names-${sessionCounter}.test`,
    async call(name, args) {
      if (name === "microsoft_docs_fetch") {
        const connector = /\/connectors\/([^/]+)\/$/.exec(args?.url || "");
        if (connector) {
          counts.connectorPages += 1;
          return { content: [{ type: "text", text: connectorPages[connector[1]] || "Page not found" }] };
        }
        return { content: [{ type: "text", text: learnPage(inline) }] };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify([
              {
                title: "Use Power Platform connectors as tools",
                url: "https://learn.microsoft.com/microsoft-copilot-studio/advanced-connectors",
                content: "Connector tools such as shared_webcontents and shared_sharepointonline are added from the Tools page. A sufficiently long documentation excerpt to survive the minimum-length filter.",
              },
            ]),
          },
        ],
      };
    },
  };
}

const REQUEST = { industry: "retail", roles: ["customer-service"], features: ["connector-tools"], title: "Contoso Connector Lab" };
const OPTIONS = { useLearnMcp: true, useLlm: false, decisions: { "steps-not-derived": "proceed-catalog" } };

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]));
}

/** The text a person reads in an Office file: every XML part of the package, entity-decoded. */
function officeText(buffer) {
  return readZipEntries(buffer)
    .filter((entry) => entry.name.endsWith(".xml"))
    .map((entry) => entry.read().toString("utf8"))
    .join("\n")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

const INLINE = ", such as `shared_webcontents`, `shared_contoso_crm` or `shared_fabrikam_hr`";

let built = null;
async function builtLab() {
  if (built) return built;
  const root = tmp("connector-lab-");
  process.env.LAB_BUILDER_CONNECTOR_CACHE = join(root, "connector-cache.json");
  const counts = { connectorPages: 0 };
  const session = learnSession({ inline: INLINE, connectorPages: { contoso_crm: CONNECTOR_PAGE("Contoso CRM") }, counts });
  const result = await generateLab(REQUEST, { ...OPTIONS, outputRoot: join(root, "labs"), connect: async () => session });
  built = { root, counts, result };
  return built;
}

test("a lab built from pages that print internal names shows display names in every output", async () => {
  const { result, counts } = await builtLab();
  assert.equal(result.status, "complete", JSON.stringify(result.blockers?.map((b) => b.code)));
  const markdown = readFileSync(join(result.outputDir, "index.md"), "utf8");

  // Before: `4. Select the service you want to connect to, such as `shared_webcontents`, ...` (in the Learn page and the lab).
  assert.match(markdown, new RegExp(`4\\. Select the service you want to connect to, such as ${ENTRA.replace(/[()]/g, "\\$&")}, Contoso CRM or a connector \\(shared_fabrikam_hr\\), or search for the service by name`));
  assert.equal(counts.connectorPages, 2, "the two names that were not in the table were looked up once each (one page exists, one does not)");

  const unresolvedNotes = markdown.match(/\*\*Connector names\.\*\*[^\n]*/)?.[0] || "";
  assert.match(unresolvedNotes, /1 connector that this builder did not know yet was looked up/);
  assert.match(unresolvedNotes, /1 connector could not be resolved.*a connector \(shared_fabrikam_hr\)/);
  assert.ok(result.warnings.some((w) => /could not be resolved from Microsoft Learn/.test(w) && /shared_fabrikam_hr/.test(w)));

  const gate = scanLabMarkdown(markdown, { moduleIds: result.manifest.modules.map((m) => m.id), manifest: result.manifest });
  assert.deepEqual(gate.findings.filter((f) => f.code === "connector-id"), [], "no internal name is shown");
  const polish = gate.findings.find((f) => f.code === "connector-unresolved");
  assert.equal(polish?.severity, "polish");
  assert.match(polish.message, /shared_fabrikam_hr/);

  // The internal name is nowhere a person reads: HTML, manifest (outside the fields that hold identifiers), shot list, Office text and decks.
  assert.deepEqual(findConnectorIds(markdown).filter((hit) => !hit.neutral), []);
  const html = readFileSync(join(result.outputDir, "index.html"), "utf8");
  assert.ok(html.includes("Contoso CRM") && html.includes(ENTRA));
  assert.deepEqual(findConnectorIdsInValue(JSON.parse(readFileSync(join(result.outputDir, "manifest.json"), "utf8"))).filter((hit) => !hit.neutral), []);
  const manifestText = readFileSync(join(result.outputDir, "manifest.json"), "utf8");
  assert.ok(manifestText.includes("Connector tools such as HTTP with Microsoft Entra ID (preauthorized) and SharePoint are added"), "the Learn excerpt keeps its sentence and changes only the names");
  for (const file of ["shots.json", "SHOTLIST.md", join("screenshots", "shots.json"), join("screenshots", "learn-state.json")]) {
    const path = join(result.outputDir, file);
    if (!existsSync(path)) continue;
    assert.deepEqual(findConnectorIds(readFileSync(path, "utf8")).filter((hit) => !hit.neutral), [], file);
  }
  let officeFiles = 0;
  let sawDisplayName = false;
  for (const file of filesUnder(result.outputDir).filter((f) => /\.(docx|pptx)$/i.test(f))) {
    const text = officeText(readFileSync(file));
    officeFiles += 1;
    assert.ok(!/shared_[a-z]/i.test(text.replace(/a connector \(shared_[a-z0-9_]+\)/g, "")), file);
    if (/Step 04/.test(file) && /\.docx$/.test(file)) {
      // After, in the Word text of the connector topic.
      assert.match(text, /Select the service you want to connect to, such as HTTP with Microsoft Entra ID \(preauthorized\), Contoso CRM or a connector \(shared_fabrikam_hr\), or search/);
      sawDisplayName = true;
    }
  }
  assert.ok(officeFiles >= 8, `${officeFiles} Office files were checked (topic documents and training decks)`);
  assert.ok(sawDisplayName);
  const pptx = filesUnder(join(result.outputDir, "topics")).find((f) => /Step 04.*\.pptx$/.test(f));
  assert.ok(officeText(readFileSync(pptx)).includes(ENTRA), "the slides and the speaker notes carry the display name");
});

test("the second build reads the answers the first one saved instead of asking Learn again", async () => {
  const { root, result } = await builtLab();
  const counts = { connectorPages: 0 };
  const session = learnSession({ inline: INLINE, connectorPages: { contoso_crm: CONNECTOR_PAGE("Contoso CRM") }, counts });
  const again = await generateLab(REQUEST, { ...OPTIONS, outputRoot: join(root, "labs-again"), connect: async () => session, write: false });
  assert.equal(again.status, "complete");
  assert.equal(counts.connectorPages, 0, "the found name and the page that is not there were both saved, so Learn is not asked again");
  assert.ok(again.markdown.includes("Contoso CRM"));
  assert.ok(result.outputDir);
});

test("the administrator guide and the checklist lead with the display name and keep the technical name as a secondary detail", async () => {
  const { result } = await builtLab();
  const guide = renderAdministratorSetupGuideMarkdown(buildAdministratorSetupGuide({ manifest: result.manifest, markdown: result.markdown }));
  const checklist = renderPrerequisitesChecklistMarkdown(buildPrerequisitesChecklist({ manifest: result.manifest, markdown: result.markdown }));
  for (const [name, text] of [["guide", guide], ["checklist", checklist]]) {
    assert.match(text, /Allow the prebuilt connectors the workshop uses as tools \(for example HTTP with Microsoft Entra ID \(preauthorized\), MSN Weather, or SQL Server\)/, name);
    assert.match(text, /Technical names: HTTP with Microsoft Entra ID \(preauthorized\) is shared_webcontents; MSN Weather is shared_msnweather; SQL Server is shared_sql\./, name);
    assert.match(text, /Technical name: shared_commondataserviceforapps\./, name);
    assert.ok(text.indexOf("HTTP with Microsoft Entra ID (preauthorized)") < text.indexOf("shared_webcontents"), `${name}: the display name comes first`);
    assert.match(text, /\[HTTP with Microsoft Entra ID \(preauthorized\) connector reference\]\(https:\/\/learn\.microsoft\.com\/connectors\/webcontents\/\)/, `${name}: the source link`);
  }
  assert.ok(!/shared_/.test(result.markdown.replace(/a connector \(shared_[a-z0-9_]+\)/g, "")), "and none of it reaches the learner guide");
});

test("the facilitator guide and the training decks show display names", async () => {
  const { result } = await builtLab();
  const facilitator = renderFacilitatorGuideMarkdown(buildFacilitatorGuideModel(result.outputDir));
  assert.ok(!/shared_[a-z]/.test(facilitator.replace(/a connector \(shared_[a-z0-9_]+\)/g, "")), "the facilitator guide has no internal name");
  assert.ok(facilitator.includes(ENTRA), "and its readiness list names the connector by its display name");
  const { summary } = ensureGeneratedLabTrainingDecks(result.outputDir);
  assert.ok(summary.decks.length >= 3);
  for (const deck of summary.decks) {
    const buffer = readCachedTrainingDeck(result.outputDir, deck.fileName);
    const text = readDeck(buffer).slides.flatMap((slide) => [...slide.lines, ...slide.notes]).join("\n");
    assert.ok(!/shared_[a-z]/.test(text.replace(/a connector \(shared_[a-z0-9_]+\)/g, "")), deck.fileName);
  }
});

// ── A lab saved before connector names existed ──────────────────────────────

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

async function olderLab() {
  const root = tmp("connector-older-");
  const session = learnSession({ inline: "" });
  const result = await generateLab(REQUEST, { ...OPTIONS, outputRoot: join(root, "labs"), connect: async () => session });
  assert.equal(result.status, "complete");
  const labDir = result.outputDir;
  // Age it: the text and the manifest carry internal names, as a lab saved by an earlier build would.
  const indexPath = join(labDir, "index.md");
  const md = readFileSync(indexPath, "utf8");
  const aged = md.replace("Select the service you want to connect to,", "Select the service you want to connect to (`shared_webcontents`),");
  assert.notEqual(aged, md);
  writeFileSync(indexPath, aged);
  const manifestPath = join(labDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const mod = manifest.modules.find((m) => m.id === "connector-tools");
  mod.training.cautions = ["The shared_office365 connection must exist before the tool can run."];
  mod.training.learnTakeaways = [{ title: "Tools", url: "https://learn.microsoft.com/microsoft-copilot-studio/advanced-connectors", summary: "Add shared_sharepointonline from the Tools page." }];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { root: join(root, "labs"), labId: result.labId, labDir, indexPath, manifestPath };
}

test("an older saved lab is shown with display names when it is read, and its files are not rewritten", async () => {
  const lab = await olderLab();
  const indexBefore = sha(lab.indexPath);
  const read = readGeneratedLab(lab.root, lab.labId);
  assert.equal(read.status, 200);
  assert.ok(read.body.markdown.includes(`(${ENTRA}),`) && !/shared_/.test(read.body.markdown));
  assert.ok(read.body.html.includes(ENTRA));
  const module = read.body.manifest.modules.find((m) => m.id === "connector-tools");
  assert.deepEqual(module.training.cautions, ["The Office 365 Outlook connection must exist before the tool can run."]);
  assert.equal(module.training.learnTakeaways[0].summary, "Add SharePoint from the Tools page.");
  assert.equal(read.body.adminPrerequisites.connectors.some((c) => c.connectors?.some((ref) => ref.apiName === "shared_webcontents")), true, "the administrator model keeps the technical name");

  assert.equal(sha(lab.indexPath), indexBefore, "index.md is read, not rewritten");
  assert.match(readFileSync(lab.manifestPath, "utf8"), /shared_office365/, "so is the manifest's text");

  const once = learnerGuideMarkdown(readFileSync(lab.indexPath, "utf8"));
  assert.equal(learnerGuideMarkdown(once), once, "idempotent");
  assert.ok(!/shared_/.test(JSON.stringify(learnerSafeManifest(JSON.parse(readFileSync(lab.manifestPath, "utf8"))).modules)), "the learner copy of the manifest too");
});

test("the topic documents of an older lab are rebuilt once from the repaired text, and a lab without an id is never rebuilt", async () => {
  const lab = await olderLab();
  const topicsDir = join(lab.labDir, "topics");
  const docx = () => filesUnder(topicsDir).find((f) => /Step 04.*\.docx$/.test(f));
  assert.ok(!officeText(readFileSync(docx())).includes("connect to (HTTP with Microsoft Entra ID (preauthorized)),"), "the saved document predates the aging");

  const first = ensureGeneratedLabTopicDocuments(lab.labDir, { labId: lab.labId });
  assert.ok(first.length >= 4);
  assert.match(officeText(readFileSync(docx())), /connect to \(HTTP with Microsoft Entra ID \(preauthorized\)\),/);
  assert.ok(!/shared_[a-z]/.test(officeText(readFileSync(docx()))));
  const saved = JSON.parse(readFileSync(lab.manifestPath, "utf8"));
  assert.equal(saved.topicDocumentsConnectorNames, 1);
  assert.match(JSON.stringify(saved), /shared_office365/, "the saved manifest is not repaired, only given the new document list");

  const stamp = statSync(docx()).mtimeMs;
  ensureGeneratedLabTopicDocuments(lab.labDir, { labId: lab.labId });
  assert.equal(statSync(docx()).mtimeMs, stamp, "the second read finds them current");

  const clean = await generateLab(REQUEST, { ...OPTIONS, outputRoot: tmp("connector-clean-"), connect: async () => learnSession({ inline: "" }) });
  const cleanDocx = filesUnder(join(clean.outputDir, "topics")).find((f) => /Step 04.*\.docx$/.test(f));
  const before = statSync(cleanDocx).mtimeMs;
  ensureGeneratedLabTopicDocuments(clean.outputDir, { labId: clean.labId });
  assert.equal(statSync(cleanDocx).mtimeMs, before, "a lab with no internal name is left alone");
});

test("exporting an older lab gives the learner display names in every file, and the administrator folder keeps its technical names", async () => {
  const lab = await olderLab();
  const chunks = [];
  const sink = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } });
  await exportGeneratedLab(lab.root, lab.labId, {}, sink, {});
  const entries = readZipEntries(Buffer.concat(chunks));
  assert.ok(entries.length > 20, `${entries.length} files in the export`);
  let learnerFiles = 0;
  let sawDisplayName = false;
  for (const entry of entries) {
    if (/(^|\/)For the administrator\//.test(entry.name) || /Prerequisites checklist|Administrator setup guide/i.test(entry.name)) continue;
    if (/\.(png|jpe?g|webp|gif)$/i.test(entry.name)) continue;
    const data = entry.read();
    const text = /\.(docx|pptx)$/i.test(entry.name) ? officeText(data) : data.toString("utf8");
    learnerFiles += 1;
    assert.ok(!/shared_[a-z]/i.test(text), entry.name);
    if (/index\.md$/.test(entry.name) && text.includes(`connect to (${ENTRA}),`)) sawDisplayName = true;
  }
  assert.ok(learnerFiles > 10);
  assert.ok(sawDisplayName, "the lab guide in the export shows the display name");
  assert.match(readFileSync(lab.indexPath, "utf8"), /shared_webcontents/, "and the saved lab is not rewritten");
});

test("the training decks of an older lab are built from the display name", async () => {
  const lab = await olderLab();
  const { summary } = ensureGeneratedLabTrainingDecks(lab.labDir);
  const lines = [];
  for (const deck of summary.decks) {
    const text = readDeck(readCachedTrainingDeck(lab.labDir, deck.fileName)).slides.flatMap((slide) => [...slide.lines, ...slide.notes]).join("\n");
    assert.ok(!/shared_[a-z]/.test(text), deck.fileName);
    lines.push(text);
  }
  assert.ok(lines.join("\n").includes("Office 365 Outlook"), "the caution Learn printed is in the decks, with the display name");
});

// ── The sample labs the other tests build ───────────────────────────────────

test("the data files that feed labs carry no internal connector name", () => {
  const libDir = new URL("../lib/", import.meta.url);
  const jsonFiles = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const next = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
      if (entry.isDirectory()) return jsonFiles(next);
      return entry.name.endsWith(".json") && entry.name !== "connectors.json" ? [next] : [];
    });
  const files = [...jsonFiles(new URL("lab-builder/", libDir)), ...jsonFiles(new URL("use-cases/", libDir))];
  assert.ok(files.length > 15, `${files.length} data files`);
  for (const file of files) {
    assert.deepEqual(findConnectorIdsInValue(JSON.parse(readFileSync(file, "utf8"))), [], file.pathname);
  }
});

test("no internal connector name appears in the rendered output of the sample labs", async () => {
  const { labs, cleanup } = await buildSampleLabs(["level200", "level300", "copilotHarness", "agentBuilder"]);
  cleanups.push(cleanup);
  let checked = 0;
  for (const { outputDir } of Object.values(labs)) {
    for (const file of filesUnder(outputDir)) {
      if (/\.(png|jpe?g|webp|gif)$/i.test(file)) continue;
      checked += 1;
      if (/\.(docx|pptx)$/i.test(file)) {
        assert.ok(!/shared_[a-z]/i.test(officeText(readFileSync(file))), file);
      } else if (/manifest\.json$/.test(file)) {
        // The administrator model carries technical names on purpose, in the fields that hold identifiers.
        assert.deepEqual(findConnectorIdsInValue(JSON.parse(readFileSync(file, "utf8"))), [], file);
      } else {
        assert.ok(!/shared_[a-z]/i.test(readFileSync(file, "utf8")), file);
      }
    }
  }
  assert.ok(checked > 40, `${checked} files were scanned`);
});
