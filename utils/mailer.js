// utils/mailer.js
import { google } from "googleapis";
import dotenv from "dotenv";
dotenv.config();

// OAuth2 client for Gmail API (HTTPS only; no SMTP)
const oAuth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);
oAuth2Client.setCredentials({ refresh_token: process.env.REFRESH_TOKEN });

const GMAIL_FROM = process.env.SENDER_EMAIL; // must be the authenticated Gmail address

const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || "").trim());

/**
 * Helper: build a minimal RFC 2822 MIME email (HTML + UTF-8) and base64url encode it.
 */
function buildRawMessage({ from, to, subject, html, text }) {
  const toList = Array.isArray(to) ? to.join(", ") : String(to);
  // Encode subject as UTF-8 with RFC2047 if needed
  const needsEncoded = /[^\x00-\x7F]/.test(subject || "");
  const encSubject = needsEncoded
    ? `=?UTF-8?B?${Buffer.from(subject || "", "utf8").toString("base64")}?=`
    : (subject || "");

  const boundary = "=_mime_boundary_" + Math.random().toString(36).slice(2);

  // Multipart/alternative (text fallback + html)
  const lines = [
    `From: ${from}`,
    `To: ${toList}`,
    `Subject: ${encSubject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    (text && String(text)) || " ",
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    html || "<p></p>",
    ``,
    `--${boundary}--`,
    ``,
  ];

  const raw = Buffer.from(lines.join("\r\n"), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  return raw;
}

/**
 * Send email via Gmail API (HTTPS, OAuth2)
 * @param {Object} params
 * @param {string|string[]} params.to
 * @param {string} params.subject
 * @param {string} params.html
 * @param {string} [params.text]
 * @returns {Promise<{id:string, threadId:string}>}
 */
export async function sendEmail({ to, subject, html, text = "" }) {
  if (!process.env.CLIENT_ID || !process.env.CLIENT_SECRET || !process.env.REFRESH_TOKEN || !process.env.REDIRECT_URI) {
    throw new Error("Gmail API credentials are not configured");
  }
  if (!GMAIL_FROM) throw new Error("SENDER_EMAIL is not configured");
  if (!to || (Array.isArray(to) && to.length === 0)) throw new Error("Recipient email is required");
  const toList = Array.isArray(to) ? to : [to];
  if (!toList.every(isEmail)) throw new Error("Invalid recipient email");

  try {
    const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

    const raw = buildRawMessage({
      from: GMAIL_FROM,
      to: toList,
      subject,
      html,
      text,
    });

    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });

    return res.data; // { id, threadId, ... }
  } catch (err) {
    // Log compactly; don’t leak secrets
    const msg = err?.response?.data?.error?.message || err?.message || String(err);
    console.error("MAIL_ERROR[Gmail API]:", msg);
    throw new Error("Failed to send email");
  }
}
