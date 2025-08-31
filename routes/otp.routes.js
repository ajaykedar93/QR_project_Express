// routes/otp.routes.js
import { Router } from "express";
import dayjs from "dayjs";
import { pool } from "../db/db.js";
import { auth } from "../middleware/auth.js";
import { mailer } from "../utils/mailer.js";

const router = Router();

// Frontend base (where users land to open a share)
const APP_URL = "http://localhost:5173";

/** Build the frontend link that the recipient will open */
function buildShareUrl(shareToken, documentId) {
  // If your frontend route is /share/:shareId use that instead.
  // This version uses token+doc via query for flexibility:
  return `${APP_URL.replace(/\/$/, "")}/view?token=${encodeURIComponent(
    shareToken
  )}&doc=${encodeURIComponent(documentId)}`;
}

/* ============================================================
   1) NOTIFY RECIPIENT AFTER SHARE
   POST /otp/notify-share
   body: { share_id }
   Auth: owner of the share
   Sends an email to recipient with the open link.
   ============================================================ */
router.post("/notify-share", auth, async (req, res) => {
  try {
    const { share_id } = req.body || {};
    if (!share_id) return res.status(400).json({ error: "share_id required" });

    // Load share + document + sender + (optional) recipient user
    const q = `
      SELECT s.share_id, s.share_token, s.access, s.expiry_time, s.is_revoked,
             s.to_user_id, s.to_user_email, s.from_user_id, s.document_id,
             d.file_name, d.mime_type, d.file_size_bytes,
             uf.full_name AS from_full_name, uf.email AS from_email,
             ur.email     AS to_email_resolved
        FROM shares s
        JOIN documents d ON d.document_id = s.document_id
        JOIN users uf     ON uf.user_id   = s.from_user_id
   LEFT JOIN users ur     ON ur.user_id   = s.to_user_id
       WHERE s.share_id = $1
       LIMIT 1`;
    const { rows } = await pool.query(q, [share_id]);
    if (!rows.length) return res.status(404).json({ error: "Share not found" });

    const sh = rows[0];

    // Only the creator may notify
    if (String(sh.from_user_id) !== String(req.user.user_id)) {
      return res.status(403).json({ error: "Not allowed" });
    }
    if (sh.is_revoked) return res.status(403).json({ error: "Share revoked" });
    if (sh.expiry_time && dayjs(sh.expiry_time).isBefore(dayjs())) {
      return res.status(403).json({ error: "Share expired" });
    }

    const recipient = sh.to_email_resolved || sh.to_user_email;
    if (!recipient) return res.status(400).json({ error: "No recipient email" });

    const url = buildShareUrl(sh.share_token, sh.document_id);

    await mailer.sendMail({
      from: `"DocShare" <${process.env.EMAIL_USER}>`,
      to: recipient,
      subject:
        sh.access === "private"
          ? "A private document was shared with you"
          : "A public document was shared with you",
      html: `
        <p><b>${sh.from_full_name}</b> (${sh.from_email}) shared a document with you.</p>
        <p><b>File:</b> ${sh.file_name} (${sh.mime_type || "file"})</p>
        <p><b>Size:</b> ${Number(sh.file_size_bytes || 0).toLocaleString()} bytes</p>
        ${
          sh.expiry_time
            ? `<p><b>Expires:</b> ${new Date(sh.expiry_time).toLocaleString()}</p>`
            : ""
        }
        <p>Open link: <a href="${url}">${url}</a></p>
        <p>${
          sh.access === "private"
            ? "Since this is <b>PRIVATE</b>, you'll be asked to verify your email with an OTP."
            : "This document is <b>PUBLIC (view-only)</b>."
        }</p>
      `,
    });

    return res.json({ success: true, notified: recipient, url });
  } catch (err) {
    console.error("NOTIFY_SHARE_ERROR:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
