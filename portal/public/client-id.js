// ── A private id for this browser ───────────────────────────────────────────
// Without sign-in the portal cannot tell two people apart, so each browser makes a random id once, keeps it in
// localStorage, and sends it with every call to the portal's own /api. The portal uses it to keep this browser's saved
// drafts and limits apart from everyone else's. It separates people and prevents collisions; it is not a password and
// does not protect anything from someone who copies it.
(function () {
  const KEY = "labBuilder.clientId.v1";
  const VALID = /^[A-Za-z0-9_-]{22,64}$/;
  let memoryId = "";

  function makeId() {
    const bytes = new Uint8Array(16);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function portalClientId() {
    try {
      const stored = localStorage.getItem(KEY);
      if (stored && VALID.test(stored)) return stored;
      const fresh = makeId();
      localStorage.setItem(KEY, fresh);
      return fresh;
    } catch {
      // Storage can be blocked (private windows, strict settings): keep one id for this page load.
      if (!memoryId) memoryId = makeId();
      return memoryId;
    }
  }

  function isPortalApi(url) {
    try {
      const parsed = new URL(String(url), globalThis.location?.href || "http://localhost/");
      return parsed.origin === (globalThis.location?.origin || parsed.origin) && parsed.pathname.startsWith("/api/");
    } catch {
      return false;
    }
  }

  const nativeFetch = globalThis.fetch?.bind(globalThis);
  if (nativeFetch) {
    globalThis.fetch = function (input, init) {
      const url = typeof input === "string" || input instanceof URL ? input : input?.url;
      if (!isPortalApi(url)) return nativeFetch(input, init);
      const headers = new Headers(init?.headers || (typeof input === "object" && input && !(input instanceof URL) ? input.headers : undefined));
      if (!headers.has("X-Client-Id")) headers.set("X-Client-Id", portalClientId());
      return nativeFetch(input, { ...(init || {}), headers });
    };
  }

  // An EventSource cannot send headers, so the id travels in the address for the progress streams.
  const NativeEventSource = globalThis.EventSource;
  if (typeof NativeEventSource === "function") {
    globalThis.EventSource = function (url, config) {
      let target = url;
      if (isPortalApi(url)) {
        const parsed = new URL(String(url), globalThis.location.href);
        if (!parsed.searchParams.has("cid")) parsed.searchParams.set("cid", portalClientId());
        target = parsed.pathname + parsed.search;
      }
      return new NativeEventSource(target, config);
    };
    globalThis.EventSource.prototype = NativeEventSource.prototype;
  }

  globalThis.portalClientId = portalClientId;
})();
