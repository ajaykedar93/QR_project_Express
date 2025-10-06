// utils/mailer.js
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config(); // Load .env variables

// ✅ Create Mailtrap transporter
export const mailer = nodemailer.createTransport({
  host: "live.smtp.mailtrap.io",
  port: 587,
  auth: {
    user: process.env.MAILTRAP_USER,
    pass: process.env.MAILTRAP_TOKEN,
  },
});

// ✅ Optional: Verify connection at startup
mailer.verify((error, success) => {
  if (error) {
    console.error("❌ Mailtrap connection failed:", error);
  } else {
    console.log("✅ Mailtrap ready to send emails!");
  }
});
