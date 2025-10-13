// routes/documents.routes.js
import { Router } from "express";
import path from "node:path";
import fs from "node:fs";
import mime from "mime-types";
import dayjs from "dayjs";
import { pool } from "../db/db.js";
import { auth } from "../middleware/auth.js";
import { upload, FILE_ROOT } from "../middleware/upload.js";

const router = Router();

/* ---------------------------------------------------------------------
   HELPERS
--------------------------------------------------------------------- */
function cdInline(fileName) {
  const safe = (fileName || "file").replace(/"/g, "'");
  return `inline; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(
    fileName || "file"
  )}`;
}

function cdAttachment(fileName) {
  const safe = (fileName || "file").replace(/"/g, "'");
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(
    fileName || "file"
  )}`;
}

/** Decide how frontend should preview file */
function decidePreviewStrategy({ mime = "", file_name = "" }) {
  const ext = (path.extname(file_name || "").slice(1) || "").toLowerCase();
  if (/^application\/pdf$/i.test(mime) || ext === "pdf") return "pdf";
  if (/^image\//i.test(mime)) return "image";
  if (
    /^text\//i.test(mime) ||
    /(json|xml|yaml)/i.test(mime) ||
    ["txt", "md", "json", "xml", "yaml", "yml", "csv", "log"].includes(ext)
  )
    return "text";
  if (/^audio\//i.test(mime)) return "audio";
  if (/^video\//i.test(mime)) return "video";
  if (
    /(msword|officedocument|excel|powerpoint)/i.test(mime) ||
    ["doc", "docx", "ppt", "pptx", "xls", "xlsx"].includes(ext)
  )
    return "office";
  return "other";
}

/** Range-safe streaming (supports large files & media) */
function streamFileWithRange(res, absPath, mime, disposition, rangeHeader) {
  const stat = fs.statSync(absPath);
  const fileSize = stat.size;

  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Disposition", disposition);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : fileSize - 1;
      if (isNaN(start) || isNaN(end) || start > end || end >= fileSize) {
        start = 0;
        end = fileSize - 1;
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

/* ---------------------------------------------------------------------
   ACCESS / SHARE RESOLUTION
--------------------------------------------------------------------- */
async function resolveAccess(req, document_id) {
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const token = (
    req.query?.token ||
    req.query?.share_token ||
    ""
  )
    .toString()
    .trim();

  let ownerRow = null;

  // Owner quick check
  if (bearer) {
    try {
      const q = `SELECT owner_user_id FROM documents WHERE document_id=$1 LIMIT 1`;
      const { rows } = await pool.query(q, [document_id]);
      ownerRow = rows[0] || null;
    } catch {}
  }

  // If share token used
  if (token) {
    const q = `
      SELECT s.*, d.owner_user_id, d.document_id
      FROM shares s
      JOIN documents d ON d.document_id = s.document_id
      WHERE s.share_token = $1
      LIMIT 1
    `;
    const { rows } = await pool.query(q, [token]);
    const share = rows[0];
    if (!share || String(share.document_id) !== String(document_id))
      return { mode: null, viewOnly: true };
    if (share.is_revoked) return { mode: null, viewOnly: true };
    if (share.expiry_time && new Date(share.expiry_time) <= new Date())
      return { mode: null, viewOnly: true };

    // Public share
    if (share.access === "public")
      return { mode: "public", share, viewOnly: true };

    // Private share (OTP required)
    const claimedEmail = String(
      req.headers["x-user-email"] || ""
    )
      .trim()
      .toLowerCase();
    if (!claimedEmail) return { mode: null, viewOnly: true };

    const ures = await pool.query(
      `SELECT user_id, email FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`,
      [claimedEmail]
    );
    if (!ures.rowCount) return { mode: null, viewOnly: true };
    const u = ures.rows[0];

    // Intended recipient validation
    if (share.to_user_id && String(share.to_user_id) !== String(u.user_id))
      return { mode: null, viewOnly: true };
    if (
      !share.to_user_id &&
      share.to_user_email &&
      share.to_user_email.toLowerCase() !== u.email.toLowerCase()
    )
      return { mode: null, viewOnly: true };

    // OTP verification check
    const vq = `
      SELECT 1 FROM otp_verifications
      WHERE share_id = $1 AND user_id = $2
        AND is_verified = TRUE
        AND expiry_time > now()
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const verified = await pool.query(vq, [share.share_id, u.user_id]);
    if (!verified.rowCount) return { mode: null, viewOnly: true };

    return { mode: "private", userId: u.user_id, share, viewOnly: false };
  }

  // Owner fallback
  if (
    ownerRow &&
    req.user &&
    String(ownerRow.owner_user_id) === String(req.user.user_id)
  )
    return { mode: "owner", userId: req.user.user_id, share: null, viewOnly: false };

  return { mode: null, viewOnly: true };
}

/* ---------------------------------------------------------------------
   ROUTES
--------------------------------------------------------------------- */

/** 📁 List my uploaded documents */
router.get("/", auth, async (req, res) => {
  try {
    const q = `
      SELECT document_id, owner_user_id, file_name, file_path, mime_type,
             file_size_bytes, is_public, created_at
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

/** 🪶 Document metadata (works for owner, public, private) */
router.get("/:document_id", async (req, res) => {
  try {
    const { document_id } = req.params;
    const d = await pool.query(
      `SELECT * FROM documents WHERE document_id=$1 LIMIT 1`,
      [document_id]
    );
    if (!d.rowCount)
      return res.status(404).json({ error: "Document not found" });

    const access = await resolveAccess(req, document_id);
    if (!access.mode)
      return res.status(403).json({ error: "Not authorized for this document" });

    const doc = d.rows[0];
    const preview_strategy = decidePreviewStrategy({
      mime: doc.mime_type,
      file_name: doc.file_name,
    });

    res.json({
      document_id,
      file_name: doc.file_name,
      mime_type: doc.mime_type,
      file_size_bytes: doc.file_size_bytes,
      preview_strategy,
      view_only: access.mode === "public",
    });
  } catch (err) {
    console.error("DOC_META_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/** ⬆️ Upload new document (owner only) */
router.post("/upload", auth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "File required" });

    const diskRelPath = path.relative(FILE_ROOT, req.file.path);
    const ins = `
      INSERT INTO documents (owner_user_id, file_name, file_path, mime_type, file_size_bytes)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *
    `;
    const { rows } = await pool.query(ins, [
      req.user.user_id,
      req.file.originalname,
      diskRelPath,
      req.file.mimetype || mime.lookup(req.file.originalname) || null,
      req.file.size || null,
    ]);

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

/** 🗑 Delete a document (owner only) */
router.delete("/:document_id", auth, async (req, res) => {
  try {
    const { document_id } = req.params;
    const d = await pool.query(
      `SELECT file_path FROM documents WHERE document_id=$1 AND owner_user_id=$2 LIMIT 1`,
      [document_id, req.user.user_id]
    );
    if (!d.rowCount)
      return res.status(404).json({ error: "Document not found" });

    await pool.query(`DELETE FROM documents WHERE document_id=$1`, [
      document_id,
    ]);

    const abs = path.join(FILE_ROOT, d.rows[0].file_path);
    try {
      fs.unlinkSync(abs);
    } catch {}

    res.json({ success: true });
  } catch (err) {
    console.error("DOC_DELETE_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/** 👁 View/Stream document (owner, public, private verified) */
router.get("/view/:document_id", async (req, res) => {
  try {
    const { document_id } = req.params;
    const { viewOnly, share_token, share_id } = req.query;

    const d = await pool.query(`SELECT * FROM documents WHERE document_id=$1 LIMIT 1`, [document_id]);
    if (!d.rowCount) return res.status(404).json({ error: "Document not found" });

    const doc = d.rows[0];
    const abs = path.join(FILE_ROOT, doc.file_path);

    if (!fs.existsSync(abs)) {
      console.error("MISSING_FILE", { document_id, rel: doc.file_path, abs });
      return res.status(404).json({ error: "File missing on server" });
    }

    // 🔹 Allow if:
    // 1. share_token access valid
    // 2. owner (auth token matches uploader_id)
    // 3. public viewOnly=1 (safe read-only mode)
    let authorized = false;
    if (viewOnly === "1") {
      authorized = true; // ✅ allow public inline viewing only
    } else {
      const access = await resolveAccess(req, document_id);
      if (access.mode) authorized = true;
    }

    if (!authorized) return res.status(403).json({ error: "Not authorized for this document" });

    // Stream inline
    res.setHeader("Cache-Control", "public, max-age=3600");
    streamFileWithRange(
      res,
      abs,
      doc.mime_type || "application/octet-stream",
      cdInline(doc.file_name),
      req.headers.range
    );
  } catch (err) {
    console.error("DOC_VIEW_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/** 💾 Download (owner or private verified only) */
router.get("/download/:document_id", async (req, res) => {
  try {
    const { document_id } = req.params;

    const d = await pool.query(
      `SELECT * FROM documents WHERE document_id=$1 LIMIT 1`,
      [document_id]
    );
    if (!d.rowCount)
      return res.status(404).json({ error: "Document not found" });

    const access = await resolveAccess(req, document_id);
    if (!access.mode)
      return res.status(403).json({ error: "Not authorized to download" });
    if (access.mode === "public")
      return res.status(403).json({ error: "Public shares are view-only" });

    const doc = d.rows[0];
    const abs = path.join(FILE_ROOT, doc.file_path);
    if (!fs.existsSync(abs)) {
      console.error("MISSING_FILE", { document_id, rel: doc.file_path, abs });
      return res.status(404).json({ error: "File missing on server" });
    }

    const mimeType =
      doc.mime_type || mime.lookup(abs) || "application/octet-stream";

    streamFileWithRange(
      res,
      abs,
      mimeType,
      cdAttachment(doc.file_name),
      req.headers.range
    );
  } catch (err) {
    console.error("DOC_DOWNLOAD_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
