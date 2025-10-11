// routes/mail.test.js (or add to any router file already using sendEmail)
import { Router } from "express";
import { sendEmail } from "../utils/mailer.js";

const router = Router();

// Health: verify env + access token creation
router.get("/mail/health", async (req, res) => {
  try {
    // minimal sanity checks (don’t expose secrets)
    const required = ["EMAIL_USER","CLIENT_ID","CLIENT_SECRET","REDIRECT_URI","REFRESH_TOKEN"];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length) return res.status(400).json({ ok:false, error:`Missing env: ${missing.join(", ")}` });

    // try a dry send to avoid spam (no sendMail)
    return res.json({ ok:true, message:"Env looks good. Ready to send." });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e.message });
  }
});

// Live send test
router.get("/mail/test", async (req, res) => {
  try {
    await sendEmail({
      to: process.env.EMAIL_USER, // send to yourself
      subject: "✅ QR-Docs OAuth2 test",
      html: "<p>Mailer is working via Gmail OAuth2.</p>",
    });
    res.json({ ok:true, sentTo: process.env.EMAIL_USER });
  } catch (e) {
    console.error("MAIL_TEST_ERROR:", e);
    res.status(500).json({ ok:false, error:e.message });
  }
});

router.post("/mail/send", async (req, res) => {
  try {
    const { to, subject = "📩 QR-Docs Test Mail", message = "This is a test email." } = req.body || {};

    if (!to) {
      return res.status(400).json({ ok: false, error: "Recipient email 'to' is required" });
    }

    await sendEmail({
      to,
      subject,
      html: `<p>${message}</p><p>✅ Mail sent successfully from QR-Docs mailer.</p>`,
    });

    res.json({ ok: true, sentTo: to });
  } catch (err) {
    console.error("MAIL_SEND_ERROR:", err);
    res.status(500).json({ ok: false, error: err.message || "Failed to send email" });
  }
});

export default router;
