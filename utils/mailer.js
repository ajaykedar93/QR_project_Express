import sgMail from "@sendgrid/mail";

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

export async function sendMail({ to, subject, html, from }) {
  try {
    await sgMail.send({
      to,
      from: from || `"QR-Docs" <${process.env.EMAIL_USER}>`,
      subject,
      html,
    });
    return true;
  } catch (err) {
    console.error("SENDGRID_ERROR:", err?.response?.body || err.message);
    throw new Error("Failed to send email");
  }
}
