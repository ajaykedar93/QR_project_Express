import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

// Create SMTP transporter
export const mailer = nodemailer.createTransport({
  host: "live.smtp.mailtrap.io", // Mailtrap Live SMTP
  port: 2525,                     // Render-friendly port
  auth: {
    user: process.env.MAILTRAP_USER,
    pass: process.env.MAILTRAP_PASS,
  },
});

// Verify connection
mailer.verify((err, success) => {
  if (err) console.error("❌ Mailtrap SMTP connection failed:", err);
  else console.log("✅ Mailtrap SMTP ready to send emails!");
});

// Generic send function
export const sendMail = async (to, subject, html, text) => {
  try {
    await mailer.sendMail({
      from: `"${process.env.APP_NAME}" <${process.env.APP_EMAIL}>`,
      to,
      subject,
      text,
      html,
    });
    console.log(`✅ Email sent to ${to}`);
  } catch (err) {
    console.error("❌ MAILER_ERROR:", err);
  }
};
