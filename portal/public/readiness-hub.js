// Readiness hub: one plain-language "Setup checklist" at the top of Configuration, and a
// compact first-run banner at the top of Build that points to it. Eight rows, each with a live
// status, a short explanation, and one button that fixes it. Nothing here blocks building a lab.
//
// Reuses what already exists: the brand profile store and editor (app.js), the capture status,
// the pairing card, and the address helpers (screenshot-center*.js), and the bulk Microsoft Learn
// scan (generated-labs.js). All DOM is built with createElement and textContent, so nothing from
// the network (profile names, computer names, messages) is ever parsed as HTML.
// Loaded as a classic script after lab-customize.js: every name is global and starts with "rh".

const RH_BANNER_DISMISSED_KEY = "rh-banner-dismissed";
const RH_BANNER_DONE_KEY = "rh-banner-done";
const RH_ADDRESS_TOTAL = 6;
const RH_ACTIONABLE = Object.freeze(["todo", "partial", "attention"]);

const rhMemoryFlags = new Map();

const rhState = {
  storage: { data: null, error: "", loading: false },
  drift: { data: null, error: "", loading: false },
  profileError: "",
  busy: "",
  helpOpen: false,
  refreshing: null,
  refreshingScope: "",
  bound: false,
};

// ── Small helpers ───────────────────────────────────────────────────────────

function rhText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function rhFlag(key) {
  try {
    return localStorage.getItem(key) === "1" || rhMemoryFlags.get(key) === true;
  } catch {
    return rhMemoryFlags.get(key) === true;
  }
}

function rhSetFlag(key) {
  rhMemoryFlags.set(key, true);
  try {
    localStorage.setItem(key, "1");
  } catch {
    /* storage unavailable: the choice lasts for this page view */
  }
}

/** True when the portal runs on the same computer as the browser, so "this computer" is the honest wording. */
function rhIsLocalHost(hostname) {
  const host = String(hostname ?? (typeof location !== "undefined" ? location.hostname : "")).toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

function rhDefaultBrand() {
  return typeof BRAND_DEFAULT_PROFILE !== "undefined" ? BRAND_DEFAULT_PROFILE : { companyName: "Dynamic Microsoft Training and Lab Generator", primaryColor: "#4f8ff7" };
}

function rhNormalizeHex(value) {
  if (typeof brandNormalizeHex === "function") return brandNormalizeHex(value);
  const match = String(value ?? "").trim().match(/^#?([0-9a-f]{6})$/i);
  return match ? `#${match[1].toLowerCase()}` : null;
}

/** Which of the three brand essentials a profile has: a company name, a logo, and a primary color. */
function rhBrandFacts(profile) {
  const fallback = rhDefaultBrand();
  const company = rhText(profile?.companyName);
  const color = rhNormalizeHex(profile?.primaryColor);
  const facts = {
    company: Boolean(company) && company.toLowerCase() !== String(fallback.companyName).toLowerCase(),
    logo: Boolean(rhText(profile?.logo)),
    color: Boolean(color) && color !== String(fallback.primaryColor).toLowerCase(),
  };
  facts.complete = facts.company && facts.logo && facts.color;
  facts.any = facts.company || facts.logo || facts.color;
  return facts;
}

function rhJoin(names, max = 3) {
  return typeof scJoinNames === "function" ? scJoinNames(names, max) : names.join(", ");
}

function rhPlural(n, singular, plural) {
  return `${n} ${n === 1 ? singular : plural || `${singular}s`}`;
}

function rhFormatDate(iso) {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

// ── Rows: pure decisions, no DOM ────────────────────────────────────────────

function rhRow(id, title, kind, essential) {
  return { id, title, kind, essential, state: "todo", detail: "", actions: [], help: "" };
}

/** A row whose data could not be read yet (loading) or at all (error). */
function rhUnavailable(row, source, error, what) {
  if (source.loading) {
    row.state = "loading";
    row.detail = "Checking.";
    return row;
  }
  row.state = "error";
  row.detail = `We could not check ${what}. Try again in a moment.`;
  row.actions = [{ id: "refresh", label: "Check again" }];
  return row;
}

function rhActiveProfile(input) {
  const store = input.profiles || {};
  return (store.profiles || []).find((profile) => profile.id === store.activeProfileId) || null;
}

function rhBrandRow(input) {
  const row = rhRow("brand", "Brand profile", "recommended", true);
  const store = input.profiles || {};
  if (!store.loaded) return rhUnavailable(row, { loading: !store.error }, store.error, "your brand profiles");
  const active = rhActiveProfile(input);
  const facts = rhBrandFacts(active);
  const missing = [];
  if (!facts.company) missing.push("company name");
  if (!facts.logo) missing.push("logo");
  if (!facts.color) missing.push("primary color");
  const field = !facts.company ? "companyName" : !facts.logo ? "logo" : "primaryColor";

  if (!missing.length) {
    row.state = "done";
    row.detail = `The ${active.name} profile is active with your company name, logo, and primary color. Every lab uses it unless you pick another profile.`;
    row.actions = [{ id: "brand-edit", label: "Edit brand profile", data: { field: "companyName" } }];
    return row;
  }
  if (missing.length === 3) {
    const other = (store.profiles || []).find((profile) => profile !== active && rhBrandFacts(profile).complete);
    if (other) {
      row.detail = `Your portal still uses the standard look. The ${other.name} profile has your branding, but it is not the active profile.`;
      row.actions = [{ id: "brand-edit", label: "Open brand profiles", data: { field: "name" }, primary: true }];
    } else {
      row.detail = "Your portal and labs use the standard look. Add your company name, logo, and primary color so every lab looks like yours.";
      row.actions = [{ id: "brand-create", label: "Create a brand profile", primary: true }];
    }
    return row;
  }
  row.state = "partial";
  row.detail = `Almost there. Still to add to the ${active.name} profile: ${rhJoin(missing)}.`;
  row.actions = [{ id: "brand-edit", label: "Finish brand profile", data: { field }, primary: true }];
  return row;
}

function rhLinksRow(input) {
  const row = rhRow("links", "Learner links", "recommended", true);
  const store = input.profiles || {};
  if (!store.loaded) return rhUnavailable(row, { loading: !store.error }, store.error, "your brand profiles");
  const active = rhActiveProfile(input);
  const hasInfo = Boolean(rhText(active?.moreInfoUrl));
  const hasContact = Boolean(rhText(active?.supportName) || rhText(active?.supportEmail));
  if (hasInfo && hasContact) {
    row.state = "done";
    const label = rhText(active.moreInfoLabel) || "More information";
    const who = rhText(active.supportName) || rhText(active.supportEmail);
    row.detail = `Learners see a "${label}" link and can reach ${who} for help.`;
    row.actions = [{ id: "links-edit", label: "Edit learner links", data: { field: "moreInfoUrl" } }];
    return row;
  }
  if (hasInfo || hasContact) {
    row.state = "partial";
    row.detail = hasInfo ? "Add a support contact so learners know who to ask when they get stuck." : "Add a more information link so learners know where to learn more.";
    row.actions = [{ id: "links-edit", label: hasInfo ? "Add a support contact" : "Add a more information link", data: { field: hasInfo ? "supportName" : "moreInfoUrl" }, primary: true }];
    return row;
  }
  row.detail = "Learners do not see a more information link or a support contact yet. Add them so people know where to learn more and who to ask.";
  row.actions = [{ id: "links-edit", label: "Add learner links", data: { field: "moreInfoUrl" }, primary: true }];
  return row;
}

function rhTenantRow(input) {
  const row = rhRow("tenant", "Tenant addresses", "optional", false);
  const store = input.profiles || {};
  if (!store.loaded) return rhUnavailable(row, { loading: !store.error }, store.error, "your brand profiles");
  const active = rhActiveProfile(input);
  const names = typeof scAddressNames === "function" ? scAddressNames(active || {}) : [];
  const firstMissing = (typeof SC_ADDRESS_FIELDS !== "undefined" ? SC_ADDRESS_FIELDS : []).find(([field]) => !rhText(active?.[field]));
  const field = firstMissing ? firstMissing[0] : "copilotStudioUrl";
  const serverSet = Boolean(input.status?.tenantUrls?.set);
  if (names.length >= RH_ADDRESS_TOTAL) {
    row.state = "done";
    row.detail = `All ${RH_ADDRESS_TOTAL} addresses are set, so screenshots show your own tenant.`;
    row.actions = [{ id: "tenant-edit", label: "Change addresses", data: { field } }];
  } else if (names.length) {
    row.state = "partial";
    row.detail = `${names.length} of ${RH_ADDRESS_TOTAL} addresses are set: ${rhJoin(names)}. Add the rest to capture those screens in your tenant.`;
    row.actions = [{ id: "tenant-edit", label: "Add the rest", data: { field }, primary: true }];
  } else if (serverSet) {
    row.state = "done";
    row.detail = "Your portal administrator already set default tenant addresses.";
    row.actions = [{ id: "tenant-edit", label: "Add your own", data: { field } }];
  } else {
    row.detail = "Only needed for screenshots of your own tenant. Add your Copilot Studio, Power Platform, SharePoint, Microsoft 365 admin, and Foundry addresses.";
    row.actions = [{ id: "tenant-edit", label: "Add tenant addresses", data: { field } }];
  }
  return row;
}

function rhComputerRow(input) {
  const row = rhRow("computer", "Screenshot computer", "recommended", true);
  row.pairing = true;
  const status = input.status;
  if (!status) return rhUnavailable(row, { loading: !input.statusError }, input.statusError, "whether a screenshot computer is connected");
  const companion = status.companion || {};
  const devices = Array.isArray(companion.devices) ? companion.devices : [];
  const nameOf = (device) => rhText(device.name) || "Unnamed computer";
  const counts = new Map();
  for (const device of devices.filter((item) => item.connected)) counts.set(nameOf(device), (counts.get(nameOf(device)) || 0) + 1);
  const online = [...counts].map(([name, n]) => (n > 1 ? `${name} (${n} connections)` : name));
  if (companion.connected) {
    row.state = "done";
    row.detail = `Connected: ${rhJoin(online, 2) || "your computer"}. Screenshots are captured on that computer, so they can use your sign-ins.`;
    row.actions = [{ id: "computer-connect", label: "Connect another computer" }];
  } else if (devices.length) {
    row.state = "attention";
    row.detail = `${rhJoin([...new Set(devices.map(nameOf))], 2)} ${new Set(devices.map(nameOf)).size === 1 ? "is" : "are"} paired but not running right now. Start the Local Capture Companion on it, or connect a different computer.`;
    row.actions = [{ id: "computer-connect", label: "Connect a computer", primary: true }];
  } else {
    row.detail = "No computer is connected. Screenshots are taken on your own computer so they can use your sign-ins. It takes about two minutes. You can also add screenshots by hand.";
    row.actions = [{ id: "computer-connect", label: "Connect your computer", primary: true }];
  }
  return row;
}

function rhSigninRow(input) {
  const row = rhRow("signin", "Signed in to products", "optional", false);
  const status = input.status;
  if (!status) return rhUnavailable(row, { loading: !input.statusError }, input.statusError, "your product sign-ins");
  const companion = status.companion || {};
  if (!companion.connected) {
    row.state = "locked";
    row.detail = "Connect a screenshot computer first. Then you sign in once per product, and it is remembered.";
    return row;
  }
  const signedIn = (Array.isArray(companion.signedInProducts) ? companion.signedInProducts : []).map((id) => (typeof scProductName === "function" ? scProductName(id) : String(id)));
  if (signedIn.length) {
    row.state = "done";
    row.detail = `Signed in to ${rhJoin(signedIn)} on your screenshot computer.`;
  } else {
    row.detail = "Not signed in to any product yet. The first screenshot for each product opens a browser window on your computer. Sign in there once and it is remembered.";
  }
  row.actions = [{ id: "screenshots-open", label: "Open Screenshot Center" }];
  return row;
}

function rhLibraryRow(input) {
  const row = rhRow("library", "Screenshot library", "optional", false);
  const status = input.status;
  if (!status) return rhUnavailable(row, { loading: !input.statusError }, input.statusError, "the screenshot library");
  const library = status.sharedLibrary || {};
  const total = typeof scCount === "function" ? scCount(library.total) : Number(library.total) || 0;
  const captured = typeof scCount === "function" ? scCount(library.captured) : Number(library.captured) || 0;
  const missing = typeof scCount === "function" ? scCount(library.missing) : Number(library.missing) || 0;
  const review = typeof scCount === "function" ? scCount(library.needsReview) : Number(library.needsReview) || 0;
  const counts = `${captured} of ${total} shared screenshots are captured and ${missing} are missing.`;
  const where = input.local ? "this computer" : "this server";
  const keeps = library.persistent || input.local;
  row.actions = [{ id: "screenshots-open", label: "Open Screenshot Center" }];
  if (review > 0) {
    row.state = "attention";
    row.detail = `${rhPlural(review, "screenshot")} ${review === 1 ? "is" : "are"} waiting for your review. ${counts}`;
    row.actions[0].primary = true;
  } else if (!keeps) {
    row.state = "attention";
    row.detail = `${counts} New screenshots are stored only on ${where} and can be lost when the portal restarts.`;
  } else if (captured === 0) {
    row.detail = `No shared screenshots are captured yet. Labs show "Screenshot pending" until an image is captured or added by hand.`;
  } else {
    row.state = "done";
    row.detail = `${counts} ${library.persistent ? "They are saved permanently." : `They are stored on ${where}.`}`;
  }
  return row;
}

const RH_BACKEND_NAMES = Object.freeze({ "azure-blob": "Azure Blob Storage", "azure-files": "Azure Files", "custom-volume": "a mounted volume" });

function rhStorageRow(input) {
  const row = rhRow("storage", "Storage", "optional", false);
  const storage = input.storage;
  if (!storage) return rhUnavailable(row, { loading: !input.storageError }, input.storageError, "where your labs are stored");
  const blob = storage.blobSync || {};
  const where = input.local ? "this computer" : "this server";
  const backend = RH_BACKEND_NAMES[storage.backend] || "permanent storage";
  if (storage.persistent && storage.writable !== false && (!blob.enabled || blob.healthy !== false)) {
    row.state = "done";
    row.detail = `Your labs are saved permanently (${backend}). They survive a restart.`;
    return row;
  }
  row.help = input.local
    ? "Labs and settings are saved in folders next to the portal on this computer. Back those folders up, or download the labs you want to keep. To save them somewhere permanent, set the PORTAL_STORAGE_ROOT environment variable to a folder or volume that persists."
    : "Ask your portal administrator to turn on permanent storage: connect an Azure Blob Storage account (AZURE_STORAGE_BLOB_ENDPOINT) or mount a persistent volume (PORTAL_STORAGE_ROOT). Until then, download the labs you want to keep. See Persistent storage in docs/lab-builder.md.";
  row.actions = [{ id: "storage-help", label: rhState.helpOpen ? "Hide the steps" : "Show how to fix this" }];
  if (storage.persistent) {
    row.state = "attention";
    row.detail = `Permanent storage is set up, but it is not working right now: ${storage.writable === false ? "the portal cannot write to it" : "saving to Azure Blob Storage is failing"}. New labs may be lost when the portal restarts.`;
  } else {
    row.state = input.local ? "todo" : "attention";
    row.detail = `Labs are stored only on ${where}. ${input.local ? "They stay here until you delete them." : "They can be lost when the portal restarts or is redeployed."}`;
  }
  return row;
}

function rhLearnRow(input) {
  const row = rhRow("learn", "Microsoft Learn freshness", "optional", false);
  const drift = input.drift;
  if (!drift) return rhUnavailable(row, { loading: !input.driftError }, input.driftError, "your labs against Microsoft Learn");
  const counts = drift.counts || {};
  const total = typeof scCount === "function" ? scCount(counts.total) : Number(counts.total) || 0;
  const changed = typeof scCount === "function" ? scCount(counts.docsUpdated) : Number(counts.docsUpdated) || 0;
  const unchecked = typeof scCount === "function" ? scCount(counts.notChecked) : Number(counts.notChecked) || 0;
  const busy = input.busy === "learn";
  const scan = (label) => ({ id: "learn-scan", label: busy ? "Checking your labs" : label, busy });
  if (!total) {
    row.state = "locked";
    row.detail = "You have no saved labs yet. Once you build one, you can check it against Microsoft Learn to catch changes to product steps.";
    row.actions = [{ id: "build-open", label: "Build a lab" }];
    return row;
  }
  if (changed > 0) {
    row.state = "attention";
    row.detail = `${rhPlural(changed, "lab")} ${changed === 1 ? "needs" : "need"} updates because Microsoft Learn changed.`;
    row.actions = [{ ...scan("Check all labs again"), primary: true }, { id: "learn-show", label: "Show them" }];
  } else if (unchecked > 0) {
    row.state = "todo";
    row.detail =
      unchecked === total
        ? total === 1
          ? "Your lab has not been checked against Microsoft Learn yet."
          : `None of your ${rhPlural(total, "lab")} have been checked against Microsoft Learn yet.`
        : `${unchecked} of your ${rhPlural(total, "lab")} ${unchecked === 1 ? "has" : "have"} not been checked against Microsoft Learn yet.`;
    row.actions = [{ ...scan("Check all labs now"), primary: true }];
  } else {
    row.state = "done";
    const when = rhFormatDate(drift.lastBulkScanAt);
    row.detail = `All ${rhPlural(total, "lab")} match Microsoft Learn.${when ? ` Last checked ${when}.` : ""}`;
    row.actions = [scan("Check again")];
  }
  return row;
}

/** The eight rows, in the order a person should work through them. Only the first open row keeps a primary button. */
function rhBuildRows(input) {
  const rows = [rhBrandRow(input), rhLinksRow(input), rhTenantRow(input), rhComputerRow(input), rhSigninRow(input), rhLibraryRow(input), rhStorageRow(input), rhLearnRow(input)];
  let primaryTaken = false;
  for (const row of rows) {
    const hasPrimary = row.actions.some((action) => action.primary);
    if (hasPrimary && !primaryTaken) primaryTaken = true;
    else if (hasPrimary) row.actions = row.actions.map((action) => ({ ...action, primary: false }));
  }
  return rows;
}

/** The headline, count, and tone for the whole checklist. */
function rhSummarize(rows) {
  const ready = rows.filter((row) => row.state === "done").length;
  const recommended = rows.filter((row) => row.essential);
  const recommendedLeft = recommended.filter((row) => row.state !== "done").length;
  const attention = rows.filter((row) => row.state === "attention" || row.state === "error").length;
  const checking = rows.some((row) => row.state === "loading");
  let message;
  let tone;
  if (checking) {
    message = "Checking your setup.";
    tone = "info";
  } else if (ready === rows.length) {
    message = "Everything is ready.";
    tone = "ok";
  } else if (!recommendedLeft) {
    message = "The recommended setup is done. The rest is optional and can wait.";
    tone = "ok";
  } else {
    message = `${rhPlural(recommendedLeft, "recommended step")} left. You can build labs at any time.`;
    tone = "warn";
  }
  if (attention && !checking) message += ` ${rhPlural(attention, "item")} ${attention === 1 ? "needs" : "need"} attention.`;
  return { ready, total: rows.length, text: `${ready} of ${rows.length} ready`, message, tone, recommendedLeft };
}

/** What the first-run banner shows, or `show: false` once the recommended steps are done or dismissed. */
function rhBannerModel(rows, { dismissed = false, finished = false } = {}) {
  const essentials = rows.filter((row) => row.essential);
  const done = essentials.filter((row) => row.state === "done").length;
  const open = essentials.filter((row) => RH_ACTIONABLE.includes(row.state));
  return {
    show: !dismissed && !finished && open.length > 0,
    complete: essentials.length > 0 && done === essentials.length,
    done,
    total: essentials.length,
    open: open.map((row) => row.title),
  };
}

// ── State and data ──────────────────────────────────────────────────────────

function rhInput() {
  const store = typeof brandProfiles !== "undefined" ? brandProfiles : null;
  const status = typeof scState !== "undefined" ? scState.status : null;
  const statusError = typeof scState !== "undefined" ? scState.statusError : "";
  const storage = rhState.storage.data || (status?.sharedLibrary?.storage ? rhStorageFromStatus(status.sharedLibrary.storage) : null);
  return {
    profiles: store ? { loaded: Boolean(store.loaded), error: store.loaded ? "" : rhState.profileError || "", profiles: store.profiles || [], activeProfileId: store.activeProfileId } : { loaded: false, error: "", profiles: [] },
    status,
    statusError,
    storage,
    storageError: rhState.storage.error,
    drift: rhState.drift.data,
    driftError: rhState.drift.error,
    local: rhIsLocalHost(),
    busy: rhState.busy,
  };
}

/** The capture status carries the same storage facts when the health check is unavailable. */
function rhStorageFromStatus(storage) {
  return { persistent: Boolean(storage.persistent), backend: storage.backend, writable: storage.writable, blobSync: { enabled: Boolean(storage.blobSyncEnabled), healthy: true } };
}

async function rhLoadStorage() {
  rhState.storage.loading = true;
  try {
    const res = await fetch("/healthz", { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.storage) throw new Error(`Request failed (${res.status})`);
    rhState.storage.data = data.storage;
    rhState.storage.error = "";
  } catch (err) {
    rhState.storage.error = err.message || "Could not read the storage status.";
  } finally {
    rhState.storage.loading = false;
  }
}

async function rhLoadDrift() {
  rhState.drift.loading = true;
  try {
    const res = await fetch("/api/lab-builder/learn-drift");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
    rhState.drift.data = { counts: data.counts || {}, lastBulkScanAt: typeof data.lastBulkScanAt === "string" ? data.lastBulkScanAt : null };
    rhState.drift.error = "";
  } catch (err) {
    rhState.drift.error = err.message || "Could not read the Microsoft Learn status.";
  } finally {
    rhState.drift.loading = false;
  }
}

/**
 * Load everything the checklist shows. The Build banner only needs the brand profiles and the
 * capture status (`scope: "banner"`); the Configuration card also reads storage and Learn freshness.
 */
function rhRefresh({ scope = "all", force = false, announce = false } = {}) {
  if (rhState.refreshing && !force) {
    if (scope === "banner" || rhState.refreshingScope === "all") return rhState.refreshing;
    return rhState.refreshing.then(() => rhRefresh({ scope, force, announce }));
  }
  const tasks = [];
  if (typeof bpEnsureLoaded === "function") {
    tasks.push(
      bpEnsureLoaded(force).catch((err) => {
        rhState.profileError = err.message || "Could not load brand profiles.";
      }),
    );
  }
  if (typeof scLoadStatus === "function") tasks.push(scLoadStatus(force));
  if (scope === "all") {
    tasks.push(rhLoadStorage());
    tasks.push(rhLoadDrift());
  }
  rhState.refreshingScope = scope;
  rhRender();
  const run = Promise.allSettled(tasks).then(() => {
    if (rhState.refreshing === run) {
      rhState.refreshing = null;
      rhState.refreshingScope = "";
    }
    rhRender();
    if (announce) rhAnnounceSummary();
  });
  rhState.refreshing = run;
  return run;
}

function rhHubVisible() {
  const panel = document.getElementById("panel-config");
  return Boolean(panel?.classList?.contains("active"));
}

/** Called by app.js when a tab opens. */
function rhOnTabShown(tabName) {
  if (tabName === "config") void rhRefresh({ scope: "all" });
  else if (tabName === "labbuilder") void rhRefresh({ scope: "banner" });
}

/** Called by app.js after the brand profiles were saved, activated, or reloaded. */
function rhOnBrandChanged() {
  rhRender();
}

/** Called by the Screenshot Center when a computer connects or disconnects. */
function rhOnStatusChanged() {
  rhRender();
}

// ── Rendering ───────────────────────────────────────────────────────────────

const RH_ICONS = Object.freeze({ done: "\u25cf", todo: "\u25cb", partial: "\u25d0", attention: "!", locked: "\u2026", loading: "\u2026", error: "!" });
const RH_TONES = Object.freeze({ done: "ok", todo: "warn", partial: "warn", attention: "warn", locked: "neutral", loading: "info", error: "bad" });

function rhStateLabel(row) {
  if (row.state === "done") return "Ready";
  if (row.state === "todo") return row.kind === "optional" ? "Not set up" : "To do";
  if (row.state === "partial") return "In progress";
  if (row.state === "attention") return "Needs attention";
  if (row.state === "locked") return "Waiting";
  if (row.state === "loading") return "Checking";
  return "Problem";
}

function rhTone(row) {
  return row.state === "todo" && row.kind === "optional" ? "neutral" : RH_TONES[row.state] || "neutral";
}

function rhRowSignature(row) {
  return JSON.stringify([row.state, row.detail, row.actions, row.kind, row.pairing && "p", row.id === "storage" && rhState.helpOpen ? row.help : ""]);
}

function rhBuildRow(row) {
  const li = scEl("li", { class: "rh-row", id: `rh-row-${row.id}`, data: { state: row.state, row: row.id, sig: rhRowSignature(row) } });
  li.appendChild(scEl("span", { class: "rh-icon", text: RH_ICONS[row.state] || "\u25cb", attrs: { "aria-hidden": "true" } }));
  const body = scEl("div", { class: "rh-body" });
  const title = scEl("p", { class: "rh-row-title" });
  title.appendChild(scEl("strong", { text: row.title }));
  title.appendChild(scChip(row.kind === "optional" ? "Optional" : "Recommended", row.kind === "optional" ? "neutral" : "info"));
  title.appendChild(scChip(rhStateLabel(row), rhTone(row)));
  body.appendChild(title);
  body.appendChild(scEl("p", { class: "rh-row-detail", id: `rh-detail-${row.id}`, text: row.detail }));
  if (row.help) {
    const help = scEl("p", { class: "rh-help", id: "rh-storage-help", text: row.help });
    help.hidden = !rhState.helpOpen;
    body.appendChild(help);
  }
  if (row.pairing) body.appendChild(scEl("div", { class: "rh-pairing", attrs: { "data-sc-pairing-host": "readiness" } }));
  li.appendChild(body);
  if (row.actions.length) {
    const actions = scEl("div", { class: "rh-actions" });
    for (const action of row.actions) {
      const attrs = { type: "button", "aria-label": `${action.label}: ${row.title}` };
      if (action.busy) {
        attrs["aria-busy"] = "true";
        attrs.disabled = true;
      }
      if (action.id === "storage-help") {
        attrs["aria-expanded"] = rhState.helpOpen ? "true" : "false";
        attrs["aria-controls"] = "rh-storage-help";
      }
      actions.appendChild(
        scEl("button", {
          class: `btn btn-sm${action.primary ? " btn-primary" : ""}`,
          text: action.label,
          attrs,
          data: { rhAction: action.id, rhField: action.data?.field },
        }),
      );
    }
    li.appendChild(actions);
  }
  return li;
}

/** Keep the pairing card (owned by the Screenshot Center) working after its row was rebuilt. */
function rhRestorePairing(focusKey) {
  if (typeof scRefreshPairingUi !== "function") return;
  scRefreshPairingUi();
  const host = document.querySelector('[data-sc-pairing-host="readiness"]');
  if (host && focusKey && typeof scFocusByKey === "function") scFocusByKey(host, focusKey);
}

function rhActiveKey(root) {
  const active = document.activeElement;
  if (!active || !root || !root.contains(active)) return null;
  if (active.dataset?.rhAction) return { type: "rh", value: active.dataset.rhAction };
  return null;
}

function rhRender() {
  const list = document.getElementById("rh-list");
  const rows = rhBuildRows(rhInput());
  if (list) {
    const pairHost = list.querySelector('[data-sc-pairing-host="readiness"]');
    const pairFocus = pairHost && typeof scActiveFocusKey === "function" ? scActiveFocusKey(pairHost) : "";
    const focusKey = rhActiveKey(list);
    let pairingRebuilt = false;
    rows.forEach((row, index) => {
      const existing = list.children[index];
      if (existing && existing.dataset.row === row.id && existing.dataset.sig === rhRowSignature(row)) return;
      const next = rhBuildRow(row);
      if (row.pairing) pairingRebuilt = true;
      if (existing) existing.replaceWith(next);
      else list.appendChild(next);
    });
    while (list.children.length > rows.length) list.removeChild(list.children[list.children.length - 1]);
    if (pairingRebuilt) rhRestorePairing(pairFocus);
    if (focusKey?.type === "rh") {
      const again = list.querySelector(`[data-rh-action="${focusKey.value}"]`);
      if (again && document.activeElement !== again) again.focus({ preventScroll: true });
    }
    list.removeAttribute("aria-busy");
  }
  rhRenderSummary(rhSummarize(rows));
  rhRenderBanner(rows);
}

/** Only touch the live region when the words change, so a screen reader never repeats itself. */
function rhRenderSummary(summary) {
  const count = document.getElementById("rh-count");
  const message = document.getElementById("rh-message");
  const bar = document.getElementById("rh-progress");
  const fill = document.getElementById("rh-progress-fill");
  if (count && count.textContent !== summary.text) count.textContent = summary.text;
  if (message && message.textContent !== summary.message) message.textContent = summary.message;
  if (bar) {
    bar.setAttribute("aria-valuemax", String(summary.total));
    bar.setAttribute("aria-valuenow", String(summary.ready));
    bar.setAttribute("aria-valuetext", summary.text);
  }
  if (fill) fill.style.width = `${Math.round((summary.ready / summary.total) * 100)}%`;
}

function rhAnnounceSummary() {
  const summary = rhSummarize(rhBuildRows(rhInput()));
  rhAnnounce(`${summary.text}. ${summary.message}`);
}

function rhRenderBanner(rows) {
  const banner = document.getElementById("rh-banner");
  if (!banner) return;
  const model = rhBannerModel(rows, { dismissed: rhFlag(RH_BANNER_DISMISSED_KEY), finished: rhFlag(RH_BANNER_DONE_KEY) });
  if (model.complete) rhSetFlag(RH_BANNER_DONE_KEY);
  banner.hidden = !model.show;
  if (!model.show) return;
  const text = document.getElementById("rh-banner-text");
  if (text) {
    text.textContent = `${model.done} of ${model.total} done. Still to do: ${rhJoin(model.open.map((name) => name.toLowerCase()))}. You can build a lab right now and finish setting up later.`;
  }
}

// ── Actions ─────────────────────────────────────────────────────────────────

/** Announce through the page-level live region, which still works while the Configuration tab is hidden. */
function rhAnnounce(message) {
  const el = document.getElementById("app-live") || document.getElementById("rh-status");
  if (!el || !message) return;
  const flip = el.dataset.flip === "1";
  el.dataset.flip = flip ? "0" : "1";
  el.textContent = flip ? String(message) : `${message}\u00a0`;
}

function rhFocus(el, block = "center") {
  if (!el) return false;
  el.scrollIntoView?.({ behavior: "smooth", block });
  el.focus?.({ preventScroll: true });
  return true;
}

function rhGoToConfig() {
  if (typeof setActiveTab === "function") setActiveTab("config");
}

const RH_EDITOR_FIELDS = Object.freeze({
  name: "bp-name",
  companyName: "bp-companyName",
  logo: "branding-logo-file",
  primaryColor: "bp-primaryColor-hex",
  moreInfoUrl: "bp-moreInfoUrl",
  supportName: "bp-supportName",
});

/** Open the Brand profiles editor on the active profile and focus the field that needs attention. */
async function rhOpenEditor({ create = false, field = "companyName" } = {}) {
  rhGoToConfig();
  try {
    if (typeof bpEnsureLoaded === "function") await bpEnsureLoaded();
  } catch {
    /* the editor still opens; it reports its own load problem */
  }
  const store = typeof brandProfiles !== "undefined" ? brandProfiles : null;
  if (create) {
    if (store && !store.isNew && typeof bpNewProfile === "function") bpNewProfile();
    else rhFocus(document.getElementById("bp-name"));
    return;
  }
  if (store && !store.isNew && store.activeProfileId && store.selectedId !== store.activeProfileId && typeof bpSelectProfile === "function") {
    bpSelectProfile(store.activeProfileId);
  }
  const id = RH_EDITOR_FIELDS[field] || (/^[A-Za-z]+$/.test(field) ? `bp-${field}` : "bp-companyName");
  rhFocus(document.getElementById(id) || document.getElementById("bp-editor-heading"));
}

async function rhWaitFor(find, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found || Date.now() >= deadline) return found || null;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
}

/** Open the newest saved lab's Screenshot Center, or explain that a lab comes first. */
async function rhOpenScreenshotCenter() {
  const labs = typeof lbGen !== "undefined" && Array.isArray(lbGen.labs) ? lbGen.labs : [];
  if (typeof setActiveTab === "function") setActiveTab("labbuilder");
  if (!labs.length) {
    rhAnnounce("Build a lab first. Every lab has its own Screenshot Center.");
    if (typeof toast === "function") toast("Build a lab first. Every lab has its own Screenshot Center.", "info");
    rhFocus(document.getElementById("lb-build-heading") || document.getElementById("lb-heading-1"), "start");
    return;
  }
  const newest = [...labs].sort((a, b) => String(b.updatedAt || b.generatedAt || "").localeCompare(String(a.updatedAt || a.generatedAt || "")))[0];
  if (typeof lbOpenGeneratedScreenshots === "function") await lbOpenGeneratedScreenshots(newest.labId);
  const heading = await rhWaitFor(() => document.getElementById("lb-screenshots-heading"));
  rhFocus(heading, "start");
}

async function rhShowLabsToUpdate() {
  if (typeof setActiveTab === "function") setActiveTab("labbuilder");
  const details = document.getElementById("lb-generated-details");
  if (details) details.open = true;
  const filter = document.getElementById("lb-gen-drift-filter");
  if (filter) {
    filter.value = "docs-updated";
    filter.dispatchEvent(new Event("change", { bubbles: true }));
  }
  rhFocus(filter || document.getElementById("lb-generated-heading"));
}

async function rhScanLearn() {
  if (rhState.busy) return;
  rhState.busy = "learn";
  rhRender();
  rhAnnounce("Checking your labs against Microsoft Learn. This can take a minute.");
  try {
    if (typeof lbGen !== "undefined" && !lbGen.loaded && typeof lbLoadGenerated === "function") await lbLoadGenerated();
    if (typeof lbScanFleetLearnDrift === "function") await lbScanFleetLearnDrift({ autoUpdate: false });
  } finally {
    rhState.busy = "";
    await rhLoadDrift();
    rhRender();
    const row = rhBuildRows(rhInput()).find((item) => item.id === "learn");
    rhAnnounce(row ? `Microsoft Learn check finished. ${row.detail}` : "Microsoft Learn check finished.");
    rhFocus(document.querySelector('#rh-row-learn [data-rh-action="learn-scan"]'), "nearest");
  }
}

function rhToggleStorageHelp() {
  rhState.helpOpen = !rhState.helpOpen;
  rhRender();
  document.querySelector('#rh-row-storage [data-rh-action="storage-help"]')?.focus?.({ preventScroll: true });
  rhAnnounce(rhState.helpOpen ? "Steps shown below the storage row." : "Steps hidden.");
}

async function rhHandleAction(action, field) {
  switch (action) {
    case "refresh":
      await rhRefresh({ scope: "all", force: true, announce: true });
      return;
    case "brand-create":
      await rhOpenEditor({ create: true });
      return;
    case "brand-edit":
    case "links-edit":
    case "tenant-edit":
      await rhOpenEditor({ field: field || "companyName" });
      return;
    case "computer-connect":
      if (typeof scStartPairing === "function") {
        await scStartPairing({
          source: "readiness",
          onConnected: () => {
            void rhRefresh({ scope: "banner", force: true });
          },
        });
      }
      return;
    case "screenshots-open":
      await rhOpenScreenshotCenter();
      return;
    case "storage-help":
      rhToggleStorageHelp();
      return;
    case "learn-scan":
      await rhScanLearn();
      return;
    case "learn-show":
      await rhShowLabsToUpdate();
      return;
    case "build-open":
      if (typeof setActiveTab === "function") setActiveTab("labbuilder");
      rhFocus(document.getElementById("lb-heading-1") || document.getElementById("lb-build-heading"), "start");
      return;
    default:
  }
}

/** Open the Setup checklist from the Build banner. */
function rhOpenChecklist() {
  rhGoToConfig();
  void rhRefresh({ scope: "all" });
  const heading = document.getElementById("rh-heading");
  rhFocus(heading, "start");
}

function rhDismissBanner() {
  rhSetFlag(RH_BANNER_DISMISSED_KEY);
  const banner = document.getElementById("rh-banner");
  if (banner) banner.hidden = true;
  rhAnnounce("Setup banner dismissed. You can find the Setup checklist in Configuration at any time.");
  rhFocus(document.getElementById("lb-build-heading") || document.getElementById("lb-heading-1"), "start");
}

function rhBind() {
  if (rhState.bound || typeof document === "undefined" || !document.getElementById("rh-list")) return;
  rhState.bound = true;
  const body = document.getElementById("rh-body") || document.getElementById("rh-list");
  body.addEventListener("click", (event) => {
    const mine = event.target?.closest?.("[data-rh-action]");
    if (mine) {
      void rhHandleAction(mine.dataset.rhAction, mine.dataset.rhField);
      return;
    }
    const pairing = event.target?.closest?.("[data-sc-action]");
    if (pairing && typeof scHandleAction === "function") {
      const action = pairing.dataset.scAction;
      void scHandleAction("", action, pairing, "", null).then(() => {
        if (action === "pair-close") rhFocus(document.querySelector('#rh-row-computer [data-rh-action="computer-connect"]'), "nearest");
      });
    }
  });
  document.getElementById("rh-refresh")?.addEventListener("click", () => void rhHandleAction("refresh"));
  document.getElementById("rh-banner-open")?.addEventListener("click", rhOpenChecklist);
  document.getElementById("rh-banner-dismiss")?.addEventListener("click", rhDismissBanner);
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("focus", () => {
      const banner = document.getElementById("rh-banner");
      if (rhHubVisible()) void rhRefresh({ scope: "all", force: true });
      else if (banner && !banner.hidden) void rhRefresh({ scope: "banner", force: true });
    });
  }
}

function rhInit() {
  rhBind();
  void rhRefresh({ scope: rhHubVisible() ? "all" : "banner" });
}

// Deferred scripts run before DOMContentLoaded, so the portal's own start-up (tabs, brand profiles) finishes first.
if (typeof document !== "undefined" && typeof window !== "undefined" && document.getElementById) {
  if (document.readyState === "loading" || document.readyState === "interactive") document.addEventListener("DOMContentLoaded", rhInit);
  else if (document.readyState === "complete") rhInit();
}
