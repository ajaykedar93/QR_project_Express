import { google } from "googleapis";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
dotenv.config();

// Gmail OAuth2 setup
const oAuth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);
oAuth2Client.setCredentials({ refresh_token: process.env.REFRESH_TOKEN });

/**
 * Send email via Gmail API (HTTP, OAuth2)
 * @param {string} to - Recipient email
 * @param {string} subject - Mail subject
 * @param {string} html - HTML body content
 */
export async function sendEmail({ to, subject, html }) {
  try {
    const accessToken = await oAuth2Client.getAccessToken();

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        type: "OAuth2",
        user: process.env.SENDER_EMAIL,
        clientId: process.env.CLIENT_ID,
        clientSecret: process.env.CLIENT_SECRET,
        refreshToken: process.env.REFRESH_TOKEN,
        accessToken: accessToken.token,
      },
    });

    const mailOptions = {
      from: `Placement App <${process.env.SENDER_EMAIL}>`,
      to,
      subject,
      html,
    };

    const result = await transporter.sendMail(mailOptions);
    return result;
  } catch (err) {
    console.error("MAIL_ERROR:", err.message);
    throw new Error("Failed to send email");
  }
}
