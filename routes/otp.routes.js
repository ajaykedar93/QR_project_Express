// routes/otp.routes.js
import { Router } from "express";
import { v4 as uuid } from "uuid";
import dayjs from "dayjs";
import { pool } from "../db/db.js";

const router = Router();

function genOTP(len = 6) {
  return Array.from({ length: len }, () => Math.floor(Math.random() * 10)).join("");
}

/** POST /otp/send
 * body: { user_id, share_id }
 * (In production, send the code by email. Here we return info for testing.)
 */
router.post("/send", async (req, res) => {
  try {
    const { user_id, share_id } = req.body || {};
    if (!user_id || !share_id) return res.status(400).json({ error: "Missing fields" });

    // verify share exists & not expired
    const s = await pool.query(`SELECT access, expiry_time FROM shares WHERE share_id=$1`, [share_id]);
    if (!s.rowCount) return res.status(404).json({ error: "Share not found" });
    if (s.rows[0].expiry_time && dayjs(s.rows[0].expiry_time).isBefore(dayjs())) {
      return res.status(410).json({ error: "Share expired" });
    }

    const code = genOTP(6);
    const expiry = dayjs().add(10, "minute").toISOString();

    const ins = `
      INSERT INTO otp_verifications (otp_id, user_id, share_id, otp_code, expiry_time)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING otp_id, otp_code, expiry_time`;
    const { rows } = await pool.query(ins, [uuid(), user_id, share_id, code, expiry]);

    // TODO: send email with 'code' to the user's email.
    res.json({ message: "OTP generated (send via email in production)", data: rows[0] });
  } catch (e) {
    console.error("OTP_SEND_ERROR:", e);
    res.status(500).json({ error: "Failed to create OTP" });
  }
});

/** POST /otp/verify
 * body: { user_id, share_id, otp_code }
 */
router.post("/verify", async (req, res) => {
  try {
    const { user_id, share_id, otp_code } = req.body || {};
    if (!user_id || !share_id || !otp_code) return res.status(400).json({ error: "Missing fields" });

    const q = `
      SELECT * FROM otp_verifications
      WHERE user_id=$1 AND share_id=$2 AND otp_code=$3
      ORDER BY created_at DESC LIMIT 1`;
    const { rows } = await pool.query(q, [user_id, share_id, otp_code]);
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

export default router;
