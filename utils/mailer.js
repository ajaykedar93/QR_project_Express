import nodemailer from "nodemailer";
import { google } from "googleapis";

const oAuth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI // e.g. https://developers.google.com/oauthplayground
);
oAuth2Client.setCredentials({ refresh_token: process.env.REFRESH_TOKEN });

export async function sendEmail({ to, subject, html }) {
  const accessToken = await oAuth2Client.getAccessToken(); // auto refresh
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      type: "OAuth2",
      user: process.env.EMAIL_USER,     // your Gmail address
      clientId: process.env.CLIENT_ID,
      clientSecret: process.env.CLIENT_SECRET,
      refreshToken: process.env.REFRESH_TOKEN,
      accessToken: accessToken?.token,  // optional; Nodemailer can fetch too
    },
    connectionTimeout: 15000,
    socketTimeout: 20000,
  });

  return transporter.sendMail({
    from: `QR-Docs <${process.env.EMAIL_USER}>`,
    to,
    subject,
    html,
  });
}
