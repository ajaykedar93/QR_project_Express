// routes/shares.routes.js
import { Router } from "express";
import dayjs from "dayjs";
import { pool } from "../db/db.js";
import { auth } from "../middleware/auth.js";
import { sendEmail } from "../utils/mailer.js";

const router = Router();

// ✅ Frontend base URL (update if needed)
const APP_URL = "https://qr-project-react.vercel.app/";

// ✅ Helper: build a full share URL from token/id
function buildShareUrl(shareToken) {
  return `${APP_URL.replace(/\/$/, "")}/share/${encodeURIComponent(shareToken)}`;
}

// ✅ Helper: check if a given ISO timestamp is in the future
const isFuture = (iso) => !!iso && dayjs(iso).isAfter(dayjs());

export { router, buildShareUrl, isFuture };


router.post("/", auth, async (req, res) => {
  try {
    let { document_id, to_email = "", expiry_time = null, access = null } = req.body || {};

    document_id = String(document_id || "").trim();
    to_email = String(to_email || "").trim();
    access = access ? String(access).toLowerCase() : null;

    if (!document_id)
      return res.status(400).json({ error: "document_id required" });

    // ✅ Check ownership
    const owns = await pool.query(
      `SELECT 1 FROM documents WHERE document_id=$1 AND owner_user_id=$2 LIMIT 1`,
      [document_id, req.user.user_id]
    );
    if (!owns.rowCount)
      return res.status(404).json({ error: "Document not found or not owned by user" });

    // ✅ Validate expiry time (if given)
    if (expiry_time) {
      const expiry = new Date(expiry_time);
      if (isNaN(expiry.getTime()) || expiry <= new Date()) {
        return res.status(400).json({ error: "expiry_time must be in the future" });
      }
      expiry_time = expiry;
    } else {
      expiry_time = null;
    }

    // ✅ Check recipient
    let to_user_id = null;
    if (to_email) {
      const u = await pool.query(
        `SELECT user_id FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`,
        [to_email]
      );
      if (u.rowCount) to_user_id = u.rows[0].user_id;
    }

    // ✅ Determine access type
    let finalAccess;
    if (access === "private") {
      if (!to_email)
        return res.status(400).json({ error: "Private share requires recipient email" });
      if (!to_user_id)
        return res.status(400).json({ error: "Recipient must be registered for private shares" });
      finalAccess = "private";
    } else if (access === "public") {
      finalAccess = "public";
    } else {
      finalAccess = to_user_id ? "private" : "public";
    }

    // ✅ Insert share
    const insertQuery = `
      INSERT INTO shares (document_id, from_user_id, to_user_id, to_user_email, access, expiry_time)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING share_id, share_token, access, expiry_time, created_at
    `;
    const { rows } = await pool.query(insertQuery, [
      document_id,
      req.user.user_id,
      to_user_id,
      to_user_id ? null : to_email || null,
      finalAccess,
      expiry_time,
    ]);

    // ✅ Success
    res.status(201).json({
      success: true,
      message: "Document shared successfully",
      ...rows[0],
    });
  } catch (err) {
    console.error("❌ SHARE_CREATE_ERROR:", err);
    return res
      .status(400)
      .json({ error: err?.message || "Cannot create share" });
  }
});

router.get("/mine", auth, async (req, res) => {
  try {
    const q = `
      SELECT
        s.share_id,
        s.share_token,
        s.access,
        s.expiry_time,
        s.is_revoked,
        s.created_at,
        s.to_user_id,
        s.to_user_email,
        d.document_id,
        d.file_name,
        d.mime_type,
        d.file_size_bytes,
        ru.full_name AS to_full_name,
        ru.email AS to_email_resolved
      FROM shares s
      JOIN documents d ON d.document_id = s.document_id
      LEFT JOIN users ru ON ru.user_id = s.to_user_id
      WHERE s.from_user_id = $1
      ORDER BY s.created_at DESC
    `;

    const { rows } = await pool.query(q, [req.user.user_id]);
    res.json({
      success: true,
      total: rows.length,
      shares: rows,
    });
  } catch (err) {
    console.error("❌ SHARES_MINE_ERROR:", err);
    res.status(500).json({ error: "Server error fetching your shared documents" });
  }
});

router.get("/received", auth, async (req, res) => {
  try {
    const q = `
      SELECT
        s.share_id,
        s.share_token,
        s.access,
        s.expiry_time,
        s.created_at AS shared_at,
        d.document_id,
        d.file_name,
        d.mime_type,
        d.file_size_bytes,
        d.created_at AS uploaded_at,
        u.full_name AS from_full_name,
        u.email AS from_email
      FROM shares s
      JOIN documents d ON d.document_id = s.document_id
      JOIN users u ON u.user_id = s.from_user_id
      LEFT JOIN share_dismissals sd
             ON sd.share_id = s.share_id
            AND sd.user_id = $1
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
    res.json({
      success: true,
      total: rows.length,
      received: rows,
    });
  } catch (err) {
    console.error("❌ SHARES_RECEIVED_ERROR:", err);
    res.status(500).json({ error: "Server error fetching received documents" });
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
    console.error("❌ SHARE_GET_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/:share_id/minimal", async (req, res) => {
  try {
    const { share_id } = req.params;
    const q = `
      SELECT share_id, document_id, access, expiry_time, is_revoked, to_user_email
      FROM shares
      WHERE share_id = $1
      LIMIT 1
    `;
    const { rows } = await pool.query(q, [share_id]);
    if (!rows.length) return res.status(404).json({ error: "Share not found" });

    const s = rows[0];
    if (s.is_revoked) return res.status(403).json({ error: "Share revoked" });
    if (s.expiry_time && new Date(s.expiry_time) <= new Date())
      return res.status(403).json({ error: "Share expired" });

    res.json({
      share_id: s.share_id,
      document_id: s.document_id,
      access: s.access,
      to_user_email: s.to_user_email || null,
    });
  } catch (err) {
    console.error("❌ SHARE_MINIMAL_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/:share_id/revoke", auth, async (req, res) => {
  try {
    const { share_id } = req.params;

    const upd = await pool.query(
      `UPDATE shares
          SET is_revoked = TRUE, revoked_at = now()
        WHERE share_id = $1 AND from_user_id = $2
        RETURNING share_id, document_id, is_revoked, revoked_at`,
      [share_id, req.user.user_id]
    );
    if (!upd.rowCount) return res.status(404).json({ error: "Share not found" });

    const sh = upd.rows[0];
    await pool.query(
      `INSERT INTO access_logs(share_id, document_id, viewer_user_id, action)
       VALUES ($1, $2, $3, 'share_revoke')`,
      [share_id, sh.document_id, req.user.user_id]
    );

    res.json(sh);
  } catch (err) {
    console.error("❌ SHARE_REVOKE_ERROR:", err);
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
    await pool.query(`DELETE FROM shares WHERE share_id=$1 AND from_user_id=$2`, [share_id, req.user.user_id]);
    await pool.query(
      `INSERT INTO access_logs(share_id, document_id, viewer_user_id, action)
       VALUES ($1, $2, $3, 'share_delete')`,
      [share_id, docId, req.user.user_id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("❌ SHARE_DELETE_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/:share_id/dismiss", auth, async (req, res) => {
  try {
    const { share_id } = req.params;

    const chk = await pool.query(
      `SELECT 1
         FROM shares s
        WHERE s.share_id = $1
          AND s.is_revoked = FALSE
          AND (s.expiry_time IS NULL OR s.expiry_time > now())
          AND (
              s.to_user_id = $2
              OR (s.to_user_id IS NULL AND LOWER(s.to_user_email) = LOWER($3))
          )
        LIMIT 1`,
      [share_id, req.user.user_id, req.user.email]
    );
    if (!chk.rowCount) return res.status(404).json({ error: "Share not found for this user" });

    await pool.query(
      `INSERT INTO share_dismissals (share_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (share_id, user_id) DO NOTHING`,
      [share_id, req.user.user_id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("❌ SHARE_DISMISS_ERROR:", err);
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
    console.error("❌ SHARE_UNDISMISS_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.patch("/:share_id/expiry", auth, async (req, res) => {
  try {
    const { share_id } = req.params;
    let { expiry_time } = req.body || {};

    if (expiry_time && new Date(expiry_time) <= new Date()) {
      return res.status(400).json({ error: "expiry_time must be in the future or null" });
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
    console.error("❌ SHARE_EXPIRY_UPDATE_ERROR:", err);
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
    console.error("❌ SHARE_EXPIRE_NOW_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});
// ✅ Send OTP for a private share
router.post("/:share_id/otp/send", async (req, res) => {
  try {
    const { share_id } = req.params;
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Email required" });

    // Share lookup
    const sres = await pool.query(`SELECT * FROM shares WHERE share_id=$1 LIMIT 1`, [share_id]);
    if (!sres.rowCount) return res.status(404).json({ error: "Share not found" });
    const sh = sres.rows[0];

    // Validations
    if (sh.is_revoked) return res.status(403).json({ error: "Share revoked" });
    if (sh.access !== "private") return res.status(400).json({ error: "OTP not required for public shares" });
    if (sh.expiry_time && new Date(sh.expiry_time) <= new Date()) {
      return res.status(403).json({ error: "Share expired" });
    }

    // Recipient must be a registered user
    const ures = await pool.query(
      `SELECT user_id, email FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`,
      [email]
    );
    if (!ures.rowCount) return res.status(400).json({ error: "User must register first" });
    const user = ures.rows[0];

    // Recipient must match share target (to_user_id or to_user_email)
    if (sh.to_user_id && String(sh.to_user_id) !== String(user.user_id)) {
      return res.status(403).json({ error: "Not the intended recipient" });
    }
    if (!sh.to_user_id && sh.to_user_email && sh.to_user_email.toLowerCase() !== user.email.toLowerCase()) {
      return res.status(403).json({ error: "Not the intended recipient" });
    }

    // Generate OTP
    const otp = (Math.floor(100000 + Math.random() * 900000)).toString();
    const ttlMins = Number(process.env.OTP_TTL_MIN || 10);
    const expiry = new Date(Date.now() + ttlMins * 60 * 1000).toISOString();

    // Insert OTP (DB trigger enforces 1 active OTP per (user, share))
    const ins = `
      INSERT INTO otp_verifications (user_id, share_id, otp_code, expiry_time)
      VALUES ($1, $2, $3, $4)
      RETURNING otp_id, expiry_time
    `;
    const { rows } = await pool.query(ins, [user.user_id, share_id, otp, expiry]);

    // Send email (same helper)
    await sendEmail({
      to: user.email,
      subject: "Your QR-Docs OTP",
      html: `<p>Your OTP is <b>${otp}</b>. It expires in ${ttlMins} minutes.</p>`,
    });

    // Log
    await pool.query(
      `INSERT INTO access_logs(share_id, document_id, viewer_user_id, action)
       SELECT $1, document_id, $2, 'otp_request' FROM shares WHERE share_id=$1`,
      [share_id, user.user_id]
    );

    res.json({ success: true, otp_id: rows[0].otp_id, expires_at: rows[0].expiry_time });
  } catch (err) {
    // Friendly message if your DB function prevent_duplicate_active_otp() fires
    if (String(err.message || "").toLowerCase().includes("only one active")) {
      return res.status(429).json({
        error: "An active OTP already exists. Please wait a minute and try again.",
      });
    }
    console.error("❌ OTP_SEND_ERROR:", err);
    res.status(400).json({ error: err.message || "Cannot send OTP" });
  }
});


// ✅ Verify OTP for a private share
router.post("/:share_id/otp/verify", async (req, res) => {
  try {
    const { share_id } = req.params;
    const email = String(req.body?.email || "").trim().toLowerCase();
    const otp = String(req.body?.otp || "").trim();
    if (!email || !otp) return res.status(400).json({ error: "Email and OTP required" });

    // Resolve user
    const u = await pool.query(
      `SELECT user_id FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`,
      [email]
    );
    if (!u.rowCount) return res.status(400).json({ error: "User must register first" });
    const userId = u.rows[0].user_id;

    // Validate OTP (must be unverified, unexpired, newest)
    const f = await pool.query(
      `SELECT otp_id
         FROM otp_verifications
        WHERE share_id=$1
          AND user_id=$2
          AND is_verified=FALSE
          AND expiry_time>now()
          AND otp_code=$3
        ORDER BY created_at DESC
        LIMIT 1`,
      [share_id, userId, otp]
    );
    if (!f.rowCount) return res.status(400).json({ error: "Invalid or expired OTP" });

    // Mark verified
    await pool.query(`UPDATE otp_verifications SET is_verified=TRUE WHERE otp_id=$1`, [
      f.rows[0].otp_id,
    ]);

    // Log
    await pool.query(
      `INSERT INTO access_logs(share_id, document_id, viewer_user_id, action)
       SELECT $1, document_id, $2, 'otp_verify' FROM shares WHERE share_id=$1`,
      [share_id, userId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("❌ OTP_VERIFY_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});


// ✅ Final fixed handler
// ✅ POST /shares/notify-share  (and /shares/otp/notify-share)

// -------- NOTIFY SHARE (private/public) --------
// POST /shares/notify-share
// body: { share_id: string, to_email?: string, meta?: {document_name?, access?, frontend_link?, qr_image?} }
async function notifyShareHandler(req, res) {
  try {
    const { share_id, to_email = null, meta = {} } = req.body || {};
    if (!share_id) return res.status(400).json({ error: "share_id required" });

    // Pull everything needed (note quoted aliases!)
    const q = `
      SELECT
        s.share_id,
        s.share_token,
        s.access,
        s.expiry_time,
        s.is_revoked,
        s.to_user_id,
        s.to_user_email,
        s.from_user_id,
        s.document_id,
        d.file_name,
        d.mime_type,
        uf.full_name AS "from_full_name",
        uf.email     AS "from_email",
        ur.email     AS "to_email_resolved"
      FROM shares s
      JOIN documents d ON d.document_id = s.document_id
      JOIN users uf     ON uf.user_id   = s.from_user_id
 LEFT JOIN users ur     ON ur.user_id   = s.to_user_id
      WHERE s.share_id = $1
      LIMIT 1`;
    const { rows } = await pool.query(q, [share_id]);
    if (!rows.length) return res.status(404).json({ error: "Share not found" });

    const sh = rows[0];

    // Only the owner can notify
    if (String(sh.from_user_id) !== String(req.user.user_id)) {
      return res.status(403).json({ error: "Not allowed" });
    }
    if (sh.is_revoked) return res.status(403).json({ error: "Share revoked" });
    if (sh.expiry_time && dayjs(sh.expiry_time).isBefore(dayjs())) {
      return res.status(403).json({ error: "Share expired" });
    }

    // Resolve recipient:
    // 1) explicit to_email from body, else 2) registered to_user, else 3) saved to_user_email
    let recipient = (to_email || "").trim().toLowerCase() ||
                    (sh.to_email_resolved || "") ||
                    (sh.to_user_email || "");

    // Private: must match intended recipient (strict)
    if (sh.access === "private") {
      if (!recipient) return res.status(400).json({ error: "Private share requires a registered recipient email" });

      // If share targets a user_id => make sure recipient is that user's email
      if (sh.to_user_id) {
        const chk = await pool.query(`SELECT email FROM users WHERE user_id=$1 LIMIT 1`, [sh.to_user_id]);
        const intended = chk.rows?.[0]?.email?.toLowerCase() || "";
        if (recipient.toLowerCase() !== intended) {
          return res.status(403).json({ error: "Recipient must match the intended registered user" });
        }
      } else if (sh.to_user_email) {
        // If share targets an email => must match, case-insensitive
        if (recipient.toLowerCase() !== String(sh.to_user_email).toLowerCase()) {
          return res.status(403).json({ error: "Recipient must match the intended email" });
        }
      } else {
        return res.status(400).json({ error: "Private share missing recipient binding" });
      }
    } else {
      // Public: allow explicit to_email; otherwise use stored recipient if present
      if (!recipient) {
        return res.status(400).json({ error: "No recipient email provided for public share" });
      }
    }

    // Build link/QR (use share_token)
    const openUrl = buildShareUrl(sh.share_token);
    const qrImg = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(openUrl)}`;

    const subject =
      sh.access === "private"
        ? "A private document was shared with you"
        : "A public document was shared with you";

    // Send
    await sendEmail({
      to: recipient,
      subject,
      html: `
        <p><b>${sh.from_full_name}</b> (${sh.from_email}) shared a document with you.</p>
        <p><b>File:</b> ${meta.document_name || sh.file_name} (${sh.mime_type || "file"})</p>
        <p><b>Access:</b> ${(meta.access || sh.access || "").toUpperCase()}</p>
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

    return res.json({ success: true, notified: recipient });
  } catch (err) {
    console.error("❌ NOTIFY_SHARE_ERROR:", err);
    return res.status(500).json({ error: err.message || "Server error" });
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
