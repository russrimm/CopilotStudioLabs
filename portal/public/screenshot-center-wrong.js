// Screenshot Center: "Pictures that look wrong". It lists the pictures the portal thinks show the wrong screen (a start page for a deeper screen,
// the same picture under several screenshots, a page that was not signed in), each with the plain reason, and lets the person keep one
// ("Keep this one") or move it to the kept pictures list (restorable for 90 days; its screenshot goes back to pending). It lives in
// Advanced, with a one-line notice at the top of the Screenshot Center when something is flagged. The words come from the portal
// (each reason, the notice), so the server and the page never disagree. All DOM is built with createElement and textContent.

const scWrong = {
  byKey: {},
  ask: null,
  message: null,
  busy: false,
};

const SC_WRONG_TTL_MS = 20000;
const SC_WRONG_LEVEL_TEXT = Object.freeze({ definite: "Clearly the wrong screen.", probable: "Worth a look." });

const scWrongKey = (labId) => String(labId || "library");
const scWrongState = (labId) => scWrong.byKey[scWrongKey(labId)] || null;

async function scWrongLoad(labId, force = false) {
  const key = scWrongKey(labId);
  const state = (scWrong.byKey[key] ||= { loaded: false, loading: false, error: "", at: 0, counts: { total: 0, definite: 0, probable: 0 }, notice: "", pictures: [] });
  if (state.loading || (state.loaded && !force && Date.now() - state.at < SC_WRONG_TTL_MS)) return state;
  state.loading = true;
  state.error = "";
  try {
    const { ok, data, status } = await scFetchJson(`/api/capture/suspect-pictures${labId ? `?labId=${encodeURIComponent(labId)}` : ""}`);
    if (!ok) throw new Error(String(data.error || `Request failed (${status}).`));
    state.pictures = Array.isArray(data.pictures) ? data.pictures : [];
    state.counts = { total: scCount(data.counts?.total), definite: scCount(data.counts?.definite), probable: scCount(data.counts?.probable) };
    state.notice = scText(data.notice, 200);
    state.loaded = true;
    state.at = Date.now();
  } catch (err) {
    state.error = err.message;
  } finally {
    state.loading = false;
  }
  return state;
}

/** Load the flagged pictures once in a while, then draw the notice and the panel again when they changed. */
function scWrongEnsure(labId) {
  const state = scWrongState(labId);
  if (state && (state.loading || (state.loaded && Date.now() - state.at < SC_WRONG_TTL_MS))) return;
  const before = state ? `${state.counts.total}:${state.loaded}` : "";
  void scWrongLoad(labId).then((next) => {
    if (`${next.counts.total}:${next.loaded}` === before) return;
    scRenderWrongHosts();
    if (typeof scRerenderOpenCenter === "function") scRerenderOpenCenter();
  });
}

/** The one-line notice at the top of the Screenshot Center: "3 pictures look like the wrong screen. Review them." */
function scWrongNotice(labId) {
  const state = scWrongState(labId);
  if (!state?.loaded || !state.counts.total || !state.notice) return null;
  const box = scEl("div", { class: "sc-banner sc-banner-warn sc-wrong-notice", attrs: { role: "status" }, data: { scWrongNotice: "1" } });
  box.appendChild(scEl("p", { text: state.notice }));
  box.appendChild(scButton("Review", { action: "wrong-review", focus: "wrong-review", aria: { "aria-label": "Review the pictures that look like the wrong screen" } }));
  return box;
}

function scWrongThumb(item, labId) {
  if (item.scope === "library") return `/api/capture/library/screenshots/${encodeURIComponent(item.filename)}/image`;
  return item.labId && typeof scAssetUrl === "function" ? scAssetUrl(item.labId, item.filename, String(item.sha256 || "").slice(0, 12)) : "";
}

function scWrongWhere(item) {
  return item.scope === "library" ? "Shared library" : item.labId === scWrong.currentLab ? "This lab" : `Lab ${scText(item.labTitle || item.labId, 60)}`;
}

function scBuildWrongAsk(labId) {
  const ask = scWrong.ask;
  if (!ask) return null;
  const box = scEl("div", { class: "sc-ask", attrs: { role: "group", "aria-label": ask.title }, data: { scAsk: "wrong" } });
  box.appendChild(scEl("p", { class: "sc-ask-title", text: ask.title }));
  box.appendChild(scEl("p", { class: "sc-ask-text", text: ask.text }));
  const row = scEl("div", { class: "sc-card-actions" });
  row.appendChild(scButton(ask.yes, { action: "wrong-ask-yes", primary: true, focus: "wrong-ask-yes" }));
  row.appendChild(scButton("Cancel", { action: "wrong-ask-cancel", focus: "wrong-ask-cancel" }));
  box.appendChild(row);
  box.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault?.();
    event.stopPropagation?.();
    scWrong.ask = null;
    scRenderWrongHosts();
  });
  return box;
}

function scWrongContents(labId) {
  scWrong.currentLab = labId || "";
  const state = scWrongState(labId);
  const out = [scEl("h6", { text: "Pictures that look wrong", attrs: { tabindex: "-1" }, data: { scWrongHeading: "1", scFocus: "wrong-heading" } })];
  out.push(
    scEl("p", {
      class: "hint",
      text: "Some pictures may show the wrong screen: a start page instead of the screen the lab describes, the same picture under several screenshots, or a page that was not signed in. Move one to the kept pictures list (it is kept for 90 days and can be restored) and its screenshot goes back to pending, so it can be captured again. Choose Keep this one when a picture is right. Select a picture to see it full size.",
    }),
  );
  if (!state?.loaded) {
    if (state?.error) out.push(scEl("p", { class: "lb-error", text: `Could not check the pictures. ${state.error}`, attrs: { role: "alert" } }));
    else out.push(scButton("Check for pictures that look wrong", { action: "wrong-load", focus: "wrong-load", disabled: Boolean(state?.loading) }));
  } else if (!state.pictures.length) {
    out.push(scEl("p", { class: "sc-library-line", text: "No pictures look wrong.", data: { scWrongNone: "1" } }));
  } else {
    out.push(scEl("p", { class: "sc-library-line", text: state.notice, data: { scWrongCount: "1" } }));
    const list = scEl("ul", { class: "sc-library-list sc-wrong-list", attrs: { "aria-label": "Pictures that look wrong" } });
    for (const item of state.pictures) {
      const picture = scPicSuspectItem(item, labId);
      const key = picture.key;
      const li = scEl("li", { class: `sc-library-row sc-wrong-row sc-pic-row sc-wrong-${picture.level}`, data: { scWrongPicture: key } });
      const thumb = scPicThumb(picture);
      if (thumb) li.appendChild(thumb);
      const body = scEl("div", { class: "sc-pic-body" });
      const text = scEl("div", { class: "sc-wrong-text" });
      text.appendChild(scEl("span", { class: "sc-library-name", text: picture.title }));
      const chip = picture.levelText ? scChip(picture.levelText, picture.level === "definite" ? "warn" : "info", `sc-wrong-chip sc-wrong-chip-${picture.level}`) : null;
      text.appendChild(scEl("span", { class: "sc-library-meta" }, [`${picture.where} `, chip]));
      text.appendChild(scEl("p", { class: "sc-wrong-reason", text: picture.reason }));
      body.appendChild(text);
      const data = { scope: item.scope, labId: item.labId || "", filename: item.filename };
      const actions = scEl("div", { class: "sc-card-actions" });
      actions.appendChild(scButton("Keep this one", { action: "wrong-keep", data, focus: `wrong:${key}:keep`, aria: { "aria-label": `Keep this one: ${item.filename}` }, disabled: Boolean(scWrong.busy) }));
      actions.appendChild(scButton("Move to kept pictures", { action: "wrong-move", data, focus: `wrong:${key}:move`, aria: { "aria-label": `Move ${item.filename} to kept pictures` }, disabled: Boolean(scWrong.busy) }));
      body.appendChild(actions);
      li.appendChild(body);
      list.appendChild(li);
    }
    out.push(list);
    if (state.counts.definite > 1) {
      out.push(
        scButton(`Move the ${state.counts.definite} clearly wrong pictures to kept pictures`, { action: "wrong-move-all", focus: "wrong-move-all", disabled: Boolean(scWrong.busy) }),
      );
    }
  }
  const ask = scBuildWrongAsk(labId);
  if (ask) out.push(ask);
  if (scWrong.message) out.push(scEl("p", { class: `sc-banner sc-banner-${scWrong.message.variant === "ok" ? "ok" : "warn"}`, text: scWrong.message.text, attrs: { role: "status" }, data: { scWrongMessage: "1" } }));
  return out;
}

/** The "Pictures that look wrong" block for a lab's Advanced section. */
function scBuildWrongSection(labId) {
  scWrongEnsure(labId);
  return scEl("div", { class: "sc-wrong sc-adv-block", data: { scWrongHost: "1", labId: labId || "" } }, scWrongContents(labId));
}

function scRenderWrongHosts() {
  for (const host of document.querySelectorAll("[data-sc-wrong-host]")) {
    const labId = host.dataset.labId || "";
    const focusKey = typeof scActiveFocusKey === "function" ? scActiveFocusKey(host) : "";
    host.replaceChildren(...scWrongContents(labId));
    if (focusKey && typeof scFocusByKey === "function") scFocusByKey(host, focusKey);
  }
  if (typeof scPicViewRefresh === "function") scPicViewRefresh("suspect");
}

/** After a move or a keep: everything that counts pictures changed. */
async function scWrongAfterChange(labId) {
  scWrong.byKey = {};
  await scWrongLoad(labId, true);
  if (typeof scPicViewActionDone === "function") scPicViewActionDone("suspect");
  if (labId && typeof scRefreshLabState === "function") await scRefreshLabState(labId);
  if (typeof scRefreshLibraryNumbers === "function") scRefreshLibraryNumbers();
  scRenderWrongHosts();
  if (typeof scRerenderOpenCenter === "function") scRerenderOpenCenter();
}

async function scWrongMove(labId, items, { all = false } = {}) {
  scWrong.ask = null;
  scWrong.busy = true;
  scRenderWrongHosts();
  try {
    const body = all ? { dryRun: false, confirm: true, ...(labId ? { labId } : {}) } : { dryRun: false, confirm: true, items };
    const { ok, data, status } = await scFetchJson("/api/capture/suspect-pictures/quarantine", scJsonInit("POST", body));
    if (!ok) throw new Error(String(data.error || `Request failed (${status}).`));
    const moved = Array.isArray(data.moved) ? data.moved.length : 0;
    const failed = Array.isArray(data.failed) ? data.failed.length : 0;
    scWrong.message = moved
      ? { variant: failed ? "warn" : "ok", text: `${scPlural(moved, "picture")} moved to the kept pictures list. ${moved === 1 ? "Its screenshot is" : "Their screenshots are"} pending again.${failed ? ` ${scPlural(failed, "picture")} could not be moved.` : ""}` }
      : { variant: "warn", text: failed ? `${scPlural(failed, "picture")} could not be moved.` : "Nothing was moved." };
  } catch (err) {
    scWrong.message = { variant: "warn", text: `Could not move the pictures. ${err.message}` };
  } finally {
    scWrong.busy = false;
  }
  scAnnounce(scWrong.message.text);
  await scWrongAfterChange(labId);
  if (typeof scLoadKept === "function" && typeof scKeep !== "undefined" && scKeep.loaded) await scLoadKept(true);
}

async function scWrongKeep(labId, scope, pictureLab, filename) {
  const url = scope === "library" ? `/api/capture/library/screenshots/${encodeURIComponent(filename)}/confirm` : `/api/lab-builder/generated/${encodeURIComponent(pictureLab)}/screenshots/${encodeURIComponent(filename)}/confirm`;
  scWrong.busy = true;
  scRenderWrongHosts();
  try {
    const { ok, data, status } = await scFetchJson(url, scJsonInit("POST", {}));
    if (!ok || data.outcome !== "confirmed") throw new Error(String(data.error || `Request failed (${status}).`));
    scWrong.message = { variant: "ok", text: "Kept. This picture is not flagged again." };
  } catch (err) {
    scWrong.message = { variant: "warn", text: `Could not keep it. ${err.message}` };
  } finally {
    scWrong.busy = false;
  }
  scAnnounce(scWrong.message.text);
  await scWrongAfterChange(labId);
}

/** Actions from the "Pictures that look wrong" panel and its notice (called from the Screenshot Center's action switch). */
async function scWrongAction(labId, action, control) {
  const data = control?.dataset || {};
  if (scWrong.busy && (action === "wrong-keep" || action === "wrong-move")) return true;
  switch (action) {
    case "wrong-review": {
      const lab = scLab(labId);
      lab.ui.advancedOpen = true;
      if (typeof scRerender === "function") scRerender(labId);
      const host = document.querySelector("[data-sc-wrong-host]");
      host?.scrollIntoView?.({ behavior: "smooth", block: "center" });
      host?.querySelector?.("[data-sc-wrong-heading]")?.focus?.({ preventScroll: true });
      return true;
    }
    case "wrong-load":
      await scWrongLoad(labId, true);
      scRenderWrongHosts();
      return true;
    case "wrong-keep":
      await scWrongKeep(labId, data.scope, data.labId || "", data.filename);
      return true;
    case "wrong-move":
      await scWrongMove(labId, [{ scope: data.scope, ...(data.labId ? { labId: data.labId } : {}), filename: data.filename }]);
      return true;
    case "wrong-move-all": {
      const count = scWrongState(labId)?.counts.definite || 0;
      scWrong.ask = {
        title: "Move the clearly wrong pictures to kept pictures?",
        text: `${scPlural(count, "picture")} will move to the kept pictures list for 90 days. Their screenshots go back to pending. You can restore any of them. Pictures that only need a look stay where they are.`,
        yes: "Yes, move them",
        run: () => scWrongMove(labId, null, { all: true }),
      };
      scRenderWrongHosts();
      return true;
    }
    case "wrong-ask-yes": {
      const run = scWrong.ask?.run;
      scWrong.ask = null;
      if (typeof run === "function") await run();
      return true;
    }
    case "wrong-ask-cancel":
      scWrong.ask = null;
      scRenderWrongHosts();
      return true;
    default:
      return typeof scPicAction === "function" ? scPicAction(labId, action, control) : false;
  }
}
