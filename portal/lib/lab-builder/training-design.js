/**
 * The design system of the pre-lab training decks: colors by role, fonts, type sizes, spacing, and the measurements of
 * the components every slide is built from (card, header band, pill, number circle, chevron, callout, layer, table).
 *
 * The look follows the owner's sample deck (a dark navy title and closing slide with a coral bar and concentric
 * circles; light content slides with an eyebrow, a title, a footer, and a slide number; white cards with colored
 * header bands; numbered circles; chevron flows; tinted callouts). Everything is a native PowerPoint shape: no pictures
 * and no embedded fonts.
 *
 * Color meaning (one meaning per color, in every deck):
 *   teal    structure: headers, numbers, pills, links (the "accent" role; a brand profile's primary color)
 *   coral   emphasis: the highlight role (a brand profile's secondary color), callout stripes, chevrons, number circles
 *   navy    the dark role: the title, divider, and closing slides, and the model layer of a stack
 *   green   the Standard harness           (always beside the harness name)
 *   purple  the Microsoft Copilot harness  (always beside the harness name)
 *   teal    the Customer Conversation harness
 *
 * Contrast: every text color is chosen for the surface it sits on (`readableOn`), so a pair that fails 4.5:1 is darkened
 * (or, on a dark surface, lightened) a little instead of changing the look. White text only sits on a fill that
 * reaches 4.5:1 with it. Large text (18 pt, or 14 pt bold) is held to the same 4.5:1: nothing here relies on the 3:1 allowance.
 */

import { SLIDE_CX, SLIDE_CY, blendHex, normalizeHexColor } from "./pptx-builder.js";
import { DEFAULT_BRAND } from "./brand-theme.js";

export const EMU_PER_INCH = 914400;
export const inch = (n) => Math.round(n * EMU_PER_INCH);

// ── Palette: the sample deck's colors ────────────────────────────────────────

export const SAMPLE_PALETTE = Object.freeze({
  ink: "1B2630",
  navy: "10303F",
  page: "F4F8FA",
  card: "FFFFFF",
  cardLine: "E3E7EA",
  teal: "0B6E99",
  tealTint: "DCEFF7",
  coral: "F26B4F",
  coralDark: "C2432A",
  green: "1E7A55",
  greenTint: "DDF0E6",
  purple: "7B3FE4",
  purpleTint: "EDE5FB",
  gray: "66727A",
  grayDark: "56646E",
  tile: "F1F4F6",
  tileLine: "C9D2D8",
  onDark: "D5DEE6",
  onDarkSoft: "C5D2DB",
  onDarkFooter: "B5C4D0",
  tableLine: "DDE2E6",
  white: "FFFFFF",
});

export const FONTS = Object.freeze({ heading: "Segoe UI Semibold", body: "Segoe UI" });

/** Type sizes in points. Body text sits between 12 and 16; labels and the footer at 10 and 11, as in the sample. */
export const TYPE = Object.freeze({
  coverTitle: Object.freeze([48, 44, 40, 36, 32, 28]),
  contentTitle: Object.freeze([30, 26, 24, 22]),
  subtitle: Object.freeze([20, 18, 16]),
  coverEyebrow: 14,
  eyebrow: [12, 11],
  pill: 12,
  series: 11,
  footer: 10,
  label: 10,
  cardHeading: 19,
  bodyMax: 16,
  bodyMin: 12,
  caption: 11,
});

/** Line spacing (percent x 1000) for headings and body text. */
export const SPACING = Object.freeze({ heading: 92000, body: 100000 });

// ── Geometry (EMU) ───────────────────────────────────────────────────────────

export const GRID = Object.freeze({
  margin: inch(0.6),
  contentW: SLIDE_CX - inch(1.2),
  top: inch(1.65),
  bottom: inch(6.75),
  gap: inch(0.2),
  gapSmall: inch(0.1),
  pad: inch(0.25),
  eyebrowY: inch(0.42),
  eyebrowH: inch(0.3),
  titleY: inch(0.72),
  titleLimitY: inch(1.62),
  footerY: inch(7.08),
  footerH: inch(0.25),
  numberX: inch(12.13),
  numberY: inch(7.05),
  numberW: inch(0.6),
  numberH: inch(0.28),
  slideW: SLIDE_CX,
  slideH: SLIDE_CY,
});

/** The measurements of each component, so every slide kind draws it the same way. */
export const PARTS = Object.freeze({
  cardLine: 10160, // 0.8 pt
  schematicLine: 19050, // 1.5 pt
  stripeW: inch(0.08),
  calloutStripeW: inch(0.09),
  bandH: inch(0.85),
  bandHSmall: inch(0.6),
  pillH: inch(0.4),
  pillAdj: 50000,
  pillPadX: inch(0.28),
  pillGap: inch(0.15),
  circle: inch(0.42),
  circleLarge: inch(0.55),
  chevronW: inch(0.28),
  chevronH: inch(0.3),
  arrowW: inch(0.65),
  arrowH: inch(0.3),
  tableRowH: inch(0.46),
  cover: Object.freeze({
    barW: inch(0.28),
    textX: inch(0.9),
    textW: inch(7.6),
    eyebrowY: inch(1.0),
    titleY: inch(1.4),
    pillY: inch(5.85),
    seriesY: inch(6.85),
    circles: Object.freeze([
      { d: 5.6, x: 8.4, y: 0.95, tone: "accent" },
      { d: 4.2, x: 9.1, y: 1.65, tone: "accent" },
      { d: 2.8, x: 9.8, y: 2.35, tone: "accent" },
      { d: 1.5, x: 10.45, y: 3.0, tone: "highlight" },
    ]),
  }),
});

// ── Contrast ─────────────────────────────────────────────────────────────────

function channelValue(hex, offset) {
  const v = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of a hex color: 0 (black) to 1 (white). */
export function luminance(hex) {
  const h = normalizeHexColor(hex);
  return 0.2126 * channelValue(h, 0) + 0.7152 * channelValue(h, 2) + 0.0722 * channelValue(h, 4);
}

/** WCAG contrast ratio between two colors. */
export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * `color` itself when it reads on every background at `min`; otherwise the nearest tone toward black (on light
 * backgrounds) or toward white (on dark ones) that does. The hue stays, so the look does not change.
 */
export function readableOn(color, backgrounds, min = 4.5) {
  const list = (Array.isArray(backgrounds) ? backgrounds : [backgrounds]).map((b) => normalizeHexColor(b));
  const start = normalizeHexColor(color);
  const passes = (c) => list.every((bg) => contrastRatio(c, bg) >= min);
  if (passes(start)) return start;
  const lightBackgrounds = list.reduce((sum, bg) => sum + luminance(bg), 0) / list.length > 0.4;
  const toward = lightBackgrounds ? "000000" : "FFFFFF";
  for (let step = 1; step <= 50; step += 1) {
    const candidate = blendHex(start, toward, step * 0.02);
    if (passes(candidate)) return candidate;
  }
  return toward;
}

/** A fill that carries white text at `min`: the color itself, or darkened just enough. */
export function fillForWhiteText(color, min = 4.5) {
  return readableOn(color, "FFFFFF", min);
}

// ── Harness colors ───────────────────────────────────────────────────────────

const HARNESS_BASE = Object.freeze({
  standard: { fill: SAMPLE_PALETTE.green, tint: SAMPLE_PALETTE.greenTint },
  "microsoft-copilot": { fill: SAMPLE_PALETTE.purple, tint: SAMPLE_PALETTE.purpleTint },
  "customer-conversation": { fill: SAMPLE_PALETTE.teal, tint: SAMPLE_PALETTE.tealTint },
});

// ── Resolving the design for a deck (default or branded) ─────────────────────

const PORTAL_DEFAULT_PRIMARY = normalizeHexColor(DEFAULT_BRAND.primaryColor);

/**
 * The colors and fonts of one deck. With no brand profile this is the sample palette and Segoe UI exactly. With one,
 * the brand's primary color becomes the accent role, its secondary color the highlight role, a dark tone of the primary
 * the dark role, and its font both font roles; the layouts do not change. The portal's own default primary color is
 * not a brand choice, so a profile that sets only a font or a logo keeps the sample colors.
 *
 * @param {{primaryColor?: string, secondaryColor?: string}|null} branding
 * @param {string|null} brandFont office typeface name of the brand font, or null
 */
export function resolveDesign(branding = null, brandFont = null) {
  const P = SAMPLE_PALETTE;
  const asked = branding?.primaryColor ? normalizeHexColor(branding.primaryColor, "") : "";
  const primary = asked && asked !== PORTAL_DEFAULT_PRIMARY ? asked : "";
  const secondary = branding?.secondaryColor ? normalizeHexColor(branding.secondaryColor, "") : "";

  const page = P.page;
  const card = P.card;
  // Dark role: a very dark tone of the brand color; white and the on-dark grays read on it at 10:1 or better.
  let navy = P.navy;
  if (primary) {
    navy = blendHex(primary, "06121B", 0.8);
    for (let i = 0; i < 20 && contrastRatio(navy, "FFFFFF") < 11; i += 1) navy = blendHex(navy, "000000", 0.1);
  }
  const accent = primary ? fillForWhiteText(primary) : P.teal;
  const accentTint = primary ? blendHex(accent, "FFFFFF", 0.88) : P.tealTint;
  const accentText = readableOn(accent, [page, card, accentTint]);
  const highlight = secondary || P.coral;
  const highlightFill = secondary ? fillForWhiteText(secondary) : P.coralDark;
  const highlightInk = readableOn(highlightFill, [page, card, accentTint]);
  const highlightOnDark = readableOn(highlight, navy);

  const harness = {};
  for (const [id, base] of Object.entries(HARNESS_BASE)) {
    // A harness color is a fixed meaning, so a brand never recolors it.
    harness[id] = { fill: fillForWhiteText(base.fill), tint: base.tint, text: readableOn(base.fill, [card, base.tint]) };
  }

  const heading = brandFont || FONTS.heading;
  const body = brandFont || FONTS.body;
  return Object.freeze({
    branded: Boolean(primary || secondary || brandFont),
    colorsBranded: Boolean(primary || secondary),
    font: Object.freeze({ heading, body, brand: brandFont || null }),
    ink: P.ink,
    navy,
    page,
    card,
    cardLine: P.cardLine,
    accent,
    accentText,
    accentTint,
    highlight,
    highlightFill,
    highlightInk,
    highlightOnDark,
    gray: readableOn(P.gray, [page, card]),
    grayDark: readableOn(P.grayDark, [page, card, accentTint, P.tile]),
    tile: P.tile,
    tileLine: P.tileLine,
    tableLine: P.tableLine,
    onDark: P.onDark,
    onDarkSoft: P.onDarkSoft,
    onDarkFooter: P.onDarkFooter,
    white: P.white,
    harness: Object.freeze(harness),
  });
}

/**
 * The colors of a harness: its fill (carries white text), tint, and readable text color. An unknown harness uses the
 * accent role, so a new harness still reads; it always has its name beside the color.
 */
export function harnessColors(design, harnessId) {
  const known = design.harness[harnessId];
  if (known) return known;
  return { fill: design.accent, tint: design.accentTint, text: design.accentText };
}
