// routes/auth.routes.js
import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import { pool } from "../db/db.js";
import { auth } from "../middleware/auth.js";
import { sendEmail } from "../utils/mailer.js"; // Yahoo mailer (EMAIL_USER/EMAIL_PASS)
import "dotenv/config";

const router = Router();

/* ------------------------------- Helpers -------------------------------- */

const normalizeStr = (v) => (typeof v === "string" ? v.trim() : "");
const mustEnv = (name, fallback) => {
  const val = process.env[name];
  return val && val.length ? val : fallback ?? "";
};
const validEmail = (email) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
const genOTP = (length = 6) => String(Math.floor(Math.random() * 1_000_000)).padStart(length, "0");
const nowIso = () => new Date().toISOString();

/* -------------------------------- Config -------------------------------- */

const OTP_WINDOW_MIN = Number(mustEnv("OTP_WINDOW_MIN", "10"));
const JWT_SECRET = mustEnv("JWT_SECRET", "dev-secret");
const JWT_EXPIRES_IN = mustEnv("JWT_EXPIRES_IN", "7d");
const FROM_EMAIL = process.env.EMAIL_USER || "noreply@qr-docs.app"; // used in mailer "from" name/address

/* ---------------------------- Rate Limiters ----------------------------- */

const loginLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 50, standardHeaders: true, legacyHeaders: false });
const existsLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
const forgotLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
const resetLimiter  = rateLimit({ windowMs: 10 * 60 * 1000, max: 50, standardHeaders: true, legacyHeaders: false });

/* -------------------------------- Register ------------------------------ */

router.post("/register", async (req, res) => {
  const client = await pool.connect();
  try {
    let { full_name, email, password } = req.body || {};
    full_name = normalizeStr(full_name);
    email = normalizeStr(email);
    const pwd = String(password ?? "");

    if (!full_name || !email || !pwd) return res.status(400).json({ error: "Missing fields" });
    if (!validEmail(email)) return res.status(400).json({ error: "Invalid email" });
    if (pwd.trim().length < 8) return res.status(400).json({ error: "Password too short (min 8)" });

    const password_hash = await bcrypt.hash(pwd, 10);

    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO users (full_name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING user_id, full_name, email, is_verified, created_at`,
      [full_name, email, password_hash]
    );
    const newUser = rows[0];

    // best-effort email (Yahoo mailer)
    sendEmail({
      to: email,
      subject: "Welcome to QR-Docs!",
      html: `<p>Hi <b>${full_name}</b>,</p><p>Welcome to QR-Docs — your secure document sharing platform.</p>`,
    }).catch((e) => console.error("MAILER_ERROR[register]:", e));

    await client.query("COMMIT");
    return res.status(201).json(newUser);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    if (e?.code === "23505") return res.status(409).json({ error: "Email already registered" });
    console.error("REGISTER_ERROR:", e);
    return res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

/* --------------------------------- Login -------------------------------- */

router.post("/login", loginLimiter, async (req, res) => {
  try {
    let { email, password } = req.body || {};
    email = normalizeStr(email);
    const pwd = String(password ?? "");

    if (!email || !pwd.trim()) return res.status(400).json({ error: "Missing email or password" });

    const { rows } = await pool.query(
      `SELECT user_id, full_name, email, password_hash, is_verified, created_at
         FROM users
        WHERE email = $1
        LIMIT 1`,
      [email]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const ok = await bcrypt.compare(pwd, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign({ user_id: user.user_id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    return res.json({
      token,
      user: {
        user_id: user.user_id,
        full_name: user.full_name,
        email: user.email,
        is_verified: user.is_verified,
        created_at: user.created_at,
      },
    });
  } catch (e) {
    console.error("LOGIN_ERROR:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* --------------------------- Check Email Exists ------------------------- */

router.get("/exists", existsLimiter, async (req, res) => {
  try {
    const email = normalizeStr(req.query.email || "");
    if (!email) return res.json({ exists: false });
    const { rowCount } = await pool.query(`SELECT 1 FROM users WHERE email = $1 LIMIT 1`, [email]);
    res.json({ exists: rowCount > 0 });
  } catch (err) {
    console.error("USER_EXISTS_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ------------------------------ Current User ---------------------------- */

router.get("/me", auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT user_id, full_name, email, is_verified, created_at
         FROM users
        WHERE user_id = $1
        LIMIT 1`,
      [req.user.user_id]
    );
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    res.json(rows[0]);
  } catch (e) {
    console.error("ME_ERROR:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* -------------------------- Password Reset (OTP) ------------------------ */
/**
 * We use otp_verifications table (share_id = NULL) for password reset OTPs.
 * To avoid multiple active resets, we proactively invalidate any previous
 * unverified/unexpired password-reset OTPs before inserting a new one.
 */

router.post("/forgot", forgotLimiter, async (req, res) => {
  const email = normalizeStr(req.body?.email || "");

  // Don’t reveal user existence
  if (!email || !validEmail(email)) {
    return res.status(200).json({ message: "If that account exists, an OTP has been sent." });
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT user_id, email, full_name FROM users WHERE email = $1 LIMIT 1`,
      [email]
    );
    const user = rows[0];

    if (user) {
      const otp = genOTP(6);
      const expiry = new Date(Date.now() + OTP_WINDOW_MIN * 60 * 1000);

      await client.query("BEGIN");
      // Invalidate previous active password-reset OTPs (identified by share_id IS NULL)
      await client.query(
        `UPDATE otp_verifications
            SET is_verified = TRUE
          WHERE user_id = $1
            AND share_id IS NULL
            AND is_verified = FALSE
            AND expiry_time > now()`,
        [user.user_id]
      );

      await client.query(
        `INSERT INTO otp_verifications (user_id, share_id, otp_code, expiry_time, is_verified, created_at)
         VALUES ($1, NULL, $2, $3, FALSE, now())`,
        [user.user_id, otp, expiry.toISOString()]
      );
      await client.query("COMMIT");

      // best-effort email (Yahoo mailer)
      sendEmail({
        to: email,
        subject: "Your password reset code",
        html: `<p>Hi${user.full_name ? ` <b>${user.full_name}</b>` : ""},</p>
               <p>Your password reset code is: <b>${otp}</b></p>
               <p>It expires in ${OTP_WINDOW_MIN} minutes.</p>`,
      }).catch((e) => console.error("MAILER_ERROR[forgot]:", e));
    }

    return res.status(200).json({ message: "If that account exists, an OTP has been sent." });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("FORGOT_ERROR:", e);
    return res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

router.post("/reset/verify", resetLimiter, async (req, res) => {
  try {
    const email = normalizeStr(req.body?.email || "");
    const otp = normalizeStr(req.body?.otp || "");
    if (!email || !otp) return res.status(400).json({ error: "Missing email or otp" });

    const { rows } = await pool.query(`SELECT user_id FROM users WHERE email = $1 LIMIT 1`, [email]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: "Invalid or expired code" });

    const { rows: otpRows } = await pool.query(
      `SELECT otp_id, expiry_time, is_verified
         FROM otp_verifications
        WHERE user_id = $1
          AND share_id IS NULL
          AND otp_code = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [user.user_id, otp]
    );
    const rec = otpRows[0];

    if (!rec || rec.is_verified || new Date(rec.expiry_time) < new Date()) {
      return res.status(404).json({ error: "Invalid or expired code" });
    }

    // Mark as verified (so it can't be reused blindly)
    await pool.query(`UPDATE otp_verifications SET is_verified = TRUE WHERE otp_id = $1`, [rec.otp_id]);

    return res.json({ ok: true });
  } catch (e) {
    console.error("RESET_VERIFY_ERROR:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/reset", resetLimiter, async (req, res) => {
  const email = normalizeStr(req.body?.email || "");
  const otp = normalizeStr(req.body?.otp || "");
  const newPassword = String(req.body?.new_password ?? "").trim();

  if (!email || !otp || !newPassword) return res.status(400).json({ error: "Missing fields" });
  if (newPassword.length < 8) return res.status(400).json({ error: "Password too short (min 8)" });

  const client = await pool.connect();
  try {
    const { rows } = await client.query(`SELECT user_id FROM users WHERE email = $1 LIMIT 1`, [email]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: "Invalid or expired code" });

    // Accept either: (a) already-verified OTP from /reset/verify OR (b) a fresh valid OTP by code
    const { rows: otpRows } = await client.query(
      `SELECT otp_id, expiry_time, is_verified
         FROM otp_verifications
        WHERE user_id = $1
          AND share_id IS NULL
          AND otp_code = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [user.user_id, otp]
    );
    const rec = otpRows[0];
    if (!rec) return res.status(404).json({ error: "Invalid or expired code" });
    if (new Date(rec.expiry_time) < new Date()) return res.status(404).json({ error: "Invalid or expired code" });

    const password_hash = await bcrypt.hash(newPassword, 10);

    await client.query("BEGIN");

    // Update password
    await client.query(`UPDATE users SET password_hash = $1 WHERE user_id = $2`, [password_hash, user.user_id]);

    // Consume this OTP and invalidate any other active password-reset OTPs
    await client.query(`UPDATE otp_verifications SET is_verified = TRUE WHERE otp_id = $1`, [rec.otp_id]);
    await client.query(
      `UPDATE otp_verifications
          SET is_verified = TRUE
        WHERE user_id = $1
          AND share_id IS NULL
          AND expiry_time > now()
          AND is_verified = FALSE`,
      [user.user_id]
    );

    await client.query("COMMIT");

    // best-effort notify (Yahoo mailer)
    sendEmail({
      to: email,
      subject: "Your password has been updated",
      html: `<p>Your password was changed successfully at ${nowIso()}.</p><p>If this wasn't you, contact support immediately.</p>`,
    }).catch((e) => console.error("MAILER_ERROR[reset notify]:", e));

    return res.json({ message: "Password updated successfully" });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("RESET_ERROR:", e);
    return res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

export default router;
