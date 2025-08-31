// routes/documents.routes.js
import { Router } from "express";
import path from "path";
import fs from "fs";
import { pool } from "../db/db.js";
import { auth } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import { streamFile, canAccess } from "../utils/access.js"; // move helpers here

const router = Router();

/** GET /documents — list my uploads */
router.get("/", auth, async (req, res) => {
  const q = `
    SELECT * FROM documents
    WHERE owner_user_id = $1
    ORDER BY created_at DESC
  `;
  const { rows } = await pool.query(q, [req.user.user_id]);
  res.json(rows);
});

/** POST /documents/upload */
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

/** DELETE /documents/:id */
router.delete("/:id", auth, async (req, res) => {
  const { id } = req.params;
  const find = await pool.query(
    `SELECT file_path FROM documents WHERE document_id=$1 AND owner_user_id=$2`,
    [id, req.user.user_id]
  );
  const doc = find.rows[0];
  if (!doc) return res.status(404).json({ error: "Not found" });

  try {
    const abs = path.join(process.cwd(), doc.file_path);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch (_) {}

  await pool.query(`DELETE FROM documents WHERE document_id=$1`, [id]);
  res.json({ success: true });
});

/** GET /documents/received */
router.get("/received", auth, async (req, res) => {
  const q = `
    SELECT s.share_id, s.access, s.expiry_time, d.document_id, d.file_name,
           d.mime_type, d.file_size_bytes, u.full_name AS from_full_name, u.email AS from_email
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

/** GET /documents/view/:id */
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

    streamFile(res, path.join(process.cwd(), doc.file_path), {
      mime: doc.mime_type,
      filename: doc.file_name,
      inline: true,
    });
  } catch (e) {
    console.error("VIEW_ERROR:", e);
    res.status(500).send("Unable to open document");
  }
});

/** GET /documents/download/:id */
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

    streamFile(res, path.join(process.cwd(), doc.file_path), {
      mime: doc.mime_type,
      filename: doc.file_name,
      inline: false,
    });
  } catch (e) {
    console.error("DOWNLOAD_ERROR:", e);
    res.status(500).send("Download failed");
  }
});

export default router;
