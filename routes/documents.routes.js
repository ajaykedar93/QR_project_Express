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

/* -----------------------------
   File-type allow/deny lists
------------------------------*/
const ALLOWED_EXT = new Set([
  // docs
  "pdf", "txt", "md",
  // office
  "doc", "docx", "ppt", "pptx", "xls", "xlsx", "csv",
  // images
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg",
  // media
  "mp3", "wav", "ogg", "mp4", "webm", "mov", "m4a",
  // data/text
  "json", "xml", "yaml", "yml", "log",
  // archives (preview fallback only)
  "zip", "rar", "7z", "tar", "gz",
]);

const BLOCKED_EXT = new Set([
  "exe", "msi", "bat", "cmd", "sh", "ps1", "php", "jsp", "asp", "dll", "so",
]);

const OFFICE_RE = /(msword|officedocument|excel|powerpoint)/i;
const isPdfMime    = (m) => /^application\/pdf$/i.test(m || "");
const isImgMime    = (m) => /^image\//i.test(m || "");
const isAudioMime  = (m) => /^audio\//i.test(m || "");
const isVideoMime  = (m) => /^video\//i.test(m || "");
const isTextMime   = (m) => /^text\//i.test(m || "") || /(json|xml|yaml)/i.test(m || "");
const isOfficeMime = (m) => OFFICE_RE.test(m || "");

/** Decide preview strategy (derived at runtime, not stored in DB) */
function decidePreviewStrategy({ mime = "", file_name = "" }) {
  const ext = (path.extname(file_name || "").slice(1) || "").toLowerCase();
  if (isPdfMime(mime) || ext === "pdf") return "pdf";
  if (isImgMime(mime)) return "image";
  if (isTextMime(mime) || ["txt", "md", "json", "xml", "yaml", "yml", "csv", "log"].includes(ext)) return "text";
  if (isAudioMime(mime)) return "audio";
  if (isVideoMime(mime)) return "video";
  if (isOfficeMime(mime) || ["doc", "docx", "ppt", "pptx", "xls", "xlsx"].includes(ext)) return "office";
  return "other"; // fallback
}

/* -----------------------------
   Multer storage (local disk)
------------------------------*/
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, FILE_ROOT),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    const name = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    cb(null, name);
  },
});

// 20 MB default limit (tune as needed)
const upload = multer({
  storage,
  limits: { fileSize: Number(process.env.MAX_UPLOAD_BYTES || 20 * 1024 * 1024) },
  fileFilter: (req, file, cb) => {
    const ext = (path.extname(file.originalname || "").slice(1) || "").toLowerCase();
    if (BLOCKED_EXT.has(ext)) return cb(new Error("Blocked file type"));
    if (!ALLOWED_EXT.has(ext)) return cb(new Error("Unsupported file type"));
    cb(null, true);
  },
});

/* -----------------------------
   Content-Disposition helpers
------------------------------*/
function cdInline(fileName) {
  const safe = (fileName || "file").replace(/"/g, "'");
  return `inline; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(fileName || "file")}`;
}
function cdAttachment(fileName) {
  const safe = (fileName || "file").replace(/"/g, "'");
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(fileName || "file")}`;
}

/* -----------------------------
   Resolve viewer_user_id (logs)
------------------------------*/
async function resolveViewerUserId(req, share) {
  if (req.user?.user_id) return req.user.user_id;
  const email = String(req.headers["x-user-email"] || "").trim().toLowerCase();
  if (!email) return null;
  const r = await pool.query(
    `SELECT user_id FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`,
    [email]
  );
  if (!r.rowCount) return null;
  if (share?.to_user_id && String(share.to_user_id) !== String(r.rows[0].user_id)) return null;
  return r.rows[0].user_id;
}

/* -----------------------------
   Access gate
------------------------------*/
async function checkAccess({ document_id, req, forDownload }) {
  // Owner (authed) can always view/download
  if (req.user?.user_id) {
    const own = await pool.query(
      `SELECT d.*, (d.owner_user_id = $2) AS is_owner FROM documents d WHERE d.document_id=$1 LIMIT 1`,
      [document_id, req.user.user_id]
    );
    if (own.rowCount) {
      const doc = own.rows[0];
      if (doc.is_owner) return { ok: true, doc, share: null };
    }
  }

  // Access via share
  const shareId = req.query.share_id || null;
  const token = req.query.token || null;

  let share = null;
  if (shareId) {
    const q = `
      SELECT s.*, d.file_name, d.mime_type, d.file_path, d.file_size_bytes, d.document_id
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
      SELECT s.*, d.file_name, d.mime_type, d.file_path, d.file_size_bytes, d.document_id
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
    return { ok: true, doc: share, share };
  }

  // private share → require verified email header (after OTP)
  if (share.access === "private") {
    const email = String(req.headers["x-user-email"] || "").trim().toLowerCase();
    if (!email) return { ok: false, reason: "Missing verified email" };

    const u = await pool.query(`SELECT user_id, email FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`, [email]);
    if (!u.rowCount) return { ok: false, reason: "Email not registered" };
    const userId = u.rows[0].user_id;

    if (share.to_user_id && String(share.to_user_id) !== String(userId)) {
      return { ok: false, reason: "Not the intended recipient" };
    }
    if (!share.to_user_id && share.to_user_email) {
      if (String(share.to_user_email).toLowerCase() !== email) {
        return { ok: false, reason: "Not the intended recipient" };
      }
    }

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
   GET DOCUMENT META (used by frontend viewer)
   GET /documents/:document_id
   (public share or owner or private with OTP header)
============================================================ */
router.get("/:document_id", async (req, res) => {
  try {
    const { document_id } = req.params;
    const gate = await checkAccess({ document_id, req, forDownload: false });
    if (!gate.ok) return res.status(403).json({ error: gate.reason || "Not allowed" });

    const preview_strategy = decidePreviewStrategy({
      mime: gate.doc.mime_type,
      file_name: gate.doc.file_name,
    });

    res.json({
      document_id,
      file_name: gate.doc.file_name,
      mime_type: gate.doc.mime_type,
      file_size_bytes: gate.doc.file_size_bytes,
      preview_strategy, // "pdf" | "image" | "text" | "audio" | "video" | "office" | "other"
    });
  } catch (err) {
    console.error("DOC_META_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ============================================================
   UPLOAD DOCUMENT (validate type)
   POST /documents/upload  (auth, multipart/form-data)
   field: file
============================================================ */
router.post("/upload", auth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "file required" });

    const ext = (path.extname(req.file.originalname || "").slice(1) || "").toLowerCase();
    if (BLOCKED_EXT.has(ext)) return res.status(400).json({ error: "Blocked file type" });
    if (!ALLOWED_EXT.has(ext)) return res.status(400).json({ error: "Unsupported file type" });

    const ins = `
      INSERT INTO documents (owner_user_id, file_name, file_path, mime_type, file_size_bytes)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING document_id, owner_user_id, file_name, file_path, mime_type, file_size_bytes, is_public, created_at
    `;
    const { rows } = await pool.query(ins, [
      req.user.user_id,
      req.file.originalname,
      req.file.filename, // disk filename
      req.file.mimetype || null,
      req.file.size || null,
    ]);

    // Append preview hint for immediate UI use
    const saved = rows[0];
    const preview_strategy = decidePreviewStrategy({
      mime: saved.mime_type,
      file_name: saved.file_name,
    });

    res.status(201).json({ ...saved, preview_strategy });
  } catch (err) {
    console.error("DOC_UPLOAD_ERROR:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

/* ============================================================
   DELETE DOCUMENT (owner)
   DELETE /documents/:document_id  (auth)
============================================================ */
router.delete("/:document_id", auth, async (req, res) => {
  try {
    const { document_id } = req.params;
    const d = await pool.query(
      `SELECT file_path FROM documents WHERE document_id=$1 AND owner_user_id=$2 LIMIT 1`,
      [document_id, req.user.user_id]
    );
    if (!d.rowCount) return res.status(404).json({ error: "Document not found" });

    await pool.query(`DELETE FROM documents WHERE document_id=$1`, [document_id]);

    try { fs.unlinkSync(path.join(FILE_ROOT, d.rows[0].file_path)); } catch {}

    res.json({ success: true });
  } catch (err) {
    console.error("DOC_DELETE_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ============================================================
   Internal: Range-friendly streaming
============================================================ */
function streamFileWithRange(res, absPath, mime, disposition, rangeHeader) {
  const stat = fs.statSync(absPath);
  const fileSize = stat.size;

  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Disposition", disposition);
  res.setHeader("Accept-Ranges", "bytes");
  // Enable embedding in Office viewer and iframes
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : fileSize - 1;
      if (isNaN(start) || isNaN(end) || start > end || end >= fileSize) {
        start = 0; end = fileSize - 1;
      }
      const chunkSize = end - start + 1;
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
      res.setHeader("Content-Length", String(chunkSize));
      fs.createReadStream(absPath, { start, end }).pipe(res);
      return;
    }
  }

  res.setHeader("Content-Length", String(fileSize));
  fs.createReadStream(absPath).pipe(res);
}

/* ============================================================
   VIEW DOCUMENT (guarded by access)
   GET /documents/view/:document_id
   Query: ?share_id=... or ?token=...
   Header for private: x-user-email
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

    streamFileWithRange(res, abs, mime, cdInline(fileName), req.headers.range);

    // audit
    const viewerId = await resolveViewerUserId(req, gate.share);
    await pool.query(
      `INSERT INTO access_logs(share_id, document_id, viewer_user_id, action)
       VALUES ($1, $2, $3, 'view')`,
      [gate.share?.share_id || null, gate.doc.document_id, viewerId]
    );
  } catch (err) {
    console.error("DOC_VIEW_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ============================================================
   DOWNLOAD DOCUMENT (guarded by access)
   GET /documents/download/:document_id
   Public shares blocked; Private allowed after OTP; Owner allowed.
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

    streamFileWithRange(res, abs, mime, cdAttachment(fileName), req.headers.range);

    const viewerId = await resolveViewerUserId(req, gate.share);
    await pool.query(
      `INSERT INTO access_logs(share_id, document_id, viewer_user_id, action)
       VALUES ($1, $2, $3, 'download')`,
      [gate.share?.share_id || null, gate.doc.document_id, viewerId]
    );
  } catch (err) {
    console.error("DOC_DOWNLOAD_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ============================================================
   Resolve by token (optional helper)
   GET /documents/resolve-share?token=...&doc=...
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
