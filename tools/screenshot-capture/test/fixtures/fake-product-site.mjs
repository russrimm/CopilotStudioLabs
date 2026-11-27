// A pretend Microsoft Copilot Studio (and a SharePoint site and a Microsoft 365 Copilot with Agent Builder) for
// real-browser capture tests. It answers requests for the real product host names through Playwright route
// interception, so nothing leaves this computer and the companion's real host patterns and address checks are
// exercised.
//
// It imitates the structure that broke the real captures, and the screens that need more than an address:
//   /                                   sends the browser to the environment's home page after a moment
//   /environments/<env>/home            home page; a "Knowledge" promo card links to the wrong place (/apps/new)
//   /environments/<env>/agents          the list of agents (open one, or "Create blank agent": a write)
//   /environments/<env>/agents/new      the create-agent form (a Name field and a Create button)
//   /environments/<env>/bots/<id>/...   an agent with a side navigation: Overview, Knowledge, Tools, Topics,
//                                       Analytics, Settings; a Test button (the test pane streams its answer after
//                                       a delay, behind a typing indicator); a Publish button that opens a dialog
//                                       with a confirming Publish button; Add knowledge, a dialog that must be
//                                       canceled; lists whose items open a details panel
//   /environments/<env>/apps/new        a decoy "Create an app" page
//   /environments/<env>/admin           an admin settings page: nothing on it may ever be touched
//   m365.cloud.microsoft/chat           Microsoft 365 Copilot; Agents lists agents, and Create agent opens Agent
//                                       Builder inside the page. Agent Builder has no address of its own
// Every page shows a loading skeleton for a while (aria-busy, progressbar) before its content appears; the agent
// overview can stay a white page with a spinner for several seconds, and fills in a field late.
//
// Options add the things that make a real product hard: a cookie banner, an unsaved-changes prompt, controls named by
// aria-label instead of text, a test pane in an iframe, a dialog in a shadow root, a control that only works on the
// second try.
//
// Anything that would change a tenant is recorded in `stats.writes` (create, publish, add knowledge), and anything the
// companion must never touch (Sign out, Delete agent, Share, the admin page's controls) in `stats.dangers`, so a test
// can prove exactly what was and was not done.

const LOGIN_HOST = "login.microsoftonline.com";
import { handleNewerWrite, newerContent, newerExtraBody, newerState, newerTop } from "./fake-newer-layout.mjs";
export const FAKE_HOSTS = Object.freeze({
  studio: "copilotstudio.microsoft.com",
  // The classic experience lives on its own host (observed on a real tenant): "Open classic experience" opens it in a NEW TAB, and a Standard agent opens there.
  previewStudio: "copilotstudio.preview.microsoft.com",
  sharepoint: "contoso.sharepoint.com",
  m365: "m365.cloud.microsoft",
  powerAdmin: "admin.powerplatform.microsoft.com",
});
export const FAKE_ENV_ID = "6b988893-6c74-4e65-9d9a-f7f044be1d08";
export const FAKE_PRACTICE_ENV_ID = "c2f3a1b4-8d5e-4f6a-9b7c-0d1e2f3a4b5c";
export const FAKE_AGENT = Object.freeze({ id: "0f6c2d9a-3a54-4a64-8c61-5b1d7a2e9c11", name: "Energy Assistant" });
const OTHER_AGENT = Object.freeze({ id: "9b2e7f10-41cd-4f0e-a3a7-2c8d5e6f7a22", name: "Energy Assistant (test copy)" });
export const FAKE_SITE_URL = `https://${FAKE_HOSTS.sharepoint}/sites/training`;
export const FAKE_AGENT_URL = `https://${FAKE_HOSTS.studio}/environments/${FAKE_ENV_ID}/bots/${FAKE_AGENT.id}/overview`;
export const FAKE_PRACTICE_ENV_URL = `https://${FAKE_HOSTS.studio}/environments/${FAKE_PRACTICE_ENV_ID}/home`;
export const FAKE_M365_URL = `https://${FAKE_HOSTS.m365}/chat`;

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
aside.test{position:fixed;right:0;top:56px;width:300px;height:520px;background:#fff;border-left:1px solid #94a3b8;padding:12px;overflow:auto}
aside.details{position:fixed;right:0;top:56px;width:320px;height:360px;background:#fff;border-left:1px solid #94a3b8;padding:12px}
dialog{border:1px solid #475569;border-radius:8px;padding:20px;width:420px}
dialog::backdrop{background:rgba(15,23,42,.45)}
.typing{display:flex;gap:4px;padding:6px 0}.typing i{width:8px;height:8px;border-radius:50%;background:#64748b;animation:blink 1s infinite}
@keyframes blink{50%{opacity:.25}}
.cookie-banner{position:fixed;left:0;right:0;bottom:0;background:#0f172a;color:#fff;padding:14px 20px;display:flex;gap:12px;align-items:center;z-index:50}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#065f46;color:#fff;padding:10px 16px;border-radius:6px}
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
 * @param {number} [options.chatDelayMs] how long the test pane shows a typing indicator before the answer starts
 * @param {number} [options.chatStreamMs] how long the answer takes to stream in
 * @param {boolean} [options.cookieBanner] a cookie banner covers the bottom of every page until it is accepted
 * @param {boolean} [options.leavePrompt] leaving a page with an unsaved chat message asks "Are you sure you want to leave?"
 * @param {boolean} [options.labelVariants] controls are named by aria-label and icons, not by their visible text
 * @param {boolean} [options.testPaneInIframe] the test pane's chat is inside an iframe
 * @param {boolean} [options.shadowDialog] the Add knowledge dialog is inside a shadow root
 * @param {boolean} [options.flakyKnowledge] the first click on Add knowledge does nothing
 * @param {string} [options.testButtonName] what the Test button is called (a renamed button the built-in steps do not know)
 * @param {"classic"|"newer"} [options.layout] the agent layout: a side navigation (classic), or the Build, Preview, Evaluate, and Monitor tabs (newer)
 * @param {boolean} [options.licenseOnPublish] (newer) Publish opens a "You need a license" alert dialog instead of the publish dialog
 * @param {boolean} [options.quotaOnSave] (newer) saving shows an alert that the limit was reached
 * @param {boolean} [options.createDisabled] (newer) the account cannot create agents: the Agents page has no New agent button
 * @param {boolean} [options.stayOnNew] (newer) the new-agent page keeps its own address after Save (the agent is made, the page says Saved)
 * @param {string} [options.knowledgeDialogTitle] (newer) the title of the Add knowledge dialog (an unknown title must never be confirmed)
 * @param {boolean} [options.editableInstructions] (classic) the Overview page edits its instructions in place: a text box and a Save button that is available only while something is unsaved
 * @param {boolean} [options.signedOutHome] the home page is the product's public page: a Sign in button at the top, no account anywhere
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
    chatDelayMs: 900,
    chatStreamMs: 700,
    cookieBanner: false,
    leavePrompt: false,
    labelVariants: false,
    testPaneInIframe: false,
    shadowDialog: false,
    flakyKnowledge: false,
    testButtonName: "",
    layout: "classic",
    licenseOnPublish: false,
    quotaOnSave: false,
    createDisabled: false,
    stayOnNew: false,
    knowledgeDialogTitle: "",
    editableInstructions: false,
    signedOutHome: false,
    // The Standard (Classic) and Microsoft Copilot harnesses, modeled on what a real tenant did (observed 2026-11-24). `harnessMode` makes each agent belong to a
    // harness (`agent.harness`) and the two experiences live on two HOSTS: the default host (Home, Agents, Workflows, Apps; Microsoft Copilot agents with the
    // Build, Preview, Evaluate, and Monitor tabs) and the preview host (the classic experience: Home, Chat, Agents, Workflows, Apps; a Standard agent at
    // /bots/<id>/overview with a TAB STRIP: Overview, Knowledge, Tools, Agents, Topics, Activity, Evaluation). A Standard agent opened on the default host
    // redirects, in the same tab, to the preview host. The "More options" menu in the lower left corner is IDENTICAL in every experience (it always offers
    // "Open classic experience"); choosing it shows the feedback prompt, and then the classic experience opens in a NEW TAB. The Agents list is a table with an
    // "Agent harness" column and "Open <name>" buttons, and "More create options" offers three ways to create an agent.
    harnessMode: false,
    // What "Open classic experience" does after the feedback prompt: "new-tab" (the real behavior), "same-tab" (the page itself moves to the preview host),
    // or "none" (nothing opens).
    classicOpens: "new-tab",
    // The feedback prompt after "Open classic experience": "skip" (Skip feedback and Submit), "submit-only" (Submit and nothing else), or "none" (no prompt).
    feedback: "skip",
    // There is no "More options" menu in the side bar at all.
    noExperienceMenu: false,
    // The Agents list has the "More create options" menu (the real behavior); false: only the older New agent button.
    createMenu: true,
    // A tab's text is its label twice (a visible label and a hidden copy that keeps the tab from changing width), like the real tab strip: OverviewOverview.
    doubledTabText: true,
    // The preview address is not reachable: every page on it goes to the default host.
    previewUnavailable: false,
    // The Standard agent page as OBSERVED on a real tenant on 2026-11-26 (read only), instead of the older pretend one: the top bar has Search your agent, Publish, Settings, Options, and Test;
    // the tab strip has Overview, Knowledge, Tools, Agents, Topics, and an overflow tab named "N more options" (at 1400 pixels or wider Activity and Evaluation are tabs of their own and the
    // overflow holds Monitor and Channels; narrower, all four are in the overflow menu); the Overview tab has the cards (Details, Instructions, Knowledge, Tools, ...), where Edit
    // Instructions opens an inline editor (a contenteditable text box named "Describe what you want this agent to do, its tone, and rules", with Cancel and Save; Save is disabled until the text
    // changes; Cancel after a change asks Close, Discard, or Cancel); the Test your agent panel (with a second "describe" text box) is on every tab; Settings opens a full page at
    // /manage/advancedSettings with a list of links on the left. Needs `harnessMode`.
    realStandard: false,
    // (realStandard) the editor never registers typed text: Save stays disabled, as a page that ignores programmatic input would.
    editorIgnoresInput: false,
    // (realStandard) Save closes the editor instead of leaving it open with Save disabled.
    saveClosesEditor: false,
    ...options,
  };
  const stats = { pages: [], writes: [], dangers: [], views: [], blocked: [], aborted: 0, loginPages: 0, promoVisits: 0, appsNewVisits: 0, adminVisits: 0, answers: 0, cookieAccepts: 0, builderOpens: 0, directBuilderVisits: 0, classicClicks: 0, feedbackSkips: 0, feedbackSubmits: 0, rootVisits: 0, menuOpens: 0, popups: 0, createMenuOpens: 0, createPicks: [], redirects: 0, instructions: [] };
  let abortedOnce = false;
  let navClickPending = false;
  let nextId = 0;
  // The host the request being answered came in on: the pages link to their own host (the two experiences are on two hosts).
  let reqHost = FAKE_HOSTS.studio;

  // The pretend tenant: two environments, the agents in them, and what has been done to those agents.
  const agentHarnessOf = (agent, fallback) => (config.harnessMode ? { ...agent, harness: fallback } : agent);
  const envs = {
    [FAKE_ENV_ID]: { agents: [agentHarnessOf(FAKE_AGENT, config.fakeAgentHarness || "standard"), agentHarnessOf(OTHER_AGENT, config.otherAgentHarness || "microsoft-copilot")] },
    [FAKE_PRACTICE_ENV_ID]: { agents: [] },
  };
  const sessionLayout = () => config.layout;
  const agentLayout = (agent) => {
    if (!config.harnessMode) return config.layout;
    return agent.harness === "standard" ? "tabstrip" : "newer";
  };
  const knowledge = new Set();
  const published = new Set();
  const newer = newerState(published);
  const newBotId = () => `7a1c${(++nextId).toString(16).padStart(4, "0")}-5b3d-4e6f-8a9b-c0d1e2f3a4b5`;

  const envBase = (envId) => `https://${reqHost}/environments/${envId}`;
  const base = `https://${FAKE_HOSTS.studio}/environments/${FAKE_ENV_ID}`;
  const agentBase = (agent = FAKE_AGENT, envId = FAKE_ENV_ID) => `${envBase(envId)}/bots/${agent.id}`;
  const toolsSegment = () => config.toolsSlug;
  const findAgent = (envId, botId) => (envs[envId]?.agents || []).find((a) => a.id === botId) || null;
  // Where an agent really opens (harnessMode): a Standard agent on the preview host at /bots/<id>/, a Microsoft Copilot agent on the host the person is on at /agents/<id>.
  const agentHome = (agent, envId) => (agent.harness === "standard" ? `https://${FAKE_HOSTS.previewStudio}/environments/${envId}/bots/${agent.id}/overview` : `https://${reqHost}/environments/${envId}/agents/${agent.id}`);

  const nav = (agent, current, envId) => {
    const item = (segment, label) => `<a href="${agentBase(agent, envId)}/${segment}"${current === segment ? ' aria-current="page"' : ""}>${label}</a>`;
    return `<nav class="side" aria-label="Agent navigation">${item("overview", "Overview")}${item("knowledge", "Knowledge")}${item(toolsSegment(), "Tools")}${item("topics", "Topics")}${item("analytics", "Analytics")}${item("settings", "Settings")}</nav>`;
  };

  // A Standard agent's TAB STRIP (harnessMode): Overview, Knowledge, Tools, Agents, Topics, Activity, Evaluation, and an overflow button that is not a tab.
  const STANDARD_TABS = [["overview", "Overview"], ["knowledge", "Knowledge"], ["tools", "Tools"], ["agents", "Agents"], ["topics", "Topics"], ["activity", "Activity"], ["evaluation", "Evaluation"]];
  const standardTabs = (agent, current, envId) =>
    `<div role="tablist" aria-label="Agent sections" style="display:flex;gap:8px;align-items:center">${STANDARD_TABS.map(([segment, label]) => {
      const slug = segment === "tools" ? toolsSegment() : segment;
      const text = config.doubledTabText ? `<span>${label}</span><span aria-hidden="true" style="visibility:hidden;height:0;overflow:hidden;position:absolute">${label}</span>` : label;
      return `<a role="tab" href="${agentBase(agent, envId)}/${slug}" aria-selected="${current === segment || (segment === "tools" && current === toolsSegment())}">${text}</a>`;
    }).join("")}<button type="button" aria-label="2 more options" aria-haspopup="menu" data-act="danger" data-what="tabs-overflow">&#8230;</button></div>`;

  // The "More options" button in the lower left corner of the side bar. Its menu is the SAME in every experience (default, preview, and on a Standard agent
  // page) and always offers "Open classic experience", so the menu proves nothing about the page (observed on a real tenant, 2026-11-24).
  const HARNESS_MENU = ["See what's new", "Solutions", "Open classic experience", "Power Platform Admin Center", "Learning resources", "Session details"];
  const experienceMenu = () => {
    if (config.noExperienceMenu) return "";
    const items = HARNESS_MENU.map((label) => (label === "Open classic experience" ? `<button type="button" role="menuitem" data-act="x-classic">${label}</button>` : `<button type="button" role="menuitem" data-act="danger" data-what="menu-${label.toLowerCase().replace(/[^a-z]+/g, "-")}">${label}</button>`)).join("");
    return `<button type="button" id="x-ellipsis" aria-label="More options" aria-haspopup="menu" data-act="x-menu-open" style="position:fixed;left:12px;bottom:12px">&#8230;</button><div role="menu" id="x-menu" aria-label="More options menu" hidden style="position:fixed;left:12px;bottom:56px;background:#fff;border:1px solid #475569;padding:6px;z-index:30">${items}</div>`;
  };

  // The Agents list's "More create options" button and its menu (observed on a real tenant, 2026-11-24): three ways to create an agent. An account that cannot
  // create agents (`createDisabled`) is modeled with the button and an empty menu: what a real tenant shows such an account was not observed.
  const createMenuHtml = () => `<p><button type="button" id="create-more" aria-label="More create options" aria-haspopup="menu" data-act="create-menu-open">&#9662;</button></p><div role="menu" id="create-menu" aria-label="More create options menu" hidden>${config.createDisabled ? "" : '<button type="button" role="menuitem" data-act="create-pick" data-kind="copilot">Agent, uses Copilot Credits</button><button type="button" role="menuitem" data-act="create-pick" data-kind="customer">Customer conversation agent, uses Copilot Credits</button><button type="button" role="menuitem" data-act="create-pick" data-kind="standard">Agent, Standard</button>'}</div>`;

  const envNav = (current, envId) => {
    if (config.harnessMode) {
      // The default experience has Home, Agents, Workflows, Apps (Preview); the classic experience (preview host) adds Chat.
      const classicHost = reqHost === FAKE_HOSTS.previewStudio;
      const link = (id, label, path) => `<a href="${envBase(envId)}/${path}"${current === id ? ' aria-current="page"' : ""}>${label}</a>`;
      return `<nav class="side" aria-label="Environment navigation">${link("home", "Home", "home")}${classicHost ? link("chat", "Chat", "chat") : ""}${link("agents", "Agents", "agents")}${link("workflows", "Workflows", "workflows")}${link("apps", "Apps (Preview)", "apps/new")}${experienceMenu()}</nav>`;
    }
    return `<nav class="side" aria-label="Environment navigation"><a href="${envBase(envId)}/home"${current === "home" ? ' aria-current="page"' : ""}>Home</a><a href="${envBase(envId)}/agents"${current === "agents" ? ' aria-current="page"' : ""}>Agents</a><a href="${envBase(envId)}/apps/new">Apps</a>${experienceMenu()}</nav>`;
  };

  const lv = config.labelVariants;
  const topBar = (agent, envId) =>
    `<header class="top"><b>Copilot Studio</b>${
      agent
        ? `<span>${esc(agent.name)}</span><button type="button" id="test-toggle" data-act="test-toggle"${lv ? ' aria-label="Test your agent"' : ""}>${esc(config.testButtonName || (lv ? "\u25B6" : "Test"))}</button><button type="button" id="publish" data-act="publish-open">Publish</button><button type="button" data-act="danger" data-what="share">Share</button>`
        : ""
    }<span style="margin-left:auto">Ada Lovelace ada@contoso.com</span>${config.harnessMode ? '<button type="button" aria-label="Open account menu for Ada Lovelace" data-act="danger" data-what="account-menu">AL</button>' : ""}<button type="button" data-act="danger" data-what="sign-out">Sign out</button></header>`;

  const chatInputAttrs = lv ? 'aria-label="Ask a question or describe what you need" placeholder="Ask a question or describe what you need"' : 'aria-label="Type your message" placeholder="Type your message"';
  const sendButton = lv ? '<button type="button" id="chat-send" data-act="chat-send" aria-label="Send message">&#10148;</button>' : '<button type="button" id="chat-send" data-act="chat-send">Send</button>';
  const chatBody = `<div id="chat" aria-live="polite"></div><input id="chat-input" ${chatInputAttrs}>${sendButton}`;
  const testPane = (agent) =>
    config.testPaneInIframe
      ? `<aside class="test" id="test-pane" hidden aria-label="Test your agent"><b>Test your agent</b><iframe title="Test your agent chat" src="https://${FAKE_HOSTS.studio}/__frame/test?bot=${agent.id}" style="width:100%;height:440px;border:0"></iframe></aside>`
      : `<aside class="test" id="test-pane" hidden aria-label="Test your agent"><b>Test your agent</b>${chatBody}</aside>`;

  const cookieBanner = config.cookieBanner ? `<div class="cookie-banner" id="cookie" role="region" aria-label="Cookie banner"><span>This site uses cookies to improve your experience.</span><button type="button" data-act="cookie-accept">Accept all</button><button type="button" data-act="cookie-accept">Reject all</button></div>` : "";

  // Everything a click can do, in one delegated handler, so pages that fill in their content later (innerHTML never runs scripts) still work.
  const CLIENT = `(function(){
var CFG=window.__fake||{};
function $(id){return document.getElementById(id)}
function post(path,body){return fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})}).then(function(r){return r.json().catch(function(){return {}})})}
function ask(bot,text){
  var chat=$('chat'); if(!chat) return;
  window.__dirty=true;
  var you=document.createElement('p'); you.textContent='You: '+text; chat.appendChild(you);
  var typing=document.createElement('div'); typing.className='typing'; typing.setAttribute('aria-busy','true'); typing.setAttribute('aria-label','The agent is typing'); typing.innerHTML='<i></i><i></i><i></i>'; chat.appendChild(typing);
  post('/__ask',{bot:bot}).then(function(d){
    setTimeout(function(){
      var words=('Here is an answer based on your question. '+(d.cited?'It comes from your knowledge source. [1] Policies.docx':'')).split(' ');
      var p=document.createElement('p'); p.setAttribute('aria-label','Agent answer'); p.textContent='Agent: '; chat.insertBefore(p,typing);
      var i=0; var step=Math.max(60,Math.round((CFG.chatStreamMs||700)/Math.max(1,Math.ceil(words.length/3))));
      var timer=setInterval(function(){ p.textContent+=words.slice(i,i+3).join(' ')+' '; i+=3; if(i>=words.length){clearInterval(timer);typing.remove();} },step);
    },CFG.chatDelayMs||900);
  });
}
function ensureShadowDialog(){
  var host=$('kn-host'); if(!host) return null;
  if(!host.shadowRoot){
    var root=host.attachShadow({mode:'open'});
    root.innerHTML='<div role="dialog" aria-label="Add knowledge" hidden style="position:fixed;left:30%;top:20%;width:420px;background:#fff;border:1px solid #475569;border-radius:8px;padding:20px;z-index:40"><h2>Add knowledge</h2><button type="button" data-act="kn-source">SharePoint</button> <button type="button" data-act="kn-add">Add to agent</button> <button type="button" data-act="kn-cancel">Cancel</button></div>';
  }
  return host.shadowRoot.querySelector('[role=dialog]');
}
function openKnowledge(){
  if(CFG.flakyKnowledge && !window.__knClicked){window.__knClicked=true;return}
  if(CFG.shadowDialog){var shadowDialog=ensureShadowDialog(); if(shadowDialog) shadowDialog.hidden=false; return}
  var d=$('knowledge-dialog'); if(d) d.show();
}
function closeKnowledge(){
  if(CFG.shadowDialog){var shadowDialog=ensureShadowDialog(); if(shadowDialog) shadowDialog.hidden=true; return}
  var d=$('knowledge-dialog'); if(d&&d.open) d.close();
}
function layoutTabs(){
  var wide=window.innerWidth>=1400;
  document.querySelectorAll('[data-wide-tab]').forEach(function(el){el.style.display=wide?'':'none'});
  document.querySelectorAll('[data-narrow-item]').forEach(function(el){el.style.display=wide?'none':''});
  var more=$('r-overflow');
  if(more){var count=wide?2:4; more.setAttribute('aria-label',count+' more options'); more.textContent='+'+count}
}
window.__layoutTabs=layoutTabs;
window.addEventListener('resize',layoutTabs);
function instrText(){var b=$('instr-box'); return b?String(b.innerText||'').trim():''}
function instrChanged(){return instrText()!==String(window.__savedInstr||'').trim()}
function closeEditor(){var e=$('instr-editor'); if(e) e.hidden=true; var b=$('r-edit-instr'); if(b) b.hidden=false; var p=$('instr-text'); if(p) p.hidden=false}
document.addEventListener('click',function(e){
  var path=e.composedPath?e.composedPath():[e.target]; var t=path[0]; t=t&&t.closest?t.closest('button,a'):null; if(!t) return;
  var act=t.getAttribute('data-act'); var bot=document.body.getAttribute('data-bot')||''; var env=document.body.getAttribute('data-env')||'';
  if(t.tagName==='A'&&t.closest('nav.side')&&t.href.indexOf('/bots/')>0){
    e.preventDefault();
    if(CFG.leavePrompt&&window.__dirty){window.__leaveTo=t.href;var u=$('unsaved');if(u)u.showModal();return}
    fetch('/__nav',{method:'POST'}).finally(function(){location.href=t.href}); return;
  }
  if(!act) return;
  if(act==='test-toggle'){var tp=$('test-pane'); if(tp) tp.hidden=!tp.hidden}
  else if(act==='publish-open'){var pd=$('publish-dialog'); if(pd) pd.showModal()}
  else if(act==='publish-cancel'){var pd2=$('publish-dialog'); if(pd2) pd2.close()}
  else if(act==='publish-confirm'){post('/__write/publish',{bot:bot}); var pd3=$('publish-dialog'); if(pd3) pd3.close(); document.body.insertAdjacentHTML('beforeend','<div class="toast" role="status">Your agent was published.</div>')}
  else if(act==='chat-send'){var inp=$('chat-input'); if(inp&&inp.value){ask(bot,inp.value.replace(/</g,''));inp.value=''}}
  else if(act==='kn-open'){openKnowledge()}
  else if(act==='kn-cancel'){closeKnowledge()}
  else if(act==='kn-source'){t.setAttribute('aria-pressed','true')}
  else if(act==='kn-add'){post('/__write/add-knowledge',{bot:bot}); closeKnowledge()}
  else if(act==='c-save'){var ci=$('c-instr'); post('/__write/set-instructions',{bot:bot,instructions:ci?ci.value:''}).then(function(){var cs=$('c-saved'); if(cs) cs.textContent='Saved'; t.disabled=true})}
  else if(act==='create-blank'){post('/__write/create-start',{env:env}).then(function(){location.href=location.origin+'/environments/'+env+'/agents/new'})}
  else if(act==='create-agent'){var nm=$('agent-name'); post('/__write/create-agent',{env:env,name:nm?nm.value:'',kind:t.getAttribute('data-kind')||'',host:location.hostname}).then(function(d){if(d.url)location.href=d.url; else if(d.id)location.href=location.origin+'/environments/'+env+'/bots/'+d.id+'/overview'})}
  else if(act==='open-agent'){location.href=t.getAttribute('data-url')}
  else if(act==='create-menu-open'){var cm=$('create-menu'); if(cm) cm.hidden=!cm.hidden; post('/__experience/create-menu',{})}
  else if(act==='create-pick'){var kind=t.getAttribute('data-kind'); post('/__experience/create-pick',{kind:kind}).then(function(){ if(kind==='customer') return; location.href=location.origin+'/environments/'+env+'/agents/new?kind='+kind })}
  else if(act==='tab-genai'){document.querySelectorAll('[role=tab]').forEach(function(x){x.setAttribute('aria-selected',String(x.id==='tab-genai'))});$('panel').innerHTML='<h2>Orchestration</h2><p>Use generative AI orchestration for your agent&#39;s responses?</p><label><input type="radio" name="o" checked> Yes</label> <label><input type="radio" name="o"> No</label>'}
  else if(act==='item'){var ip=$('item-panel'); if(ip){ip.hidden=false;$('item-title').textContent=t.getAttribute('data-title')||'Details'}}
  else if(act==='item-close'){var ip2=$('item-panel'); if(ip2) ip2.hidden=true}
  else if(act==='cookie-accept'){var c=$('cookie'); if(c) c.remove(); document.cookie='cookies_ok=1; path=/'; post('/__cookie',{})}
  else if(act==='unsaved-leave'){window.__dirty=false; location.href=window.__leaveTo||location.href}
  else if(act==='unsaved-keep'){var u2=$('unsaved'); if(u2) u2.close()}
  else if(act==='danger'){post('/__danger/'+(t.getAttribute('data-what')||'unknown'),{})}
  else if(act==='builder-open'){post('/__builder',{}); var bm=$('main'); if(bm) bm.innerHTML=window.__builderHtml}
  else if(act==='builder-tab'){var which=t.getAttribute('data-tab'); document.querySelectorAll('[data-act=builder-tab]').forEach(function(x){x.setAttribute('aria-selected',String(x===t))}); $('builder-panel').innerHTML=window.__builderPanels[which]}
  else if(act==='builder-create'){post('/__write/create-builder-agent',{})}
  else if(act==='x-menu-open'){var xm=$('x-menu'); if(xm) xm.hidden=!xm.hidden; post('/__experience/menu',{})}
  else if(act==='x-classic'){
    var xm2=$('x-menu'); if(xm2) xm2.hidden=true;
    var openClassic=function(){
      var target='https://'+CFG.previewHost+'/environments/'+(env||CFG.defaultEnv)+'/home';
      if(CFG.classicOpens==='new-tab'){post('/__experience/popup',{}); window.open(target,'_blank')}
      else if(CFG.classicOpens==='same-tab'){location.href=target}
    };
    post('/__experience/classic',{}).then(function(){
      var fb=CFG.feedback;
      if(fb==='skip'||fb==='submit-only'){window.__openClassic=openClassic; document.body.insertAdjacentHTML('beforeend','<div id="x-feedback" role="dialog" aria-label="Feedback" style="position:fixed;left:30%;top:30%;background:#fff;border:1px solid #475569;padding:16px;z-index:50"><h2>Tell us why you switched</h2><p>Your feedback helps us improve the new experience.</p>'+(fb==='skip'?'<button type="button" data-act="x-fb-skip">Skip feedback</button> ':'')+'<button type="button" data-act="x-fb-submit">Submit</button></div>')}
      else openClassic();
    });
  }
  else if(act==='x-fb-skip'){var fbd=$('x-feedback'); if(fbd) fbd.remove(); post('/__experience/feedback',{action:'skip'}).then(function(){ if(window.__openClassic) window.__openClassic() })}
  else if(act==='x-fb-submit'){post('/__experience/feedback',{action:'submit'})}
  else if(act==='r-edit-instr'){
    // The card shows the editor in place of the button; the text box is NOT focused (what the real page does on open was not observed).
    var ed=$('instr-editor'); var box=$('instr-box'); if(!ed||!box) return;
    window.__savedInstr=window.__savedInstr==null?(($('instr-text')||{}).getAttribute('data-saved')||''):window.__savedInstr;
    box.innerText=window.__savedInstr; ed.hidden=false; t.hidden=true; var ip3=$('instr-text'); if(ip3) ip3.hidden=true; var sv=$('instr-save'); if(sv) sv.disabled=true;
  }
  else if(act==='r-instr-save'){
    var cur=instrText();
    post('/__write/set-instructions',{bot:bot,instructions:cur}).then(function(){window.__savedInstr=cur; var tx=$('instr-text'); if(tx) tx.textContent=cur; var sv2=$('instr-save'); if(sv2) sv2.disabled=true; if(CFG.saveClosesEditor) closeEditor()});
  }
  else if(act==='r-instr-cancel'){ if(instrChanged()){var cf=$('r-confirm'); if(cf) cf.hidden=false} else closeEditor() }
  else if(act==='r-confirm-close'||act==='r-confirm-cancel'){var cf2=$('r-confirm'); if(cf2) cf2.hidden=true}
  else if(act==='r-confirm-discard'){var cf3=$('r-confirm'); if(cf3) cf3.hidden=true; post('/__experience/discard',{}); closeEditor()}
  else if(act==='r-overflow'){var rm=$('r-menu'); if(rm) rm.hidden=!rm.hidden}
  else if(act==='r-go'){location.href=t.getAttribute('data-url')}
  else if(act==='r-combo'){var lb=$('r-listbox'); if(lb){lb.hidden=!lb.hidden; t.setAttribute('aria-expanded',String(!lb.hidden))}}
  else if(act==='tool-open'){var td=$('tool-dialog'); if(td) td.showModal()}
  else if(act==='tool-close'){var td2=$('tool-dialog'); if(td2) td2.close()}
  else if(act==='r-slink'){document.querySelectorAll('[data-act=r-slink]').forEach(function(x){x.removeAttribute('aria-current')}); t.setAttribute('aria-current','page'); var sp=$('r-settings-panel'); if(sp) sp.innerHTML='<h2>'+t.textContent+'</h2><p>Settings for '+t.textContent+'.</p>'}
});
document.addEventListener('keydown',function(e){if(e.key==='Escape'){var xm3=$('x-menu'); if(xm3) xm3.hidden=true; var rm2=$('r-menu'); if(rm2) rm2.hidden=true; var cm3=$('create-menu'); if(cm3) cm3.hidden=true}});
document.addEventListener('input',function(e){var t=e.target; if(t&&t.id==='chat-input'&&t.value){window.__dirty=true} if(t&&t.id==='c-instr'){var cb=$('c-save'); if(cb) cb.disabled=false} if(t&&t.id==='instr-box'&&!CFG.editorIgnoresInput){var sb=$('instr-save'); if(sb) sb.disabled=!instrChanged()}});
if(CFG.leavePrompt){window.addEventListener('beforeunload',function(e){if(window.__dirty){e.preventDefault();e.returnValue=''}})}
})();`;

  /** A page whose main area shows a skeleton for `delay` ms, then the content (or, with `boot`, a bare spinner that is replaced whole). */
  function shell({ title, agent = null, envId = FAKE_ENV_ID, sideNav, content, delay, boot = false, late = "", host = "studio", topHtml = null, extraBody = "", testPane: withTestPane = true, tabsHtml = "" }) {
    const top = topHtml ?? topBar(agent, envId);
    const frame = (inner, busy) => `${top}${tabsHtml}<div class="layout">${sideNav}<main id="main"${busy ? ' aria-busy="true"' : ""}>${inner}</main></div>${agent && withTestPane ? testPane(agent) : ""}${extraBody}`;
    const skeleton = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
    const initial = boot ? `<div id="boot" role="progressbar" aria-label="Loading" class="spinner"></div>` : frame(skeleton, true);
    const fill = boot ? `document.body.innerHTML=${JSON.stringify(frame(content, false))}` : `var m=document.getElementById('main');m.innerHTML=${JSON.stringify(content)};m.removeAttribute('aria-busy')`;
    const lateJs = late ? `setTimeout(function(){${late}},${Number(config.lateTextMs) || 600});` : "";
    const cookieHtml = config.cookieBanner ? `<script>if(document.cookie.indexOf('cookies_ok=1')<0){document.body.insertAdjacentHTML('beforeend',${JSON.stringify(cookieBanner)})}</script>` : "";
    const data = ` data-bot="${esc(agent?.id || "")}" data-env="${esc(envId)}"`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>${STYLE}</head><body${data}>${initial}<script>window.__fake=${JSON.stringify({ chatDelayMs: config.chatDelayMs, chatStreamMs: config.chatStreamMs, leavePrompt: config.leavePrompt, flakyKnowledge: config.flakyKnowledge, shadowDialog: config.shadowDialog, licenseOnPublish: config.licenseOnPublish, quotaOnSave: config.quotaOnSave, stayOnNew: config.stayOnNew, feedback: config.feedback, harnessMode: config.harnessMode, classicOpens: config.classicOpens, previewHost: FAKE_HOSTS.previewStudio, defaultEnv: FAKE_ENV_ID, editorIgnoresInput: config.editorIgnoresInput, saveClosesEditor: config.saveClosesEditor })}</script><script>${CLIENT}</script><script>setTimeout(function(){${fill};if(window.__layoutTabs)window.__layoutTabs();${lateJs}},${Number(delay) || 0})</script>${cookieHtml}</body></html>`;
  }
  function delayFor(name) {
    return Number.isFinite(config.delays[name]) ? config.delays[name] : config.defaultDelayMs;
  }

  const publishDialog = `<dialog id="publish-dialog" aria-label="Publish this agent"><h2>Publish this agent</h2><p>Publishing makes the latest version available to the channels you turned on.</p><button type="button" data-act="publish-confirm">Publish</button> <button type="button" data-act="publish-cancel">Cancel</button></dialog>`;
  const unsavedDialog = config.leavePrompt ? `<dialog id="unsaved" aria-label="Unsaved changes"><h2>Unsaved changes</h2><p>Are you sure you want to leave this page? Your message has not been sent.</p><button type="button" data-act="unsaved-keep">Keep editing</button> <button type="button" data-act="unsaved-leave">Leave</button></dialog>` : "";
  const knowledgeButton = lv ? '<button type="button" id="add-knowledge" data-act="kn-open" aria-label="Add knowledge source">+ Add</button>' : '<button type="button" id="add-knowledge" data-act="kn-open">Add knowledge</button>';
  const knowledgeDialog = config.shadowDialog ? '<div id="kn-host"></div>' : `<dialog id="knowledge-dialog" aria-label="Add knowledge"><h2>Add knowledge</h2><button type="button" data-act="kn-source">SharePoint</button> <button type="button" id="add-to-agent" data-act="kn-add">Add to agent</button> <button type="button" data-act="kn-cancel">Cancel</button></dialog>`;
  const itemPanel = `<aside class="details" id="item-panel" hidden aria-label="Details"><h2 id="item-title">Details</h2><p>Name, description, and settings for this item.</p><button type="button" data-act="item-close">Close</button></aside>`;

  const instructionsByBot = new Map();

  /**
   * The Standard agent page as observed on a real tenant (see `realStandard`): the facts of the Standard page (names only) that the recipes were written from.
   * Overview, Knowledge, Tools (the /actions address), Agents, Topics, Activity, Evaluation, Monitor, Channels, and the Settings page at /manage/advancedSettings.
   */
  function realStandardPage({ envId, agent, segs }) {
    const base = agentBase(agent, envId);
    const section = segs[4] || "overview";
    const onSettings = section === "manage" && segs[5] === "advancedSettings";
    const label = (text) => (config.doubledTabText ? `<span>${text}</span><span aria-hidden="true" style="visibility:hidden;height:0;overflow:hidden;position:absolute">${text}</span>` : text);
    const tab = (slug, text, extra = "") => `<a role="tab" ${extra} href="${base}/${slug}" aria-selected="${section === slug}">${label(text)}</a>`;
    const tabs =
      `<div role="tablist" aria-label="Agent sections" style="display:flex;gap:8px;align-items:center">${tab("overview", "Overview")}${tab("knowledge", "Knowledge")}${tab(toolsSegment(), "Tools")}${tab("agents", "Agents")}${tab("topics", "Topics")}` +
      `${tab("activity", "Activity", 'data-wide-tab="1"')}${tab("evaluation", "Evaluation", 'data-wide-tab="1"')}` +
      `<button type="button" role="tab" id="r-overflow" aria-selected="false" aria-haspopup="menu" aria-label="4 more options" data-act="r-overflow">+4</button></div>` +
      `<div role="menu" id="r-menu" aria-label="More tabs" hidden style="position:absolute;right:340px;top:100px;background:#fff;border:1px solid #475569;padding:6px;z-index:30">` +
      `<button type="button" role="menuitem" data-narrow-item="1" data-act="r-go" data-url="${base}/activity">Activity</button>` +
      `<button type="button" role="menuitem" data-narrow-item="1" data-act="r-go" data-url="${base}/evaluation">Evaluation</button>` +
      `<button type="button" role="menuitem" data-act="r-go" data-url="${base}/monitor">Monitor</button>` +
      `<button type="button" role="menuitem" data-act="r-go" data-url="${base}/channels">Channels</button></div>`;
    const top = `<header class="top"><b>Copilot Studio</b><span>${esc(agent.name)}</span><button type="button" data-act="danger" data-what="search-agent">Search your agent</button><button type="button" id="publish" data-act="publish-open">Publish</button><button type="button" data-act="r-go" data-url="${base}/manage/advancedSettings">Settings</button><button type="button" data-act="danger" data-what="options">Options</button><button type="button" id="test-toggle" data-act="test-toggle">Test</button><span style="margin-left:auto">Ada Lovelace ada@contoso.com</span><button type="button" aria-label="Open account menu for Ada Lovelace" data-act="danger" data-what="account-menu">AL</button></header>`;
    // The Test your agent panel is on every tab: a heading, a text box named with the agent's name (it also says "describe"), and its buttons. It is a plain panel (no landmark label).
    const testPanel = `<div class="test" id="test-pane" style="position:fixed;right:0;top:56px;width:300px;height:520px;background:#fff;border-left:1px solid #94a3b8;padding:12px;overflow:auto"><h2>Test your agent</h2><div><button type="button" data-act="danger" data-what="chat-mode">Chat mode</button> <button type="button" data-act="danger" data-what="test-more">More</button> <button type="button" data-act="danger" data-what="expand-test">Expand test pane</button></div><div id="chat" aria-live="polite"></div><textarea id="chat-input" rows="2" aria-label="Ask a question or describe what you need, ${esc(agent.name)}"></textarea><button type="button" data-act="danger" data-what="upload-file">Upload file</button><button type="button" id="chat-send" data-act="chat-send">Send</button></div>`;
    const confirm = `<div id="r-confirm" role="dialog" hidden style="position:fixed;left:30%;top:30%;background:#fff;border:1px solid #475569;padding:16px;z-index:50"><p>You have changes that were not saved. They are lost if you leave now.</p><button type="button" data-act="r-confirm-close">Close</button> <button type="button" data-act="r-confirm-discard">Discard</button> <button type="button" data-act="r-confirm-cancel">Cancel</button></div>`;
    const toolDialog = `<dialog id="tool-dialog" aria-label="Add a tool"><h2>Add a tool</h2><button type="button" data-act="tool-close">Cancel</button></dialog>`;
    const card = (title, body) => `<section class="card"><h2>${title}</h2>${body}</section>`;
    const saved = instructionsByBot.get(agent.id) || "";
    const common = { agent, envId, sideNav: "", topHtml: top, testPane: false };
    const extra = `${testPanel}${publishDialog}${itemPanel}${experienceMenu()}${confirm}${toolDialog}`;
    if (onSettings) {
      const links = ["Generative AI", "Agent details", "Security", "Connected Agents", "Connection Settings", "Authoring Canvas", "Entities", "Skills", "Voice", "Languages", "Language understanding", "Component collections", "Advanced"];
      return shell({
        ...common,
        title: `${agent.name} - Settings`,
        delay: delayFor("settings"),
        content: `<h1>Settings</h1><nav aria-label="Settings sections">${links.map((l, i) => `<a href="#" data-act="r-slink"${i === 0 ? ' aria-current="page"' : ""}>${l}</a>`).join("<br>")}</nav><div id="r-settings-panel"><h2>Generative AI</h2><p>Settings for Generative AI.</p></div><p><button type="button" data-act="r-go" data-url="${base}/overview">Close</button> <button type="button" disabled>Save</button></p>`,
        extraBody: `${experienceMenu()}`,
      });
    }
    const known = ["overview", "knowledge", toolsSegment(), "agents", "topics", "activity", "evaluation", "monitor", "channels"];
    const current = known.includes(section) ? section : "overview";
    const delay = current === "overview" && config.overviewBlankMs ? config.overviewBlankMs : delayFor(current);
    const boot = current === "overview" && config.overviewBlankMs > 0;
    const make = (title, content) => shell({ ...common, title: `${agent.name} - ${title}`, delay, boot, tabsHtml: tabs, content, extraBody: extra });
    if (current === "overview") {
      return make(
        "Overview",
        `<h1>${esc(agent.name)}</h1>` +
          card("Details", `<p>Name: ${esc(agent.name)}</p><p>Description:</p><p>Agent status: Draft</p><button type="button" data-act="danger" data-what="edit-details">Edit Details</button>`) +
          card("Model", `<button type="button" role="combobox" aria-label="Select your agent's model" aria-haspopup="listbox" aria-expanded="false" data-act="r-combo">GPT-4.1</button><div role="listbox" id="r-listbox" aria-label="Models" hidden><div role="option" aria-selected="true">GPT-4.1</div><div role="option" aria-selected="false">GPT-5</div></div>`) +
          card(
            "Instructions",
            `<p id="instr-text" data-saved="${esc(saved)}">${esc(saved) || "Add instructions to tell your agent how to respond."}</p><button type="button" id="r-edit-instr" data-act="r-edit-instr">Edit Instructions</button>` +
              `<div id="instr-editor" hidden><div id="instr-box" contenteditable="true" role="textbox" aria-label="Describe what you want this agent to do, its tone, and rules" style="border:1px solid #475569;min-height:80px;padding:6px"></div>` +
              `<button type="button">Undo</button> <button type="button">Redo</button> <button type="button">Add</button> <button type="button" id="instr-cancel" data-act="r-instr-cancel">Cancel</button> <button type="button" id="instr-save" data-act="r-instr-save" disabled>Save</button></div>`,
          ) +
          card("Knowledge", `<p>${knowledge.has(agent.id) ? "1 source: Policies.docx" : "No knowledge added yet."}</p><button type="button" data-act="kn-open">Add knowledge</button>`) +
          card("Tools", `<button type="button">Add tool</button>`) +
          card("Triggers", `<button type="button">Add trigger</button>`) +
          card("Agents", `<button type="button">Add agent</button>`) +
          card("Topics", `<button type="button">Add topic</button> <button type="button">Use this for topic tools</button> <button type="button">See all</button>`) +
          card("Suggested prompts", `<button type="button">Add suggested prompts</button>`) +
          knowledgeDialog,
      );
    }
    if (current === "knowledge") {
      const items = knowledge.has(agent.id) ? `<ul><li><a href="#" data-act="item" data-title="Policies.docx">Policies.docx</a></li></ul>` : "<p>No knowledge sources yet.</p>";
      return make("Knowledge", `<h1>Knowledge</h1><button type="button" id="add-knowledge" data-act="kn-open">Add knowledge</button> <button type="button">See suggestions</button>${items}${knowledgeDialog}`);
    }
    if (current === toolsSegment()) return make("Tools", `<h1>Tools</h1><button type="button" data-act="tool-open">Add a tool</button><ul><li><a href="#" data-act="item" data-title="Weather lookup">Weather lookup</a></li></ul>`);
    if (current === "agents") return make("Agents", `<h1>Agents</h1><button type="button">Add</button><p>Connected agents appear here.</p>`);
    if (current === "topics") {
      const rows = ["Goodbye", "Greeting", "Start Over", "Thank you"].map((n) => `<tr><td><a href="#" data-act="item" data-title="${n}">${n}</a></td><td>Phrases</td><td>today</td><td>0</td><td>No</td><td><button type="button" aria-label="More options for ${n}" data-act="danger" data-what="topic-options">&#8230;</button></td></tr>`).join("");
      return make(
        "Topics",
        `<h1>Topics</h1><div role="tablist" aria-label="Topic filters"><button type="button" role="tab" aria-selected="true">All</button><button type="button" role="tab" aria-selected="false">Custom (0)</button><button type="button" role="tab" aria-selected="false">System (4)</button></div><p><button type="button">Add a topic</button> <button type="button">Refresh topics</button></p><table><thead><tr><th><button type="button">Name</button></th><th><button type="button">Trigger</button></th><th><button type="button">Last modified</button></th><th><button type="button">Errors</button></th><th><button type="button">Blocked</button></th><th></th></tr></thead><tbody>${rows}</tbody></table>`,
      );
    }
    const titles = { activity: "Activity", evaluation: "Evaluation", monitor: "Monitor", channels: "Channels" };
    return make(titles[current], `<h1>${titles[current]}</h1><p>${titles[current]} page of the pretend Standard agent.</p>`);
  }

  function page(url, envId, agent, navClick = false) {
    const segs = url.pathname.split("/").filter(Boolean);
    // /environments/<env>/<area>[/<id>/<section>]
    const area = segs[2] || "";
    const home = envBase(envId);
    if (area === "home" && config.signedOutHome) {
      // The product's own public page: a Sign in button at the top, no account anywhere, and a pitch instead of the product.
      return shell({
        title: "Microsoft Copilot Studio",
        envId,
        sideNav: "",
        delay: delayFor("home"),
        topHtml: `<header class="top"><b>Copilot Studio</b><span style="margin-left:auto"></span><button type="button" id="public-sign-in">Sign in</button></header>`,
        content: `<h1>Build agents for your business</h1><p>Sign in to start building. New here? Explore what agents can do.</p>`,
      });
    }
    if (area === "home") {
      return shell({
        title: "Home",
        envId,
        sideNav: envNav("home", envId),
        delay: delayFor("home"),
        content:
          `<h1>What would you like to build?</h1><textarea aria-label="Describe your agent" rows="3" cols="50" placeholder="Describe the agent you want"></textarea><br><button type="button">Submit</button>` +
          `<div class="card"><h2>Start building from scratch</h2><p>Choose Agent to begin. Settings and Instructions can be changed later.</p></div>` +
          `<div class="promo"><a href="${home}/apps/new">Knowledge</a> <span>Bring your own data to an app.</span></div>`,
      });
    }
    if (area === "agents" && segs[3] === "new") {
      // The newer layout opens the unsaved agent (Name and Instructions, a Save button); the classic layout asks on a form. In harnessMode the create option decides:
      // "Agent, Standard" opens the classic form (a Create button), "Agent, uses Copilot Credits" the newer one (a Save button).
      const kind = url.searchParams.get("kind") || "";
      const newer = config.harnessMode ? kind !== "standard" : sessionLayout() === "newer";
      return shell({
        title: newer ? "New agent" : "Create an agent",
        envId,
        sideNav: envNav("agents", envId),
        delay: delayFor("agents"),
        content: newer
          ? `<h1>New agent</h1><label>Name <input id="agent-name" aria-label="Name" placeholder="Agent name"></label><label>Instructions <textarea aria-label="Instructions" rows="4" cols="50"></textarea></label><p><button type="button" data-act="n-create-agent" aria-label="Save">Save</button></p>`
          : `<h1>Create an agent</h1><label>Name <input id="agent-name" aria-label="Name" placeholder="Agent name"></label><p><button type="button" data-act="create-agent" data-kind="${esc(kind)}">Create</button></p>`,
        extraBody: newer ? newerExtraBody({ config }) : "",
      });
    }
    if (area === "agents" && segs.length === 3) {
      if (config.harnessMode) {
        // The real Agents list (observed 2026-11-24): a table with Name, Status, Owner, Last modified, and Agent harness; each row has "Open <name>" and
        // "More actions for <name>"; the harness cell's text is "Microsoft Copilot" or "Standard" with a tooltip appended; "More create options" lists three ways to create.
        const tip = (a) => (a.harness === "standard" ? "This agent runs on the standard harness. It doesn't use Copilot Credits for users with a Microsoft 365 Copilot license." : "This agent runs on the Microsoft Copilot harness. Copilot Credits are used as you create and edit it.");
        const cell = (a) => `<td><span>${a.harness === "standard" ? "Standard" : a.harness === "customer-conversation" ? "Customer Conversation" : "Microsoft Copilot"}</span><span role="tooltip" style="position:absolute;left:-9999px">${esc(tip(a))}</span></td>`;
        const list = envs[envId]?.agents || [];
        const table = list.length
          ? `<table><thead><tr><th>Name</th><th>Status</th><th>Owner</th><th>Last modified</th><th>Agent harness</th><th><span style="position:absolute;left:-9999px">Actions</span></th></tr></thead><tbody>${list.map((a) => `<tr><td>${esc(a.name)}</td><td>Published</td><td>Ada Lovelace</td><td>today</td>${cell(a)}<td><button type="button" aria-label="Open ${esc(a.name)}" data-act="open-agent" data-url="${esc(agentHome(a, envId))}">Open</button> <button type="button" aria-label="More actions for ${esc(a.name)}" data-act="danger" data-what="row-actions">&#8230;</button></td></tr>`).join("")}</tbody></table>`
          : "<p>No agents yet.</p>";
        const create = config.createMenu !== false
          ? createMenuHtml()
          : `<p><button type="button" id="new-agent" data-act="n-new-agent">New agent</button></p>`;
        return shell({ title: "Agents", envId, sideNav: envNav("agents", envId), delay: delayFor("agents"), content: `<h1>Agents</h1>${table}${create}`, extraBody: newerExtraBody({ config }) });
      }
      const newerList = sessionLayout() === "newer";
      const deleteButton = `<button type="button" data-act="danger" data-what="delete-listed-agent">Delete</button>`;
      const rows = (envs[envId]?.agents || []).map((a) => `<div><a href="${agentBase(a, envId)}/overview"><b>${esc(a.name)}</b></a> Last edited today ${deleteButton}</div>`).join("");
      const create = (newerList ? `<p><input type="search" aria-label="Search agents by name" placeholder="Search agents by name">${config.createDisabled ? "" : ` <button type="button" id="new-agent" data-act="n-new-agent">New agent</button>`}</p>` : `<p><button type="button" id="create-blank" data-act="create-blank">Create blank agent</button></p>`) + (config.createMenu !== false ? createMenuHtml() : "");
      return shell({
        title: "Agents",
        envId,
        sideNav: envNav("agents", envId),
        delay: delayFor("agents"),
        content: `<h1>Agents</h1>${rows || "<p>No agents yet.</p>"}${create}`,
        extraBody: newerList ? newerExtraBody({ config }) : "",
      });
    }
    if (area === "apps") {
      stats.appsNewVisits += 1;
      return shell({ title: "Create an app", envId, sideNav: envNav("apps", envId), delay: delayFor("apps"), content: `<h1>Create an app</h1><p>Pick a template to start a new app.</p>` });
    }
    if (area === "admin") {
      stats.adminVisits += 1;
      return shell({
        title: "Admin settings",
        envId,
        sideNav: envNav("admin", envId),
        delay: delayFor("admin"),
        content: `<h1>Admin settings</h1><label><input type="checkbox" data-act="danger" data-what="admin-toggle"> Allow external sharing</label><p><button type="button" data-act="danger" data-what="admin-save">Save</button></p>`,
      });
    }
    if ((area === "bots" || (config.harnessMode && area === "agents" && segs[3])) && agent) {
      // The newer layout: whatever the address says (/knowledge, /analytics...), the page opens on its Build tab and the tab strip decides what is shown.
      if (config.realStandard && config.harnessMode && agentLayout(agent) === "tabstrip") return realStandardPage({ envId, agent, segs });
      if (agentLayout(agent) === "newer") {
        return shell({ title: `${agent.name} - Build`, agent, envId, sideNav: "", delay: delayFor("overview"), content: newerContent({ agent, envId, state: newer, config: { ...config, deployTab: agent.harness === "customer-conversation" } }), topHtml: newerTop(agent), extraBody: newerExtraBody({ config }), testPane: false });
      }
      let section = segs[4] || "overview";
      const harnessSections = config.harnessMode ? ["agents", "activity", "evaluation"] : [];
      const known = ["overview", "knowledge", toolsSegment(), "topics", "analytics", "settings", ...harnessSections];
      if (!known.includes(section)) section = "overview";
      // Some tenants do not honor a typed address for a section: only the side navigation reaches it.
      if (!config.directSections && section !== "overview" && !navClick) {
        return `<!doctype html><title>Redirecting</title><script>location.replace(${JSON.stringify(`${agentBase(agent, envId)}/overview`)})</script>`;
      }
      const delay = section === "overview" && config.overviewBlankMs ? config.overviewBlankMs : delayFor(section);
      const boot = section === "overview" && config.overviewBlankMs > 0;
      // A Standard agent (harnessMode) has a TAB STRIP across the top instead of a side navigation, and the same "More options" menu in the lower left corner.
      const tabsHtml = config.harnessMode ? standardTabs(agent, section, envId) : "";
      const sideNav = config.harnessMode ? "" : nav(agent, section, envId);
      const extraBody = `${publishDialog}${unsavedDialog}${itemPanel}${config.harnessMode ? experienceMenu() : ""}`;
      const common = { agent, envId, sideNav, delay, extraBody, tabsHtml };
      if (section === "overview") {
        return shell({
          ...common,
          title: `${agent.name} - Overview`,
          boot,
          late: config.lateTextMs ? `document.getElementById('instr-text').textContent='You are an energy resources assistant. Answer only from approved documents.';document.getElementById('instr').textContent='Instructions (saved)'` : "",
          content: `<h1>${esc(agent.name)}</h1><section class="card" aria-labelledby="instr"><h2 id="instr">Instructions</h2>${config.editableInstructions ? `<textarea id="c-instr" aria-label="Instructions" rows="4" cols="50">You are an energy resources assistant. Answer only from approved documents.</textarea><p><button type="button" id="c-save" data-act="c-save" aria-label="Save" disabled>Save</button> <span id="c-saved" role="status" aria-live="polite"></span></p>` : `<p id="instr-text">${config.lateTextMs ? "Loading..." : "You are an energy resources assistant. Answer only from approved documents."}</p>`}</section><section class="card"><h2>Knowledge</h2><p>${knowledge.has(agent.id) ? "1 source: Policies.docx" : "No knowledge added yet."}</p></section>`,
        });
      }
      if (section === "knowledge") {
        const items = knowledge.has(agent.id) ? `<ul><li><a href="#" data-act="item" data-title="Policies.docx">Policies.docx</a></li></ul>` : "<p>No knowledge sources yet.</p>";
        return shell({ ...common, title: `${agent.name} - Knowledge`, content: `<h1>Knowledge</h1>${knowledgeButton}${items}${knowledgeDialog}` });
      }
      if (section === toolsSegment()) {
        return shell({ ...common, title: `${agent.name} - Tools`, content: `<h1>Tools</h1><button type="button">Add a tool</button><ul><li><a href="#" data-act="item" data-title="Weather lookup">Weather lookup</a></li><li><a href="#" data-act="item" data-title="Order status">Order status</a></li></ul>` });
      }
      if (section === "topics") return shell({ ...common, title: `${agent.name} - Topics`, content: `<h1>Topics</h1><p>System topics and custom topics.</p>` });
      if (section === "agents") return shell({ ...common, title: `${agent.name} - Agents`, content: `<h1>Agents</h1><p>Connected agents appear here.</p>` });
      if (section === "activity") return shell({ ...common, title: `${agent.name} - Activity`, content: `<h1>Activity</h1><p>Recent conversations and runs.</p>` });
      if (section === "evaluation") return shell({ ...common, title: `${agent.name} - Evaluation`, content: `<h1>Evaluation</h1><p>Test sets and results.</p>` });
      if (section === "analytics") return shell({ ...common, title: `${agent.name} - Analytics`, content: `<h1>Analytics</h1><p>Sessions, satisfaction, and themes.</p>` });
      // settings: the General tab is open; Generative AI is a tab
      return shell({
        ...common,
        title: `${agent.name} - Settings`,
        content:
          `<h1>Settings</h1><div role="tablist" aria-label="Settings sections"><button role="tab" aria-selected="true" id="tab-general">General</button><button role="tab" aria-selected="false" id="tab-genai" data-act="tab-genai">Generative AI</button><button role="tab" aria-selected="false" id="tab-security">Security</button></div>` +
          `<div id="panel">General settings: name, language, and icon.</div><p><a href="${home}/admin">Admin</a> <button type="button" data-act="danger" data-what="delete-agent">Delete agent</button></p>`,
      });
    }
    return shell({ title: "Not found", envId, sideNav: envNav("", envId), delay: 50, content: `<h1>That page was not found</h1>` });
  }

  function sharepointPage() {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Training - Home</title>${STYLE}</head><body><header class="top"><b>SharePoint</b></header><div class="layout"><nav class="side" aria-label="Site navigation"><a href="/sites/training">Home</a><a href="/sites/training/Shared%20Documents">Documents</a><a href="/sites/training/SitePages">Pages</a><a href="/sites/training/_layouts/15/viewlsts.aspx">Site contents</a></nav><main><h1>Training</h1><p>Welcome to the training site.</p></main></div></body></html>`;
  }

  // Microsoft 365 Copilot: the Agents page lists agents; Create agent opens Agent Builder inside the page, which has no address of its own.
  function m365Page(url) {
    const nav = (current) => `<nav class="side" aria-label="Copilot navigation"><a href="/chat"${current === "chat" ? ' aria-current="page"' : ""}>Chat</a><a href="/agents"${current === "agents" ? ' aria-current="page"' : ""}>Agents</a><a href="/create">Create</a></nav>`;
    const builder = `<section aria-label="Agent builder"><h1>New agent</h1><div role="tablist" aria-label="Agent builder tabs"><button role="tab" aria-selected="true" data-act="builder-tab" data-tab="describe">Describe</button><button role="tab" aria-selected="false" data-act="builder-tab" data-tab="configure">Configure</button></div><div id="builder-panel"><p>Tell Copilot what your agent should do.</p><textarea aria-label="Describe your agent" rows="4" cols="50" placeholder="Describe your agent"></textarea></div><p><button type="button" data-act="builder-create">Create</button></p></section>`;
    const panels = {
      describe: `<p>Tell Copilot what your agent should do.</p><textarea aria-label="Describe your agent" rows="4" cols="50" placeholder="Describe your agent"></textarea>`,
      configure: `<label>Name <input aria-label="Name" placeholder="Name"></label><h2>Instructions</h2><textarea aria-label="Instructions" rows="4" cols="50" placeholder="What should the agent do?"></textarea><h2>Knowledge</h2><button type="button" data-act="kn-open" id="add-knowledge">Add knowledge</button><dialog id="knowledge-dialog" aria-label="Add knowledge"><h2>Add knowledge</h2><button type="button" data-act="kn-source">Websites</button> <button type="button" data-act="kn-source">SharePoint</button> <button type="button" data-act="kn-add">Add</button> <button type="button" data-act="kn-cancel">Cancel</button></dialog>`,
    };
    const script = `<script>window.__builderHtml=${JSON.stringify(builder)};window.__builderPanels=${JSON.stringify(panels)};</script>`;
    const segs = url.pathname.split("/").filter(Boolean);
    const area = segs[0] || "chat";
    const top = `<header class="top"><b>Microsoft 365 Copilot</b><span style="margin-left:auto">Ada Lovelace ada@contoso.com</span><button type="button" data-act="danger" data-what="sign-out">Sign out</button></header>`;
    const wrap = (current, title, content) =>
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>${STYLE}</head><body data-bot="" data-env="">${top}<div class="layout">${nav(current)}<main id="main">${content}</main></div>${script}<script>window.__fake=${JSON.stringify({ chatDelayMs: config.chatDelayMs, flakyKnowledge: config.flakyKnowledge, shadowDialog: false })}</script><script>${CLIENT}</script></body></html>`;
    if (area === "chat") return wrap("chat", "Microsoft 365 Copilot", `<h1>Chat</h1><textarea aria-label="Ask Copilot" rows="2" cols="60" placeholder="Ask Copilot"></textarea>`);
    if (area === "agents") return wrap("agents", "Agents", `<h1>Agents</h1><div class="card"><b>Researcher</b></div><div class="card"><b>Writing coach</b></div><p><button type="button" data-act="builder-open" id="create-agent">Create agent</button></p>`);
    stats.directBuilderVisits += 1;
    return wrap("", "Not found", `<h1>That page was not found</h1>`);
  }

  function genericPage(host, title) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>${STYLE}</head><body><header class="top"><b>${esc(title)}</b></header><div class="layout"><main><h1>${esc(title)}</h1><p>${esc(host)}</p><div class="card">Create agent</div><div class="card">Agents</div></main></div></body></html>`;
  }

  const frameDoc = (botId) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Test chat</title>${STYLE}</head><body data-bot="${esc(botId)}" data-env=""><aside aria-label="Test your agent">${chatBody}</aside><script>window.__fake=${JSON.stringify({ chatDelayMs: config.chatDelayMs, chatStreamMs: config.chatStreamMs })}</script><script>${CLIENT}</script></body></html>`;

  async function handle(context, route) {
    const request = route.request();
    const url = new URL(request.url());
    const html = (body, status = 200, headers = {}) => route.fulfill({ status, contentType: "text/html; charset=utf-8", headers: { "cache-control": "no-store", ...headers }, body });
    const json = (value, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(value) });
    const body = () => {
      try {
        return JSON.parse(request.postData() || "{}");
      } catch {
        return {};
      }
    };
    if (url.pathname === "/favicon.ico") return route.fulfill({ status: 204, body: "" });
    if (url.pathname === "/__nav") {
      navClickPending = true;
      return route.fulfill({ status: 204, body: "" });
    }
    if (url.pathname === "/__cookie") {
      stats.cookieAccepts += 1;
      return json({});
    }
    if (url.pathname === "/__experience/menu") {
      stats.menuOpens += 1;
      return json({});
    }
    if (url.pathname === "/__experience/classic") {
      stats.classicClicks += 1;
      return json({});
    }
    if (url.pathname === "/__experience/popup") {
      stats.popups += 1;
      return json({});
    }
    if (url.pathname === "/__experience/create-menu") {
      stats.createMenuOpens += 1;
      return json({});
    }
    if (url.pathname === "/__experience/create-pick") {
      stats.createPicks.push(String(body().kind || ""));
      // The older fake counted the start of creating on the classic form as a write; picking an option that opens that form is that start.
      if (!config.harnessMode && body().kind !== "customer" && sessionLayout() !== "newer") stats.writes.push("create-start");
      return json({});
    }
    if (url.pathname === "/__experience/feedback") {
      if (body().action === "submit") stats.feedbackSubmits += 1;
      else stats.feedbackSkips += 1;
      return json({});
    }
    if (url.pathname === "/__experience/discard") {
      stats.discards = (stats.discards || 0) + 1;
      return json({});
    }
    if (url.pathname === "/__builder") {
      stats.builderOpens += 1;
      return json({});
    }
    if (url.pathname === "/__ask") {
      stats.answers += 1;
      newer.sessions.set(body().bot, (newer.sessions.get(body().bot) || 0) + 1);
      return json({ cited: knowledge.has(body().bot) || (newer.knowledge.get(body().bot) || []).length > 0 });
    }
    if (url.pathname.startsWith("/__view/")) {
      stats.views.push(url.pathname.replace("/__view/", ""));
      return json({});
    }
    if (url.pathname.startsWith("/__danger/")) {
      stats.dangers.push(url.pathname.replace("/__danger/", ""));
      return json({});
    }
    if (url.pathname.startsWith("/__write/")) {
      const what = url.pathname.replace("/__write/", "");
      const data = body();
      const handled = handleNewerWrite(what, data, { state: newer, stats, findKnown: (botId) => Object.values(envs).flatMap((e) => e.agents).find((a) => a.id === botId) || null });
      if (handled) return json(handled);
      if (what === "create-agent") {
        const envId = envs[data.env] ? data.env : FAKE_ENV_ID;
        // In harnessMode the create option decides the harness: "Agent, Standard" makes a Standard agent, anything else a Microsoft Copilot one.
        const harness = data.kind === "standard" ? "standard" : "microsoft-copilot";
        const agent = { id: newBotId(), name: String(data.name || "Untitled agent").slice(0, 80), ...(config.harnessMode ? { harness } : {}) };
        envs[envId].agents.push(agent);
        stats.writes.push(`create-agent:${agent.name}`);
        // Where the new agent opens: a Standard agent on the preview host (its own address shape), a Microsoft Copilot agent on the host the person is on.
        if (config.harnessMode) {
          const host = harness === "standard" || data.host === FAKE_HOSTS.previewStudio ? FAKE_HOSTS.previewStudio : FAKE_HOSTS.studio;
          return json({ id: agent.id, url: harness === "standard" ? `https://${FAKE_HOSTS.previewStudio}/environments/${envId}/bots/${agent.id}/overview` : `https://${host}/environments/${envId}/agents/${agent.id}` });
        }
        return json({ id: agent.id });
      }
      if (what === "add-knowledge") knowledge.add(data.bot);
      if (what === "publish") published.add(data.bot);
      if (what === "set-instructions") {
        stats.instructions.push(String(data.instructions || ""));
        instructionsByBot.set(data.bot, String(data.instructions || ""));
      }
      stats.writes.push(["add-knowledge", "publish", "set-instructions"].includes(what) ? `${what}:${data.bot}` : what);
      return json({});
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
    if (url.hostname === FAKE_HOSTS.m365) return html(m365Page(url));
    if (url.hostname !== FAKE_HOSTS.studio && url.hostname !== FAKE_HOSTS.previewStudio) return html(genericPage(url.hostname, url.hostname));
    // The pages link to their own host: the two experiences are on two hosts.
    reqHost = url.hostname;
    // The preview address does not work at all (the classic experience is not reachable): it sends every page to the default host.
    if (config.previewUnavailable && url.hostname === FAKE_HOSTS.previewStudio) {
      return html(`<!doctype html><title>Redirecting</title><script>location.replace(${JSON.stringify(`https://${FAKE_HOSTS.studio}${url.pathname}`)})</script>`);
    }

    if (url.pathname === "/__frame/test") return html(frameDoc(url.searchParams.get("bot") || ""));
    if (url.pathname === "/" || url.pathname === "") {
      stats.rootVisits += 1;
      if (config.abortFirstNavigation && !abortedOnce && request.isNavigationRequest()) {
        abortedOnce = true;
        stats.aborted += 1;
        return route.abort("aborted");
      }
      return html(`<!doctype html><title>Copilot Studio</title><div class="spinner" role="progressbar" aria-label="Loading"></div><script>setTimeout(function(){location.replace(${JSON.stringify(`${envBase(FAKE_ENV_ID)}/home`)})},120)</script>`);
    }
    const segs = url.pathname.split("/").filter(Boolean);
    if (segs[0] === "environments" && envs[segs[1]]) {
      const envId = segs[1];
      const isAgentRoute = segs[2] === "bots" || (config.harnessMode && segs[2] === "agents" && segs[3] && segs[3] !== "new");
      const botId = isAgentRoute ? segs[3] : null;
      const agent = findAgent(envId, botId);
      if (isAgentRoute && !agent) return html(page(new URL(`${envBase(envId)}/home`), envId, null), 404);
      // A Standard agent opened on the default host redirects, in the same tab, to the preview host (observed on a real tenant).
      if (config.harnessMode && agent?.harness === "standard" && url.hostname !== FAKE_HOSTS.previewStudio) {
        stats.redirects += 1;
        return html(`<!doctype html><title>Redirecting</title><script>location.replace(${JSON.stringify(`https://${FAKE_HOSTS.previewStudio}/environments/${envId}/bots/${agent.id}/${segs[4] || "overview"}`)})</script>`);
      }
      const clicked = navClickPending && request.isNavigationRequest();
      if (request.isNavigationRequest()) navClickPending = false;
      return html(page(url, envId, agent, clicked));
    }
    return html(page(new URL(`${base}/home`), FAKE_ENV_ID, null), 404);
  }

  return {
    config,
    stats,
    base,
    practiceBase: envBase(FAKE_PRACTICE_ENV_ID),
    envs,
    knowledge,
    published,
    /** What was done to agents in the newer layout: instructions, knowledge sites, memory, evaluations, sessions. */
    newer,
    /** The browser session ends: the product forgets nothing (the experience is the host a page is on), so there is nothing to reset. */
    endSession() {},
    agentUrl: (section = "overview") => `${agentBase()}/${section}`,
    /** The practice agents in the pretend practice environment (the ones a companion created). */
    practiceAgents: () => envs[FAKE_PRACTICE_ENV_ID].agents,
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
        // A browser the companion started itself and connected to (see attach.mjs) gets the same pretend site.
        if (prop === "connectOverCDP") {
          return async (...args) => {
            const browser = await target.connectOverCDP(...args);
            const context = browser.contexts()[0];
            launches.push({ via: "attach", type: name });
            contexts.push(context);
            await site.attach(context);
            if (onContext) onContext(context);
            return browser;
          };
        }
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
