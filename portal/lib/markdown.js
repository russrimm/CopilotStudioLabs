import sanitizeHtml from "sanitize-html";
import { Marked } from "marked";
import {
  ARCHITECTURE_FENCE_LANG,
  renderArchitectureOverviewHtml,
} from "./lab-builder/architecture-overview.js";

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

const labMarked = new Marked();
labMarked.use(labDiagramExtension);

const LAB_ARCH_CLASS_RE = /^lab-arch(?:-[a-z0-9-]+)?$/;
const LAB_ARCH_SVG_CLASS_RE = /^lab-arch(?:-[a-z0-9-]+)?-svg$/;

const SAFE_STYLE_PROPERTIES = {
  "align-items": [/^(?:baseline|center|flex-(?:end|start)|stretch)$/],
  background: [/^rgba?\([\d\s.,%]+\)$/i, /^#[0-9a-f]{3,8}$/i, /^transparent$/i],
  border: [/^(?:0|1px solid #[0-9a-f]{3,8})$/i],
  "border-radius": [/^\d+(?:\.\d+)?(?:px|rem|%)$/],
  color: [/^#[0-9a-f]{3,8}$/i],
  display: [/^(?:block|flex|inline|inline-block|none)$/],
  "flex-wrap": [/^(?:nowrap|wrap)$/],
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
      "details",
      "figcaption",
      "figure",
      "img",
      "input",
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
      "*": ["style", "aria-label", "aria-hidden", "role"],
      a: ["href", "name", "rel", "target"],
      img: sanitizeHtml.defaults.allowedAttributes.img,
      input: ["checked", "disabled", "type"],
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
      code: [/^language-[a-z0-9_-]+$/],
      div: ["mermaid", "lab-branding-banner", "lab-branding-title", "lab-branding-tagline", LAB_ARCH_CLASS_RE],
      figcaption: [LAB_ARCH_CLASS_RE],
      figure: [LAB_ARCH_CLASS_RE],
      input: ["task-list-item-checkbox"],
      li: ["task-list-item", LAB_ARCH_CLASS_RE],
      pre: [LAB_ARCH_CLASS_RE],
      section: [LAB_ARCH_CLASS_RE],
      span: [LAB_ARCH_CLASS_RE],
      strong: [LAB_ARCH_CLASS_RE],
      svg: [LAB_ARCH_SVG_CLASS_RE],
      ul: ["contains-task-list", LAB_ARCH_CLASS_RE],
    },
    exclusiveFilter: (frame) => {
      if (frame.tag === "svg") {
        const cls = String(frame.attribs?.class || "").trim();
        return !LAB_ARCH_SVG_CLASS_RE.test(cls) || frame.attribs?.["aria-hidden"] !== "true";
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
        return {
          tagName,
          attribs: target === "_blank"
            ? { ...safeAttributes, target, rel: "noopener noreferrer" }
            : safeAttributes,
        };
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
  return sanitizeLabHtml(transformHtml(labMarked.parse(String(markdown ?? ""))));
}
