// routes/documents.routes.js
import { Router } from "express";
import path from "node:path";
import fs from "node:fs";
import multer from "multer";
import { pool } from "../db/db.js";
import { auth } from "../middleware/auth.js";

const router = Router();
const FILE_ROOT = process.env.FILE_ROOT || path.resolve("uploads");

// Ensure local folder exists
fs.mkdirSync(FILE_ROOT, { recursive: true });

// Multer storage (local disk). In production, swap to S3/GCS.
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, FILE_ROOT),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    const name = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    cb(null, name);
  },
});
const upload = multer({ storage });

/** Utility: inline vs attachment */
function contentDispositionInline(fileName) {
  const safe = fileName.replace(/"/g, "'");
  return `inline; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
function contentDispositionAttachment(fileName) {
  const safe = fileName.replace(/"/g, "'");
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** Shared access gate: returns { ok, reason, doc, share } */
async function checkAccess({ document_id, req, forDownload }) {
  // Owner can always view/download when authenticated
  if (req.user?.user_id) {
    const own = await pool.query(
      `SELECT d.*, (d.owner_user_id = $2) AS is_owner FROM documents d WHERE d.document_id=$1 LIMIT 1`,
      [document_id, req.user.user_id]
    );
    if (own.rowCount) {
      const doc = own.rows[0];
      if (doc.is_owner) return { ok: true, doc };
    }
  }

  // Access via share
  const shareId = req.query.share_id || null;
  const token = req.query.token || null;

  let share = null;
  if (shareId) {
    const q = `
      SELECT s.*, d.file_name, d.mime_type, d.file_path, d.file_size_bytes
      FROM shares s
      JOIN documents d ON d.document_id = s.document_id
      WHERE s.share_id=$1
      LIMIT 1
    `;
    const r = await pool.query(q, [shareId]);
    if (!r.rowCount) return { ok: false, reason: "Share not found" };
    share = r.rows[0];
  } else if (token) {
    const q = `
      SELECT s.*, d.file_name, d.mime_type, d.file_path, d.file_size_bytes
      FROM shares s
      JOIN documents d ON d.document_id = s.document_id
      WHERE s.share_token=$1 AND s.document_id=$2
      LIMIT 1
    `;
    const r = await pool.query(q, [token, document_id]);
    if (!r.rowCount) return { ok: false, reason: "Share not found" };
    share = r.rows[0];
  } else {
    // no share param, no owner
    const d = await pool.query(`SELECT * FROM documents WHERE document_id=$1 LIMIT 1`, [document_id]);
    if (!d.rowCount) return { ok: false, reason: "Document not found" };
    // If document is public at document-level AND not download
    if (d.rows[0].is_public && !forDownload) return { ok: true, doc: d.rows[0], share: null };
    return { ok: false, reason: "Not allowed" };
  }

  // common checks
  if (share.is_revoked) return { ok: false, reason: "Share revoked" };
  if (share.expiry_time && new Date(share.expiry_time) <= new Date()) {
    return { ok: false, reason: "Share expired" };
  }

  // public share → allow view, block download
  if (share.access === "public") {
    if (forDownload) return { ok: false, reason: "Public share cannot be downloaded" };
    return { ok: true, doc: share, share }; // share has d.* columns
  }

  // private share → require verified email (ShareAccess page stores in header)
  if (share.access === "private") {
    const email = String(req.headers["x-user-email"] || "").trim().toLowerCase();
    if (!email) return { ok: false, reason: "Missing verified email" };

    // The email must be registered
    const u = await pool.query(`SELECT user_id, email FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`, [email]);
    if (!u.rowCount) return { ok: false, reason: "Email not registered" };
    const userId = u.rows[0].user_id;

    // Must be intended recipient
    if (share.to_user_id && String(share.to_user_id) !== String(userId)) {
      return { ok: false, reason: "Not the intended recipient" };
    }
    if (!share.to_user_id && share.to_user_email) {
      if (String(share.to_user_email).toLowerCase() !== email) {
        return { ok: false, reason: "Not the intended recipient" };
      }
    }

    // Must have a recent verified OTP
    const v = await pool.query(
      `SELECT 1 FROM otp_verifications 
       WHERE share_id=$1 AND user_id=$2 AND is_verified=TRUE AND expiry_time > now()
       ORDER BY created_at DESC LIMIT 1`,
      [share.share_id, userId]
    );
    if (!v.rowCount) return { ok: false, reason: "OTP not verified or expired" };

    return { ok: true, doc: share, share };
  }

  return { ok: false, reason: "Not allowed" };
}

/* ============================================================
  LIST DOCUMENTS (mine)
  GET /documents  (auth)
============================================================ */
router.get("/", auth, async (req, res) => {
  try {
    const q = `
      SELECT document_id, owner_user_id, file_name, file_path, mime_type, file_size_bytes, is_public, created_at
      FROM documents
      WHERE owner_user_id = $1
      ORDER BY created_at DESC
    `;
    const { rows } = await pool.query(q, [req.user.user_id]);
    res.json(rows);
  } catch (err) {
    console.error("DOC_LIST_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ============================================================
  UPLOAD DOCUMENT
  POST /documents/upload  (auth, multipart/form-data)
  field: file
============================================================ */
router.post("/upload", auth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "file required" });

    const ins = `
      INSERT INTO documents (owner_user_id, file_name, file_path, mime_type, file_size_bytes)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING document_id, owner_user_id, file_name, file_path, mime_type, file_size_bytes, is_public, created_at
    `;
    const { rows } = await pool.query(ins, [
      req.user.user_id,
      req.file.originalname,
      req.file.filename, // we store disk filename; could store full path
      req.file.mimetype || null,
      req.file.size || null,
    ]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("DOC_UPLOAD_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ============================================================
  DELETE DOCUMENT (owner)
  DELETE /documents/:document_id  (auth)
============================================================ */
router.delete("/:document_id", auth, async (req, res) => {
  try {
    const { document_id } = req.params;

    // Ensure owner
    const d = await pool.query(
      `SELECT file_path FROM documents WHERE document_id=$1 AND owner_user_id=$2 LIMIT 1`,
      [document_id, req.user.user_id]
    );
    if (!d.rowCount) return res.status(404).json({ error: "Document not found" });

    // Delete record (cascades shares via FK)
    await pool.query(`DELETE FROM documents WHERE document_id=$1`, [document_id]);

    // Remove file from disk
    try {
      fs.unlinkSync(path.join(FILE_ROOT, d.rows[0].file_path));
    } catch {}

    res.json({ success: true });
  } catch (err) {
    console.error("DOC_DELETE_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ============================================================
  VIEW DOCUMENT (public route, guarded by checkAccess)
  GET /documents/view/:document_id
  Query: ?share_id=... or ?token=...
  Header for private: x-user-email: verifiedEmail
============================================================ */
router.get("/view/:document_id", async (req, res) => {
  try {
    const { document_id } = req.params;
    const gate = await checkAccess({ document_id, req, forDownload: false });
    if (!gate.ok) return res.status(403).json({ error: gate.reason || "Not allowed" });

    const fileName = gate.doc.file_name;
    const mime = gate.doc.mime_type || "application/octet-stream";
    const diskName = gate.doc.file_path;
    const abs = path.join(FILE_ROOT, diskName);

    if (!fs.existsSync(abs)) return res.status(404).json({ error: "File missing on server" });

    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", contentDispositionInline(fileName));
    // Let browser stream it
    const stream = fs.createReadStream(abs);
    stream.pipe(res);

    // audit
    await pool.query(
      `INSERT INTO access_logs(share_id, document_id, viewer_user_id, action)
       VALUES ($1, $2, NULL, 'view')`,
      [gate.share?.share_id || null, gate.doc.document_id]
    );
  } catch (err) {
    console.error("DOC_VIEW_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ============================================================
  DOWNLOAD DOCUMENT (public route, guarded by checkAccess)
  GET /documents/download/:document_id
  - Public shares: blocked
  - Private shares: allowed after OTP verify
  - Owner (auth): allowed
============================================================ */
router.get("/download/:document_id", async (req, res) => {
  try {
    const { document_id } = req.params;
    const gate = await checkAccess({ document_id, req, forDownload: true });
    if (!gate.ok) return res.status(403).json({ error: gate.reason || "Not allowed" });

    const fileName = gate.doc.file_name;
    const mime = gate.doc.mime_type || "application/octet-stream";
    const diskName = gate.doc.file_path;
    const abs = path.join(FILE_ROOT, diskName);

    if (!fs.existsSync(abs)) return res.status(404).json({ error: "File missing on server" });

    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", contentDispositionAttachment(fileName));
    const stream = fs.createReadStream(abs);
    stream.pipe(res);

    // audit
    await pool.query(
      `INSERT INTO access_logs(share_id, document_id, viewer_user_id, action)
       VALUES ($1, $2, NULL, 'download')`,
      [gate.share?.share_id || null, gate.doc.document_id]
    );
  } catch (err) {
    console.error("DOC_DOWNLOAD_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ============================================================
  (Optional) Resolve by token (used by ViewDoc if you pass token)
  GET /shares/resolve?token=...&doc=...
  -> { access, document_id }
============================================================ */
router.get("/resolve-share", async (req, res) => {
  try {
    const token = String(req.query.token || "").trim();
    const doc = String(req.query.doc || "").trim();
    if (!token || !doc) return res.status(400).json({ error: "token and doc required" });

    const q = `
      SELECT s.share_id, s.access, s.is_revoked, s.expiry_time, s.document_id
      FROM shares s
      WHERE s.share_token=$1 AND s.document_id=$2
      LIMIT 1
    `;
    const { rows } = await pool.query(q, [token, doc]);
    if (!rows.length) return res.status(404).json({ error: "Share not found" });
    const s = rows[0];

    if (s.is_revoked) return res.status(403).json({ error: "Share revoked" });
    if (s.expiry_time && new Date(s.expiry_time) <= new Date()) {
      return res.status(403).json({ error: "Share expired" });
    }

    res.json({ access: s.access, document_id: s.document_id });
  } catch (err) {
    console.error("RESOLVE_SHARE_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
