// utils/mailer.js
import nodemailer from "nodemailer";

export const mailer = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER, // e.g. ajaykedar3790@gmail.com
    pass: process.env.EMAIL_PASS, // Gmail App Password
  },
});
