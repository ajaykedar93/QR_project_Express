// routes/notify.routes.js
import { Router } from "express";
import path from "path";
import fs from "fs";
import { pool } from "../db/db.js";

// mailer is optional — don't crash if it's not configured
let mailer = null;
try {
  const m = await import("../utils/mailer.js");
  mailer = m.mailer;
} catch (_) {
  // no mailer config; we'll no-op later
}

const router = Router();

// ---------- Public URL helpers ----------
const strip = (u) => (u || "").replace(/\/+$/, "");
const first = (v) => (v || "").split(",")[0].trim();

// LIVE fallbacks (you can still override with env)
const FALLBACK_APP = "https://qr-project-react.vercel.app";   // Vercel (frontend)
const FALLBACK_API = "https://qr-project-v0h4.onrender.com";  // Render (backend)

function getPublicAppBase(req) {
  const envBase = process.env.PUBLIC_APP_URL || process.env.APP_ORIGIN || FALLBACK_APP;
  if (envBase) return strip(envBase);
  const proto = first(req.headers["x-forwarded-proto"]) || req.protocol || "https";
  const host  = first(req.headers["x-forwarded-host"])  || req.get("host") || "";
  return `${proto}://${host}`;
}

function getPublicApiBase(req) {
  const envBase = process.env.PUBLIC_API_URL || process.env.API_BASE || FALLBACK_API;
  if (envBase) return strip(envBase);
  const proto = first(req.headers["x-forwarded-proto"]) || req.protocol || "https";
  const host  = first(req.headers["x-forwarded-host"])  || req.get("host") || "";
  return `${proto}://${host}`;
}

// ------------------------------------------------------------
// POST /notify/share
// body: { share_id }
// Sends an email to shares.to_user_email with link + QR.
// Works for registered & unregistered recipients.
// ------------------------------------------------------------
router.post("/share", async (req, res) => {
  try {
    const { share_id } = req.body || {};
    if (!share_id) return res.status(400).json({ error: "Missing share_id" });

    // Load share + doc + author
    const q = `
      SELECT s.share_id, s.document_id, s.to_user_email, s.access, s.qr_code_path,
             d.file_name,
             u.email AS from_email
      FROM shares s
      JOIN documents d ON d.document_id = s.document_id
      JOIN users u ON u.user_id = s.from_user_id
      WHERE s.share_id = $1
      LIMIT 1`;
    const { rows } = await pool.query(q, [share_id]);
    const share = rows[0];
    if (!share) return res.status(404).json({ error: "Share not found" });
    if (!share.to_user_email) return res.status(400).json({ error: "No recipient email on this share" });

    // Is recipient registered?
    const reg = await pool.query(
      `SELECT user_id FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`,
      [share.to_user_email]
    );
    const isRegistered = !!reg.rowCount;

    // Live bases
    const APP_ORIGIN = getPublicAppBase(req); // e.g. https://qr-project-react.vercel.app
    const API_BASE   = getPublicApiBase(req); // e.g. https://qr-project-v0h4.onrender.com

    // IMPORTANT: use hash route so Vercel SPA handles deep link without rewrites
    const shareLink = `${APP_ORIGIN}/#/share/${share.share_id}`;

    // Prefer the on-demand SVG QR (always available)
    const qrSvgUrl = `${API_BASE}/shares/${share.share_id}/qr.svg`;

    // Build email body
    const lines = [
      `Hi,`,
      ``,
      `${share.from_email} shared a document with you${share.file_name ? `: "${share.file_name}"` : ""}.`,
      `Access link: ${shareLink}`,
      `Access type: ${String(share.access || "").toUpperCase()}`,
      ``,
      share.access === "private"
        ? (isRegistered
            ? `PRIVATE: Please log in with your registered email; you'll receive an OTP to view/download.`
            : `PRIVATE: Please register first with this email, then log in and complete OTP to view/download.`)
        : `PUBLIC: Anyone with the link can view (download disabled).`,
      ``,
      `QR (open or download): ${qrSvgUrl}`,
      ``,
      `Thanks,`,
      `QR-Docs`,
    ];

    // Best-effort PNG attachment if it exists on disk
    const attachments = [];
    if (share.qr_code_path) {
      const abs = path.join(process.cwd(), share.qr_code_path);
      if (fs.existsSync(abs)) {
        attachments.push({ filename: "share-qr.png", path: abs });
      }
    }

    // If mailer isn't configured, don't fail the request
    if (!mailer) {
      return res.json({
        ok: false,
        message: "Email not configured on server; skipped sending",
        preview: {
          to: share.to_user_email,
          subject: `Document shared with you${share.file_name ? ` — ${share.file_name}` : ""}`,
          body: lines.join("\n"),
          qrSvgUrl,
        },
        isRegistered,
      });
    }

    await mailer.sendMail({
      from: process.env.EMAIL_USER || "no-reply@qr-docs",
      to: share.to_user_email,
      subject: `Document shared with you${share.file_name ? ` — ${share.file_name}` : ""}`,
      text: lines.join("\n"),
      attachments,
    });

    res.json({ ok: true, sent_to: share.to_user_email, isRegistered });
  } catch (e) {
    console.error("NOTIFY_SHARE_ERROR:", e);
    res.status(500).json({ error: "Failed to send email" });
  }
});

export default router;
