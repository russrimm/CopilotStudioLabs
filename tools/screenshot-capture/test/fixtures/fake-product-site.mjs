// A pretend Microsoft Copilot Studio (and a SharePoint site) for real-browser capture tests. It answers
// requests for the real product host names through Playwright route interception, so nothing leaves this
// computer and the companion's real host patterns and address checks are exercised.
//
// It imitates the structure that broke the real captures:
//   /                                   sends the browser to the environment's home page after a moment
//   /environments/<env>/home            home page; a "Knowledge" promo card links to the wrong place (/apps/new)
//   /environments/<env>/agents          the list of agents (open one, or "Create blank agent": a write)
//   /environments/<env>/bots/<id>/...   an agent with a side navigation: Overview, Knowledge, Tools, Topics,
//                                       Analytics, Settings; a Test button; a Publish button (a write)
//   /environments/<env>/apps/new        a decoy "Create an app" page
//   every page shows a loading skeleton for a while (aria-busy, progressbar) before its content appears;
//   the agent overview can stay a white page with a spinner for several seconds, and fills in a field late.
//
// Anything that would change a tenant (Create blank agent, Publish, Add to agent) is recorded in
// `stats.writes`, so a test can prove the companion never does it.

const LOGIN_HOST = "login.microsoftonline.com";
export const FAKE_HOSTS = Object.freeze({
  studio: "copilotstudio.microsoft.com",
  sharepoint: "contoso.sharepoint.com",
  m365: "m365.cloud.microsoft",
  powerAdmin: "admin.powerplatform.microsoft.com",
});
export const FAKE_ENV_ID = "6b988893-6c74-4e65-9d9a-f7f044be1d08";
export const FAKE_AGENT = Object.freeze({ id: "0f6c2d9a-3a54-4a64-8c61-5b1d7a2e9c11", name: "Energy Assistant" });
const OTHER_AGENT = Object.freeze({ id: "9b2e7f10-41cd-4f0e-a3a7-2c8d5e6f7a22", name: "Energy Assistant (test copy)" });
export const FAKE_SITE_URL = `https://${FAKE_HOSTS.sharepoint}/sites/training`;
export const FAKE_AGENT_URL = `https://${FAKE_HOSTS.studio}/environments/${FAKE_ENV_ID}/bots/${FAKE_AGENT.id}/overview`;

const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const STYLE = `<style>
body{margin:0;font:16px Segoe UI,Arial,sans-serif;color:#1f2937;background:#fff}
header.top{display:flex;gap:16px;align-items:center;padding:10px 20px;background:#1f2937;color:#fff}
header.top a,header.top button{color:#e0f2fe;background:none;border:1px solid #64748b;border-radius:4px;padding:4px 10px;text-decoration:none;font:inherit;cursor:pointer}
.layout{display:flex;min-height:640px}
nav.side{width:210px;background:#eef2ff;padding:12px;border-right:1px solid #c7d2fe}
nav.side a{display:block;padding:8px 10px;margin:2px 0;border-radius:4px;color:#1e3a8a;text-decoration:none}
nav.side a[aria-current=page]{background:#c7d2fe;font-weight:600}
main{flex:1;padding:24px}
.card{border:1px solid #cbd5e1;border-radius:8px;padding:14px;margin:12px 0;background:#f8fafc}
.promo{border:2px dashed #f59e0b;background:#fffbeb;padding:14px;border-radius:8px;margin:16px 0}
.skeleton{height:34px;margin:14px 0;border-radius:6px;background:linear-gradient(90deg,#e5e7eb,#f3f4f6,#e5e7eb)}
.spinner{margin:300px auto;width:26px;height:26px;border:4px solid #e5e7eb;border-top-color:#9ca3af;border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
[role=tablist]{display:flex;gap:8px;border-bottom:1px solid #cbd5e1;margin-bottom:12px}
[role=tab]{padding:8px 12px;border:0;background:none;font:inherit;cursor:pointer}
[role=tab][aria-selected=true]{border-bottom:3px solid #2563eb;font-weight:600}
aside.test{position:fixed;right:0;top:56px;width:300px;height:520px;background:#fff;border-left:1px solid #94a3b8;padding:12px}
dialog{border:1px solid #475569;border-radius:8px;padding:20px;width:420px}
</style>`;

/**
 * @param {object} [options]
 * @param {number} [options.defaultDelayMs] how long every page shows its loading skeleton
 * @param {Record<string, number>} [options.delays] per page (`overview`, `settings`, ...) skeleton time in ms
 * @param {number} [options.overviewBlankMs] the agent overview stays a white page with a spinner this long
 * @param {number} [options.lateTextMs] the instructions text fills in this long after the page appears
 * @param {boolean} [options.directSections] opening an agent section by address works (otherwise it lands on the overview)
 * @param {"actions"|"tools"} [options.toolsSlug] the address segment of the Tools page
 * @param {boolean} [options.abortFirstNavigation] the first request for the start page is interrupted (net::ERR_ABORTED)
 * @param {boolean} [options.requireSession] a pretend sign-in cookie is needed (seeded by default)
 * @param {boolean} [options.seedSession]
 */
export function createFakeProductSite(options = {}) {
  const config = {
    defaultDelayMs: 350,
    delays: {},
    overviewBlankMs: 0,
    lateTextMs: 0,
    directSections: true,
    toolsSlug: "actions",
    abortFirstNavigation: false,
    requireSession: true,
    seedSession: true,
    ...options,
  };
  const stats = { pages: [], writes: [], blocked: [], aborted: 0, loginPages: 0, promoVisits: 0, appsNewVisits: 0 };
  let abortedOnce = false;
  let navClickPending = false;

  const base = `https://${FAKE_HOSTS.studio}/environments/${FAKE_ENV_ID}`;
  const agentBase = (agent = FAKE_AGENT) => `${base}/bots/${agent.id}`;
  const toolsSegment = () => config.toolsSlug;

  const nav = (agent, current) => {
    const item = (segment, label) => `<a href="${agentBase(agent)}/${segment}"${current === segment ? ' aria-current="page"' : ""}>${label}</a>`;
    return `<nav class="side" aria-label="Agent navigation">${item("overview", "Overview")}${item("knowledge", "Knowledge")}${item(toolsSegment(), "Tools")}${item("topics", "Topics")}${item("analytics", "Analytics")}${item("settings", "Settings")}</nav>`;
  };

  const envNav = (current) =>
    `<nav class="side" aria-label="Environment navigation"><a href="${base}/home"${current === "home" ? ' aria-current="page"' : ""}>Home</a><a href="${base}/agents"${current === "agents" ? ' aria-current="page"' : ""}>Agents</a><a href="${base}/apps/new">Apps</a></nav>`;

  const topBar = (agent) =>
    `<header class="top"><b>Copilot Studio</b>${agent ? `<span>${esc(agent.name)}</span><button type="button" id="test-toggle">Test</button><button type="button" id="publish">Publish</button>` : ""}<span style="margin-left:auto">Ada Lovelace ada@contoso.com</span></header>`;

  const testPane = `<aside class="test" id="test-pane" hidden aria-label="Test your agent"><b>Test your agent</b><div id="chat"></div><input id="chat-input" aria-label="Type your message" placeholder="Type your message"><button type="button" id="chat-send">Send</button></aside>`;

  // One delegated handler, so pages that fill in their content later (innerHTML never runs scripts) still work.
  const GLOBAL_SCRIPT = `document.addEventListener('click',function(e){var t=e.target.closest&&e.target.closest('button,a');if(!t)return;var id=t.id;
if(t.tagName==='A'&&t.closest('nav.side')&&t.href.indexOf('/bots/')>0){e.preventDefault();fetch('/__nav',{method:'POST'}).finally(function(){location.href=t.href})}
else if(id==='test-toggle'){document.getElementById('test-pane').hidden=false}
else if(id==='publish'){fetch('/__write/publish',{method:'POST'});document.body.insertAdjacentHTML('beforeend','<div role="alert">Your agent was published.</div>')}
else if(id==='chat-send'){var v=document.getElementById('chat-input').value;document.getElementById('chat').insertAdjacentHTML('beforeend','<p>You: '+v.replace(/</g,'')+'</p><p>Agent: Here is an answer.</p>')}
else if(id==='add-knowledge'){document.getElementById('knowledge-dialog').show()}
else if(id==='add-to-agent'){fetch('/__write/add-knowledge',{method:'POST'})}
else if(id==='create-blank'){fetch('/__write/create-agent',{method:'POST'})}
else if(id==='tab-genai'){document.querySelectorAll('[role=tab]').forEach(function(x){x.setAttribute('aria-selected',String(x.id==='tab-genai'))});document.getElementById('panel').innerHTML='<h2>Orchestration</h2><p>Use generative AI orchestration for your agent&#39;s responses?</p><label><input type="radio" name="o" checked> Yes</label> <label><input type="radio" name="o"> No</label>'}
});`;

  /** A page whose main area shows a skeleton for `delay` ms, then the content (or, with `boot`, a bare spinner that is replaced whole). */
  function shell({ title, agent = null, sideNav, content, delay, boot = false, late = "" }) {
    const frame = (inner, busy) => `${topBar(agent)}<div class="layout">${sideNav}<main id="main"${busy ? ' aria-busy="true"' : ""}>${inner}</main></div>${agent ? testPane : ""}`;
    const skeleton = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
    const initial = boot ? `<div id="boot" role="progressbar" aria-label="Loading" class="spinner"></div>` : frame(skeleton, true);
    const fill = boot ? `document.body.innerHTML=${JSON.stringify(frame(content, false))}` : `var m=document.getElementById('main');m.innerHTML=${JSON.stringify(content)};m.removeAttribute('aria-busy')`;
    const lateJs = late ? `setTimeout(function(){${late}},${Number(config.lateTextMs) || 600});` : "";
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>${STYLE}</head><body>${initial}<script>${GLOBAL_SCRIPT}</script><script>setTimeout(function(){${fill};${lateJs}},${Number(delay) || 0})</script></body></html>`;
  }
  function delayFor(name) {
    return Number.isFinite(config.delays[name]) ? config.delays[name] : config.defaultDelayMs;
  }

  function page(url, agent, navClick = false) {
    const segs = url.pathname.split("/").filter(Boolean);
    // /environments/<env>/<area>[/<id>/<section>]
    const area = segs[2] || "";
    if (area === "home") {
      return shell({
        title: "Home",
        current: "home",
        sideNav: envNav("home"),
        delay: delayFor("home"),
        content:
          `<h1>What would you like to build?</h1><textarea aria-label="Describe your agent" rows="3" cols="50" placeholder="Describe the agent you want"></textarea><br><button type="button">Submit</button>` +
          `<div class="card"><h2>Start building from scratch</h2><p>Choose Agent to begin. Settings and Instructions can be changed later.</p></div>` +
          `<div class="promo"><a href="${base}/apps/new">Knowledge</a> <span>Bring your own data to an app.</span></div>`,
      });
    }
    if (area === "agents" && segs.length === 3) {
      return shell({
        title: "Agents",
        current: "agents",
        sideNav: envNav("agents"),
        delay: delayFor("agents"),
        content:
          `<h1>Agents</h1><div><a href="${agentBase()}/overview"><b>${esc(FAKE_AGENT.name)}</b></a> Last edited today</div>` +
          `<div><a href="${agentBase(OTHER_AGENT)}/overview"><b>${esc(OTHER_AGENT.name)}</b></a> Last edited last week</div>` +
          `<p><button type="button" id="create-blank">Create blank agent</button></p>`,
      });
    }
    if (area === "apps") {
      stats.appsNewVisits += 1;
      return shell({ title: "Create an app", sideNav: envNav("apps"), delay: delayFor("apps"), content: `<h1>Create an app</h1><p>Pick a template to start a new app.</p>` });
    }
    if (area === "bots" && agent) {
      let section = segs[4] || "overview";
      const known = ["overview", "knowledge", toolsSegment(), "topics", "analytics", "settings"];
      if (!known.includes(section)) section = "overview";
      // Some tenants do not honor a typed address for a section: only the side navigation reaches it.
      if (!config.directSections && section !== "overview" && !navClick) {
        return `<!doctype html><title>Redirecting</title><script>location.replace(${JSON.stringify(`${agentBase(agent)}/overview`)})</script>`;
      }
      const delay = section === "overview" && config.overviewBlankMs ? config.overviewBlankMs : delayFor(section);
      const boot = section === "overview" && config.overviewBlankMs > 0;
      const sideNav = nav(agent, section);
      if (section === "overview") {
        return shell({
          title: `${agent.name} - Overview`,
          agent,
          current: section,
          sideNav,
          delay,
          boot,
          late: config.lateTextMs ? `document.getElementById('instr-text').textContent='You are an energy resources assistant. Answer only from approved documents.';document.getElementById('instr').textContent='Instructions (saved)'` : "",
          content: `<h1>${esc(agent.name)}</h1><section class="card" aria-labelledby="instr"><h2 id="instr">Instructions</h2><p id="instr-text">${config.lateTextMs ? "Loading..." : "You are an energy resources assistant. Answer only from approved documents."}</p></section><section class="card"><h2>Knowledge</h2><p>No knowledge added yet.</p></section>`,
        });
      }
      if (section === "knowledge") {
        return shell({
          title: `${agent.name} - Knowledge`,
          agent,
          current: section,
          sideNav,
          delay,
          content: `<h1>Knowledge</h1><button type="button" id="add-knowledge">Add knowledge</button><dialog id="knowledge-dialog" aria-label="Add knowledge"><h2>Add knowledge</h2><button type="button">SharePoint</button> <button type="button" id="add-to-agent">Add to agent</button></dialog>`,
        });
      }
      if (section === toolsSegment()) {
        return shell({ title: `${agent.name} - Tools`, agent, current: section, sideNav, delay, content: `<h1>Tools</h1><button type="button">Add a tool</button><p>No tools yet.</p>` });
      }
      if (section === "topics") {
        return shell({ title: `${agent.name} - Topics`, agent, current: section, sideNav, delay, content: `<h1>Topics</h1><p>System topics and custom topics.</p>` });
      }
      if (section === "analytics") {
        return shell({ title: `${agent.name} - Analytics`, agent, current: section, sideNav, delay, content: `<h1>Analytics</h1><p>Sessions, satisfaction, and themes.</p>` });
      }
      // settings: the General tab is open; Generative AI is a tab
      return shell({
        title: `${agent.name} - Settings`,
        agent,
        current: "settings",
        sideNav,
        delay,
        content:
          `<h1>Settings</h1><div role="tablist" aria-label="Settings sections"><button role="tab" aria-selected="true" id="tab-general">General</button><button role="tab" aria-selected="false" id="tab-genai">Generative AI</button><button role="tab" aria-selected="false" id="tab-security">Security</button></div>` +
          `<div id="panel">General settings: name, language, and icon.</div>`,
      });
    }
    return shell({ title: "Not found", sideNav: envNav(""), delay: 50, content: `<h1>That page was not found</h1>` });
  }

  function sharepointPage() {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Training - Home</title>${STYLE}</head><body><header class="top"><b>SharePoint</b></header><div class="layout"><nav class="side" aria-label="Site navigation"><a href="/sites/training">Home</a><a href="/sites/training/Shared%20Documents">Documents</a><a href="/sites/training/SitePages">Pages</a><a href="/sites/training/_layouts/15/viewlsts.aspx">Site contents</a></nav><main><h1>Training</h1><p>Welcome to the training site.</p></main></div></body></html>`;
  }

  function genericPage(host, title) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>${STYLE}</head><body><header class="top"><b>${esc(title)}</b></header><div class="layout"><main><h1>${esc(title)}</h1><p>${esc(host)}</p><div class="card">Create agent</div><div class="card">Agents</div></main></div></body></html>`;
  }

  async function handle(context, route) {
    const request = route.request();
    const url = new URL(request.url());
    const html = (body, status = 200, headers = {}) => route.fulfill({ status, contentType: "text/html; charset=utf-8", headers: { "cache-control": "no-store", ...headers }, body });
    if (url.pathname === "/favicon.ico") return route.fulfill({ status: 204, body: "" });
    if (url.pathname === "/__nav") {
      navClickPending = true;
      return route.fulfill({ status: 204, body: "" });
    }
    if (url.pathname.startsWith("/__write/")) {
      stats.writes.push(`${request.method()} ${url.pathname.replace("/__write/", "")}`);
      return route.fulfill({ status: 204, body: "" });
    }
    if (url.hostname === LOGIN_HOST) {
      stats.loginPages += 1;
      return html(`<!doctype html><title>Sign in to your account</title><h1>Sign in to your account</h1><input aria-label="Email"><button>Next</button>`);
    }
    if (config.requireSession) {
      const cookies = Object.fromEntries((await context.cookies(url.href)).map((c) => [c.name, c.value]));
      if (cookies.cs_session !== "1") {
        return html(`<!doctype html><title>Redirecting</title><meta http-equiv="refresh" content="0;url=https://${LOGIN_HOST}/common/oauth2/authorize?client_id=${esc(url.hostname)}"><h1>Redirecting</h1>`);
      }
    }
    stats.pages.push(`${url.hostname}${url.pathname}`);
    if (url.hostname === FAKE_HOSTS.sharepoint) return html(sharepointPage());
    if (url.hostname !== FAKE_HOSTS.studio) return html(genericPage(url.hostname, url.hostname));

    if (url.pathname === "/" || url.pathname === "") {
      if (config.abortFirstNavigation && !abortedOnce && request.isNavigationRequest()) {
        abortedOnce = true;
        stats.aborted += 1;
        return route.abort("aborted");
      }
      return html(`<!doctype html><title>Copilot Studio</title><div class="spinner" role="progressbar" aria-label="Loading"></div><script>setTimeout(function(){location.replace(${JSON.stringify(`${base}/home`)})},120)</script>`);
    }
    const segs = url.pathname.split("/").filter(Boolean);
    if (segs[0] === "environments" && segs[1] === FAKE_ENV_ID) {
      const botId = segs[2] === "bots" ? segs[3] : null;
      const agent = [FAKE_AGENT, OTHER_AGENT].find((a) => a.id === botId) || null;
      if (segs[2] === "bots" && !agent) return html(page(new URL(`${base}/home`), null), 404);
      const clicked = navClickPending && request.isNavigationRequest();
      if (request.isNavigationRequest()) navClickPending = false;
      return html(page(url, agent, clicked));
    }
    return html(page(new URL(`${base}/home`), null), 404);
  }

  return {
    config,
    stats,
    base,
    agentUrl: (section = "overview") => `${agentBase()}/${section}`,
    /** Answer for the fake hosts in this browser context. Every other address is refused. */
    async attach(context) {
      const hosts = [LOGIN_HOST, ...Object.values(FAKE_HOSTS)].map((h) => h.replace(/\./g, "\\."));
      await context.route(/^https?:\/\//, (route) => {
        stats.blocked.push(new URL(route.request().url()).hostname);
        return route.abort();
      });
      await context.route(new RegExp(`^https://(?:${hosts.join("|")})/`), (route) => handle(context, route));
      if (config.seedSession) {
        const expires = Math.floor(Date.now() / 1000) + 86_400;
        await context.addCookies(Object.values(FAKE_HOSTS).map((domain) => ({ name: "cs_session", value: "1", domain, path: "/", secure: true, sameSite: "None", expires })));
      }
    },
  };
}

/**
 * Wrap a real Playwright module so every browser context the companion opens is attached to the fake site.
 * Records each launch, and keeps the contexts so a test can close one mid-run.
 */
export function withFakeProductSite(playwright, site, { forceChannel = undefined, onContext = null } = {}) {
  const launches = [];
  const contexts = [];
  const wrapType = (type, name) =>
    new Proxy(type, {
      get(target, prop) {
        if (prop !== "launchPersistentContext") return typeof target[prop] === "function" ? target[prop].bind(target) : target[prop];
        return async (dir, opts = {}) => {
          const options = forceChannel === undefined ? { ...opts } : { ...opts, ...(forceChannel ? { channel: forceChannel } : {}) };
          launches.push({ dir, options: { ...opts }, type: name });
          const context = await target.launchPersistentContext(dir, options);
          contexts.push(context);
          await site.attach(context);
          if (onContext) onContext(context);
          return context;
        };
      },
    });
  return { chromium: wrapType(playwright.chromium, "chromium"), launches, contexts };
}
