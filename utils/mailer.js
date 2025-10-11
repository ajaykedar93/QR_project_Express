// ✅ utils/mailer.js
import dotenv from "dotenv";
import nodemailer from "nodemailer";

dotenv.config();

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

export const sendEmail = async ({ to, subject, message, html, attachments = [] }) => {
  if (!to || !subject || (!message && !html)) throw new Error("Missing fields");

  await transporter.sendMail({
    from: `"QR-Docs" <${process.env.EMAIL_USER}>`,
    to,
    subject,
    text: message,
    html: html || `<p>${message}</p>`,
    attachments,
  });

  console.log(`✅ Email sent to ${to}`);
};
