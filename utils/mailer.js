import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

export const mailer = nodemailer.createTransport({
  host: "live.smtp.mailtrap.io",
  port: 587,
  auth: {
    user: process.env.MAILTRAP_USER, // e.g., apismtp@mailtrap.io
    pass: process.env.MAILTRAP_TOKEN, // your API token
  },
  secure: false, // use STARTTLS
  tls: {
    ciphers: "SSLv3",
  },
});

mailer.verify((err, success) => {
  if (err) console.error("❌ Mailtrap SMTP connection failed:", err);
  else console.log("✅ Mailtrap SMTP ready!");
});
