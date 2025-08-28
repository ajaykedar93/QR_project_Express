// routes/notify.routes.js
import { Router } from "express";
import path from "path";
import fs from "fs";
import { pool } from "../db/db.js";  // ✅
import { mailer } from "../utils/mailer.js";

const router = Router();

// Config (fallbacks for local dev)
const APP_ORIGIN = process.env.APP_ORIGIN || "http://localhost:5173"; // frontend
const API_BASE   = process.env.API_BASE   || "http://localhost:5000"; // backend

/**
 * POST /notify/share
 * body: { share_id }
 * Sends an email to shares.to_user_email with link + QR.
 * Works for both registered and not-registered recipients.
 */
router.post("/share", async (req, res) => {
  try {
    const { share_id } = req.body || {};
    if (!share_id) return res.status(400).json({ error: "Missing share_id" });

    // Load share + doc + author
    const q = `
      SELECT s.share_id, s.document_id, s.to_user_email, s.access, s.qr_code_path,
             d.file_name,
             u.email AS from_email
      FROM shares s
      JOIN documents d ON d.document_id = s.document_id
      JOIN users u ON u.user_id = s.from_user_id
      WHERE s.share_id = $1
      LIMIT 1`;
    const { rows } = await pool.query(q, [share_id]);
    const share = rows[0];
    if (!share) return res.status(404).json({ error: "Share not found" });
    if (!share.to_user_email) return res.status(400).json({ error: "No recipient email on this share" });

    // Is recipient registered?
    const reg = await pool.query(
      `SELECT user_id FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`,
      [share.to_user_email]
    );
    const isRegistered = !!reg.rowCount;

    const shareLink = `${APP_ORIGIN}/share/${share.share_id}`;
    const qrUrl = share.qr_code_path
      ? `${API_BASE}/${share.qr_code_path}`.replace(/(?<!:)\/\/+/g, "/")
      : null;

    // Email body logic
    const lines = [
      `Hi,`,
      ``,
      `${share.from_email} shared a document with you${share.file_name ? `: "${share.file_name}"` : ""}.`,
      `Access link: ${shareLink}`,
      `Access type: ${share.access.toUpperCase()}`,
      ``,
      share.access === "private"
        ? (isRegistered
           ? `Since this is PRIVATE: Log in with your registered email, then you'll receive an OTP to view/download.`
           : `This is PRIVATE: Please register first using this email, then log in and complete OTP to view/download.`)
        : `This is PUBLIC: Anyone with the link can view (download is disabled).`,
      ``,
      qrUrl ? `You can also scan the attached QR code (or open ${qrUrl}).` : ``,
      ``,
      `Thanks,`,
      `QR-Docs`,
    ].filter(Boolean);

    // Try attaching QR image if present on disk (best effort)
    let attachments = [];
    if (share.qr_code_path) {
      const abs = path.join(process.cwd(), share.qr_code_path);
      if (fs.existsSync(abs)) {
        attachments.push({ filename: "share-qr.png", path: abs });
      }
    }

    await mailer.sendMail({
      from: process.env.EMAIL_USER,
      to: share.to_user_email,
      subject: `Document shared with you${share.file_name ? ` — ${share.file_name}` : ""}`,
      text: lines.join("\n"),
      attachments,
    });

    res.json({ ok: true, sent_to: share.to_user_email, isRegistered });
  } catch (e) {
    console.error("NOTIFY_SHARE_ERROR:", e);
    res.status(500).json({ error: "Failed to send email" });
  }
});

export default router;
