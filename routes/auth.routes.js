// routes/auth.routes.js
import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import { pool } from "../db/db.js";
import { auth } from "../middleware/auth.js";

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


/* ----------------------------- Rate limits ----------------------------- */
// Adjust windows/limits as needed
const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 50,                  // 50 attempts per window per IP
  standardHeaders: true,
  legacyHeaders: false,
});
const existsLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 120,                // to reduce email enumeration abuse
  standardHeaders: true,
  legacyHeaders: false,
});

/* ----------------------------- Rate Limits ----------------------------- */
const forgotLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 10, // Max 10 requests per IP per window for password recovery
  standardHeaders: true,
  legacyHeaders: false,
});


// Email OTP
async function sendOtp(email) {
  const otp = crypto.randomInt(100000, 999999).toString(); // Generate a 6 digit OTP
  const transporter = nodemailer.createTransport({
    service: 'gmail', // You can use other services (e.g., SendGrid, Mailgun)
    auth: {
      user: process.env.EMAIL_USER, // from .env
      pass: process.env.EMAIL_PASS, // from .env
    },
  });

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: email,
    subject: 'Password Reset OTP',
    text: `Your OTP for password reset is: ${otp}`,
  };

  try {
    await transporter.sendMail(mailOptions);
    // Store OTP in the database for validation
    await pool.query("UPDATE users SET otp = $1 WHERE email = $2", [otp, email]);
    return otp;
  } catch (error) {
    console.error("Email send failed:", error);
    throw new Error("Failed to send OTP");
  }
}

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

    // Safety backfill: link pending shares for this email (trigger already does this)
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
      // unique_violation on users(email)
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
    // With CITEXT we can use '=' directly
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

    // CITEXT '=' is case-insensitive
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



// POST /auth/forgot/start - Send OTP to email for password recovery
router.post("/forgot/start", forgotLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    const normalizedEmail = normalizeStr(email);

    if (!validEmail(normalizedEmail)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    const result = await pool.query("SELECT * FROM users WHERE email = $1", [normalizedEmail]);
    const user = result.rows[0];
    if (!user) {
      return res.status(404).json({ error: "Email not found" });
    }

    // Send OTP to email
    await sendOtp(normalizedEmail);
    res.status(200).json({ message: "OTP sent to your email" });
  } catch (err) {
    console.error("Forgot Password Start Error:", err);
    res.status(500).json({ error: "Failed to initiate password reset" });
  }
});

// POST /auth/forgot/verify - Verify OTP
router.post("/forgot/verify", async (req, res) => {
  try {
    const { email, otp } = req.body;
    const normalizedEmail = normalizeStr(email);

    // Validate OTP format
    if (!otp || otp.length !== 6) {
      return res.status(400).json({ error: "Invalid OTP format" });
    }

    const result = await pool.query("SELECT * FROM users WHERE email = $1", [normalizedEmail]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: "Email not found" });

    // Verify OTP
    if (user.otp !== otp) {
      return res.status(400).json({ error: "Invalid OTP" });
    }

    // Generate reset token
    const resetToken = jwt.sign({ email: normalizedEmail }, mustEnv("JWT_SECRET", "dev-secret"), { expiresIn: "15m" });
    res.status(200).json({ reset_token: resetToken });
  } catch (err) {
    console.error("Forgot Password Verify Error:", err);
    res.status(500).json({ error: "Failed to verify OTP" });
  }
});

// POST /auth/forgot/reset - Reset password
router.post("/forgot/reset", async (req, res) => {
  try {
    const { reset_token, new_password } = req.body;

    // Validate reset token
    let decoded;
    try {
      decoded = jwt.verify(reset_token, mustEnv("JWT_SECRET", "dev-secret"));
    } catch (e) {
      return res.status(400).json({ error: "Invalid or expired reset token" });
    }

    const email = decoded.email;
    if (!email) return res.status(400).json({ error: "Missing email in reset token" });

    if (!new_password || new_password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const password_hash = await bcrypt.hash(new_password, 10);

    // Update password in DB
    await pool.query("UPDATE users SET password_hash = $1 WHERE email = $2", [password_hash, email]);

    res.status(200).json({ message: "Password successfully reset" });
  } catch (err) {
    console.error("Password Reset Error:", err);
    res.status(500).json({ error: "Failed to reset password" });
  }
});

export default router;
