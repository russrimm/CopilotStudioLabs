/**
 * Pure-Node, zero-dependency OOXML (.pptx) PresentationML builder for
 * generated labs and standalone per-topic slide decks.
 *
 * Produces a spec-compliant PKZIP PresentationML archive with widescreen 16:9
 * slides (12192000 x 6858000 EMUs), ECMA-376 Speaker Notes (`notesMaster1.xml`
 * and `notesSlideN.xml`) for PowerPoint Presenter View, theme accents honoring
 * lab branding, paginated click-by-click walkthrough slides, embedded PNG/JPEG
 * screenshots, DrawingML tables, copy-ready prompt/code cards, Check Your Work
 * & Troubleshooting cards, non-spoiler Knowledge Check quiz slides with answer
 * keys in speaker notes, and clickable external Microsoft Learn hyperlinks.
 *
 * Strictly uses Node built-in modules and local lab-builder helpers only.
 */

import { buildZipBuffer, inspectImageDimensions, stripIllegalXmlChars } from "./docx-builder.js";
import {
  ARCHITECTURE_FENCE_LANG,
  renderArchitectureDocumentMarkdown,
} from "./architecture-overview.js";
import { splitGeneratedLabModules } from "./module-samples.js";
import { resolveTopicTrainingDigest } from "./topic-training.js";
import { getBrandFont, getBrandInfoModel } from "./brand-theme.js";
import { stripEmbeddedHtml } from "./html-fragments.js";

const SLIDE_CX = 12192000; // 13.333 in * 914400 EMU/in (16:9 widescreen)
const SLIDE_CY = 6858000;  // 7.500 in * 914400 EMU/in
const NOTES_CX = 6858000;
const NOTES_CY = 9144000;
const SLIDE_THEME_NAME = "Copilot Studio Lab Theme";
const NOTES_THEME_NAME = "Copilot Studio Lab Notes Theme";

// Heading/body typefaces are module-level because dozens of slide builders reference them.
// Deck assembly is fully synchronous, and every deck resets them in its constructor,
// so a brand font never leaks from one render into the next.
const DEFAULT_FONT_HEADING = "Segoe UI Semibold";
const DEFAULT_FONT_BODY = "Segoe UI";
let FONT_HEADING = DEFAULT_FONT_HEADING;
let FONT_BODY = DEFAULT_FONT_BODY;
const FONT_CODE = "Consolas";

const COLORS = Object.freeze({
  canvasBg: "F8FAFC",
  cardBg: "FFFFFF",
  subtleBg: "F1F5F9",
  codeBg: "0F172A",
  codeBorder: "334155",
  codeText: "F8FAFC",
  ink: "0F172A",
  body: "1E293B",
  muted: "475569",
  border: "CBD5E1",
  borderLight: "E2E8F0",
  white: "FFFFFF",
  successAccent: "15803D",
  successBg: "F0FDF4",
  successBorder: "86EFAC",
  warnAccent: "B45309",
  warnBg: "FFFBEB",
  warnBorder: "FCD34D",
  quizAccent: "6D28D9",
  quizBg: "FAF5FF",
  quizBorder: "D8B4FE",
});

function sanitizeXmlChars(value) {
  return stripIllegalXmlChars(value);
}

function xmlEscape(value) {
  return sanitizeXmlChars(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeHexColor(input, fallback = "0F6CBD") {
  const cleaned = String(input || "")
    .trim()
    .replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(cleaned)) return cleaned.toUpperCase();
  if (/^[0-9a-fA-F]{3}$/.test(cleaned)) {
    return cleaned
      .split("")
      .map((ch) => ch + ch)
      .join("")
      .toUpperCase();
  }
  return fallback;
}

function blendHex(hexA, hexB, weightB = 0.5) {
  const a = normalizeHexColor(hexA);
  const b = normalizeHexColor(hexB);
  const w = Math.max(0, Math.min(1, Number(weightB) || 0));
  const ch = (offset) => {
    const va = Number.parseInt(a.slice(offset, offset + 2), 16);
    const vb = Number.parseInt(b.slice(offset, offset + 2), 16);
    return Math.round(va * (1 - w) + vb * w)
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  };
  return `${ch(0)}${ch(2)}${ch(4)}`;
}

function stripMarkdownFormatting(text) {
  return sanitizeXmlChars(text)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
    .replace(/(^|[^_])_([^_\n]+)_/g, "$1$2")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(text, maxChars = 220) {
  const clean = sanitizeXmlChars(text).replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  let cut = Math.max(16, maxChars - 1);
  // Never slice inside a Markdown `[label](url)` link — either include the complete
  // link when we are already inside it, or trim cleanly before it.
  const linkRe = /\[(?:\\.|[^\]])*\]\([^)\s]+\)/g;
  let m;
  while ((m = linkRe.exec(clean)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (cut > start && cut < end) {
      cut = end <= maxChars + 260 ? end : start;
      break;
    }
  }
  if (cut >= clean.length) return clean;
  const sliced = clean.slice(0, cut);
  if (sliced.endsWith(")")) return `${sliced}...`;
  const wordBoundary = sliced.lastIndexOf(" ");
  const trimmed = wordBoundary >= Math.floor(maxChars * 0.6) ? sliced.slice(0, wordBoundary) : sliced;
  return `${trimmed.replace(/[,:;.\-\s]+$/, "")}...`;
}

function chunkItems(items, maxPerSlide = 5) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];
  const size = Math.max(1, Number(maxPerSlide) || 5);
  const chunks = [];
  for (let i = 0; i < list.length; i += size) {
    chunks.push(list.slice(i, i + size));
  }
  return chunks;
}

function expandArchitectureBlocks(markdown) {
  const fenceRe = new RegExp(
    "```" + ARCHITECTURE_FENCE_LANG + "\\s*\\r?\\n([\\s\\S]*?)\\r?\\n```",
    "g"
  );
  return String(markdown || "").replace(fenceRe, (_whole, rawJson) => {
    try {
      const model = JSON.parse(rawJson);
      return renderArchitectureDocumentMarkdown(model);
    } catch {
      return "";
    }
  });
}

function isExternalHttpUrl(url) {
  return /^https?:\/\/\S+$/i.test(String(url || "").trim());
}

/**
 * Tokenize inline Markdown (`**bold**`, `*italic*`, `_italic_`, `` `code` ``,
 * `[label](url)`) so slide text runs preserve emphasis, inline UI paths, and
 * clickable external links.
 */
function parseInlineTokens(text) {
  const tokens = [];
  const src = sanitizeXmlChars(text);
  const pattern =
    /(\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_)/g;
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(src)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: "text", text: src.slice(lastIndex, match.index) });
    }
    if (match[2] !== undefined && match[3] !== undefined) {
      tokens.push({
        type: "link",
        text: stripMarkdownFormatting(match[2]) || match[3],
        url: match[3].trim(),
      });
    } else if (match[4] !== undefined) {
      tokens.push({ type: "code", text: match[4] });
    } else if (match[5] !== undefined || match[6] !== undefined) {
      tokens.push({ type: "bold", text: match[5] ?? match[6] });
    } else if (match[7] !== undefined || match[8] !== undefined) {
      tokens.push({ type: "italic", text: match[7] ?? match[8] });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < src.length) {
    tokens.push({ type: "text", text: src.slice(lastIndex) });
  }
  return tokens.length ? tokens : [{ type: "text", text: src }];
}

function extractMarkdownLinks(text) {
  const found = [];
  const src = sanitizeXmlChars(text);
  const re = /(?<!!)\[([^\]]+)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const label = stripMarkdownFormatting(m[1]).trim();
    const url = m[2].trim();
    if (url) {
      found.push({ title: label || url, url });
    }
  }
  return found;
}

function dedupeLinks(links) {
  const seen = new Set();
  const out = [];
  for (const item of links || []) {
    if (!item || !isExternalHttpUrl(item.url)) continue;
    const key = item.url.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title: stripMarkdownFormatting(item.title || item.url) || item.url,
      url: item.url.trim(),
      category: item.category || (key.includes("learn.microsoft.com") ? "Microsoft Learn" : "Reference"),
    });
  }
  return out;
}

function splitTableCells(line) {
  return String(line || "")
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(String(line || ""));
}

/**
 * Parse a standalone topic module Markdown (as generated by `composer.js` /
 * `splitGeneratedLabModules`) into structured pedagogical sections for rich
 * multi-slide presentation rendering.
 */
export function parseTopicMarkdownStructure(markdown, hints = {}) {
  const expanded = expandArchitectureBlocks(stripEmbeddedHtml(markdown));
  const lines = expanded.replace(/\r\n/g, "\n").split("\n");

  const meta = {
    labTitle: hints.labTitle || "",
    stepLabel: hints.stepLabel || "",
    moduleText: "",
    topicTitle: hints.topicTitle || "",
    levelText: hints.levelText || "",
    estimatedTime: hints.estimatedTime || "",
    products: hints.products || "",
    agentName: hints.agentName || "",
  };

  let headingConsumed = false;
  let idx = 0;

  while (idx < lines.length && !lines[idx].trim()) idx += 1;
  if (idx < lines.length) {
    const hMatch = lines[idx].match(/^#{1,3}\s+(.+?)\s*$/);
    if (hMatch) {
      headingConsumed = true;
      const rawHeading = stripMarkdownFormatting(hMatch[1]);
      const stepMatch = rawHeading.match(
        /^(?:Prerequisite\s+)?(Step\s+\d+|Recap\s+\d+)\s*(?:-|–|—|:)\s*(.+)$/i
      );
      if (stepMatch) {
        if (!meta.stepLabel) meta.stepLabel = stepMatch[1].replace(/\s+/g, " ").trim();
        if (!meta.topicTitle) meta.topicTitle = stepMatch[2].trim();
      } else if (!meta.topicTitle) {
        meta.topicTitle = rawHeading;
      }
      idx += 1;
    }
  }

  // Parse optional `*Part of lab: <Lab Title>*` line emitted by `splitGeneratedLabModules`
  while (idx < lines.length && !lines[idx].trim()) idx += 1;
  if (idx < lines.length) {
    const partOfLabMatch = lines[idx].trim().match(/^\*Part of lab:\s*(.+?)\*$/i);
    if (partOfLabMatch) {
      if (!meta.labTitle) meta.labTitle = stripMarkdownFormatting(partOfLabMatch[1]);
      idx += 1;
    }
  }

  // Parse optional top metadata table (`| **LAB** | ... |`, optionally preceded by `| Field | Details |`)
  let tableSharepointSite = "";
  while (idx < lines.length && !lines[idx].trim()) idx += 1;
  if (
    idx + 1 < lines.length &&
    lines[idx].trim().startsWith("|") &&
    isTableSeparator(lines[idx + 1])
  ) {
    const candidateRows = [splitTableCells(lines[idx])];
    let tIdx = idx + 2;
    while (tIdx < lines.length && lines[tIdx].trim().startsWith("|")) {
      candidateRows.push(splitTableCells(lines[tIdx]));
      tIdx += 1;
    }
    const looksLikeModuleMeta = candidateRows.some((r) =>
      /^(LAB|MODULE|LEVEL|ESTIMATED TIME|PRODUCTS|SHAREPOINT SITE|DURATION|DIFFICULTY|SAMPLE FILES)$/i.test(
        stripMarkdownFormatting(r[0] || "")
      )
    );
    if (looksLikeModuleMeta) {
      for (const [kRaw, vRaw] of candidateRows) {
        const key = stripMarkdownFormatting(kRaw || "").toUpperCase();
        const val = stripMarkdownFormatting(vRaw || "");
        if (!val || key === "FIELD") continue;
        if (key === "SHAREPOINT SITE" && vRaw) {
          tableSharepointSite = String(vRaw).trim();
          continue;
        }
        if (key === "LAB" && !meta.labTitle) meta.labTitle = val;
        else if (key === "MODULE") {
          meta.moduleText = val;
          const fullModMatch = val.match(/^(Step\s+\d+|Recap\s+\d+)\s*(?:—|–|-|:)\s*(.+)$/i);
          if (fullModMatch) {
            if (!meta.stepLabel) meta.stepLabel = fullModMatch[1].replace(/\s+/g, " ").trim();
            if (!hints.topicTitle) meta.topicTitle = fullModMatch[2].replace(/^Recap:\s*/i, "").trim();
          } else if (!meta.stepLabel) {
            const sm = val.match(/^(Step\s+\d+|Recap\s+\d+)/i);
            if (sm) meta.stepLabel = sm[1];
          }
        } else if ((key === "LEVEL" || key === "DIFFICULTY") && !meta.levelText) {
          meta.levelText = val;
        } else if ((key === "ESTIMATED TIME" || key === "DURATION") && !meta.estimatedTime) {
          meta.estimatedTime = val;
        } else if (key === "PRODUCTS" && !meta.products) {
          meta.products = val;
        }
      }
      idx = tIdx;
      // Skip optional horizontal rule + repeated H2 display title right after metadata table
      while (idx < lines.length && (!lines[idx].trim() || /^---+$/.test(lines[idx].trim()))) {
        idx += 1;
      }
      if (idx < lines.length && /^##\s+/.test(lines[idx].trim())) {
        idx += 1;
      }
    }
  }

  // Extract `<details>...</details>` blocks (Troubleshooting & Knowledge check answers)
  const bodyText = lines.slice(idx).join("\n");
  const troubleshooting = [];
  const quizAnswerByNumber = new Map();
  const extraLearnLinks = [];

  const withoutDetails = bodyText.replace(
    /<details\b[^>]*>([\s\S]*?)<\/details>/gi,
    (_whole, inner) => {
      const summaryMatch = inner.match(/^\s*<summary\b[^>]*>([\s\S]*?)<\/summary>/i);
      const summary = summaryMatch ? stripMarkdownFormatting(summaryMatch[1]) : "";
      const rest = summaryMatch ? inner.slice(summaryMatch[0].length).trim() : inner.trim();
      for (const l of extractMarkdownLinks(rest)) extraLearnLinks.push(l);

      const qMatch = summary.match(/Question\s+(\d+)\s+answer/i);
      const isGenericAnswer = !qMatch && /\banswer\b/i.test(summary);
      if (qMatch || isGenericAnswer) {
        const qNum = qMatch ? Number.parseInt(qMatch[1], 10) : quizAnswerByNumber.size + 1;
        let answerLetter = "";
        let explanation = "";
        const learnLinks = extractMarkdownLinks(rest);
        for (const rawLine of rest.split("\n")) {
          const t = rawLine.trim();
          if (!t) continue;
          const ansMatch =
            t.match(/^\*\*Correct answer:\s*([A-D])\.?\*\*\s*(.*)$/i) ||
            t.match(/^\*\*Correct answer:?\*\*\s*([A-D])(?:\s*[.):—–-]\s*|\s+)(.*)$/i);
          if (ansMatch) {
            answerLetter = ansMatch[1].toUpperCase();
            explanation = ansMatch[2].trim();
          } else if (!/^\*\*Microsoft Learn reference:/i.test(t)) {
            explanation = explanation ? `${explanation} ${t}` : t;
          }
        }
        quizAnswerByNumber.set(qNum, {
          correctLetter: answerLetter,
          explanation,
          learnLinks: dedupeLinks(learnLinks),
        });
        return "";
      }

      if (/troubleshooting/i.test(summary)) {
        for (const rawLine of rest.split("\n")) {
          const bullet = rawLine.trim().match(/^[-*+]\s+(.+)$/);
          if (bullet) troubleshooting.push(bullet[1].trim());
        }
        return "";
      }

      // Preserve any other details block as note lines
      return rest;
    }
  );

  const whatYouAreDoing = [];
  let whyItMatters = "";
  let fromTheDocs = "";
  let inYourScenario = "";
  let sharepointSite = typeof tableSharepointSite === "string" ? tableSharepointSite : "";
  let provenance = "";
  const concepts = [];
  const steps = [];
  const expectedResults = [];
  const differenceNotes = [];
  const checkYourWork = [];
  const codeSnippets = [];
  const tables = [];
  const images = [];
  const learnReferences = [];
  const vendorReferences = [];
  const knowledgeChecks = [];
  const otherBullets = [];

  let section = "intro";
  let currentQuiz = null;
  let pendingSampleLabel = "";

  const remLines = withoutDetails.split("\n");
  for (let i = 0; i < remLines.length; i += 1) {
    const raw = remLines[i];
    const trimmed = raw.trim();

    if (!trimmed || /^---+$/.test(trimmed)) continue;

    // Fenced code blocks
    const fenceOpen = trimmed.match(/^(`{3,}|~{3,})([^\s`~]*)/);
    if (fenceOpen) {
      const marker = fenceOpen[1];
      const lang = fenceOpen[2] || "text";
      const codeLines = [];
      i += 1;
      while (i < remLines.length && !remLines[i].trim().startsWith(marker)) {
        codeLines.push(remLines[i]);
        i += 1;
      }
      if (codeLines.join("\n").trim()) {
        codeSnippets.push({
          label: pendingSampleLabel || (lang && lang !== "text" ? `${lang.toUpperCase()} snippet` : "Sample input / prompt"),
          language: lang,
          code: codeLines.join("\n"),
        });
        pendingSampleLabel = "";
      }
      continue;
    }

    // Markdown tables inside module body
    if (
      trimmed.startsWith("|") &&
      i + 1 < remLines.length &&
      isTableSeparator(remLines[i + 1])
    ) {
      const headers = splitTableCells(trimmed);
      const rows = [];
      i += 2;
      while (i < remLines.length && remLines[i].trim().startsWith("|")) {
        rows.push(splitTableCells(remLines[i]));
        i += 1;
      }
      i -= 1;
      tables.push({
        title: pendingSampleLabel || "Configuration & Reference Values",
        headers,
        rows,
      });
      pendingSampleLabel = "";
      continue;
    }

    // Standalone image line
    const imgMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/);
    if (imgMatch) {
      let caption = "";
      if (i + 1 < remLines.length) {
        const nextTrimmed = remLines[i + 1].trim();
        const capMatch = nextTrimmed.match(/^_([^_]+)_\s*$/) || nextTrimmed.match(/^\*([^*]+)\*\s*$/);
        if (capMatch) {
          caption = capMatch[1].trim();
          i += 1;
        }
      }
      images.push({
        alt: imgMatch[1].trim() || "Topic screenshot",
        src: imgMatch[2].trim(),
        caption,
      });
      continue;
    }

    // Collect any inline links for reference fallback
    for (const l of extractMarkdownLinks(trimmed)) extraLearnLinks.push(l);

    // Blockquotes
    if (trimmed.startsWith(">")) {
      const quoteLines = [];
      while (i < remLines.length && remLines[i].trim().startsWith(">")) {
        quoteLines.push(remLines[i].trim().replace(/^>\s?/, ""));
        i += 1;
      }
      i -= 1;
      const quoteText = quoteLines.join(" ").trim();
      if (/^\*\*Why this matters:\*\*/i.test(quoteText)) {
        whyItMatters = quoteText.replace(/^\*\*Why this matters:\*\*\s*/i, "").trim();
      } else if (/^\*\*From the documentation:\*\*/i.test(quoteText)) {
        fromTheDocs = quoteText.replace(/^\*\*From the documentation:\*\*\s*/i, "").trim();
      } else if (/^\*\*In your scenario:\*\*/i.test(quoteText)) {
        inYourScenario = quoteText.replace(/^\*\*In your scenario:\*\*\s*/i, "").trim();
        if (!meta.agentName) {
          const boldMatch = inYourScenario.match(/\*\*([^*]{2,80})\*\*/);
          if (boldMatch) meta.agentName = boldMatch[1].trim();
        }
      } else if (/^\*\*Target SharePoint site:\*\*/i.test(quoteText)) {
        sharepointSite = quoteText.replace(/^\*\*Target SharePoint site:\*\*\s*/i, "").trim();
      } else if (
        section === "quiz" &&
        currentQuiz &&
        /^\*\*(?:Correct\s+)?Answer:?\*\*/i.test(quoteText)
      ) {
        const inlineAns =
          quoteText.match(/^\*\*(?:Correct\s+)?Answer:\s*([A-D])\.?\*\*\s*(.*)$/i) ||
          quoteText.match(
            /^\*\*(?:Correct\s+)?Answer:?\*\*\s*([A-D])\b(?:\s*[.):—–-]\s*|\s+)?(.*)$/i
          );
        if (inlineAns) {
          currentQuiz.correctLetter = inlineAns[1].toUpperCase();
          currentQuiz.explanation = inlineAns[2].trim();
        } else {
          currentQuiz.explanation = quoteText
            .replace(/^\*\*(?:Correct\s+)?Answer:?\*\*\s*/i, "")
            .trim();
        }
        const quoteLinks = extractMarkdownLinks(quoteText);
        if (quoteLinks.length > 0) {
          currentQuiz.learnLinks = dedupeLinks([
            ...(currentQuiz.learnLinks || []),
            ...quoteLinks,
          ]);
        }
      } else {
        differenceNotes.push(quoteText);
      }
      continue;
    }

    // Explicit section markers
    if (/^\*\*(?:Concepts before you click|Key concepts):?\*\*$/i.test(trimmed)) {
      section = "concepts";
      continue;
    }
    if (/^\*\*Why this matters:?\*\*\s+/i.test(trimmed)) {
      whyItMatters = trimmed.replace(/^\*\*Why this matters:?\*\*\s+/i, "").trim();
      continue;
    }
    if (/^\*\*Do this:?\*\*$/i.test(trimmed)) {
      section = "steps";
      continue;
    }
    if (/^\*\*What you should see:?\*\*/i.test(trimmed)) {
      const inline = trimmed.replace(/^\*\*What you should see:?\*\*\s*/i, "").trim();
      if (inline) expectedResults.push(inline);
      section = "expected";
      continue;
    }
    if (/^\*\*Check your work:?\*\*$/i.test(trimmed)) {
      section = "check";
      continue;
    }
    if (/^(?:\*\*Knowledge check:?|#{2,4}\s+Knowledge check\b)/i.test(trimmed)) {
      section = "quiz";
      continue;
    }
    if (/^\*\*References:?\*\*$/i.test(trimmed)) {
      section = "references";
      continue;
    }
    if (/^\*\*Microsoft Learn:\*\*/i.test(trimmed)) {
      for (const l of extractMarkdownLinks(trimmed)) {
        learnReferences.push({ ...l, category: "Microsoft Learn" });
      }
      continue;
    }
    if (/^\*\*Vendor documentation:\*\*/i.test(trimmed)) {
      for (const l of extractMarkdownLinks(trimmed)) {
        vendorReferences.push({ ...l, category: "Vendor documentation" });
      }
      continue;
    }
    if (/^_Steps adapted from\s+/i.test(trimmed)) {
      provenance = trimmed.replace(/^_|_$/g, "").trim();
      continue;
    }

    // Quiz questions & options
    if (section === "quiz") {
      const qPromptMatch =
        trimmed.match(/^\*\*Question(?:\s+(\d+))?[.:]\*\*\s*(.+)$/i) ||
        trimmed.match(/^(\d+)\.\s+(.+)$/);
      if (qPromptMatch) {
        const qNum = qPromptMatch[1]
          ? Number.parseInt(qPromptMatch[1], 10)
          : knowledgeChecks.length + 1;
        const answerInfo = quizAnswerByNumber.get(qNum) || {
          correctLetter: "",
          explanation: "",
          learnLinks: [],
        };
        currentQuiz = {
          number: qNum,
          prompt: qPromptMatch[2].trim(),
          options: [],
          correctLetter: answerInfo.correctLetter,
          explanation: answerInfo.explanation,
          learnLinks: answerInfo.learnLinks,
        };
        knowledgeChecks.push(currentQuiz);
        continue;
      }
      const optMatch = trimmed.match(
        /^[-*+]\s+(?:\*\*([A-D])[.)]\*\*|([A-D])[.)])\s+(.+)$/
      );
      if (optMatch && currentQuiz) {
        const optLetter = (optMatch[1] || optMatch[2] || "").toUpperCase();
        const rawOptBody = optMatch[3].trim();
        if (/\(\s*Correct\s*\)\s*$/i.test(rawOptBody) && !currentQuiz.correctLetter) {
          currentQuiz.correctLetter = optLetter;
        }
        const cleanOptBody = rawOptBody.replace(/\s*\(\s*Correct\s*\)\s*$/i, "").trim();
        currentQuiz.options.push(`${optLetter}. ${cleanOptBody}`);
        continue;
      }
      if (/^\*Test your understanding/i.test(trimmed)) {
        continue;
      }
    }

    // Sample prompt / configuration intro labels
    if (/^\*\*Sample\s+[^*]+\.\*\*/i.test(trimmed)) {
      const labelMatch = trimmed.match(/^\*\*([^*]+?)\.\*\*\s*(.*)$/);
      if (labelMatch) {
        pendingSampleLabel = labelMatch[1].trim();
        if (labelMatch[2] && !remLines[i + 1]?.trim()?.startsWith("```")) {
          inYourScenario = inYourScenario
            ? `${inYourScenario} ${trimmed}`
            : trimmed;
        }
      }
      continue;
    }

    // Task checklist items
    const taskMatch = trimmed.match(/^[-*+]\s+\[([ xX])\]\s+(.+)$/);
    if (taskMatch) {
      checkYourWork.push({
        checked: taskMatch[1].toLowerCase() === "x",
        text: taskMatch[2].trim(),
      });
      continue;
    }

    // Numbered steps
    const orderedMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (orderedMatch) {
      steps.push({
        number: Number.parseInt(orderedMatch[1], 10),
        text: orderedMatch[2].trim(),
      });
      section = "steps";
      continue;
    }

    // Unordered bullets
    const bulletMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (bulletMatch) {
      const itemText = bulletMatch[1].trim();
      if (section === "references") {
        for (const l of extractMarkdownLinks(itemText)) {
          learnReferences.push({ ...l, category: "Microsoft Learn" });
        }
      } else if (section === "concepts") concepts.push(itemText);
      else if (section === "expected") expectedResults.push(itemText);
      else if (section === "check") checkYourWork.push({ checked: false, text: itemText });
      else otherBullets.push(itemText);
      continue;
    }

    // Subheadings inside generic markdown
    const subHeading = trimmed.match(/^#{2,6}\s+(.+)$/);
    if (subHeading) {
      const hTitle = stripMarkdownFormatting(subHeading[1]);
      if (/knowledge check|quiz/i.test(hTitle)) section = "quiz";
      else if (/reference|further reading/i.test(hTitle)) section = "references";
      else if (/check your work|validation/i.test(hTitle)) section = "check";
      else if (/concept|overview|why/i.test(hTitle)) section = "concepts";
      else if (/step|walkthrough|procedure|do this/i.test(hTitle)) section = "steps";
      else pendingSampleLabel = hTitle;
      continue;
    }

    // Plain prose paragraphs
    if (section === "intro") {
      whatYouAreDoing.push(trimmed);
    } else if (section === "expected") {
      expectedResults.push(trimmed);
    } else if (whatYouAreDoing.length === 0) {
      whatYouAreDoing.push(trimmed);
    } else {
      otherBullets.push(trimmed);
    }
  }

  const allReferences = dedupeLinks([
    ...learnReferences,
    ...vendorReferences,
    ...extraLearnLinks,
    ...(hints.references || []),
  ]);

  const isStructuredTopic = Boolean(
    steps.length > 0 ||
      checkYourWork.length > 0 ||
      whyItMatters ||
      inYourScenario ||
      knowledgeChecks.length > 0 ||
      meta.stepLabel
  );

  return {
    headingConsumed,
    isStructuredTopic,
    meta: {
      labTitle: meta.labTitle || hints.labTitle || "Hands-On Lab",
      stepLabel: meta.stepLabel || hints.stepLabel || "",
      moduleText: meta.moduleText || meta.stepLabel || "",
      topicTitle: meta.topicTitle || hints.topicTitle || "Lab Topic",
      levelText: meta.levelText || hints.levelText || "",
      estimatedTime: meta.estimatedTime || hints.estimatedTime || "",
      products: meta.products || hints.products || "",
      agentName: meta.agentName || hints.agentName || "",
    },
    whatYouAreDoing,
    whyItMatters,
    fromTheDocs,
    inYourScenario,
    sharepointSite,
    provenance,
    concepts,
    steps,
    expectedResults,
    differenceNotes,
    checkYourWork,
    troubleshooting,
    knowledgeChecks,
    codeSnippets,
    tables,
    images,
    otherBullets,
    references: allReferences,
  };
}

/**
 * Presentation state collector that assigns slide shapes, deduplicates embedded
 * media buffers, and tracks per-slide external hyperlink and image relationships.
 */
class PptxDeckAssembler {
  constructor(options = {}) {
    const branding = options.branding || {};
    this.primaryHex = normalizeHexColor(branding.primaryColor, "0F6CBD");
    this.primaryDarkHex = blendHex(this.primaryHex, "0A2540", 0.38);
    this.primaryTintHex = blendHex(this.primaryHex, "FFFFFF", 0.9);
    this.primaryBorderHex = blendHex(this.primaryHex, "FFFFFF", 0.65);
    this.secondaryHex = branding.secondaryColor ? normalizeHexColor(branding.secondaryColor, "") : "";
    const brandFont = getBrandFont(branding.font).office;
    this.brandFont = brandFont || null;
    FONT_HEADING = brandFont || DEFAULT_FONT_HEADING;
    FONT_BODY = brandFont || DEFAULT_FONT_BODY;
    this.organizationName = sanitizeXmlChars(
      branding.companyName || branding.organizationName || ""
    ).trim();
    this.footerText = sanitizeXmlChars(
      branding.footerText || branding.tagline || ""
    ).trim();
    this.coverSubtitle = sanitizeXmlChars(branding.coverSubtitle || "").trim();
    this.brandInfo = getBrandInfoModel(branding);
    this.title = sanitizeXmlChars(options.title || "Hands-On Lab").trim() || "Hands-On Lab";
    this.resolveImageBuffer =
      typeof options.resolveImageBuffer === "function" ? options.resolveImageBuffer : null;

    this.mediaByKey = new Map();
    this.mediaItems = [];
    this.slides = [];

    this.logoMedia = null;
    if (Buffer.isBuffer(branding.logoBuffer)) {
      this.logoMedia = this.registerMediaBuffer("branding:logo", branding.logoBuffer);
    }
  }

  registerMediaBuffer(cacheKey, buf) {
    if (!Buffer.isBuffer(buf) || !buf.length) return null;
    if (cacheKey && this.mediaByKey.has(cacheKey)) {
      return this.mediaByKey.get(cacheKey);
    }
    const dim = inspectImageDimensions(buf);
    const mediaKind = String(dim?.ext || dim?.type || "").toLowerCase();
    if (!dim || (mediaKind !== "png" && mediaKind !== "jpeg" && mediaKind !== "jpg")) return null;
    const index = this.mediaItems.length + 1;
    const ext = mediaKind === "png" ? "png" : "jpeg";
    const entry = {
      index,
      fileName: `image${index}.${ext}`,
      data: buf,
      widthPx: Math.max(1, dim.width || 800),
      heightPx: Math.max(1, dim.height || 450),
      type: ext,
    };
    this.mediaItems.push(entry);
    if (cacheKey) this.mediaByKey.set(cacheKey, entry);
    return entry;
  }

  resolveTopicImage(src) {
    if (!src || !this.resolveImageBuffer) return null;
    const key = `src:${src}`;
    if (this.mediaByKey.has(key)) return this.mediaByKey.get(key);
    let buf = null;
    try {
      buf = this.resolveImageBuffer(src);
    } catch {
      buf = null;
    }
    if (!Buffer.isBuffer(buf)) return null;
    return this.registerMediaBuffer(key, buf);
  }

  createSlide(meta = {}) {
    const slide = new SlideBuilder(this, meta);
    this.slides.push(slide);
    return slide;
  }

  toPptxBuffer() {
    if (this.slides.length === 0) {
      const empty = this.createSlide({ kicker: "OVERVIEW", title: this.title });
      empty.addCard({
        x: 685800,
        y: 1500000,
        cx: SLIDE_CX - 1371600,
        cy: 2400000,
        paragraphs: [{ text: this.title, sizePt: 18, bold: true }],
      });
      empty.setNotes([
        `FACILITATOR OVERVIEW: ${this.title}`,
        "PACING CUE: Confirm every attendee can sign in to the target environment before starting hands-on steps.",
      ]);
    }

    const totalSlides = this.slides.length;
    const notesEntries = [];
    this.slides.forEach((slide, idx) => {
      const slideNum = idx + 1;
      slide.finalizeChrome(slideNum, totalSlides);
      if (slide.hasNotes()) {
        notesEntries.push({
          slide,
          slideNum,
          notesNum: notesEntries.length + 1,
        });
      }
    });
    const notesNumBySlideNum = new Map(
      notesEntries.map((entry) => [entry.slideNum, entry.notesNum])
    );

    const entries = [
      { name: "[Content_Types].xml", data: this.renderContentTypesXml(notesEntries) },
      { name: "_rels/.rels", data: this.renderRootRelsXml() },
      { name: "docProps/core.xml", data: this.renderCorePropsXml() },
      { name: "docProps/app.xml", data: this.renderAppPropsXml(notesEntries.length) },
      { name: "ppt/presentation.xml", data: this.renderPresentationXml() },
      { name: "ppt/_rels/presentation.xml.rels", data: this.renderPresentationRelsXml() },
      { name: "ppt/presProps.xml", data: this.renderPresPropsXml() },
      { name: "ppt/viewProps.xml", data: this.renderViewPropsXml() },
      { name: "ppt/tableStyles.xml", data: this.renderTableStylesXml() },
      { name: "ppt/theme/theme1.xml", data: this.renderThemeXml(SLIDE_THEME_NAME) },
      // PowerPoint rejects a package whose notes master shares the slide master's theme part.
      { name: "ppt/theme/theme2.xml", data: this.renderThemeXml(NOTES_THEME_NAME) },
      { name: "ppt/slideMasters/slideMaster1.xml", data: this.renderSlideMasterXml() },
      { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: this.renderSlideMasterRelsXml() },
      { name: "ppt/slideLayouts/slideLayout1.xml", data: this.renderSlideLayoutXml() },
      { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: this.renderSlideLayoutRelsXml() },
      { name: "ppt/notesMasters/notesMaster1.xml", data: this.renderNotesMasterXml() },
      { name: "ppt/notesMasters/_rels/notesMaster1.xml.rels", data: this.renderNotesMasterRelsXml() },
    ];

    this.slides.forEach((slide, idx) => {
      const num = idx + 1;
      const notesNum = notesNumBySlideNum.get(num) || null;
      entries.push({ name: `ppt/slides/slide${num}.xml`, data: slide.renderXml() });
      entries.push({
        name: `ppt/slides/_rels/slide${num}.xml.rels`,
        data: slide.renderRelsXml(notesNum),
      });
    });

    for (const entry of notesEntries) {
      entries.push({
        name: `ppt/notesSlides/notesSlide${entry.notesNum}.xml`,
        data: entry.slide.renderNotesXml(entry.slideNum),
      });
      entries.push({
        name: `ppt/notesSlides/_rels/notesSlide${entry.notesNum}.xml.rels`,
        data: entry.slide.renderNotesRelsXml(entry.slideNum),
      });
    }

    for (const media of this.mediaItems) {
      entries.push({ name: `ppt/media/${media.fileName}`, data: media.data });
    }

    return buildZipBuffer(entries);
  }

  renderContentTypesXml(notesEntries = []) {
    const overrides = [
      `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`,
      `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>`,
      `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`,
      `<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>`,
      `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`,
      `<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`,
      `<Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>`,
      `<Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>`,
      `<Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>`,
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`,
      `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>`,
      ...this.slides.map(
        (_s, idx) =>
          `<Override PartName="/ppt/slides/slide${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
      ),
      ...notesEntries.map(
        (entry) =>
          `<Override PartName="/ppt/notesSlides/notesSlide${entry.notesNum}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`
      ),
    ];
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  ${overrides.join("\n  ")}
</Types>`;
  }

  renderRootRelsXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
  }

  renderCorePropsXml() {
    const nowIso = new Date().toISOString();
    const creator = this.organizationName || "Copilot Studio Labs Builder";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:dcmitype="http://purl.org/dc/dcmitype/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xmlEscape(this.title)}</dc:title>
  <dc:creator>${xmlEscape(creator)}</dc:creator>
  <cp:lastModifiedBy>${xmlEscape(creator)}</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${nowIso}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${nowIso}</dcterms:modified>
</cp:coreProperties>`;
  }

  renderAppPropsXml(notesCount = 0) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
  xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Copilot Studio Labs Builder</Application>
  <PresentationFormat>Widescreen</PresentationFormat>
  <Slides>${this.slides.length}</Slides>
  <Notes>${notesCount}</Notes>
  <HiddenSlides>0</HiddenSlides>
  <MMClips>0</MMClips>
  <ScaleCrop>false</ScaleCrop>
  <Company>${xmlEscape(this.organizationName)}</Company>
  <LinksUpToDate>false</LinksUpToDate>
  <SharedDoc>false</SharedDoc>
  <HyperlinksChanged>false</HyperlinksChanged>
  <AppVersion>16.0000</AppVersion>
</Properties>`;
  }

  renderPresentationXml() {
    const sldIds = this.slides
      .map((_s, idx) => `<p:sldId id="${256 + idx}" r:id="rIdSlide${idx + 1}"/>`)
      .join("\n    ");
    const lvlStyles = Array.from({ length: 9 }, (_v, i) => {
      const marL = i * 342900;
      const sz = Math.max(1100, 1800 - i * 100);
      return `<a:lvl${i + 1}pPr marL="${marL}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1">
      <a:defRPr sz="${sz}" kern="1200">
        <a:solidFill><a:schemeClr val="tx1"/></a:solidFill>
        <a:latin typeface="+mn-lt"/>
        <a:ea typeface="+mn-ea"/>
        <a:cs typeface="+mn-cs"/>
      </a:defRPr>
    </a:lvl${i + 1}pPr>`;
    }).join("\n    ");

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  saveSubsetFonts="1">
  <p:sldMasterIdLst>
    <p:sldMasterId id="2147483648" r:id="rIdMaster1"/>
  </p:sldMasterIdLst>
  <p:notesMasterIdLst>
    <p:notesMasterId r:id="rIdNotesMaster1"/>
  </p:notesMasterIdLst>
  <p:sldIdLst>
    ${sldIds}
  </p:sldIdLst>
  <p:sldSz cx="${SLIDE_CX}" cy="${SLIDE_CY}"/>
  <p:notesSz cx="${NOTES_CX}" cy="${NOTES_CY}"/>
  <p:defaultTextStyle>
    <a:defPPr>
      <a:defRPr lang="en-US"/>
    </a:defPPr>
    ${lvlStyles}
  </p:defaultTextStyle>
</p:presentation>`;
  }

  renderPresentationRelsXml() {
    const slideRels = this.slides
      .map(
        (_s, idx) =>
          `<Relationship Id="rIdSlide${idx + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${idx + 1}.xml"/>`
      )
      .join("\n  ");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdMaster1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  <Relationship Id="rIdNotesMaster1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="notesMasters/notesMaster1.xml"/>
  <Relationship Id="rIdPresProps" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/>
  <Relationship Id="rIdViewProps" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps" Target="viewProps.xml"/>
  <Relationship Id="rIdTheme1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
  <Relationship Id="rIdTableStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/>
  ${slideRels}
</Relationships>`;
  }

  renderPresPropsXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentationPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`;
  }

  renderViewPropsXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:viewPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:normalViewPr>
    <p:restoredLeft sz="15620"/>
    <p:restoredTop sz="94660"/>
  </p:normalViewPr>
  <p:slideViewPr>
    <p:cSldViewPr>
      <p:cViewPr varScale="1">
        <p:scale>
          <a:sx n="100" d="100"/>
          <a:sy n="100" d="100"/>
        </p:scale>
        <p:origin x="0" y="0"/>
      </p:cViewPr>
    </p:cSldViewPr>
  </p:slideViewPr>
</p:viewPr>`;
  }

  renderTableStylesXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`;
  }

  renderThemeXml(themeName = SLIDE_THEME_NAME) {
    const headingFont = xmlEscape(FONT_HEADING);
    const bodyFont = xmlEscape(FONT_BODY);
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${xmlEscape(themeName)}">
  <a:themeElements>
    <a:clrScheme name="Copilot Studio">
      <a:dk1><a:srgbClr val="${COLORS.ink}"/></a:dk1>
      <a:lt1><a:srgbClr val="${COLORS.white}"/></a:lt1>
      <a:dk2><a:srgbClr val="${COLORS.body}"/></a:dk2>
      <a:lt2><a:srgbClr val="${COLORS.subtleBg}"/></a:lt2>
      <a:accent1><a:srgbClr val="${this.primaryHex}"/></a:accent1>
      <a:accent2><a:srgbClr val="${this.secondaryHex || this.primaryDarkHex}"/></a:accent2>
      <a:accent3><a:srgbClr val="${COLORS.successAccent}"/></a:accent3>
      <a:accent4><a:srgbClr val="${COLORS.warnAccent}"/></a:accent4>
      <a:accent5><a:srgbClr val="${COLORS.quizAccent}"/></a:accent5>
      <a:accent6><a:srgbClr val="0284C7"/></a:accent6>
      <a:hlink><a:srgbClr val="${this.primaryHex}"/></a:hlink>
      <a:folHlink><a:srgbClr val="${this.primaryDarkHex}"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Segoe UI">
      <a:majorFont>
        <a:latin typeface="${headingFont}"/>
        <a:ea typeface=""/>
        <a:cs typeface=""/>
      </a:majorFont>
      <a:minorFont>
        <a:latin typeface="${bodyFont}"/>
        <a:ea typeface=""/>
        <a:cs typeface=""/>
      </a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="Standard">
      <a:fillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:fillStyleLst>
      <a:lnStyleLst>
        <a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
        <a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
        <a:ln w="25400" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
      </a:lnStyleLst>
      <a:effectStyleLst>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
      </a:effectStyleLst>
      <a:bgFillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
  <a:objectDefaults/>
  <a:extraClrSchemeLst/>
</a:theme>`;
  }

  renderSlideMasterXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg>
      <p:bgRef idx="1001">
        <a:schemeClr val="bg1"/>
      </p:bgRef>
    </p:bg>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm>
          <a:off x="0" y="0"/>
          <a:ext cx="0" cy="0"/>
          <a:chOff x="0" y="0"/>
          <a:chExt cx="0" cy="0"/>
        </a:xfrm>
      </p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst>
    <p:sldLayoutId id="2147483649" r:id="rIdLayout1"/>
  </p:sldLayoutIdLst>
  <p:txStyles>
    <p:titleStyle>
      <a:lvl1pPr algn="l"><a:defRPr sz="2800" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr>
    </p:titleStyle>
    <p:bodyStyle>
      <a:lvl1pPr marL="228600" indent="-228600" algn="l"><a:defRPr sz="1600"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr>
    </p:bodyStyle>
    <p:otherStyle>
      <a:lvl1pPr algn="l"><a:defRPr sz="1400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr>
    </p:otherStyle>
  </p:txStyles>
</p:sldMaster>`;
  }

  renderSlideMasterRelsXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdLayout1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rIdTheme1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`;
  }

  renderSlideLayoutXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  type="blank" preserve="1">
  <p:cSld name="Blank">
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm>
          <a:off x="0" y="0"/>
          <a:ext cx="0" cy="0"/>
          <a:chOff x="0" y="0"/>
          <a:chExt cx="0" cy="0"/>
        </a:xfrm>
      </p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr>
    <a:masterClrMapping/>
  </p:clrMapOvr>
</p:sldLayout>`;
  }

  renderSlideLayoutRelsXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdMaster1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`;
  }

  renderNotesMasterXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notesMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg>
      <p:bgRef idx="1001">
        <a:schemeClr val="bg1"/>
      </p:bgRef>
    </p:bg>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm>
          <a:off x="0" y="0"/>
          <a:ext cx="0" cy="0"/>
          <a:chOff x="0" y="0"/>
          <a:chExt cx="0" cy="0"/>
        </a:xfrm>
      </p:grpSpPr>
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="2" name="Slide Image Placeholder 1"/>
          <p:cNvSpPr>
            <a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/>
          </p:cNvSpPr>
          <p:nvPr>
            <p:ph type="sldImg"/>
          </p:nvPr>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm>
            <a:off x="685800" y="685800"/>
            <a:ext cx="5486400" cy="3086100"/>
          </a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        </p:spPr>
      </p:sp>
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="3" name="Notes Placeholder 2"/>
          <p:cNvSpPr>
            <a:spLocks noGrp="1"/>
          </p:cNvSpPr>
          <p:nvPr>
            <p:ph type="body" idx="1"/>
          </p:nvPr>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm>
            <a:off x="685800" y="4000500"/>
            <a:ext cx="5486400" cy="4343400"/>
          </a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        </p:spPr>
        <p:txBody>
          <a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/>
          <a:lstStyle/>
          <a:p>
            <a:pPr lvl="0"/>
            <a:endParaRPr lang="en-US"/>
          </a:p>
        </p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="4" name="Slide Number Placeholder 3"/>
          <p:cNvSpPr>
            <a:spLocks noGrp="1"/>
          </p:cNvSpPr>
          <p:nvPr>
            <p:ph type="sldNum" sz="quarter" idx="10"/>
          </p:nvPr>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm>
            <a:off x="3884613" y="8685213"/>
            <a:ext cx="2287587" cy="457200"/>
          </a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        </p:spPr>
        <p:txBody>
          <a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="b"/>
          <a:lstStyle/>
          <a:p>
            <a:fld id="{7F8B6D52-4A9E-4B1D-9C1E-2A4F8E3C0010}" type="slidenum">
              <a:rPr lang="en-US" smtClean="0"/>
              <a:t>#</a:t>
            </a:fld>
            <a:endParaRPr lang="en-US"/>
          </a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:notesStyle>
    <a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1">
      <a:defRPr sz="1150" kern="1200">
        <a:solidFill><a:schemeClr val="tx1"/></a:solidFill>
        <a:latin typeface="+mn-lt"/>
        <a:ea typeface="+mn-ea"/>
        <a:cs typeface="+mn-cs"/>
      </a:defRPr>
    </a:lvl1pPr>
  </p:notesStyle>
</p:notesMaster>`;
  }

  renderNotesMasterRelsXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme2.xml"/>
</Relationships>`;
  }
}

class SlideBuilder {
  constructor(deck, meta = {}) {
    this.deck = deck;
    this.meta = meta;
    this.nextShapeId = 2; // id=1 is reserved for spTree nvGrpSpPr
    this.chromeXml = [];
    this.elementsXml = [];
    this.hyperlinksByUrl = new Map();
    this.imagesByMediaIndex = new Map();
    this.nextRelSeq = 2; // rId1 is reserved for slideLayout1.xml
    this.notesParagraphs = [];

    if (meta.notes) {
      this.setNotes(meta.notes);
    }

    if (!meta.isHero) {
      this.buildStandardHeader();
    }
  }

  setNotes(notesInput) {
    this.notesParagraphs = [];
    this.appendNotes(notesInput);
    return this;
  }

  appendNotes(notesInput) {
    const items = Array.isArray(notesInput)
      ? notesInput
      : String(notesInput ?? "").split(/\r?\n/);
    for (const rawItem of items) {
      if (rawItem === null || rawItem === undefined) continue;
      if (typeof rawItem === "object") {
        const text = sanitizeXmlChars(stripMarkdownFormatting(rawItem.text || "")).trim();
        const heading = sanitizeXmlChars(stripMarkdownFormatting(rawItem.heading || "")).trim();
        if (!text && !heading) continue;
        this.notesParagraphs.push({
          heading,
          text,
          bullet: Boolean(rawItem.bullet),
        });
        continue;
      }
      const cleaned = sanitizeXmlChars(stripMarkdownFormatting(String(rawItem))).trim();
      if (!cleaned) continue;
      const bulletMatch = cleaned.match(/^(?:[-•*])\s+(.+)$/);
      const bodyLine = bulletMatch ? bulletMatch[1].trim() : cleaned;
      const labelMatch = bodyLine.match(/^([A-Z][A-Z0-9 /&()'–—-]{2,48}:)\s*(.*)$/);
      if (labelMatch) {
        this.notesParagraphs.push({
          heading: labelMatch[1],
          text: labelMatch[2].trim(),
          bullet: Boolean(bulletMatch),
        });
      } else {
        this.notesParagraphs.push({
          heading: "",
          text: bodyLine,
          bullet: Boolean(bulletMatch),
        });
      }
    }
    return this;
  }

  hasNotes() {
    return this.notesParagraphs.length > 0;
  }

  allocateShapeId() {
    const id = this.nextShapeId;
    this.nextShapeId += 1;
    return id;
  }

  registerHyperlink(url) {
    const clean = String(url || "").trim();
    if (!isExternalHttpUrl(clean)) return null;
    if (this.hyperlinksByUrl.has(clean)) return this.hyperlinksByUrl.get(clean);
    const rId = `rId${this.nextRelSeq++}`;
    this.hyperlinksByUrl.set(clean, rId);
    return rId;
  }

  registerImage(mediaEntry) {
    if (!mediaEntry) return null;
    if (this.imagesByMediaIndex.has(mediaEntry.index)) {
      return this.imagesByMediaIndex.get(mediaEntry.index).rId;
    }
    const rId = `rId${this.nextRelSeq++}`;
    this.imagesByMediaIndex.set(mediaEntry.index, { rId, mediaEntry });
    return rId;
  }

  buildStandardHeader() {
    // Top branding accent bar
    this.chromeXml.push(
      this.renderShapeXml({
        name: "Brand Bar",
        x: 0,
        y: 0,
        cx: SLIDE_CX,
        cy: 68580,
        fillHex: this.deck.primaryHex,
        paragraphs: [{ text: "", sizePt: 4 }],
      })
    );
    if (this.deck.secondaryHex) {
      this.chromeXml.push(
        this.renderShapeXml({
          name: "Brand Bar Secondary",
          x: 0,
          y: 68580,
          cx: SLIDE_CX,
          cy: 27432,
          fillHex: this.deck.secondaryHex,
          paragraphs: [{ text: "", sizePt: 2 }],
        })
      );
    }

    if (this.meta.kicker) {
      this.chromeXml.push(
        this.renderShapeXml({
          name: "Slide Kicker",
          x: 640080,
          y: 205740,
          cx: 9600000,
          cy: 274320,
          paragraphs: [
            {
              text: String(this.meta.kicker).toUpperCase(),
              sizePt: 10,
              bold: true,
              colorHex: this.deck.primaryHex,
              font: FONT_HEADING,
            },
          ],
          insets: { l: 0, t: 0, r: 0, b: 0 },
        })
      );
    }

    if (this.meta.badge) {
      this.chromeXml.push(
        this.renderShapeXml({
          name: "Slide Badge",
          x: SLIDE_CX - 2560000,
          y: 192000,
          cx: 1920000,
          cy: 300000,
          geom: "roundRect",
          fillHex: this.deck.primaryTintHex,
          borderHex: this.deck.primaryBorderHex,
          align: "ctr",
          anchor: "ctr",
          paragraphs: [
            {
              text: truncateText(this.meta.badge, 28),
              sizePt: 9.5,
              bold: true,
              colorHex: this.deck.primaryDarkHex,
              align: "ctr",
            },
          ],
          insets: { l: 68580, t: 22860, r: 68580, b: 22860 },
        })
      );
    }

    if (this.meta.title) {
      this.chromeXml.push(
        this.renderShapeXml({
          name: "Slide Title",
          x: 640080,
          y: 468000,
          cx: SLIDE_CX - 1280160,
          cy: 560000,
          paragraphs: [
            {
              text: truncateText(this.meta.title, 115),
              sizePt: 21,
              bold: true,
              colorHex: COLORS.ink,
              font: FONT_HEADING,
            },
          ],
          insets: { l: 0, t: 0, r: 0, b: 0 },
        })
      );
    }

    // Subtle divider below header
    this.chromeXml.push(
      this.renderShapeXml({
        name: "Header Divider",
        x: 640080,
        y: 1060000,
        cx: SLIDE_CX - 1280160,
        cy: 12700,
        fillHex: COLORS.borderLight,
        paragraphs: [{ text: "", sizePt: 2 }],
      })
    );
  }

  finalizeChrome(slideNumber, totalSlides) {
    const brandingText = this.deck.footerText || this.deck.organizationName || "";
    const contextText = truncateText(this.meta.footerContext || this.deck.title, 76);
    const footerLeft = truncateText(
      [brandingText, contextText]
        .filter((part, idx, arr) => part && arr.indexOf(part) === idx)
        .join("  ·  "),
      115,
    );
    this.chromeXml.push(
      this.renderShapeXml({
        name: "Footer Context",
        x: 640080,
        y: SLIDE_CY - 365760,
        cx: 8800000,
        cy: 250000,
        paragraphs: [
          {
            text: footerLeft,
            sizePt: 9,
            colorHex: COLORS.muted,
          },
        ],
        insets: { l: 0, t: 0, r: 0, b: 0 },
      })
    );
    this.chromeXml.push(
      this.renderShapeXml({
        name: "Slide Counter",
        x: SLIDE_CX - 2400000,
        y: SLIDE_CY - 365760,
        cx: 1760000,
        cy: 250000,
        paragraphs: [
          {
            text: `Slide ${slideNumber} of ${totalSlides}`,
            sizePt: 9,
            colorHex: COLORS.muted,
            align: "r",
          },
        ],
        insets: { l: 0, t: 0, r: 0, b: 0 },
      })
    );
  }

  renderRunXml(runSpec) {
    const text = sanitizeXmlChars(runSpec.text ?? "");
    if (!text) return "";
    const sz = Math.round((Number(runSpec.sizePt) || 13) * 100);
    const font = runSpec.font || FONT_BODY;
    const boldAttr = runSpec.bold || (this.deck.brandFont && font === FONT_HEADING) ? ` b="1"` : "";
    const italicAttr = runSpec.italic ? ` i="1"` : "";
    const underlineAttr = runSpec.underline || runSpec.url ? ` u="sng"` : "";
    const colorHex = normalizeHexColor(
      runSpec.colorHex || (runSpec.url ? this.deck.primaryHex : COLORS.body)
    );
    const hlinkId = runSpec.url ? this.registerHyperlink(runSpec.url) : null;
    const hlinkXml = hlinkId
      ? `<a:hlinkClick r:id="${hlinkId}" tooltip="${xmlEscape(runSpec.url)}"/>`
      : "";

    // Strict ECMA-376 CT_TextCharacterProperties child element order:
    // solidFill -> latin -> ea -> cs -> hlinkClick
    return `<a:r>
            <a:rPr lang="en-US" sz="${sz}"${boldAttr}${italicAttr}${underlineAttr} dirty="0">
              <a:solidFill><a:srgbClr val="${colorHex}"/></a:solidFill>
              <a:latin typeface="${xmlEscape(font)}"/>
              <a:ea typeface="${xmlEscape(font)}"/>
              <a:cs typeface="${xmlEscape(font)}"/>
              ${hlinkXml}
            </a:rPr>
            <a:t>${xmlEscape(text)}</a:t>
          </a:r>`;
  }

  renderParagraphXml(pSpec) {
    const baseSizePt = Number(pSpec.sizePt) || 13;
    const baseColor = pSpec.colorHex || COLORS.body;
    const baseFont = pSpec.font || FONT_BODY;
    const align = pSpec.align || "l";
    const spaceBeforePt = Number(pSpec.spaceBeforePt) || 0;
    const spaceAfterPt = pSpec.spaceAfterPt !== undefined ? Number(pSpec.spaceAfterPt) : 4;
    const lineSpacingPct = Number(pSpec.lineSpacingPct) || 118000;

    let marLAttr = "";
    let indentAttr = "";
    let bulletXml = `<a:buNone/>`;
    if (pSpec.bulletChar) {
      marLAttr = ` marL="251460"`;
      indentAttr = ` indent="-251460"`;
      const buColor = normalizeHexColor(pSpec.bulletColorHex || this.deck.primaryHex);
      bulletXml = `<a:buClr><a:srgbClr val="${buColor}"/></a:buClr>
            <a:buFont typeface="${FONT_BODY}"/>
            <a:buChar char="${xmlEscape(pSpec.bulletChar)}"/>`;
    }

    // Strict CT_TextParagraphProperties child element order:
    // lnSpc -> spcBef -> spcAft -> buClr -> buFont -> buNone/buChar
    const pPrXml = `<a:pPr${marLAttr}${indentAttr} algn="${align}">
            <a:lnSpc><a:spcPct val="${lineSpacingPct}"/></a:lnSpc>
            ${spaceBeforePt > 0 ? `<a:spcBef><a:spcPts val="${Math.round(spaceBeforePt * 100)}"/></a:spcBef>` : ""}
            ${spaceAfterPt > 0 ? `<a:spcAft><a:spcPts val="${Math.round(spaceAfterPt * 100)}"/></a:spcAft>` : ""}
            ${bulletXml}
          </a:pPr>`;

    let runs = [];
    if (Array.isArray(pSpec.runs) && pSpec.runs.length > 0) {
      runs = pSpec.runs.map((r) =>
        this.renderRunXml({
          sizePt: baseSizePt,
          colorHex: baseColor,
          font: baseFont,
          bold: Boolean(pSpec.bold),
          italic: Boolean(pSpec.italic),
          ...r,
        })
      );
    } else if (pSpec.markdown !== undefined) {
      const prefixRuns = pSpec.prefix
        ? [
            this.renderRunXml({
              text: pSpec.prefix,
              sizePt: baseSizePt,
              bold: true,
              colorHex: pSpec.prefixColorHex || this.deck.primaryHex,
              font: FONT_HEADING,
            }),
          ]
        : [];
      const inlineTokens = parseInlineTokens(pSpec.markdown);
      runs = [
        ...prefixRuns,
        ...inlineTokens.map((tok) => {
          if (tok.type === "bold") {
            return this.renderRunXml({
              text: tok.text,
              sizePt: baseSizePt,
              bold: true,
              colorHex: COLORS.ink,
              font: FONT_HEADING,
            });
          }
          if (tok.type === "italic") {
            return this.renderRunXml({
              text: tok.text,
              sizePt: baseSizePt,
              italic: true,
              colorHex: baseColor,
              font: baseFont,
            });
          }
          if (tok.type === "code") {
            return this.renderRunXml({
              text: tok.text,
              sizePt: Math.max(9.5, baseSizePt - 0.5),
              bold: true,
              colorHex: this.deck.primaryDarkHex,
              font: FONT_CODE,
            });
          }
          if (tok.type === "link") {
            return this.renderRunXml({
              text: tok.text,
              url: isExternalHttpUrl(tok.url) ? tok.url : undefined,
              sizePt: baseSizePt,
              colorHex: isExternalHttpUrl(tok.url) ? this.deck.primaryHex : baseColor,
              underline: isExternalHttpUrl(tok.url),
              font: baseFont,
            });
          }
          return this.renderRunXml({
            text: tok.text,
            sizePt: baseSizePt,
            bold: Boolean(pSpec.bold),
            italic: Boolean(pSpec.italic),
            colorHex: baseColor,
            font: baseFont,
          });
        }),
      ];
    } else if (pSpec.text) {
      runs = [
        this.renderRunXml({
          text: pSpec.text,
          url: pSpec.url,
          sizePt: baseSizePt,
          bold: Boolean(pSpec.bold),
          italic: Boolean(pSpec.italic),
          colorHex: baseColor,
          font: baseFont,
        }),
      ];
    }

    const joinedRuns = runs.filter(Boolean).join("\n          ");
    const endSz = Math.round(baseSizePt * 100);
    return `<a:p>
          ${pPrXml}
          ${joinedRuns}
          <a:endParaRPr lang="en-US" sz="${endSz}" dirty="0"/>
        </a:p>`;
  }

  renderShapeXml(spec) {
    const id = this.allocateShapeId();
    const x = Math.max(0, Math.round(spec.x || 0));
    const y = Math.max(0, Math.round(spec.y || 0));
    const cx = Math.max(12700, Math.round(spec.cx || 914400));
    const cy = Math.max(12700, Math.round(spec.cy || 457200));
    const geom = spec.geom || "rect";
    const avLst = geom === "roundRect" ? `<a:avLst><a:gd name="adj" fmla="val 6500"/></a:avLst>` : `<a:avLst/>`;
    const fillXml = spec.fillHex
      ? `<a:solidFill><a:srgbClr val="${normalizeHexColor(spec.fillHex)}"/></a:solidFill>`
      : `<a:noFill/>`;
    const borderXml = spec.borderHex
      ? `<a:ln w="${Math.round(spec.borderWidthEmu || 12700)}"><a:solidFill><a:srgbClr val="${normalizeHexColor(spec.borderHex)}"/></a:solidFill></a:ln>`
      : `<a:ln><a:noFill/></a:ln>`;
    const insets = {
      l: spec.insets?.l ?? 182880,
      t: spec.insets?.t ?? 137160,
      r: spec.insets?.r ?? 182880,
      b: spec.insets?.b ?? 137160,
    };
    const anchor = spec.anchor || "t";
    const paragraphs = (spec.paragraphs?.length ? spec.paragraphs : [{ text: "", sizePt: 10 }])
      .map((p) => this.renderParagraphXml(p))
      .join("\n        ");

    return `<p:sp>
      <p:nvSpPr>
        <p:cNvPr id="${id}" name="${xmlEscape(spec.name || `Shape ${id}`)}"/>
        <p:cNvSpPr txBox="1"/>
        <p:nvPr/>
      </p:nvSpPr>
      <p:spPr>
        <a:xfrm>
          <a:off x="${x}" y="${y}"/>
          <a:ext cx="${cx}" cy="${cy}"/>
        </a:xfrm>
        <a:prstGeom prst="${geom}">${avLst}</a:prstGeom>
        ${fillXml}
        ${borderXml}
      </p:spPr>
      <p:txBody>
        <a:bodyPr wrap="square" lIns="${insets.l}" tIns="${insets.t}" rIns="${insets.r}" bIns="${insets.b}" anchor="${anchor}">
          <a:normAutofit/>
        </a:bodyPr>
        <a:lstStyle/>
        ${paragraphs}
      </p:txBody>
    </p:sp>`;
  }

  addShape(spec) {
    this.elementsXml.push(this.renderShapeXml(spec));
  }

  addCard(spec) {
    const paragraphs = [];
    if (spec.heading) {
      paragraphs.push({
        text: spec.heading,
        sizePt: spec.headingSizePt || 13.5,
        bold: true,
        colorHex: spec.headingColorHex || this.deck.primaryDarkHex,
        font: FONT_HEADING,
        spaceAfterPt: 6,
      });
    }
    if (Array.isArray(spec.paragraphs)) {
      paragraphs.push(...spec.paragraphs);
    }
    this.addShape({
      name: spec.name || spec.heading || "Card",
      x: spec.x,
      y: spec.y,
      cx: spec.cx,
      cy: spec.cy,
      geom: spec.geom || "roundRect",
      fillHex: spec.fillHex || COLORS.cardBg,
      borderHex: spec.borderHex || COLORS.border,
      borderWidthEmu: spec.borderWidthEmu || 12700,
      insets: spec.insets || { l: 205740, t: 160020, r: 205740, b: 160020 },
      anchor: spec.anchor || "t",
      paragraphs,
    });
  }

  addPicture({ media, x, y, maxCx, maxCy, alt, caption }) {
    if (!media) return;
    const rId = this.registerImage(media);
    if (!rId) return;
    const captionReserve = caption ? 280000 : 0;
    const availCy = Math.max(457200, maxCy - captionReserve);
    const ratio = media.widthPx / Math.max(1, media.heightPx);
    let drawCx = maxCx;
    let drawCy = Math.round(drawCx / ratio);
    if (drawCy > availCy) {
      drawCy = availCy;
      drawCx = Math.round(drawCy * ratio);
    }
    const drawX = Math.round(x + (maxCx - drawCx) / 2);
    const drawY = Math.round(y + (availCy - drawCy) / 2);
    const id = this.allocateShapeId();

    this.elementsXml.push(`<p:pic>
      <p:nvPicPr>
        <p:cNvPr id="${id}" name="${xmlEscape(`Picture ${id}`)}" descr="${xmlEscape(alt || "Topic screenshot")}"/>
        <p:cNvPicPr>
          <a:picLocks noChangeAspect="1"/>
        </p:cNvPicPr>
        <p:nvPr/>
      </p:nvPicPr>
      <p:blipFill>
        <a:blip r:embed="${rId}"/>
        <a:stretch><a:fillRect/></a:stretch>
      </p:blipFill>
      <p:spPr>
        <a:xfrm>
          <a:off x="${Math.max(0, drawX)}" y="${Math.max(0, drawY)}"/>
          <a:ext cx="${Math.max(91440, drawCx)}" cy="${Math.max(91440, drawCy)}"/>
        </a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        <a:ln w="12700"><a:solidFill><a:srgbClr val="${COLORS.border}"/></a:solidFill></a:ln>
      </p:spPr>
    </p:pic>`);

    if (caption) {
      this.addShape({
        name: "Image Caption",
        x,
        y: y + availCy + 30000,
        cx: maxCx,
        cy: 240000,
        insets: { l: 45720, t: 0, r: 45720, b: 0 },
        paragraphs: [
          {
            text: truncateText(stripMarkdownFormatting(caption), 140),
            sizePt: 9.5,
            italic: true,
            colorHex: COLORS.muted,
            align: "ctr",
          },
        ],
      });
    }
  }

  addTable({
    x,
    y,
    cx,
    headers,
    rows,
    maxCy = 4600000,
    rowHeight = 400000,
    cellMaxChars = 260,
    colRatios = null,
  }) {
    const colCount = Math.max(
      1,
      headers?.length || 0,
      ...(rows || []).map((r) => r.length)
    );
    const totalCx = Math.round(cx);
    let colWidths;
    if (Array.isArray(colRatios) && colRatios.length === colCount) {
      const ratioSum = colRatios.reduce((acc, n) => acc + (Number(n) || 0), 0) || 1;
      colWidths = colRatios.map((r) => Math.max(457200, Math.floor((totalCx * Number(r)) / ratioSum)));
      const usedExcludingLast = colWidths.slice(0, -1).reduce((a, b) => a + b, 0);
      colWidths[colCount - 1] = Math.max(457200, totalCx - usedExcludingLast);
    } else {
      const evenWidth = Math.floor(totalCx / colCount);
      colWidths = Array.from({ length: colCount }, (_v, idx) =>
        idx === colCount - 1 ? totalCx - evenWidth * (colCount - 1) : evenWidth
      );
    }
    const gridCols = colWidths.map((w) => `<a:gridCol w="${w}"/>`).join("");
    const allRows = [headers || [], ...(rows || [])];
    const totalCy = Math.min(maxCy, allRows.length * rowHeight);
    const id = this.allocateShapeId();

    const rowsXml = allRows
      .map((cells, rIdx) => {
        const isHeader = rIdx === 0;
        const fillHex = isHeader
          ? this.deck.primaryHex
          : rIdx % 2 === 1
            ? COLORS.cardBg
            : COLORS.subtleBg;
        const textColor = isHeader ? COLORS.white : COLORS.body;
        const cellsXml = Array.from({ length: colCount }, (_v, cIdx) => {
          const cellVal = cells[cIdx] ?? "";
          const pXml = this.renderParagraphXml({
            markdown: truncateText(cellVal, cellMaxChars),
            sizePt: isHeader ? 11 : 10.5,
            bold: isHeader,
            colorHex: textColor,
            spaceAfterPt: 2,
          });
          return `<a:tc>
              <a:txBody>
                <a:bodyPr lIns="114300" tIns="68580" rIns="114300" bIns="68580"/>
                <a:lstStyle/>
                ${pXml}
              </a:txBody>
              <a:tcPr anchor="ctr">
                <a:lnL w="9525"><a:solidFill><a:srgbClr val="${COLORS.border}"/></a:solidFill></a:lnL>
                <a:lnR w="9525"><a:solidFill><a:srgbClr val="${COLORS.border}"/></a:solidFill></a:lnR>
                <a:lnT w="9525"><a:solidFill><a:srgbClr val="${COLORS.border}"/></a:solidFill></a:lnT>
                <a:lnB w="9525"><a:solidFill><a:srgbClr val="${COLORS.border}"/></a:solidFill></a:lnB>
                <a:solidFill><a:srgbClr val="${fillHex}"/></a:solidFill>
              </a:tcPr>
            </a:tc>`;
        }).join("\n            ");
        return `<a:tr h="${rowHeight}">
            ${cellsXml}
          </a:tr>`;
      })
      .join("\n          ");

    this.elementsXml.push(`<p:graphicFrame>
      <p:nvGraphicFramePr>
        <p:cNvPr id="${id}" name="${xmlEscape(`Table ${id}`)}"/>
        <p:cNvGraphicFramePr>
          <a:graphicFrameLocks noGrp="1"/>
        </p:cNvGraphicFramePr>
        <p:nvPr/>
      </p:nvGraphicFramePr>
      <p:xfrm>
        <a:off x="${Math.round(x)}" y="${Math.round(y)}"/>
        <a:ext cx="${Math.round(cx)}" cy="${Math.round(totalCy)}"/>
      </p:xfrm>
      <a:graphic>
        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
          <a:tbl>
            <a:tblPr firstRow="1" bandRow="1"/>
            <a:tblGrid>${gridCols}</a:tblGrid>
            ${rowsXml}
          </a:tbl>
        </a:graphicData>
      </a:graphic>
    </p:graphicFrame>`);
  }

  renderXml() {
    const bgHex = normalizeHexColor(this.meta.bgHex || COLORS.canvasBg);
    const bodyShapes = [...this.chromeXml, ...this.elementsXml].join("\n      ");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg>
      <p:bgPr>
        <a:solidFill><a:srgbClr val="${bgHex}"/></a:solidFill>
        <a:effectLst/>
      </p:bgPr>
    </p:bg>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm>
          <a:off x="0" y="0"/>
          <a:ext cx="0" cy="0"/>
          <a:chOff x="0" y="0"/>
          <a:chExt cx="0" cy="0"/>
        </a:xfrm>
      </p:grpSpPr>
      ${bodyShapes}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr>
    <a:masterClrMapping/>
  </p:clrMapOvr>
</p:sld>`;
  }

  renderRelsXml(notesSlideNum = null) {
    const rels = [
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`,
    ];
    for (const [url, rId] of this.hyperlinksByUrl.entries()) {
      rels.push(
        `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEscape(url)}" TargetMode="External"/>`
      );
    }
    for (const { rId, mediaEntry } of this.imagesByMediaIndex.values()) {
      rels.push(
        `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${mediaEntry.fileName}"/>`
      );
    }
    if (notesSlideNum) {
      rels.push(
        `<Relationship Id="rIdNotes${notesSlideNum}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${notesSlideNum}.xml"/>`
      );
    }
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${rels.join("\n  ")}
</Relationships>`;
  }

  renderNotesXml(slideNumber) {
    const paragraphsXml =
      this.notesParagraphs.length > 0
        ? this.notesParagraphs
            .map((p) => {
              const runs = [];
              if (p.bullet) {
                runs.push(
                  `<a:r><a:rPr lang="en-US" sz="1100" b="1" dirty="0"/><a:t>• </a:t></a:r>`
                );
              }
              if (p.heading) {
                const sep = p.text ? " " : "";
                runs.push(
                  `<a:r><a:rPr lang="en-US" sz="1100" b="1" dirty="0"/><a:t>${xmlEscape(
                    `${p.heading}${sep}`
                  )}</a:t></a:r>`
                );
              }
              if (p.text) {
                runs.push(
                  `<a:r><a:rPr lang="en-US" sz="1100" dirty="0"/><a:t>${xmlEscape(
                    p.text
                  )}</a:t></a:r>`
                );
              }
              return `<a:p>
            <a:pPr algn="l" spcAft="400"><a:spcAft><a:spcPts val="400"/></a:spcAft></a:pPr>
            ${runs.join("\n            ")}
          </a:p>`.replace(
                `<a:pPr algn="l" spcAft="400"><a:spcAft><a:spcPts val="400"/></a:spcAft></a:pPr>`,
                `<a:pPr algn="l"><a:spcAft><a:spcPts val="400"/></a:spcAft></a:pPr>`
              );
            })
            .join("\n          ")
        : `<a:p><a:endParaRPr lang="en-US"/></a:p>`;

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm>
          <a:off x="0" y="0"/>
          <a:ext cx="0" cy="0"/>
          <a:chOff x="0" y="0"/>
          <a:chExt cx="0" cy="0"/>
        </a:xfrm>
      </p:grpSpPr>
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="2" name="Slide Image Placeholder 1"/>
          <p:cNvSpPr>
            <a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/>
          </p:cNvSpPr>
          <p:nvPr>
            <p:ph type="sldImg"/>
          </p:nvPr>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm>
            <a:off x="685800" y="685800"/>
            <a:ext cx="5486400" cy="3086100"/>
          </a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        </p:spPr>
      </p:sp>
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="3" name="Notes Placeholder 2"/>
          <p:cNvSpPr>
            <a:spLocks noGrp="1"/>
          </p:cNvSpPr>
          <p:nvPr>
            <p:ph type="body" idx="1"/>
          </p:nvPr>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm>
            <a:off x="685800" y="4000500"/>
            <a:ext cx="5486400" cy="4343400"/>
          </a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        </p:spPr>
        <p:txBody>
          <a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/>
          <a:lstStyle/>
          ${paragraphsXml}
        </p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="4" name="Slide Number Placeholder 3"/>
          <p:cNvSpPr>
            <a:spLocks noGrp="1"/>
          </p:cNvSpPr>
          <p:nvPr>
            <p:ph type="sldNum" sz="quarter" idx="10"/>
          </p:nvPr>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm>
            <a:off x="3884613" y="8685213"/>
            <a:ext cx="2287587" cy="457200"/>
          </a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        </p:spPr>
        <p:txBody>
          <a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="b"/>
          <a:lstStyle/>
          <a:p>
            <a:fld id="{7F8B6D52-4A9E-4B1D-9C1E-2A4F8E3C0010}" type="slidenum">
              <a:rPr lang="en-US" smtClean="0"/>
              <a:t>${slideNumber}</a:t>
            </a:fld>
            <a:endParaRPr lang="en-US"/>
          </a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr>
    <a:masterClrMapping/>
  </p:clrMapOvr>
</p:notes>`;
  }

  renderNotesRelsXml(slideNumber) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="../notesMasters/notesMaster1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide${slideNumber}.xml"/>
</Relationships>`;
  }
}

/**
 * Append a complete, instructor-ready multi-slide training & walkthrough
 * sequence for a topic into a `PptxDeckAssembler`.
 */
function appendStructuredTopicSlides(deck, parsedTopic, topicHints = {}) {
  const { meta } = parsedTopic;
  const training = resolveTopicTrainingDigest(parsedTopic, topicHints);
  const stepBadge = meta.stepLabel || "Lab Topic";
  const footerContext = `${meta.labTitle}${meta.stepLabel ? ` • ${meta.stepLabel}` : ""} — ${meta.topicTitle}`;
  const fullContentCx = SLIDE_CX - 1280160;
  const colCx = Math.floor((fullContentCx - 228600) / 2);
  const rightColX = 640080 + colCx + 228600;

  // 1. Topic Title & Learning Objectives Slide
  const titleSlide = deck.createSlide({
    isHero: true,
    bgHex: COLORS.cardBg,
    footerContext,
  });

  titleSlide.addShape({
    name: "Hero Brand Top Bar",
    x: 0,
    y: 0,
    cx: SLIDE_CX,
    cy: 114300,
    fillHex: deck.primaryHex,
    paragraphs: [{ text: "", sizePt: 4 }],
  });

  const heroSummary =
    training.capabilitySummary ||
    parsedTopic.whatYouAreDoing[0] ||
    training.whyItMatters ||
    "";
  titleSlide.addShape({
    name: "Hero Accent Panel",
    x: 640080,
    y: 280000,
    cx: fullContentCx,
    cy: 2300000,
    geom: "roundRect",
    fillHex: COLORS.canvasBg,
    borderHex: deck.primaryBorderHex,
    insets: { l: 320040, t: 228600, r: 320040, b: 205740 },
    paragraphs: [
      {
        text: meta.labTitle.toUpperCase(),
        sizePt: 10.5,
        bold: true,
        colorHex: deck.primaryHex,
        font: FONT_HEADING,
        spaceAfterPt: 4,
      },
      {
        text: `${stepBadge}  •  ${training.availabilityBadge || "Generally Available"}`,
        sizePt: 12.5,
        bold: true,
        colorHex: deck.primaryDarkHex,
        font: FONT_HEADING,
        spaceAfterPt: 4,
      },
      {
        text: meta.topicTitle,
        sizePt: 26,
        bold: true,
        colorHex: COLORS.ink,
        font: FONT_HEADING,
        spaceAfterPt: 8,
      },
      ...(deck.coverSubtitle
        ? [
            {
              text: truncateText(deck.coverSubtitle, 160),
              sizePt: 12,
              italic: true,
              colorHex: COLORS.muted,
              spaceAfterPt: 6,
            },
          ]
        : []),
      ...(heroSummary
        ? [
            {
              markdown: truncateText(heroSummary, 340),
              sizePt: 12.5,
              colorHex: COLORS.body,
              spaceAfterPt: 4,
            },
          ]
        : []),
    ],
  });

  if (deck.logoMedia) {
    titleSlide.addPicture({
      media: deck.logoMedia,
      x: SLIDE_CX - 2560000,
      y: 380000,
      maxCx: 1600000,
      maxCy: 560000,
      alt: deck.organizationName || "Organization logo",
    });
  }

  titleSlide.addCard({
    name: "Learning Objectives Card",
    heading: "Learning Objectives — What You Will Master",
    x: 640080,
    y: 2720000,
    cx: fullContentCx,
    cy: 2220000,
    fillHex: deck.primaryTintHex,
    borderHex: deck.primaryBorderHex,
    insets: { l: 251460, t: 160020, r: 251460, b: 160020 },
    paragraphs: (training.learningObjectives || []).slice(0, 4).map((obj) => ({
      markdown: truncateText(obj, 240),
      sizePt: 11.5,
      bulletChar: "✓",
      bulletColorHex: deck.primaryHex,
      spaceAfterPt: 5,
    })),
  });

  const metaCards = [
    {
      label: "PRODUCT(S)",
      value: meta.products || training.productLabel || "Microsoft Copilot Studio",
    },
    {
      label: "LEVEL & TIER",
      value: `${meta.levelText || "Hands-On"}${
        training.availabilityBadge ? ` • ${training.availabilityBadge}` : ""
      }`,
    },
    { label: "ESTIMATED TIME", value: meta.estimatedTime || "Self-paced" },
    {
      label: "SCENARIO / AGENT",
      value: meta.agentName || training.domainLabel || meta.moduleText || stepBadge,
    },
  ];
  const cardGap = 182880;
  const singleCardCx = Math.floor(
    (fullContentCx - cardGap * (metaCards.length - 1)) / metaCards.length
  );
  metaCards.forEach((chip, i) => {
    titleSlide.addCard({
      name: `Metadata ${chip.label}`,
      x: 640080 + i * (singleCardCx + cardGap),
      y: 5080000,
      cx: singleCardCx,
      cy: 1080000,
      fillHex: COLORS.cardBg,
      borderHex: COLORS.border,
      insets: { l: 160020, t: 137160, r: 160020, b: 114300 },
      paragraphs: [
        {
          text: chip.label,
          sizePt: 9,
          bold: true,
          colorHex: COLORS.muted,
          font: FONT_HEADING,
          spaceAfterPt: 4,
        },
        {
          text: truncateText(chip.value, 64),
          sizePt: 11.5,
          bold: true,
          colorHex: COLORS.ink,
          font: FONT_HEADING,
        },
      ],
    });
  });

  titleSlide.setNotes([
    `FACILITATOR PACING CUE: Target ${meta.estimatedTime || "~15 min"} total for ${stepBadge} (${meta.topicTitle}). Spend 3–5 minutes on live framing and walkthrough orientation before releasing attendees for hands-on configuration.`,
    `OPENING HOOK (WHY LEARNERS CARE): ${
      training.whyItMatters ||
      heroSummary ||
      `Show how ${meta.topicTitle} moves an enterprise AI solution from prototype behavior to reliable, auditable runtime execution.`
    }`,
    `LIVE FRAMING TALKING POINTS:`,
    `- Anchor ${meta.topicTitle} inside ${meta.agentName || training.domainLabel || "the workshop agent"} on ${meta.products || training.productLabel || "Microsoft Copilot Studio"}.`,
    ...(training.learningObjectives || []).slice(0, 3).map((obj) => `- Outcome checkpoint: ${obj}`),
    `COACHING TIP: Confirm everyone has their browser zoomed to 100%–125% and their target environment selected before advancing to the architecture slide.`,
  ]);

  // 2. Core Concepts: What It Is & How It Works
  const conceptsSlide = deck.createSlide({
    kicker: `${stepBadge} • CORE CONCEPTS & ARCHITECTURE`,
    badge: training.conceptName || meta.estimatedTime || "How It Works",
    title: `${meta.topicTitle} — Core Concepts & How It Works`,
    footerContext,
  });

  const leftMentalModelParas = [];
  if (training.whyItMatters) {
    leftMentalModelParas.push({
      text: "Why This Capability Matters",
      sizePt: 12.5,
      bold: true,
      colorHex: deck.primaryDarkHex,
      font: FONT_HEADING,
      spaceAfterPt: 4,
    });
    leftMentalModelParas.push({
      markdown: truncateText(training.whyItMatters, 520),
      sizePt: 11.5,
      colorHex: COLORS.body,
      spaceAfterPt: 8,
    });
  }
  if (Array.isArray(training.architectureFlow) && training.architectureFlow.length > 0) {
    leftMentalModelParas.push({
      text: "Runtime Execution Lifecycle",
      sizePt: 12,
      bold: true,
      colorHex: deck.primaryDarkHex,
      font: FONT_HEADING,
      spaceBeforePt: 4,
      spaceAfterPt: 4,
    });
    training.architectureFlow.slice(0, 4).forEach((stage, idx) => {
      leftMentalModelParas.push({
        prefix: `${idx + 1}. `,
        prefixColorHex: deck.primaryHex,
        markdown: truncateText(stage, 210),
        sizePt: 10.5,
        colorHex: COLORS.body,
        spaceAfterPt: 4,
      });
    });
  }

  conceptsSlide.addCard({
    name: "Mental Model Card",
    x: 640080,
    y: 1220000,
    cx: colCx,
    cy: 4980000,
    fillHex: COLORS.cardBg,
    borderHex: COLORS.border,
    paragraphs:
      leftMentalModelParas.length > 0
        ? leftMentalModelParas
        : [{ text: meta.topicTitle, sizePt: 13, colorHex: COLORS.body }],
  });

  const primaryCoreConcepts = (training.coreConcepts || []).slice(0, 4);
  const rightConceptParas = [];
  if (primaryCoreConcepts.length > 0) {
    for (const c of primaryCoreConcepts) {
      rightConceptParas.push({
        markdown: truncateText(c, 340),
        sizePt: 11.5,
        bulletChar: "•",
        bulletColorHex: deck.primaryHex,
        spaceAfterPt: 7,
      });
    }
  } else {
    rightConceptParas.push({
      markdown: `Configure **${meta.topicTitle}** in **${meta.products || training.productLabel || "your lab environment"}** and verify runtime behavior before moving to downstream modules.`,
      sizePt: 12,
      bulletChar: "•",
      bulletColorHex: deck.primaryHex,
      spaceAfterPt: 8,
    });
  }
  if (parsedTopic.provenance) {
    rightConceptParas.push({
      markdown: truncateText(parsedTopic.provenance, 220),
      sizePt: 10,
      italic: true,
      colorHex: COLORS.muted,
      spaceBeforePt: 4,
    });
  }

  conceptsSlide.addCard({
    name: "Core Mechanics Card",
    heading: "Core Mechanics & Platform Concepts",
    x: rightColX,
    y: 1220000,
    cx: colCx,
    cy: 4980000,
    fillHex: deck.primaryTintHex,
    borderHex: deck.primaryBorderHex,
    paragraphs: rightConceptParas,
  });

  conceptsSlide.setNotes([
    `PACING & TEACHING GOAL: Spend ~2 minutes building the mental model for ${meta.topicTitle} before attendees start clicking in the portal.`,
    `ARCHITECTURE WALKTHROUGH:`,
    ...(Array.isArray(training.architectureFlow) && training.architectureFlow.length > 0
      ? training.architectureFlow.slice(0, 4).map((stage, idx) => `- Stage ${idx + 1}: ${stage}`)
      : [
          `- Trace how user input enters ${meta.products || training.productLabel || "the agent"}, invokes ${meta.topicTitle}, and returns a grounded response.`,
        ]),
    `KEY CONCEPTS TO EMPHASIZE:`,
    ...primaryCoreConcepts.slice(0, 3).map((c) => `- ${c}`),
    `COACHING CALLOUT: Pause for 15 seconds and ask if any attendee uses a different term for this capability in another Microsoft AI surface before moving on.`,
  ]);

  // 2b. Microsoft Learn Deep-Dive Takeaways & Additional Concepts Slide(s)
  const deepDiveEntries = [];
  for (const extraConcept of (training.coreConcepts || []).slice(4)) {
    deepDiveEntries.push({ kind: "concept", markdown: extraConcept });
  }
  for (const takeaway of training.learnTakeaways || []) {
    if (!takeaway?.summary) continue;
    deepDiveEntries.push({
      kind: "learn",
      title: takeaway.title || "Microsoft Learn",
      summary: takeaway.summary,
      url: takeaway.url || null,
    });
  }
  if (parsedTopic.fromTheDocs && deepDiveEntries.length === 0) {
    deepDiveEntries.push({
      kind: "quote",
      markdown: parsedTopic.fromTheDocs,
    });
  }

  if (deepDiveEntries.length > 0) {
    const deepDiveChunks = chunkItems(deepDiveEntries, 4);
    deepDiveChunks.forEach((chunk, dIdx) => {
      const showHeadingsStrip =
        dIdx === 0 && Array.isArray(training.docHeadings) && training.docHeadings.length > 0;
      const learnSlide = deck.createSlide({
        kicker: `${stepBadge} • MICROSOFT LEARN INSIGHTS & KEY CONCEPTS`,
        badge:
          deepDiveChunks.length > 1
            ? `Insights (${dIdx + 1}/${deepDiveChunks.length})`
            : "Microsoft Learn",
        title: `${meta.topicTitle} — Essential Topic Takeaways`,
        footerContext,
      });

      learnSlide.addCard({
        name: "Learn Takeaways Card",
        heading: "Important Facts & Guidance from Official Documentation",
        x: 640080,
        y: 1220000,
        cx: fullContentCx,
        cy: showHeadingsStrip ? 4040000 : 4980000,
        fillHex: COLORS.cardBg,
        borderHex: COLORS.border,
        paragraphs: chunk.map((entry) => {
          if (entry.kind === "learn") {
            const linkSuffix = entry.url ? ` ([Learn](${entry.url}))` : "";
            return {
              markdown: `**${truncateText(entry.title, 88)}:** ${truncateText(entry.summary, 400)}${linkSuffix}`,
              sizePt: 11.5,
              bulletChar: "•",
              bulletColorHex: deck.primaryHex,
              spaceAfterPt: 8,
            };
          }
          return {
            markdown: truncateText(entry.markdown, 420),
            sizePt: 11.5,
            bulletChar: "•",
            bulletColorHex: deck.primaryHex,
            spaceAfterPt: 8,
          };
        }),
      });

      if (showHeadingsStrip) {
        learnSlide.addCard({
          name: "Documentation Topics Strip",
          x: 640080,
          y: 5380000,
          cx: fullContentCx,
          cy: 820000,
          fillHex: COLORS.subtleBg,
          borderHex: COLORS.border,
          insets: { l: 182880, t: 102870, r: 182880, b: 91440 },
          paragraphs: [
            {
              markdown: `**Key Documentation Sections:** ${training.docHeadings
                .slice(0, 6)
                .map((h) => truncateText(h, 48))
                .join("  •  ")}`,
              sizePt: 10.5,
              colorHex: COLORS.muted,
            },
          ],
        });
      }

      learnSlide.setNotes([
        `MICROSOFT LEARN DEEP-DIVE CUE: Highlight 1–2 official documentation facts rather than reading every bullet verbatim.`,
        ...chunk.map((entry) =>
          entry.kind === "learn"
            ? `- ${entry.title}: ${entry.summary}${entry.url ? ` (Source: ${entry.url})` : ""}`
            : `- Key takeaway: ${entry.markdown}`
        ),
        `FACILITATOR TIP: Remind attendees that portal blade names evolve across release waves; the linked Microsoft Learn articles remain the authoritative source post-workshop.`,
      ]);
    });
  }

  // 3. Design Best Practices, Use Cases & Scenario Application
  const hasPracticesOrScenario =
    Boolean(training.whenToUse) ||
    (training.bestPractices && training.bestPractices.length > 0) ||
    Boolean(training.inYourScenario) ||
    Boolean(parsedTopic.sharepointSite) ||
    (training.surfaceComparisons?.notes?.length || 0) > 0;

  if (hasPracticesOrScenario) {
    const practiceSlide = deck.createSlide({
      kicker: `${stepBadge} • BEST PRACTICES & SCENARIO DESIGN`,
      badge: "Design Guidance",
      title: `${meta.topicTitle} — When to Use It & Design Best Practices`,
      footerContext,
    });

    const leftPracticeParas = [];
    if (training.whenToUse) {
      leftPracticeParas.push({
        text: "When to Use This Capability",
        sizePt: 12.5,
        bold: true,
        colorHex: deck.primaryDarkHex,
        font: FONT_HEADING,
        spaceAfterPt: 4,
      });
      leftPracticeParas.push({
        markdown: truncateText(training.whenToUse, 360),
        sizePt: 11.5,
        colorHex: COLORS.body,
        spaceAfterPt: 8,
      });
    }
    const bestPracticeList = (training.bestPractices || []).slice(0, 4);
    if (bestPracticeList.length > 0) {
      leftPracticeParas.push({
        text: "Implementation Best Practices",
        sizePt: 12,
        bold: true,
        colorHex: deck.primaryDarkHex,
        font: FONT_HEADING,
        spaceBeforePt: 2,
        spaceAfterPt: 4,
      });
      for (const bp of bestPracticeList) {
        leftPracticeParas.push({
          markdown: truncateText(bp, 320),
          sizePt: 11,
          bulletChar: "•",
          bulletColorHex: deck.primaryHex,
          spaceAfterPt: 6,
        });
      }
    }

    practiceSlide.addCard({
      name: "Best Practices Card",
      x: 640080,
      y: 1220000,
      cx: colCx,
      cy: 4980000,
      fillHex: COLORS.cardBg,
      borderHex: COLORS.border,
      paragraphs:
        leftPracticeParas.length > 0
          ? leftPracticeParas
          : [
              {
                markdown: `Use **${meta.topicTitle}** when building modular, enterprise-ready agent workflows with explicit validation checkpoints.`,
                sizePt: 12,
                colorHex: COLORS.body,
              },
            ],
    });

    const rightScenarioParas = [];
    const scenarioBody =
      training.inYourScenario ||
      `Apply **${meta.topicTitle}** directly in **${
        meta.agentName || training.domainLabel || "your lab scenario"
      }** so learners experience realistic prompts, enterprise data boundaries, and end-to-end verification.`;
    rightScenarioParas.push({
      text: "In Your Lab Scenario",
      sizePt: 12.5,
      bold: true,
      colorHex: deck.primaryDarkHex,
      font: FONT_HEADING,
      spaceAfterPt: 4,
    });
    rightScenarioParas.push({
      markdown: truncateText(scenarioBody, 420),
      sizePt: 11.5,
      colorHex: COLORS.body,
      spaceAfterPt: 8,
    });

    if (parsedTopic.sharepointSite) {
      rightScenarioParas.push({
        text: "Target SharePoint Site",
        sizePt: 12,
        bold: true,
        colorHex: deck.primaryDarkHex,
        font: FONT_HEADING,
        spaceBeforePt: 4,
        spaceAfterPt: 3,
      });
      rightScenarioParas.push({
        markdown: truncateText(parsedTopic.sharepointSite, 340),
        sizePt: 11,
        colorHex: COLORS.body,
        spaceAfterPt: 8,
      });
    }

    const surfaceNotes = (training.surfaceComparisons?.notes || []).slice(0, 2);
    if (surfaceNotes.length > 0) {
      rightScenarioParas.push({
        text: "Platform & Surface Notes",
        sizePt: 12,
        bold: true,
        colorHex: deck.primaryDarkHex,
        font: FONT_HEADING,
        spaceBeforePt: 4,
        spaceAfterPt: 4,
      });
      for (const note of surfaceNotes) {
        rightScenarioParas.push({
          markdown: truncateText(note, 280),
          sizePt: 10.5,
          bulletChar: "•",
          bulletColorHex: deck.primaryHex,
          spaceAfterPt: 5,
        });
      }
    }

    practiceSlide.addCard({
      name: "Scenario Application Card",
      x: rightColX,
      y: 1220000,
      cx: colCx,
      cy: 4980000,
      fillHex: deck.primaryTintHex,
      borderHex: deck.primaryBorderHex,
      paragraphs: rightScenarioParas,
    });

    practiceSlide.setNotes([
      `DESIGN COACHING CUE: Connect recommended design patterns directly to ${meta.agentName || training.domainLabel || "the customer scenario"}.`,
      ...(training.whenToUse ? [`WHEN TO USE IT: ${training.whenToUse}`] : []),
      `BEST-PRACTICE TALKING POINTS:`,
      ...bestPracticeList.map((bp) => `- ${bp}`),
      ...(parsedTopic.sharepointSite
        ? [
            `SHAREPOINT GROUNDING REMINDER: Verify attendees use ${parsedTopic.sharepointSite} and confirm signed-in test accounts have at least Read access so delegated ACL trimming returns citations.`,
          ]
        : []),
    ]);
  }

  // 3b. Cross-Harness Surface Comparison Table Slide (when applicable)
  const surfaceRows = training.surfaceComparisons?.rows || [];
  if (surfaceRows.length >= 2) {
    const surfaceSlide = deck.createSlide({
      kicker: `${stepBadge} • SURFACE & HARNESS COMPARISON`,
      badge: "Cross-Platform",
      title: `${meta.topicTitle} — ${truncateText(
        training.surfaceComparisons.conceptTitle || "Across Microsoft AI Surfaces",
        58
      )}`,
      footerContext,
    });
    surfaceSlide.addTable({
      x: 640080,
      y: 1260000,
      cx: fullContentCx,
      headers: ["Surface / Harness", "Terminology & Support", "How It Works & Key Limits"],
      rows: surfaceRows.slice(0, 5),
      colRatios: [0.22, 0.28, 0.5],
      cellMaxChars: 260,
    });
    surfaceSlide.setNotes([
      `CROSS-HARNESS COACHING CUE: Attendees with M365 Copilot, Copilot Studio, or Microsoft Foundry backgrounds often map the same concept to different UI labels.`,
      ...surfaceRows
        .slice(0, 4)
        .map((row) => `- ${row[0]}: ${row[1]} — ${row[2]}`),
      `PACING TIP: Spend 60 seconds clarifying which column applies to today's lab harness so learners do not hunt for settings from another portal.`,
    ]);
  }

  // 4. Governance, Admin Prerequisites, Licensing & Guardrails Slide(s)
  const govRows = training.governanceRows || [];
  const guardrails = training.guardrails || [];
  if (govRows.length > 0 || guardrails.length > 0) {
    const govSlide = deck.createSlide({
      kicker: `${stepBadge} • GOVERNANCE, LICENSING & GUARDRAILS`,
      badge: training.availabilityBadge || "Governance",
      title: `${meta.topicTitle} — Admin Prerequisites, DLP & Guardrails`,
      footerContext,
    });

    if (govRows.length > 0) {
      govSlide.addTable({
        x: 640080,
        y: 1200000,
        cx: fullContentCx,
        maxCy: 2800000,
        rowHeight: 420000,
        colRatios: [0.22, 0.28, 0.5],
        cellMaxChars: 240,
        headers: [
          "Governance Area",
          "Required Role / Connector / Policy",
          "Admin Center & Implementation Guidance",
        ],
        rows: govRows.slice(0, 4),
      });

      const guardrailParas = [];
      if (training.availabilityGuidance) {
        guardrailParas.push({
          markdown: `**Availability (${training.availabilityBadge || "GA"}):** ${truncateText(
            training.availabilityGuidance,
            280
          )}`,
          sizePt: 10.5,
          colorHex: COLORS.body,
          spaceAfterPt: 4,
        });
      }
      for (const g of guardrails.slice(0, 3)) {
        guardrailParas.push({
          markdown: truncateText(g, 300),
          sizePt: 10.5,
          bulletChar: "⚠",
          bulletColorHex: COLORS.warnAccent,
          spaceAfterPt: 4,
        });
      }
      if (guardrailParas.length > 0) {
        govSlide.addCard({
          name: "Guardrails Card",
          heading: "Production Guardrails, Quotas & Availability",
          headingColorHex: COLORS.warnAccent,
          x: 640080,
          y: 4160000,
          cx: fullContentCx,
          cy: 2040000,
          fillHex: COLORS.warnBg,
          borderHex: COLORS.warnBorder,
          insets: { l: 182880, t: 114300, r: 182880, b: 114300 },
          paragraphs: guardrailParas,
        });
      }

      if (govRows.length > 4) {
        const extraGovChunks = chunkItems(govRows.slice(4), 5);
        extraGovChunks.forEach((gChunk, gIdx) => {
          const extraGovSlide = deck.createSlide({
            kicker: `${stepBadge} • GOVERNANCE & PREREQUISITES (CONTINUED)`,
            badge: `Admin (${gIdx + 2})`,
            title: `${meta.topicTitle} — Additional Admin & DLP Controls`,
            footerContext,
          });
          extraGovSlide.addTable({
            x: 640080,
            y: 1260000,
            cx: fullContentCx,
            colRatios: [0.22, 0.28, 0.5],
            cellMaxChars: 240,
            headers: [
              "Governance Area",
              "Required Role / Connector / Policy",
              "Admin Center & Implementation Guidance",
            ],
            rows: gChunk,
          });
          extraGovSlide.setNotes([
            `ADDITIONAL GOVERNANCE TALKING POINTS: Walk enterprise architects and admins through these supplemental tenant controls.`,
            ...gChunk.map((r) => `- ${r[0]} (${r[1]}): ${r[2]}`),
            `RESCUE TIP: If a learner's tenant blocks a connector via DLP during class, pair them with your pre-provisioned backup maker account or inspect the pre-built reference agent.`,
          ]);
        });
      }
    } else {
      const guardrailOnlyParas = [];
      if (training.availabilityGuidance) {
        guardrailOnlyParas.push({
          markdown: `**Availability (${training.availabilityBadge || "GA"}):** ${truncateText(
            training.availabilityGuidance,
            320
          )}`,
          sizePt: 11.5,
          colorHex: COLORS.body,
          spaceAfterPt: 8,
        });
      }
      for (const g of guardrails.slice(0, 5)) {
        guardrailOnlyParas.push({
          markdown: truncateText(g, 340),
          sizePt: 11.5,
          bulletChar: "⚠",
          bulletColorHex: COLORS.warnAccent,
          spaceAfterPt: 7,
        });
      }
      govSlide.addCard({
        name: "Guardrails Card",
        heading: "Production Guardrails, Quotas & Availability",
        headingColorHex: COLORS.warnAccent,
        x: 640080,
        y: 1220000,
        cx: fullContentCx,
        cy: 4980000,
        fillHex: COLORS.warnBg,
        borderHex: COLORS.warnBorder,
        paragraphs: guardrailOnlyParas,
      });
    }

    govSlide.setNotes([
      `GOVERNANCE & ADMIN PRE-FLIGHT CUE: Emphasize that most enterprise rollout blockers happen here—DLP connector classification, Managed Environment / ACP toggles, and maker RBAC—not in the prompt text.`,
      ...(training.availabilityGuidance
        ? [`RELEASE TIER (${training.availabilityBadge || "GA"}): ${training.availabilityGuidance}`]
        : []),
      ...govRows.slice(0, 3).map((r) => `- ${r[0]} (${r[1]}): ${r[2]}`),
      ...guardrails.slice(0, 2).map((g) => `- Guardrail callout: ${g}`),
      `FAST RESCUE STEP: If an attendee sees a connector blocked by DLP or greyed-out preview toggle, confirm they selected the designated workshop sandbox environment rather than the tenant Default environment.`,
    ]);
  }

  // 5. Configuration Reference Tables & Copy-Ready Prompt / Payload Assets
  if (parsedTopic.tables.length > 0) {
    for (const tbl of parsedTopic.tables) {
      const rowChunks = chunkItems(tbl.rows, 6);
      (rowChunks.length ? rowChunks : [[]]).forEach((rChunk, rIdx) => {
        const tblSlide = deck.createSlide({
          kicker: `${stepBadge} • CONFIGURATION TABLE`,
          badge: rowChunks.length > 1 ? `Table (${rIdx + 1}/${rowChunks.length})` : "Reference",
          title: `${meta.topicTitle} — ${truncateText(tbl.title, 70)}`,
          footerContext,
        });
        tblSlide.addTable({
          x: 640080,
          y: 1260000,
          cx: fullContentCx,
          headers: tbl.headers,
          rows: rChunk,
          cellMaxChars: 260,
        });
        tblSlide.setNotes([
          `CONFIGURATION REFERENCE CUE: Keep this slide projected while learners fill in configuration fields for ${meta.topicTitle}.`,
          ...rChunk
            .slice(0, 4)
            .map((row) => `- ${row.filter(Boolean).join(" -> ")}`),
          `COACHING TIP: Direct attendees to copy exact field values from the module's sample-files/ starter sheet so typos in variable or schema names do not break downstream steps.`,
        ]);
      });
    }
  } else if (
    Array.isArray(training.synthesizedConfigRows) &&
    training.synthesizedConfigRows.length >= 3
  ) {
    const refTblSlide = deck.createSlide({
      kicker: `${stepBadge} • CONFIGURATION QUICK-REFERENCE`,
      badge: "Reference",
      title: `${meta.topicTitle} — Configuration Summary`,
      footerContext,
    });
    refTblSlide.addTable({
      x: 640080,
      y: 1260000,
      cx: fullContentCx,
      headers: ["Configuration Aspect", "Target / Scope", "Guidance & Expected State"],
      rows: training.synthesizedConfigRows.slice(0, 6),
      colRatios: [0.24, 0.28, 0.48],
      cellMaxChars: 240,
    });
    refTblSlide.setNotes([
      `CONFIGURATION SUMMARY CUE: Walk through the target scope and expected state before starting the click-by-click steps.`,
      ...training.synthesizedConfigRows
        .slice(0, 4)
        .map((row) => `- ${row[0]} (${row[1]}): ${row[2]}`),
      `PACING TIP: Leave this summary visible on a secondary screen or remind learners it is in their per-topic handout.`,
    ]);
  }

  for (const snippet of parsedTopic.codeSnippets) {
    const codeLines = snippet.code.split("\n");
    const lineChunks = chunkItems(codeLines, 13);
    lineChunks.forEach((linesPart, lIdx) => {
      const codeSlide = deck.createSlide({
        kicker: `${stepBadge} • COPY-READY PROMPT & INPUT`,
        badge: snippet.language || "Prompt",
        title: `${meta.topicTitle} — ${truncateText(snippet.label, 68)}${
          lineChunks.length > 1 ? ` (${lIdx + 1}/${lineChunks.length})` : ""
        }`,
        footerContext,
      });
      codeSlide.addCard({
        name: "Code Card",
        x: 640080,
        y: 1260000,
        cx: fullContentCx,
        cy: 4900000,
        fillHex: COLORS.codeBg,
        borderHex: COLORS.codeBorder,
        paragraphs: linesPart.map((line) => ({
          text: line.length ? truncateText(line, 118) : " ",
          sizePt: 11,
          colorHex: COLORS.codeText,
          font: FONT_CODE,
          spaceAfterPt: 2,
          lineSpacingPct: 112000,
        })),
      });
      codeSlide.setNotes([
        `COPY-READY ASSET CUE (${snippet.label}): Do NOT have attendees re-type this block from the projector.`,
        `- Instruct attendees to copy this ${snippet.language || "prompt/payload"} block directly from their lab handout or the module sample-files/ folder.`,
        `- Point out any placeholder tokens, URLs, or variable names that must match their tenant environment.`,
        `RESCUE TIP: Paste the snippet into workshop chat (Teams / Zoom) right now so any learner on a split screen can copy it in one click.`,
      ]);
    });
  }

  // 6. Paginated Hands-On Lab Walkthrough Slides (`Do this`)
  const resolvedImages = parsedTopic.images
    .map((img) => ({
      ...img,
      media: deck.resolveTopicImage(img.src),
    }))
    .filter((img) => img.media !== null);

  const avgStepLen =
    parsedTopic.steps.length > 0
      ? parsedTopic.steps.reduce((acc, s) => acc + String(s.text || "").length, 0) /
        parsedTopic.steps.length
      : 0;
  const maxStepsPerSlide = resolvedImages.length > 0 || avgStepLen > 170 ? 4 : 5;
  const stepChunks = chunkItems(parsedTopic.steps, maxStepsPerSlide);
  const expectedOutcomes =
    parsedTopic.expectedResults.length > 0
      ? parsedTopic.expectedResults
      : training.expectedResults || [];

  if (stepChunks.length > 0) {
    stepChunks.forEach((chunk, chunkIdx) => {
      const pairedImage = resolvedImages[chunkIdx] || (chunkIdx === 0 ? resolvedImages[0] : null);
      const hasVisual = Boolean(pairedImage);
      const pageSuffix =
        stepChunks.length > 1 ? ` (${chunkIdx + 1} of ${stepChunks.length})` : "";

      const walkSlide = deck.createSlide({
        kicker: `${stepBadge} • HANDS-ON WALKTHROUGH${pageSuffix}`,
        badge: `Steps ${chunk[0].number}–${chunk[chunk.length - 1].number}`,
        title: `${meta.topicTitle}${pageSuffix}`,
        footerContext,
      });

      const stepCardCx = hasVisual ? Math.floor(fullContentCx * 0.56) : fullContentCx;
      const isLastWalkSlide = chunkIdx === stepChunks.length - 1;
      const showExpectedInline =
        isLastWalkSlide && expectedOutcomes.length > 0 && !hasVisual;
      const stepCardCy = showExpectedInline ? 3780000 : 4980000;

      walkSlide.addCard({
        name: "Walkthrough Steps",
        heading: "Step-by-Step Instructions",
        x: 640080,
        y: 1220000,
        cx: stepCardCx,
        cy: stepCardCy,
        paragraphs: chunk.map((step) => ({
          prefix: `${step.number}. `,
          prefixColorHex: deck.primaryHex,
          markdown: truncateText(step.text, hasVisual ? 320 : 440),
          sizePt: hasVisual ? 11.5 : 12,
          spaceAfterPt: 8,
        })),
      });

      if (hasVisual) {
        const imgX = 640080 + stepCardCx + 205740;
        const imgCx = SLIDE_CX - 640080 - imgX;
        const imgCy =
          isLastWalkSlide && expectedOutcomes.length > 0 ? 3500000 : 4980000;
        walkSlide.addPicture({
          media: pairedImage.media,
          x: imgX,
          y: 1220000,
          maxCx: imgCx,
          maxCy: imgCy,
          alt: pairedImage.alt,
          caption: pairedImage.caption || pairedImage.alt,
        });
        if (isLastWalkSlide && expectedOutcomes.length > 0) {
          walkSlide.addCard({
            name: "Expected Result Card",
            heading: "What You Should See",
            x: imgX,
            y: 4840000,
            cx: imgCx,
            cy: 1360000,
            fillHex: COLORS.successBg,
            borderHex: COLORS.successBorder,
            headingColorHex: COLORS.successAccent,
            insets: { l: 160020, t: 114300, r: 160020, b: 114300 },
            paragraphs: expectedOutcomes.slice(0, 2).map((er) => ({
              markdown: truncateText(er, 220),
              sizePt: 10.5,
              colorHex: COLORS.body,
              spaceAfterPt: 4,
            })),
          });
        }
      } else if (showExpectedInline) {
        walkSlide.addCard({
          name: "Expected Result Card",
          heading: "What You Should See",
          x: 640080,
          y: 5140000,
          cx: fullContentCx,
          cy: 1060000,
          fillHex: COLORS.successBg,
          borderHex: COLORS.successBorder,
          headingColorHex: COLORS.successAccent,
          insets: { l: 182880, t: 114300, r: 182880, b: 114300 },
          paragraphs: expectedOutcomes.slice(0, 2).map((er) => ({
            markdown: truncateText(er, 320),
            sizePt: 11,
            colorHex: COLORS.body,
            spaceAfterPt: 4,
          })),
        });
      }

      walkSlide.setNotes([
        `LIVE DEMO & HANDS-ON PACING (Steps ${chunk[0].number}–${chunk[chunk.length - 1].number}): ${
          chunkIdx === 0
            ? "Demonstrate the navigation path on screen for 2–3 minutes at 125% browser zoom, then have learners execute Steps " +
              `${chunk[0].number}–${chunk[chunk.length - 1].number} in their own environment.`
            : "Coach learners through these steps while circulating or monitoring chat for thumbs-up completion signals."
        }`,
        `STEP-BY-STEP COACHING CUES:`,
        ...chunk.map((step) => `- Step ${step.number}: ${truncateText(step.text, 220)}`),
        ...(isLastWalkSlide && expectedOutcomes.length > 0
          ? [`EXPECTED SCREEN RESULT: ${expectedOutcomes[0]}`]
          : []),
        `PACING CHECKPOINT: Ask for a quick reaction/thumbs-up once Step ${chunk[chunk.length - 1].number} is saved before advancing.`,
      ]);
    });
  }

  // Extra screenshots beyond step chunks get dedicated visual slides
  if (resolvedImages.length > Math.max(1, stepChunks.length)) {
    for (let imgIdx = Math.max(1, stepChunks.length); imgIdx < resolvedImages.length; imgIdx += 1) {
      const img = resolvedImages[imgIdx];
      const figSlide = deck.createSlide({
        kicker: `${stepBadge} • VISUAL REFERENCE`,
        badge: `Figure ${imgIdx + 1}`,
        title: `${meta.topicTitle} — Visual Reference`,
        footerContext,
      });
      figSlide.addPicture({
        media: img.media,
        x: 914400,
        y: 1240000,
        maxCx: SLIDE_CX - 1828800,
        maxCy: 4920000,
        alt: img.alt,
        caption: img.caption || img.alt,
      });
      figSlide.setNotes([
        `VISUAL LANDMARK CALLOUT (Figure ${imgIdx + 1}): Point out the highlighted portal controls in "${img.caption || img.alt}".`,
        `COACHING TIP: Help attendees orient by left-navigation rail and top command bar rather than pixel position, as responsive window widths shift panel layouts.`,
      ]);
    }
  }

  // 7. Common Pitfalls, Troubleshooting & Validation Checklist Slide(s)
  const checkSource =
    training.checkItems && training.checkItems.length > 0
      ? training.checkItems
      : parsedTopic.checkYourWork;
  const troubleSource =
    training.troubleshootingItems && training.troubleshootingItems.length > 0
      ? training.troubleshootingItems
      : parsedTopic.troubleshooting;

  if (checkSource.length > 0 || troubleSource.length > 0) {
    const checkChunks = chunkItems(checkSource, 4);
    const troubleChunks = chunkItems(troubleSource, 4);
    const totalValSlides = Math.max(1, checkChunks.length, troubleChunks.length);

    for (let vIdx = 0; vIdx < totalValSlides; vIdx += 1) {
      const checks =
        checkChunks[vIdx] || (vIdx === 0 ? [] : checkChunks[checkChunks.length - 1] || []);
      const troubles =
        troubleChunks[vIdx] ||
        (vIdx === 0 ? [] : troubleChunks[troubleChunks.length - 1] || []);
      const valSlide = deck.createSlide({
        kicker: `${stepBadge} • VERIFICATION & TROUBLESHOOTING`,
        badge: totalValSlides > 1 ? `Part ${vIdx + 1}/${totalValSlides}` : "Validation",
        title: `${meta.topicTitle} — Check Your Work & Troubleshooting`,
        footerContext,
      });

      const hasBoth = checks.length > 0 && troubles.length > 0;
      if (hasBoth) {
        valSlide.addCard({
          name: "Check Your Work Card",
          heading: "Check Your Work",
          headingColorHex: COLORS.successAccent,
          x: 640080,
          y: 1220000,
          cx: colCx,
          cy: 4980000,
          fillHex: COLORS.successBg,
          borderHex: COLORS.successBorder,
          paragraphs: checks.map((item) => ({
            markdown: truncateText(item.text, 340),
            sizePt: 11.5,
            bulletChar: item.checked ? "☑" : "☐",
            bulletColorHex: COLORS.successAccent,
            spaceAfterPt: 8,
          })),
        });
        valSlide.addCard({
          name: "Troubleshooting Card",
          heading: "Troubleshooting & Common Pitfalls",
          headingColorHex: COLORS.warnAccent,
          x: rightColX,
          y: 1220000,
          cx: colCx,
          cy: 4980000,
          fillHex: COLORS.warnBg,
          borderHex: COLORS.warnBorder,
          paragraphs: troubles.map((item) => ({
            markdown: truncateText(item, 360),
            sizePt: 11,
            bulletChar: "•",
            bulletColorHex: COLORS.warnAccent,
            spaceAfterPt: 8,
          })),
        });
      } else if (checks.length > 0) {
        valSlide.addCard({
          name: "Check Your Work Card",
          heading: "Check Your Work",
          headingColorHex: COLORS.successAccent,
          x: 640080,
          y: 1220000,
          cx: fullContentCx,
          cy: 4980000,
          fillHex: COLORS.successBg,
          borderHex: COLORS.successBorder,
          paragraphs: checks.map((item) => ({
            markdown: truncateText(item.text, 400),
            sizePt: 12,
            bulletChar: item.checked ? "☑" : "☐",
            bulletColorHex: COLORS.successAccent,
            spaceAfterPt: 8,
          })),
        });
      } else {
        valSlide.addCard({
          name: "Troubleshooting Card",
          heading: "Troubleshooting & Common Pitfalls",
          headingColorHex: COLORS.warnAccent,
          x: 640080,
          y: 1220000,
          cx: fullContentCx,
          cy: 4980000,
          fillHex: COLORS.warnBg,
          borderHex: COLORS.warnBorder,
          paragraphs: troubles.map((item) => ({
            markdown: truncateText(item, 400),
            sizePt: 12,
            bulletChar: "•",
            bulletColorHex: COLORS.warnAccent,
            spaceAfterPt: 8,
          })),
        });
      }

      const fallbackRefUrl =
        (parsedTopic.references && parsedTopic.references[0]?.url) ||
        (training.references && training.references[0]?.url) ||
        "https://learn.microsoft.com/en-us/microsoft-copilot-studio/";
      valSlide.setNotes([
        `VALIDATION & FAST RESCUE PLAYBOOK: Confirm at least 85% of attendees pass these checks before moving past ${stepBadge}.`,
        ...checks.map((item) => `- Verification check: ${item.text}`),
        `FAST ATTENDEE RESCUE STEPS (DO NOT DERAIL CLASS PACING):`,
        ...(troubles.length > 0
          ? troubles.map((t) => `- Rescue cue: ${t}`)
          : [
              `- If a learner's test pane still shows stale behavior, have them click Save, wait 10 seconds for indexing/orchestration sync, and click Refresh in the Test pane.`,
            ]),
        `DEBRIEF DISCUSSION PROMPT: Ask the room: "Which guardrail or verification check in ${meta.topicTitle} would your security or operations team require before production rollout?"`,
        ...(parsedTopic.knowledgeChecks.length === 0 && vIdx === totalValSlides - 1
          ? [
              `OPTIONAL LIVE KNOWLEDGE CHECK (ANSWER KEY & RATIONALE):`,
              `- Question: Why do we validate ${meta.topicTitle} in the test harness before layering downstream modules?`,
              `- Correct Answer: A — Isolating and verifying ${meta.topicTitle} now confirms authentication, connector permissions, and grounding citations work before downstream tools depend on them.`,
              `- Rationale: ${
                training.whyItMatters ||
                `Verifying ${meta.topicTitle} in isolation prevents cascading troubleshooting across multi-step agent flows.`
              } (Microsoft Learn: ${fallbackRefUrl})`,
            ]
          : []),
      ]);
    }
  }

  // 8. Knowledge Check Slide(s) (when mini-quiz content is present)
  // Keep the answer key & rationale strictly in Presenter View speaker notes so
  // projecting the slide never spoils the quiz for learners!
  if (parsedTopic.knowledgeChecks.length > 0) {
    parsedTopic.knowledgeChecks.forEach((quiz, qIdx) => {
      const qSlide = deck.createSlide({
        kicker: `${stepBadge} • KNOWLEDGE CHECK (${qIdx + 1} OF ${parsedTopic.knowledgeChecks.length})`,
        badge: `Question ${quiz.number}`,
        title: `${meta.topicTitle} — Knowledge Check`,
        footerContext,
      });

      const sanitizedSlideOptions = quiz.options.map((opt) =>
        String(opt || "").replace(/\s*\(\s*Correct\s*\)\s*$/i, "").trim()
      );

      qSlide.addCard({
        name: `Question ${quiz.number} Prompt`,
        heading: `Question ${quiz.number}`,
        headingColorHex: COLORS.quizAccent,
        x: 640080,
        y: 1220000,
        cx: fullContentCx,
        cy: 3420000,
        fillHex: COLORS.cardBg,
        borderHex: COLORS.border,
        paragraphs: [
          {
            markdown: truncateText(quiz.prompt, 280),
            sizePt: 13.5,
            bold: true,
            colorHex: COLORS.ink,
            spaceAfterPt: 10,
          },
          ...sanitizedSlideOptions.map((opt) => ({
            markdown: truncateText(opt, 220),
            sizePt: 12,
            colorHex: COLORS.body,
            spaceAfterPt: 6,
          })),
        ],
      });

      const pollRefs =
        quiz.learnLinks && quiz.learnLinks.length > 0
          ? quiz.learnLinks.slice(0, 2)
          : (training.references || []).slice(0, 1);
      const pollParas = [
        {
          markdown:
            "Select the single best option (**A–D**) for your lab scenario. Be ready to explain how your choice behaves at runtime before the instructor debriefs the answer.",
          sizePt: 11.5,
          colorHex: COLORS.body,
          spaceAfterPt: pollRefs.length > 0 ? 6 : 2,
        },
      ];
      for (const ref of pollRefs) {
        if (!ref?.url) continue;
        pollParas.push({
          runs: [
            {
              text: "Microsoft Learn Reference: ",
              bold: true,
              sizePt: 10.5,
              colorHex: COLORS.quizAccent,
            },
            {
              text: truncateText(ref.title || ref.url, 110),
              url: ref.url,
              sizePt: 10.5,
              colorHex: deck.primaryHex,
            },
          ],
          spaceAfterPt: 3,
        });
      }

      qSlide.addCard({
        name: `Question ${quiz.number} Poll Prompt`,
        heading: "Think, Vote & Discuss",
        headingColorHex: COLORS.quizAccent,
        x: 640080,
        y: 4780000,
        cx: fullContentCx,
        cy: 1420000,
        fillHex: COLORS.quizBg,
        borderHex: COLORS.quizBorder,
        insets: { l: 182880, t: 114300, r: 182880, b: 114300 },
        paragraphs: pollParas,
      });

      const correctLetter = (quiz.correctLetter || "A").toUpperCase();
      const matchedCorrectOpt = sanitizedSlideOptions.find((opt) =>
        new RegExp(`^${correctLetter}[.)]\\s+`, "i").test(opt)
      );
      const distractorNotes = sanitizedSlideOptions
        .filter((opt) => !new RegExp(`^${correctLetter}[.)]\\s+`, "i").test(opt))
        .map(
          (opt) =>
            `- Distractor (${opt}): Explain why this choice either bypasses ${meta.topicTitle} governance/grounding or describes an anti-pattern.`
        );
      const primaryLearnRef =
        (quiz.learnLinks && quiz.learnLinks[0]?.url) ||
        (training.references && training.references[0]?.url) ||
        "https://learn.microsoft.com/en-us/microsoft-copilot-studio/";

      qSlide.setNotes([
        `INSTRUCTOR ANSWER KEY — DO NOT REVEAL ON SCREEN BEFORE CLASS POLL:`,
        `CORRECT ANSWER: ${matchedCorrectOpt || correctLetter}`,
        `WHY ${correctLetter} IS CORRECT (RATIONALE): ${
          quiz.explanation ||
          training.whyItMatters ||
          `${correctLetter} reflects the documented Microsoft architecture and runtime behavior for ${meta.topicTitle}.`
        }`,
        ...distractorNotes,
        `MICROSOFT LEARN SOURCE: ${primaryLearnRef}`,
        `FACILITATOR DELIVERY CUE: Give learners 30–45 seconds to vote in chat or by show of hands, ask one volunteer why they picked ${correctLetter}, then debrief any common distractor.`,
      ]);
    });
  }

  // 9. Microsoft Learn Deep-Dive References Slide(s)
  const combinedRefs = [];
  const seenRefUrls = new Set();
  for (const r of [...(parsedTopic.references || []), ...(training.references || [])]) {
    if (!r?.url || seenRefUrls.has(r.url)) continue;
    seenRefUrls.add(r.url);
    combinedRefs.push(r);
  }

  if (combinedRefs.length > 0) {
    const takeawayByUrl = new Map(
      (training.learnTakeaways || [])
        .filter((t) => t?.url && t?.summary)
        .map((t) => [t.url, t.summary])
    );
    const refChunks = chunkItems(combinedRefs, 4);
    refChunks.forEach((rChunk, rIdx) => {
      const refSlide = deck.createSlide({
        kicker: `${stepBadge} • DOCUMENTATION & GROUNDING`,
        badge: refChunks.length > 1 ? `Links (${rIdx + 1}/${refChunks.length})` : "Microsoft Learn",
        title: `${meta.topicTitle} — Microsoft Learn References`,
        footerContext,
      });

      const refParas = [];
      for (const ref of rChunk) {
        refParas.push({
          bulletChar: "•",
          bulletColorHex: deck.primaryHex,
          runs: [
            {
              text: `${ref.category || "Microsoft Learn"}: `,
              bold: true,
              sizePt: 12,
              colorHex: COLORS.ink,
              font: FONT_HEADING,
            },
            {
              text: truncateText(ref.title || ref.url, 120),
              url: ref.url,
              sizePt: 12,
              colorHex: deck.primaryHex,
            },
          ],
          spaceAfterPt: 2,
        });
        const takeawayLine = takeawayByUrl.get(ref.url);
        if (takeawayLine) {
          refParas.push({
            text: truncateText(takeawayLine, 180),
            sizePt: 10.5,
            colorHex: COLORS.body,
            spaceAfterPt: 2,
          });
        }
        refParas.push({
          runs: [
            {
              text: `    ${truncateText(ref.url, 115)}`,
              url: ref.url,
              sizePt: 9.5,
              colorHex: COLORS.muted,
            },
          ],
          spaceAfterPt: 8,
        });
      }

      refSlide.addCard({
        name: "References Card",
        heading: "Official Documentation & Study Links",
        x: 640080,
        y: 1220000,
        cx: fullContentCx,
        cy: 4980000,
        paragraphs: refParas,
      });

      refSlide.setNotes([
        `MODULE WRAP-UP & TRANSITION CUE: Summarize what learners accomplished in ${stepBadge} (${meta.topicTitle}) and point them to these official Microsoft Learn links for deeper post-workshop study.`,
        ...rChunk.map((ref) => `- ${ref.title || "Reference"}: ${ref.url}`),
        `TRANSITION BRIDGE: Confirm everyone saved their work in the portal before transitioning to the next module.`,
      ]);
    });
  }
}

/**
 * Append paginated slides for generic Markdown sections (lab overview, admin
 * prerequisites, end-of-lab validation, or custom Markdown documents).
 */
function appendGenericMarkdownSlides(deck, markdown, options = {}) {
  const expanded = expandArchitectureBlocks(markdown);
  const lines = expanded.replace(/\r\n/g, "\n").split("\n");
  const docTitle = options.title || deck.title || "Lab Overview";
  const kickerPrefix = options.kickerPrefix || "HANDS-ON LAB";

  if (options.includeCover !== false) {
    const cover = deck.createSlide({
      isHero: true,
      bgHex: COLORS.cardBg,
      footerContext: docTitle,
    });
    cover.addShape({
      name: "Cover Top Bar",
      x: 0,
      y: 0,
      cx: SLIDE_CX,
      cy: 114300,
      fillHex: deck.primaryHex,
      paragraphs: [{ text: "", sizePt: 4 }],
    });
    cover.addShape({
      name: "Cover Hero Box",
      x: 640080,
      y: 680000,
      cx: SLIDE_CX - 1280160,
      cy: 5100000,
      geom: "roundRect",
      fillHex: COLORS.canvasBg,
      borderHex: deck.primaryBorderHex,
      insets: { l: 365760, t: 365760, r: 365760, b: 365760 },
      paragraphs: [
        {
          text: (deck.organizationName || "MICROSOFT AI HANDS-ON LAB").toUpperCase(),
          sizePt: 11,
          bold: true,
          colorHex: deck.primaryHex,
          font: FONT_HEADING,
          spaceAfterPt: 10,
        },
        {
          text: docTitle,
          sizePt: 30,
          bold: true,
          colorHex: COLORS.ink,
          font: FONT_HEADING,
          spaceAfterPt: 14,
        },
        ...(options.subtitle
          ? [
              {
                markdown: truncateText(options.subtitle, 280),
                sizePt: 14,
                colorHex: COLORS.body,
                spaceAfterPt: 6,
              },
            ]
          : []),
        ...(deck.coverSubtitle
          ? [
              {
                text: truncateText(deck.coverSubtitle, 160),
                sizePt: 13,
                italic: true,
                colorHex: COLORS.muted,
              },
            ]
          : []),
      ],
    });
    if (deck.logoMedia) {
      cover.addPicture({
        media: deck.logoMedia,
        x: SLIDE_CX - 2560000,
        y: 820000,
        maxCx: 1650000,
        maxCy: 685800,
        alt: deck.organizationName || "Organization logo",
      });
    }
    cover.setNotes([
      `WORKSHOP WELCOME & 15-MINUTE PRE-FLIGHT BUFFER: Welcome attendees to "${docTitle}"${
        options.subtitle ? ` (${options.subtitle})` : ""
      }.`,
      `PRE-FLIGHT CHECKLIST BEFORE STARTING MODULE 1:`,
      `- Confirm every attendee is signed into the designated sandbox tenant/environment in an isolated browser profile.`,
      `- Verify attendees have downloaded the Complete Lab Package or per-module sample-files/ starter pack.`,
      `- Share the Run-of-Show agenda, demo-first then hands-on rhythm, and scheduled break times.`,
    ]);
  }

  // Group content by H2/H3 headings
  const sections = [];
  let current = { title: options.defaultSectionTitle || "Overview", items: [], tables: [], codeBlocks: [], images: [] };

  const cleanDetails = lines
    .join("\n")
    .replace(/<details\b[^>]*>([\s\S]*?)<\/details>/gi, (_w, inner) =>
      inner.replace(/<\/?summary\b[^>]*>/gi, "\n")
    )
    .split("\n");

  for (let i = 0; i < cleanDetails.length; i += 1) {
    const trimmed = cleanDetails[i].trim();
    if (!trimmed || /^---+$/.test(trimmed)) continue;

    const h1 = trimmed.match(/^#\s+(.+)$/);
    if (h1) continue;

    const heading = trimmed.match(/^(#{2,4})\s+(.+)$/);
    if (heading) {
      if (
        current.items.length ||
        current.tables.length ||
        current.codeBlocks.length ||
        current.images.length
      ) {
        sections.push(current);
      }
      current = {
        title: stripMarkdownFormatting(heading[2]),
        items: [],
        tables: [],
        codeBlocks: [],
        images: [],
      };
      continue;
    }

    const fence = trimmed.match(/^(`{3,}|~{3,})([^\s`~]*)/);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2] || "text";
      const buf = [];
      i += 1;
      while (i < cleanDetails.length && !cleanDetails[i].trim().startsWith(marker)) {
        buf.push(cleanDetails[i]);
        i += 1;
      }
      if (buf.join("\n").trim()) {
        current.codeBlocks.push({ lang, code: buf.join("\n") });
      }
      continue;
    }

    if (
      trimmed.startsWith("|") &&
      i + 1 < cleanDetails.length &&
      isTableSeparator(cleanDetails[i + 1])
    ) {
      const headers = splitTableCells(trimmed);
      const rows = [];
      i += 2;
      while (i < cleanDetails.length && cleanDetails[i].trim().startsWith("|")) {
        rows.push(splitTableCells(cleanDetails[i]));
        i += 1;
      }
      i -= 1;
      current.tables.push({ headers, rows });
      continue;
    }

    const img = trimmed.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/);
    if (img) {
      current.images.push({ alt: img[1] || "Illustration", src: img[2] });
      continue;
    }

    if (trimmed.startsWith(">")) {
      current.items.push({
        kind: "callout",
        text: trimmed.replace(/^>\s?/, ""),
      });
      continue;
    }

    const task = trimmed.match(/^[-*+]\s+\[([ xX])\]\s+(.+)$/);
    if (task) {
      current.items.push({
        kind: "task",
        checked: task[1].toLowerCase() === "x",
        text: task[2],
      });
      continue;
    }

    const ordered = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (ordered) {
      current.items.push({
        kind: "ordered",
        number: ordered[1],
        text: ordered[2],
      });
      continue;
    }

    const bullet = trimmed.match(/^[-*+]\s+(.+)$/);
    if (bullet) {
      current.items.push({ kind: "bullet", text: bullet[1] });
      continue;
    }

    current.items.push({ kind: "paragraph", text: trimmed });
  }

  if (
    current.items.length ||
    current.tables.length ||
    current.codeBlocks.length ||
    current.images.length
  ) {
    sections.push(current);
  }

  for (const sec of sections) {
    const itemChunks = chunkItems(sec.items, 5);
    itemChunks.forEach((chunk, idx) => {
      const s = deck.createSlide({
        kicker: kickerPrefix,
        badge: itemChunks.length > 1 ? `${idx + 1}/${itemChunks.length}` : undefined,
        title: sec.title,
        footerContext: docTitle,
      });
      s.addCard({
        x: 640080,
        y: 1220000,
        cx: SLIDE_CX - 1280160,
        cy: 4980000,
        paragraphs: chunk.map((item) => {
          if (item.kind === "ordered") {
            return {
              prefix: `${item.number}. `,
              markdown: truncateText(item.text, 280),
              sizePt: 12.5,
              spaceAfterPt: 8,
            };
          }
          if (item.kind === "task") {
            return {
              markdown: truncateText(item.text, 280),
              bulletChar: item.checked ? "☑" : "☐",
              bulletColorHex: COLORS.successAccent,
              sizePt: 12.5,
              spaceAfterPt: 8,
            };
          }
          if (item.kind === "bullet") {
            return {
              markdown: truncateText(item.text, 280),
              bulletChar: "•",
              bulletColorHex: deck.primaryHex,
              sizePt: 12.5,
              spaceAfterPt: 8,
            };
          }
          return {
            markdown: truncateText(item.text, 320),
            sizePt: 12.5,
            italic: item.kind === "callout",
            spaceAfterPt: 9,
          };
        }),
      });

      const titleLower = String(sec.title || "").toLowerCase();
      const genericCue = /prereq|admin|tenant|connector|license|environment/i.test(titleLower)
        ? `PRE-DELIVERY & ADMIN READINESS CUE: Walk through these prerequisites carefully. Confirm tenant connectors are in the Business DLP group and test accounts have license + environment maker access.`
        : /architect|topology|flow|overview|agenda/i.test(titleLower)
          ? `ARCHITECTURE & AGENDA TALKING POINTS: Trace the end-to-end solution flow on screen so attendees see how each lab module builds toward the complete agent.`
          : /validat|summary|next step|wrap|debrief/i.test(titleLower)
            ? `END-OF-LAB VALIDATION & DEBRIEF CUE: Confirm attendees completed end-to-end testing and invite 1–2 takeaways on how they will apply this pattern in their own organization.`
            : `FACILITATOR TALKING POINTS (${sec.title}): Highlight the key takeaways below in 1–2 minutes before advancing.`;
      s.setNotes([
        genericCue,
        ...chunk.slice(0, 4).map((item) => `- ${truncateText(item.text, 220)}`),
      ]);
    });

    for (const tbl of sec.tables) {
      const rChunks = chunkItems(tbl.rows, 6);
      (rChunks.length ? rChunks : [[]]).forEach((rChunk) => {
        const s = deck.createSlide({
          kicker: `${kickerPrefix} • TABLE`,
          title: sec.title,
          footerContext: docTitle,
        });
        s.addTable({
          x: 640080,
          y: 1260000,
          cx: SLIDE_CX - 1280160,
          headers: tbl.headers,
          rows: rChunk,
        });
        s.setNotes([
          `REFERENCE TABLE WALKTHROUGH (${sec.title}): Call out the top rows that directly impact attendee setup and pacing.`,
          ...rChunk
            .slice(0, 4)
            .map((row) => `- ${row.filter(Boolean).join(" -> ")}`),
        ]);
      });
    }

    for (const cb of sec.codeBlocks) {
      const cChunks = chunkItems(cb.code.split("\n"), 13);
      cChunks.forEach((linesPart) => {
        const s = deck.createSlide({
          kicker: `${kickerPrefix} • CODE / PROMPT`,
          badge: cb.lang,
          title: sec.title,
          footerContext: docTitle,
        });
        s.addCard({
          x: 640080,
          y: 1260000,
          cx: SLIDE_CX - 1280160,
          cy: 4900000,
          fillHex: COLORS.codeBg,
          borderHex: COLORS.codeBorder,
          paragraphs: linesPart.map((line) => ({
            text: line.length ? truncateText(line, 118) : " ",
            sizePt: 11,
            colorHex: COLORS.codeText,
            font: FONT_CODE,
            spaceAfterPt: 2,
          })),
        });
        s.setNotes([
          `CODE / PROMPT WALKTHROUGH (${sec.title}): Have learners copy this snippet from the handout rather than typing manually from the slide.`,
          `COACHING TIP: Point out key parameters or placeholders to customize for their environment.`,
        ]);
      });
    }

    for (const img of sec.images) {
      const media = deck.resolveTopicImage(img.src);
      if (media) {
        const s = deck.createSlide({
          kicker: `${kickerPrefix} • ILLUSTRATION`,
          title: sec.title,
          footerContext: docTitle,
        });
        s.addPicture({
          media,
          x: 914400,
          y: 1240000,
          maxCx: SLIDE_CX - 1828800,
          maxCy: 4920000,
          alt: img.alt,
          caption: img.alt,
        });
        s.setNotes([
          `VISUAL CALLOUT (${sec.title}): Walk attendees through "${img.alt}" and highlight the primary UI landmarks.`,
        ]);
      }
    }
  }
}

/**
 * Closing slide with the brand's "More information" link, support contact, and
 * community link. Added only when the brand defines at least one of them.
 */
function appendBrandInfoSlide(deck, docTitle) {
  const info = deck.brandInfo;
  if (!info?.hasLinks) return;
  const stripBrackets = (value) => String(value || "").replace(/[[\]]/g, "");
  const slide = deck.createSlide({
    kicker: "MORE INFORMATION",
    title: "More information and support",
    footerContext: docTitle,
  });
  const paragraphs = [];
  if (info.moreInfo) {
    paragraphs.push({
      markdown: `**More information:** [${stripBrackets(info.moreInfo.label)}](${info.moreInfo.url})`,
      sizePt: 15,
      spaceAfterPt: 10,
    });
  }
  if (info.support) {
    const who = info.support.name || "your support contact";
    paragraphs.push({
      text: info.support.email ? `Need help? Contact ${who} at ${info.support.email}` : `Need help? Contact ${who}`,
      sizePt: 15,
      colorHex: COLORS.body,
      spaceAfterPt: 10,
    });
  }
  if (info.community) {
    paragraphs.push({
      markdown: `**${info.community.label}:** [${stripBrackets(info.community.url.replace(/^https:\/\//, ""))}](${info.community.url})`,
      sizePt: 15,
      spaceAfterPt: 10,
    });
  }
  slide.addCard({
    name: "Brand Information Card",
    heading: "Where to go next",
    x: 640080,
    y: 1240000,
    cx: SLIDE_CX - 1280160,
    cy: 2600000,
    fillHex: deck.primaryTintHex,
    borderHex: deck.primaryBorderHex,
    insets: { l: 320040, t: 228600, r: 320040, b: 205740 },
    paragraphs,
  });
}

/**
 * Render a standalone per-topic presentation (.pptx) buffer.
 *
 * @param {string} topicMarkdown - Standalone topic Markdown (or module slice)
 * @param {object} [options]
 * @param {string} [options.title]
 * @param {object} [options.topic] - Optional topic metadata hints (`labTitle`, `stepLabel`, `topicTitle`, `levelText`, `estimatedTime`, `products`, `agentName`, `references`)
 * @param {object} [options.branding]
 * @param {(src: string) => Buffer | null} [options.resolveImageBuffer]
 * @returns {Buffer}
 */
export function renderTopicToPptxBuffer(topicMarkdown, options = {}) {
  const hints = options.topic || {};
  const parsed = parseTopicMarkdownStructure(topicMarkdown, hints);
  const deckTitle =
    options.title ||
    (parsed.meta.labTitle && parsed.meta.stepLabel
      ? `${parsed.meta.labTitle} - ${parsed.meta.stepLabel} - ${parsed.meta.topicTitle}`
      : parsed.meta.topicTitle);

  const deck = new PptxDeckAssembler({
    title: deckTitle,
    branding: options.branding,
    resolveImageBuffer: options.resolveImageBuffer,
  });

  appendStructuredTopicSlides(deck, parsed, hints);
  return deck.toPptxBuffer();
}

/**
 * Render Markdown (either a full generated lab `index.md`, a standalone topic
 * module, or an overview/custom Markdown document) to a `.pptx` buffer.
 *
 * @param {string} markdown
 * @param {object} [options]
 * @param {string} [options.title]
 * @param {object} [options.manifest]
 * @param {object} [options.topic]
 * @param {object} [options.branding]
 * @param {(src: string) => Buffer | null} [options.resolveImageBuffer]
 * @returns {Buffer}
 */
export function renderMarkdownToPptxBuffer(markdown, options = {}) {
  const src = stripEmbeddedHtml(String(markdown || ""));
  if (options.topic) {
    return renderTopicToPptxBuffer(src, options);
  }

  // Detect full multi-module generated lab (`## Step-by-Step` + `### Step N` / `### Recap N`)
  const split = splitGeneratedLabModules(src, options.manifest || {});
  if (split.modules.length > 0 && /^##\s+Step-by-Step\b/m.test(src)) {
    const labTitle =
      options.title ||
      split.labTitle ||
      options.manifest?.title ||
      split.overview?.title?.replace(/\s+—\s+Overview and Admin Prerequisites$/, "") ||
      "Hands-On Lab";
    const deck = new PptxDeckAssembler({
      title: labTitle,
      branding: options.branding,
      resolveImageBuffer: options.resolveImageBuffer,
    });

    // Full-lab cover + overview slides from pre-Step-by-Step content
    const stepByStepIdx = src.search(/^##\s+Step-by-Step\b/m);
    const introMd =
      stepByStepIdx > 0 ? src.slice(0, stepByStepIdx) : split.overview?.markdown || "";
    const subtitleParts = [
      options.manifest?.levelName || (options.manifest?.level ? `Level ${options.manifest.level}` : ""),
      options.manifest?.duration || "",
      `${split.modules.length} module${split.modules.length === 1 ? "" : "s"}`,
    ].filter(Boolean);

    appendGenericMarkdownSlides(deck, introMd, {
      title: labTitle,
      subtitle: subtitleParts.join("  •  "),
      includeCover: true,
      kickerPrefix: "LAB OVERVIEW",
    });

    // Append structured slide sequence for every topic in the lab
    const productsText = Array.isArray(options.manifest?.products)
      ? options.manifest.products.join(", ")
      : "";
    const manifestMods = Array.isArray(options.manifest?.modules) ? options.manifest.modules : [];
    for (const mod of split.modules) {
      const mMeta =
        manifestMods.find((m) => Number(m.order) === Number(mod.order)) || mod.moduleInfo || {};
      const modHints = {
        featureId: mMeta.id || mod.id || null,
        labTitle,
        stepLabel: mod.stepLabel,
        topicTitle: mod.title,
        levelText: mMeta.level ? `Level ${mMeta.level}` : "",
        estimatedTime: mMeta.minutes ? `~${mMeta.minutes} min` : "",
        products: productsText,
        agentName: options.manifest?.agentName || options.manifest?.options?.agentName || "",
        harness:
          options.manifest?.request?.harness ||
          options.manifest?.differences?.labHarness ||
          null,
        trainingDigest: mMeta.trainingDigest || null,
        manifest: options.manifest || null,
      };
      const parsedMod = parseTopicMarkdownStructure(mod.markdown, modHints);
      appendStructuredTopicSlides(deck, parsedMod, modHints);
    }

    // Post-module validation / next steps sections if present
    const postMatch = src.match(/\n(##\s+(?:Validation|End-of-Lab Validation|Summary|Next Steps)[\s\S]*)$/i);
    if (postMatch) {
      appendGenericMarkdownSlides(deck, postMatch[1], {
        title: labTitle,
        includeCover: false,
        kickerPrefix: "LAB WRAP-UP",
      });
    }

    appendBrandInfoSlide(deck, labTitle);
    return deck.toPptxBuffer();
  }

  // Check if `markdown` is a standalone topic module (e.g. from `splitGeneratedLabModules`)
  const standaloneHints = {
    labTitle: options.manifest?.title || "",
    topicTitle: options.title || "",
    manifest: options.manifest || null,
  };
  const candidateTopic = parseTopicMarkdownStructure(src, standaloneHints);
  if (candidateTopic.isStructuredTopic && candidateTopic.steps.length > 0) {
    const deck = new PptxDeckAssembler({
      title: options.title || candidateTopic.meta.topicTitle,
      branding: options.branding,
      resolveImageBuffer: options.resolveImageBuffer,
    });
    appendStructuredTopicSlides(deck, candidateTopic, standaloneHints);
    return deck.toPptxBuffer();
  }

  // Generic Markdown fallback (e.g. `00 - Overview and Admin Prerequisites` or custom Markdown)
  const deck = new PptxDeckAssembler({
    title: options.title || candidateTopic.meta.topicTitle || "Presentation",
    branding: options.branding,
    resolveImageBuffer: options.resolveImageBuffer,
  });
  appendGenericTopicOrMarkdown(deck, src, options);
  appendBrandInfoSlide(deck, deck.title);
  return deck.toPptxBuffer();
}

function appendGenericTopicOrMarkdown(deck, src, options) {
  appendGenericMarkdownSlides(deck, src, {
    title: options.title || deck.title,
    includeCover: true,
    kickerPrefix: "OVERVIEW",
  });
}

export const buildPptxFromLabMarkdown = renderMarkdownToPptxBuffer;
export const buildTopicPptxFromMarkdown = renderTopicToPptxBuffer;
