/**
 * Email sending — supports SMTP (Nodemailer) and Microsoft Graph API.
 *
 * Configuration via environment variables:
 *   SMTP mode:  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM
 *   Graph mode: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, MAIL_FROM
 */

import nodemailer from "nodemailer";

/**
 * Send an email with optional attachments.
 *
 * @param {Object} opts
 * @param {string|string[]} opts.to       - Recipient(s)
 * @param {string}          opts.subject  - Subject line
 * @param {string}          opts.html     - HTML body
 * @param {string}          [opts.text]   - Plain-text fallback
 * @param {Array}           [opts.attachments] - Nodemailer-style attachments
 * @returns {Promise<Object>} Send result
 */
export async function sendMail({ to, subject, html, text, attachments = [] }) {
  const recipients = Array.isArray(to) ? to : [to];

  // Decide transport based on available config
  if (process.env.SMTP_HOST) {
    return sendViaSMTP({ to: recipients, subject, html, text, attachments });
  }

  if (process.env.AZURE_TENANT_ID && process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET) {
    return sendViaGraph({ to: recipients, subject, html, text, attachments });
  }

  throw new Error(
    "No email transport configured. Set SMTP_HOST or AZURE_TENANT_ID + AZURE_CLIENT_ID + AZURE_CLIENT_SECRET."
  );
}

// ── SMTP transport ──────────────────────────────────────────────────────────

async function sendViaSMTP({ to, subject, html, text, attachments }) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });

  const info = await transporter.sendMail({
    from: process.env.MAIL_FROM || "labs@copilot-studio-labs.local",
    to: to.join(", "),
    subject,
    html,
    text,
    attachments,
  });

  return { transport: "smtp", messageId: info.messageId, accepted: info.accepted };
}

// ── Microsoft Graph transport ───────────────────────────────────────────────

async function getGraphToken() {
  const tenantId = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;

  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
  });

  const res = await fetch(url, { method: "POST", body });
  if (!res.ok) throw new Error(`Graph token request failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

async function sendViaGraph({ to, subject, html, text, attachments }) {
  const token = await getGraphToken();
  const from = process.env.MAIL_FROM;

  if (!from) throw new Error("MAIL_FROM is required for Microsoft Graph transport.");

  const message = {
    subject,
    body: { contentType: "HTML", content: html },
    toRecipients: to.map((addr) => ({ emailAddress: { address: addr } })),
    attachments: attachments.map((a) => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: a.filename,
      contentBytes: typeof a.content === "string"
        ? Buffer.from(a.content).toString("base64")
        : a.content.toString("base64"),
      contentType: a.contentType || "application/octet-stream",
    })),
  };

  const url = `https://graph.microsoft.com/v1.0/users/${from}/sendMail`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message, saveToSentItems: true }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Graph sendMail failed: ${res.status} ${errText}`);
  }

  return { transport: "graph", status: "sent", recipients: to };
}
