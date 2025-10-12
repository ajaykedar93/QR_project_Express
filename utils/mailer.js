// utils/mailer.js
import { google } from "googleapis";
import 'dotenv/config'; // safe to keep; ensures envs are present even if caller forgot

const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || "").trim());

function buildRaw({ from, to, subject, html, text }) {
  const toList = Array.isArray(to) ? to.join(", ") : String(to);
  const needsEncoded = /[^\x00-\x7F]/.test(subject || "");
  const encSubject = needsEncoded
    ? `=?UTF-8?B?${Buffer.from(subject || "", "utf8").toString("base64")}?=`
    : (subject || "");
  const boundary = "=_mime_" + Math.random().toString(36).slice(2);

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
    text || " ",
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

  return Buffer.from(lines.join("\r\n"), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * HTTPS-only Gmail API sender (no SMTP).
 * Keeps the same signature used by your routes.
 */
export async function sendEmail({ to, subject, html, text = "" }) {
  const {
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI,
    REFRESH_TOKEN,
    SENDER_EMAIL,
  } = process.env;

  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI || !REFRESH_TOKEN) {
    throw new Error("Gmail API credentials are not configured");
  }
  if (!SENDER_EMAIL) throw new Error("SENDER_EMAIL is not configured");
  const toList = Array.isArray(to) ? to : [to];
  if (!toList.length || !toList.every(isEmail)) throw new Error("Invalid recipient email");

  try {
    const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
    oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
    const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

    const raw = buildRaw({
      from: `Placement App <${SENDER_EMAIL}>`,
      to: toList,
      subject,
      html,
      text,
    });

    const { data } = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });

    return data; // { id, threadId, ... }
  } catch (err) {
    const msg = err?.response?.data?.error?.message || err?.message || String(err);
    console.error("MAIL_ERROR[Gmail API]:", msg);
    throw new Error("Failed to send email");
  }
}
