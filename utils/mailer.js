// utils/mailer.js
import nodemailer from "nodemailer";
import dotenv from "dotenv";
dotenv.config();

const { EMAIL_USER, EMAIL_PASS, EMAIL_FROM_NAME } = process.env;

// Minimal env checks
(function requireEnv() {
  const missing = [];
  if (!EMAIL_USER) missing.push("EMAIL_USER");            // e.g. ajaykedar9370@yahoo.com
  if (!EMAIL_PASS) missing.push("EMAIL_PASS");            // Yahoo App Password
  if (missing.length) {
    throw new Error(
      `Mailer env missing: ${missing.join(", ")}. Set them in your environment and restart.`
    );
  }
})();

// Yahoo SMTP (SSL 465)
const transporter = nodemailer.createTransport({
  host: "smtp.mail.yahoo.com",
  port: 465,
  secure: true,
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS, // App Password
  },
  pool: true,
  maxConnections: 3,
  maxMessages: 50,
  connectionTimeout: 15_000,
  socketTimeout: 20_000,
});

/**
 * Send an email
 * @param {Object} param0
 * @param {string} param0.to
 * @param {string} param0.subject
 * @param {string} [param0.message] - plain text
 * @param {string} [param0.html]    - HTML body (preferred)
 * @param {Array}  [param0.attachments]
 */
export const sendEmail = async ({ to, subject, message, html, attachments = [] }) => {
  if (!to || !subject || (!message && !html)) {
    throw new Error("sendEmail: missing to/subject/body");
  }

  const info = await transporter.sendMail({
    from: `${EMAIL_FROM_NAME || "QR-Docs"} <${EMAIL_USER}>`,
    to,
    subject,
    text: message,
    html: html || (message ? `<p>${message}</p>` : undefined),
    attachments,
  });

  return info;
};

export default sendEmail;
