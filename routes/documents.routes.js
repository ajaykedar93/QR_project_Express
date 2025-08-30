// routes/documents.routes.js
import { Router } from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import dayjs from "dayjs";
import { pool } from "../db/db.js";
import { auth } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";

const router = Router();

/** CORS: expose headers so frontend can read filename/type/size via axios */
function exposeHeaders(res) {
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Disposition, Content-Type, Content-Length, Accept-Ranges"
  );
}

/** tiny helpers */
const toBool = (v) => String(v).toLowerCase() === "true";
const nowIso = () => new Date().toISOString();
const isAfterNow = (t) => t && dayjs(t).isAfter(dayjs());

/** STREAM FILE (shared; sets headers & pipes) */
function streamFile(res, absPath, { mime, filename, inline = true }) {
  exposeHeaders(res);
  const st = fs.statSync(absPath);
  res.setHeader("Content-Type", mime || "application/octet-stream");

  const safe = encodeURIComponent(filename || path.basename(absPath));
  const dispType = inline ? "inline" : "attachment";
  res.setHeader(
    "Content-Disposition",
    `${dispType}; filename="${safe}"; filename*=UTF-8''${safe}`
  );
  res.setHeader("Content-Length", String(st.size));
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");

  fs.createReadStream(absPath).pipe(res);
}

/**
 * ACCESS CHECK
 * - Accepts share_id or share_token (prefer token from QR)
 * - Public: view allowed, download blocked
 * - Private: requires a verified OTP for (share_id, user_id) and still-unexpired
 */
async function canAccess({ document_id, share_id, share_token, wantDownload, user_email }) {
  if (!share_id && !share_token) return { ok: false, msg: "Missing share reference" };

  const s = await pool.query(
    `
      SELECT s.share_id, s.document_id, s.access, s.expiry_time, s.is_revoked,
             s.to_user_id, s.to_user_email
      FROM shares s
      WHERE ($1::uuid IS NOT NULL AND s.share_id = $1::uuid)
         OR ($2::text IS NOT NULL AND s.share_token = $2::text)
      LIMIT 1
    `,
    [share_id || null, share_token || null]
  );
  if (!s.rowCount) return { ok: false, msg: "Share not found" };
  const sh = s.rows[0];

  if (String(sh.document_id) !== String(document_id)) {
    return { ok: false, msg: "Share/document mismatch" };
  }
  if (sh.is_revoked) return { ok: false, msg: "Share revoked" };
  if (sh.expiry_time && dayjs(sh.expiry_time).isBefore(dayjs())) {
    return { ok: false, msg: "Share expired" };
  }

  // PUBLIC: inline view allowed; download disabled
  if (sh.access === "public") {
    if (wantDownload) return { ok: false, msg: "Public shares are view-only" };
    return { ok: true, share: sh };
  }

  // PRIVATE: need verified OTP for this share & the user's account
  if (!user_email) return { ok: false, msg: "Email required for private share" };

  const ures = await pool.query(
    `SELECT user_id FROM users WHERE email = $1 LIMIT 1`,
    [String(user_email).trim()]
  );
  if (!ures.rowCount) return { ok: false, msg: "User must register first" };
  const viewerUserId = ures.rows[0].user_id;

  // must match intended recipient either by linked user or pending email
  if (sh.to_user_id && String(sh.to_user_id) !== String(viewerUserId)) {
    return { ok: false, msg: "Not the intended recipient" };
  }
  if (!sh.to_user_id && sh.to_user_email) {
    if (String(sh.to_user_email).toLowerCase() !== String(user_email).toLowerCase()) {
      return { ok: false, msg: "Not the intended recipient" };
    }
  }

  // must have a verified, unexpired OTP for this (share, user)
  const v = await pool.query(
    `
      SELECT 1
      FROM otp_verifications
      WHERE share_id = $1
        AND user_id = $2
        AND is_verified = TRUE
        AND expiry_time > now()
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [sh.share_id, viewerUserId]
  );
  if (!v.rowCount) return { ok: false, msg: "OTP verification required" };

  return { ok: true, share: sh, viewerUserId };
}

/* =========================
   DOCUMENTS: CRUD + LISTS
   ========================= */

/** GET /documents — list my uploads */
router.get("/", auth, async (req, res) => {
  const q = `
    SELECT *
    FROM documents
    WHERE owner_user_id = $1
    ORDER BY created_at DESC
  `;
  const { rows } = await pool.query(q, [req.user.user_id]);
  res.json(rows);
});

/** POST /documents/upload — upload any file (drag-drop or choose) */
router.post("/upload", auth, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });

  const { originalname, filename, mimetype, size, destination } = req.file;
  const filePath = path.join(destination, filename).replace(/\\/g, "/");

  const q = `
    INSERT INTO documents (owner_user_id, file_name, file_path, mime_type, file_size_bytes)
    VALUES ($1,$2,$3,$4,$5)
    RETURNING *
  `;
  const { rows } = await pool.query(q, [
    req.user.user_id,
    originalname,
    filePath,
    mimetype,
    size,
  ]);
  res.status(201).json(rows[0]);
});

/** DELETE /documents/:id — delete my file (and cascade deletes shares) */
router.delete("/:id", auth, async (req, res) => {
  const { id } = req.params;

  // ensure ownership
  const find = await pool.query(
    `SELECT file_path FROM documents WHERE document_id=$1 AND owner_user_id=$2`,
    [id, req.user.user_id]
  );
  const doc = find.rows[0];
  if (!doc) return res.status(404).json({ error: "Not found" });

  // best-effort delete from disk
  try {
    const abs = path.join(process.cwd(), doc.file_path);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch (_) {}

  await pool.query(`DELETE FROM documents WHERE document_id=$1`, [id]);
  res.json({ success: true });
});

/** GET /documents/received — documents shared *to me* (active only) */
router.get("/received", auth, async (req, res) => {
  const q = `
    SELECT s.share_id, s.share_token, s.access, s.expiry_time, s.created_at AS shared_at,
           d.document_id, d.file_name, d.mime_type, d.file_size_bytes, d.created_at AS uploaded_at,
           u.full_name AS from_full_name, u.email AS from_email
    FROM shares s
    JOIN documents d ON d.document_id = s.document_id
    JOIN users u ON u.user_id = s.from_user_id
    WHERE s.is_revoked = FALSE
      AND (s.expiry_time IS NULL OR s.expiry_time > now())
      AND (s.to_user_id = $1 OR (s.to_user_id IS NULL AND lower(s.to_user_email) = lower($2)))
    ORDER BY s.created_at DESC
  `;
  const { rows } = await pool.query(q, [req.user.user_id, req.user.email]);
  res.json(rows);
});

/* =========================
   SHARING: CREATE/LIST/REVOKE
   ========================= */

/**
 * POST /documents/:id/share
 * body: { to_email, expiry_time }  // expiry_time ISO optional
 * Logic:
 * - If to_email is a registered user → create PRIVATE share (to_user_id set)
 * - If not registered → create PUBLIC share (to_user_email set)
 * - share_token auto-generated (QR can encode a URL using token)
 */
router.post("/:id/share", auth, async (req, res) => {
  const { id } = req.params;
  let { to_email, expiry_time } = req.body || {};
  to_email = (to_email || "").trim();

  // verify owner
  const dres = await pool.query(
    `SELECT document_id FROM documents WHERE document_id=$1 AND owner_user_id=$2`,
    [id, req.user.user_id]
  );
  if (!dres.rowCount) return res.status(404).json({ error: "Document not found" });

  // ensure expiry in future if provided
  if (expiry_time && !isAfterNow(expiry_time)) {
    return res.status(400).json({ error: "expiry_time must be in the future" });
  }

  // is recipient registered?
  const u = to_email
    ? await pool.query(`SELECT user_id, email FROM users WHERE email=$1 LIMIT 1`, [to_email])
    : { rowCount: 0 };
  const isRegistered = !!u.rowCount;

  // If registered: private share; else: public (as per your flow)
  const access = isRegistered ? "private" : "public";

  const ins = `
    INSERT INTO shares (document_id, from_user_id, to_user_id, to_user_email, access, expiry_time)
    VALUES ($1,$2,$3,$4,$5,$6)
    RETURNING share_id, share_token, access, expiry_time, created_at
  `;
  const params = [
    id,
    req.user.user_id,
    isRegistered ? u.rows[0].user_id : null,
    !isRegistered ? to_email || null : null,
    access,
    expiry_time || null,
  ];
  const { rows } = await pool.query(ins, params);

  // Optional: log "otp_request" etc. in access_logs later
  res.status(201).json({
    ...rows[0],
    // Give client a canonical share URL it can turn into a QR (adjust domain)
    url: `${process.env.PUBLIC_APP_URL || "https://your-app.example"}/view?token=${rows[0].share_token}&doc=${id}`,
  });
});

/** GET /shares/mine — shares I have sent (grouped by access type) */
router.get("/shares/mine", auth, async (req, res) => {
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
});

/** POST /shares/:share_id/revoke — revoke a share I created */
router.post("/shares/:share_id/revoke", auth, async (req, res) => {
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
});

/* =========================
   OTP: SEND & VERIFY (PRIVATE)
   ========================= */

/**
 * POST /shares/:share_id/otp/send
 * body: { email }
 * - Only for PRIVATE shares
 * - Ensures email corresponds to registered user & intended recipient
 * - Creates an OTP (demo sends via console; integrate mail/SMS)
 */
router.post("/shares/:share_id/otp/send", async (req, res) => {
  const { share_id } = req.params;
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: "Email required" });

  // Load share
  const s = await pool.query(`SELECT * FROM shares WHERE share_id=$1 LIMIT 1`, [share_id]);
  if (!s.rowCount) return res.status(404).json({ error: "Share not found" });
  const sh = s.rows[0];

  if (sh.is_revoked) return res.status(403).json({ error: "Share revoked" });
  if (sh.access !== "private") return res.status(400).json({ error: "OTP not needed for public" });
  if (sh.expiry_time && dayjs(sh.expiry_time).isBefore(dayjs())) {
    return res.status(403).json({ error: "Share expired" });
  }

  // must be registered user
  const u = await pool.query(`SELECT user_id, email FROM users WHERE email=$1 LIMIT 1`, [email]);
  if (!u.rowCount) return res.status(400).json({ error: "User must register first" });
  const user = u.rows[0];

  // must be intended recipient
  if (sh.to_user_id && String(sh.to_user_id) !== String(user.user_id)) {
    return res.status(403).json({ error: "Not intended recipient" });
  }
  if (!sh.to_user_id && sh.to_user_email) {
    if (String(sh.to_user_email).toLowerCase() !== String(user.email).toLowerCase()) {
      return res.status(403).json({ error: "Not intended recipient" });
    }
  }

  // Generate 6-digit OTP (demo). Prefer hashing (otp_hash) in production.
  const otp = (Math.floor(100000 + Math.random() * 900000)).toString();
  const ttlMins = Number(process.env.OTP_TTL_MIN || 10);
  const expiry = dayjs().add(ttlMins, "minute").toISOString();

  // Create OTP (trigger ensures only one active per user/share)
  const ins = `
    INSERT INTO otp_verifications (user_id, share_id, otp_code, expiry_time)
    VALUES ($1, $2, $3, $4)
    RETURNING otp_id, expiry_time, created_at
  `;
  const { rows } = await pool.query(ins, [user.user_id, share_id, otp, expiry]);

  // TODO: send email/SMS. For now, log it (you’ll replace with nodemailer / provider)
  console.log(`OTP for ${email} share ${share_id}: ${otp} (expires ${expiry})`);

  res.json({ success: true, otp_id: rows[0].otp_id, expires_at: rows[0].expiry_time });
});

/**
 * POST /shares/:share_id/otp/verify
 * body: { email, otp }
 * - Marks OTP verified if valid & unexpired
 */
router.post("/shares/:share_id/otp/verify", async (req, res) => {
  const { share_id } = req.params;
  const { email, otp } = req.body || {};
  if (!email || !otp) return res.status(400).json({ error: "Email and OTP required" });

  // user must exist
  const u = await pool.query(`SELECT user_id FROM users WHERE email=$1 LIMIT 1`, [email]);
  if (!u.rowCount) return res.status(400).json({ error: "User must register first" });
  const userId = u.rows[0].user_id;

  // find a matching unverified, unexpired OTP
  const find = await pool.query(
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
  if (!find.rowCount) return res.status(400).json({ error: "Invalid or expired OTP" });

  await pool.query(`UPDATE otp_verifications SET is_verified = TRUE WHERE otp_id=$1`, [
    find.rows[0].otp_id,
  ]);

  // Optional: log verification
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
});

/* =========================
   VIEW / DOWNLOAD via SHARE
   ========================= */

/**
 * GET /documents/view/:id?share_id=...&token=...
 * headers:
 *   - x-user-email (required for private)
 */
router.get("/view/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { share_id = null, token: share_token = null } = req.query;

    const dres = await pool.query(`SELECT * FROM documents WHERE document_id=$1 LIMIT 1`, [id]);
    const doc = dres.rows[0];
    if (!doc) return res.status(404).send("Not found");

    const email = req.headers["x-user-email"] || "";
    const check = await canAccess({
      document_id: id,
      share_id,
      share_token,
      wantDownload: false,
      user_email: email,
    });
    if (!check.ok) return res.status(403).send(check.msg);

    const abs = path.join(process.cwd(), doc.file_path);
    if (!fs.existsSync(abs)) return res.status(404).send("File missing");

    // Optional: log view
    await pool.query(
      `INSERT INTO access_logs (share_id, document_id, viewer_user_id, action)
       VALUES ($1, $2, $3, 'view')`,
      [check.share?.share_id || null, doc.document_id, check.viewerUserId || null]
    );

    streamFile(res, abs, { mime: doc.mime_type, filename: doc.file_name, inline: true });
  } catch (e) {
    console.error("VIEW_ERROR:", e);
    res.status(500).send("Unable to open document");
  }
});

/**
 * GET /documents/download/:id?share_id=...&token=...
 * headers:
 *   - x-user-email (required for private)
 * - Public shares: download is blocked (view only)
 */
router.get("/download/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { share_id = null, token: share_token = null } = req.query;

    const dres = await pool.query(`SELECT * FROM documents WHERE document_id=$1 LIMIT 1`, [id]);
    const doc = dres.rows[0];
    if (!doc) return res.status(404).send("Not found");

    const email = req.headers["x-user-email"] || "";
    const check = await canAccess({
      document_id: id,
      share_id,
      share_token,
      wantDownload: true,
      user_email: email,
    });
    if (!check.ok) return res.status(403).send(check.msg);

    const abs = path.join(process.cwd(), doc.file_path);
    if (!fs.existsSync(abs)) return res.status(404).send("File missing");

    // Optional: log download
    await pool.query(
      `INSERT INTO access_logs (share_id, document_id, viewer_user_id, action)
       VALUES ($1, $2, $3, 'download')`,
      [check.share?.share_id || null, doc.document_id, check.viewerUserId || null]
    );

    streamFile(res, abs, { mime: doc.mime_type, filename: doc.file_name, inline: false });
  } catch (e) {
    console.error("DOWNLOAD_ERROR:", e);
    res.status(500).send("Download failed");
  }
});

export default router;
