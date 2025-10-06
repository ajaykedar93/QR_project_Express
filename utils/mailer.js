// utils/mailer.js
import nodemailer from "nodemailer";
import { MailtrapTransport } from "mailtrap";
import dotenv from "dotenv";

dotenv.config();

export const mailer = nodemailer.createTransport(
  MailtrapTransport({
    token: process.env.MAILTRAP_TOKEN, // 619bfaed6c8fb4bf35412c8728898ba5
  })
);

// Example send function
export const sendMail = async (to, subject, text) => {
  try {
    await mailer.sendMail({
      from: { address: "hello@demomailtrap.co", name: "Placement Drive" },
      to,
      subject,
      text,
    });
    console.log("✅ Email sent successfully!");
  } catch (err) {
    console.error("❌ MAILER_ERROR:", err);
  }
};
