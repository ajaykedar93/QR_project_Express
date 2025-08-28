// routes/otp.routes.js
import { Router } from "express";
import { v4 as uuid } from "uuid";
import dayjs from "dayjs";
import { pool } from "../db/db.js";

const router = Router();

// OPTIONAL email transport; safe if not present
let mailer = null;
try {
  const m = await import("../utils/mailer.js");
  mailer = m.mailer;
} catch (_) {
  // mailer not configured; ignore
}

function genOTP(len = 6) {
  return Array.from({ length: len }, () => Math.floor(Math.random() * 10)).join("");
}

/**
 * POST /otp/send
 * Body:
 *   { share_id, email }             // ✅ preferred
 *   or { share_id, user_id }        // fallback (we will look up email)
 *
 * Behavior:
 *   - Only for PRIVATE shares.
 *   - If share has to_user_email set, only that email can request OTP.
 *   - Creates OTP valid for 10 minutes and (optionally) emails it.
 */
router.post("/send", async (req, res) => {
  try {
    let { share_id, email, user_id } = req.body || {};
    if (!share_id) return res.status(400).json({ error: "Missing share_id" });

    // Load share
    const s = await pool.query(
      `SELECT access, expiry_time, to_user_email
         FROM shares
        WHERE share_id = $1
        LIMIT 1`,
      [share_id]
    );
    if (!s.rowCount) return res.status(404).json({ error: "Share not found" });
    const share = s.rows[0];

    if (share.expiry_time && dayjs(share.expiry_time).isBefore(dayjs())) {
      return res.status(410).json({ error: "Share expired" });
    }
    if (share.access !== "private") {
      return res.status(400).json({ error: "OTP not required for public shares" });
    }

    // Resolve email if only user_id provided
    if (!email && user_id) {
      const u = await pool.query(`SELECT email FROM users WHERE user_id=$1 LIMIT 1`, [user_id]);
      if (u.rowCount) email = u.rows[0].email;
    }

    email = (email || "").trim();
    if (!email) return res.status(400).json({ error: "Email required" });

    // If share is targeted to a specific recipient email, enforce it (case-insensitive)
    if (share.to_user_email && share.to_user_email.toLowerCase() !== email.toLowerCase()) {
      return res
        .status(403)
        .json({ error: "This private share is restricted to a different recipient email" });
    }

    // Verify user exists if you want to restrict to registered users
    const u = await pool.query(`SELECT user_id FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`, [email]);
    const resolvedUserId = u.rowCount ? u.rows[0].user_id : null;

    // Generate OTP
    const otp_code = genOTP(6);
    const expiry_time = dayjs().add(10, "minute").toISOString();

    const ins = `
      INSERT INTO otp_verifications (otp_id, share_id, email, user_id, otp_code, expiry_time, is_verified)
      VALUES ($1,$2,$3,$4,$5,$6,FALSE)
      RETURNING otp_id, otp_code, expiry_time`;
    const { rows } = await pool.query(ins, [
      uuid(),
      share_id,
      email,
      resolvedUserId || user_id || null,
      otp_code,
      expiry_time,
    ]);
    const created = rows[0];

    // Try to email the code (non-blocking for dev)
    if (mailer) {
      try {
        await mailer.sendMail({
          to: email,
          from: process.env.EMAIL_USER || "no-reply@qr-docs",
          subject: "Your OTP code for QR-Docs",
          text: `Your OTP code is: ${otp_code}\nIt expires at: ${expiry_time}`,
        });
      } catch (mailErr) {
        console.warn("MAIL_SEND_WARN:", mailErr?.message || mailErr);
      }
    }

    res.json({
      message: "OTP created. Check your email.",
      data: { otp_id: created.otp_id, expiry_time: created.expiry_time },
      // For local testing only — DO NOT expose otp_code in production:
      // debug_otp: otp_code,
    });
  } catch (e) {
    console.error("OTP_SEND_ERROR:", e);
    res.status(500).json({ error: "Failed to create OTP" });
  }
});

/**
 * POST /otp/verify
 * Body:
 *   { share_id, email, otp_code }   // ✅ preferred
 *   or { share_id, user_id, otp_code } // fallback (we resolve email)
 *
 * Marks the latest matching record as verified if code is valid and not expired.
 */
router.post("/verify", async (req, res) => {
  try {
    let { share_id, email, user_id, otp_code } = req.body || {};
    if (!share_id || !otp_code) return res.status(400).json({ error: "Missing fields" });

    // Resolve email if user_id given
    if (!email && user_id) {
      const u = await pool.query(`SELECT email FROM users WHERE user_id=$1 LIMIT 1`, [user_id]);
      if (u.rowCount) email = u.rows[0].email;
    }
    email = (email || "").trim();
    if (!email) return res.status(400).json({ error: "Email required" });

    const q = `
      SELECT *
        FROM otp_verifications
       WHERE share_id=$1
         AND LOWER(email)=LOWER($2)
         AND otp_code=$3
       ORDER BY created_at DESC
       LIMIT 1`;
    const { rows } = await pool.query(q, [share_id, email, otp_code]);
    const rec = rows[0];

    if (!rec) return res.status(400).json({ error: "Invalid OTP" });
    if (dayjs(rec.expiry_time).isBefore(dayjs())) {
      return res.status(400).json({ error: "OTP expired" });
    }

    await pool.query(`UPDATE otp_verifications SET is_verified=TRUE WHERE otp_id=$1`, [rec.otp_id]);
    res.json({ success: true });
  } catch (e) {
    console.error("OTP_VERIFY_ERROR:", e);
    res.status(500).json({ error: "Failed to verify OTP" });
  }
});

/**
 * GET /otp/status?share_id=...&email=...
 * Returns { verified: boolean }
 * (Useful for client to know whether to show the viewer directly after a previous verification.)
 */
router.get("/status", async (req, res) => {
  try {
    const { share_id } = req.query;
    let { email } = req.query;
    if (!share_id) return res.status(400).json({ error: "Missing share_id" });

    email = (email || "").trim();
    if (!email) return res.status(400).json({ error: "Email required" });

    const v = await pool.query(
      `SELECT 1
         FROM otp_verifications
        WHERE share_id=$1
          AND LOWER(email)=LOWER($2)
          AND is_verified=TRUE
        ORDER BY created_at DESC
        LIMIT 1`,
      [share_id, email]
    );

    res.json({ verified: !!v.rowCount });
  } catch (e) {
    console.error("OTP_STATUS_ERROR:", e);
    res.status(500).json({ error: "Failed to check status" });
  }
});

export default router;
