import sanitizeHtml from "sanitize-html";
import { Marked } from "marked";
import {
  ARCHITECTURE_FENCE_LANG,
  renderArchitectureOverviewHtml,
} from "./lab-builder/architecture-overview.js";
import { enhanceInteractiveLabHtml } from "./lab-builder/interactive-elements.js";
import { BRAND_FONTS } from "./lab-builder/brand-theme.js";
import { normalizeEmbeddedHtml } from "./lab-builder/html-fragments.js";

export const labDiagramExtension = {
  name: "labDiagrams",
  renderer: {
    code({ text, lang }) {
      const normalized = String(lang || "").trim().toLowerCase();
      if (normalized === "mermaid") {
        const escaped = String(text ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;");
        return `<div class="mermaid">${escaped}</div>`;
      }
      if (normalized === ARCHITECTURE_FENCE_LANG) {
        return renderArchitectureOverviewHtml(text);
      }
      return false;
    },
  },
};

// Real HTML element names. A tag outside this list in running text is a placeholder such as
// `<site-name>`, which the sanitizer would silently drop, so it is shown as literal text instead.
const HTML_ELEMENT_NAMES = new Set(
  (
    "a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup " +
    "data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 " +
    "head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript " +
    "object ol optgroup option output p param picture pre progress q rp rt ruby s samp script section select slot small " +
    "source span strong style sub summary sup svg path circle ellipse rect line polyline polygon table tbody td template " +
    "textarea tfoot th thead time title tr track u ul var video wbr"
  ).split(" "),
);

const labPlaceholderExtension = {
  renderer: {
    html({ text, block }) {
      if (block) return false;
      const tag = /^<\/?([a-z][a-z0-9-]*)/i.exec(String(text ?? ""));
      if (!tag || HTML_ELEMENT_NAMES.has(tag[1].toLowerCase())) return false;
      return String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    },
  },
};

const labMarked = new Marked();
labMarked.use(labDiagramExtension);
labMarked.use(labPlaceholderExtension);

const LAB_ARCH_CLASS_RE = /^lab-arch(?:-[a-z0-9-]+)?$/;
const LAB_ARCH_SVG_CLASS_RE = /^lab-arch(?:-[a-z0-9-]+)?-svg$/;

// Brand fonts come from a fixed allowlist; only those exact stacks may appear in inline styles.
const BRAND_FONT_STYLE_PATTERNS = Object.values(BRAND_FONTS)
  .filter((font) => font.css)
  .map((font) => new RegExp(`^${font.css.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"));

const SAFE_STYLE_PROPERTIES = {
  "align-items": [/^(?:baseline|center|flex-(?:end|start)|stretch)$/],
  background: [/^rgba?\([\d\s.,%]+\)$/i, /^#[0-9a-f]{3,8}$/i, /^transparent$/i],
  border: [/^(?:0|1px solid #[0-9a-f]{3,8})$/i],
  "border-bottom": [/^[1-6]px solid #[0-9a-f]{3,8}$/i],
  "border-radius": [/^\d+(?:\.\d+)?(?:px|rem|%)$/],
  color: [/^#[0-9a-f]{3,8}$/i],
  display: [/^(?:block|flex|inline|inline-block|none)$/],
  "flex-wrap": [/^(?:nowrap|wrap)$/],
  "font-family": BRAND_FONT_STYLE_PATTERNS,
  "font-size": [/^\d+(?:\.\d+)?(?:px|rem|em|%)$/],
  "font-weight": [/^(?:[1-9]00|bold|normal)$/],
  gap: [/^\d+(?:\.\d+)?(?:px|rem)$/],
  margin: [/^[\d\s.-]+(?:px|rem|em|%)?(?:\s+[\d.-]+(?:px|rem|em|%)?){0,3}$/],
  "max-height": [/^\d+(?:\.\d+)?(?:px|rem|%)$/],
  "max-width": [/^\d+(?:\.\d+)?(?:px|rem|%)$/],
  padding: [/^[\d\s.-]+(?:px|rem|em|%)?(?:\s+[\d.-]+(?:px|rem|em|%)?){0,3}$/],
  width: [/^(?:auto|\d+(?:\.\d+)?(?:px|rem|%))$/],
};

export function sanitizeLabHtml(html) {
  return sanitizeHtml(String(html ?? ""), {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      "button",
      "details",
      "fieldset",
      "figcaption",
      "figure",
      "img",
      "input",
      "label",
      "legend",
      "section",
      "summary",
      "svg",
      "path",
      "circle",
      "ellipse",
      "rect",
      "line",
      "polyline",
      "polygon",
    ],
    allowedAttributes: {
      "*": ["style", "aria-label", "aria-hidden", "aria-live", "role"],
      a: ["href", "name", "rel", "target"],
      button: ["type", "data-quiz-check-one", "data-quiz-check-all", "data-quiz-reset"],
      div: ["hidden", "data-quiz-explanation"],
      fieldset: ["data-question-index", "data-correct", "data-quiz-state"],
      img: sanitizeHtml.defaults.allowedAttributes.img,
      input: ["checked", "type", "name", "value", "data-task-key", "data-quiz-option"],
      label: ["data-option-letter", "data-option-state"],
      section: ["data-quiz-id"],
      span: ["data-quiz-score", "data-quiz-status"],
      svg: [
        "viewBox",
        "viewbox",
        "fill",
        "stroke",
        "stroke-width",
        "stroke-linecap",
        "stroke-linejoin",
        "width",
        "height",
        "aria-hidden",
      ],
      path: ["d", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin"],
      circle: ["cx", "cy", "r", "fill", "stroke", "stroke-width"],
      ellipse: ["cx", "cy", "rx", "ry", "fill", "stroke", "stroke-width"],
      rect: ["x", "y", "width", "height", "rx", "ry", "fill", "stroke", "stroke-width"],
      line: ["x1", "y1", "x2", "y2", "stroke", "stroke-width", "stroke-linecap"],
      polyline: ["points", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin"],
      polygon: ["points", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin"],
    },
    allowedClasses: {
      button: ["lab-quiz-btn", "lab-quiz-check-one", "lab-quiz-btn-primary", "lab-quiz-btn-reset"],
      code: [/^language-[a-z0-9_-]+$/],
      div: [
        "mermaid",
        "lab-branding-banner",
        "lab-branding-title",
        "lab-branding-tagline",
        "lab-branding-subtitle",
        "lab-quiz-header",
        "lab-quiz-heading-group",
        "lab-quiz-options",
        "lab-quiz-question-actions",
        "lab-quiz-explanation",
        "lab-quiz-footer",
        LAB_ARCH_CLASS_RE,
      ],
      fieldset: ["lab-quiz-question", "is-correct", "is-incorrect"],
      figcaption: [LAB_ARCH_CLASS_RE],
      figure: [LAB_ARCH_CLASS_RE],
      input: ["task-list-item-checkbox", "lab-quiz-radio"],
      label: ["task-list-label", "lab-quiz-option", "is-selected", "is-correct", "is-incorrect"],
      legend: ["lab-quiz-prompt"],
      li: ["task-list-item", LAB_ARCH_CLASS_RE],
      p: [
        "lab-subhead",
        "lab-module-meta",
        "lab-scenario-callout",
        "lab-quiz-title",
        "lab-quiz-intro",
        "lab-quiz-learn-ref",
        LAB_ARCH_CLASS_RE,
      ],
      pre: [LAB_ARCH_CLASS_RE],
      section: ["lab-quiz", LAB_ARCH_CLASS_RE],
      span: [
        "task-list-item-text",
        "lab-quiz-eyebrow",
        "lab-quiz-score",
        "lab-quiz-option-badge",
        "lab-quiz-option-text",
        "lab-quiz-status",
        LAB_ARCH_CLASS_RE,
      ],
      strong: [LAB_ARCH_CLASS_RE],
      svg: [LAB_ARCH_SVG_CLASS_RE],
      ul: ["contains-task-list", LAB_ARCH_CLASS_RE],
    },
    exclusiveFilter: (frame) => {
      if (frame.tag === "svg") {
        const cls = String(frame.attribs?.class || "").trim();
        return !LAB_ARCH_SVG_CLASS_RE.test(cls) || frame.attribs?.["aria-hidden"] !== "true";
      }
      if (frame.tag === "input") {
        const inputType = String(frame.attribs?.type || "").trim().toLowerCase();
        return inputType !== "checkbox" && inputType !== "radio";
      }
      if (frame.tag === "button") {
        const cls = String(frame.attribs?.class || "");
        return !/\blab-quiz-btn\b/.test(cls);
      }
      return false;
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowProtocolRelative: false,
    allowedStyles: {
      "*": SAFE_STYLE_PROPERTIES,
    },
    transformTags: {
      a: (tagName, attribs) => {
        const { target, ...safeAttributes } = attribs;
        // External links, including Microsoft Learn references, open in a new tab so the wizard keeps its state.
        const external = /^https?:\/\//i.test(String(safeAttributes.href || "").trim());
        return {
          tagName,
          attribs: target === "_blank" || external
            ? { ...safeAttributes, target: "_blank", rel: "noopener noreferrer" }
            : safeAttributes,
        };
      },
      button: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, type: "button" },
      }),
      input: (tagName, attribs) => {
        const next = { ...attribs };
        delete next.disabled;
        return { tagName, attribs: next };
      },
      svg: (tagName, attribs) => {
        const next = { ...attribs };
        if (next.viewbox && !next.viewBox) {
          next.viewBox = next.viewbox;
          delete next.viewbox;
        }
        return { tagName, attribs: next };
      },
    },
  });
}

export function renderLabMarkdown(markdown, transformHtml = (html) => html) {
  const rendered = enhanceInteractiveLabHtml(labMarked.parse(normalizeEmbeddedHtml(String(markdown ?? ""))));
  return sanitizeLabHtml(transformHtml(rendered));
}
