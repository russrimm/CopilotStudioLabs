// src/main.ts
import { branding } from "./config";
import { initAuth, signIn, signOut, getAccount } from "./auth";
import {
  startConversation,
  sendMessage,
  resetClient,
} from "./chatClient";
import { renderActivity, renderUserMessage } from "./ui";
import "./styles.css";

const root = document.getElementById("app")!;

root.innerHTML = `
  <div class="chat-shell" style="
    --primary:${branding.primaryColor};
    --primary-hover:${branding.primaryColorHover};
    --surface:${branding.surfaceColor};
    --text:${branding.textColor};
  ">
    <header class="chat-header">
      <img src="${branding.agentAvatarUrl}" alt="" class="brand-avatar" />
      <div>
        <h1>${branding.productName}</h1>
        <p>${branding.tagline}</p>
      </div>
      <button id="auth-btn" class="auth-btn">Sign in</button>
    </header>
    <main id="messages" class="messages" aria-live="polite"></main>
    <footer class="composer">
      <input
        id="composer-input"
        type="text"
        placeholder="Ask me anything…"
        autocomplete="off"
        disabled
      />
      <button id="send-btn" class="send-btn" disabled>Send</button>
    </footer>
  </div>
`;

const messagesEl = document.getElementById("messages") as HTMLDivElement;
const inputEl = document.getElementById("composer-input") as HTMLInputElement;
const sendBtn = document.getElementById("send-btn") as HTMLButtonElement;
const authBtn = document.getElementById("auth-btn") as HTMLButtonElement;

function setSignedInUi(signedIn: boolean) {
  inputEl.disabled = !signedIn;
  sendBtn.disabled = !signedIn;
  authBtn.textContent = signedIn ? "Sign out" : "Sign in";
}

async function handleSendMessage(text: string) {
  if (!text.trim()) return;
  renderUserMessage(messagesEl, text);
  inputEl.value = "";

  showTyping(true);
  try {
    const activities = await sendMessage(text);
    showTyping(false);
    for (const activity of activities) {
      renderActivity(messagesEl, activity, (suggestion) =>
        handleSendMessage(suggestion)
      );
    }
  } catch (err) {
    showTyping(false);
    renderActivity(
      messagesEl,
      {
        type: "message",
        text: `Sorry — something went wrong: ${(err as Error).message}`,
        from: { role: "bot" },
      } as any,
      () => {}
    );
  }
}

function showTyping(on: boolean) {
  const existing = document.getElementById("typing-bubble");
  if (on && !existing) {
    const bubble = document.createElement("div");
    bubble.id = "typing-bubble";
    bubble.className = "msg bot typing";
    bubble.innerHTML = `<span></span><span></span><span></span>`;
    messagesEl.appendChild(bubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } else if (!on && existing) {
    existing.remove();
  }
}

async function bootstrap() {
  await initAuth();

  authBtn.addEventListener("click", async () => {
    if (getAccount()) {
      await signOut();
      resetClient();
      messagesEl.innerHTML = "";
      setSignedInUi(false);
    } else {
      await signIn();
      setSignedInUi(true);
      await openWelcome();
    }
  });

  sendBtn.addEventListener("click", () => handleSendMessage(inputEl.value));
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleSendMessage(inputEl.value);
  });

  if (getAccount()) {
    setSignedInUi(true);
    await openWelcome();
  } else {
    setSignedInUi(false);
  }
}

async function openWelcome() {
  renderActivity(
    messagesEl,
    {
      type: "message",
      text: branding.welcomeMessage,
      from: { role: "bot" },
    } as any,
    () => {}
  );

  showTyping(true);
  try {
    const activities = await startConversation();
    showTyping(false);
    for (const activity of activities) {
      renderActivity(messagesEl, activity, (suggestion) =>
        handleSendMessage(suggestion)
      );
    }
  } catch (err) {
    showTyping(false);
    console.error(err);
  }
}

bootstrap();
