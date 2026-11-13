// Static page for the kanban canvas. Client code builds the DOM with
// createElement/textContent only, so card text is never parsed as HTML.

const CSS = String.raw`
:root {
  --status-bar-color: var(--background-color-default, #ffffff); color-scheme: light dark;
  --kb-muted: var(--text-color-muted, #59636e); --kb-danger: #cf222e;
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 16px;
  background: var(--background-color-default, #ffffff);
  color: var(--text-color-default, #1f2328);
  font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  font-size: var(--text-body-medium, 14px); line-height: var(--leading-body-medium, 20px);
}
@media (prefers-color-scheme: dark) {
  :root { --kb-muted: var(--text-color-muted, #9198a1); --kb-danger: #ff7b72; }
  body { background: var(--background-color-default, #0d1117); color: var(--text-color-default, #e6edf3); }
}
header { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; margin-bottom: 16px; }
h1 { margin: 0 12px 0 0; font-size: var(--text-title-large, 22px); line-height: 28px; font-weight: var(--font-weight-semibold, 600); }
form.new { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; }
label { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--kb-muted); }
input, select, button {
  font: inherit; color: inherit; padding: 6px 8px; border-radius: 6px;
  border: 1px solid var(--border-color-default, #8c959f); background: transparent;
}
button { cursor: pointer; }
button.primary { background: var(--color-focus-outline, #0969da); border-color: transparent; color: #fff; }
button.danger { color: var(--kb-danger); }
:focus-visible { outline: 2px solid var(--color-focus-outline, #0969da); outline-offset: 2px; }
#board { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; align-items: start; }
.column { border: 1px solid var(--border-color-default, #d0d7de); border-radius: 8px; padding: 8px; min-height: 120px; }
.column h2 { margin: 0 0 8px; font-size: 14px; display: flex; justify-content: space-between; }
.count { color: var(--kb-muted); font-weight: normal; }
.cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; min-height: 48px; }
.cards.over { outline: 2px dashed var(--color-focus-outline, #0969da); outline-offset: 2px; }
.card { border: 1px solid var(--border-color-default, #d0d7de); border-radius: 6px; padding: 8px; cursor: grab; }
.card.dragging { opacity: 0.5; }
.card h3 { margin: 0 0 4px; font-size: 14px; }
.card p { margin: 0 0 6px; color: var(--kb-muted); white-space: pre-wrap; overflow-wrap: anywhere; }
.id { font-family: var(--font-mono, Consolas, monospace); font-size: 11px; color: var(--kb-muted); }
.badge { display: inline-block; padding: 0 8px; border-radius: 999px; border: 1px solid var(--border-color-default, #8c959f); font-size: 12px; }
.badge.none { color: var(--kb-muted); border-style: dashed; }
.row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 6px; }
.row button, .row select, .row input { padding: 2px 6px; font-size: 12px; }
.empty { color: var(--kb-muted); font-style: italic; padding: 4px; }
details { margin-top: 16px; }
#activity { margin: 8px 0 0; padding-left: 18px; color: var(--kb-muted); }
#status { min-height: 20px; margin-bottom: 8px; }
#status.error { color: var(--kb-danger); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (prefers-reduced-motion: no-preference) { .card { transition: opacity 0.15s; } }
`;

const SCRIPT = String.raw`
"use strict";
var state = { board: null, columns: [], editing: null, confirming: null, draft: null, dragging: false, stale: false };
var statusEl = document.getElementById("status");

function el(tag, attrs, children) {
  var node = document.createElement(tag);
  Object.keys(attrs || {}).forEach(function (k) {
    if (k === "class") node.className = attrs[k];
    else if (k === "text") node.textContent = attrs[k];
    else node.setAttribute(k, attrs[k]);
  });
  (children || []).forEach(function (c) { if (c) node.appendChild(c); });
  return node;
}

function announce(message, isError) {
  statusEl.textContent = message || "";
  statusEl.className = isError ? "error" : "";
}

function api(method, path, body) {
  return fetch(path, {
    method: method,
    headers: { "X-Requested-With": "kanban", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (data) {
      if (!res.ok) throw new Error(data.error || res.statusText);
      return data;
    });
  });
}

function act(promise, okMessage, focusKey) {
  return promise.then(function (data) {
    if (data.board) { state.board = data.board; render(focusKey); }
    if (okMessage) announce(okMessage, false);
  }).catch(function (err) { announce(err.message, true); });
}

function assigneeSuggestions() {
  var seen = { agent: true, copilot: true };
  state.board.cards.forEach(function (c) { if (c.assignee) seen[c.assignee] = true; });
  return Object.keys(seen);
}

function renderCard(card, list) {
  var li = el("li", { class: "card", draggable: "true", "data-id": card.id });
  li.addEventListener("dragstart", function (e) {
    e.dataTransfer.setData("text/plain", card.id);
    e.dataTransfer.effectAllowed = "move";
    state.dragging = true;
    li.classList.add("dragging");
  });
  li.addEventListener("dragend", function () {
    state.dragging = false;
    li.classList.remove("dragging");
    if (state.stale) refresh();
  });

  li.appendChild(el("div", { class: "id", text: card.id }));
  li.appendChild(el("h3", { text: card.title }));
  if (card.description) li.appendChild(el("p", { text: card.description }));

  var row = el("div", { class: "row" });
  if (state.editing === card.id) {
    var input = el("input", { type: "text", value: state.draft !== null ? state.draft : card.assignee, list: "assignees", "aria-label": "Assignee for " + card.id, maxlength: "80", "data-key": "assign-input-" + card.id });
    var save = function () {
      var value = input.value;
      state.editing = null; state.draft = null;
      act(api("POST", "/api/cards/" + card.id + "/assign", { assignee: value }), "Assigned " + card.id, "assign-" + card.id);
    };
    input.addEventListener("input", function () { state.draft = input.value; });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); save(); }
      if (e.key === "Escape") { state.editing = null; state.draft = null; render("assign-" + card.id); }
    });
    var saveBtn = el("button", { type: "button", text: "Save", "data-key": "assign-save-" + card.id });
    saveBtn.addEventListener("click", save);
    row.appendChild(input); row.appendChild(saveBtn);
  } else {
    row.appendChild(el("span", { class: card.assignee ? "badge" : "badge none", text: card.assignee || "Unassigned" }));
    var assignBtn = el("button", { type: "button", text: "Assign", "data-key": "assign-" + card.id, "aria-label": "Assign " + card.id });
    assignBtn.addEventListener("click", function () { state.editing = card.id; render("assign-input-" + card.id); });
    row.appendChild(assignBtn);
  }
  li.appendChild(row);

  var row2 = el("div", { class: "row" });
  var select = el("select", { "aria-label": "Move " + card.id + " to column", "data-key": "move-" + card.id });
  select.appendChild(el("option", { value: "", text: "Move to…" }));
  state.columns.forEach(function (c) { if (c.id !== card.column) select.appendChild(el("option", { value: c.id, text: c.title })); });
  select.addEventListener("change", function () {
    if (select.value) act(api("POST", "/api/cards/" + card.id + "/move", { column: select.value }), "Moved " + card.id, "move-" + card.id);
  });
  row2.appendChild(select);

  var confirming = state.confirming === card.id;
  var del = el("button", { type: "button", class: "danger", text: confirming ? "Confirm delete" : "Delete", "data-key": "delete-" + card.id });
  del.addEventListener("click", function () {
    if (!confirming) { state.confirming = card.id; render("delete-" + card.id); return; }
    state.confirming = null;
    act(api("DELETE", "/api/cards/" + card.id), "Deleted " + card.id, "new-title");
  });
  row2.appendChild(del);
  li.appendChild(row2);
  return li;
}

function renderColumn(col) {
  var cards = state.board.cards.filter(function (c) { return c.column === col.id; });
  var section = el("section", { class: "column", "aria-labelledby": "h-" + col.id });
  section.appendChild(el("h2", { id: "h-" + col.id }, [el("span", { text: col.title }), el("span", { class: "count", text: String(cards.length) })]));
  var list = el("ul", { class: "cards", "aria-label": col.title + " cards" });
  cards.forEach(function (card) { list.appendChild(renderCard(card, list)); });
  if (!cards.length) list.appendChild(el("li", { class: "empty", text: "No cards" }));

  list.addEventListener("dragover", function (e) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; list.classList.add("over"); });
  list.addEventListener("dragleave", function () { list.classList.remove("over"); });
  list.addEventListener("drop", function (e) {
    e.preventDefault(); list.classList.remove("over");
    state.dragging = false;
    var id = e.dataTransfer.getData("text/plain");
    if (!id) return;
    var items = Array.prototype.filter.call(list.querySelectorAll("li.card"), function (li) { return li.getAttribute("data-id") !== id; });
    var position = items.length;
    for (var i = 0; i < items.length; i++) {
      var r = items[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { position = i; break; }
    }
    act(api("POST", "/api/cards/" + id + "/move", { column: col.id, position: position }), "Moved " + id, "move-" + id);
  });
  section.appendChild(list);
  return section;
}

function render(focusKey) {
  if (!state.board) return;
  var active = document.activeElement;
  var key = focusKey || (active && active.getAttribute ? active.getAttribute("data-key") : null);
  document.getElementById("title").textContent = state.board.title;
  var datalist = document.getElementById("assignees");
  datalist.replaceChildren();
  assigneeSuggestions().forEach(function (a) { datalist.appendChild(el("option", { value: a })); });
  var board = document.getElementById("board");
  board.replaceChildren();
  state.columns.forEach(function (col) { board.appendChild(renderColumn(col)); });
  var log = document.getElementById("activity");
  log.replaceChildren();
  state.board.activity.forEach(function (a) {
    log.appendChild(el("li", { text: new Date(a.at).toLocaleTimeString() + " · " + a.by + ": " + a.text }));
  });
  if (key) {
    var target = document.querySelector('[data-key="' + key.replace(/"/g, "") + '"]');
    if (target) target.focus();
  }
}

function refresh() {
  if (state.dragging) { state.stale = true; return Promise.resolve(); }
  state.stale = false;
  return api("GET", "/api/board").then(function (data) {
    state.columns = data.columns; state.board = data.board; render();
  }).catch(function (err) { announce(err.message, true); });
}

var form = document.getElementById("new-card");
var select = document.getElementById("new-column");
form.addEventListener("submit", function (e) {
  e.preventDefault();
  var title = document.getElementById("new-title");
  var assignee = document.getElementById("new-assignee");
  if (!title.value.trim()) { announce("Enter a title for the card.", true); title.focus(); return; }
  act(api("POST", "/api/cards", { title: title.value, column: select.value, assignee: assignee.value }), "Card created").then(function () {
    title.value = ""; assignee.value = ""; title.focus();
  });
});

refresh().then(function () {
  state.columns.forEach(function (c) { select.appendChild(el("option", { value: c.id, text: c.title })); });
});

var events = new EventSource("/events");
events.onmessage = function () { refresh(); };
`;

export function renderPage() {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'">
<title>Agentic kanban</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <h1 id="title">Kanban board</h1>
  <form id="new-card" class="new" aria-label="Create card">
    <label>Title<input id="new-title" data-key="new-title" type="text" maxlength="200" autocomplete="off"></label>
    <label>Column<select id="new-column"></select></label>
    <label>Assignee<input id="new-assignee" type="text" list="assignees" maxlength="80" autocomplete="off"></label>
    <button class="primary" type="submit">Add card</button>
  </form>
  <datalist id="assignees"></datalist>
</header>
<div id="status" role="status" aria-live="polite"></div>
<main id="board"></main>
<details>
  <summary>Activity</summary>
  <ul id="activity"></ul>
</details>
<script>${SCRIPT}</script>
</body>
</html>`;
}
