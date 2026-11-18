// A pretend Microsoft tenant for real-browser sign-in tests. It answers requests for
// a few product hosts and for login.microsoftonline.com through Playwright route
// interception, so nothing leaves this computer and the real sign-in host patterns
// in the companion are exercised. Sign-in state lives in the browser's own cookie
// jar, so closing and reopening a profile behaves like a real browser.
//
//   product host      needs the app cookie, otherwise redirects to the login host
//   login host        silent single sign-on when the Entra cookie is present, otherwise a
//                     sign-in page that the simulated person completes after a delay
//   sign-in cookies   session cookies (the person did not choose Yes on "Stay signed in?")
//                     or persistent ones (they did)

const LOGIN_HOST = "login.microsoftonline.com";
export const FAKE_PRODUCT_HOSTS = Object.freeze(["copilotstudio.microsoft.com", "make.powerapps.com", "admin.microsoft.com"]);

const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const blocks = Array.from({ length: 24 }, (_, i) => `<i style="background:hsl(${(i * 37) % 360} 55% 55%)"></i>`).join("");
const style =
  "<style>body{margin:0;font:18px Segoe UI,Arial,sans-serif;background:linear-gradient(135deg,#eef2ff,#fdf2f8)}" +
  "header{display:flex;gap:18px;align-items:center;padding:14px 24px;background:#1f2937;color:#fff}header a{color:#bfdbfe}" +
  "main{padding:24px}i{display:inline-block;width:150px;height:90px;margin:6px;border-radius:8px}" +
  "#mectrl_main_trigger{margin-left:auto;width:40px;height:40px;border-radius:50%;background:#2563eb;color:#fff;border:0}</style>";

/**
 * @param {object} [options]
 * @param {boolean} [options.sessionCookies] sign-in cookies are session cookies (default true)
 * @param {number|null} [options.userSignsInAfterMs] the person completes sign-in after this long; null means nobody signs in
 * @param {boolean} [options.staySignedInPage] show the "Stay signed in?" page after sign-in
 * @param {boolean} [options.userChoosesYes] the person chooses Yes on it (makes the Entra cookie persistent)
 * @param {"redirect"|"client"} [options.ssoHop] silent single sign-on answers with a redirect or with a page that redirects itself
 * @param {number} [options.hopDelayMs] how long the self-redirecting page lingers on the login host
 * @param {boolean} [options.blockSignIn] the tenant never lets the browser sign in (for example a Conditional Access block)
 * @param {string[]} [options.stepUpHosts] product hosts that always ask for a fresh interactive sign-in (for example an admin center that wants MFA)
 * @param {string[]} [options.preSignedIn] product hosts the person is already signed in to; seeded once, into the first browser profile that opens, with session or persistent cookies per `sessionCookies`
 * @param {boolean} [options.staleApp] the seeded app sign-in has expired, so the product needs a silent single sign-on round trip
 * @param {boolean} [options.bounceForever] the product never accepts the sign-in (its callback sets no session), so the browser bounces between the product and the login host for ever
 */
export function createFakeTenant(options = {}) {
  const config = { sessionCookies: true, userSignsInAfterMs: 2000, staySignedInPage: false, userChoosesYes: false, ssoHop: "redirect", hopDelayMs: 0, redirectDelayMs: 150, blockSignIn: false, bounceForever: false, stepUpHosts: [], preSignedIn: [], ...options };
  const stats = { interactivePages: 0, silentHops: 0, signOuts: 0, forcedReauth: 0, kmsiPages: 0, productPages: [], loginVisits: [], blocked: [] };
  let generation = 1;
  let seeded = false;

  const persistentAttrs = "Path=/; Max-Age=86400; Secure; SameSite=None";
  const sessionAttrs = "Path=/; Secure; SameSite=None";
  const cookieHeader = (name, value, persistent) => `${name}=${value}; ${persistent ? persistentAttrs : sessionAttrs}`;
  const clearHeader = (name) => `${name}=; Path=/; Max-Age=0; Secure; SameSite=None`;

  async function jar(context, url) {
    return Object.fromEntries((await context.cookies(url)).map((c) => [c.name, c.value]));
  }

  function appPage(host, title) {
    return (
      `<!doctype html><title>${esc(title)}</title>${style}<header><b>${esc(title)}</b>` +
      `<a href="/settings">Settings</a><a href="/memory">Memory</a><a href="/home">Home</a>` +
      `<a id="signout" href="/signout">Sign out</a><a id="switch" href="https://${LOGIN_HOST}/common/oauth2/authorize?prompt=select_account&client_id=${host}&redirect_uri=${encodeURIComponent(`https://${host}/signin-callback`)}">Switch account</a>` +
      `<button id="mectrl_main_trigger">AL</button></header><main><h1>${esc(title)}</h1><p>Signed in as ada@contoso.com</p>${blocks}</main>`
    );
  }

  function loginPage({ heading, query, kind }) {
    const auto =
      config.userSignsInAfterMs === null || config.blockSignIn
        ? ""
        : `<script>setTimeout(function(){location.href="/signin/complete${query}"},${Number(config.userSignsInAfterMs)})</script>`;
    const text = config.blockSignIn ? "You cannot access this right now. Your sign-in was successful but your device does not meet your organization's requirements." : heading;
    return `<!doctype html><title>Sign in to your account</title>${style}<main><h1>${esc(text)}</h1><p>${esc(kind)}</p><input aria-label="Email"><button>Next</button>${blocks}</main>${auto}`;
  }

  async function handle(context, route) {
    const request = route.request();
    const url = new URL(request.url());
    const html = (body, headers = {}, status = 200) => route.fulfill({ status, contentType: "text/html; charset=utf-8", headers: { "cache-control": "no-store", ...headers }, body });
    // Playwright does not intercept the target of a fulfilled 3xx, so a "redirect" is a page that sends the browser on,
    // which is also how single-page apps and the Microsoft sign-in pages move around.
    const redirect = (location, headers = {}) =>
      html(
        `<!doctype html><title>Working on it</title><meta http-equiv="refresh" content="${Math.max(0, Number(config.redirectDelayMs) / 1000)};url=${esc(location)}"><h1>Working on it...</h1>`,
        headers,
      );
    if (url.pathname === "/favicon.ico") return route.fulfill({ status: 204, body: "" });

    if (url.hostname === LOGIN_HOST) {
      const cookies = await jar(context, url.href);
      const signedIn = Boolean(cookies.ESTSAUTH || cookies.ESTSAUTHPERSISTENT);
      stats.loginVisits.push(url.pathname);
      if (url.pathname.endsWith("/logout")) {
        stats.signOuts += 1;
        return html("<!doctype html><title>Signed out</title><h1>You signed out of your account</h1>", { "set-cookie": [clearHeader("ESTSAUTH"), clearHeader("ESTSAUTHPERSISTENT")].join("\n") });
      }
      if (url.pathname === "/signin/complete") {
        const done = `${url.search}${url.search ? "&" : "?"}done=1`;
        const next = config.staySignedInPage ? `/kmsi${done}` : `/common/oauth2/authorize${done}`;
        return redirect(next, { "set-cookie": cookieHeader("ESTSAUTH", "1", !config.sessionCookies) });
      }
      if (url.pathname === "/kmsi") {
        stats.kmsiPages += 1;
        const yes = config.userChoosesYes;
        return html(
          `<!doctype html><title>Stay signed in?</title>${style}<main><h1>Stay signed in?</h1><button>No</button><button>Yes</button>${blocks}</main>` +
            `<script>setTimeout(function(){location.href="/kmsi/${yes ? "yes" : "no"}${url.search}"},200)</script>`,
        );
      }
      if (url.pathname.startsWith("/kmsi/")) {
        const headers = url.pathname.endsWith("/yes") ? { "set-cookie": [cookieHeader("ESTSAUTHPERSISTENT", "1", true), clearHeader("ESTSAUTH")].join("\n") } : {};
        return redirect(`/common/oauth2/authorize${url.search}`, headers);
      }
      // /common/oauth2/authorize
      const prompt = url.searchParams.get("prompt");
      const forced = Boolean(prompt) && !url.searchParams.has("done");
      const target = url.searchParams.get("redirect_uri") || `https://${FAKE_PRODUCT_HOSTS[0]}/signin-callback`;
      if (config.blockSignIn) {
        stats.interactivePages += 1;
        return html(loginPage({ heading: "Sign in", query: url.search, kind: "blocked" }));
      }
      if (signedIn && !forced) {
        stats.silentHops += 1;
        if (config.ssoHop === "client") {
          return html(`<!doctype html><title>Working on it</title><h1>Working on it...</h1><script>setTimeout(function(){location.replace(${JSON.stringify(target)})},${Number(config.hopDelayMs)})</script>`);
        }
        return redirect(target);
      }
      if (signedIn && forced) stats.forcedReauth += 1;
      stats.interactivePages += 1;
      return html(loginPage({ heading: prompt === "select_account" ? "Pick an account" : "Sign in", query: url.search, kind: prompt ? "forced" : "first" }));
    }

    // A product host.
    stats.productPages.push(`${url.hostname}${url.pathname}`);
    const cookies = await jar(context, url.href);
    if (url.pathname === "/signin-callback") return redirect("/", config.bounceForever ? {} : { "set-cookie": cookieHeader("app_session", String(generation), !config.sessionCookies) });
    if (url.pathname === "/signout") return redirect(`https://${LOGIN_HOST}/common/oauth2/logout`, { "set-cookie": clearHeader("app_session") });
    if (cookies.app_session !== String(generation)) {
      const callback = `https://${url.hostname}/signin-callback`;
      const stepUp = config.stepUpHosts.includes(url.hostname) ? "&prompt=login" : "";
      return redirect(`https://${LOGIN_HOST}/common/oauth2/authorize?client_id=${url.hostname}&response_type=code&redirect_uri=${encodeURIComponent(callback)}&state=${Math.random().toString(16).slice(2)}${stepUp}`);
    }
    if (url.pathname === "/trap") return html(appPage(url.hostname, `${url.hostname} (trap)`));
    return html(appPage(url.hostname, url.hostname === FAKE_PRODUCT_HOSTS[0] ? "Copilot Studio" : url.hostname));
  }

  return {
    config,
    stats,
    /** Make every saved app sign-in invalid, like a token that expired. */
    expireAppSessions() {
      generation += 1;
    },
    /** Answer for the fake hosts in this browser context. Every other address is refused, so a test never reaches the real internet. */
    async attach(context) {
      const hosts = [LOGIN_HOST, ...FAKE_PRODUCT_HOSTS].map((h) => h.replace(/\./g, "\\."));
      await context.route(/^https?:\/\//, (route) => {
        stats.blocked.push(new URL(route.request().url()).hostname);
        return route.abort();
      });
      await context.route(new RegExp(`^https://(?:${hosts.join("|")})/`), (route) => handle(context, route));
      if (config.preSignedIn.length && !seeded) {
        seeded = true;
        const expires = config.sessionCookies ? -1 : Math.floor(Date.now() / 1000) + 86_400;
        const base = { path: "/", secure: true, sameSite: "None", expires };
        await context.addCookies([
          { ...base, name: config.sessionCookies ? "ESTSAUTH" : "ESTSAUTHPERSISTENT", value: "1", domain: LOGIN_HOST },
          ...config.preSignedIn.map((host) => ({ ...base, name: "app_session", value: String(config.staleApp ? 0 : generation), domain: host })),
        ]);
      }
    },
  };
}

/**
 * Wrap a real Playwright module so every browser context the companion opens is
 * attached to the fake tenant. Records each launch so tests can see what opened.
 */
export function withFakeTenant(playwright, tenant, { forceChannel = undefined } = {}) {
  const launches = [];
  const wrapType = (type, name) =>
    new Proxy(type, {
      get(target, prop) {
        // A browser the companion started itself and connected to (see attach.mjs) gets the same fake tenant.
        if (prop === "connectOverCDP") {
          return async (...args) => {
            const browser = await target.connectOverCDP(...args);
            launches.push({ via: "attach", type: name });
            await tenant.attach(browser.contexts()[0]);
            return browser;
          };
        }
        if (prop !== "launchPersistentContext") return typeof target[prop] === "function" ? target[prop].bind(target) : target[prop];
        return async (dir, opts = {}) => {
          const options = forceChannel === undefined ? { ...opts } : { ...opts, ...(forceChannel ? { channel: forceChannel } : {}) };
          launches.push({ dir, options: { ...opts }, type: name });
          const context = await target.launchPersistentContext(dir, options);
          await tenant.attach(context);
          return context;
        };
      },
    });
  return { chromium: wrapType(playwright.chromium, "chromium"), launches };
}
