/**
 * Dependency-free strict checks for generated Office Open XML packages.
 *
 * Lenient readers (python-pptx, python-docx, the Open XML SDK validator) accept
 * packages that the real Office applications reject as "corrupted and unreadable".
 * These checks encode the invariants PowerPoint and Word enforce that those
 * readers do not, for example:
 *   - a slide master and the notes master may not share a theme part,
 *   - every master and layout id is unique and >= 2147483648,
 *   - XML parts contain only legal XML 1.0 characters and declared namespaces,
 *   - every relationship target, content type and r:id reference resolves,
 *   - schema child order and attribute value ranges hold in the parts we write.
 *
 * Every check returns plain strings (`<part>: <message>`); an empty array means the
 * package passed. Nothing here is used at portal runtime.
 */

import { crc32, inflateRawSync } from "node:zlib";

const NS = Object.freeze({
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  ct: "http://schemas.openxmlformats.org/package/2006/content-types",
  rel: "http://schemas.openxmlformats.org/package/2006/relationships",
  wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  pic: "http://schemas.openxmlformats.org/drawingml/2006/picture",
});
const ABBR_BY_NS = new Map(Object.entries(NS).map(([abbr, uri]) => [uri, abbr]));

const RT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
const REL_TYPE = Object.freeze({
  officeDocument: `${RT}officeDocument`,
  slide: `${RT}slide`,
  slideMaster: `${RT}slideMaster`,
  slideLayout: `${RT}slideLayout`,
  notesMaster: `${RT}notesMaster`,
  notesSlide: `${RT}notesSlide`,
  theme: `${RT}theme`,
  image: `${RT}image`,
  hyperlink: `${RT}hyperlink`,
});

const CT = Object.freeze({
  rels: "application/vnd.openxmlformats-package.relationships+xml",
  theme: "application/vnd.openxmlformats-officedocument.theme+xml",
  presentation: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  slideMaster: "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml",
  slideLayout: "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml",
  slide: "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
  notesMaster: "application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml",
  notesSlide: "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml",
  document: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
});

/* ------------------------------------------------------------------ */
/* ZIP container                                                       */
/* ------------------------------------------------------------------ */

/**
 * Read a ZIP archive and check the container invariants Office enforces: unique,
 * forward-slash entry names, no directory entries, known compression methods,
 * matching CRC-32 and sizes, and (for OPC packages) `[Content_Types].xml` as the
 * first entry. Pass `{ opc: false }` for plain archives such as the lab bundle.
 *
 * @returns {{ entries: Map<string, Buffer>, order: string[], problems: string[] }}
 */
export function readZipStrict(buffer, { opc = true } = {}) {
  const problems = [];
  const entries = new Map();
  const order = [];
  const fail = (message) => {
    problems.push(`(zip): ${message}`);
    return { entries, order, problems };
  };

  if (!Buffer.isBuffer(buffer) || buffer.length < 22) return fail("not a ZIP archive (too short)");
  if (buffer.readUInt32LE(0) !== 0x04034b50) return fail("does not start with a local file header (PK\\x03\\x04)");

  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return fail("end of central directory record not found");

  const total = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return fail("ZIP64 archives are not allowed");
  if (cdOffset + cdSize > eocd) return fail("central directory overlaps the end record");

  const seen = new Set();
  let offset = cdOffset;
  for (let i = 0; i < total; i += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      return fail(`bad central directory header #${i}`);
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    offset += 46 + nameLen + extraLen + commentLen;

    if (!name) problems.push("(zip): empty entry name");
    if (name.includes("\\")) problems.push(`${name}: entry name contains a backslash`);
    if (name.startsWith("/")) problems.push(`${name}: entry name has a leading slash`);
    if (name.endsWith("/")) problems.push(`${name}: directory entries are not allowed in an OPC package`);
    if (name.split("/").some((seg) => seg === ".." || seg === ".")) problems.push(`${name}: entry name has a relative segment`);
    const key = name.toLowerCase();
    if (seen.has(key)) problems.push(`${name}: duplicate entry name (case-insensitive)`);
    seen.add(key);
    if (flags & 0x0001) problems.push(`${name}: encrypted entries are not allowed`);
    if (method !== 0 && method !== 8) problems.push(`${name}: unsupported compression method ${method}`);

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      problems.push(`${name}: bad local file header`);
      continue;
    }
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const localName = buffer.subarray(localOffset + 30, localOffset + 30 + localNameLen).toString("utf8");
    if (localName !== name) problems.push(`${name}: local header name '${localName}' differs from the central directory`);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buffer.subarray(dataStart, dataStart + compSize);
    if (raw.length !== compSize) {
      problems.push(`${name}: compressed data runs past the end of the archive`);
      continue;
    }
    let data;
    try {
      data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    } catch (err) {
      problems.push(`${name}: cannot inflate (${err.message})`);
      continue;
    }
    if (data.length !== size) problems.push(`${name}: uncompressed size ${data.length} differs from the header (${size})`);
    if (crc32(data) !== crc) problems.push(`${name}: CRC-32 mismatch`);
    entries.set(name, data);
    order.push(name);
  }

  if (opc && order[0] !== "[Content_Types].xml") problems.push(`(zip): first entry must be [Content_Types].xml, found '${order[0]}'`);
  return { entries, order, problems };
}

/* ------------------------------------------------------------------ */
/* Strict XML parser                                                   */
/* ------------------------------------------------------------------ */

const NAME_RE = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/;
const ATTR_RE = /\s+([^\s=/>"'<]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;

function isXmlChar(cp) {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

/** Return the first character that is illegal in XML 1.0 (as a code point), or null. */
export function findIllegalXmlChar(text) {
  for (let i = 0; i < text.length; i += 1) {
    const cp = text.codePointAt(i);
    if (cp > 0xffff) {
      i += 1;
      continue;
    }
    if (!isXmlChar(cp)) return cp;
  }
  return null;
}

function checkReferences(value, where) {
  const withoutValid = value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (whole, ref) => {
    if (ref.startsWith("#")) {
      const cp = ref[1] === "x" ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
      if (!isXmlChar(cp)) throw new Error(`${where}: character reference ${whole} is not a legal XML character`);
    }
    return "";
  });
  if (withoutValid.includes("&")) throw new Error(`${where}: unescaped '&' or unknown entity`);
}

/**
 * Parse XML strictly (well-formedness, namespaces, legal characters, no DTD).
 * @returns {{ name, local, ns, attrs, children, text }}
 */
export function parseXmlStrict(buffer) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    throw new Error("invalid UTF-8 byte sequence");
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const illegal = findIllegalXmlChar(text);
  if (illegal !== null) throw new Error(`illegal XML character U+${illegal.toString(16).toUpperCase().padStart(4, "0")}`);

  let pos = 0;
  if (text.startsWith("<?xml")) {
    const end = text.indexOf("?>");
    if (end < 0) throw new Error("unterminated XML declaration");
    const enc = text.slice(0, end).match(/encoding\s*=\s*["']([^"']+)["']/i);
    if (enc && enc[1].toUpperCase() !== "UTF-8") throw new Error(`unsupported encoding '${enc[1]}'`);
    pos = end + 2;
  }

  const root = { name: "#document", local: "#document", ns: "", attrs: [], children: [], text: "", parent: null };
  const nsStack = [new Map([["xml", "http://www.w3.org/XML/1998/namespace"]])];
  let current = root;
  let rootCount = 0;

  const split = (qname) => {
    const idx = qname.indexOf(":");
    return idx < 0 ? { prefix: "", local: qname } : { prefix: qname.slice(0, idx), local: qname.slice(idx + 1) };
  };

  while (pos < text.length) {
    const lt = text.indexOf("<", pos);
    const chunk = text.slice(pos, lt < 0 ? text.length : lt);
    if (chunk) {
      if (current === root) {
        if (chunk.trim()) throw new Error("text outside the root element");
      } else {
        if (chunk.includes("]]>")) throw new Error("']]>' is not allowed in text");
        checkReferences(chunk, `text in <${current.name}>`);
        current.text += chunk;
      }
    }
    if (lt < 0) break;
    pos = lt;

    if (text.startsWith("<!--", pos)) {
      const end = text.indexOf("-->", pos + 4);
      if (end < 0) throw new Error("unterminated comment");
      if (text.slice(pos + 4, end).includes("--")) throw new Error("'--' inside a comment");
      pos = end + 3;
    } else if (text.startsWith("<![CDATA[", pos)) {
      const end = text.indexOf("]]>", pos);
      if (end < 0) throw new Error("unterminated CDATA section");
      current.text += text.slice(pos + 9, end);
      pos = end + 3;
    } else if (text.startsWith("<?", pos)) {
      const end = text.indexOf("?>", pos);
      if (end < 0) throw new Error("unterminated processing instruction");
      pos = end + 2;
    } else if (text.startsWith("<!", pos)) {
      throw new Error("DOCTYPE/DTD declarations are not allowed");
    } else if (text.startsWith("</", pos)) {
      const end = text.indexOf(">", pos);
      if (end < 0) throw new Error("unterminated end tag");
      const name = text.slice(pos + 2, end).trim();
      if (current === root || current.name !== name) {
        throw new Error(`end tag </${name}> does not match <${current === root ? "(none)" : current.name}>`);
      }
      current = current.parent;
      nsStack.pop();
      pos = end + 1;
    } else {
      pos += 1;
      const nameMatch = /^[^\s/>]+/.exec(text.slice(pos, pos + 256));
      if (!nameMatch || !NAME_RE.test(nameMatch[0])) throw new Error(`invalid element name near offset ${pos}`);
      const name = nameMatch[0];
      pos += name.length;

      const rawAttrs = [];
      for (;;) {
        ATTR_RE.lastIndex = pos;
        const m = ATTR_RE.exec(text);
        if (!m) break;
        if (!NAME_RE.test(m[1])) throw new Error(`invalid attribute name '${m[1]}' on <${name}>`);
        const value = m[2] ?? m[3];
        checkReferences(value, `attribute ${m[1]} on <${name}>`);
        if (rawAttrs.some((a) => a.qname === m[1])) throw new Error(`duplicate attribute '${m[1]}' on <${name}>`);
        rawAttrs.push({ qname: m[1], value });
        pos = ATTR_RE.lastIndex;
      }
      while (/\s/.test(text[pos] || "")) pos += 1;
      let selfClosing = false;
      if (text.startsWith("/>", pos)) {
        selfClosing = true;
        pos += 2;
      } else if (text[pos] === ">") {
        pos += 1;
      } else {
        throw new Error(`malformed start tag <${name}> near offset ${pos}`);
      }

      const scope = new Map(nsStack[nsStack.length - 1]);
      for (const attr of rawAttrs) {
        if (attr.qname === "xmlns") scope.set("", attr.value);
        else if (attr.qname.startsWith("xmlns:")) scope.set(attr.qname.slice(6), attr.value);
      }
      const { prefix, local } = split(name);
      if (prefix && !scope.has(prefix)) throw new Error(`undeclared namespace prefix '${prefix}' on <${name}>`);
      const attrs = rawAttrs
        .filter((a) => a.qname !== "xmlns" && !a.qname.startsWith("xmlns:"))
        .map((a) => {
          const parts = split(a.qname);
          if (parts.prefix && !scope.has(parts.prefix)) {
            throw new Error(`undeclared namespace prefix '${parts.prefix}' on attribute ${a.qname}`);
          }
          return { qname: a.qname, local: parts.local, ns: parts.prefix ? scope.get(parts.prefix) : "", value: a.value };
        });

      const node = { name, local, ns: scope.get(prefix) || "", attrs, children: [], text: "", parent: current };
      if (current === root) {
        rootCount += 1;
        if (rootCount > 1) throw new Error("more than one root element");
      }
      current.children.push(node);
      if (!selfClosing) {
        current = node;
        nsStack.push(scope);
      }
    }
  }
  if (current !== root) throw new Error(`unclosed element <${current.name}>`);
  if (rootCount !== 1) throw new Error("no root element");
  return root.children[0];
}

const keyOf = (node) => `${ABBR_BY_NS.get(node.ns) || "?"}:${node.local}`;

function attrOf(node, local, nsAbbr = null) {
  const wanted = nsAbbr ? NS[nsAbbr] : "";
  const hit = node.attrs.find((a) => a.local === local && a.ns === wanted);
  return hit ? hit.value : null;
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

function childrenByKey(node, key) {
  return node.children.filter((c) => keyOf(c) === key);
}

/* ------------------------------------------------------------------ */
/* Schema child order tables (only parents the builders emit)          */
/* ------------------------------------------------------------------ */

// Each parent lists its children in schema order; names in one inner array are alternatives of the same slot.
const FILL = ["a:noFill", "a:solidFill", "a:gradFill", "a:blipFill", "a:pattFill", "a:grpFill"];
const RPR_ORDER = [
  ["a:ln"], FILL, ["a:effectLst", "a:effectDag"], ["a:highlight"], ["a:uLnTx", "a:uLn"], ["a:uFillTx", "a:uFill"],
  ["a:latin"], ["a:ea"], ["a:cs"], ["a:sym"], ["a:hlinkClick"], ["a:hlinkMouseOver"], ["a:rtl"], ["a:extLst"],
];
const PPR_ORDER = [
  ["a:lnSpc"], ["a:spcBef"], ["a:spcAft"], ["a:buClrTx", "a:buClr"], ["a:buSzTx", "a:buSzPct", "a:buSzPts"],
  ["a:buFontTx", "a:buFont"], ["a:buNone", "a:buAutoNum", "a:buChar", "a:buBlip"], ["a:tabLst"], ["a:defRPr"], ["a:extLst"],
];
const GROUP_MEMBERS = ["p:sp", "p:grpSp", "p:graphicFrame", "p:cxnSp", "p:pic", "p:contentPart"];

const PPTX_ORDER = {
  "p:presentation": [
    ["p:sldMasterIdLst"], ["p:notesMasterIdLst"], ["p:handoutMasterIdLst"], ["p:sldIdLst"], ["p:sldSz"], ["p:notesSz"],
    ["p:smartTags"], ["p:embeddedFontLst"], ["p:custShowLst"], ["p:photoAlbum"], ["p:custDataLst"], ["p:kinsoku"],
    ["p:defaultTextStyle"], ["p:modifyVerifier"], ["p:extLst"],
  ],
  "p:sld": [["p:cSld"], ["p:clrMapOvr"], ["p:transition"], ["p:timing"], ["p:extLst"]],
  "p:sldLayout": [["p:cSld"], ["p:clrMapOvr"], ["p:transition"], ["p:timing"], ["p:hf"], ["p:extLst"]],
  "p:sldMaster": [["p:cSld"], ["p:clrMap"], ["p:sldLayoutIdLst"], ["p:transition"], ["p:timing"], ["p:hf"], ["p:txStyles"], ["p:extLst"]],
  "p:notesMaster": [["p:cSld"], ["p:clrMap"], ["p:hf"], ["p:notesStyle"], ["p:extLst"]],
  "p:notes": [["p:cSld"], ["p:clrMapOvr"], ["p:extLst"]],
  "p:cSld": [["p:bg"], ["p:spTree"], ["p:custDataLst"], ["p:controls"], ["p:extLst"]],
  "p:bg": [["p:bgPr", "p:bgRef"]],
  "p:spTree": [["p:nvGrpSpPr"], ["p:grpSpPr"], GROUP_MEMBERS, ["p:extLst"]],
  "p:grpSp": [["p:nvGrpSpPr"], ["p:grpSpPr"], GROUP_MEMBERS, ["p:extLst"]],
  "p:sp": [["p:nvSpPr"], ["p:spPr"], ["p:style"], ["p:txBody"], ["p:extLst"]],
  "p:pic": [["p:nvPicPr"], ["p:blipFill"], ["p:spPr"], ["p:style"], ["p:extLst"]],
  "p:graphicFrame": [["p:nvGraphicFramePr"], ["p:xfrm"], ["a:graphic"], ["p:extLst"]],
  "p:cxnSp": [["p:nvCxnSpPr"], ["p:spPr"], ["p:style"], ["p:extLst"]],
  "p:nvSpPr": [["p:cNvPr"], ["p:cNvSpPr"], ["p:nvPr"]],
  "p:nvPicPr": [["p:cNvPr"], ["p:cNvPicPr"], ["p:nvPr"]],
  "p:nvGrpSpPr": [["p:cNvPr"], ["p:cNvGrpSpPr"], ["p:nvPr"]],
  "p:nvCxnSpPr": [["p:cNvPr"], ["p:cNvCxnSpPr"], ["p:nvPr"]],
  "p:nvGraphicFramePr": [["p:cNvPr"], ["p:cNvGraphicFramePr"], ["p:nvPr"]],
  "p:blipFill": [["a:blip"], ["a:srcRect"], ["a:tile", "a:stretch"]],
  "p:txBody": [["a:bodyPr"], ["a:lstStyle"], ["a:p"]],
  "p:spPr": [["a:xfrm"], ["a:custGeom", "a:prstGeom"], FILL, ["a:ln"], ["a:effectLst", "a:effectDag"], ["a:scene3d"], ["a:sp3d"], ["a:extLst"]],
  "p:grpSpPr": [["a:xfrm"], FILL, ["a:effectLst", "a:effectDag"], ["a:scene3d"], ["a:extLst"]],
  "p:txStyles": [["p:titleStyle"], ["p:bodyStyle"], ["p:otherStyle"], ["p:extLst"]],
  "a:txBody": [["a:bodyPr"], ["a:lstStyle"], ["a:p"]],
  "a:p": [["a:pPr"], ["a:r", "a:br", "a:fld"], ["a:endParaRPr"]],
  "a:r": [["a:rPr"], ["a:t"]],
  "a:fld": [["a:rPr"], ["a:pPr"], ["a:t"]],
  "a:pPr": PPR_ORDER,
  "a:rPr": RPR_ORDER,
  "a:endParaRPr": RPR_ORDER,
  "a:defRPr": RPR_ORDER,
  "a:bodyPr": [["a:prstTxWarp"], ["a:noAutofit", "a:normAutofit", "a:spAutoFit"], ["a:scene3d"], ["a:sp3d"], ["a:flatTx"], ["a:extLst"]],
  "a:xfrm": [["a:off"], ["a:ext"], ["a:chOff"], ["a:chExt"]],
  "a:ln": [FILL, ["a:prstDash", "a:custDash"], ["a:round", "a:bevel", "a:miter"], ["a:headEnd"], ["a:tailEnd"], ["a:extLst"]],
  "a:tbl": [["a:tblPr"], ["a:tblGrid"], ["a:tr"]],
  "a:tr": [["a:tc"], ["a:extLst"]],
  "a:tc": [["a:txBody"], ["a:tcPr"], ["a:extLst"]],
  "a:tcPr": [["a:lnL"], ["a:lnR"], ["a:lnT"], ["a:lnB"], ["a:lnTlToBr"], ["a:lnBlToTr"], ["a:cell3D"], FILL, ["a:headers"], ["a:extLst"]],
  "a:tblPr": [FILL, ["a:effectLst", "a:effectDag"], ["a:tableStyle", "a:tableStyleId"], ["a:extLst"]],
  "a:graphic": [["a:graphicData"]],
  "a:theme": [["a:themeElements"], ["a:objectDefaults"], ["a:extraClrSchemeLst"], ["a:custClrLst"], ["a:extLst"]],
  "a:themeElements": [["a:clrScheme"], ["a:fontScheme"], ["a:fmtScheme"], ["a:extLst"]],
  "a:clrScheme": [["a:dk1"], ["a:lt1"], ["a:dk2"], ["a:lt2"], ["a:accent1"], ["a:accent2"], ["a:accent3"], ["a:accent4"], ["a:accent5"], ["a:accent6"], ["a:hlink"], ["a:folHlink"], ["a:extLst"]],
  "a:fontScheme": [["a:majorFont"], ["a:minorFont"], ["a:extLst"]],
  "a:majorFont": [["a:latin"], ["a:ea"], ["a:cs"], ["a:font"], ["a:extLst"]],
  "a:minorFont": [["a:latin"], ["a:ea"], ["a:cs"], ["a:font"], ["a:extLst"]],
  "a:fmtScheme": [["a:fillStyleLst"], ["a:lnStyleLst"], ["a:effectStyleLst"], ["a:bgFillStyleLst"], ["a:extLst"]],
};
const LST_STYLE_ORDER = [["a:defPPr"], ...Array.from({ length: 9 }, (_v, i) => [`a:lvl${i + 1}pPr`]), ["a:extLst"]];
for (let lvl = 1; lvl <= 9; lvl += 1) PPTX_ORDER[`a:lvl${lvl}pPr`] = PPR_ORDER;
PPTX_ORDER["a:defPPr"] = PPR_ORDER;
PPTX_ORDER["a:lstStyle"] = LST_STYLE_ORDER;
for (const style of ["titleStyle", "bodyStyle", "otherStyle", "notesStyle", "defaultTextStyle"]) {
  PPTX_ORDER[`p:${style}`] = LST_STYLE_ORDER;
}

const wordSlots = (names) => names.map((n) => [`w:${n}`]);
const DOCX_ORDER = {
  "w:pPr": wordSlots([
    "pStyle", "keepNext", "keepLines", "pageBreakBefore", "framePr", "widowControl", "numPr", "suppressLineNumbers", "pBdr", "shd",
    "tabs", "suppressAutoHyphens", "kinsoku", "wordWrap", "overflowPunct", "topLinePunct", "autoSpaceDE", "autoSpaceDN", "bidi",
    "adjustRightInd", "snapToGrid", "spacing", "ind", "contextualSpacing", "mirrorIndents", "suppressOverlap", "jc",
    "textDirection", "textAlignment", "textboxTightWrap", "outlineLvl", "divId", "cnfStyle", "rPr", "sectPr", "pPrChange",
  ]),
  "w:rPr": wordSlots([
    "rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike", "outline", "shadow", "emboss", "imprint",
    "noProof", "snapToGrid", "vanish", "webHidden", "color", "spacing", "w", "kern", "position", "sz", "szCs", "highlight", "u",
    "effect", "bdr", "shd", "fitText", "vertAlign", "rtl", "cs", "em", "lang", "eastAsianLayout", "specVanish", "oMath",
  ]),
  "w:tblPr": wordSlots([
    "tblStyle", "tblpPr", "tblOverlap", "bidiVisual", "tblStyleRowBandSize", "tblStyleColBandSize", "tblW", "jc",
    "tblCellSpacing", "tblInd", "tblBorders", "shd", "tblLayout", "tblCellMar", "tblLook",
  ]),
  "w:tr": [["w:tblPrEx"], ["w:trPr"], ["w:tc"]],
  "w:tcPr": wordSlots([
    "cnfStyle", "tcW", "gridSpan", "hMerge", "vMerge", "tcBorders", "shd", "noWrap", "tcMar", "textDirection", "tcFitText", "vAlign", "hideMark",
  ]),
  "w:sectPr": [
    ["w:headerReference", "w:footerReference"], ["w:footnotePr"], ["w:endnotePr"], ["w:type"], ["w:pgSz"], ["w:pgMar"], ["w:paperSrc"],
    ["w:pgBorders"], ["w:lnNumType"], ["w:pgNumType"], ["w:cols"], ["w:formProt"], ["w:vAlign"], ["w:noEndnote"], ["w:titlePg"],
    ["w:textDirection"], ["w:bidi"], ["w:rtlGutter"], ["w:docGrid"], ["w:printerSettings"],
  ],
};

function checkChildOrder(node, table, problems, part) {
  const spec = table[keyOf(node)];
  if (!spec) return;
  const slotOf = new Map();
  spec.forEach((names, idx) => names.forEach((n) => slotOf.set(n, idx)));
  let last = -1;
  let lastKey = "";
  for (const child of node.children) {
    const key = keyOf(child);
    if (!slotOf.has(key)) {
      if (key.endsWith(":extLst") || key.startsWith("?:")) continue;
      problems.push(`${part}: <${keyOf(node)}> has unexpected child <${key}>`);
      continue;
    }
    const slot = slotOf.get(key);
    if (slot < last) problems.push(`${part}: <${keyOf(node)}> child <${key}> appears after <${lastKey}> (schema order)`);
    else {
      last = slot;
      lastKey = key;
    }
  }
}

/* ------------------------------------------------------------------ */
/* OPC package checks                                                  */
/* ------------------------------------------------------------------ */

function posixDir(partName) {
  const idx = partName.lastIndexOf("/");
  return idx < 0 ? "" : partName.slice(0, idx);
}

function resolveTarget(sourcePart, target) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = posixDir(sourcePart).split("/").filter(Boolean);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("/");
}

function relsSource(relsPartName) {
  if (relsPartName === "_rels/.rels") return "";
  const m = relsPartName.match(/^(?:(.*)\/)?_rels\/([^/]+)\.rels$/);
  if (!m) return null;
  return m[1] ? `${m[1]}/${m[2]}` : m[2];
}

function relsPartFor(source) {
  if (!source) return "_rels/.rels";
  const dir = posixDir(source);
  return `${dir ? `${dir}/` : ""}_rels/${source.split("/").pop()}.rels`;
}

/** Parse every part and run the generic OPC checks. */
function loadPackage(buffer) {
  const zip = readZipStrict(buffer);
  const problems = [...zip.problems];
  const ctx = {
    entries: zip.entries,
    xml: new Map(),
    rels: new Map(), // source part -> [{ id, type, target, external, resolved }]
    contentTypeOf: new Map(),
  };

  for (const [name, data] of zip.entries) {
    if (!/\.(xml|rels)$/i.test(name)) continue;
    try {
      ctx.xml.set(name, parseXmlStrict(data));
    } catch (err) {
      problems.push(`${name}: ${err.message}`);
    }
  }

  const types = ctx.xml.get("[Content_Types].xml");
  const defaults = new Map();
  const overrides = new Map();
  const contentTypeRe = /^[\w.+-]+\/[\w.+-]+$/;
  if (!types) {
    problems.push("[Content_Types].xml: missing or unparsable");
  } else if (keyOf(types) !== "ct:Types") {
    problems.push(`[Content_Types].xml: root must be <Types> in the content-types namespace, found <${types.name}>`);
  } else {
    for (const child of types.children) {
      const key = keyOf(child);
      if (key === "ct:Default") {
        const ext = (attrOf(child, "Extension") || "").toLowerCase();
        const type = attrOf(child, "ContentType") || "";
        if (!/^[a-z0-9]+$/.test(ext)) problems.push(`[Content_Types].xml: Default has invalid Extension '${ext}'`);
        if (!contentTypeRe.test(type)) problems.push(`[Content_Types].xml: Default '${ext}' has invalid ContentType '${type}'`);
        if (defaults.has(ext)) problems.push(`[Content_Types].xml: duplicate Default for extension '${ext}'`);
        defaults.set(ext, type);
      } else if (key === "ct:Override") {
        const partName = attrOf(child, "PartName") || "";
        const type = attrOf(child, "ContentType") || "";
        if (!partName.startsWith("/")) problems.push(`[Content_Types].xml: Override PartName '${partName}' must start with '/'`);
        if (!contentTypeRe.test(type)) problems.push(`[Content_Types].xml: Override '${partName}' has invalid ContentType '${type}'`);
        if (overrides.has(partName)) problems.push(`[Content_Types].xml: duplicate Override for '${partName}'`);
        if (!zip.entries.has(partName.slice(1))) problems.push(`[Content_Types].xml: Override targets missing part '${partName}'`);
        overrides.set(partName, type);
      } else {
        problems.push(`[Content_Types].xml: unexpected element <${child.name}>`);
      }
    }
  }
  for (const name of zip.entries.keys()) {
    if (name === "[Content_Types].xml") continue;
    const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
    const type = overrides.get(`/${name}`) ?? defaults.get(ext);
    if (!type) problems.push(`${name}: no content type (no Override and no Default for '.${ext}')`);
    else ctx.contentTypeOf.set(name, type);
    if (ext === "rels" && type !== CT.rels) problems.push(`${name}: relationships part must use ${CT.rels}`);
  }

  for (const [name, root] of ctx.xml) {
    if (!name.endsWith(".rels")) continue;
    const source = relsSource(name);
    if (source === null) {
      problems.push(`${name}: relationships part is not located in a _rels folder`);
      continue;
    }
    if (source && !zip.entries.has(source)) problems.push(`${name}: its source part '${source}' does not exist`);
    if (keyOf(root) !== "rel:Relationships") {
      problems.push(`${name}: root must be <Relationships> in the package relationships namespace`);
      continue;
    }
    const list = [];
    const ids = new Set();
    for (const child of root.children) {
      if (keyOf(child) !== "rel:Relationship") {
        problems.push(`${name}: unexpected element <${child.name}>`);
        continue;
      }
      const id = attrOf(child, "Id") || "";
      const type = attrOf(child, "Type") || "";
      const target = attrOf(child, "Target");
      const mode = attrOf(child, "TargetMode");
      if (ids.has(id)) problems.push(`${name}: duplicate relationship Id '${id}'`);
      ids.add(id);
      if (!/^[A-Za-z_][\w.-]*$/.test(id)) problems.push(`${name}: relationship Id '${id}' is not a valid xsd:ID`);
      if (!type) problems.push(`${name}: relationship '${id}' has no Type`);
      if (!target) problems.push(`${name}: relationship '${id}' has no Target`);
      if (mode !== null && mode !== "Internal" && mode !== "External") problems.push(`${name}: relationship '${id}' has invalid TargetMode '${mode}'`);
      const external = mode === "External";
      let resolved = null;
      if (!external && target) {
        resolved = resolveTarget(source, target);
        if (!zip.entries.has(resolved)) problems.push(`${name}: relationship '${id}' targets missing part '${resolved}'`);
      }
      list.push({ id, type, target: target || "", external, resolved });
    }
    ctx.rels.set(source, list);
  }

  // Every part must be reachable from the package root relationships.
  const reached = new Set(["[Content_Types].xml"]);
  const queue = [""];
  const visited = new Set();
  while (queue.length) {
    const source = queue.shift();
    if (visited.has(source)) continue;
    visited.add(source);
    reached.add(relsPartFor(source));
    for (const rel of ctx.rels.get(source) || []) {
      if (rel.resolved && zip.entries.has(rel.resolved)) {
        reached.add(rel.resolved);
        queue.push(rel.resolved);
      }
    }
  }
  for (const name of zip.entries.keys()) {
    if (!reached.has(name)) problems.push(`${name}: orphan part (not reachable through any relationship)`);
  }

  // r:id style references must resolve in the owning part's relationships.
  for (const [name, root] of ctx.xml) {
    if (name.endsWith(".rels") || name === "[Content_Types].xml") continue;
    const relIds = new Set((ctx.rels.get(name) || []).map((r) => r.id));
    walk(root, (node) => {
      for (const attr of node.attrs) {
        if (attr.ns !== NS.r) continue;
        if (!attr.value) problems.push(`${name}: <${node.name}> has an empty ${attr.qname}`);
        else if (!relIds.has(attr.value)) problems.push(`${name}: <${node.name}> ${attr.qname}="${attr.value}" has no matching relationship`);
      }
    });
  }

  const core = ctx.xml.get("docProps/core.xml");
  if (core) {
    for (const key of ["created", "modified"]) {
      const el = core.children.find((c) => c.local === key);
      if (el && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(el.text.trim())) {
        problems.push(`docProps/core.xml: dcterms:${key} '${el.text.trim()}' is not W3CDTF`);
      }
    }
  }

  return { ctx, problems };
}

function relsOfType(ctx, source, type) {
  return (ctx.rels.get(source) || []).filter((r) => r.type === type);
}

function expectRoot(ctx, problems, part, expectedKey, expectedType) {
  const root = ctx.xml.get(part);
  if (!root) return null;
  if (keyOf(root) !== expectedKey) problems.push(`${part}: root element must be <${expectedKey}>, found <${keyOf(root)}>`);
  if (expectedType && ctx.contentTypeOf.get(part) !== expectedType) {
    problems.push(`${part}: content type must be ${expectedType}, found ${ctx.contentTypeOf.get(part)}`);
  }
  return root;
}

function imageKind(buf) {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return "png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  return null;
}

/* ------------------------------------------------------------------ */
/* PPTX                                                                */
/* ------------------------------------------------------------------ */

const INT_ATTRS = new Set(["x", "y", "cx", "cy", "w", "h", "marL", "marR", "indent", "lIns", "tIns", "rIns", "bIns", "sz", "gridSpan", "rowSpan", "lvl", "spc"]);
const NON_NEGATIVE_ATTRS = new Set(["cx", "cy", "h", "marL", "marR", "gridSpan", "rowSpan", "lIns", "tIns", "rIns", "bIns"]);
const MAX_COORD = 27273042316900;
const BAD_LITERAL = /^(NaN|undefined|null|Infinity|-Infinity)$/;

function checkDrawingValues(root, part, problems) {
  walk(root, (node) => {
    const key = keyOf(node);
    for (const attr of node.attrs) {
      const v = attr.value;
      if (BAD_LITERAL.test(v)) problems.push(`${part}: <${key}> ${attr.qname}="${v}" is not a valid value`);
      if (attr.ns !== "" || !INT_ATTRS.has(attr.local) || key === "p:ph") continue;
      if (!/^-?\d+$/.test(v)) {
        problems.push(`${part}: <${key}> ${attr.qname}="${v}" must be an integer`);
        continue;
      }
      const n = Number(v);
      if (Math.abs(n) > MAX_COORD) problems.push(`${part}: <${key}> ${attr.qname}="${v}" is out of range`);
      if (NON_NEGATIVE_ATTRS.has(attr.local) && n < 0) problems.push(`${part}: <${key}> ${attr.qname}="${v}" must not be negative`);
      if (attr.local === "sz" && (key === "a:rPr" || key === "a:defRPr" || key === "a:endParaRPr") && (n < 100 || n > 400000)) {
        problems.push(`${part}: <${key}> sz="${v}" must be between 100 and 400000`);
      }
    }
    if (key === "a:srgbClr" && !/^[0-9A-Fa-f]{6}$/.test(attrOf(node, "val") || "")) {
      problems.push(`${part}: <a:srgbClr> val="${attrOf(node, "val")}" must be six hex digits`);
    }
    if (key === "p:sldSz" || key === "p:notesSz") {
      const cx = Number(attrOf(node, "cx"));
      const cy = Number(attrOf(node, "cy"));
      if (!(cx >= 914400 && cx <= 51206400 && cy >= 914400 && cy <= 51206400)) problems.push(`${part}: <${key}> size ${cx}x${cy} is outside 914400..51206400`);
    }
  });
}

function checkShapeIds(root, part, problems) {
  const seen = new Set();
  walk(root, (node) => {
    if (keyOf(node) !== "p:cNvPr") return;
    const id = attrOf(node, "id");
    if (!/^\d+$/.test(id || "") || Number(id) < 1 || Number(id) > 4294967295) {
      problems.push(`${part}: <p:cNvPr> id="${id}" must be a positive integer`);
      return;
    }
    if (seen.has(id)) problems.push(`${part}: duplicate shape id ${id}`);
    seen.add(id);
  });
}

function placeholderTypes(root) {
  const types = [];
  walk(root, (node) => {
    if (keyOf(node) === "p:ph") types.push(attrOf(node, "type"));
  });
  return types;
}

/**
 * Strict checks for a generated .pptx package.
 * @param {Buffer} buffer
 * @param {{ expectNotes?: boolean }} [options] when set, assert whether notes slides exist.
 * @returns {string[]} problems (empty when the package passes)
 */
export function checkPptxPackage(buffer, options = {}) {
  const { ctx, problems } = loadPackage(buffer);
  const names = [...ctx.entries.keys()];

  const officeDoc = relsOfType(ctx, "", REL_TYPE.officeDocument);
  if (officeDoc.length !== 1 || officeDoc[0].resolved !== "ppt/presentation.xml") {
    problems.push("_rels/.rels: exactly one officeDocument relationship to ppt/presentation.xml is required");
    return problems;
  }

  for (const [name, root] of ctx.xml) {
    if (name.endsWith(".rels") || name === "[Content_Types].xml" || name.startsWith("docProps/")) continue;
    walk(root, (node) => checkChildOrder(node, PPTX_ORDER, problems, name));
    checkDrawingValues(root, name, problems);
  }

  const pres = expectRoot(ctx, problems, "ppt/presentation.xml", "p:presentation", CT.presentation);
  if (!pres) return problems;
  const none = { children: [] };

  // Master, layout and notes master ids; every master owns its own theme part.
  const allIds = new Map();
  const claimId = (id, label) => {
    if (!/^\d+$/.test(id || "")) {
      problems.push(`${label}: id '${id}' must be an unsigned integer`);
      return;
    }
    if (Number(id) < 2147483648 || Number(id) > 4294967295) problems.push(`${label}: id ${id} must be between 2147483648 and 4294967295`);
    if (allIds.has(id)) problems.push(`${label}: id ${id} is already used by ${allIds.get(id)}`);
    allIds.set(id, label);
  };

  const presRels = ctx.rels.get("ppt/presentation.xml") || [];
  const presRelById = new Map(presRels.map((r) => [r.id, r]));
  const masterParts = [];
  for (const el of childrenByKey(childrenByKey(pres, "p:sldMasterIdLst")[0] || none, "p:sldMasterId")) {
    const rel = presRelById.get(attrOf(el, "id", "r"));
    claimId(attrOf(el, "id"), `ppt/presentation.xml sldMasterId ${attrOf(el, "id", "r")}`);
    if (!rel || rel.type !== REL_TYPE.slideMaster) problems.push("ppt/presentation.xml: sldMasterId r:id must reference a slideMaster relationship");
    else masterParts.push(rel.resolved);
  }
  if (masterParts.length < 1) problems.push("ppt/presentation.xml: at least one slide master is required");

  const notesMasterParts = [];
  for (const el of childrenByKey(childrenByKey(pres, "p:notesMasterIdLst")[0] || none, "p:notesMasterId")) {
    const rel = presRelById.get(attrOf(el, "id", "r"));
    if (!rel || rel.type !== REL_TYPE.notesMaster) problems.push("ppt/presentation.xml: notesMasterId r:id must reference a notesMaster relationship");
    else notesMasterParts.push(rel.resolved);
  }
  if (notesMasterParts.length > 1) problems.push("ppt/presentation.xml: at most one notes master is allowed");
  if (names.some((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)) && notesMasterParts.length === 0) {
    problems.push("ppt/presentation.xml: notes slides exist but no notesMasterIdLst is declared");
  }
  if (presRels.filter((r) => r.type === REL_TYPE.notesMaster).length !== notesMasterParts.length) {
    problems.push("ppt/_rels/presentation.xml.rels: notesMaster relationships do not match notesMasterIdLst");
  }

  const themeOwner = new Map();
  const ownTheme = (masterPart, label) => {
    const themes = relsOfType(ctx, masterPart, REL_TYPE.theme);
    if (themes.length !== 1) {
      problems.push(`${masterPart}: ${label} must have exactly one theme relationship, found ${themes.length}`);
      return;
    }
    const theme = themes[0].resolved;
    if (themeOwner.has(theme)) {
      problems.push(`${masterPart}: ${label} shares theme part '${theme}' with ${themeOwner.get(theme)}; PowerPoint rejects the file as corrupted`);
    }
    themeOwner.set(theme, masterPart);
    const themeRoot = ctx.xml.get(theme);
    if (themeRoot && keyOf(themeRoot) !== "a:theme") problems.push(`${theme}: root element must be <a:theme>`);
    if (ctx.contentTypeOf.get(theme) !== CT.theme) problems.push(`${theme}: content type must be ${CT.theme}`);
  };

  for (const masterPart of masterParts) {
    const master = expectRoot(ctx, problems, masterPart, "p:sldMaster", CT.slideMaster);
    ownTheme(masterPart, "slide master");
    if (!master) continue;
    const layoutRels = new Map(relsOfType(ctx, masterPart, REL_TYPE.slideLayout).map((r) => [r.id, r]));
    const layoutEls = childrenByKey(childrenByKey(master, "p:sldLayoutIdLst")[0] || none, "p:sldLayoutId");
    if (layoutEls.length === 0) problems.push(`${masterPart}: sldLayoutIdLst must list at least one layout`);
    for (const el of layoutEls) {
      claimId(attrOf(el, "id"), `${masterPart} sldLayoutId ${attrOf(el, "id", "r")}`);
      const rel = layoutRels.get(attrOf(el, "id", "r"));
      if (!rel) {
        problems.push(`${masterPart}: sldLayoutId r:id does not reference a slideLayout relationship`);
        continue;
      }
      const layout = expectRoot(ctx, problems, rel.resolved, "p:sldLayout", CT.slideLayout);
      const back = relsOfType(ctx, rel.resolved, REL_TYPE.slideMaster);
      if (back.length !== 1 || back[0].resolved !== masterPart) problems.push(`${rel.resolved}: layout must relate back to exactly its slide master`);
      if (layout) checkShapeIds(layout, rel.resolved, problems);
    }
    checkShapeIds(master, masterPart, problems);
  }
  for (const notesMasterPart of notesMasterParts) {
    const nm = expectRoot(ctx, problems, notesMasterPart, "p:notesMaster", CT.notesMaster);
    ownTheme(notesMasterPart, "notes master");
    if (!nm) continue;
    checkShapeIds(nm, notesMasterPart, problems);
    if (childrenByKey(nm, "p:clrMap").length !== 1) problems.push(`${notesMasterPart}: notes master requires a p:clrMap`);
    const phTypes = placeholderTypes(nm);
    for (const need of ["sldImg", "body"]) {
      if (!phTypes.includes(need)) problems.push(`${notesMasterPart}: notes master is missing the '${need}' placeholder`);
    }
  }

  // Slides and notes slides
  const sldIds = new Set();
  const slideParts = [];
  const sldIdList = childrenByKey(pres, "p:sldIdLst")[0];
  for (const el of sldIdList ? childrenByKey(sldIdList, "p:sldId") : []) {
    const id = attrOf(el, "id");
    if (!/^\d+$/.test(id || "") || Number(id) < 256 || Number(id) > 2147483647) problems.push(`ppt/presentation.xml: sldId id='${id}' must be 256..2147483647`);
    if (sldIds.has(id)) problems.push(`ppt/presentation.xml: duplicate sldId ${id}`);
    sldIds.add(id);
    const rel = presRelById.get(attrOf(el, "id", "r"));
    if (!rel || rel.type !== REL_TYPE.slide) problems.push(`ppt/presentation.xml: sldId ${id} r:id must reference a slide relationship`);
    else slideParts.push(rel.resolved);
  }
  const allSlideParts = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  if (slideParts.length !== allSlideParts.length) problems.push(`ppt/presentation.xml: sldIdLst lists ${slideParts.length} slides but the package holds ${allSlideParts.length}`);
  if (slideParts.length === 0) problems.push("ppt/presentation.xml: a deck needs at least one slide");

  let notesCount = 0;
  const notesParts = new Set();
  for (const slidePart of slideParts) {
    const slide = expectRoot(ctx, problems, slidePart, "p:sld", CT.slide);
    const slideRels = ctx.rels.get(slidePart) || [];
    const layouts = relsOfType(ctx, slidePart, REL_TYPE.slideLayout);
    if (layouts.length !== 1) problems.push(`${slidePart}: exactly one slideLayout relationship is required, found ${layouts.length}`);
    for (const rel of slideRels) {
      if (rel.type === REL_TYPE.hyperlink) {
        let ok = rel.external;
        try {
          const url = new URL(rel.target);
          ok = ok && (url.protocol === "https:" || url.protocol === "http:") && !/\s/.test(rel.target);
        } catch {
          ok = false;
        }
        if (!ok) problems.push(`${slidePart}: hyperlink relationship '${rel.id}' must be an absolute external http(s) URL, found '${rel.target}'`);
      }
      if (rel.type === REL_TYPE.image) {
        const data = ctx.entries.get(rel.resolved);
        const kind = data && imageKind(data);
        const ext = (rel.resolved || "").split(".").pop().toLowerCase();
        if (!kind) problems.push(`${slidePart}: image '${rel.resolved}' is not a PNG or JPEG`);
        else {
          if ((kind === "png") !== (ext === "png")) problems.push(`${rel.resolved}: file extension does not match its ${kind} content`);
          if (ctx.contentTypeOf.get(rel.resolved) !== `image/${kind}`) problems.push(`${rel.resolved}: content type must be image/${kind}`);
        }
      }
    }
    if (slide) {
      checkShapeIds(slide, slidePart, problems);
      walk(slide, (node) => {
        const key = keyOf(node);
        if (key === "a:hlinkClick") {
          const rel = slideRels.find((r) => r.id === attrOf(node, "id", "r"));
          if (rel && rel.type !== REL_TYPE.hyperlink) problems.push(`${slidePart}: a:hlinkClick r:id must reference a hyperlink relationship`);
        }
        if (key === "a:blip") {
          const rel = slideRels.find((r) => r.id === attrOf(node, "embed", "r"));
          if (!rel || rel.type !== REL_TYPE.image) problems.push(`${slidePart}: a:blip r:embed must reference an image relationship`);
        }
        if (key === "a:tbl") {
          const cols = childrenByKey(childrenByKey(node, "a:tblGrid")[0] || none, "a:gridCol").length;
          if (cols === 0) problems.push(`${slidePart}: a:tbl needs at least one a:gridCol`);
          for (const tr of childrenByKey(node, "a:tr")) {
            const cells = childrenByKey(tr, "a:tc");
            if (cells.length !== cols) problems.push(`${slidePart}: a:tbl row has ${cells.length} cells but the grid has ${cols} columns`);
            for (const tc of cells) {
              if (childrenByKey(tc, "a:txBody").length !== 1) problems.push(`${slidePart}: a:tc requires exactly one a:txBody`);
            }
          }
        }
        if ((key === "p:txBody" || key === "a:txBody") && (childrenByKey(node, "a:bodyPr").length !== 1 || childrenByKey(node, "a:p").length < 1)) {
          problems.push(`${slidePart}: <${key}> requires one a:bodyPr and at least one a:p`);
        }
      });
    }

    const notes = relsOfType(ctx, slidePart, REL_TYPE.notesSlide);
    if (notes.length > 1) problems.push(`${slidePart}: at most one notesSlide relationship is allowed`);
    if (notes.length !== 1) continue;
    notesCount += 1;
    const notesPart = notes[0].resolved;
    if (notesParts.has(notesPart)) problems.push(`${notesPart}: notes slide is shared by more than one slide`);
    notesParts.add(notesPart);
    const nroot = expectRoot(ctx, problems, notesPart, "p:notes", CT.notesSlide);
    const toMaster = relsOfType(ctx, notesPart, REL_TYPE.notesMaster);
    if (toMaster.length !== 1 || toMaster[0].resolved !== notesMasterParts[0]) problems.push(`${notesPart}: must relate to exactly the notes master`);
    const toSlide = relsOfType(ctx, notesPart, REL_TYPE.slide);
    if (toSlide.length !== 1 || toSlide[0].resolved !== slidePart) problems.push(`${notesPart}: must relate back to its slide (${slidePart})`);
    if (nroot) {
      checkShapeIds(nroot, notesPart, problems);
      const phTypes = placeholderTypes(nroot);
      for (const need of ["sldImg", "body"]) {
        if (!phTypes.includes(need)) problems.push(`${notesPart}: notes slide is missing the '${need}' placeholder`);
      }
    }
  }
  const allNotesParts = names.filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n));
  if (allNotesParts.length !== notesCount) problems.push(`ppt/notesSlides: ${allNotesParts.length} notes slide parts but ${notesCount} slides reference one`);
  if (typeof options.expectNotes === "boolean" && options.expectNotes !== (notesCount > 0)) {
    problems.push(`notes: expected ${options.expectNotes ? "speaker notes" : "no speaker notes"}, found ${notesCount} notes slides`);
  }

  const app = ctx.xml.get("docProps/app.xml");
  if (app) {
    const num = (local) => {
      const el = app.children.find((c) => c.local === local);
      return el ? Number(el.text.trim()) : null;
    };
    if (num("Slides") !== slideParts.length) problems.push(`docProps/app.xml: <Slides> is ${num("Slides")} but the deck has ${slideParts.length} slides`);
    if (num("Notes") !== notesCount) problems.push(`docProps/app.xml: <Notes> is ${num("Notes")} but the deck has ${notesCount} notes slides`);
  }

  for (const name of names) {
    if (/^ppt\/media\//.test(name) && !/\.(png|jpe?g)$/i.test(name)) problems.push(`${name}: media part must be a .png/.jpg/.jpeg file`);
  }
  return problems;
}

/* ------------------------------------------------------------------ */
/* DOCX                                                                */
/* ------------------------------------------------------------------ */

/**
 * Strict checks for a generated .docx package.
 * @param {Buffer} buffer
 * @returns {string[]} problems (empty when the package passes)
 */
export function checkDocxPackage(buffer) {
  const { ctx, problems } = loadPackage(buffer);

  const officeDoc = relsOfType(ctx, "", REL_TYPE.officeDocument);
  if (officeDoc.length !== 1 || officeDoc[0].resolved !== "word/document.xml") {
    problems.push("_rels/.rels: exactly one officeDocument relationship to word/document.xml is required");
    return problems;
  }

  for (const [name, root] of ctx.xml) {
    if (name.endsWith(".rels") || name === "[Content_Types].xml" || name.startsWith("docProps/")) continue;
    walk(root, (node) => {
      checkChildOrder(node, DOCX_ORDER, problems, name);
      for (const attr of node.attrs) {
        if (BAD_LITERAL.test(attr.value)) problems.push(`${name}: <${keyOf(node)}> ${attr.qname}="${attr.value}" is not a valid value`);
      }
    });
  }

  const doc = expectRoot(ctx, problems, "word/document.xml", "w:document", CT.document);
  if (!doc) return problems;
  const body = childrenByKey(doc, "w:body")[0];
  if (!body) {
    problems.push("word/document.xml: <w:body> is required");
    return problems;
  }
  const lastChild = body.children[body.children.length - 1];
  if (!lastChild || keyOf(lastChild) !== "w:sectPr") problems.push("word/document.xml: the final child of <w:body> must be <w:sectPr>");
  for (const c of body.children.slice(0, -1)) {
    if (keyOf(c) === "w:sectPr") problems.push("word/document.xml: <w:sectPr> may only be the last child of <w:body>");
  }

  const styleIds = new Set();
  const styles = ctx.xml.get("word/styles.xml");
  if (styles) {
    walk(styles, (node) => {
      if (keyOf(node) === "w:style") styleIds.add(attrOf(node, "styleId", "w"));
    });
  }
  const numIds = new Set();
  const numbering = ctx.xml.get("word/numbering.xml");
  if (numbering) {
    walk(numbering, (node) => {
      if (keyOf(node) === "w:num") numIds.add(attrOf(node, "numId", "w"));
    });
  }

  const bookmarkIds = new Set();
  const drawingIds = new Set();
  for (const [name, root] of ctx.xml) {
    if (!/^word\/[^/]+\.xml$/.test(name)) continue;
    const rels = ctx.rels.get(name) || [];
    walk(root, (node) => {
      const key = keyOf(node);
      if (key === "w:pStyle" || key === "w:rStyle" || key === "w:tblStyle") {
        const id = attrOf(node, "val", "w");
        if (styles && !styleIds.has(id)) problems.push(`${name}: <${key}> references unknown style '${id}'`);
      }
      if (key === "w:numId") {
        const id = attrOf(node, "val", "w");
        if (id !== "0" && numbering && !numIds.has(id)) problems.push(`${name}: <w:numId> references unknown numbering '${id}'`);
      }
      if (key === "w:tc") {
        const last = node.children[node.children.length - 1];
        if (!last || keyOf(last) !== "w:p") problems.push(`${name}: <w:tc> must end with a <w:p> paragraph`);
      }
      if (key === "w:tbl") {
        if (childrenByKey(node, "w:tblGrid").length !== 1) problems.push(`${name}: <w:tbl> requires exactly one <w:tblGrid>`);
        if (childrenByKey(node, "w:tr").length < 1) problems.push(`${name}: <w:tbl> requires at least one <w:tr>`);
      }
      if (key === "w:tr" && childrenByKey(node, "w:tc").length < 1) problems.push(`${name}: <w:tr> requires at least one <w:tc>`);
      if (key === "w:bookmarkStart") {
        const id = attrOf(node, "id", "w");
        if (bookmarkIds.has(id)) problems.push(`${name}: duplicate bookmark id ${id}`);
        bookmarkIds.add(id);
      }
      if (key === "wp:docPr") {
        const id = attrOf(node, "id");
        if (drawingIds.has(id)) problems.push(`${name}: duplicate drawing id ${id}`);
        drawingIds.add(id);
      }
      if (key === "w:hyperlink") {
        const rid = attrOf(node, "id", "r");
        const rel = rid ? rels.find((r) => r.id === rid) : null;
        if (rel && (rel.type !== REL_TYPE.hyperlink || !rel.external)) problems.push(`${name}: <w:hyperlink> r:id must reference an external hyperlink relationship`);
      }
      if (key === "a:blip") {
        const rel = rels.find((r) => r.id === attrOf(node, "embed", "r"));
        if (!rel || rel.type !== REL_TYPE.image) {
          problems.push(`${name}: a:blip r:embed must reference an image relationship`);
          return;
        }
        const data = ctx.entries.get(rel.resolved);
        const kind = data && imageKind(data);
        if (!kind) problems.push(`${name}: image '${rel.resolved}' is not a PNG or JPEG`);
        else if ((kind === "png") !== /\.png$/i.test(rel.resolved)) problems.push(`${rel.resolved}: file extension does not match its ${kind} content`);
      }
    });
  }
  return problems;
}

/** Dispatch on the package kind (`pptx` or `docx`). */
export function checkOfficePackage(buffer, kind, options = {}) {
  if (kind === "pptx") return checkPptxPackage(buffer, options);
  if (kind === "docx") return checkDocxPackage(buffer);
  return [`(package): unsupported kind '${kind}'`];
}
