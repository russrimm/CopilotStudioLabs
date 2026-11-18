// Gives the fake DOM an `innerHTML` setter, so the wizard, which renders with template strings, can run against it.
// The parser is small and strict about what the wizard emits (quoted attributes, closed tags, void <input>); it is not
// a general HTML parser. Entities in text and attribute values are decoded the way a browser would.

const VOID = new Set(["input", "br", "img", "hr", "meta", "link"]);
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(text) {
  return String(text).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, name) => {
    if (name[0] === "#") {
      const code = name[1] === "x" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return NAMED[name] ?? whole;
  });
}

const TOKEN = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+|<)/g;
const ATTRIBUTE = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

export function parseHtml(html, document) {
  const root = document.createElement("div");
  const stack = [root];
  let match;
  TOKEN.lastIndex = 0;
  while ((match = TOKEN.exec(String(html)))) {
    const [whole, closing, opening, attributes, selfClosing, text] = match;
    const parent = stack[stack.length - 1];
    if (whole.startsWith("<!--")) continue;
    if (closing) {
      const at = stack.map((el) => el.tagName.toLowerCase()).lastIndexOf(closing.toLowerCase());
      if (at > 0) stack.length = at;
    } else if (opening) {
      const el = document.createElement(opening);
      ATTRIBUTE.lastIndex = 0;
      let attr;
      while ((attr = ATTRIBUTE.exec(attributes || ""))) {
        el.setAttribute(attr[1], decode(attr[2] ?? attr[3] ?? attr[4] ?? ""));
      }
      if (opening.toLowerCase() === "input") el.checked = el.hasAttribute("checked");
      parent.appendChild(el);
      if (!VOID.has(opening.toLowerCase()) && !selfClosing) stack.push(el);
    } else if (text) {
      parent.appendChild(document.createTextNode(decode(text)));
    }
  }
  return [...root.childNodes];
}

/** Add `innerHTML` to every element of a fake DOM created by `createFakeDom()`. */
export function installInnerHtml({ document, FakeElement }) {
  Object.defineProperty(FakeElement.prototype, "innerHTML", {
    configurable: true,
    get() {
      return this._rawHtml ?? "";
    },
    set(value) {
      this._rawHtml = String(value ?? "");
      this.replaceChildren(...parseHtml(this._rawHtml, document));
    },
  });
}
