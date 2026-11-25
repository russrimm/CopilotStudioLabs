/**
 * Text contrast of what is on screen, for the browser test that checks every primary button stays readable
 * (test/btn-primary-contrast-browser.test.js). The function below runs inside the page, so it stands alone (Playwright serializes it).
 * It reads the computed colors of each element that has text of its own, lays the element's translucent background
 * over the ones behind it, and returns the WCAG 2 contrast ratio of the text against that.
 */

export const WCAG_NORMAL_TEXT = 4.5;
export const WCAG_LARGE_TEXT = 3;

/**
 * One row per visible element that matches `selector` and holds text of its own.
 * `ownBackgroundOnly` keeps just the elements that paint their own background (buttons, pills, badges), which is where a stray
 * text color on a filled button shows up.
 */
export function sweepContrast({ selector = "body *", ownBackgroundOnly = false } = {}) {
  const probe = document.createElement("canvas").getContext("2d");
  const part = (token) => (String(token).endsWith("%") ? Number.parseFloat(token) / 100 : Number(token));
  const parseColor = (value) => {
    const text = String(value || "").trim();
    let match = text.match(/^rgba?\(([^)]+)\)$/);
    if (match) {
      const parts = match[1].split(/[\s,/]+/).filter(Boolean);
      return [part(parts[0]), part(parts[1]), part(parts[2]), parts.length > 3 ? part(parts[3]) : 1];
    }
    match = text.match(/^color\(srgb ([^)]+)\)$/);
    if (match) {
      const parts = match[1].split(/[\s/]+/).filter(Boolean);
      return [part(parts[0]) * 255, part(parts[1]) * 255, part(parts[2]) * 255, parts.length > 3 ? part(parts[3]) : 1];
    }
    probe.fillStyle = "#000000";
    probe.fillStyle = text;
    const normal = String(probe.fillStyle);
    if (normal.startsWith("#")) {
      const hex = normal.slice(1);
      return [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).concat(1);
    }
    return parseColor(normal);
  };
  const over = (top, bottom) => {
    const alpha = top[3] + bottom[3] * (1 - top[3]);
    if (alpha === 0) return [0, 0, 0, 0];
    return [0, 1, 2].map((i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / alpha).concat(alpha);
  };
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (rgb) => 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
  const ratioOf = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const css = (rgb) => `rgb(${rgb.slice(0, 3).map(Math.round).join(", ")})`;
  const describe = (el) => {
    const id = el.id ? `#${el.id}` : "";
    const classes = [...el.classList].slice(0, 4).map((name) => `.${name}`).join("");
    const holder = el.parentElement?.closest("[id], [class]");
    const where = holder && holder !== document.body ? `${holder.tagName.toLowerCase()}${holder.id ? `#${holder.id}` : ""}${[...holder.classList].slice(0, 1).map((name) => `.${name}`).join("")}` : "";
    return `${where ? `${where} > ` : ""}${el.tagName.toLowerCase()}${id}${classes}`;
  };

  const rows = [];
  for (const el of document.querySelectorAll(selector)) {
    if (/^(SCRIPT|STYLE|NOSCRIPT|OPTION|OPTGROUP)$/.test(el.tagName) || el instanceof SVGElement) continue;
    if (!el.childNodes) continue;
    const text = [...el.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent).join(" ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const style = getComputedStyle(el);
    if (style.visibility !== "visible") continue;
    let hidden = false;
    for (let node = el; node && !hidden; node = node.parentElement) hidden = getComputedStyle(node).opacity === "0";
    if (hidden) continue;

    const own = parseColor(style.backgroundColor);
    const ownBackground = own[3] > 0;
    if (ownBackgroundOnly && !ownBackground) continue;

    const layers = [];
    let image = false;
    for (let node = el; node; node = node.parentElement) {
      const layer = getComputedStyle(node);
      const color = parseColor(layer.backgroundColor);
      if (layer.backgroundImage !== "none") image = true;
      if (color[3] > 0) layers.push(color);
      if (color[3] >= 0.999 || layer.backgroundImage !== "none") break;
    }
    let background = [255, 255, 255, 1];
    for (const layer of layers.reverse()) background = over(layer, background);
    let color = parseColor(style.color);
    if (color[3] < 1) color = over(color, background);

    const fontSize = Number.parseFloat(style.fontSize);
    const fontWeight = Number.parseInt(style.fontWeight, 10) || 400;
    const large = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
    rows.push({
      selector: describe(el),
      text: text.slice(0, 60),
      color: css(color),
      background: css(background),
      ratio: Math.round(ratioOf(color, background) * 100) / 100,
      required: large ? 3 : 4.5,
      fontSize,
      fontWeight,
      ownBackground,
      image,
      btnPrimary: el.classList.contains("btn-primary"),
      disabled: el.matches(":disabled, [aria-disabled='true']"),
    });
  }
  return rows;
}

/** The rows that miss the WCAG minimum for their size. Controls that are switched off are exempt from WCAG, so they are left out. */
export const lowContrast = (rows, { includeDisabled = false } = {}) =>
  rows.filter((row) => row.ratio < row.required && !row.image && (includeDisabled || !row.disabled));
