// ✅ routes/auth.routes.js
import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import { pool } from "../db/db.js";
import { auth } from "../middleware/auth.js";
import { sendEmail } from "../utils/mailer.js";
import "dotenv/config";

const router = Router();

// ---------- Helpers ----------
function normalizeStr(v) {
  return typeof v === "string" ? v.trim() : "";
}

function mustEnv(name, fallback) {
  const val = process.env[name];
  return val && val.length ? val : fallback ?? "";
}

function validEmail(email) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

function genOTP(length = 6) {
  const n = Math.floor(Math.random() * 1_000_000);
  return n.toString().padStart(length, "0");
}

// ---------- Config ----------
const OTP_WINDOW_MIN = Number(mustEnv("OTP_WINDOW_MIN", "10"));
const FROM_EMAIL = process.env.EMAIL_USER || "noreply@qr-docs.app";

// ---------- Rate limiters ----------
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

// ----------------------
// REGISTER
// ----------------------
router.post("/register", async (req, res) => {
  const client = await pool.connect();
  try {
    let { full_name, email, password } = req.body || {};
    full_name = normalizeStr(full_name);
    email = normalizeStr(email);
    const pwd = String(password ?? "");

    if (!full_name || !email || !pwd) return res.status(400).json({ error: "Missing fields" });
    if (!validEmail(email)) return res.status(400).json({ error: "Invalid email" });
    if (pwd.trim().length < 8) return res.status(400).json({ error: "Password too short" });

    const password_hash = await bcrypt.hash(pwd, 10);
    await client.query("BEGIN");

    const insertSql = `
      INSERT INTO users (full_name, email, password_hash)
      VALUES ($1, $2, $3)
      RETURNING user_id, full_name, email, is_verified, created_at
    `;
    const { rows } = await client.query(insertSql, [full_name, email, password_hash]);
    const newUser = rows[0];

    // Send welcome email (optional)
    try {
      await sendEmail({
        to: email,
        subject: "Welcome to QR-Docs!",
        html: `<p>Hi <b>${full_name}</b>,</p><p>Welcome to QR-Docs — your secure document sharing platform.</p>`,
      });
    } catch (mailErr) {
      console.error("MAILER_ERROR[register]:", mailErr);
    }

    await client.query("COMMIT");
    return res.status(201).json(newUser);
  } catch (e) {
    await client.query("ROLLBACK");
    if (e?.code === "23505") return res.status(409).json({ error: "Email already registered" });
    console.error("REGISTER_ERROR:", e);
    return res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

// ----------------------
// LOGIN
// ----------------------
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

    const secret = mustEnv("JWT_SECRET", "dev-secret");
    const token = jwt.sign({ user_id: user.user_id, email: user.email }, secret, {
      expiresIn: mustEnv("JWT_EXPIRES_IN", "7d"),
    });

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

// ----------------------
// CHECK EMAIL EXISTS
// ----------------------
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

// ----------------------
// GET CURRENT USER
// ----------------------
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

// ----------------------
// FORGOT PASSWORD (send OTP)
// ----------------------
router.post("/forgot", forgotLimiter, async (req, res) => {
  const email = normalizeStr(req.body?.email || "");
  if (!email || !validEmail(email))
    return res.status(200).json({ message: "If that account exists, an OTP has been sent." });

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT user_id, email FROM users WHERE email = $1 LIMIT 1`,
      [email]
    );

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

      try {
        await sendEmail({
          to: email,
          subject: "Your password reset code",
          html: `<p>Your password reset code is: <b>${otp}</b></p><p>Expires in ${OTP_WINDOW_MIN} minutes.</p>`,
        });
      } catch (mailErr) {
        console.error("MAILER_ERROR[forgot]:", mailErr);
      }
    }

    return res
      .status(200)
      .json({ message: "If that account exists, an OTP has been sent." });
  } catch (e) {
    console.error("FORGOT_ERROR:", e);
    return res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

// ----------------------
// RESET VERIFY OTP
// ----------------------
router.post("/reset/verify", resetLimiter, async (req, res) => {
  try {
    const email = normalizeStr(req.body?.email || "");
    const otp = normalizeStr(req.body?.otp || "");
    if (!email || !otp) return res.status(400).json({ error: "Missing email or otp" });

    const { rows } = await pool.query(
      `SELECT user_id, reset_token, reset_token_expiry
         FROM users
        WHERE email = $1
        LIMIT 1`,
      [email]
    );
    const user = rows[0];
    if (!user || !user.reset_token || !user.reset_token_expiry)
      return res.status(404).json({ error: "Invalid or expired code" });

    const now = new Date();
    if (user.reset_token !== otp || now > new Date(user.reset_token_expiry))
      return res.status(404).json({ error: "Invalid or expired code" });

    return res.json({ ok: true });
  } catch (e) {
    console.error("RESET_VERIFY_ERROR:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// ----------------------
// RESET PASSWORD
// ----------------------
router.post("/reset", resetLimiter, async (req, res) => {
  const email = normalizeStr(req.body?.email || "");
  const otp = normalizeStr(req.body?.otp || "");
  const newPassword = String(req.body?.new_password ?? "").trim();

  if (!email || !otp || !newPassword)
    return res.status(400).json({ error: "Missing fields" });
  if (newPassword.length < 8)
    return res.status(400).json({ error: "Password too short" });

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT user_id, reset_token, reset_token_expiry
         FROM users
        WHERE email = $1
        LIMIT 1`,
      [email]
    );
    const user = rows[0];
    if (!user || !user.reset_token || !user.reset_token_expiry)
      return res.status(404).json({ error: "Invalid or expired code" });

    const now = new Date();
    if (user.reset_token !== otp || now > new Date(user.reset_token_expiry))
      return res.status(404).json({ error: "Invalid or expired code" });

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

    // Confirmation email
    try {
      await sendEmail({
        to: email,
        subject: "Your password has been updated",
        html: `<p>Your password was changed successfully.</p>
               <p>If this wasn't you, contact support immediately.</p>`,
      });
    } catch (mailErr) {
      console.error("MAILER_ERROR[reset notify]:", mailErr);
    }

    return res.json({ message: "Password updated successfully" });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("RESET_ERROR:", e);
    return res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

export default router;
