import nodemailer from "nodemailer";

export const mailer = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,           // TLS port
  secure: false,       // false for TLS
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS, 
  },
});
