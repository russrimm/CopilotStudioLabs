// A small DOM for the Screenshot Center tests: enough elements, events, selectors, focus,
// and <dialog> behavior to drive the real browser scripts inside a node:vm context.
// It parses no HTML. Every node is built with createElement, exactly like the scripts do.

const kebab = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? true;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    Object.assign(this, init);
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {
    this.propagationStopped = true;
  }
}

class FakeText {
  constructor(data) {
    this.nodeType = 3;
    this.data = String(data);
    this.parentNode = null;
  }

  get textContent() {
    return this.data;
  }
}

function splitTop(text, separator) {
  const parts = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === "[") {
      depth += 1;
      current += ch;
    } else if (ch === "]") {
      depth -= 1;
      current += ch;
    } else if (ch === separator && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function splitDescendants(text) {
  const parts = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (const ch of text.trim()) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === "[") {
      depth += 1;
      current += ch;
    } else if (ch === "]") {
      depth -= 1;
      current += ch;
    } else if (/\s/.test(ch) && depth === 0) {
      if (current) parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function parseCompound(token) {
  const out = { tag: "", id: "", classes: [], attrs: [] };
  let rest = token;
  if (rest.startsWith("*")) rest = rest.slice(1);
  const tag = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(rest);
  if (tag) {
    out.tag = tag[0].toLowerCase();
    rest = rest.slice(tag[0].length);
  }
  while (rest) {
    let m;
    if ((m = /^#([\w-]+)/.exec(rest))) out.id = m[1];
    else if ((m = /^\.([\w-]+)/.exec(rest))) out.classes.push(m[1]);
    else if ((m = /^\[([\w-]+)(?:=("[^"]*"|'[^']*'|[^\]]*))?\]/.exec(rest))) out.attrs.push([m[1], m[2] === undefined ? null : m[2].replace(/^["']|["']$/g, "")]);
    else throw new Error(`Unsupported selector: ${token}`);
    rest = rest.slice(m[0].length);
  }
  return out;
}

function matchesCompound(el, compound) {
  if (compound.tag && el.tagName.toLowerCase() !== compound.tag) return false;
  if (compound.id && el.id !== compound.id) return false;
  for (const name of compound.classes) if (!el.classList.contains(name)) return false;
  for (const [name, value] of compound.attrs) {
    if (!el.hasAttribute(name)) return false;
    if (value !== null && el.getAttribute(name) !== value) return false;
  }
  return true;
}

function compileSelector(selector) {
  return splitTop(selector, ",").map((part) => splitDescendants(part).map(parseCompound));
}

function matchesChain(el, chain) {
  if (!matchesCompound(el, chain[chain.length - 1])) return false;
  let node = el.parentNode;
  for (let i = chain.length - 2; i >= 0; i -= 1) {
    while (node && !(node.nodeType === 1 && matchesCompound(node, chain[i]))) node = node.parentNode;
    if (!node) return false;
    node = node.parentNode;
  }
  return true;
}

export function createFakeDom() {
  const doc = {
    nodeType: 9,
    activeElement: null,
    listeners: {},
    createElement: (tag) => new FakeElement(tag, doc),
    createElementNS: (namespace, tag) => Object.assign(new FakeElement(tag, doc), { namespaceURI: namespace }),
    createTextNode: (text) => new FakeText(text),
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
    removeEventListener() {},
    dispatchEvent() {},
    getElementById: (id) => doc.body.querySelectorAll("*").find((el) => el.id === id) || null,
    querySelector: (sel) => doc.body.querySelector(sel),
    querySelectorAll: (sel) => doc.body.querySelectorAll(sel),
  };

  class FakeElement {
    constructor(tag, ownerDocument) {
      this.nodeType = 1;
      this.tagName = String(tag).toUpperCase();
      this.ownerDocument = ownerDocument;
      this.attributes = new Map();
      this.childNodes = [];
      this.parentNode = null;
      this.listeners = {};
      this.style = {};
      this.files = [];
      this.value = "";
      this.checked = false;
      this.selected = false;
      this.focusCount = 0;
      this.scrolled = 0;
      this._dataset = null;
    }

    get id() {
      return this.getAttribute("id") || "";
    }

    set id(value) {
      this.setAttribute("id", value);
    }

    get className() {
      return this.getAttribute("class") || "";
    }

    set className(value) {
      this.setAttribute("class", value);
    }

    get type() {
      return this.getAttribute("type") || (this.tagName === "BUTTON" ? "submit" : "");
    }

    get hidden() {
      return this.hasAttribute("hidden");
    }

    set hidden(value) {
      if (value) this.setAttribute("hidden", "");
      else this.removeAttribute("hidden");
    }

    get disabled() {
      return this.hasAttribute("disabled");
    }

    set disabled(value) {
      if (value) this.setAttribute("disabled", "");
      else this.removeAttribute("disabled");
    }

    get open() {
      return this.hasAttribute("open");
    }

    set open(value) {
      if (value) this.setAttribute("open", "");
      else this.removeAttribute("open");
    }

    get classList() {
      const el = this;
      const read = () => el.className.split(/\s+/).filter(Boolean);
      return {
        add: (...names) => el.setAttribute("class", [...new Set([...read(), ...names])].join(" ")),
        remove: (...names) => el.setAttribute("class", read().filter((n) => !names.includes(n)).join(" ")),
        contains: (name) => read().includes(name),
        toggle(name, force) {
          const has = read().includes(name);
          const want = force === undefined ? !has : Boolean(force);
          if (want && !has) this.add(name);
          if (!want && has) this.remove(name);
          return want;
        },
      };
    }

    get dataset() {
      if (!this._dataset) {
        const el = this;
        this._dataset = new Proxy(
          {},
          {
            get: (_t, prop) => (typeof prop === "string" ? el.attributes.get(`data-${kebab(prop)}`) : undefined),
            set: (_t, prop, value) => {
              el.setAttribute(`data-${kebab(String(prop))}`, value);
              return true;
            },
            has: (_t, prop) => el.attributes.has(`data-${kebab(String(prop))}`),
            deleteProperty: (_t, prop) => {
              el.attributes.delete(`data-${kebab(String(prop))}`);
              return true;
            },
          },
        );
      }
      return this._dataset;
    }

    get children() {
      return this.childNodes.filter((n) => n.nodeType === 1);
    }

    get textContent() {
      return this.childNodes.map((n) => n.textContent).join("");
    }

    set textContent(value) {
      for (const child of this.childNodes) child.parentNode = null;
      this.childNodes = [];
      if (value !== "" && value !== null && value !== undefined) this.appendChild(new FakeText(value));
    }

    get isConnected() {
      let node = this;
      while (node.parentNode) node = node.parentNode;
      return node === doc.body;
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }

    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    removeAttribute(name) {
      this.attributes.delete(name);
    }

    hasAttribute(name) {
      return this.attributes.has(name);
    }

    appendChild(node) {
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = this;
      this.childNodes.push(node);
      return node;
    }

    insertBefore(node, ref) {
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = this;
      const at = ref ? this.childNodes.indexOf(ref) : -1;
      if (at < 0) this.childNodes.push(node);
      else this.childNodes.splice(at, 0, node);
      return node;
    }

    removeChild(node) {
      const at = this.childNodes.indexOf(node);
      if (at >= 0) this.childNodes.splice(at, 1);
      node.parentNode = null;
      return node;
    }

    replaceChildren(...nodes) {
      for (const child of this.childNodes) child.parentNode = null;
      this.childNodes = [];
      for (const node of nodes) this.appendChild(typeof node === "string" ? new FakeText(node) : node);
    }

    replaceWith(...nodes) {
      const parent = this.parentNode;
      if (!parent) return;
      const at = parent.childNodes.indexOf(this);
      parent.childNodes.splice(at, 1, ...nodes);
      this.parentNode = null;
      for (const node of nodes) node.parentNode = parent;
    }

    remove() {
      this.parentNode?.removeChild(this);
    }

    contains(node) {
      for (let n = node; n; n = n.parentNode) if (n === this) return true;
      return false;
    }

    matches(selector) {
      return compileSelector(selector).some((chain) => matchesChain(this, chain));
    }

    closest(selector) {
      for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.matches(selector)) return n;
      return null;
    }

    querySelectorAll(selector) {
      const chains = compileSelector(selector);
      const out = [];
      const visit = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType !== 1) continue;
          if (chains.some((chain) => matchesChain(child, chain))) out.push(child);
          visit(child);
        }
      };
      visit(this);
      return out;
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }

    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    }

    removeEventListener(type, fn) {
      this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
    }

    dispatchEvent(event) {
      event.target ||= this;
      const path = [];
      for (let n = this; n; n = n.parentNode) path.push(n);
      for (const node of path) {
        event.currentTarget = node;
        for (const fn of [...(node.listeners?.[event.type] || [])]) fn.call(node, event);
        node.onerror && event.type === "error" && node.onerror(event);
        if (!event.bubbles || event.propagationStopped) break;
      }
      return !event.defaultPrevented;
    }

    focus() {
      if (doc.activeElement === this) return;
      doc.activeElement = this;
      this.focusCount += 1;
      this.dispatchEvent(new FakeEvent("focusin"));
    }

    blur() {
      if (doc.activeElement === this) doc.activeElement = null;
    }

    click() {
      if (this.disabled) return;
      this.clicked = (this.clicked || 0) + 1;
      this.dispatchEvent(new FakeEvent("click"));
    }

    scrollIntoView() {
      this.scrolled += 1;
    }

    showModal() {
      this.setAttribute("open", "");
      this.modal = true;
    }

    close() {
      if (!this.open) return;
      this.removeAttribute("open");
      this.modal = false;
      this.dispatchEvent(new FakeEvent("close", { bubbles: false }));
    }
  }

  doc.body = new FakeElement("body", doc);
  return { document: doc, FakeEvent, FakeElement, FakeText };
}
