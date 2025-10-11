// utils/mailer.js
import nodemailer from "nodemailer";
import { google } from "googleapis";
import dotenv from "dotenv";
dotenv.config();

const { EMAIL_USER, CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, REFRESH_TOKEN } = process.env;

(function requireEnv() {
  const missing = [];
  if (!EMAIL_USER) missing.push("EMAIL_USER");
  if (!CLIENT_ID) missing.push("CLIENT_ID");
  if (!CLIENT_SECRET) missing.push("CLIENT_SECRET");
  if (!REDIRECT_URI) missing.push("REDIRECT_URI");
  if (!REFRESH_TOKEN) missing.push("REFRESH_TOKEN");
  if (missing.length) {
    throw new Error(
      `Mailer OAuth2 env missing: ${missing.join(", ")}. Set these env vars in your host and restart.`
    );
  }
})();

const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

export const sendEmail = async ({ to, subject, message, html, attachments = [] }) => {
  if (!to || !subject || (!message && !html)) {
    throw new Error("sendEmail: missing to/subject/body");
  }

  const accessTokenResp = await oAuth2Client.getAccessToken();
  const accessToken =
    typeof accessTokenResp === "string" ? accessTokenResp : accessTokenResp?.token;

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      type: "OAuth2",
      user: EMAIL_USER,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      refreshToken: REFRESH_TOKEN,
      accessToken,
    },
  });

  const info = await transporter.sendMail({
    from: `"QR-Docs" <${EMAIL_USER}>`,
    to,
    subject,
    text: message,
    html: html || `<p>${message}</p>`,
    attachments,
  });

  return info; // optional: caller can log or inspect
};
