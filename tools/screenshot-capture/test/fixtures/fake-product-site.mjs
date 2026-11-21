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
    ...options,
  };
  const stats = { pages: [], writes: [], dangers: [], views: [], blocked: [], aborted: 0, loginPages: 0, promoVisits: 0, appsNewVisits: 0, adminVisits: 0, answers: 0, cookieAccepts: 0, builderOpens: 0, directBuilderVisits: 0 };
  let abortedOnce = false;
  let navClickPending = false;
  let nextId = 0;

  // The pretend tenant: two environments, the agents in them, and what has been done to those agents.
  const envs = { [FAKE_ENV_ID]: { agents: [FAKE_AGENT, OTHER_AGENT] }, [FAKE_PRACTICE_ENV_ID]: { agents: [] } };
  const knowledge = new Set();
  const published = new Set();
  const newer = newerState(published);
  const newBotId = () => `7a1c${(++nextId).toString(16).padStart(4, "0")}-5b3d-4e6f-8a9b-c0d1e2f3a4b5`;

  const envBase = (envId) => `https://${FAKE_HOSTS.studio}/environments/${envId}`;
  const base = envBase(FAKE_ENV_ID);
  const agentBase = (agent = FAKE_AGENT, envId = FAKE_ENV_ID) => `${envBase(envId)}/bots/${agent.id}`;
  const toolsSegment = () => config.toolsSlug;
  const findAgent = (envId, botId) => (envs[envId]?.agents || []).find((a) => a.id === botId) || null;

  const nav = (agent, current, envId) => {
    const item = (segment, label) => `<a href="${agentBase(agent, envId)}/${segment}"${current === segment ? ' aria-current="page"' : ""}>${label}</a>`;
    return `<nav class="side" aria-label="Agent navigation">${item("overview", "Overview")}${item("knowledge", "Knowledge")}${item(toolsSegment(), "Tools")}${item("topics", "Topics")}${item("analytics", "Analytics")}${item("settings", "Settings")}</nav>`;
  };

  const envNav = (current, envId) =>
    `<nav class="side" aria-label="Environment navigation"><a href="${envBase(envId)}/home"${current === "home" ? ' aria-current="page"' : ""}>Home</a><a href="${envBase(envId)}/agents"${current === "agents" ? ' aria-current="page"' : ""}>Agents</a><a href="${envBase(envId)}/apps/new">Apps</a></nav>`;

  const lv = config.labelVariants;
  const topBar = (agent, envId) =>
    `<header class="top"><b>Copilot Studio</b>${
      agent
        ? `<span>${esc(agent.name)}</span><button type="button" id="test-toggle" data-act="test-toggle"${lv ? ' aria-label="Test your agent"' : ""}>${esc(config.testButtonName || (lv ? "\u25B6" : "Test"))}</button><button type="button" id="publish" data-act="publish-open">Publish</button><button type="button" data-act="danger" data-what="share">Share</button>`
        : ""
    }<span style="margin-left:auto">Ada Lovelace ada@contoso.com</span><button type="button" data-act="danger" data-what="sign-out">Sign out</button></header>`;

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
  else if(act==='create-agent'){var nm=$('agent-name'); post('/__write/create-agent',{env:env,name:nm?nm.value:''}).then(function(d){if(d.id)location.href=location.origin+'/environments/'+env+'/bots/'+d.id+'/overview'})}
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
});
document.addEventListener('input',function(e){var t=e.target; if(t&&t.id==='chat-input'&&t.value){window.__dirty=true} if(t&&t.id==='c-instr'){var cb=$('c-save'); if(cb) cb.disabled=false}});
if(CFG.leavePrompt){window.addEventListener('beforeunload',function(e){if(window.__dirty){e.preventDefault();e.returnValue=''}})}
})();`;

  /** A page whose main area shows a skeleton for `delay` ms, then the content (or, with `boot`, a bare spinner that is replaced whole). */
  function shell({ title, agent = null, envId = FAKE_ENV_ID, sideNav, content, delay, boot = false, late = "", host = "studio", topHtml = null, extraBody = "", testPane: withTestPane = true }) {
    const top = topHtml ?? topBar(agent, envId);
    const frame = (inner, busy) => `${top}<div class="layout">${sideNav}<main id="main"${busy ? ' aria-busy="true"' : ""}>${inner}</main></div>${agent && withTestPane ? testPane(agent) : ""}${extraBody}`;
    const skeleton = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
    const initial = boot ? `<div id="boot" role="progressbar" aria-label="Loading" class="spinner"></div>` : frame(skeleton, true);
    const fill = boot ? `document.body.innerHTML=${JSON.stringify(frame(content, false))}` : `var m=document.getElementById('main');m.innerHTML=${JSON.stringify(content)};m.removeAttribute('aria-busy')`;
    const lateJs = late ? `setTimeout(function(){${late}},${Number(config.lateTextMs) || 600});` : "";
    const cookieHtml = config.cookieBanner ? `<script>if(document.cookie.indexOf('cookies_ok=1')<0){document.body.insertAdjacentHTML('beforeend',${JSON.stringify(cookieBanner)})}</script>` : "";
    const data = ` data-bot="${esc(agent?.id || "")}" data-env="${esc(envId)}"`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>${STYLE}</head><body${data}>${initial}<script>window.__fake=${JSON.stringify({ chatDelayMs: config.chatDelayMs, chatStreamMs: config.chatStreamMs, leavePrompt: config.leavePrompt, flakyKnowledge: config.flakyKnowledge, shadowDialog: config.shadowDialog, licenseOnPublish: config.licenseOnPublish, quotaOnSave: config.quotaOnSave, stayOnNew: config.stayOnNew })}</script><script>${CLIENT}</script><script>setTimeout(function(){${fill};${lateJs}},${Number(delay) || 0})</script>${cookieHtml}</body></html>`;
  }
  function delayFor(name) {
    return Number.isFinite(config.delays[name]) ? config.delays[name] : config.defaultDelayMs;
  }

  const publishDialog = `<dialog id="publish-dialog" aria-label="Publish this agent"><h2>Publish this agent</h2><p>Publishing makes the latest version available to the channels you turned on.</p><button type="button" data-act="publish-confirm">Publish</button> <button type="button" data-act="publish-cancel">Cancel</button></dialog>`;
  const unsavedDialog = config.leavePrompt ? `<dialog id="unsaved" aria-label="Unsaved changes"><h2>Unsaved changes</h2><p>Are you sure you want to leave this page? Your message has not been sent.</p><button type="button" data-act="unsaved-keep">Keep editing</button> <button type="button" data-act="unsaved-leave">Leave</button></dialog>` : "";
  const knowledgeButton = lv ? '<button type="button" id="add-knowledge" data-act="kn-open" aria-label="Add knowledge source">+ Add</button>' : '<button type="button" id="add-knowledge" data-act="kn-open">Add knowledge</button>';
  const knowledgeDialog = config.shadowDialog ? '<div id="kn-host"></div>' : `<dialog id="knowledge-dialog" aria-label="Add knowledge"><h2>Add knowledge</h2><button type="button" data-act="kn-source">SharePoint</button> <button type="button" id="add-to-agent" data-act="kn-add">Add to agent</button> <button type="button" data-act="kn-cancel">Cancel</button></dialog>`;
  const itemPanel = `<aside class="details" id="item-panel" hidden aria-label="Details"><h2 id="item-title">Details</h2><p>Name, description, and settings for this item.</p><button type="button" data-act="item-close">Close</button></aside>`;

  function page(url, envId, agent, navClick = false) {
    const segs = url.pathname.split("/").filter(Boolean);
    // /environments/<env>/<area>[/<id>/<section>]
    const area = segs[2] || "";
    const home = envBase(envId);
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
      // The newer layout opens the unsaved agent (Name and Instructions, a Save button); the classic layout asks on a form.
      const newer = config.layout === "newer";
      return shell({
        title: newer ? "New agent" : "Create an agent",
        envId,
        sideNav: envNav("agents", envId),
        delay: delayFor("agents"),
        content: newer
          ? `<h1>New agent</h1><label>Name <input id="agent-name" aria-label="Name" placeholder="Agent name"></label><label>Instructions <textarea aria-label="Instructions" rows="4" cols="50"></textarea></label><p><button type="button" data-act="n-create-agent" aria-label="Save">Save</button></p>`
          : `<h1>Create an agent</h1><label>Name <input id="agent-name" aria-label="Name" placeholder="Agent name"></label><p><button type="button" data-act="create-agent">Create</button></p>`,
        extraBody: newer ? newerExtraBody({ config }) : "",
      });
    }
    if (area === "agents" && segs.length === 3) {
      const rows = (envs[envId]?.agents || []).map((a) => `<div><a href="${agentBase(a, envId)}/overview"><b>${esc(a.name)}</b></a> Last edited today <button type="button" data-act="danger" data-what="delete-listed-agent">Delete</button></div>`).join("");
      const create = config.layout === "newer" ? `<p><input type="search" aria-label="Search agents by name" placeholder="Search agents by name">${config.createDisabled ? "" : ` <button type="button" id="new-agent" data-act="n-new-agent">New agent</button>`}</p>` : `<p><button type="button" id="create-blank" data-act="create-blank">Create blank agent</button></p>`;
      return shell({
        title: "Agents",
        envId,
        sideNav: envNav("agents", envId),
        delay: delayFor("agents"),
        content: `<h1>Agents</h1>${rows || "<p>No agents yet.</p>"}${create}`,
        extraBody: config.layout === "newer" ? newerExtraBody({ config }) : "",
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
    if (area === "bots" && agent) {
      // The newer layout: whatever the address says (/knowledge, /analytics...), the page opens on its Build tab and the tab strip decides what is shown.
      if (config.layout === "newer") {
        return shell({ title: `${agent.name} - Build`, agent, envId, sideNav: "", delay: delayFor("overview"), content: newerContent({ agent, envId, state: newer, config }), topHtml: newerTop(agent), extraBody: newerExtraBody({ config }), testPane: false });
      }
      let section = segs[4] || "overview";
      const known = ["overview", "knowledge", toolsSegment(), "topics", "analytics", "settings"];
      if (!known.includes(section)) section = "overview";
      // Some tenants do not honor a typed address for a section: only the side navigation reaches it.
      if (!config.directSections && section !== "overview" && !navClick) {
        return `<!doctype html><title>Redirecting</title><script>location.replace(${JSON.stringify(`${agentBase(agent, envId)}/overview`)})</script>`;
      }
      const delay = section === "overview" && config.overviewBlankMs ? config.overviewBlankMs : delayFor(section);
      const boot = section === "overview" && config.overviewBlankMs > 0;
      const sideNav = nav(agent, section, envId);
      const extraBody = `${publishDialog}${unsavedDialog}${itemPanel}`;
      const common = { agent, envId, sideNav, delay, extraBody };
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
        const agent = { id: newBotId(), name: String(data.name || "Untitled agent").slice(0, 80) };
        envs[envId].agents.push(agent);
        stats.writes.push(`create-agent:${agent.name}`);
        return json({ id: agent.id });
      }
      if (what === "add-knowledge") knowledge.add(data.bot);
      if (what === "publish") published.add(data.bot);
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
    if (url.hostname !== FAKE_HOSTS.studio) return html(genericPage(url.hostname, url.hostname));

    if (url.pathname === "/__frame/test") return html(frameDoc(url.searchParams.get("bot") || ""));
    if (url.pathname === "/" || url.pathname === "") {
      if (config.abortFirstNavigation && !abortedOnce && request.isNavigationRequest()) {
        abortedOnce = true;
        stats.aborted += 1;
        return route.abort("aborted");
      }
      return html(`<!doctype html><title>Copilot Studio</title><div class="spinner" role="progressbar" aria-label="Loading"></div><script>setTimeout(function(){location.replace(${JSON.stringify(`${base}/home`)})},120)</script>`);
    }
    const segs = url.pathname.split("/").filter(Boolean);
    if (segs[0] === "environments" && envs[segs[1]]) {
      const envId = segs[1];
      const botId = segs[2] === "bots" ? segs[3] : null;
      const agent = findAgent(envId, botId);
      if (segs[2] === "bots" && !agent) return html(page(new URL(`${envBase(envId)}/home`), envId, null), 404);
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
