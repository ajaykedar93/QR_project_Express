// utils/mailer.js
import sgMail from "@sendgrid/mail";
import dotenv from "dotenv";
dotenv.config();

if (!process.env.SENDGRID_API_KEY) {
  console.error("❌ Missing SENDGRID_API_KEY in environment");
}
if (!process.env.EMAIL_FROM) {
  console.error("❌ Missing EMAIL_FROM in environment");
}

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

/**
 * sendMail helper
 * @param {{ to: string, subject: string, text?: string, html?: string }} opts
 */
export async function sendMail({ to, subject, text = "", html = "" }) {
  const msg = {
    to,
    from: process.env.EMAIL_FROM,
    subject,
    text,
    html,
  };

  try {
    const res = await sgMail.send(msg);
    // sgMail.send returns an array of responses for legacy reasons; return first
    return res;
  } catch (err) {
    // Helpful logging for debugging
    console.error("SENDGRID_SEND_ERROR:", err?.response?.body || err);
    throw err;
  }
}
