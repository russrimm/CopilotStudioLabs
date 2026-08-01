import sanitizeHtml from "sanitize-html";

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
    allowedTags: [...sanitizeHtml.defaults.allowedTags, "details", "img", "input", "summary"],
    allowedAttributes: {
      "*": ["style"],
      a: ["href", "name", "rel", "target"],
      img: sanitizeHtml.defaults.allowedAttributes.img,
      input: ["checked", "disabled", "type"],
    },
    allowedClasses: {
      code: [/^language-[a-z0-9_-]+$/],
      div: ["mermaid"],
      input: ["task-list-item-checkbox"],
      li: ["task-list-item"],
      ul: ["contains-task-list"],
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
    },
  });
}
