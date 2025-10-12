// utils/mailer.js
import nodemailer from "nodemailer";
import dotenv from "dotenv";
dotenv.config();

const {
  EMAIL_USER,        // e.g. "ajaykedar9370@yahoo.com"
  EMAIL_PASS,        // Yahoo **App Password** (16 chars)
  EMAIL_FROM_NAME,   // e.g. "QR-Docs"
  SMTP_HOST,         // optional override
  SMTP_DEBUG,        // "1" to enable nodemailer debug logs
} = process.env;

(function requireEnv() {
  const missing = [];
  if (!EMAIL_USER) missing.push("EMAIL_USER");
  if (!EMAIL_PASS) missing.push("EMAIL_PASS");
  if (missing.length) {
    throw new Error(`Mailer env missing: ${missing.join(", ")}.`);
  }
})();

const HOST = SMTP_HOST || "smtp.mail.yahoo.com";

// Primary: SMTPS 465 (implicit TLS)
const primaryTransport = nodemailer.createTransport({
  host: HOST,
  port: 465,
  secure: true,
  auth: { user: EMAIL_USER, pass: EMAIL_PASS },
  // Pooling off: Yahoo + serverless often happier without it
  pool: false,
  connectionTimeout: 45_000,  // open socket timeout
  greetingTimeout: 30_000,    // wait for 220 greeting
  socketTimeout: 60_000,      // inactivity after connect
  tls: {
    // Some providers need SNI
    servername: HOST,
    // keep strict; only loosen if you KNOW you need to:
    // rejectUnauthorized: false,
  },
  logger: !!SMTP_DEBUG,
  debug: !!SMTP_DEBUG,
});

// Fallback: 587 STARTTLS
const fallbackTransport = nodemailer.createTransport({
  host: HOST,
  port: 587,
  secure: false,               // STARTTLS on 587
  auth: { user: EMAIL_USER, pass: EMAIL_PASS },
  requireTLS: true,            // enforce STARTTLS upgrade
  pool: false,
  connectionTimeout: 45_000,
  greetingTimeout: 30_000,
  socketTimeout: 60_000,
  tls: {
    servername: HOST,
    // rejectUnauthorized: false,
  },
  logger: !!SMTP_DEBUG,
  debug: !!SMTP_DEBUG,
});

// Optionally verify on boot (non-fatal if it fails; some hosts block during cold start)
(async () => {
  try {
    await primaryTransport.verify();
    console.log("[mailer] Yahoo SMTP 465 verified.");
  } catch (e) {
    console.warn("[mailer] 465 verify failed:", e?.code || e?.message || e);
    try {
      await fallbackTransport.verify();
      console.log("[mailer] Yahoo SMTP 587 verified (fallback).");
    } catch (e2) {
      console.warn("[mailer] 587 verify failed:", e2?.code || e2?.message || e2);
      console.warn("[mailer] Emails may fail until outbound SMTP is reachable from the host.");
    }
  }
})();

/**
 * Send an email with automatic 587 fallback on ETIMEDOUT/ECONNECTION
 * @param {Object} opts
 * @param {string} opts.to
 * @param {string} opts.subject
 * @param {string} [opts.message] - plain text
 * @param {string} [opts.html]    - HTML
 * @param {Array}  [opts.attachments]
 */
export const sendEmail = async ({ to, subject, message, html, attachments = [] }) => {
  if (!to || !subject || (!message && !html)) {
    throw new Error("sendEmail: missing to/subject/body");
  }

  const mail = {
    from: `${EMAIL_FROM_NAME || "QR-Docs"} <${EMAIL_USER}>`, // Yahoo requires matching From
    to,
    subject,
    text: message,
    html: html || (message ? `<p>${message}</p>` : undefined),
    attachments,
  };

  try {
    // Try 465 first
    return await primaryTransport.sendMail(mail);
  } catch (err) {
    const code = (err && (err.code || err.responseCode)) || "";
    const msg = String(err?.message || "").toLowerCase();

    const isConnIssue =
      code === "ETIMEDOUT" ||
      code === "ECONNECTION" ||
      msg.includes("timed out") ||
      msg.includes("connection closed") ||
      msg.includes("failed to connect");

    // If connection issue, retry with 587 STARTTLS
    if (isConnIssue) {
      console.warn("[mailer] 465 send failed, retrying on 587…", code || err);
      return await fallbackTransport.sendMail(mail);
    }
    // Not a connection issue — rethrow (likely EAUTH/EBADRESP/etc.)
    throw err;
  }
};

export default sendEmail;
