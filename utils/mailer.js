// utils/mailer.js
import nodemailer from "nodemailer";
import dotenv from "dotenv";
dotenv.config();

const { EMAIL_USER, EMAIL_PASS, EMAIL_FROM_NAME = "QR-Docs" } = process.env;

const transporter = nodemailer.createTransport({
  host: "smtp.mail.yahoo.com",
  port: 587,
  secure: false,            // STARTTLS
  requireTLS: true,
  family: 4,                // force IPv4 (avoid IPv6 timeouts)
  auth: { user: EMAIL_USER, pass: EMAIL_PASS }, // Yahoo App Password
  connectionTimeout: 60000,
  greetingTimeout: 30000,
  socketTimeout: 90000,
  tls: { minVersion: "TLSv1.2", servername: "smtp.mail.yahoo.com" },
  // logger/debug help when diagnosing:
  logger: true,
  debug: true,
});

export async function verifyMailer() {
  await transporter.verify(); // throws ETIMEDOUT if egress blocked
}

export async function sendEmail({ to, subject, html, message, attachments = [] }) {
  if (!to || !subject || (!html && !message)) throw new Error("sendEmail: missing to/subject/body");
  return transporter.sendMail({
    from: `${EMAIL_FROM_NAME} <${EMAIL_USER}>`, // must match Yahoo account
    to,
    subject,
    html: html || `<p>${message}</p>`,
    text: message,
    attachments,
  });
}
export default sendEmail;
