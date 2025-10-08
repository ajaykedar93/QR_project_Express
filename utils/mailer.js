// utils/mailer.js
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

/**
 * Wrapper for sending emails with Resend
 * @param {object} options
 * @param {string} options.from
 * @param {string|string[]} options.to
 * @param {string} options.subject
 * @param {string} [options.text]
 * @param {string} [options.html]
 */
export async function sendMail({ from, to, subject, text, html }) {
  return await resend.emails.send({
    from,
    to,
    subject,
    text,
    html,
  });
}
