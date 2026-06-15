/**
 * Environment provisioning approval engine.
 * Supports multiple approval channels and notification methods.
 */

import { randomBytes, randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { sendMail } from "./mailer.js";
import { createEnvironment } from "./powerplatform.js";

const dataRoot = resolve(import.meta.dirname, "..", "data");
const approvalConfigPath = resolve(dataRoot, "approval-config.json");
const approvalRequestsPath = resolve(dataRoot, "approval-requests.json");

const DEFAULT_CONFIG = {
  approvalMethod: "none",
  notificationChannels: [],
  powerAutomateWebhookUrl: "",
  logicAppsWebhookUrl: "",
  copilotStudioWebhookUrl: "",
  teamsAdaptiveCardWebhookUrl: "",
  teamsNotificationWebhookUrl: "",
  teamsNotificationUserEmail: "",
  approverEmails: [],
};

const VALID_APPROVAL_METHODS = new Set([
  "none",
  "portal",
  "power-automate",
  "logic-apps",
  "copilot-studio",
  "teams-adaptive-card",
]);

const VALID_NOTIFICATION_CHANNELS = new Set(["teams", "email"]);

function ensureDataRoot() {
  mkdirSync(dataRoot, { recursive: true });
}

function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(path, data) {
  ensureDataRoot();
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function sanitizeString(value) {
  return String(value ?? "").trim();
}

function sanitizeUrl(value) {
  return sanitizeString(value);
}

function sanitizeEmailList(value) {
  const items = Array.isArray(value)
    ? value
    : String(value ?? "")
      .split(/[;,]/)
      .map((item) => item.trim());

  return [...new Set(items.filter(Boolean))];
}

function sanitizeConfig(config = {}) {
  const approvalMethod = VALID_APPROVAL_METHODS.has(config.approvalMethod)
    ? config.approvalMethod
    : DEFAULT_CONFIG.approvalMethod;

  const notificationChannels = [...new Set(
    (Array.isArray(config.notificationChannels) ? config.notificationChannels : [])
      .filter((channel) => VALID_NOTIFICATION_CHANNELS.has(channel))
  )];

  return {
    ...DEFAULT_CONFIG,
    approvalMethod,
    notificationChannels,
    powerAutomateWebhookUrl: sanitizeUrl(config.powerAutomateWebhookUrl),
    logicAppsWebhookUrl: sanitizeUrl(config.logicAppsWebhookUrl),
    copilotStudioWebhookUrl: sanitizeUrl(config.copilotStudioWebhookUrl),
    teamsAdaptiveCardWebhookUrl: sanitizeUrl(config.teamsAdaptiveCardWebhookUrl),
    teamsNotificationWebhookUrl: sanitizeUrl(config.teamsNotificationWebhookUrl),
    teamsNotificationUserEmail: sanitizeString(config.teamsNotificationUserEmail),
    approverEmails: sanitizeEmailList(config.approverEmails),
  };
}

function loadRequestsInternal() {
  const data = readJson(approvalRequestsPath, []);
  return Array.isArray(data) ? data : [];
}

function saveRequestsInternal(requests) {
  writeJson(approvalRequestsPath, requests);
}

function updateRequest(requestId, updater) {
  const requests = loadRequestsInternal();
  const index = requests.findIndex((request) => request.id === requestId);
  if (index === -1) {
    throw new Error(`Approval request not found: ${requestId}`);
  }

  const updated = updater({ ...requests[index] });
  requests[index] = updated;
  saveRequestsInternal(requests);
  return updated;
}

function appendWorkflowEvent(request, type, message) {
  return {
    ...request,
    workflowEvents: [
      ...(request.workflowEvents || []),
      {
        type,
        message,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

function isEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function uniqueEmails(...groups) {
  return [...new Set(groups.flat().filter((email) => isEmailAddress(email)))];
}

function getPortalReviewUrl(portalUrl) {
  return `${portalUrl}#powerplatform`;
}

function getCallbackGetUrl(portalUrl, request, decision) {
  const url = new URL("/api/pp/approval-callback", portalUrl);
  url.searchParams.set("requestId", request.id);
  url.searchParams.set("callbackToken", request.callbackToken);
  url.searchParams.set("decision", decision);
  url.searchParams.set("decidedBy", "teams-adaptive-card");
  return url.toString();
}

function getCallbackPostUrl(portalUrl) {
  return new URL("/api/pp/approval-callback", portalUrl).toString();
}

function buildAdaptiveCard({ title, intro, request, portalUrl, actions = [] }) {
  const card = {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: title,
        weight: "Bolder",
        size: "Large",
      },
      {
        type: "FactSet",
        facts: [
          { title: "Environment:", value: request.displayName },
          { title: "Type:", value: request.environmentType },
          { title: "Region:", value: request.location },
          { title: "Requested by:", value: request.requestedBy },
          { title: "Requested at:", value: new Date(request.requestedAt).toLocaleString() },
        ],
      },
      {
        type: "TextBlock",
        text: intro,
        wrap: true,
        size: "Small",
      },
    ],
    actions: [
      {
        type: "Action.OpenUrl",
        title: "✅ Open Portal to Review",
        url: getPortalReviewUrl(portalUrl),
      },
      ...actions,
    ],
  };

  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: card,
      },
    ],
  };
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Webhook ${res.status}: ${text.substring(0, 300)}`);
  }

  const text = await res.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function loadApprovalConfig() {
  return sanitizeConfig(readJson(approvalConfigPath, DEFAULT_CONFIG));
}

export function saveApprovalConfig(config) {
  const nextConfig = sanitizeConfig(config);
  writeJson(approvalConfigPath, nextConfig);
  return nextConfig;
}

export function listRequests(filter = {}) {
  const status = typeof filter === "string" ? filter : sanitizeString(filter.status);
  const requests = loadRequestsInternal()
    .filter((request) => !status || request.status === status)
    .sort((a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime());

  return requests;
}

export function getRequest(requestId) {
  return loadRequestsInternal().find((request) => request.id === requestId) || null;
}

export async function sendTeamsNotification(webhookUrl, message) {
  if (!webhookUrl) return null;
  return postJson(webhookUrl, message);
}

export async function sendEmailNotification(to, subject, html) {
  const recipients = sanitizeEmailList(to);
  if (!recipients.length) return null;
  return sendMail({
    to: recipients,
    subject,
    html,
    text: html.replace(/<[^>]+>/g, " "),
  });
}

async function sendConfiguredNotifications(request, eventType) {
  const config = loadApprovalConfig();
  const portalUrl = request.portalUrl || process.env.PORTAL_BASE_URL || "http://localhost:3000";
  const teamsWebhookUrl = config.teamsNotificationWebhookUrl || config.teamsAdaptiveCardWebhookUrl;

  const eventTitles = {
    submitted: "⚡ Power Platform Environment Request",
    approved: "✅ Power Platform Request Approved",
    rejected: "❌ Power Platform Request Rejected",
    provisioned: "🚀 Power Platform Environment Provisioned",
    failed: "⚠️ Power Platform Provisioning Failed",
  };

  const introText = {
    submitted: "Review and respond in the Copilot Studio Labs Portal",
    approved: `Approved by ${request.decidedBy || "an approver"}.`,
    rejected: `Rejected by ${request.decidedBy || "an approver"}.`,
    provisioned: `Provisioning completed${request.environmentId ? ` — Environment ID: ${request.environmentId}` : ""}.`,
    failed: `Provisioning failed${request.reason ? ` — ${request.reason}` : ""}.`,
  };

  const notificationEmails = eventType === "submitted"
    ? config.approverEmails
    : uniqueEmails(config.approverEmails, isEmailAddress(request.requestedBy) ? [request.requestedBy] : []);

  if (config.notificationChannels.includes("teams") && teamsWebhookUrl) {
    try {
      await sendTeamsNotification(teamsWebhookUrl, buildAdaptiveCard({
        title: eventTitles[eventType] || eventTitles.submitted,
        intro: introText[eventType] || introText.submitted,
        request,
        portalUrl,
      }));
    } catch (err) {
      console.warn(`Teams notification failed for request ${request.id}:`, err.message);
    }
  }

  if (config.notificationChannels.includes("email") && notificationEmails.length) {
    const html = `
      <div style="font-family: Segoe UI, Arial, sans-serif; max-width: 640px;">
        <h2>${eventTitles[eventType] || eventTitles.submitted}</h2>
        <p>${introText[eventType] || introText.submitted}</p>
        <ul>
          <li><strong>Environment:</strong> ${request.displayName}</li>
          <li><strong>Type:</strong> ${request.environmentType}</li>
          <li><strong>Region:</strong> ${request.location}</li>
          <li><strong>Requested by:</strong> ${request.requestedBy}</li>
          <li><strong>Requested at:</strong> ${new Date(request.requestedAt).toLocaleString()}</li>
          ${request.decidedBy ? `<li><strong>Decided by:</strong> ${request.decidedBy}</li>` : ""}
          ${request.reason ? `<li><strong>Reason:</strong> ${request.reason}</li>` : ""}
          ${request.environmentId ? `<li><strong>Environment ID:</strong> ${request.environmentId}</li>` : ""}
        </ul>
        <p><a href="${getPortalReviewUrl(portalUrl)}">Open the Copilot Studio Labs Portal</a></p>
      </div>
    `;

    try {
      await sendEmailNotification(
        notificationEmails,
        `${eventTitles[eventType] || eventTitles.submitted} — ${request.displayName}`,
        html,
      );
    } catch (err) {
      console.warn(`Email notification failed for request ${request.id}:`, err.message);
    }
  }
}

function validateApprovalChannelConfig(config) {
  const missingConfigErrors = {
    "power-automate": !config.powerAutomateWebhookUrl && "Power Automate webhook URL is required.",
    "logic-apps": !config.logicAppsWebhookUrl && "Logic App HTTP trigger URL is required.",
    "copilot-studio": !config.copilotStudioWebhookUrl && "Copilot Studio agent webhook URL is required.",
    "teams-adaptive-card": !config.teamsAdaptiveCardWebhookUrl && "Teams webhook URL is required for Teams Adaptive Card approvals.",
  };

  const error = missingConfigErrors[config.approvalMethod];
  if (error) throw new Error(error);
}

async function triggerApprovalChannel(request, config) {
  const portalUrl = request.portalUrl || process.env.PORTAL_BASE_URL || "http://localhost:3000";
  const callbackUrl = getCallbackPostUrl(portalUrl);
  const payload = {
    requestId: request.id,
    callbackToken: request.callbackToken,
    callbackUrl,
    portalUrl,
    request,
  };

  switch (config.approvalMethod) {
    case "none":
      return approveRequest(request.id, request.requestedBy, "Auto-approved (approval method: none)");
    case "portal":
      return request;
    case "power-automate":
      await postJson(config.powerAutomateWebhookUrl, payload);
      return request;
    case "logic-apps":
      await postJson(config.logicAppsWebhookUrl, payload);
      return request;
    case "copilot-studio":
      await postJson(config.copilotStudioWebhookUrl, payload);
      return request;
    case "teams-adaptive-card":
      await sendTeamsNotification(config.teamsAdaptiveCardWebhookUrl, buildAdaptiveCard({
        title: "⚡ Power Platform Environment Request",
        intro: "Review the request and approve or reject directly from Teams or open the portal for more details.",
        request,
        portalUrl,
        actions: [
          {
            type: "Action.OpenUrl",
            title: "✅ Approve",
            url: getCallbackGetUrl(portalUrl, request, "approved"),
          },
          {
            type: "Action.OpenUrl",
            title: "❌ Reject",
            url: getCallbackGetUrl(portalUrl, request, "rejected"),
          },
        ],
      }));
      return request;
    default:
      throw new Error(`Unsupported approval method: ${config.approvalMethod}`);
  }
}

export async function submitRequest(requestData) {
  const config = loadApprovalConfig();
  validateApprovalChannelConfig(config);

  if (!sanitizeString(requestData.displayName)) {
    throw new Error("displayName is required");
  }

  const request = {
    id: randomUUID(),
    requestedBy: sanitizeString(requestData.requestedBy) || "unknown",
    requestedByName: sanitizeString(requestData.requestedByName),
    displayName: sanitizeString(requestData.displayName),
    environmentType: sanitizeString(requestData.environmentType) || "Sandbox",
    location: sanitizeString(requestData.location) || "unitedstates",
    language: sanitizeString(requestData.language) || "1033",
    currency: sanitizeString(requestData.currency) || "USD",
    securityGroupId: sanitizeString(requestData.securityGroupId) || null,
    status: "pending",
    requestedAt: new Date().toISOString(),
    decidedAt: null,
    decidedBy: null,
    reason: "",
    environmentId: null,
    callbackToken: randomBytes(24).toString("hex"),
    approvalMethod: config.approvalMethod,
    portalUrl: sanitizeString(requestData.portalUrl),
    workflowEvents: [],
  };

  const requests = loadRequestsInternal();
  requests.push(appendWorkflowEvent(request, "submitted", "Request submitted."));
  saveRequestsInternal(requests);

  try {
    await sendConfiguredNotifications(request, "submitted");
    const result = await triggerApprovalChannel(request, config);
    return result;
  } catch (err) {
    updateRequest(request.id, (current) => appendWorkflowEvent(current, "error", err.message));
    throw err;
  }
}

export async function approveRequest(requestId, decidedBy, reason = "") {
  let request = updateRequest(requestId, (current) => {
    if (current.status !== "pending") {
      throw new Error(`Only pending requests can be approved. Current status: ${current.status}`);
    }

    return appendWorkflowEvent({
      ...current,
      status: "approved",
      decidedAt: new Date().toISOString(),
      decidedBy: sanitizeString(decidedBy) || "approver",
      reason: sanitizeString(reason),
    }, "approved", "Request approved. Provisioning started.");
  });

  await sendConfiguredNotifications(request, "approved");

  try {
    const environment = await createEnvironment({
      displayName: request.displayName,
      location: request.location,
      environmentType: request.environmentType,
      currency: request.currency,
      language: request.language,
      securityGroupId: request.securityGroupId,
    });

    request = updateRequest(requestId, (current) => appendWorkflowEvent({
      ...current,
      status: "provisioned",
      environmentId: current.environmentId || environment?.name || environment?.id || null,
      provisionedAt: new Date().toISOString(),
      environment,
    }, "provisioned", "Environment provisioned successfully."));

    await sendConfiguredNotifications(request, "provisioned");
    return request;
  } catch (err) {
    request = updateRequest(requestId, (current) => appendWorkflowEvent({
      ...current,
      status: "failed",
      reason: sanitizeString(reason) || err.message,
      failedAt: new Date().toISOString(),
    }, "failed", err.message));

    await sendConfiguredNotifications(request, "failed");
    throw err;
  }
}

export async function rejectRequest(requestId, decidedBy, reason = "") {
  const request = updateRequest(requestId, (current) => {
    if (current.status !== "pending") {
      throw new Error(`Only pending requests can be rejected. Current status: ${current.status}`);
    }

    return appendWorkflowEvent({
      ...current,
      status: "rejected",
      decidedAt: new Date().toISOString(),
      decidedBy: sanitizeString(decidedBy) || "approver",
      reason: sanitizeString(reason),
    }, "rejected", "Request rejected.");
  });

  await sendConfiguredNotifications(request, "rejected");
  return request;
}
