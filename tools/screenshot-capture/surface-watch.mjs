// Passive observation of the browser WINDOW while a person signs in.
//
// A sign-in that "just sits there" can be a page, a popup that closed, a page that went blank, a native Windows account
// dialog, a minimized window, or a window that lost focus. The address bar alone cannot tell these apart, so this
// watcher writes down what it can see WITHOUT reading page text and WITHOUT touching anything:
//   - how many browser windows and tabs exist, and whether a tab was opened as a popup or closed,
//   - for each tab: its kind and host (never the query string), whether its title is empty (never the title),
//     whether it is visible and focused, and how many elements, inputs, and buttons it has (counts only),
//   - the window state (normal, minimized, maximized) from the browser itself,
//   - on Windows: whether the browser window is in front, minimized, or covered by another program, and whether a
//     Windows sign-in broker window is open (program names are reported only for a short list of sign-in brokers).
// It never navigates, reloads, clicks, types, or brings a window to the front. Nothing here reads cookies or page text.

import { spawn } from "node:child_process";

import { classifyUrl } from "./signin-url.mjs";

/** Windows programs that show account or credential prompts. Any other program is reported only as "another-app". */
const KNOWN_BROKERS = Object.freeze(["CredentialUIBroker", "Microsoft.AAD.BrokerPlugin", "WWAHost", "LogonUI", "consent"]);

const defaultSleep = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(undefined), ms).unref?.())]);

// ── Windows window facts ─────────────────────────────────────────────────

const probeScript = (browserPid, intervalMs) => `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class SurfaceProbe {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static string Snap(uint browser) {
    int bw = 0; int bmin = 0; uint fg = 0;
    IntPtr f = GetForegroundWindow();
    if (f != IntPtr.Zero) GetWindowThreadProcessId(f, out fg);
    HashSet<uint> others = new HashSet<uint>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      if (GetWindow(h, 4) != IntPtr.Zero) return true;
      if (GetWindowTextLength(h) == 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == browser) { bw++; if (IsIconic(h)) bmin++; } else others.Add(pid);
      return true;
    }, IntPtr.Zero);
    List<string> ids = new List<string>();
    foreach (uint p in others) ids.Add(p.ToString());
    return bw + ";" + bmin + ";" + fg + ";" + string.Join(",", ids.ToArray());
  }
}
'@
$me = ${browserPid}
for ($i = 0; $i -lt 7200; $i++) {
  $parts = ([SurfaceProbe]::Snap($me)).Split(';')
  $names = @{}
  Get-Process | ForEach-Object { $names[[int]$_.Id] = $_.ProcessName }
  $fgId = [int]$parts[2]
  $fgName = if ($fgId -eq $me) { 'browser' } elseif ($names.ContainsKey($fgId)) { $names[$fgId] } else { '' }
  $others = @()
  foreach ($p in ($parts[3] -split ',')) { if ($p -and $names.ContainsKey([int]$p)) { $others += $names[[int]$p] } }
  $line = [pscustomobject]@{ bw = [int]$parts[0]; bmin = [int]$parts[1]; fg = $fgName; others = @($others) } | ConvertTo-Json -Compress
  try { [Console]::Out.WriteLine($line); [Console]::Out.Flush() } catch { break }
  Start-Sleep -Milliseconds ${intervalMs}
}
`;

/** Turn the probe's raw line into facts that are safe to write down. Program names other than sign-in brokers are dropped. */
export function describeNativeSnapshot(raw) {
  if (!raw || typeof raw !== "object") return null;
  const others = (Array.isArray(raw.others) ? raw.others : raw.others ? [raw.others] : []).map((n) => String(n));
  const name = String(raw.fg || "");
  let front = "none";
  if (name === "browser") front = "browser";
  else if (name === "msedge") front = "another-edge-window";
  else if (name === "explorer") front = "desktop";
  else if (KNOWN_BROKERS.includes(name)) front = name;
  else if (name) front = "another-app";
  return {
    browserWindows: Number(raw.bw) || 0,
    browserMinimized: Number(raw.bmin) || 0,
    front,
    brokerWindows: [...new Set(others.filter((n) => KNOWN_BROKERS.includes(n)))].sort(),
    otherEdgeWindows: others.filter((n) => n === "msedge").length,
  };
}

/** Start the Windows probe. Returns `{ latest(), stop() }`, or null when this is not Windows or the browser's process id is unknown. */
export function startNativeProbe({ browserPid, intervalMs = 2000, spawnFn = spawn, platform = process.platform } = {}) {
  if (platform !== "win32" || !Number.isInteger(browserPid) || browserPid <= 0) return null;
  let latest = null;
  let buffer = "";
  let child;
  try {
    const encoded = Buffer.from(probeScript(browserPid, Math.max(500, Math.floor(intervalMs))), "utf16le").toString("base64");
    child = spawnFn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  } catch {
    return null;
  }
  child.on?.("error", () => {});
  child.stdout?.on?.("data", (chunk) => {
    buffer += String(chunk);
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      try {
        latest = describeNativeSnapshot(JSON.parse(line));
      } catch {
        // A partial or unexpected line is not worth stopping for.
      }
    }
  });
  const stop = () => {
    try {
      child.kill?.();
    } catch {
      // Already gone.
    }
  };
  process.once("exit", stop);
  return { latest: () => latest, stop };
}

// ── The watcher ──────────────────────────────────────────────────────────

const pageFacts = () => {
  const body = document.body;
  return {
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    ready: document.readyState,
    elements: body ? body.getElementsByTagName("*").length : -1,
    inputs: document.getElementsByTagName("input").length,
    buttons: document.getElementsByTagName("button").length,
    frames: document.getElementsByTagName("iframe").length,
  };
};

/**
 * Watch the browser window passively and write what it does to the trace.
 * @param {object} options
 * @param {object} options.context Playwright browser context.
 * @param {object} [options.browser] Playwright browser (for window and tab counts); defaults to `context.browser()`.
 * @param {number} [options.pid] The browser's process id (Windows window facts).
 * @param {object} [options.trace] A trace with `event(name, data)`.
 * @param {() => ({latest: () => object|null, stop: () => void})|null} [options.nativeProbe] Replaces the Windows probe in tests.
 */
export function createSurfaceWatch({ context, browser = null, pid = null, trace = null, intervalMs = 2000, nativeProbe = null, sleep = defaultSleep, now = () => Date.now(), platform = process.platform } = {}) {
  const started = now();
  const at = () => now() - started;
  const summary = { samples: 0, maxTabs: 0, maxWindows: 0, popupsOpened: 0, tabsClosed: 0, blankOnSignIn: null, lostFocus: 0, minimized: false, covered: [], brokers: [], otherEdgeWindows: 0, windowClosed: false, crashed: 0 };
  const seen = new Map(); // page -> { key, hadForm, hadContent }
  const watchedPages = new WeakSet();
  let stopped = false;
  let finished = null;
  let loop = null;
  let probe = null;
  let browserSession = null;
  let lastNativeKey = "";
  let lastCountKey = "";
  let wasInFront = null;

  const event = (name, data) => trace?.event(name, data);
  const livePages = () => {
    try {
      return context.pages().filter((p) => !p.isClosed?.());
    } catch {
      return [];
    }
  };

  const hostFacts = (page) => {
    let address = "";
    try {
      address = page.url();
    } catch {
      address = "";
    }
    const info = classifyUrl(address);
    return { kind: info.kind === "sign-in" ? "sign-in" : address === "about:blank" || address === "" ? "blank-address" : "product", host: info.host || "", path: info.path || "" };
  };

  const watchPage = (page) => {
    if (watchedPages.has(page)) return;
    watchedPages.add(page);
    page.on?.("close", () => {
      summary.tabsClosed += 1;
      event("surface-tab-closed", { afterMs: at(), tabs: livePages().length });
    });
    page.on?.("crash", () => {
      summary.crashed += 1;
      event("surface-tab-crashed", { afterMs: at() });
    });
  };

  const onNewPage = async (page) => {
    watchPage(page);
    let popup = false;
    try {
      popup = Boolean(await withTimeout(page.opener?.(), 1000));
    } catch {
      popup = false;
    }
    if (popup) summary.popupsOpened += 1;
    const facts = hostFacts(page);
    event("surface-tab-opened", { afterMs: at(), popup, tabs: livePages().length, kind: facts.kind, host: facts.host });
  };

  const countWindows = async () => {
    const out = { tabs: livePages().length, windows: null, states: [] };
    const source = browser || (typeof context.browser === "function" ? context.browser() : null);
    if (!source || typeof source.newBrowserCDPSession !== "function") return out;
    try {
      browserSession = browserSession || (await withTimeout(source.newBrowserCDPSession(), 2000)) || null;
      if (!browserSession) return out;
      const targets = (await withTimeout(browserSession.send("Target.getTargets"), 1500))?.targetInfos || [];
      const pages = targets.filter((t) => t.type === "page");
      const windows = new Map();
      for (const target of pages) {
        try {
          const found = await withTimeout(browserSession.send("Browser.getWindowForTarget", { targetId: target.targetId }), 1000);
          if (found?.windowId !== undefined) windows.set(found.windowId, found.bounds?.windowState || "normal");
        } catch {
          // A target that closed between the two calls.
        }
      }
      out.tabs = pages.length || out.tabs;
      out.windows = windows.size;
      out.states = [...new Set(windows.values())].sort();
    } catch {
      browserSession = null;
    }
    return out;
  };

  const samplePage = async (page) => {
    const facts = hostFacts(page);
    let titleEmpty = null;
    try {
      titleEmpty = String((await withTimeout(page.title(), 1200)) ?? "").trim() === "";
    } catch {
      titleEmpty = null;
    }
    let dom = null;
    try {
      dom = (await withTimeout(page.evaluate(pageFacts), 1500)) || null;
    } catch {
      dom = null;
    }
    return { ...facts, titleEmpty, dom };
  };

  const sampleOnce = async () => {
    summary.samples += 1;
    const counts = await countWindows();
    summary.maxTabs = Math.max(summary.maxTabs, counts.tabs);
    if (counts.windows !== null) summary.maxWindows = Math.max(summary.maxWindows, counts.windows);
    if (counts.states.includes("minimized")) summary.minimized = true;
    const countKey = JSON.stringify(counts);
    if (countKey !== lastCountKey) {
      lastCountKey = countKey;
      event("surface-windows", { afterMs: at(), tabs: counts.tabs, windows: counts.windows, windowStates: counts.states });
    }

    let index = 0;
    for (const page of livePages()) {
      index += 1;
      watchPage(page);
      const sample = await samplePage(page);
      const dom = sample.dom;
      let state = seen.get(page) || { key: "", signature: "", hadForm: false, hadContent: false, goneStreak: 0, reportedBlank: false };
      const signature = `${sample.kind}:${sample.host}`;
      // A new page on a different site starts with a clean slate: its DOM is expected to be empty while it loads.
      if (state.signature !== signature) state = { ...state, signature, hadForm: false, hadContent: false, goneStreak: 0, reportedBlank: false };
      const hasForm = Boolean(dom && dom.inputs + dom.buttons > 0);
      const hasContent = Boolean(dom && dom.elements > 12);
      const blank = Boolean(dom && dom.ready !== "loading" && dom.elements <= 3);
      const formGone = Boolean(state.hadForm && dom && dom.inputs === 0 && dom.buttons === 0);
      const key = JSON.stringify([sample.kind, sample.host, sample.path, sample.titleEmpty, dom && [dom.visibility, dom.focused, dom.ready, dom.inputs > 0, dom.buttons > 0, dom.frames, blank]]);
      if (key !== state.key) {
        event("surface-tab", { afterMs: at(), tab: index, kind: sample.kind, host: sample.host, path: sample.path, titleEmpty: sample.titleEmpty, visible: dom ? dom.visibility === "visible" : null, focused: dom ? dom.focused : null, ready: dom ? dom.ready : null, elements: dom ? dom.elements : null, inputs: dom ? dom.inputs : null, buttons: dom ? dom.buttons : null, frames: dom ? dom.frames : null, blank });
      }
      const gone = sample.kind === "sign-in" && (blank || formGone) && (state.hadForm || state.hadContent);
      state.goneStreak = gone ? state.goneStreak + 1 : 0;
      // Two samples in a row, so a page that is only changing screens is not reported.
      if (state.goneStreak >= 2 && !state.reportedBlank) {
        state.reportedBlank = true;
        const why = blank ? "blank-document" : "form-removed";
        summary.blankOnSignIn = summary.blankOnSignIn || { afterMs: at(), why };
        event("surface-sign-in-surface-gone", { afterMs: at(), tab: index, host: sample.host, why, titleEmpty: sample.titleEmpty });
      } else if (state.reportedBlank && hasForm) {
        state.reportedBlank = false;
        event("surface-sign-in-surface-back", { afterMs: at(), tab: index, host: sample.host });
      }
      seen.set(page, { key, signature, hadForm: state.hadForm || hasForm, hadContent: state.hadContent || hasContent, goneStreak: state.goneStreak, reportedBlank: state.reportedBlank });
    }

    const native = probe?.latest?.() || null;
    if (native) {
      const key = JSON.stringify(native);
      if (key !== lastNativeKey) {
        lastNativeKey = key;
        event("surface-native", { afterMs: at(), browserWindows: native.browserWindows, minimized: native.browserMinimized, inFront: native.front, signInBrokerWindows: native.brokerWindows, otherEdgeWindows: native.otherEdgeWindows });
      }
      if (native.browserMinimized > 0) summary.minimized = true;
      const inFront = native.front === "browser";
      if (wasInFront === true && !inFront) summary.lostFocus += 1;
      if (!inFront && native.front !== "none" && !summary.covered.includes(native.front)) summary.covered.push(native.front);
      wasInFront = inFront;
      for (const name of native.brokerWindows) if (!summary.brokers.includes(name)) summary.brokers.push(name);
      summary.otherEdgeWindows = Math.max(summary.otherEdgeWindows, native.otherEdgeWindows);
    }
  };

  const run = async () => {
    while (!stopped) {
      try {
        await sampleOnce();
      } catch {
        // A failed sample is not a reason to stop watching.
      }
      await sleep(intervalMs);
    }
  };

  return {
    start() {
      if (loop) return;
      try {
        context.on?.("page", (page) => void onNewPage(page));
        context.on?.("close", () => {
          summary.windowClosed = true;
          event("surface-browser-closed", { afterMs: at() });
        });
      } catch {
        // A driver without events is still sampled.
      }
      for (const page of livePages()) watchPage(page);
      probe = nativeProbe ? nativeProbe() : platform === "win32" ? startNativeProbe({ browserPid: pid, intervalMs, platform }) : null;
      event("surface-watch-start", { native: Boolean(probe), tabs: livePages().length });
      loop = run();
    },
    async stop() {
      if (finished) return finished;
      stopped = true;
      try {
        probe?.stop();
      } catch {
        // Already gone.
      }
      await withTimeout(loop || Promise.resolve(), 600);
      try {
        await browserSession?.detach?.();
      } catch {
        // The browser may already be closed.
      }
      event("surface-watch-summary", { ...plain(summary), blankOnSignIn: null, blankAfterMs: summary.blankOnSignIn?.afterMs ?? null, blankWhy: summary.blankOnSignIn?.why ?? null });
      finished = plain(summary);
      return finished;
    },
    summary: () => plain(summary),
    /** True when the last look at Windows found the browser window behind another program (not minimized, not unknown). */
    isCovered: () => {
      const native = probe?.latest?.() || null;
      return Boolean(native && native.front !== "browser" && native.front !== "none" && native.browserWindows > 0);
    },
  };
}

const plain = (summary) => ({ ...summary, covered: [...summary.covered], brokers: [...summary.brokers] });

/** Plain-language lines about what the window did, for the verdict. */
export function describeSurface(surface) {
  if (!surface) return [];
  const lines = [];
  const windows = surface.maxWindows ? `${surface.maxWindows} browser window${surface.maxWindows === 1 ? "" : "s"}, ` : "";
  lines.push(`Window: ${windows}up to ${surface.maxTabs} tab${surface.maxTabs === 1 ? "" : "s"}${surface.popupsOpened ? `, ${surface.popupsOpened} popup${surface.popupsOpened === 1 ? "" : "s"} opened` : ", no popups"}${surface.tabsClosed ? `, ${surface.tabsClosed} tab${surface.tabsClosed === 1 ? "" : "s"} closed` : ""}.`);
  if (surface.blankOnSignIn) lines.push(`The sign-in page went ${surface.blankOnSignIn.why === "blank-document" ? "blank (an empty document)" : "empty (its input boxes were removed)"} about ${Math.round(surface.blankOnSignIn.afterMs / 1000)} seconds in, while the browser was still on the sign-in site. The companion did not reload it.`);
  if (surface.brokers.length) lines.push(`A Windows sign-in window was open (${surface.brokers.join(", ")}). It is separate from the browser page and may have been the "login box".`);
  if (surface.minimized) lines.push("The browser window was minimized at some point.");
  if (surface.lostFocus) lines.push(`The browser window lost focus ${surface.lostFocus} time${surface.lostFocus === 1 ? "" : "s"}${surface.covered.length ? ` (in front instead: ${surface.covered.join(", ")})` : ""}.`);
  else if (surface.covered.length) lines.push(`Another window was in front: ${surface.covered.join(", ")}.`);
  if (surface.otherEdgeWindows) lines.push("Another Microsoft Edge window was open on this computer, which is not the companion's window.");
  if (surface.windowClosed) lines.push("The browser window was closed while the check was running.");
  if (surface.crashed) lines.push(`A tab crashed ${surface.crashed} time${surface.crashed === 1 ? "" : "s"}.`);
  return lines;
}
