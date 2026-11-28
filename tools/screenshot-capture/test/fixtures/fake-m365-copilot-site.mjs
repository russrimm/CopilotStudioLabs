// A pretend Microsoft 365 Copilot with Agent Builder, shaped like the REAL pages as they were read on a real tenant on 2026-11-27 (read only, 1440 by 900, nothing typed,
// saved, or created). It answers the real host names through Playwright route interception, so nothing leaves this computer and the companion's own host and address checks
// are exercised. It is separate from fake-product-site.mjs, whose Microsoft 365 Copilot page is the older layout that no longer exists.
//
//   m365.cloud.microsoft/chat            redirects to https://copilot.cloud.microsoft/home (the start page)
//   copilot.cloud.microsoft/home         the side bar (links Copilot home, New, Search, Library, Automations, Plugins, Workspaces; buttons Apps and more, Tasks, Collapse
//                                        sidebar, Agents, Projects; tabs Home and Code), and the message box "Message Copilot" with the radios Chat and Cowork.
//                                        The side bar BUTTON named Agents does NOT navigate: it opens a flyout, a dialog named "Agents menu" that lists the person's agents as
//                                        links, then a LINK named "New agent" (to /agents/new) and a link "More agents & plugins".
//   copilot.cloud.microsoft/agents/new   the start screen of Agent Builder (the address gets ?redirfrom=mcmToCcm): the heading "Build your own specialist agent", the button
//                                        Skip, the text box "Message Agent Builder", the buttons "Add and manage sources" and "Start dictation", a source filter tab strip
//                                        (All, Files, Meetings, Chats, Channels, Sites, Fabric), the tabs Templates and My agents, and template buttons. There are NO Describe or
//                                        Configure tabs: the builder is conversational. What Skip does, and every screen after a message is sent, were never read, so they do not exist here.
//
// Anything the computer must not do on this screen (Skip, a template, View all, Add and manage sources, Start dictation, sending a message) is recorded in `stats.writes`,
// so a test can prove that nothing was clicked besides the Agents button and the New agent link.

const LOGIN_HOST = "login.microsoftonline.com";
export const FAKE_M365_HOSTS = Object.freeze({ chat: "m365.cloud.microsoft", copilot: "copilot.cloud.microsoft" });
export const FAKE_M365_START_URL = `https://${FAKE_M365_HOSTS.chat}/chat`;
export const FAKE_M365_HOME_URL = `https://${FAKE_M365_HOSTS.copilot}/home`;
export const FAKE_M365_NEW_AGENT_URL = `https://${FAKE_M365_HOSTS.copilot}/agents/new`;

const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const STYLE = `<style>
body{margin:0;font:15px Segoe UI,Arial,sans-serif;color:#1f2937;background:#f7f7fb}
.shell{display:flex;min-height:900px}
nav.side{width:250px;background:#efeef7;padding:12px;border-right:1px solid #d6d3e6;box-sizing:border-box}
nav.side a,nav.side button{display:block;width:100%;text-align:left;padding:7px 10px;margin:2px 0;border:0;border-radius:6px;background:none;color:#2b2a4c;text-decoration:none;font:inherit;cursor:pointer}
nav.side a:hover,nav.side button:hover{background:#dedcf0}
nav.side h2{font-size:12px;text-transform:uppercase;color:#6b6a8a;margin:14px 10px 4px}
nav.side [role=tablist]{display:flex;gap:4px;margin:8px 0}
nav.side [role=tab]{width:auto;flex:1;text-align:center}
nav.side [role=tab][aria-selected=true]{background:#fff;font-weight:600}
main{flex:1;padding:32px 48px;position:relative}
main h1{font-size:30px;margin:48px 0 8px}
.composer{max-width:760px;margin:24px 0;padding:14px;border:1px solid #cfcde6;border-radius:12px;background:#fff}
.composer textarea{width:100%;box-sizing:border-box;border:0;outline:0;font:inherit;resize:none;min-height:56px}
.composer .row{display:flex;gap:10px;align-items:center;margin-top:8px}
.composer button,.chips button,.skip{border:1px solid #cfcde6;border-radius:8px;background:#fff;padding:6px 12px;font:inherit;cursor:pointer}
.skip{position:absolute;right:48px;top:28px}
.flyout{position:absolute;left:262px;top:300px;width:320px;background:#fff;border:1px solid #bdbad8;border-radius:10px;padding:10px;box-shadow:0 8px 24px rgba(30,27,75,.2);z-index:20}
.flyout ul{list-style:none;margin:0 0 8px;padding:0}
.flyout a{display:block;padding:7px 10px;border-radius:6px;color:#2b2a4c;text-decoration:none}
.flyout a:hover{background:#efeef7}
.chips{display:flex;gap:10px;flex-wrap:wrap;margin:10px 0}
.card{border:1px solid #cfcde6;border-radius:10px;background:#fff;padding:12px;width:220px}
[role=tablist].strip{display:flex;gap:8px;margin:12px 0;border-bottom:1px solid #d6d3e6}
.strip [role=tab]{border:0;background:none;padding:6px 10px;font:inherit;cursor:pointer}
.strip [role=tab][aria-selected=true]{border-bottom:3px solid #5b5fc7;font-weight:600}
.spinner{margin:300px auto;width:26px;height:26px;border:4px solid #e5e7eb;border-top-color:#9ca3af;border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
</style>`;

const CLIENT = `(function(){
function act(name){try{fetch('/__act/'+encodeURIComponent(name),{method:'POST',keepalive:true})}catch(e){}}
document.addEventListener('click',function(e){
  var t=e.target.closest('[data-act]'); if(!t) return;
  var a=t.getAttribute('data-act');
  if(a==='agents-flyout'){var m=document.getElementById('agents-menu'); if(m){m.hidden=!m.hidden}; act('open-agents-menu'); return}
  act(a);
});
})();`;

/**
 * @param {object} [options]
 * @param {number} [options.homeDelayMs] how long the start page shows a spinner before its side bar draws
 * @param {"dialog"|"none"} [options.flyout] what the side bar button Agents does: opens the dialog "Agents menu" (the real behavior), or nothing at all
 * @param {boolean} [options.newAgentLink] the Agents menu has the link "New agent" (the real behavior); false: it lists the agents and the link "More agents & plugins" only
 * @param {boolean} [options.startScreen] /agents/new draws the start screen (the real behavior); false: a page with neither the heading nor the message box
 * @param {boolean} [options.agentsLink] the OLD layout: Agents is a link to /agents (a page with a Create agent button in the main area) and there is no flyout
 */
export function createFakeM365CopilotSite(options = {}) {
  const config = { homeDelayMs: 250, flyout: "dialog", newAgentLink: true, startScreen: true, agentsLink: false, ...options };
  const stats = { pages: [], writes: [], dangers: [], blocked: [], adminVisits: 0, redirects: 0, flyoutOpens: 0, directBuilderVisits: 0, newAgentVisits: 0, loginPages: 0 };

  const agentLinks = `<li><a href="/chat/agent/researcher">Researcher</a></li><li><a href="/chat/agent/writing-coach">Writing coach</a></li>`;

  function sideBar() {
    const agents = config.agentsLink ? `<a href="/agents">Agents</a>` : `<button type="button" ${config.flyout === "dialog" ? 'data-act="agents-flyout"' : ""}>Agents</button>`;
    return `<nav class="side" aria-label="Side bar">
<a href="/home" aria-label="Copilot, home">Copilot</a>
<button type="button">Apps and more</button>
<button type="button">Tasks</button>
<button type="button">Collapse sidebar</button>
<div role="tablist" aria-label="Mode"><button type="button" role="tab" aria-selected="true">Home</button><button type="button" role="tab" aria-selected="false">Code</button></div>
<a href="/home">New</a>
<a href="/search">Search</a>
<a href="/library">Library</a>
<a href="/automations">Automations</a>
<a href="/plugins">Plugins</a>
${agents}
<a href="/workspaces">Workspaces</a>
<button type="button">Projects</button>
<button type="button">New project</button>
<button type="button">Add project here</button>
<h2>Recent</h2>
<ul style="list-style:none;margin:0;padding:0"><li><a href="/chat/recent/1">Quarterly planning notes</a></li><li><a href="/chat/recent/2">Meeting summary</a></li></ul>
<button type="button">Account menu</button>
<button type="button">Settings and more</button>
</nav>`;
  }

  const flyout = () =>
    config.flyout === "dialog" && !config.agentsLink
      ? `<div id="agents-menu" role="dialog" aria-label="Agents menu" class="flyout" hidden><ul>${agentLinks}</ul>${config.newAgentLink ? '<a href="/agents/new">New agent</a>' : ""}<a href="/agents/store">More agents &amp; plugins</a></div>`
      : "";

  const shell = (title, body, { loading = 0 } = {}) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>${STYLE}</head><body>${loading ? `<div class="spinner" id="spin" role="progressbar" aria-label="Loading"></div>` : ""}<div class="shell" id="app"${loading ? ' style="display:none"' : ""}>${sideBar()}<main id="main">${body}</main></div>${flyout()}<script>${CLIENT}${loading ? `setTimeout(function(){var s=document.getElementById('spin');if(s)s.remove();document.getElementById('app').style.display='flex'},${Number(loading)})` : ""}</script></body></html>`;

  // A page that draws its side bar a moment after it loads, as the real one does.
  const homePage = () =>
    shell(
      "Microsoft Copilot",
      `<h1>Good to see you</h1><div class="composer"><textarea aria-label="Message Copilot" placeholder="Message Copilot"></textarea><div class="row"><label><input type="radio" name="mode" checked> Chat</label><label><input type="radio" name="mode"> Cowork</label><button type="button" data-act="model-settings">Model and generation settings: Auto</button></div></div>`,
      { loading: config.homeDelayMs },
    );

  const startScreen = () =>
    config.startScreen
      ? shell(
          "Microsoft Copilot",
          `<button type="button" class="skip" data-act="skip">Skip</button><h1>Build your own specialist agent</h1>
<div class="composer"><textarea aria-label="Message Agent Builder" placeholder="Message Agent Builder"></textarea><div class="row"><button type="button" data-act="add-sources">Add and manage sources</button><button type="button" data-act="dictation">Start dictation</button></div>
<div role="tablist" class="strip" aria-label="Source filter">${["All", "Files", "Meetings", "Chats", "Channels", "Sites", "Fabric"].map((name, i) => `<button type="button" role="tab" aria-selected="${i === 0}" data-act="source-filter">${name}</button>`).join("")}</div></div>
<div role="tablist" class="strip" aria-label="Agent list"><button type="button" role="tab" aria-selected="true" data-act="tab-templates">Templates</button><button type="button" role="tab" aria-selected="false" data-act="tab-my-agents">My agents</button></div>
<div class="chips"><button type="button" class="card" data-act="template-plan-my-day">Plan My Day template</button><button type="button" class="card" data-act="template-project-delta-digest">Project Delta Digest template</button><button type="button" class="card" data-act="template-executive-briefing">Executive Briefing Agent template</button><button type="button" data-act="view-all">View all</button></div>`,
        )
      : shell("Microsoft Copilot", `<h1>Something went wrong</h1><p>This page could not be shown.</p>`);

  const agentsPage = () => shell("Agents", `<h1>Agents</h1><div class="card"><b>Researcher</b></div><div class="card"><b>Writing coach</b></div><p><button type="button" data-act="create-agent">Create agent</button></p>`);

  async function handle(route) {
    const request = route.request();
    const url = new URL(request.url());
    const html = (body, status = 200) => route.fulfill({ status, contentType: "text/html; charset=utf-8", headers: { "cache-control": "no-store" }, body });
    const json = (value) => route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(value) });
    // A redirect is a page that moves itself: a fulfilled 302 is followed by the browser OUTSIDE the interception, which would reach the real host.
    const redirect = (to) => {
      stats.redirects += 1;
      return html(`<!doctype html><title>Redirecting</title><script>location.replace(${JSON.stringify(to)})</script>`);
    };
    if (url.pathname.startsWith("/__act/")) {
      const what = decodeURIComponent(url.pathname.replace("/__act/", ""));
      if (what === "open-agents-menu") stats.flyoutOpens += 1;
      else stats.writes.push(what);
      return json({});
    }
    if (url.hostname === LOGIN_HOST) {
      stats.loginPages += 1;
      return html(`<!doctype html><title>Sign in to your account</title><h1>Sign in to your account</h1><input aria-label="Email"><button>Next</button>`);
    }
    if (url.hostname === FAKE_M365_HOSTS.chat) {
      if (url.pathname === "/chat" || url.pathname === "/") return redirect(FAKE_M365_HOME_URL);
      return html(shell("Not found", `<h1>That page was not found</h1>`), 404);
    }
    stats.pages.push(`${url.hostname}${url.pathname}`);
    if (url.pathname.startsWith("/admin")) stats.adminVisits += 1;
    if (url.pathname === "/home" || url.pathname === "/") return html(homePage());
    if (url.pathname === "/agents/new") {
      // The address that was typed (no referring page) is counted: Agent Builder is reached through the Agents menu.
      if (!url.searchParams.has("redirfrom")) {
        const referer = await request.headerValue("referer").catch(() => null);
        if (!referer) stats.directBuilderVisits += 1;
      }
      stats.newAgentVisits += 1;
      // The real address gets ?redirfrom=mcmToCcm: the page adds it to its own address.
      return html(startScreen().replace("</body>", `<script>if(!location.search)history.replaceState(null,'','/agents/new?redirfrom=mcmToCcm')</script></body>`));
    }
    if (url.pathname === "/agents") return html(agentsPage());
    if (url.pathname === "/agents/store") return html(shell("Agent store", `<h1>Agents and plugins</h1>`));
    return html(shell("Microsoft Copilot", `<h1>That page was not found</h1>`), 404);
  }

  return {
    config,
    stats,
    homeUrl: FAKE_M365_HOME_URL,
    newAgentUrl: FAKE_M365_NEW_AGENT_URL,
    /** The shape the capture scenarios read from a pretend product site: this one has no practice agents. */
    practiceAgents: () => [],
    /** Answer for the fake hosts in this browser context. Every other address is refused. */
    async attach(context) {
      const hosts = [LOGIN_HOST, ...Object.values(FAKE_M365_HOSTS)].map((h) => h.replace(/\./g, "\\."));
      await context.route(/^https?:\/\//, (route) => {
        stats.blocked.push(new URL(route.request().url()).hostname);
        return route.abort();
      });
      await context.route(new RegExp(`^https://(?:${hosts.join("|")})/`), (route) => handle(route));
    },
  };
}
