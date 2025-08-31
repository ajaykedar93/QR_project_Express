// routes/shares.routes.js
import { Router } from "express";
import dayjs from "dayjs";
import { pool } from "../db/db.js";
import { auth } from "../middleware/auth.js";
import { mailer } from "../utils/mailer.js"; // <— add this



const router = Router();

const isFuture = (iso) => !!iso && dayjs(iso).isAfter(dayjs());

// -------------------------------
// CREATE SHARE
// POST /shares
// body: { document_id, to_email?, expiry_time? (ISO) }
// Rules:
// - If to_email exists in users -> PRIVATE (to_user_id set)
// - Else -> PUBLIC (to_user_email recorded)
// -------------------------------
router.post("/", auth, async (req, res) => {
  try {
    let { document_id, to_email = "", expiry_time = null } = req.body || {};
    document_id = String(document_id || "").trim();
    to_email = String(to_email || "").trim();

    if (!document_id) return res.status(400).json({ error: "document_id required" });

    // owner check
    const owns = await pool.query(
      `SELECT 1 FROM documents WHERE document_id=$1 AND owner_user_id=$2 LIMIT 1`,
      [document_id, req.user.user_id]
    );
    if (!owns.rowCount) return res.status(404).json({ error: "Document not found" });

    if (expiry_time && !isFuture(expiry_time)) {
      return res.status(400).json({ error: "expiry_time must be in the future" });
    }

    // find recipient (case-insensitive)
    let to_user_id = null;
    let access = "public";
    if (to_email) {
      const u = await pool.query(
        `SELECT user_id FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`,
        [to_email]
      );
      if (u.rowCount) {
        to_user_id = u.rows[0].user_id;
        access = "private";
      } else {
        access = "public";
      }
    }

    const ins = `
      INSERT INTO shares (document_id, from_user_id, to_user_id, to_user_email, access, expiry_time)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING share_id, share_token, access, expiry_time, created_at
    `;
    const { rows } = await pool.query(ins, [
      document_id,
      req.user.user_id,
      to_user_id,
      to_user_id ? null : (to_email || null),
      access,
      expiry_time || null,
    ]);

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("SHARE_CREATE_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// -------------------------------
// MINIMAL (QR landing)
// GET /shares/:share_id/minimal
// Public: returns {share_id, document_id, access, to_user_email}
// -------------------------------
router.get("/:share_id/minimal", async (req, res) => {
  try {
    const { share_id } = req.params;
    const q = `
      SELECT s.share_id, s.document_id, s.access, s.expiry_time, s.is_revoked, s.to_user_email
      FROM shares s
      WHERE s.share_id = $1
      LIMIT 1
    `;
    const { rows } = await pool.query(q, [share_id]);
    if (!rows.length) return res.status(404).json({ error: "Share not found" });
    const s = rows[0];

    if (s.is_revoked) return res.status(403).json({ error: "Share revoked" });
    if (s.expiry_time && new Date(s.expiry_time) <= new Date()) {
      return res.status(403).json({ error: "Share expired" });
    }

    res.json({
      share_id: s.share_id,
      document_id: s.document_id,
      access: s.access,
      to_user_email: s.to_user_email || null,
    });
  } catch (err) {
    console.error("SHARE_MINIMAL_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// -------------------------------
// MY SENT SHARES
// GET /shares/mine (auth)
// -------------------------------
router.get("/mine", auth, async (req, res) => {
  try {
    const q = `
      SELECT s.share_id, s.share_token, s.access, s.expiry_time, s.is_revoked, s.created_at,
             s.to_user_id, s.to_user_email,
             d.document_id, d.file_name, d.mime_type, d.file_size_bytes,
             ru.full_name AS to_full_name, ru.email AS to_email_resolved
      FROM shares s
      JOIN documents d ON d.document_id = s.document_id
      LEFT JOIN users ru ON ru.user_id = s.to_user_id
      WHERE s.from_user_id = $1
      ORDER BY s.created_at DESC
    `;
    const { rows } = await pool.query(q, [req.user.user_id]);
    res.json(rows);
  } catch (err) {
    console.error("SHARES_MINE_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// -------------------------------
// RECEIVED SHARES (active)
// GET /shares/received (auth)
// -------------------------------
router.get("/received", auth, async (req, res) => {
  try {
    const q = `
      SELECT s.share_id, s.share_token, s.access, s.expiry_time, s.created_at AS shared_at,
             d.document_id, d.file_name, d.mime_type, d.file_size_bytes, d.created_at AS uploaded_at,
             u.full_name AS from_full_name, u.email AS from_email
      FROM shares s
      JOIN documents d ON d.document_id = s.document_id
      JOIN users u ON u.user_id = s.from_user_id
      WHERE s.is_revoked = FALSE
        AND (s.expiry_time IS NULL OR s.expiry_time > now())
        AND (s.to_user_id = $1 OR (s.to_user_id IS NULL AND LOWER(s.to_user_email) = LOWER($2)))
      ORDER BY s.created_at DESC
    `;
    const { rows } = await pool.query(q, [req.user.user_id, req.user.email]);
    res.json(rows);
  } catch (err) {
    console.error("SHARES_RECEIVED_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// -------------------------------
// SHARE DETAILS (owner-only)
// GET /shares/:share_id (auth)
// -------------------------------
router.get("/:share_id", auth, async (req, res) => {
  try {
    const { share_id } = req.params;
    const q = `
      SELECT s.*, d.file_name, d.mime_type, d.file_size_bytes
      FROM shares s
      JOIN documents d ON d.document_id = s.document_id
      WHERE s.share_id = $1 AND s.from_user_id = $2
      LIMIT 1
    `;
    const { rows } = await pool.query(q, [share_id, req.user.user_id]);
    if (!rows.length) return res.status(404).json({ error: "Share not found" });

    const sh = rows[0];
    res.json({
      share_id: sh.share_id,
      share_token: sh.share_token,
      access: sh.access,
      is_revoked: sh.is_revoked,
      revoked_at: sh.revoked_at,
      expiry_time: sh.expiry_time,
      created_at: sh.created_at,
      to_user_id: sh.to_user_id,
      to_user_email: sh.to_user_email,
      document: {
        document_id: sh.document_id,
        file_name: sh.file_name,
        mime_type: sh.mime_type,
        file_size_bytes: sh.file_size_bytes,
      },
    });
  } catch (err) {
    console.error("SHARE_GET_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// -------------------------------
// REVOKE SHARE (owner)
// POST /shares/:share_id/revoke (auth)
// -------------------------------
router.post("/:share_id/revoke", auth, async (req, res) => {
  try {
    const { share_id } = req.params;
    const upd = await pool.query(
      `
        UPDATE shares
           SET is_revoked = TRUE, revoked_at = now()
         WHERE share_id = $1
           AND from_user_id = $2
         RETURNING share_id, is_revoked, revoked_at
      `,
      [share_id, req.user.user_id]
    );
    if (!upd.rowCount) return res.status(404).json({ error: "Share not found" });
    res.json(upd.rows[0]);
  } catch (err) {
    console.error("SHARE_REVOKE_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// -------------------------------
// OTP SEND  (private shares)
// POST /shares/:share_id/otp/send
// body: { email }
// -------------------------------
router.post("/:share_id/otp/send", async (req, res) => {
  try {
    const { share_id } = req.params;
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: "Email required" });

    const sres = await pool.query(`SELECT * FROM shares WHERE share_id=$1 LIMIT 1`, [share_id]);
    if (!sres.rowCount) return res.status(404).json({ error: "Share not found" });
    const sh = sres.rows[0];

    if (sh.is_revoked) return res.status(403).json({ error: "Share revoked" });
    if (sh.access !== "private") return res.status(400).json({ error: "OTP not required for public" });
    if (sh.expiry_time && dayjs(sh.expiry_time).isBefore(dayjs())) {
      return res.status(403).json({ error: "Share expired" });
    }

    const ures = await pool.query(
      `SELECT user_id, email FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`,
      [email]
    );
    if (!ures.rowCount) return res.status(400).json({ error: "User must register first" });
    const user = ures.rows[0];

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

    // TODO: send via mail provider; log for dev
    console.log(`OTP for ${email} / share ${share_id}: ${otp} (expires ${expiry})`);

    res.json({ success: true, otp_id: rows[0].otp_id, expires_at: rows[0].expiry_time });
  } catch (err) {
    console.error("OTP_SEND_ERROR:", err);
    res.status(400).json({ error: err.message || "Cannot send OTP" });
  }
});

// -------------------------------
// OTP VERIFY (private shares)
// POST /shares/:share_id/otp/verify
// body: { email, otp }
// -------------------------------
router.post("/:share_id/otp/verify", async (req, res) => {
  try {
    const { share_id } = req.params;
    const { email, otp } = req.body || {};
    if (!email || !otp) return res.status(400).json({ error: "Email and OTP required" });

    const u = await pool.query(
      `SELECT user_id FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`,
      [email]
    );
    if (!u.rowCount) return res.status(400).json({ error: "User must register first" });
    const userId = u.rows[0].user_id;

    const f = await pool.query(
      `
        SELECT otp_id
        FROM otp_verifications
        WHERE share_id = $1
          AND user_id = $2
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

    // optional: access log
    await pool.query(
      `
        INSERT INTO access_logs (share_id, document_id, viewer_user_id, action)
        SELECT s.share_id, s.document_id, $2, 'otp_verify'
        FROM shares s
        WHERE s.share_id = $1
      `,
      [share_id, userId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("OTP_VERIFY_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
