/**
 * The harness labels in a real browser (headless Chromium, no server, no network): a very long label wraps inside a narrow card and is never cut
 * off, the one-click buttons and the group for pictures with no harness recorded stay inside a phone-width screen, and the label's text keeps its
 * contrast in both themes. The real Screenshot Center scripts draw the cards, with the real stylesheet of the portal page.
 *
 * The test skips itself when Playwright or a Chromium build is not installed (tools/screenshot-capture: npm install).
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = resolve(here, "..");
const PLAYWRIGHT = resolve(PORTAL_ROOT, "..", "tools", "screenshot-capture", "node_modules", "playwright", "index.mjs");
const publicFile = (name) => readFileSync(resolve(PORTAL_ROOT, "public", name), "utf8");
const STYLE = publicFile("index.html").match(/<style>([\s\S]*?)<\/style>/)[1];
const SCRIPTS = ["screenshot-center-core.js", "screenshot-center-command.js", "screenshot-center-jobs.js", "screenshot-center-keep.js", "screenshot-center-wrong.js", "screenshot-center-pictures.js", "screenshot-center.js"].map(publicFile);

const LAB = "lab-test-1";
const ctx = {};

// Made-up harness labels as long as the page shows one (it keeps the first 80 characters): one of many words, and one single word that is wider than the card.
const LONG = "Customer Conversation harness (preview) for the Contoso Fabrikam Northwind training team";
const LONG_WORD = "Supercalifragilisticexpialidocious".repeat(3);
const NOT_RECORDED_NOTE = `This picture has no harness recorded, so it is not used for a ${LONG} slot until you say which harness it shows.`;

function shot(filename, extra = {}) {
  return {
    id: 1,
    shotId: filename,
    moduleOrder: 1,
    stepLabel: "Step 1",
    featureId: "mod-a",
    moduleTitle: "Create an agent",
    product: "copilot-studio",
    figure: "1.1",
    kind: "ui-location",
    filename,
    alt: "The Copilot Studio agents page",
    caption: "Agents page",
    instructions: [],
    manual: false,
    captured: false,
    stale: false,
    needsReview: false,
    checkState: "up-to-date",
    harness: "customer-conversation",
    harnessLabel: LONG,
    harnessGap: null,
    harnessGapNote: null,
    pictureHarness: null,
    pictureHarnessLabel: null,
    harnessState: "pending",
    harnessMessage: null,
    ...extra,
  };
}

function labState() {
  const shots = [
    shot("long.png"),
    shot("word.png", { id: 3, figure: "1.3", caption: "Name the agent", harnessLabel: LONG_WORD }),
    shot("untagged.png", { id: 2, figure: "1.2", caption: "Create an agent", captured: true, capturedAt: "2026-06-01T11:00:00.000Z", imageSource: "lab", imageCapturedAt: "2026-05-20T12:00:00.000Z", confirmed: null, share: { state: "not-shared", libraryConfirmed: false }, pictureHarnessLabel: "Harness not recorded", harnessState: "not-recorded", harnessMessage: NOT_RECORDED_NOTE }),
  ];
  return {
    labId: LAB,
    title: "Test lab",
    harness: "customer-conversation",
    harnessLabel: LONG,
    harnessInfo: { id: "customer-conversation", label: LONG, source: "chosen", statement: `This lab: ${LONG}. Every picture is taken in the Customer Conversation harness.` },
    harnessSummary: { labHarness: "customer-conversation", statement: "", notRecorded: 1, wrong: 0, gaps: 0, notRecordedFiles: ["untagged.png"], wrongFiles: [], gapFiles: [], harnessesSeen: [], mixed: true, mixedMessage: `This lab is built for the ${LONG}, but it has pictures from both the Standard (Classic) harness and the Microsoft Copilot harness.` },
    summary: { total: 3, captured: 1, missing: 2, stale: 0, needsReview: 0, checkState: "up-to-date" },
    checkState: "up-to-date",
    modules: [{ featureId: "mod-a", moduleOrder: 1, stepLabel: "Step 1", moduleTitle: "Create an agent", checkState: "up-to-date", status: "up-to-date", primaryUrl: "", diff: null }],
    shots,
  };
}

before(async (t) => {
  if (!existsSync(PLAYWRIGHT)) return t.skip("Playwright is not installed (tools/screenshot-capture: npm install).");
  const { chromium } = await import(pathToFileURL(PLAYWRIGHT).href);
  try {
    ctx.browser = await chromium.launch({ headless: true });
  } catch (err) {
    return t.skip(`No headless Chromium is available: ${err.message.split("\n")[0]}`);
  }
});

after(async () => {
  await ctx.browser?.close();
});

/** A phone-width page with the portal's stylesheet and the real Screenshot Center scripts, showing the lab above. */
async function openLab(theme) {
  const context = await ctx.browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${STYLE}</style></head><body><main style="padding:12px"><section id="lb-result-screenshots"></section><div class="lab-shot-card" style="margin-top:12px"><span class="lab-shot-card-label">Screenshot to add</span><span class="lab-shot-card-harness"><strong>Harness:</strong> ${LONG} ${LONG_WORD}</span></div></main></body></html>`);
  for (const content of SCRIPTS) await page.addScriptTag({ content });
  await page.evaluate(
    ({ labId, state }) => {
      scRenderCenter(document.getElementById("lb-result-screenshots"), labId, state, null);
    },
    { labId: LAB, state: labState() },
  );
  await page.locator('.sc-card[data-filename="long.png"] .sc-harness-label').waitFor();
  return { context, page };
}

const luminance = (rgb) => {
  const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map((v) => Number(v) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

for (const theme of ["light", "dark"]) {
  test(`${theme} theme: a wrong-harness picture's message, its disabled Accept, and the reason beside it are readable and stay inside a 390 px screen`, async (t) => {
    if (!ctx.browser) return t.skip("no browser");
    const WRONG = "This picture was taken in the Microsoft Copilot harness (Build, Preview, Evaluate, Monitor); this lab needs the Standard (Classic) harness.";
    const state = labState();
    state.harness = "standard";
    state.harnessLabel = "Standard (Classic) harness";
    state.harnessInfo = { id: "standard", label: "Standard (Classic) harness", source: "chosen", statement: "This lab: Standard (Classic) harness. Every picture is taken in the Classic harness." };
    state.harnessSummary = { labHarness: "standard", statement: state.harnessInfo.statement, notRecorded: 0, wrong: 0, gaps: 0, notRecordedFiles: [], wrongFiles: [], gapFiles: [], harnessesSeen: [], mixed: false, mixedMessage: "" };
    state.summary = { total: 1, captured: 0, missing: 1, stale: 0, needsReview: 1, checkState: "up-to-date" };
    state.shots = [
      shot("wrong.png", {
        harness: "standard",
        harnessLabel: "Standard (Classic) harness",
        needsReview: true,
        harnessReview: { code: "wrong-harness", found: "microsoft-copilot", foundLabel: "Microsoft Copilot harness", source: "address", needed: "standard", neededLabel: "Standard (Classic) harness", message: WRONG, canAccept: false, addressAgrees: false },
        verification: { level: "warn", state: "needs-review", stagedAt: "2026-06-01T10:00:00.000Z", reasons: [{ code: "wrong-harness", level: "warn", message: WRONG, derived: true }] },
      }),
    ];
    const context = await ctx.browser.newContext({ viewport: { width: 390, height: 900 } });
    try {
      const page = await context.newPage();
      await page.setContent(`<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${STYLE}</style></head><body><main style="padding:12px"><section id="lb-result-screenshots"></section></main></body></html>`);
      for (const content of SCRIPTS) await page.addScriptTag({ content });
      await page.evaluate(({ labId, state: lab }) => scRenderCenter(document.getElementById("lb-result-screenshots"), labId, lab, null), { labId: LAB, state });
      await page.locator('.sc-card[data-filename="wrong.png"] [data-sc-accept-why]').waitFor();

      const card = await page.evaluate(() => {
        const root = document.querySelector('.sc-card[data-filename="wrong.png"]');
        const accept = root.querySelector('[data-sc-action="shot-accept"]');
        const why = root.querySelector("[data-sc-accept-why]");
        const box = why.getBoundingClientRect();
        return { disabled: accept.disabled, describedBy: accept.getAttribute("aria-describedby"), whyId: why.id, whyText: why.textContent, whyHeight: box.height, whyRight: box.right, viewport: window.innerWidth, keep: Boolean(root.querySelector('[data-sc-action="shot-keep-wrong-harness"]')), scrollW: root.scrollWidth, clientW: root.clientWidth };
      });
      assert.equal(card.disabled, true, "Accept is off");
      assert.equal(card.describedBy, card.whyId, "the visible reason is tied to the button");
      assert.ok(card.whyHeight > 0 && card.whyRight <= card.viewport + 0.5, "the reason is drawn, on screen");
      assert.ok(card.scrollW <= card.clientW + 1, "nothing is hidden to the side");
      assert.ok(card.keep, "Keep in kept pictures is offered");
      assert.match(card.whyText, /^Accept is off: this picture shows the Microsoft Copilot harness, and this screenshot needs the Standard \(Classic\) harness\./);

      await page.locator('.sc-card[data-filename="wrong.png"] [data-sc-action="preview"]').first().click();
      await page.locator(".sc-review-wrong-harness").waitFor();
      const alert = await page.locator(".sc-review-wrong-harness").evaluate((el) => {
        const style = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        return { role: el.getAttribute("role"), text: el.textContent, color: style.color, background: style.backgroundColor, right: box.right, height: box.height, viewport: window.innerWidth, borderLeft: Number.parseFloat(style.borderLeftWidth), first: el.parentElement.firstElementChild === el };
      });
      assert.equal(alert.role, "alert");
      assert.equal(alert.text, WRONG);
      assert.ok(alert.first, "it comes first in the review");
      assert.ok(alert.height > 0 && alert.right <= alert.viewport + 0.5, "it is drawn, inside the screen");
      assert.ok(alert.borderLeft >= 4, "a visible edge, in addition to its words");
      assert.ok(contrast(alert.color, alert.background) >= 4.5, `${theme}: the message is ${contrast(alert.color, alert.background).toFixed(2)}:1`);
    } finally {
      await context.close();
    }
  });
}

for (const theme of ["light", "dark"]) {
  test(`${theme} theme: a very long harness label wraps inside a 390 px card and is never clipped, and everything harness-related stays on screen`, async (t) => {
    if (!ctx.browser) return t.skip("no browser");
    const { context, page } = await openLab(theme);
    try {
      const measure = (filename) =>
        page.evaluate((name) => {
          const rect = (el) => el.getBoundingClientRect();
          const card = document.querySelector(`.sc-card[data-filename="${name}"]`);
          const label = card.querySelector(".sc-harness-label");
          const style = getComputedStyle(label);
          return {
            text: label.textContent,
            cardScrollW: card.scrollWidth,
            cardClientW: card.clientWidth,
            cardRight: rect(card).right,
            labelRight: rect(label).right,
            labelHeight: rect(label).height,
            lineHeight: Number.parseFloat(style.lineHeight),
            labelScrollW: label.scrollWidth,
            labelClientW: label.clientWidth,
            textOverflow: style.textOverflow,
            whiteSpace: style.whiteSpace,
            overflowX: style.overflowX,
            display: style.display,
            borderWidth: Number.parseFloat(style.borderTopWidth),
            borderStyle: style.borderTopStyle,
            color: style.color,
            background: style.backgroundColor,
          };
        }, filename);

      for (const [filename, minimumLines] of [["long.png", 2], ["word.png", 2]]) {
        const m = await measure(filename);
        // The label is a block of wrapped text, not one clipped line, and a single word wider than the card breaks inside the word.
        assert.ok(m.text.length >= 80 || filename === "long.png", `${filename}: the label is as long as the page shows one`);
        assert.ok(m.labelHeight >= m.lineHeight * minimumLines, `${filename}: the label wraps onto ${minimumLines} or more lines (${m.labelHeight}px high, one line is ${m.lineHeight}px)`);
        assert.ok(m.cardScrollW <= m.cardClientW + 1, `${filename}: the card has nothing hidden to the side (${m.cardScrollW} vs ${m.cardClientW})`);
        assert.ok(m.labelRight <= m.cardRight + 0.5, `${filename}: the label ends inside the card`);
        assert.ok(m.labelScrollW <= m.labelClientW + 1, `${filename}: no text of the label sticks out of its own box`);
        assert.notEqual(m.textOverflow, "ellipsis");
        assert.equal(m.whiteSpace, "normal");
        assert.equal(m.overflowX, "visible");
        assert.ok(["block", "inline-block"].includes(m.display), "a box of its own (a flex item is blockified)");
        assert.ok(m.borderWidth >= 2 && m.borderStyle !== "none", "a visible border");
        // The label's text is readable, and its colors come from the theme.
        assert.ok(contrast(m.color, m.background) >= 4.5, `${theme}: label text is ${contrast(m.color, m.background).toFixed(2)}:1`);
      }

      // Nothing harness-related, in the Screenshot Center or in the lab preview's card, cuts text off with an ellipsis.
      const ellipsis = await page.evaluate(() => [...document.querySelectorAll(".sc-harness, .sc-harness *, .sc-harness-banner, .sc-harness-banner *, .sc-harness-unrecorded, .sc-harness-unrecorded *, .lab-shot-card, .lab-shot-card *")].filter((el) => getComputedStyle(el).textOverflow === "ellipsis").length);
      assert.equal(ellipsis, 0, "no ellipsis anywhere");

      // Everything harness-related, in the banner, the group, the buttons, and the lab preview's card, stays inside the phone's width.
      const inside = await page.evaluate(() =>
        [...document.querySelectorAll(".sc-harness-label, .sc-harness-note, .sc-harness-tag .btn, .sc-harness-banner, .sc-harness-mixed, .sc-harness-item, .sc-harness-help, .lab-shot-card-harness")].map((el) => ({
          cls: el.className,
          left: el.getBoundingClientRect().left,
          right: el.getBoundingClientRect().right,
          scrollW: el.scrollWidth,
          clientW: el.clientWidth,
          viewport: window.innerWidth,
        })),
      );
      assert.ok(inside.length >= 12, "the banner, the group, the buttons, and the preview card are all there");
      for (const el of inside) {
        assert.ok(el.left >= -0.5 && el.right <= el.viewport + 0.5, `${el.cls} stays on screen (${Math.round(el.left)} to ${Math.round(el.right)} of ${el.viewport})`);
        assert.ok(el.scrollW <= el.clientW + 1, `${el.cls} hides nothing to the side`);
      }
      const preview = await page.locator(".lab-shot-card-harness").evaluate((el) => ({ height: el.getBoundingClientRect().height, line: Number.parseFloat(getComputedStyle(el).lineHeight) || 16, whiteSpace: getComputedStyle(el).whiteSpace }));
      assert.equal(preview.whiteSpace, "normal");
      assert.ok(preview.height >= preview.line * 3, "the preview card's harness line wraps too");

      const notRecorded = await page.locator(".sc-harness-item .sc-harness-label-not-recorded").first().evaluate((el) => ({ color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor, style: getComputedStyle(el).borderTopStyle }));
      assert.ok(contrast(notRecorded.color, notRecorded.background) >= 4.5, `${theme}: the 'Harness not recorded' label is readable`);
      assert.equal(notRecorded.style, "dotted", "its border style differs from the other harnesses, in addition to its words");
      const buttons = await page.locator(".sc-harness-tag .btn").evaluateAll((els) => els.map((el) => ({ text: el.textContent, height: el.getBoundingClientRect().height })));
      assert.deepEqual(buttons.slice(0, 3).map((b) => b.text), ["This is Standard (Classic)", "This is Microsoft Copilot", "This is Customer Conversation"]);
      assert.ok(buttons.every((b) => b.height > 0), "every button is drawn");
    } finally {
      await context.close();
    }
  });
}