// src/ui.ts
import { branding } from "./config";

type Activity = {
  type: string;
  text?: string;
  from?: { role?: string };
  suggestedActions?: { actions: { title: string; value: string }[] };
  attachments?: { contentType: string; content: any }[];
};

export function renderUserMessage(parent: HTMLElement, text: string) {
  const row = document.createElement("div");
  row.className = "msg-row user";
  row.innerHTML = `
    <div class="msg user">${escapeHtml(text)}</div>
    <div class="avatar user-avatar">${escapeHtml(branding.userAvatarInitials)}</div>
  `;
  parent.appendChild(row);
  parent.scrollTop = parent.scrollHeight;
}

export function renderActivity(
  parent: HTMLElement,
  activity: Activity,
  onSuggestion: (text: string) => void
) {
  if (activity.type !== "message") return;

  const row = document.createElement("div");
  row.className = "msg-row bot";
  row.innerHTML = `
    <img src="${branding.agentAvatarUrl}" alt="" class="avatar" />
    <div class="bot-content"></div>
  `;
  const content = row.querySelector(".bot-content") as HTMLElement;

  if (activity.text) {
    const bubble = document.createElement("div");
    bubble.className = "msg bot";
    bubble.innerHTML = formatText(activity.text);
    content.appendChild(bubble);
  }

  if (activity.attachments?.length) {
    for (const att of activity.attachments) {
      if (att.contentType === "application/vnd.microsoft.card.adaptive") {
        const card = document.createElement("div");
        card.className = "adaptive-card-fallback";
        card.textContent = JSON.stringify(att.content, null, 2);
        content.appendChild(card);
      }
    }
  }

  if (activity.suggestedActions?.actions?.length) {
    const wrap = document.createElement("div");
    wrap.className = "suggestions";
    for (const action of activity.suggestedActions.actions) {
      const btn = document.createElement("button");
      btn.className = "suggestion";
      btn.textContent = action.title;
      btn.addEventListener("click", () =>
        onSuggestion(action.value ?? action.title)
      );
      wrap.appendChild(btn);
    }
    content.appendChild(wrap);
  }

  parent.appendChild(row);
  parent.scrollTop = parent.scrollHeight;
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatText(s: string) {
  const escaped = escapeHtml(s);
  const withLinks = escaped.replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener">$1</a>'
  );
  return withLinks.replace(/\n/g, "<br />");
}
