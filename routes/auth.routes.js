// routes/auth.routes.js
import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import { pool } from "../db/db.js";
import { auth } from "../middleware/auth.js";
import { mailer } from "../utils/mailer.js"; // Nodemailer transport (has sendMail)

const router = Router();

/* ----------------------------- Helpers ----------------------------- */
function normalizeStr(v) {
  return typeof v === "string" ? v.trim() : "";
}
function mustEnv(name, fallback) {
  const val = process.env[name];
  return val && val.length ? val : (fallback ?? "");
}
function validEmail(email) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}
function genOTP(length = 6) {
  const n = Math.floor(Math.random() * 1_000_000);
  return n.toString().padStart(length, "0");
}

/* ----------------------------- Config ----------------------------- */
const OTP_WINDOW_MIN = Number(mustEnv("OTP_WINDOW_MIN", "10")); // minutes
const FROM_EMAIL = mustEnv("EMAIL_FROM", process.env.EMAIL_USER); // fallback to Gmail user

/* ----------------------------- Rate limits ----------------------------- */
const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
});
const existsLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
const forgotLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});
const resetLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
});

/* ----------------------------- POST /auth/register ----------------------------- */
/**
 * body: { full_name, email, password }
 * 201 -> { user_id, full_name, email, is_verified, created_at }
 */
router.post("/register", async (req, res) => {
  const client = await pool.connect();
  try {
    let { full_name, email, password } = req.body || {};
    full_name = normalizeStr(full_name);
    email = normalizeStr(email);
    const pwd = String(password ?? "");

    if (!full_name || !email || !pwd) {
      return res.status(400).json({ error: "Missing full_name, email or password" });
    }
    if (!validEmail(email)) {
      return res.status(400).json({ error: "Invalid email" });
    }
    if (pwd.trim().length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const password_hash = await bcrypt.hash(pwd, 10);

    await client.query("BEGIN");

    const insertSql = `
      INSERT INTO users (full_name, email, password_hash)
      VALUES ($1, $2, $3)
      RETURNING user_id, full_name, email, is_verified, created_at
    `;
    const { rows } = await client.query(insertSql, [full_name, email, password_hash]);
    const newUser = rows[0];

    // Safety backfill for pending shares (optional)
    await client.query(
      `
        UPDATE shares
           SET to_user_id = $1
         WHERE to_user_id IS NULL
           AND to_user_email IS NOT NULL
           AND LOWER(to_user_email) = LOWER($2)
      `,
      [newUser.user_id, newUser.email]
    );

    await client.query("COMMIT");
    return res.status(201).json(newUser);
  } catch (e) {
    await client.query("ROLLBACK");
    if (e?.code === "23505") {
      return res.status(409).json({ error: "Email already registered" });
    }
    console.error("REGISTER_ERROR:", e);
    return res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

/* ----------------------------- POST /auth/login ----------------------------- */
/**
 * body: { email, password }
 * 200 -> { token, user:{ user_id, full_name, email, is_verified, created_at } }
 */
router.post("/login", loginLimiter, async (req, res) => {
  try {
    let { email, password } = req.body || {};
    email = normalizeStr(email);
    const pwd = String(password ?? "");

    if (!email || !pwd.trim()) {
      return res.status(400).json({ error: "Missing email or password" });
    }

    const q = `
      SELECT user_id, full_name, email, password_hash, is_verified, created_at
      FROM users
      WHERE email = $1
      LIMIT 1
    `;
    const { rows } = await pool.query(q, [email]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const ok = await bcrypt.compare(pwd, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const secret = mustEnv("JWT_SECRET", "dev-secret");
    if (secret === "dev-secret") {
      console.warn("⚠️ JWT_SECRET is not set. Using a development fallback.");
    }
    const token = jwt.sign(
      { user_id: user.user_id, email: user.email },
      secret,
      { expiresIn: mustEnv("JWT_EXPIRES_IN", "7d") }
    );

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

/* ----------------------------- GET /auth/exists ----------------------------- */
/**
 * query: ?email=...
 * 200 -> { exists: boolean }
 */
router.get("/exists", existsLimiter, async (req, res) => {
  try {
    const email = normalizeStr(req.query.email || "");
    if (!email) return res.json({ exists: false });

    const r = await pool.query(`SELECT 1 FROM users WHERE email = $1 LIMIT 1`, [email]);
    res.json({ exists: r.rowCount > 0 });
  } catch (err) {
    console.error("USER_EXISTS_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ----------------------------- GET /auth/me ----------------------------- */
/**
 * header: Authorization: Bearer <token>
 * 200 -> { user_id, full_name, email, is_verified, created_at }
 */
router.get("/me", auth, async (req, res) => {
  try {
    const q = `
      SELECT user_id, full_name, email, is_verified, created_at
      FROM users
      WHERE user_id = $1
      LIMIT 1
    `;
    const { rows } = await pool.query(q, [req.user.user_id]);
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    res.json(rows[0]);
  } catch (e) {
    console.error("ME_ERROR:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* --------------------- POST /auth/forgot (send OTP) --------------------- */
/**
 * body: { email }
 * 200 -> { message: "If that account exists, an OTP has been sent." }
 *
 * Note: Responds generically to avoid account enumeration.
 */
router.post("/forgot", forgotLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    const email = normalizeStr(req.body?.email || "");
    if (!email || !validEmail(email)) {
      return res.status(200).json({ message: "If that account exists, an OTP has been sent." });
    }

    const { rows } = await client.query(
      `SELECT user_id, email FROM users WHERE email = $1 LIMIT 1`,
      [email]
    );

    // Always behave the same regardless of existence
    const otp = genOTP(6);
    const expiry = new Date(Date.now() + OTP_WINDOW_MIN * 60 * 1000);

    if (rows.length) {
      await client.query(
        `UPDATE users
           SET reset_token = $1,
               reset_token_expiry = $2
         WHERE user_id = $3`,
        [otp, expiry.toISOString(), rows[0].user_id]
      );

      // Send email using nodemailer transport
      try {
        await mailer.sendMail({
          from: FROM_EMAIL,
          to: email,
          subject: "Your password reset code",
          text: `Your password reset code is: ${otp}\nThis code expires in ${OTP_WINDOW_MIN} minutes.\nIf you didn't request this, ignore this email.`,
          html: `
            <div style="font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;max-width:520px">
              <h2 style="margin:0 0 8px">Password reset code</h2>
              <p style="margin:0 0 12px;color:#444">Use the code below to continue. It expires in <b>${OTP_WINDOW_MIN} minutes</b>.</p>
              <div style="font-size:32px;letter-spacing:6px;font-weight:800;background:#f6f7ff;border:1px solid #e4e6ff;border-radius:12px;padding:14px 18px;text-align:center;margin:10px 0 14px">
                ${otp}
              </div>
              <p style="color:#666;margin:0">If you didn’t request this, you can safely ignore this email.</p>
            </div>
          `,
        });
      } catch (mailErr) {
        console.error("MAILER_ERROR[forgot]:", mailErr);
        // do not leak to client
      }
    }

    return res.status(200).json({ message: "If that account exists, an OTP has been sent." });
  } catch (e) {
    console.error("FORGOT_ERROR:", e);
    return res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

/* ------------------ POST /auth/reset/verify (check OTP) ------------------ */
/**
 * body: { email, otp }
 * 200 -> { ok: true }   // if valid & not expired
 * 400/404 -> error
 */
router.post("/reset/verify", resetLimiter, async (req, res) => {
  try {
    const email = normalizeStr(req.body?.email || "");
    const otp = normalizeStr(req.body?.otp || "");

    if (!email || !otp) {
      return res.status(400).json({ error: "Missing email or otp" });
    }

    const { rows } = await pool.query(
      `SELECT user_id, reset_token, reset_token_expiry
         FROM users
        WHERE email = $1
        LIMIT 1`,
      [email]
    );
    const user = rows[0];
    if (!user || !user.reset_token || !user.reset_token_expiry) {
      return res.status(404).json({ error: "Invalid or expired code" });
    }

    const now = new Date();
    const exp = new Date(user.reset_token_expiry);
    if (user.reset_token !== otp || now > exp) {
      return res.status(404).json({ error: "Invalid or expired code" });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("RESET_VERIFY_ERROR:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ------------------ POST /auth/reset (verify & update) ------------------- */
/**
 * body: { email, otp, new_password }
 * 200 -> { message: "Password updated" }
 */
router.post("/reset", resetLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    const email = normalizeStr(req.body?.email || "");
    const otp = normalizeStr(req.body?.otp || "");
    const newPassword = String(req.body?.new_password ?? "");

    if (!email || !otp || !newPassword.trim()) {
      return res.status(400).json({ error: "Missing email, otp, or new_password" });
    }
    if (newPassword.trim().length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const { rows } = await client.query(
      `SELECT user_id, reset_token, reset_token_expiry
         FROM users
        WHERE email = $1
        LIMIT 1`,
      [email]
    );
    const user = rows[0];
    if (!user || !user.reset_token || !user.reset_token_expiry) {
      return res.status(404).json({ error: "Invalid or expired code" });
    }

    const now = new Date();
    const exp = new Date(user.reset_token_expiry);
    if (user.reset_token !== otp || now > exp) {
      return res.status(404).json({ error: "Invalid or expired code" });
    }

    const password_hash = await bcrypt.hash(newPassword, 10);

    await client.query("BEGIN");
    await client.query(
      `UPDATE users
          SET password_hash = $1,
              reset_token = NULL,
              reset_token_expiry = NULL
        WHERE user_id = $2`,
      [password_hash, user.user_id]
    );
    await client.query("COMMIT");

    // Optional: notify success (non-sensitive)
    try {
      await mailer.sendMail({
        from: FROM_EMAIL,
        to: email,
        subject: "Your password has been updated",
        text:
          "Your password was changed successfully. If this wasn't you, please contact support immediately.",
        html:
          "<p>Your password was changed successfully.</p><p>If this wasn't you, please contact support immediately.</p>",
      });
    } catch (mailErr) {
      console.error("MAILER_ERROR[reset notify]:", mailErr);
    }

    return res.json({ message: "Password updated" });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("RESET_ERROR:", e);
    return res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

export default router;
