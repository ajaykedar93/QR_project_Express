// routes/documents.routes.js
import { Router } from "express";
import path from "path";
import fs from "fs";
import { pool } from "../db/db.js";
import { auth } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import dayjs from "dayjs";

const router = Router();

/** CORS: expose headers so frontend can read filename/type/size via axios */
function exposeHeaders(res) {
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Disposition, Content-Type, Content-Length, Accept-Ranges"
  );
}

/** helper: check access for view/download via share_id */
async function canAccess({ document_id, share_id, wantDownload, user_id }) {
  if (!share_id) return { ok: false, msg: "Missing share_id" };

  const s = await pool.query(
    `SELECT access, document_id, expiry_time FROM shares WHERE share_id=$1`,
    [share_id]
  );
  if (!s.rowCount) return { ok: false, msg: "Share not found" };
  const sh = s.rows[0];

  if (String(sh.document_id) !== String(document_id)) {
    return { ok: false, msg: "Share/document mismatch" };
  }
  if (sh.expiry_time && dayjs(sh.expiry_time).isBefore(dayjs())) {
    return { ok: false, msg: "Share expired" };
  }

  if (sh.access === "public") {
    if (wantDownload) return { ok: false, msg: "Public shares are view-only" };
    return { ok: true };
  }

  // private: need verified OTP for this share + user
  const v = await pool.query(
    `SELECT 1 FROM otp_verifications 
      WHERE share_id=$1 AND user_id=$2 AND is_verified=TRUE 
      ORDER BY created_at DESC LIMIT 1`,
    [share_id, user_id || null]
  );
  if (!v.rowCount) return { ok: false, msg: "OTP verification required" };
  return { ok: true };
}

/** GET /documents — list my uploads */
router.get("/", auth, async (req, res) => {
  const q = `SELECT * FROM documents WHERE owner_user_id=$1 ORDER BY created_at DESC`;
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
    RETURNING *`;
  const { rows } = await pool.query(q, [
    req.user.user_id,
    originalname,
    filePath,
    mimetype,
    size,
  ]);
  res.json(rows[0]);
});

/** DELETE /documents/:id — delete my file */
router.delete("/:id", auth, async (req, res) => {
  const { id } = req.params;
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

/** Shared stream helper (adds headers + streams file) */
function streamFile(res, absPath, { mime, filename, inline = true }) {
  exposeHeaders(res);

  // Basic stat for size
  const st = fs.statSync(absPath);
  const size = st.size;

  // Content headers
  res.setHeader("Content-Type", mime || "application/octet-stream");

  // RFC 5987 filename* + legacy filename=
  const safe = encodeURIComponent(filename || path.basename(absPath));
  const dispType = inline ? "inline" : "attachment";
  res.setHeader(
    "Content-Disposition",
    `${dispType}; filename="${safe}"; filename*=UTF-8''${safe}`
  );
  res.setHeader("Content-Length", String(size));
  res.setHeader("Accept-Ranges", "bytes");
  // Preview files should generally not be cached too aggressively for private content
  res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");

  // NOTE: minimal range support (serves full for simplicity).
  // If you need true scrubbing for big videos, implement Range parsing here.

  fs.createReadStream(absPath).pipe(res);
}

/** GET /documents/view/:id?share_id=... — inline view (public OK, private needs OTP) */
router.get("/view/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { share_id } = req.query;

    const dres = await pool.query(`SELECT * FROM documents WHERE document_id=$1`, [id]);
    const doc = dres.rows[0];
    if (!doc) return res.status(404).send("Not found");

    const user_id = req.headers["x-user-id"] || null;
    const check = await canAccess({ document_id: id, share_id, wantDownload: false, user_id });
    if (!check.ok) return res.status(403).send(check.msg);

    const abs = path.join(process.cwd(), doc.file_path);
    if (!fs.existsSync(abs)) return res.status(404).send("File missing");

    streamFile(res, abs, { mime: doc.mime_type, filename: doc.file_name, inline: true });
  } catch (e) {
    console.error("VIEW_ERROR:", e);
    // Keep it text so the iframe shows a readable error
    res.status(500).send("Unable to open document");
  }
});

/** GET /documents/download/:id?share_id=... — download (private+OTP only) */
router.get("/download/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { share_id } = req.query;

    const dres = await pool.query(`SELECT * FROM documents WHERE document_id=$1`, [id]);
    const doc = dres.rows[0];
    if (!doc) return res.status(404).send("Not found");

    const user_id = req.headers["x-user-id"] || null;
    const check = await canAccess({ document_id: id, share_id, wantDownload: true, user_id });
    if (!check.ok) return res.status(403).send(check.msg);

    const abs = path.join(process.cwd(), doc.file_path);
    if (!fs.existsSync(abs)) return res.status(404).send("File missing");

    streamFile(res, abs, { mime: doc.mime_type, filename: doc.file_name, inline: false });
  } catch (e) {
    console.error("DOWNLOAD_ERROR:", e);
    res.status(500).send("Download failed");
  }
});

export default router;
