// Screenshot Center: kept pictures, moving the shared library between computers, and the one-time "we found your pictures" notice.
// It lives in Advanced > Shared screenshot library. Network calls and DOM are here; the words come from the portal
// (the status line, each kept picture's reason), so the server and the page never disagree.
// All DOM is built with createElement and textContent; nothing from the network is ever parsed as HTML.

const scKeep = {
  loaded: false,
  loading: false,
  error: "",
  retentionDays: 90,
  entries: [],
  ask: null,
  message: null,
  busy: false,
  importResult: null,
  replaceExisting: false,
};

const SC_KEEP_EXPORT_HINT =
  "Export the shared library as a ZIP to use it on another computer or in Azure. Pictures were masked when they were captured, but check that no picture shows account names, email addresses, or customer data before you share the ZIP. Importing checks every picture again.";

/** "Nov 12, 2026" for a kept date (US English). */
const scKeepDate = (iso) => (typeof scFormatDate === "function" ? scFormatDate(iso) : String(iso || "").slice(0, 10));

async function scLoadKept(force = false) {
  if (scKeep.loading || (scKeep.loaded && !force)) return;
  scKeep.loading = true;
  scKeep.error = "";
  try {
    const { ok, data, status } = await scFetchJson("/api/capture/kept");
    if (!ok) throw new Error(String(data.error || `Request failed (${status}).`));
    scKeep.entries = Array.isArray(data.entries) ? data.entries : [];
    scKeep.retentionDays = scCount(data.retentionDays) || 90;
    scKeep.loaded = true;
  } catch (err) {
    scKeep.error = err.message;
  } finally {
    scKeep.loading = false;
  }
}

/** The status notice for a library that was found at its default folder, with a way to dismiss it. */
function scKeepNotice() {
  const notice = scState.status?.sharedLibrary?.notice;
  if (!notice?.text) return null;
  const box = scEl("div", { class: "sc-banner sc-banner-ok sc-keep-notice", attrs: { role: "status" }, data: { scKeepNotice: "1" } });
  box.appendChild(scEl("p", { text: scText(notice.text, 400) }));
  box.appendChild(scButton("Got it", { action: "keep-notice-dismiss", focus: "keep-notice-dismiss" }));
  return box;
}

const SC_KEEP_WHY = Object.freeze({
  "lab-only": "Specific to that lab.",
  "previous-version": "An earlier version of a picture.",
  "carry-failed": "Could not be copied into the new lab.",
  "looks-wrong": "Moved because it looked like the wrong screen.",
  "wrong-harness": "Moved because it was taken in a different harness than its screenshot needs.",
});

function scKeepWhy(picture) {
  // The server's sentence names both harnesses ("This picture is from the Microsoft Copilot harness, but this slot needs the Standard (Classic) harness."), so it is shown as it comes.
  if (picture.why === "wrong-harness") return scText(picture.message, 300) || SC_KEEP_WHY["wrong-harness"];
  return SC_KEEP_WHY[picture.why] || scText(picture.message, 240) || "Kept so you can restore it.";
}

function scKeepRestoreLabel(option) {
  return option.type === "library" ? "Restore to the shared library" : `Restore to \u201c${scText(option.title || option.labId, 60)}\u201d`;
}

function scBuildKeepAsk() {
  const ask = scKeep.ask;
  if (!ask) return null;
  const box = scEl("div", { class: "sc-ask", attrs: { role: "group", "aria-label": ask.title }, data: { scAsk: ask.kind } });
  box.appendChild(scEl("p", { class: "sc-ask-title", text: ask.title }));
  box.appendChild(scEl("p", { class: "sc-ask-text", text: ask.text }));
  const row = scEl("div", { class: "sc-card-actions" });
  row.appendChild(scButton(ask.yes, { action: "keep-ask-yes", primary: true, focus: "keep-ask-yes" }));
  row.appendChild(scButton("Cancel", { action: "keep-ask-cancel", focus: "keep-ask-cancel" }));
  box.appendChild(row);
  box.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault?.();
    event.stopPropagation?.();
    scKeep.ask = null;
    scRenderLibraryHost();
  });
  return box;
}

/** "From “Lab” (deleted Mar 1, 2026). 62 days left." for a kept entry. */
function scKeepEntryHead(entry) {
  const how = entry.reason === "replaced" ? "replaced" : entry.reason === "failed-build" ? "removed after a failed build" : entry.reason === "looks-wrong" ? "moved because they looked wrong" : entry.reason === "wrong-harness" ? "moved because they showed the wrong harness" : "deleted";
  const left = scCount(entry.daysLeft);
  return `From \u201c${scText(entry.labTitle || entry.labId, 80)}\u201d (${how} ${scKeepDate(entry.keptAt)}). ${scPlural(left, "day")} left.`;
}

function scBuildKeptEntry(entry) {
  const box = scEl("div", { class: "sc-keep-entry", data: { scKeptEntry: entry.id } });
  box.appendChild(scEl("p", { class: "sc-keep-entry-head", text: scKeepEntryHead(entry) }));
  const list = scEl("ul", { class: "sc-library-list", attrs: { "aria-label": `Kept pictures from ${scText(entry.labTitle || entry.labId, 80)}` } });
  for (const picture of entry.pictures || []) {
    const li = scEl("li", { class: "sc-library-row sc-keep-row sc-pic-row", data: { scKeptPicture: picture.filename } });
    const thumb = typeof scPicThumb === "function" ? scPicThumb(scPicKeptItem(entry, picture)) : null;
    if (thumb) li.appendChild(thumb);
    const body = scEl("div", { class: "sc-pic-body" });
    const text = scEl("div", { class: "sc-wrong-text" });
    text.appendChild(scEl("span", { class: "sc-library-name", text: picture.earlierVersion ? `${picture.base} (earlier version)` : picture.filename }));
    // The harness the picture was recorded as taken in, or "Harness not recorded".
    const harnessLines = typeof scPicHarnessLines === "function" ? scPicHarnessLines(scPicKeptHarness(picture)) : null;
    if (harnessLines) text.appendChild(harnessLines);
    text.appendChild(scEl("span", { class: "sc-library-meta", text: scKeepWhy(picture) }));
    body.appendChild(text);
    const actions = scEl("div", { class: "sc-card-actions" });
    const data = { entry: entry.id, filename: picture.filename };
    const option = Array.isArray(picture.restore) ? picture.restore[0] : null;
    if (option) {
      actions.appendChild(
        scButton(scKeepRestoreLabel(option), {
          action: "keep-restore",
          data: { ...data, to: option.type, labId: option.labId || "" },
          focus: `keep:${entry.id}:${picture.filename}:restore`,
          aria: { "aria-label": `${scKeepRestoreLabel(option)}: ${picture.filename}` },
        }),
      );
    } else {
      actions.appendChild(scEl("span", { class: "sc-library-meta", text: "Nowhere to put it back right now, so download it instead." }));
    }
    actions.appendChild(
      scEl("a", {
        class: "btn btn-sm",
        text: "Download",
        attrs: { href: `/api/capture/kept/${encodeURIComponent(entry.id)}/${encodeURIComponent(picture.filename)}?download=1`, "aria-label": `Download ${picture.filename}` },
      }),
    );
    actions.appendChild(scButton("Delete forever", { action: "keep-delete", data, focus: `keep:${entry.id}:${picture.filename}:delete`, aria: { "aria-label": `Delete ${picture.filename} forever` } }));
    body.appendChild(actions);
    li.appendChild(body);
    list.appendChild(li);
  }
  box.appendChild(list);
  return box;
}

/** The "Kept pictures" block and the "Move shared screenshots between computers" block, for the shared-library section. */
function scKeepContents() {
  const out = [];
  const kept = scEl("div", { class: "sc-keep sc-adv-block", data: { scKeptHost: "1" } });
  kept.appendChild(scEl("h6", { text: "Kept pictures", attrs: { tabindex: "-1" }, data: { scKeptHeading: "1", scFocus: "kept-heading" } }));
  kept.appendChild(
    scEl("p", {
      class: "hint",
      text: `When you delete or replace a lab, pictures that exist only in that lab are kept for ${scKeep.retentionDays} days, so you can restore them. Pictures in the shared library are never removed with a lab. Select a picture to see it full size.`,
    }),
  );
  const summary = scState.status?.sharedLibrary?.kept;
  if (!scKeep.loaded) {
    const count = scCount(summary?.pictures);
    if (count) kept.appendChild(scEl("p", { class: "sc-library-line", text: `${scPlural(count, "picture")} kept.`, data: { scKeptCount: "1" } }));
    kept.appendChild(scButton(count ? "Show kept pictures" : "Check for kept pictures", { action: "keep-load", focus: "keep-load", disabled: scKeep.loading }));
  } else if (!scKeep.entries.length) {
    kept.appendChild(scEl("p", { class: "sc-library-line", text: "No pictures are being kept right now.", data: { scKeptNone: "1" } }));
  } else {
    for (const entry of scKeep.entries) kept.appendChild(scBuildKeptEntry(entry));
  }
  if (scKeep.error) kept.appendChild(scEl("p", { class: "lb-error", text: `Could not load the kept pictures. ${scKeep.error}`, attrs: { role: "alert" } }));
  const ask = scBuildKeepAsk();
  if (ask) kept.appendChild(ask);
  if (scKeep.message) kept.appendChild(scEl("p", { class: `sc-banner sc-banner-${scKeep.message.variant === "ok" ? "ok" : "warn"}`, text: scKeep.message.text, attrs: { role: "status" } }));
  out.push(kept);

  const move = scEl("div", { class: "sc-keep-move sc-adv-block", data: { scMoveHost: "1" } });
  move.appendChild(scEl("h6", { text: "Move shared screenshots between computers" }));
  move.appendChild(scEl("p", { class: "hint", text: SC_KEEP_EXPORT_HINT }));
  const row = scEl("div", { class: "sc-step-actions" });
  row.appendChild(scEl("a", { class: "btn btn-sm", text: "Export shared screenshots", attrs: { href: "/api/capture/library/export", download: "shared-screenshots.zip" }, data: { scKeepExport: "1" } }));
  row.appendChild(scButton("Import screenshots", { action: "keep-import", focus: "keep-import", disabled: scKeep.busy }));
  move.appendChild(row);
  const replaceId = "sc-keep-replace";
  const replace = scEl("input", { id: replaceId, attrs: { type: "checkbox", autocomplete: "off" }, data: { scKeepReplace: "1" } });
  replace.checked = Boolean(scKeep.replaceExisting);
  replace.addEventListener("change", () => {
    scKeep.replaceExisting = Boolean(replace.checked);
  });
  move.appendChild(scEl("label", { class: "sc-check", attrs: { for: replaceId } }, [replace, scEl("span", { text: "Replace pictures the library already has (the old ones are kept as backups)" })]));
  const file = scEl("input", { class: "sr-only", attrs: { type: "file", accept: ".zip,application/zip", tabindex: "-1", "aria-hidden": "true", autocomplete: "off" }, data: { scKeepFile: "1" } });
  file.addEventListener("change", () => {
    const chosen = file.files?.[0];
    if (chosen) void scKeepImport(chosen);
    file.value = "";
  });
  move.appendChild(file);
  const result = scKeep.importResult;
  if (result) {
    const box = scEl("div", { class: `sc-feedback sc-feedback-${result.variant === "bad" ? "bad" : result.busy ? "warn" : "ok"}`, attrs: { role: "status" }, data: { scImportResult: "1" } });
    box.appendChild(scEl("p", { class: "sc-feedback-head", text: result.message }));
    if (result.items?.length) {
      const ul = scEl("ul", { class: "sc-feedback-list" });
      for (const item of result.items) ul.appendChild(scEl("li", { text: item }));
      box.appendChild(ul);
    }
    move.appendChild(box);
  }
  out.push(move);
  return out;
}

async function scKeepImport(file) {
  scKeep.busy = true;
  scKeep.importResult = { busy: true, message: "Importing screenshots.", items: [] };
  scRenderLibraryHost();
  try {
    const { ok, data, status } = await scFetchJson(`/api/capture/library/import${scKeep.replaceExisting ? "?replace=true" : ""}`, { method: "POST", headers: { "Content-Type": "application/zip" }, body: file });
    if (!ok) throw new Error(String(data.error || `Request failed (${status}).`));
    const rows = [...(data.skipped || []), ...(data.rejected || []), ...(data.needsReview || [])].slice(0, 12).map((r) => `${scText(r.filename, 80)}: ${scText(r.message, 200)}`);
    scKeep.importResult = { variant: "ok", message: scText(data.message, 300) || "Import finished.", items: rows };
    scAnnounce(scKeep.importResult.message);
    scRefreshLibraryNumbers();
  } catch (err) {
    scKeep.importResult = { variant: "bad", message: `Could not import the screenshots. ${err.message}`, items: [] };
    scAnnounce(scKeep.importResult.message);
  } finally {
    scKeep.busy = false;
  }
  scRenderLibraryHost();
}

async function scKeepRestore(entry, filename, to, labId) {
  scKeep.ask = null;
  const { ok, data, status } = await scFetchJson(`/api/capture/kept/${encodeURIComponent(entry)}/${encodeURIComponent(filename)}/restore`, scJsonInit("POST", { to, ...(labId ? { labId } : {}), confirm: to === "library" }));
  scKeep.message = ok
    ? { variant: "ok", text: to === "library" ? "Restored to the shared library. Every lab can use it." : "Restored to the lab." }
    : { variant: "warn", text: String(data.error || `Could not restore it (${status}).`) };
  scAnnounce(scKeep.message.text);
  await scLoadKept(true);
  if (typeof scPicViewActionDone === "function") scPicViewActionDone("kept");
  if (ok) scRefreshLibraryNumbers();
  else scRenderLibraryHost();
}

async function scKeepDelete(entry, filename) {
  scKeep.ask = null;
  const { ok, data, status } = await scFetchJson(`/api/capture/kept/${encodeURIComponent(entry)}/${encodeURIComponent(filename)}?confirm=true`, { method: "DELETE" });
  scKeep.message = ok ? { variant: "ok", text: "Deleted forever." } : { variant: "warn", text: String(data.error || `Could not delete it (${status}).`) };
  scAnnounce(scKeep.message.text);
  await scLoadKept(true);
  if (typeof scPicViewActionDone === "function") scPicViewActionDone("kept");
  scRenderLibraryHost();
}

/** Actions from the kept-pictures and move-screenshots controls (called from the Screenshot Center's action switch). */
async function scKeepAction(labId, action, control) {
  const data = control?.dataset || {};
  switch (action) {
    case "keep-load":
      await scLoadKept(true);
      scRenderLibraryHost();
      return true;
    case "keep-notice-dismiss": {
      await scFetchJson("/api/capture/library/notice/dismiss", scJsonInit("POST", {}));
      if (scState.status?.sharedLibrary) scState.status.sharedLibrary.notice = null;
      scRerenderOpenCenter();
      scRenderLibraryHost();
      return true;
    }
    case "keep-restore":
      if (data.to === "library") {
        scKeep.ask = {
          kind: "keep-restore",
          title: "Use this picture for every lab?",
          text: "Every lab that has no picture of its own will show it. Check that it shows no account names, email addresses, or customer data.",
          yes: "Yes, restore it to the shared library",
          run: () => scKeepRestore(data.entry, data.filename, "library", ""),
        };
        scRenderLibraryHost();
        return true;
      }
      await scKeepRestore(data.entry, data.filename, "lab", data.labId || "");
      return true;
    case "keep-delete":
      scKeep.ask = {
        kind: "keep-delete",
        title: "Delete this picture forever?",
        text: "It is removed from the kept pictures and cannot be restored.",
        yes: "Yes, delete it forever",
        run: () => scKeepDelete(data.entry, data.filename),
      };
      scRenderLibraryHost();
      return true;
    case "keep-ask-yes": {
      const run = scKeep.ask?.run;
      scKeep.ask = null;
      if (typeof run === "function") await run();
      return true;
    }
    case "keep-ask-cancel":
      scKeep.ask = null;
      scRenderLibraryHost();
      return true;
    case "keep-import":
      document.querySelector("[data-sc-keep-file]")?.click?.();
      return true;
    default:
      return false;
  }
}
