/**
 * Add another Microsoft product from Microsoft Learn: the search results, in the real page.
 *
 * A search used to list a raw path dropdown per hit, and a dropdown whose options were all covered by an existing product
 * showed nothing at all. This test starts the portal against a fake Microsoft Learn MCP server (the owner's "sharepoint"
 * search, plus a few others), searches in headless Chromium, in both themes at 1440, 768, and 360 wide, and checks that every
 * result group shows readable choices: a visible name for every option, exactly one preselected Recommended option per group
 * that has a choice, nothing to choose (and no button) when everything is covered, no dropdown, text that is not cut off,
 * nothing outside the panel, readable contrast, a visible focus mark, arrow keys that change the choice, and that Add posts
 * the chosen address.
 *
 * Throwaway storage folders; the language model and the real Microsoft Learn are off. It skips itself when Playwright or a
 * Chromium build is not installed (tools/screenshot-capture: npm install).
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = resolve(here, "..");
const PLAYWRIGHT = resolve(PORTAL_ROOT, "..", "tools", "screenshot-capture", "node_modules", "playwright", "index.mjs");
const WIDTHS = [1440, 768, 360];
const LEARN = "https://learn.microsoft.com";
const cleanups = [];
const ctx = {};

const HITS = [
  ["What is sharepoint - Microsoft Q&A", `${LEARN}/answers/a/12804744`],
  ["SharePoint as a data source - HIS", `${LEARN}/host-integration-server/core/sharepoint1#overview`],
  ["Intro to file collaboration in Microsoft 365, powered by SharePoint", `${LEARN}/sharepoint/intro-to-file-collaboration#key-features`],
  ["SharePoint Add-ins", `${LEARN}/sharepoint/dev/sp-add-ins/sharepoint-add-ins`],
  ["Step 2: Review Microsoft 365 communication tools", `${LEARN}/sharepoint/review-communication-apps#sharepoint-engage,-learn,-and-collaborate`],
  ["Learn the basics of Dynamics 365 Sales", `${LEARN}/dynamics365/sales/user-guide-learn-basics`],
  ["Overview of Dynamics 365 Sales Professional - Training", `${LEARN}/training/modules/overview-d365-sales-professional/`],
  ["Azure AI Document Intelligence layout model", `${LEARN}/azure/ai-services/document-intelligence/prebuilt/layout`],
  ["Use the Graph connector for Power Platform", `${LEARN}/power-platform/admin/graph-connectors`],
].map(([title, contentUrl]) => ({ title, contentUrl, content: "An excerpt that is long enough to count as a page of text for the search." }));

function freePort() {
  return new Promise((resolvePort) => {
    const server = createNetServer();
    server.once("error", () => resolvePort(0));
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

/** A Learn MCP server that answers the search with HITS and every page read with a short document. */
async function startFakeLearn() {
  const server = createHttpServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const rpc = JSON.parse(raw || "{}");
      const reply = (result) => {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fake" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
      };
      if (rpc.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: {} });
      if (rpc.params?.name === "microsoft_docs_search") return reply({ content: [{ type: "text", text: JSON.stringify(HITS) }] });
      return reply({ content: [{ type: "text", text: "# Documentation\n\nLearn about the product and how to use it every day.\n" }] });
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  cleanups.push(() => server.close());
  return `http://127.0.0.1:${server.address().port}/`;
}

before(async () => {
  const root = mkdtempSync(join(tmpdir(), "lb-addprod-scopes-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  ctx.port = await freePort();
  ctx.base = `http://127.0.0.1:${ctx.port}`;
  const learnUrl = await startFakeLearn();
  let stderr = "";
  const child = spawn(process.execPath, ["server.js"], {
    cwd: PORTAL_ROOT,
    env: {
      ...process.env,
      PORT: String(ctx.port),
      HOST: "127.0.0.1",
      PORTAL_AUTH_DISABLED: "true",
      AZURE_KEYVAULT_URL: "",
      AZURE_STORAGE_BLOB_ENDPOINT: "",
      PORTAL_DATA_DIR: join(root, "data"),
      LAB_BUILDER_OUTPUT_DIR: join(root, "generated"),
      FEATURE_TOUR_SCREENSHOTS_DIR: join(root, "shots"),
      LAB_BUILDER_LINK_CHECK: "off",
      LAB_BUILDER_LLM: "off",
      LAB_BUILDER_VENDOR_DOCS: "off",
      CAPTURE_STARTUP_SCAN: "off",
      LEARN_MCP_URL: learnUrl,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  cleanups.push(() => child.kill());
  const deadline = Date.now() + 40000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${stderr.slice(-800)}`);
    try {
      if ((await fetch(`${ctx.base}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server did not start: ${stderr.slice(-800)}`);
    await new Promise((r) => setTimeout(r, 150));
  }

  if (!existsSync(PLAYWRIGHT)) {
    ctx.skipReason = "Playwright is not installed (tools/screenshot-capture: npm install).";
    return;
  }
  try {
    const { chromium } = await import(pathToFileURL(PLAYWRIGHT).href);
    ctx.browser = await chromium.launch({ headless: true });
    cleanups.push(() => ctx.browser?.close());
  } catch (err) {
    ctx.skipReason = `No headless Chromium is available: ${err.message.split("\n")[0]}`;
  }
});

after(() => {
  for (const clean of cleanups.reverse()) {
    try {
      clean();
    } catch {
      /* best effort */
    }
  }
});

/** Runs in the page: everything the checks need to know about the result list. */
function inspectResults() {
  const panel = document.getElementById("lb-addprod");
  const panelBox = panel.getBoundingClientRect();
  const results = document.getElementById("lb-addprod-results");
  const luminance = ([r, g, b]) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const rgba = (value) => (value.match(/[\d.]+/g) || []).map(Number);
  const backgroundOf = (el) => {
    for (let node = el; node; node = node.parentElement) {
      const [r, g, b, a = 1] = rgba(getComputedStyle(node).backgroundColor);
      if (a > 0.99) return [r, g, b];
    }
    return [255, 255, 255];
  };
  const contrast = (el) => {
    const fg = rgba(getComputedStyle(el).color).slice(0, 3);
    const [a, b] = [luminance(fg), luminance(backgroundOf(el))].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  };
  const inside = (el) => {
    const box = el.getBoundingClientRect();
    return box.left >= panelBox.left - 0.5 && box.right <= panelBox.right + 0.5;
  };
  const cutOff = (el) => el.scrollWidth > el.clientWidth + 1;

  const groups = [...results.querySelectorAll(".lb-scope-group")].map((group) => {
    const radios = [...group.querySelectorAll('input[type="radio"]')].map((input) => {
      const name = document.getElementById(input.getAttribute("aria-labelledby"));
      const row = input.closest(".lb-scope-option");
      return {
        value: input.value,
        checked: input.checked,
        disabled: input.disabled,
        name: name.innerText.trim(),
        nameWidth: name.getBoundingClientRect().width,
        recommended: Boolean(name.querySelector(".lb-scope-badge")),
        note: row.querySelector(".lb-scope-note").innerText.trim(),
        path: row.querySelector(".lb-scope-path").innerText.trim(),
        describedBy: input.getAttribute("aria-describedby"),
        problems: [
          ...[...row.querySelectorAll(".lb-scope-label, .lb-scope-note, .lb-scope-path")].filter(cutOff).map((el) => `${el.className} is cut off`),
          ...(inside(row) ? [] : ["the row sticks out of the panel"]),
        ],
        contrasts: [...row.querySelectorAll(".lb-scope-label, .lb-scope-note, .lb-scope-path, .lb-scope-badge")].map((el) => [el.className, contrast(el)]),
      };
    });
    return {
      legend: group.querySelector("legend")?.innerText.trim() ?? null,
      hasFieldset: Boolean(group.querySelector("fieldset")),
      text: group.innerText.replace(/\s+/g, " ").trim(),
      radios,
      buttons: [...group.querySelectorAll("button")].map((button) => ({ text: button.innerText.trim(), inside: inside(button), height: button.getBoundingClientRect().height })),
      links: [...group.querySelectorAll("a")].map((a) => ({ text: a.textContent.trim(), target: a.target, inside: inside(a), cutOff: cutOff(a), contrast: contrast(a) })),
      inside: inside(group),
    };
  });
  return {
    theme: document.documentElement.getAttribute("data-theme"),
    groups,
    selects: results.querySelectorAll("select, option").length,
    hidden: results.querySelector(".lb-scope-hidden")?.innerText.trim() ?? null,
    hiddenContrast: results.querySelector(".lb-scope-hidden") ? contrast(results.querySelector(".lb-scope-hidden")) : null,
    status: document.getElementById("lb-addprod-status").innerText.trim(),
    panelOverflow: panel.scrollWidth - panel.clientWidth,
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
}

async function openAndSearch(viewport, theme) {
  const context = await ctx.browser.newContext({ viewport });
  await context.addInitScript((value) => {
    try {
      localStorage.setItem("portal-theme", value);
    } catch {
      /* storage unavailable */
    }
  }, theme);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(`${ctx.base}/#labbuilder`);
  await page.waitForSelector("#lb-product-options input");
  await page.waitForFunction(() => document.querySelectorAll("#lb-steps li:not([hidden])").length === 4);
  await page.click("#lb-addprod > summary");
  await page.fill("#lb-addprod-input", "sharepoint");
  await page.click("#lb-addprod-go");
  await page.waitForSelector("#lb-addprod-results .lb-scope-group");
  return { context, page, errors };
}

for (const theme of ["light", "dark"]) {
  test(`every search result group has named choices, one recommended and preselected, and fits from 1440 to 360 wide (${theme})`, async (t) => {
    if (ctx.skipReason) return t.skip(ctx.skipReason);
    const { context, page, errors } = await openAndSearch({ width: WIDTHS[0], height: 900 }, theme);
    try {
      for (const width of WIDTHS) {
        const where = `${theme}, ${width}px`;
        await page.setViewportSize({ width, height: 900 });
        const view = await page.evaluate(inspectResults);
        assert.equal(view.theme, theme, `${where}: the ${theme} theme is applied`);
        assert.equal(view.selects, 0, `${where}: no dropdown in the results`);
        assert.ok(view.groups.length >= 4, `${where}: ${view.groups.length} groups`);

        const names = view.groups.map((group) => group.text.split(" 1 matching")[0].split(" Already")[0].split(" 5 matching")[0]);
        assert.deepEqual(names.slice(0, 4), ["Host Integration Server", "Dynamics 365 Sales", "Azure Document Intelligence", "Power Platform > Admin"], `${where}: groups with a choice come first, named for the hub`);
        assert.equal(view.groups.at(-1).radios.length, 0, `${where}: the covered group has nothing to choose`);
        assert.match(view.groups.at(-1).text, /Already covered by SharePoint AI features, so there is nothing to add\./);
        assert.equal(view.groups.at(-1).buttons.length, 0, `${where}: and no button`);
        assert.match(view.hidden, /^Hidden: 2 results that are not product documentation \(Microsoft Q&A threads, training modules and learning paths\)\.$/);
        assert.match(view.status, /^4 documentation areas found\./);

        for (const group of view.groups) {
          assert.ok(group.inside, `${where}: ${group.text.slice(0, 30)} sticks out of the panel`);
          if (!group.radios.length) continue;
          const label = `${where}: ${group.legend}`;
          assert.ok(group.hasFieldset && group.legend, `${label}: the choices sit in a fieldset with a legend`);
          assert.deepEqual(group.buttons.map((button) => button.text), ["Add as a product"], `${label}: one button`);
          assert.ok(group.buttons.every((button) => button.inside && button.height >= 28), `${label}: the button is inside the panel and big enough`);
          const checked = group.radios.filter((radio) => radio.checked);
          assert.equal(checked.length, 1, `${label}: exactly one option is selected`);
          assert.ok(checked[0].recommended && !checked[0].disabled, `${label}: the selected option is the recommended one`);
          assert.equal(group.radios.filter((radio) => radio.recommended).length, 1, `${label}: exactly one recommended option`);
          for (const radio of group.radios) {
            assert.ok(radio.name.length > 0 && radio.nameWidth > 0, `${label}: an option has no visible name`);
            assert.ok(!radio.name.startsWith("/"), `${label}: ${radio.name} is a raw path, not a name`);
            assert.ok(radio.note.length > 0 && radio.path.startsWith("/"), `${label}: ${radio.name} says what it means and where it is`);
            assert.ok(radio.describedBy.includes("-note") && radio.describedBy.includes("-path"), `${label}: the explanation is attached to the option`);
            assert.deepEqual(radio.problems, [], `${label}: ${radio.name}`);
            if (radio.disabled) assert.match(radio.note, /^Already covered by /, `${label}: a disabled option says why`);
            for (const [part, ratio] of radio.contrasts) assert.ok(ratio >= 4.5, `${label}: ${radio.name} ${part} has contrast ${ratio.toFixed(2)}`);
          }
          for (const link of group.links) {
            assert.equal(link.target, "_blank");
            assert.ok(link.inside && !link.cutOff && link.contrast >= 4.5, `${label}: the link "${link.text}" fits and is readable (${link.contrast.toFixed(2)})`);
          }
        }
        const azure = view.groups.find((group) => group.legend === "Azure Document Intelligence");
        assert.deepEqual(azure.radios.map((radio) => [radio.name.replace(" Recommended", ""), radio.disabled]), [
          ["Azure", true],
          ["Azure > AI Services", false],
          ["Azure Document Intelligence", false],
          ["Azure Document Intelligence > Prebuilt", false],
        ], `${where}: a covered scope stays in its place, disabled, and the reviewed hub is the recommendation`);
        assert.equal(azure.radios[0].note, "Already covered by Microsoft Foundry.");
        assert.ok(view.hiddenContrast >= 4.5, `${where}: the hidden line is readable (${view.hiddenContrast})`);
        assert.ok(view.panelOverflow <= 0, `${where}: the panel scrolls sideways (${view.panelOverflow})`);
        assert.ok(view.pageOverflow <= 0, `${where}: the page is ${view.pageOverflow}px wider than the window`);
      }
      assert.deepEqual(errors, [], "no script errors on the page");
    } finally {
      await context.close();
    }
  });
}

test("the arrow keys move the choice, the focus mark shows, and Add as a product posts the chosen address", async (t) => {
  if (ctx.skipReason) return t.skip(ctx.skipReason);
  const { context, page, errors } = await openAndSearch({ width: 1024, height: 900 }, "light");
  try {
    const posts = [];
    await page.route("**/api/lab-builder/products/mine", async (route) => {
      posts.push(JSON.parse(route.request().postData() || "{}"));
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "That documentation is already covered by a test." }) });
    });
    const radio = (group, index) => page.locator(`#lb-addprod-scope-${group}-${index}`);

    // Tab to the selected radio of the first group, so the browser draws the focus mark as it does for a person on the keyboard.
    await page.keyboard.press("Tab");
    await radio(0, 0).focus();
    const mark = await page.evaluate(() => {
      const row = document.getElementById("lb-addprod-scope-0-0").closest(".lb-scope-option");
      const style = getComputedStyle(row);
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    assert.ok(mark.style !== "none" && mark.width >= 2, `the focused option is outlined (${mark.style} ${mark.width}px)`);

    await page.keyboard.press("ArrowDown");
    assert.equal(await radio(0, 1).isChecked(), true, "the arrow key chose the next option");
    assert.equal(await radio(0, 0).isChecked(), false);
    await page.click('[data-addprod-root="0"]');
    await page.waitForFunction(() => /already covered by a test/.test(document.getElementById("lb-addprod-status").innerText));
    assert.deepEqual(posts, [{ root: `${LEARN}/host-integration-server/core` }], "the chosen address is posted, with no name");

    // The choice survives the list being drawn again, and another group still posts its own recommended address.
    assert.equal(await radio(0, 1).isChecked(), true);
    await page.click('[data-addprod-root="1"]');
    for (let waited = 0; waited < 5000 && posts.length < 2; waited += 20) await page.waitForTimeout(20);
    assert.deepEqual(posts.at(-1), { root: `${LEARN}/dynamics365/sales` }, "an untouched group posts its recommended address");
    assert.deepEqual(errors, [], "no script errors on the page");
  } finally {
    await context.close();
  }
});
