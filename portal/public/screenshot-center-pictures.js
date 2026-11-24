// Screenshot Center: looking at a picture in order to decide about it. The "Pictures that look wrong" list and the "Kept pictures" list
// both show each picture as a thumbnail button big enough to judge, and pressing it opens the picture full size in the dialog the
// screenshot gallery already uses (scBuildLightbox in screenshot-center.js). The dialog shows the same title, where the picture is, the
// plain reason, and the same buttons as the list, so a person can decide while looking at the large picture, then moves to the next one.
// The words and the buttons come from the lists' own code (screenshot-center-wrong.js and screenshot-center-keep.js); this file only draws
// the thumbnail, the viewer, and the order they are visited in. All DOM is built with createElement and textContent.

const scPicView = {
  open: false,
  labId: "",
  source: "",
  key: "",
  at: 0,
  fit: true,
  notice: null,
  shownKey: "",
  snapshot: null,
  origin: "",
  askShown: null,
  said: "",
  saidAt: 0,
  prefetch: [],
};

const SC_PIC_LOAD_FAILED = "Could not load this picture.";
const SC_PIC_ACTION_KEYS = ["lb-keep", "lb-move", "lb-restore", "lb-delete"];
const SC_PIC_ASK_KEYS = ["keep-ask-yes", "keep-ask-cancel"];
let scPicStateSeq = 0;

// ── The pictures, in list order ─────────────────────────────────────────────

/** One flagged picture, in the words the list and the viewer share. */
function scPicSuspectItem(item, labId) {
  const filename = scText(item.filename, 90);
  return {
    source: "suspect",
    key: `${item.scope}:${item.labId || ""}:${item.filename}`,
    title: scText(item.label || item.filename, 120),
    where: `${scWrongWhere(item)}: ${filename}.`,
    level: item.level === "definite" ? "definite" : "probable",
    levelText: SC_WRONG_LEVEL_TEXT[item.level] || "",
    reason: scText(item.reason, 400),
    url: scWrongThumb(item, labId),
    width: scCount(item.width),
    height: scCount(item.height),
    raw: item,
  };
}

/** One kept picture. A kept picture's size is not known until it loads. */
function scPicKeptItem(entry, picture) {
  const base = `/api/capture/kept/${encodeURIComponent(entry.id)}/${encodeURIComponent(picture.filename)}`;
  return {
    source: "kept",
    key: `${entry.id}:${picture.filename}`,
    title: picture.earlierVersion ? `${picture.base} (earlier version)` : picture.filename,
    where: scKeepEntryHead(entry),
    level: "",
    levelText: "",
    reason: scKeepWhy(picture),
    url: base,
    downloadUrl: `${base}?download=1`,
    width: 0,
    height: 0,
    raw: { entry, picture },
  };
}

/** The pictures a list shows, in the order it shows them, or null while they are still loading. */
function scPicItems(source, labId) {
  if (source === "suspect") {
    const state = scWrongState(labId);
    return state?.loaded ? state.pictures.map((picture) => scPicSuspectItem(picture, labId)) : null;
  }
  if (source === "kept") {
    return scKeep.loaded ? scKeep.entries.flatMap((entry) => (entry.pictures || []).map((picture) => scPicKeptItem(entry, picture))) : null;
  }
  return null;
}

// ── The thumbnail ───────────────────────────────────────────────────────────

/**
 * The thumbnail for a list row: a real button that opens the picture full size. It is as big as the row allows up to a useful size, never
 * larger than the picture itself, never cropped, and it says in text when it is loading or could not be loaded.
 */
function scPicThumb(item) {
  if (!item.url) return null;
  const stateId = `sc-pic-state-${(scPicStateSeq += 1)}`;
  const button = scEl("button", {
    class: "sc-pic-thumb",
    attrs: { type: "button", "aria-label": `Show the picture for ${item.title} full size`, "aria-haspopup": "dialog" },
    data: { scAction: "pic-open", scPicOpen: "1", picSource: item.source, picKey: item.key, scFocus: `pic:${item.source}:${item.key}` },
  });
  const sized = item.width > 0 && item.height > 0;
  if (sized) {
    button.style.aspectRatio = `${item.width} / ${item.height}`;
    button.style.maxWidth = `min(var(--sc-pic-w, 360px), 100%, ${item.width}px)`;
  }
  const img = scEl("img", { class: "sc-pic-img", attrs: { alt: "", loading: "lazy", decoding: "async", ...(sized ? { width: item.width, height: item.height } : {}) } });
  const state = scEl("span", { class: "sc-pic-state", text: "Loading the picture", attrs: { id: stateId, "aria-hidden": "true" } });
  img.addEventListener("load", () => {
    button.classList.add("sc-pic-loaded");
    state.textContent = "";
    if (!sized && img.naturalWidth > 0 && img.naturalHeight > 0) {
      button.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
      button.style.maxWidth = `min(var(--sc-pic-w, 360px), 100%, ${img.naturalWidth}px)`;
    }
  });
  img.addEventListener("error", () => {
    button.classList.add("sc-pic-failed");
    state.textContent = SC_PIC_LOAD_FAILED;
    state.removeAttribute("aria-hidden");
    button.setAttribute("aria-describedby", stateId);
  });
  img.setAttribute("src", item.url);
  button.appendChild(img);
  button.appendChild(state);
  button.appendChild(scEl("span", { class: "sc-pic-hint", text: "Click to enlarge", attrs: { "aria-hidden": "true" } }));
  return button;
}

// ── The viewer: the screenshot gallery's dialog, showing one flagged or kept picture ──

function scPicViewActive(labId) {
  return scPicView.open && (!labId || scPicView.labId === labId);
}

/** The picture to show now: the one named by the viewer, or (when it is gone) the one that took its place; null items while loading. */
function scPicViewCurrent() {
  const items = scPicItems(scPicView.source, scPicView.labId);
  if (!items) return { items: null, at: scPicView.at, total: 1, item: scPicView.snapshot };
  if (!items.length) return { items, at: -1, total: 0, item: null };
  let at = items.findIndex((candidate) => candidate.key === scPicView.key);
  if (at < 0) at = Math.min(Math.max(scPicView.at, 0), items.length - 1);
  return { items, at, total: items.length, item: items[at] };
}

function scPicViewSay(dialog, message) {
  const live = dialog?.querySelector("[data-sc-pic-live]");
  if (!live || !message) return;
  const flip = live.dataset.flip === "1";
  live.dataset.flip = flip ? "0" : "1";
  live.textContent = flip ? String(message) : `${message}\u00a0`;
  scPicView.said = String(message);
  scPicView.saidAt = Date.now();
}

function scPicOpenDialog(dialog) {
  if (dialog.open) return;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function scPicViewOpen(labId, source, key) {
  const dialog = scLightboxDialog(labId);
  const items = scPicItems(source, labId);
  const at = items ? items.findIndex((candidate) => candidate.key === key) : -1;
  if (!dialog || at < 0) return;
  scLab(labId).lightbox = null;
  Object.assign(scPicView, { open: true, labId, source, key, at, fit: true, notice: null, shownKey: "", snapshot: items[at], origin: "", askShown: null });
  scPicViewFill(labId);
  scPicOpenDialog(dialog);
  scFocusByKey(dialog, "lb-close");
  scPicViewPrefetch(items, at);
}

/** Put the picture's neighbors in the browser's hands now, so Previous and Next are quick. Only after the viewer opened. */
function scPicViewPrefetch(items, at) {
  scPicView.prefetch = [items[at - 1], items[at + 1]]
    .filter((candidate) => candidate?.url)
    .map((candidate) => {
      const img = scEl("img", { attrs: { decoding: "async" } });
      img.setAttribute("src", candidate.url);
      return img;
    });
}

function scPicViewStage(item, dialog) {
  const stage = scEl("div", { class: "sc-pic-stage", data: { scPicStage: "1" } });
  const scroll = scEl("div", { class: "sc-pic-scroll", data: { scPicScroll: "1" } });
  stage.appendChild(scroll);
  if (!item.url) {
    scroll.appendChild(scEl("p", { class: "sc-pic-note", text: "This picture is not available to show here." }));
    return stage;
  }
  const img = scEl("img", { class: "sc-pic-full", attrs: { alt: `The picture for ${item.title}`, decoding: "async" } });
  const note = scEl("p", { class: "sc-pic-note", text: "Loading the picture", data: { scPicNote: "1" } });
  img.addEventListener("load", () => {
    stage.classList.add("sc-pic-loaded");
    note.textContent = "";
    const size = img.naturalWidth > 0 ? `${img.naturalWidth} by ${img.naturalHeight} pixels` : "";
    stage.dataset.picSize = size;
    const label = dialog.querySelector("[data-sc-pic-size]");
    if (label) label.textContent = size;
  });
  img.addEventListener("error", () => {
    stage.classList.add("sc-pic-failed");
    note.textContent = SC_PIC_LOAD_FAILED;
    note.appendChild(scButton("Try again", { action: "pic-retry", focus: "lb-retry" }));
    scPicViewSay(dialog, SC_PIC_LOAD_FAILED);
  });
  img.setAttribute("src", item.url);
  scroll.appendChild(img);
  scroll.appendChild(note);
  return stage;
}

function scPicViewActions(item) {
  const row = scEl("div", { class: "sc-card-actions", data: { scPicActions: "1" } });
  if (item.source === "suspect") {
    const picture = item.raw;
    const data = { scope: picture.scope, labId: picture.labId || "", filename: picture.filename };
    const busy = Boolean(scWrong.busy);
    const aria = (label) => ({ "aria-label": label, ...(busy ? { "aria-disabled": "true" } : {}) });
    row.appendChild(scButton("Keep this one", { action: "wrong-keep", data, focus: "lb-keep", aria: aria(`Keep this one: ${picture.filename}`) }));
    row.appendChild(scButton("Move to kept pictures", { action: "wrong-move", data, focus: "lb-move", aria: aria(`Move ${picture.filename} to kept pictures`) }));
    return row;
  }
  const { entry, picture } = item.raw;
  const option = Array.isArray(picture.restore) ? picture.restore[0] : null;
  if (option) {
    row.appendChild(
      scButton(scKeepRestoreLabel(option), {
        action: "keep-restore",
        data: { entry: entry.id, filename: picture.filename, to: option.type, labId: option.labId || "" },
        focus: "lb-restore",
        aria: { "aria-label": `${scKeepRestoreLabel(option)}: ${picture.filename}` },
      }),
    );
  } else {
    row.appendChild(scEl("span", { class: "sc-library-meta", text: "Nowhere to put it back right now, so download it instead." }));
  }
  row.appendChild(scEl("a", { class: "btn btn-sm", text: "Download", attrs: { href: item.downloadUrl, "aria-label": `Download ${picture.filename}` } }));
  row.appendChild(scButton("Delete forever", { action: "keep-delete", data: { entry: entry.id, filename: picture.filename }, focus: "lb-delete", aria: { "aria-label": `Delete ${picture.filename} forever` } }));
  return row;
}

function scPicViewInfo(item, at, total) {
  const nodes = [];
  const meta = scEl("p", { class: "sc-lb-meta sc-pic-meta" });
  if (item.levelText) meta.appendChild(scChip(item.levelText, item.level === "definite" ? "warn" : "info", `sc-wrong-chip sc-wrong-chip-${item.level}`));
  meta.appendChild(scEl("span", { text: `Picture ${at + 1} of ${total}`, data: { scPicPosition: "1" } }));
  meta.appendChild(scEl("span", { class: "sc-pic-size", data: { scPicSize: "1" } }));
  nodes.push(meta);
  nodes.push(scEl("p", { class: "sc-pic-where", text: item.where }));
  if (item.reason) nodes.push(scEl("p", { class: "sc-wrong-reason", text: item.reason }));

  const tools = scEl("div", { class: "sc-pic-tools" });
  const size = scEl("div", { class: "sc-pic-size-toggle", attrs: { role: "group", "aria-label": "Picture size" } });
  size.appendChild(scButton("Fit to screen", { action: "pic-fit", focus: "lb-fit", aria: { "aria-pressed": scPicView.fit ? "true" : "false" } }));
  size.appendChild(scButton("Actual size", { action: "pic-actual", focus: "lb-actual", aria: { "aria-pressed": scPicView.fit ? "false" : "true" } }));
  tools.appendChild(size);
  tools.appendChild(scEl("a", { class: "btn btn-sm", text: "Open in a new tab", attrs: { href: item.url, target: "_blank", rel: "noopener noreferrer" }, data: { scPicNewTab: "1" } }));
  nodes.push(tools);

  if (scPicView.notice) nodes.push(scEl("p", { class: `sc-banner sc-banner-${scPicView.notice.variant === "ok" ? "ok" : "warn"}`, text: scPicView.notice.text, data: { scPicNotice: "1" } }));
  const ask = item.source === "kept" ? scBuildKeepAsk() : null;
  if (ask) nodes.push(ask);
  nodes.push(scPicViewActions(item));
  return nodes;
}

function scPicFocusIn(root, key) {
  for (const el of root.querySelectorAll("[data-sc-focus]")) {
    if (el.dataset.scFocus !== key || el.disabled) continue;
    el.focus({ preventScroll: true });
    return true;
  }
  return false;
}

/** After the dialog's contents were drawn again: put focus back on the button that had it, or on the nearest one that can have it. */
function scPicViewRestoreFocus(dialog, previousKey) {
  if (!dialog.open) return;
  if (previousKey && scPicFocusIn(dialog, previousKey)) return;
  if (SC_PIC_ASK_KEYS.includes(previousKey) && scPicView.origin && scPicFocusIn(dialog, scPicView.origin)) return;
  const active = document.activeElement;
  if (dialog.contains(active) && !active.disabled) return;
  for (const key of ["lb-next", "lb-prev", "lb-close"]) if (scPicFocusIn(dialog, key)) return;
}

/** Draw the dialog for the current picture. The picture itself is only drawn again when it changed. `quiet` draws it without saying it. */
function scPicViewFill(labId, { quiet = false } = {}) {
  const dialog = scLightboxDialog(labId);
  if (!dialog || !scPicView.open) return;
  const cur = scPicViewCurrent();
  if (!cur.item) {
    scPicViewClose(labId);
    return;
  }
  const { item, at, total } = cur;
  const changed = scPicView.shownKey !== item.key;
  const previousKey = scActiveFocusKey(dialog);
  if (SC_PIC_ACTION_KEYS.includes(previousKey)) scPicView.origin = previousKey;
  Object.assign(scPicView, { key: item.key, at, snapshot: item });

  dialog.classList.add("sc-lightbox-picture");
  const title = dialog.querySelector("#sc-lb-title");
  if (title) title.textContent = item.title;
  const prev = dialog.querySelector('[data-sc-action="lightbox-prev"]');
  const next = dialog.querySelector('[data-sc-action="lightbox-next"]');
  if (prev) {
    prev.setAttribute("aria-label", "Previous picture");
    prev.disabled = at <= 0;
  }
  if (next) {
    next.setAttribute("aria-label", "Next picture");
    next.disabled = at < 0 || at >= total - 1;
  }
  const figure = dialog.querySelector("[data-sc-lb-figure]");
  if (changed || !figure.querySelector("[data-sc-pic-stage]")) {
    figure.replaceChildren(scPicViewStage(item, dialog));
    scPicView.shownKey = item.key;
    if (!quiet) scPicViewSay(dialog, `Picture ${at + 1} of ${total}: ${item.title}`);
  }
  dialog.querySelector("[data-sc-lb-info]").replaceChildren(...scPicViewInfo(item, at, total));
  const ask = item.source === "kept" ? scKeep.ask : null;
  if (ask && scPicView.askShown !== ask && !quiet) scPicViewSay(dialog, `${ask.title} ${ask.text}`);
  scPicView.askShown = ask;
  const loaded = figure.querySelector("[data-sc-pic-stage]")?.dataset.picSize;
  const sizeLabel = dialog.querySelector("[data-sc-pic-size]");
  if (sizeLabel && loaded) sizeLabel.textContent = loaded;
  scPicViewApplyFit(dialog);
  scPicViewRestoreFocus(dialog, previousKey);
}

/** Fit to screen or Actual size: only the picture's classes change, so it is not loaded again. */
function scPicViewApplyFit(dialog) {
  const stage = dialog.querySelector("[data-sc-pic-stage]");
  const scroll = dialog.querySelector("[data-sc-pic-scroll]");
  stage?.classList.toggle("sc-pic-fit", scPicView.fit);
  stage?.classList.toggle("sc-pic-actual", !scPicView.fit);
  if (scroll) {
    if (scPicView.fit) {
      scroll.removeAttribute("tabindex");
      scroll.removeAttribute("role");
      scroll.removeAttribute("aria-label");
    } else {
      scroll.setAttribute("tabindex", "0");
      scroll.setAttribute("role", "group");
      scroll.setAttribute("aria-label", "The picture at actual size. Use the arrow keys to scroll.");
    }
  }
  for (const button of dialog.querySelectorAll('[data-sc-action="pic-fit"], [data-sc-action="pic-actual"]')) {
    button.setAttribute("aria-pressed", (button.dataset.scAction === "pic-fit") === scPicView.fit ? "true" : "false");
  }
}

function scPicViewStep(labId, direction) {
  const cur = scPicViewCurrent();
  if (!cur.items?.length) return;
  const last = cur.items.length - 1;
  const target = direction === "first" ? 0 : direction === "last" ? last : cur.at + direction;
  if (target < 0 || target > last || target === cur.at) return;
  scPicView.key = cur.items[target].key;
  scPicView.at = target;
  scPicView.notice = null;
  scPicViewFill(labId);
  scPicViewPrefetch(cur.items, target);
}

function scPicViewClose(labId) {
  const dialog = scLightboxDialog(labId);
  if (dialog?.open && typeof dialog.close === "function") dialog.close();
  else scPicViewClosed(labId);
}

/** The dialog closed (Close, Escape, or nothing left to look at): focus goes back to the thumbnail of the picture that was shown. */
function scPicViewClosed(labId) {
  const { source, key, at } = scPicView;
  Object.assign(scPicView, { open: false, snapshot: null, shownKey: "", origin: "", askShown: null, notice: null, prefetch: [] });
  const host = scHostFor(labId);
  if (!host) return;
  const items = scPicItems(source, labId) || [];
  const pick = items.find((candidate) => candidate.key === key) || items[Math.min(Math.max(at, 0), items.length - 1)];
  if (pick && scPicFocusIn(host, `pic:${source}:${pick.key}`)) return;
  host.querySelector(source === "kept" ? "[data-sc-kept-heading]" : "[data-sc-wrong-heading]")?.focus?.({ preventScroll: true });
}

/** The dialog was drawn again (the Screenshot Center rendered): show the same picture in the new dialog, and repeat what was just said. */
function scPicViewRestore(labId) {
  if (!scPicViewActive(labId)) return;
  const dialog = scLightboxDialog(labId);
  if (!dialog) return;
  scPicView.shownKey = "";
  scPicViewFill(labId, { quiet: true });
  if (!scPicView.open) return;
  scPicOpenDialog(dialog);
  // A live region that is new is not read, so what was said a moment ago is said again once the new dialog is in place.
  const { said, saidAt } = scPicView;
  if (said && Date.now() - saidAt < 2000) {
    const timer = setTimeout(() => scPicViewSay(scLightboxDialog(labId), said), 60);
    timer?.unref?.();
  }
}

/** The list the viewer is showing was drawn again (it changed, or an action began or ended): bring the viewer up to date with it. */
function scPicViewRefresh(source) {
  if (scPicView.open && scPicView.source === source) scPicViewFill(scPicView.labId);
}

/** A Keep, Move, Restore, or Delete from the viewer finished: say what happened, and the viewer moves on (or closes when nothing is left). */
function scPicViewActionDone(source) {
  if (!scPicView.open || scPicView.source !== source) return;
  const message = source === "suspect" ? scWrong.message : scKeep.message;
  scPicView.notice = message?.text ? { variant: message.variant === "ok" ? "ok" : "warn", text: message.text } : null;
  const dialog = scLightboxDialog(scPicView.labId);
  const before = scPicView.key;
  scPicViewFill(scPicView.labId);
  if (scPicView.open && message?.text) {
    const { at, total, item } = scPicViewCurrent();
    scPicViewSay(dialog, scPicView.key === before ? message.text : `${message.text} Picture ${at + 1} of ${total}: ${item?.title || ""}`);
  }
}

/** Arrow keys move between pictures, but in Actual size they scroll the picture while it has focus; and a key with a modifier is the browser's. */
function scPicViewLetBrowserHandle(labId, event) {
  if (!scPicViewActive(labId)) return false;
  if (event.altKey || event.ctrlKey || event.metaKey) return true;
  return !scPicView.fit && Boolean(event.target?.closest?.("[data-sc-pic-scroll]"));
}

/** Actions from the thumbnails and the viewer's own buttons (called from the Screenshot Center's action switch). */
async function scPicAction(labId, action, control) {
  const data = control?.dataset || {};
  switch (action) {
    case "pic-open":
      scPicViewOpen(labId, data.picSource, data.picKey);
      return true;
    case "pic-fit":
    case "pic-actual": {
      scPicView.fit = action === "pic-fit";
      const dialog = scLightboxDialog(labId);
      if (dialog) {
        scPicViewApplyFit(dialog);
        scPicViewSay(dialog, scPicView.fit ? "Fit to screen." : "Actual size.");
      }
      return true;
    }
    case "pic-retry":
      scPicView.shownKey = "";
      scPicViewFill(labId);
      return true;
    default:
      return false;
  }
}

/** Put the dialog back the way the screenshot gallery expects it, when the gallery opens a screenshot in it. */
function scPicViewLeave(dialog) {
  dialog.classList.remove("sc-lightbox-picture");
  const prev = dialog.querySelector('[data-sc-action="lightbox-prev"]');
  const next = dialog.querySelector('[data-sc-action="lightbox-next"]');
  if (prev) {
    prev.setAttribute("aria-label", "Previous screenshot");
    prev.disabled = false;
  }
  if (next) {
    next.setAttribute("aria-label", "Next screenshot");
    next.disabled = false;
  }
}
