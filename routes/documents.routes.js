// routes/documents.routes.js
import { Router } from "express";
import path from "node:path";
import fs from "node:fs";
import multer from "multer";
import { pool } from "../db/db.js";
import { auth } from "../middleware/auth.js";
import { upload, FILE_ROOT } from "../middleware/upload.js";

const router = Router();

// Content-Disposition helpers
function cdInline(fileName) {
  const safe = (fileName || "file").replace(/"/g, "'");
  return `inline; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(fileName || "file")}`;
}
function cdAttachment(fileName) {
  const safe = (fileName || "file").replace(/"/g, "'");
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(fileName || "file")}`;
}

// Preview strategy
function decidePreviewStrategy({ mime = "", file_name = "" }) {
  const ext = (path.extname(file_name || "").slice(1) || "").toLowerCase();
  if (/^application\/pdf$/i.test(mime) || ext === "pdf") return "pdf";
  if (/^image\//i.test(mime)) return "image";
  if (/^text\//i.test(mime) || /(json|xml|yaml)/i.test(mime) || ["txt", "md", "json", "xml", "yaml", "yml", "csv", "log"].includes(ext)) return "text";
  if (/^audio\//i.test(mime)) return "audio";
  if (/^video\//i.test(mime)) return "video";
  if (/(msword|officedocument|excel|powerpoint)/i.test(mime) || ["doc", "docx", "ppt", "pptx", "xls", "xlsx"].includes(ext)) return "office";
  return "other";
}

// Range streaming
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
   LIST DOCUMENTS
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
   GET META
============================================================ */
router.get("/:document_id", async (req, res) => {
  try {
    const { document_id } = req.params;
    const d = await pool.query(`SELECT * FROM documents WHERE document_id=$1 LIMIT 1`, [document_id]);
    if (!d.rowCount) return res.status(404).json({ error: "Document not found" });

    const doc = d.rows[0];
    const preview_strategy = decidePreviewStrategy({ mime: doc.mime_type, file_name: doc.file_name });

    res.json({
      document_id,
      file_name: doc.file_name,
      mime_type: doc.mime_type,
      file_size_bytes: doc.file_size_bytes,
      preview_strategy,
    });
  } catch (err) {
    console.error("DOC_META_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ============================================================
   UPLOAD DOCUMENT
============================================================ */
router.post("/upload", auth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "file required" });

    // Save relative path (so subfolder structure is preserved)
    const diskRelPath = path.relative(FILE_ROOT, req.file.path);

    const ins = `
      INSERT INTO documents (owner_user_id, file_name, file_path, mime_type, file_size_bytes)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING document_id, owner_user_id, file_name, file_path, mime_type, file_size_bytes, is_public, created_at
    `;
    const { rows } = await pool.query(ins, [
      req.user.user_id,
      req.file.originalname,
      diskRelPath,
      req.file.mimetype || null,
      req.file.size || null,
    ]);

    const saved = rows[0];
    const preview_strategy = decidePreviewStrategy({ mime: saved.mime_type, file_name: saved.file_name });
    res.status(201).json({ ...saved, preview_strategy });
  } catch (err) {
    console.error("DOC_UPLOAD_ERROR:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

/* ============================================================
   DELETE DOCUMENT
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

    const abs = path.join(FILE_ROOT, d.rows[0].file_path);
    try { fs.unlinkSync(abs); } catch {}
    res.json({ success: true });
  } catch (err) {
    console.error("DOC_DELETE_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ============================================================
   VIEW DOCUMENT
============================================================ */
router.get("/view/:document_id", async (req, res) => {
  try {
    const { document_id } = req.params;
    const d = await pool.query(`SELECT * FROM documents WHERE document_id=$1 LIMIT 1`, [document_id]);
    if (!d.rowCount) return res.status(404).json({ error: "Document not found" });

    const doc = d.rows[0];
    const abs = path.join(FILE_ROOT, doc.file_path);

    if (!fs.existsSync(abs)) {
      console.error("MISSING_FILE", { document_id, rel: doc.file_path, abs, FILE_ROOT });
      return res.status(404).json({ error: "File missing on server" });
    }

    streamFileWithRange(res, abs, doc.mime_type || "application/octet-stream", cdInline(doc.file_name), req.headers.range);
  } catch (err) {
    console.error("DOC_VIEW_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ============================================================
   DOWNLOAD DOCUMENT
============================================================ */
router.get("/download/:document_id", async (req, res) => {
  try {
    const { document_id } = req.params;
    const d = await pool.query(`SELECT * FROM documents WHERE document_id=$1 LIMIT 1`, [document_id]);
    if (!d.rowCount) return res.status(404).json({ error: "Document not found" });

    const doc = d.rows[0];
    const abs = path.join(FILE_ROOT, doc.file_path);

    if (!fs.existsSync(abs)) {
      console.error("MISSING_FILE", { document_id, rel: doc.file_path, abs, FILE_ROOT });
      return res.status(404).json({ error: "File missing on server" });
    }

    streamFileWithRange(res, abs, doc.mime_type || "application/octet-stream", cdAttachment(doc.file_name), req.headers.range);
  } catch (err) {
    console.error("DOC_DOWNLOAD_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
