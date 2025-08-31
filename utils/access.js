// utils/access.js
import fs from "fs";
import path from "path";
import dayjs from "dayjs";
import { pool } from "../db/db.js";

/** Expose headers for frontend (so axios can read filename/type/size) */
export function exposeHeaders(res) {
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Disposition, Content-Type, Content-Length, Accept-Ranges"
  );
}

/** Stream file with proper headers */
export function streamFile(res, absPath, { mime, filename, inline = true }) {
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
 * Access check for shares (public/private).
 * @param {Object} opts
 * @param {string} opts.document_id
 * @param {string} opts.share_id
 * @param {string} opts.share_token
 * @param {boolean} opts.wantDownload
 * @param {string} opts.user_email
 */
export async function canAccess({ document_id, share_id, share_token, wantDownload, user_email }) {
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

  // PUBLIC: view allowed, download blocked
  if (sh.access === "public") {
    if (wantDownload) return { ok: false, msg: "Public shares are view-only" };
    return { ok: true, share: sh };
  }

  // PRIVATE: needs OTP
  if (!user_email) return { ok: false, msg: "Email required for private share" };

  const ures = await pool.query(`SELECT user_id FROM users WHERE email = $1 LIMIT 1`, [String(user_email).trim()]);
  if (!ures.rowCount) return { ok: false, msg: "User must register first" };
  const viewerUserId = ures.rows[0].user_id;

  if (sh.to_user_id && String(sh.to_user_id) !== String(viewerUserId)) {
    return { ok: false, msg: "Not the intended recipient" };
  }
  if (!sh.to_user_id && sh.to_user_email) {
    if (String(sh.to_user_email).toLowerCase() !== String(user_email).toLowerCase()) {
      return { ok: false, msg: "Not the intended recipient" };
    }
  }

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
