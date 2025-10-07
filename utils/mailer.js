import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config(); // Load .env variables

export const mailer = nodemailer.createTransport({
  service: "SendGrid",
  auth: {
    user: "apikey", // <-- this must literally be the word "apikey"
    pass: process.env.SENDGRID_API_KEY, // <-- your SendGrid API key from .env
  },
});
