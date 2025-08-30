// utils/mailer.js
import nodemailer from "nodemailer";

export const mailer = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER, // e.g. your Gmail
    pass: process.env.EMAIL_PASS, // Gmail App Password
  },
});
