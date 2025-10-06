import nodemailer from "nodemailer";

export const mailer = nodemailer.createTransport({
  host: "live.smtp.mailtrap.io",
  port: 2525,
  auth: {
    user: process.env.MAILTRAP_USER,
    pass: process.env.MAILTRAP_PASS,
  },
});
