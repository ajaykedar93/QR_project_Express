// routes/otp.routes.js
import { Router } from "express";
import dayjs from "dayjs";
import { pool } from "../db/db.js";
import { auth } from "../middleware/auth.js";
import { mailer } from "../utils/mailer.js";

const router = Router();

const APP_URL = process.env.PUBLIC_APP_URL || "https://your-app.example";
const shareUrl = (token, docId) =>
  `${APP_URL}/view?token=${encodeURIComponent(token)}&doc=${encodeURIComponent(docId)}`;

/* ============================================================
   1) NOTIFY RECIPIENT AFTER SHARE
   POST /otp/notify-share
   body: { share_id }
   ============================================================ */
router.post("/notify-share", auth, async (req, res) => {
  try {
    const { share_id } = req.body || {};
    if (!share_id) return res.status(400).json({ error: "share_id required" });

    const q = `
      SELECT s.share_id, s.share_token, s.access, s.expiry_time, s.is_revoked,
             s.to_user_id, s.to_user_email, s.from_user_id, s.document_id,
             d.file_name, d.mime_type, d.file_size_bytes,
             uf.full_name AS from_full_name, uf.email AS from_email,
             ur.email AS to_email_resolved
      FROM shares s
      JOIN documents d ON d.document_id = s.document_id
      JOIN users uf ON uf.user_id = s.from_user_id
      LEFT JOIN users ur ON ur.user_id = s.to_user_id
      WHERE s.share_id = $1
      LIMIT 1
    `;
    const { rows } = await pool.query(q, [share_id]);
    if (!rows.length) return res.status(404).json({ error: "Share not found" });

    const sh = rows[0];
    if (String(sh.from_user_id) !== String(req.user.user_id)) {
      return res.status(403).json({ error: "Not allowed" });
    }
    if (sh.is_revoked) return res.status(403).json({ error: "Share revoked" });
    if (sh.expiry_time && dayjs(sh.expiry_time).isBefore(dayjs())) {
      return res.status(403).json({ error: "Share expired" });
    }

    const recipient = sh.to_email_resolved || sh.to_user_email;
    if (!recipient) return res.status(400).json({ error: "No recipient email" });

    const url = shareUrl(sh.share_token, sh.document_id);

    await mailer.sendMail({
      from: `"DocShare App" <${process.env.EMAIL_USER}>`,
      to: recipient,
      subject:
        sh.access === "private"
          ? "A private document was shared with you"
          : "A public document was shared with you",
      html: `
        <p><b>${sh.from_full_name}</b> (${sh.from_email}) shared a document with you.</p>
        <p><b>File:</b> ${sh.file_name} (${sh.mime_type || "file"})</p>
        <p><b>Size:</b> ${sh.file_size_bytes || 0} bytes</p>
        ${
          sh.expiry_time
            ? `<p><b>Expires:</b> ${new Date(sh.expiry_time).toLocaleString()}</p>`
            : ""
        }
        <p>Open this link (or scan the QR code):</p>
        <p><a href="${url}">${url}</a></p>
        <p>${
          sh.access === "private"
            ? "You will be asked to verify your email via OTP after opening the link."
            : "This document is public view-only."
        }</p>
      `,
    });

    res.json({ success: true, notified: recipient, url });
  } catch (err) {
    console.error("NOTIFY_SHARE_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ============================================================
   2) SEND OTP AFTER QR SCAN (PRIVATE)
   POST /otp/send
   body: { share_id, email }
   ============================================================ */
router.post("/send", async (req, res) => {
  try {
    const { share_id, email } = req.body || {};
    if (!share_id || !email) {
      return res.status(400).json({ error: "share_id and email are required" });
    }

    const s = await pool.query(`SELECT * FROM shares WHERE share_id=$1 LIMIT 1`, [share_id]);
    if (!s.rowCount) return res.status(404).json({ error: "Share not found" });
    const sh = s.rows[0];

    if (sh.is_revoked) return res.status(403).json({ error: "Share revoked" });
    if (sh.access !== "private") return res.status(400).json({ error: "OTP not required" });
    if (sh.expiry_time && dayjs(sh.expiry_time).isBefore(dayjs())) {
      return res.status(403).json({ error: "Share expired" });
    }

    const u = await pool.query(`SELECT user_id, email FROM users WHERE email=$1 LIMIT 1`, [email]);
    if (!u.rowCount) return res.status(400).json({ error: "User must register first" });
    const user = u.rows[0];

    if (sh.to_user_id && String(sh.to_user_id) !== String(user.user_id)) {
      return res.status(403).json({ error: "Not the intended recipient" });
    }
    if (!sh.to_user_id && sh.to_user_email) {
      if (String(sh.to_user_email).toLowerCase() !== String(user.email).toLowerCase()) {
        return res.status(403).json({ error: "Not the intended recipient" });
      }
    }

    const otp = (Math.floor(100000 + Math.random() * 900000)).toString();
    const ttlMins = Number(process.env.OTP_TTL_MIN || 10);
    const expiry = dayjs().add(ttlMins, "minute").toISOString();

    const ins = `
      INSERT INTO otp_verifications (user_id, share_id, otp_code, expiry_time)
      VALUES ($1, $2, $3, $4)
      RETURNING otp_id, expiry_time
    `;
    const { rows } = await pool.query(ins, [user.user_id, share_id, otp, expiry]);

    await mailer.sendMail({
      from: `"DocShare App" <${process.env.EMAIL_USER}>`,
      to: user.email,
      subject: "Your OTP for document access",
      html: `<p>Your OTP is <b>${otp}</b></p>
             <p>This code expires at ${new Date(expiry).toLocaleString()}.</p>`,
    });

    await pool.query(
      `INSERT INTO access_logs (share_id, document_id, viewer_user_id, action)
       SELECT s.share_id, s.document_id, $2, 'otp_request'
       FROM shares s
       WHERE s.share_id = $1`,
      [share_id, user.user_id]
    );

    res.json({ success: true, otp_id: rows[0].otp_id, expires_at: rows[0].expiry_time });
  } catch (err) {
    console.error("OTP_SEND_ERROR:", err);
    res.status(400).json({ error: err.message || "Cannot send OTP" });
  }
});

/* ============================================================
   3) VERIFY OTP
   POST /otp/verify
   body: { share_id, email, otp }
   ============================================================ */
router.post("/verify", async (req, res) => {
  try {
    const { share_id, email, otp } = req.body || {};
    if (!share_id || !email || !otp) {
      return res.status(400).json({ error: "share_id, email, and otp are required" });
    }

    const u = await pool.query(`SELECT user_id FROM users WHERE email=$1 LIMIT 1`, [email]);
    if (!u.rowCount) return res.status(400).json({ error: "User must register first" });
    const userId = u.rows[0].user_id;

    const f = await pool.query(
      `
        SELECT otp_id
        FROM otp_verifications
        WHERE share_id = $1
          AND user_id  = $2
          AND is_verified = FALSE
          AND expiry_time > now()
          AND otp_code = $3
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [share_id, userId, String(otp)]
    );
    if (!f.rowCount) return res.status(400).json({ error: "Invalid or expired OTP" });

    await pool.query(`UPDATE otp_verifications SET is_verified = TRUE WHERE otp_id=$1`, [
      f.rows[0].otp_id,
    ]);

    await pool.query(
      `INSERT INTO access_logs (share_id, document_id, viewer_user_id, action)
       SELECT s.share_id, s.document_id, $2, 'otp_verify'
       FROM shares s
       WHERE s.share_id = $1`,
      [share_id, userId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("OTP_VERIFY_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
