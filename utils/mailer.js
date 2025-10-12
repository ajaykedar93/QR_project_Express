// utils/mailer.js
import dotenv from "dotenv";
dotenv.config();

import nodemailer from "nodemailer";

// Optional Resend (HTTP) — avoids SMTP port blocks entirely
let resendClient = null;
if (process.env.RESEND_API_KEY) {
  try {
    const { Resend } = await import("resend");
    resendClient = new Resend(process.env.RESEND_API_KEY);
  } catch (_) {
    // If the package isn't installed, we'll silently fall back to SMTP
    // npm i resend  (to use this path)
    resendClient = null;
  }
}

/* ------------------------------- ENV -------------------------------- */

const {
  EMAIL_FROM_NAME = "QR-Docs",
  EMAIL_FROM = "",                // optional explicit from address (e.g., "no-reply@yourdomain.com")
  EMAIL_USER = "",                // SMTP user (Yahoo address for Yahoo mode)
  EMAIL_PASS = "",                // SMTP password (Yahoo App Password for Yahoo mode)

  // Generic SMTP (if you don’t want Yahoo defaults)
  SMTP_HOST = "",                 // e.g., "smtp.sendgrid.net" or "smtp.mail.yahoo.com"
  SMTP_PORT = "",                 // e.g., "2525" or "587" or "465"
  SMTP_SECURE = "",               // "true"/"false" (true = SMTPS/465)
  SMTP_REQUIRE_TLS = "true",      // for 587 STARTTLS
  SMTP_FAMILY = "4",              // force IPv4 by default (avoids IPv6 timeouts on some PaaS)
  SMTP_CONN_TIMEOUT = "60000",
  SMTP_GREETING_TIMEOUT = "30000",
  SMTP_SOCKET_TIMEOUT = "90000",
} = process.env;

// Choose a default sender
function buildFrom() {
  const addr = EMAIL_FROM || EMAIL_USER;     // prefer explicit EMAIL_FROM, else EMAIL_USER
  return addr ? `${EMAIL_FROM_NAME} <${addr}>` : `${EMAIL_FROM_NAME} <noreply@qr-docs.app>`;
}

/* --------------------------- TRANSPORT BUILD -------------------------- */

let cachedTransport = null;

/**
 * Create or reuse a nodemailer transporter.
 * Priority:
 *  - If RESEND_API_KEY is present & usable, we'll not create a transporter (HTTP path).
 *  - If SMTP_HOST provided, use those generic SMTP settings.
 *  - Else fallback to Yahoo defaults on port 587 with STARTTLS.
 */
function getSmtpTransport() {
  if (cachedTransport) return cachedTransport;

  // If a generic SMTP host is provided, use that
  if (SMTP_HOST) {
    cachedTransport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT || 587),
      secure: String(SMTP_SECURE).toLowerCase() === "true", // true = 465
      requireTLS: String(SMTP_REQUIRE_TLS).toLowerCase() === "true",
      family: Number(SMTP_FAMILY || 4),            // force IPv4 by default
      auth: EMAIL_USER && EMAIL_PASS ? { user: EMAIL_USER, pass: EMAIL_PASS } : undefined,
      connectionTimeout: Number(SMTP_CONN_TIMEOUT || 60000),
      greetingTimeout: Number(SMTP_GREETING_TIMEOUT || 30000),
      socketTimeout: Number(SMTP_SOCKET_TIMEOUT || 90000),
      // Avoid pooling on serverless/PaaS; enable only if you know your infra keeps the process warm.
      // pool: false,
      tls: { minVersion: "TLSv1.2" },
    });
    return cachedTransport;
  }

  // Yahoo fallback (STARTTLS on 587, IPv4)
  cachedTransport = nodemailer.createTransport({
    host: "smtp.mail.yahoo.com",
    port: 587,
    secure: false,                 // STARTTLS
    requireTLS: true,
    family: 4,                     // <-- important to avoid IPv6 timeouts on some hosts
    auth: { user: EMAIL_USER, pass: EMAIL_PASS }, // Yahoo App Password required
    connectionTimeout: 60000,
    greetingTimeout: 30000,
    socketTimeout: 90000,
    // pool: false,
    tls: { servername: "smtp.mail.yahoo.com", minVersion: "TLSv1.2" },
  });

  return cachedTransport;
}

/* ------------------------------- API -------------------------------- */

/**
 * Send an email (HTML preferred).
 * Automatically uses:
 *   - Resend HTTP API if RESEND_API_KEY is set & library present
 *   - Else SMTP (generic or Yahoo fallback)
 *
 * @param {Object} opts
 * @param {string|string[]} opts.to
 * @param {string} opts.subject
 * @param {string} [opts.html]
 * @param {string} [opts.message] - plain text
 * @param {Array}  [opts.attachments] - nodemailer attachments array
 * @param {string} [opts.from] - override default From
 */
export async function sendEmail({ to, subject, html, message, attachments = [], from }) {
  if (!to || !subject || (!html && !message)) {
    throw new Error("sendEmail: missing to/subject/body");
  }

  // 1) HTTP (Resend) path — best on PaaS (no SMTP/ports)
  if (resendClient) {
    const sender = from || buildFrom();
    const payload = {
      from: sender,
      to: Array.isArray(to) ? to : [to],
      subject,
      html: html || (message ? `<p>${message}</p>` : "<p></p>"),
    };

    // Resend supports simple attachments via "attachments" with content/filename if needed.
    // If you need attachments, map nodemailer-like entries to Resend's:
    if (attachments?.length) {
      payload.attachments = await Promise.all(
        attachments.map(async (a) => {
          // Support Buffer or string paths for simplicity
          if (a.path) {
            // If you need to read a file: import fs/promises and readFile here (omitted for brevity)
            // const data = await fs.readFile(a.path);
            // return { filename: a.filename || path.basename(a.path), content: data.toString("base64") };
            throw new Error("Resend attachments with 'path' not implemented in this snippet.");
          }
          if (a.content) {
            const base64 = Buffer.isBuffer(a.content)
              ? a.content.toString("base64")
              : Buffer.from(String(a.content)).toString("base64");
            return { filename: a.filename || "attachment", content: base64 };
          }
          return null;
        })
      ).then((list) => list.filter(Boolean));
    }

    const { error } = await resendClient.emails.send(payload);
    if (error) throw error;
    return { ok: true, via: "resend" };
  }

  // 2) SMTP path (generic or Yahoo)
  const transporter = getSmtpTransport();
  const info = await transporter.sendMail({
    from: from || buildFrom(),
    to,
    subject,
    text: message,
    html: html || (message ? `<p>${message}</p>` : undefined),
    attachments,
  });
  return { ok: true, via: "smtp", id: info?.messageId };
}

/**
 * Optional: call this at startup to verify configuration/connectivity.
 * Example:
 *   import { verifyMailer } from './utils/mailer.js';
 *   verifyMailer().catch(console.error);
 */
export async function verifyMailer() {
  if (resendClient) {
    // Basic token presence is enough; Resend has no 'verify' call.
    console.log("[mailer] Using Resend HTTP API.");
    return true;
  }
  const transporter = getSmtpTransport();
  console.log("[mailer] Verifying SMTP transport…");
  await transporter.verify(); // throws if cannot connect/login
  console.log("[mailer] SMTP transport verified.");
  return true;
}

export default sendEmail;
