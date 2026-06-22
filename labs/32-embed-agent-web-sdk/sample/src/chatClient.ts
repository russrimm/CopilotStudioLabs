// src/chatClient.ts
import {
  CopilotStudioClient,
  ConnectionSettings,
  PowerPlatformCloud,
} from "@microsoft/agents-copilotstudio-client";
import { agentConfig } from "./config";
import { getAccessToken } from "./auth";

let client: CopilotStudioClient | null = null;
let conversationId: string | null = null;

function cloudFromString(value: string): PowerPlatformCloud {
  switch (value) {
    case "Gov":
      return PowerPlatformCloud.Gov;
    case "High":
      return PowerPlatformCloud.High;
    case "DoD":
      return PowerPlatformCloud.DoD;
    default:
      return PowerPlatformCloud.Prod;
  }
}

export async function ensureClient(): Promise<CopilotStudioClient> {
  if (client) return client;

  const token = await getAccessToken();

  const settings: ConnectionSettings = {
    environmentId: agentConfig.environmentId,
    agentIdentifier: agentConfig.agentIdentifier,
    cloud: cloudFromString(agentConfig.cloud),
  };

  client = new CopilotStudioClient(settings, token);
  return client;
}

export async function startConversation() {
  const c = await ensureClient();
  const activities: any[] = [];
  for await (const activity of c.startConversationAsync(true)) {
    activities.push(activity);
    if (activity.conversation?.id) {
      conversationId = activity.conversation.id;
    }
  }
  return activities;
}

export async function sendMessage(text: string) {
  const c = await ensureClient();
  if (!conversationId) {
    throw new Error("Conversation not started");
  }
  const activities: any[] = [];
  for await (const activity of c.askQuestionAsync(text, conversationId)) {
    activities.push(activity);
  }
  return activities;
}

export function getConversationId() {
  return conversationId;
}

export function resetClient() {
  client = null;
  conversationId = null;
}
