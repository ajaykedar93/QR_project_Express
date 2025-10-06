import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

export const mailer = nodemailer.createTransport({
  host: "live.smtp.mailtrap.io",
  port: 2525,
  auth: {
    user: process.env.MAILTRAP_USER,
    pass: process.env.MAILTRAP_PASS,
  },
});

// Verify SMTP connection
mailer.verify((err, success) => {
  if (err) console.error("❌ SMTP connection failed:", err);
  else console.log("✅ SMTP ready to send emails!");
});

// Generic send function
export const sendMail = async (to, subject, html, text) => {
  try {
    await mailer.sendMail({
      from: process.env.EMAIL_FROM,
      to,
      subject,
      html,
      text,
    });
    console.log(`✅ Email sent to ${to}`);
  } catch (err) {
    console.error("MAILER_ERROR:", err);
  }
};
