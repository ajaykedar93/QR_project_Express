import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

export const mailer = nodemailer.createTransport({
  host: "smtp.mailtrap.io", // Use 2525 for testing or 587 for live
  port: 2525,
  auth: {
    user: process.env.MAILTRAP_USER,
    pass: process.env.MAILTRAP_PASS,
  },
});

// Verify connection
mailer.verify((err, success) => {
  if (err) console.error("❌ Mailtrap connection failed:", err);
  else console.log("✅ Mailtrap ready to send emails!");
});
