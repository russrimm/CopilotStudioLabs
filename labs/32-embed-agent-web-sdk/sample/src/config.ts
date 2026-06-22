// src/config.ts
// Replace these placeholder values with the IDs you captured in Use Cases 1 and 2.
// In a real app, load these from environment variables — never hard-code secrets.

export const authConfig = {
  clientId: "<YOUR-APP-CLIENT-ID>",
  tenantId: "<YOUR-TENANT-ID>",
  redirectUri: "http://localhost:5173",
  scopes: ["https://api.powerplatform.com/CopilotStudio.Copilots.Invoke"],
};

export const agentConfig = {
  environmentId: "<YOUR-ENVIRONMENT-ID>",
  agentIdentifier: "<YOUR-AGENT-SCHEMA-NAME>",
  cloud: "Prod" as const,
};

export const branding = {
  productName: "Contoso Assist",
  tagline: "Your AI helper for everything Contoso",
  primaryColor: "#0b6cff",
  primaryColorHover: "#0957cc",
  surfaceColor: "#ffffff",
  textColor: "#1c1c1c",
  agentAvatarUrl: "/agent-avatar.png",
  userAvatarInitials: "U",
  welcomeMessage:
    "Hi! I'm the Contoso Assist agent. Ask me about IT, policies, or your account.",
};
