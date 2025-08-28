import { Router } from "express";
import { pool } from "../db/db.js";
import { auth } from "../middleware/auth.js";
import QRCode from "qrcode";
import path from "path";
import fs from "fs";
import dayjs from "dayjs";

// OPTIONAL mailer
let mailer = null;
try {
  const m = await import("../utils/mailer.js");
  mailer = m.mailer;
} catch {}

const router = Router();

// Live bases (env first, then fallbacks)
const FALLBACK_APP = "https://qr-project-react.vercel.app";   // Vercel
const FALLBACK_API = "https://qr-project-v0h4.onrender.com";  // Render

const strip = (u) => (u || "").replace(/\/+$/, "");
const first = (v) => (v || "").split(",")[0].trim();

function getPublicAppBase(req) {
  const envBase = process.env.PUBLIC_APP_URL || FALLBACK_APP;
  if (envBase) return strip(envBase);
  const proto = first(req.headers["x-forwarded-proto"]) || req.protocol || "https";
  const host  = first(req.headers["x-forwarded-host"])  || req.get("host") || "";
  return `${proto}://${host}`;
}

function getPublicApiBase(req) {
  const envBase = process.env.PUBLIC_API_URL || FALLBACK_API;
  if (envBase) return strip(envBase);
  const proto = first(req.headers["x-forwarded-proto"]) || req.protocol || "https";
  const host  = first(req.headers["x-forwarded-host"])  || req.get("host") || "";
  return `${proto}://${host}`;
}

// QR output dir
const QR_DIR = path.join(process.cwd(), "qrcodes");
if (!fs.existsSync(QR_DIR)) fs.mkdirSync(QR_DIR, { recursive: true });

/** POST /shares/create */
router.post("/create", auth, async (req, res) => {
  try {
    let { document_id, to_user_email, access = "private", expiry_time } = req.body || {};
    if (!document_id) return res.status(400).json({ error: "document_id required" });
    if (!["private", "public"].includes(access)) return res.status(400).json({ error: "invalid access" });

    // validate doc ownership
    const d = await pool.query(
      `SELECT document_id, file_name FROM documents WHERE document_id=$1 AND owner_user_id=$2 LIMIT 1`,
      [document_id, req.user.user_id]
    );
    const doc = d.rows[0];
    if (!doc) return res.status(404).json({ error: "Document not found" });

    // recipient existence
    let recipientExists = false;
    let to_user_id = null;
    let toEmailNorm = null;
    if (to_user_email && String(to_user_email).trim()) {
      toEmailNorm = String(to_user_email).trim();
      const r = await pool.query(
        `SELECT user_id FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`,
        [toEmailNorm]
      );
      if (r.rowCount) {
        recipientExists = true;
        to_user_id = r.rows[0].user_id;
      }
    }

    // expiry
    let expirySql = null;
    if (expiry_time) {
      const dt = dayjs(expiry_time);
      if (dt.isValid()) expirySql = dt.toISOString();
    }

    // create share
    const ins = `
      INSERT INTO shares (document_id, from_user_id, to_user_id, to_user_email, access, expiry_time)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *`;
    const { rows } = await pool.query(ins, [
      document_id,
      req.user.user_id,
      to_user_id,
      toEmailNorm,
      access,
      expirySql,
    ]);
    const share = rows[0];

    const APP_ORIGIN = getPublicAppBase(req); // Vercel URL
    const API_BASE   = getPublicApiBase(req); // Render URL

   
    
// AFTER (hash route so no server rewrite needed)
const shareUrl = `${APP_ORIGIN}/#/share/${share.share_id}`;
    const qrPath = path.join(QR_DIR, `${share.share_id}.png`);
    await QRCode.toFile(qrPath, shareUrl, {
      width: 600,
      margin: 3,
      errorCorrectionLevel: "H",
      color: { dark: "#000000", light: "#FFFFFFFF" },
    });

    const relQrPath = `qrcodes/${path.basename(qrPath)}`;
    const upd = await pool.query(
      `UPDATE shares SET qr_code_path=$1 WHERE share_id=$2 RETURNING *`,
      [relQrPath, share.share_id]
    );
    const saved = upd.rows[0];

    // optional email notify
    if (mailer && toEmailNorm) {
      const lines = [
        `Hi,`,
        ``,
        `${req.user.email} shared a document with you${doc.file_name ? `: "${doc.file_name}"` : ""}.`,
        `Access link: ${shareUrl}`,
        `Access type: ${access.toUpperCase()}`,
        ``,
        access === "private"
          ? (recipientExists
              ? `PRIVATE: Please login with your registered email; you'll receive an OTP to view/download.`
              : `PRIVATE: Please register first with this email, then login and complete OTP to view/download.`)
          : `PUBLIC: Anyone with the link can view (download disabled).`,
        ``,
        `You can also scan the attached QR image or open: ${API_BASE}/${relQrPath}`.replace(/(?<!:)\/\/+/g, "/"),
        ``,
        `Thanks,`,
        `QR-Docs`,
      ].join("\n");

      const abs = path.join(process.cwd(), relQrPath);
      const attachments = fs.existsSync(abs) ? [{ filename: "share-qr.png", path: abs }] : [];
      try {
        await mailer.sendMail({
          from: process.env.EMAIL_USER || "no-reply@qr-docs",
          to: toEmailNorm,
          subject: `Document shared with you${doc.file_name ? ` — ${doc.file_name}` : ""}`,
          text: lines,
          attachments,
        });
      } catch (mailErr) {
        console.warn("MAIL_SEND_WARN:", mailErr?.message || mailErr);
      }
    }

    const absolute_qr_url = `${strip(getPublicApiBase(req))}/${relQrPath}`.replace(/(?<!:)\/\/+/g, "/");
    return res.json({ share: { ...saved, absolute_qr_url }, recipientExists });
  } catch (e) {
    console.error("SHARE_CREATE_ERROR:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/** GET /shares/:id/qr.svg — vector QR (frontend link) */
router.get("/:id/qr.svg", async (req, res) => {
  try {
    const { id } = req.params;
    const chk = await pool.query(`SELECT 1 FROM shares WHERE share_id=$1 LIMIT 1`, [id]);
    if (chk.rowCount === 0) return res.status(404).send("Not found");

    const APP_ORIGIN = getPublicAppBase(req);
    const shareUrl = `${APP_ORIGIN}/share/${id}`;

    const svg = await QRCode.toString(shareUrl, {
      type: "svg",
      errorCorrectionLevel: "H",
      margin: 3,
      width: 512,
      color: { dark: "#000000", light: "#FFFFFF" },
    });

    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.status(200).send(svg);
  } catch (e) {
    console.error("QR_SVG_ERROR:", e);
    return res.status(500).send("QR generation failed");
  }
});

/** GET /shares/mine */
router.get("/mine", auth, async (req, res) => {
  try {
    const q = `
      SELECT s.*, d.file_name
      FROM shares s
      JOIN documents d ON d.document_id = s.document_id
      WHERE s.from_user_id = $1
      ORDER BY s.created_at DESC`;
    const { rows } = await pool.query(q, [req.user.user_id]);
    res.json(rows);
  } catch (e) {
    console.error("SHARE_MINE_ERROR:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/** GET /shares/received */
router.get("/received", auth, async (req, res) => {
  try {
    const q = `
      SELECT s.*, d.file_name
      FROM shares s
      JOIN documents d ON d.document_id = s.document_id
      WHERE s.to_user_id = $1
         OR (s.to_user_email IS NOT NULL AND LOWER(s.to_user_email)=LOWER($2))
      ORDER BY s.created_at DESC`;
    const { rows } = await pool.query(q, [req.user.user_id, req.user.email]);
    res.json(rows);
  } catch (e) {
    console.error("SHARE_RECEIVED_ERROR:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/** GET /shares/:id/minimal — used by ShareAccess */
router.get("/:id/minimal", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const q = `
      SELECT s.share_id, s.document_id, s.access, s.expiry_time
      FROM shares s
      WHERE s.share_id = $1
      LIMIT 1`;
    const { rows } = await pool.query(q, [id]);
    const share = rows[0];
    if (!share) return res.status(404).json({ error: "Not found" });
    res.json(share);
  } catch (e) {
    console.error("SHARE_MINIMAL_ERROR:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/** GET /shares/:id — full (if needed) */
router.get("/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const q = `
      SELECT s.*, d.file_name, d.mime_type, d.file_path
      FROM shares s
      JOIN documents d ON d.document_id = s.document_id
      WHERE s.share_id = $1
      LIMIT 1`;
    const { rows } = await pool.query(q, [id]);
    const share = rows[0];
    if (!share) return res.status(404).json({ error: "Not found" });
    res.json(share);
  } catch (e) {
    console.error("SHARE_GET_ERROR:", e);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /shares/:id  (owner can revoke)
router.delete("/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    // ensure the share belongs to the requester
    const chk = await pool.query(
      `SELECT share_id FROM shares WHERE share_id=$1 AND from_user_id=$2`,
      [id, req.user.user_id]
    );
    if (!chk.rowCount) return res.status(404).json({ error: "Share not found" });

    await pool.query(`DELETE FROM shares WHERE share_id=$1`, [id]);
    return res.json({ success: true });
  } catch (e) {
    console.error("SHARE_DELETE_ERROR:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/** GET /shares/:id/qr.svg — vector QR (frontend link) */
router.get("/:id/qr.svg", async (req, res) => {
  try {
    const { id } = req.params;

    const chk = await pool.query(`SELECT 1 FROM shares WHERE share_id=$1 LIMIT 1`, [id]);
    if (chk.rowCount === 0) return res.status(404).send("Not found");

    const APP_ORIGIN = getPublicAppBase(req);

    // 🔴 OLD (breaks on Vercel deep link)
    // const shareUrl = `${APP_ORIGIN}/share/${id}`;

    // 🟢 NEW: use the HASH route so the SPA can handle it without rewrites
    const shareUrl = `${APP_ORIGIN}/#/share/${id}`;

    const svg = await QRCode.toString(shareUrl, {
      type: "svg",
      errorCorrectionLevel: "H",
      margin: 3,
      width: 512,
      color: { dark: "#000000", light: "#FFFFFF" },
    });

    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.status(200).send(svg);
  } catch (e) {
    console.error("QR_SVG_ERROR:", e);
    return res.status(500).send("QR generation failed");
  }
});



export default router;
