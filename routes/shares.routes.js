// routes/shares.routes.js
import { Router } from "express";
import dayjs from "dayjs";
import { pool } from "../db/db.js";
import { auth } from "../middleware/auth.js";
import nodemailer from "nodemailer";
import "dotenv/config";

const router = Router();

const APP_URL = "https://qr-project-react.vercel.app/";

function buildShareUrl(shareId) {
  return `${APP_URL.replace(/\/$/, "")}/share/${encodeURIComponent(shareId)}`;
}
const isFuture = (iso) => !!iso && dayjs(iso).isAfter(dayjs());

// ---- Gmail transporter (replaces utils/mailer.js) ----
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

router.post("/", auth, async (req, res) => {
  try {
    let {
      document_id,
      to_email = "",
      expiry_time = null,
      access = null,
    } = req.body || {};

    document_id = String(document_id || "").trim();
    to_email = String(to_email || "").trim();
    access = access ? String(access).toLowerCase() : null;

    if (!document_id) return res.status(400).json({ error: "document_id required" });

    const owns = await pool.query(
      `SELECT 1 FROM documents WHERE document_id=$1 AND owner_user_id=$2 LIMIT 1`,
      [document_id, req.user.user_id]
    );
    if (!owns.rowCount) return res.status(404).json({ error: "Document not found" });

    if (expiry_time && !isFuture(expiry_time)) {
      return res.status(400).json({ error: "expiry_time must be in the future" });
    }

    let to_user_id = null;
    if (to_email) {
      const u = await pool.query(
        `SELECT user_id FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`,
        [to_email]
      );
      if (u.rowCount) to_user_id = u.rows[0].user_id;
    }

    let finalAccess;
    if (access === "private") {
      if (!to_email) {
        return res.status(400).json({ error: "Private share requires recipient email" });
      }
      if (!to_user_id) {
        return res.status(400).json({ error: "Recipient email must be registered for private shares" });
      }
      finalAccess = "private";
    } else if (access === "public") {
      finalAccess = "public";
    } else {
      finalAccess = to_user_id ? "private" : "public";
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
      finalAccess,
      expiry_time || null,
    ]);

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("SHARE_CREATE_ERROR:", err);
    return res.status(400).json({ error: err?.message || "Cannot create share" });
  }
});

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

router.get("/received", auth, async (req, res) => {
  try {
    const q = `
      SELECT s.share_id, s.share_token, s.access, s.expiry_time, s.created_at AS shared_at,
             d.document_id, d.file_name, d.mime_type, d.file_size_bytes, d.created_at AS uploaded_at,
             u.full_name AS from_full_name, u.email AS from_email
      FROM shares s
      JOIN documents d ON d.document_id = s.document_id
      JOIN users u ON u.user_id = s.from_user_id
 LEFT JOIN share_dismissals sd ON sd.share_id = s.share_id AND sd.user_id = $1
      WHERE s.is_revoked = FALSE
        AND (s.expiry_time IS NULL OR s.expiry_time > now())
        AND sd.share_id IS NULL
        AND (
             s.to_user_id = $1
             OR (s.to_user_id IS NULL AND LOWER(s.to_user_email) = LOWER($2))
        )
      ORDER BY s.created_at DESC
    `;
    const { rows } = await pool.query(q, [req.user.user_id, req.user.email]);
    res.json(rows);
  } catch (err) {
    console.error("SHARES_RECEIVED_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

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
    if (s.expiry_time && dayjs(s.expiry_time).isBefore(dayjs())) {
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

    await pool.query(
      `INSERT INTO access_logs(share_id, document_id, viewer_user_id, action)
       SELECT $1, document_id, $2, 'share_revoke' FROM shares WHERE share_id=$1`,
      [share_id, req.user.user_id]
    );

    res.json(upd.rows[0]);
  } catch (err) {
    console.error("SHARE_REVOKE_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.delete("/:share_id", auth, async (req, res) => {
  try {
    const { share_id } = req.params;

    const sel = await pool.query(
      `SELECT document_id FROM shares WHERE share_id=$1 AND from_user_id=$2 LIMIT 1`,
      [share_id, req.user.user_id]
    );
    if (!sel.rowCount) return res.status(404).json({ error: "Share not found" });

    const docId = sel.rows[0].document_id;

    await pool.query(`DELETE FROM otp_verifications WHERE share_id=$1 AND is_verified=FALSE`, [share_id]);

    const del = await pool.query(`DELETE FROM shares WHERE share_id=$1 AND from_user_id=$2`, [share_id, req.user.user_id]);
    if (!del.rowCount) return res.status(404).json({ error: "Share not found" });

    await pool.query(
      `INSERT INTO access_logs(share_id, document_id, viewer_user_id, action)
       VALUES ($1, $2, $3, 'share_delete')`,
      [share_id, docId, req.user.user_id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("SHARE_DELETE_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/:share_id/dismiss", auth, async (req, res) => {
  try {
    const { share_id } = req.params;

    const chk = await pool.query(
      `
      SELECT 1
        FROM shares s
       WHERE s.share_id = $1
         AND s.is_revoked = FALSE
         AND (s.expiry_time IS NULL OR s.expiry_time > now())
         AND (
              s.to_user_id = $2
              OR (s.to_user_id IS NULL AND LOWER(s.to_user_email) = LOWER($3))
         )
      LIMIT 1
      `,
      [share_id, req.user.user_id, req.user.email]
    );
    if (!chk.rowCount) return res.status(404).json({ error: "Share not found for this user" });

    await pool.query(
      `
      INSERT INTO share_dismissals (share_id, user_id)
      VALUES ($1, $2)
      ON CONFLICT (share_id, user_id) DO NOTHING
      `,
      [share_id, req.user.user_id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("SHARE_DISMISS_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.delete("/:share_id/dismiss", auth, async (req, res) => {
  try {
    const { share_id } = req.params;
    const del = await pool.query(
      `DELETE FROM share_dismissals WHERE share_id=$1 AND user_id=$2`,
      [share_id, req.user.user_id]
    );
    if (!del.rowCount) return res.status(404).json({ error: "Not dismissed" });
    res.json({ success: true });
  } catch (err) {
    console.error("SHARE_UNDISMISS_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.patch("/:share_id/expiry", auth, async (req, res) => {
  try {
    const { share_id } = req.params;
    let { expiry_time } = req.body || {};

    if (expiry_time !== null && expiry_time !== undefined) {
      if (!isFuture(expiry_time)) {
        return res.status(400).json({ error: "expiry_time must be in the future (or null to remove)" });
      }
    }

    const sel = await pool.query(
      `SELECT document_id FROM shares WHERE share_id=$1 AND from_user_id=$2 LIMIT 1`,
      [share_id, req.user.user_id]
    );
    if (!sel.rowCount) return res.status(404).json({ error: "Share not found" });

    const upd = await pool.query(
      `UPDATE shares SET expiry_time=$1 WHERE share_id=$2 RETURNING share_id, expiry_time`,
      [expiry_time || null, share_id]
    );

    await pool.query(
      `INSERT INTO access_logs(share_id, document_id, viewer_user_id, action, meta)
       VALUES ($1, $2, $3, 'share_expiry_update', $4)`,
      [share_id, sel.rows[0].document_id, req.user.user_id, JSON.stringify({ expiry_time: expiry_time || null })]
    );

    res.json(upd.rows[0]);
  } catch (err) {
    console.error("SHARE_EXPIRY_UPDATE_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/:share_id/expire-now", auth, async (req, res) => {
  try {
    const { share_id } = req.params;

    const sel = await pool.query(
      `SELECT document_id FROM shares WHERE share_id=$1 AND from_user_id=$2 LIMIT 1`,
      [share_id, req.user.user_id]
    );
    if (!sel.rowCount) return res.status(404).json({ error: "Share not found" });

    const upd = await pool.query(
      `UPDATE shares SET expiry_time = now() WHERE share_id=$1 RETURNING share_id, expiry_time`,
      [share_id]
    );

    await pool.query(
      `INSERT INTO access_logs(share_id, document_id, viewer_user_id, action)
       VALUES ($1, $2, $3, 'share_expired_now')`,
      [share_id, sel.rows[0].document_id, req.user.user_id]
    );

    res.json(upd.rows[0]);
  } catch (err) {
    console.error("SHARE_EXPIRE_NOW_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

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

    // ---- send OTP email via Gmail transporter ----
    await transporter.sendMail({
      from: `"QR-Docs" <${process.env.EMAIL_USER}>`,
      to: user.email,
      subject: "Your QR-Docs OTP",
      html: `<p>Your OTP is <b>${otp}</b>. It expires in ${ttlMins} minutes.</p>`,
    });

    await pool.query(
      `INSERT INTO access_logs(share_id, document_id, viewer_user_id, action)
       SELECT $1, document_id, $2, 'otp_request' FROM shares WHERE share_id=$1`,
      [share_id, user.user_id]
    );

    res.json({ success: true, otp_id: rows[0].otp_id, expires_at: rows[0].expiry_time });
  } catch (err) {
    console.error("OTP_SEND_ERROR:", err);
    res.status(400).json({ error: err.message || "Cannot send OTP" });
  }
});

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
      `INSERT INTO access_logs(share_id, document_id, viewer_user_id, action)
       SELECT $1, document_id, $2, 'otp_verify' FROM shares WHERE share_id=$1`,
      [share_id, userId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("OTP_VERIFY_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

async function notifyShareHandler(req, res) {
  try {
    const { share_id, to_email = null, meta = {} } = req.body || {};
    if (!share_id) return res.status(400).json({ error: "share_id required" });

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
    if (String(sh.from_user_id) !== String(req.user.user_id)) {
      return res.status(403).json({ error: "Not allowed" });
    }
    if (sh.is_revoked) return res.status(403).json({ error: "Share revoked" });
    if (sh.expiry_time && dayjs(sh.expiry_time).isBefore(dayjs())) {
      return res.status(403).json({ error: "Share expired" });
    }

    const recipient = to_email || sh.to_email_resolved || sh.to_user_email;
    if (!recipient) return res.status(400).json({ error: "No recipient email on this share" });

    const openUrl = buildShareUrl(sh.share_id);
    const qrImg = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(openUrl)}`;

    const subject =
      sh.access === "private" ? "A private document was shared with you" : "A public document was shared with you";

    // ---- send share notification via Gmail transporter ----
    await transporter.sendMail({
      from: `"QR-Docs" <${process.env.EMAIL_USER}>`,
      to: recipient,
      subject,
      html: `
        <p><b>${sh.from_full_name}</b> (${sh.from_email}) shared a document with you.</p>
        <p><b>File:</b> ${meta.document_name || sh.file_name} (${sh.mime_type || "file"})</p>
        <p><b>Access:</b> ${(meta.access || sh.access || "").toUpperCase()}</p>
        <p><b>Sender:</b> ${meta.sender_email || sh.from_email}</p>
        ${sh.expiry_time ? `<p><b>Expires:</b> ${new Date(sh.expiry_time).toLocaleString()}</p>` : ""}
        <p>Open link: <a href="${meta.frontend_link || openUrl}">${meta.frontend_link || openUrl}</a></p>
        <p><img src="${meta.qr_image || qrImg}" alt="QR code to open the share" /></p>
        <p>${
          sh.access === "private"
            ? `This is <b>PRIVATE</b>. Use your registered email; you'll get an OTP to view & download.`
            : `This is <b>PUBLIC (view-only)</b>.`
        }</p>
      `,
    });

    res.json({ success: true, notified: recipient });
  } catch (err) {
    console.error("NOTIFY_SHARE_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
}

router.post("/notify-share", auth, notifyShareHandler);
router.post("/otp/notify-share", auth, notifyShareHandler);

router.delete("/documents/:document_id", auth, async (req, res) => {
  try {
    const { document_id } = req.params;

    const chk = await pool.query(
      `SELECT 1 FROM documents WHERE document_id=$1 AND owner_user_id=$2 LIMIT 1`,
      [document_id, req.user.user_id]
    );
    if (!chk.rowCount) return res.status(404).json({ error: "Document not found" });

    await pool.query(`DELETE FROM documents WHERE document_id=$1`, [document_id]);

    // log
    await pool.query(
      `INSERT INTO access_logs(share_id, document_id, viewer_user_id, action)
       VALUES (NULL, $1, $2, 'document_delete')`,
      [document_id, req.user.user_id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("DOCUMENT_DELETE_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
