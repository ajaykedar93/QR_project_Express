// routes/auth.routes.js
import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { pool } from "../db/db.js";

const router = Router();

/**
 * Helpers
 */
function normalizeStr(v) {
  return typeof v === "string" ? v.trim() : "";
}
function mustEnv(name, fallback) {
  const val = process.env[name];
  return val && val.length ? val : (fallback ?? "");
}

/**
 * POST /auth/register
 * body: { full_name, email, password }
 * success: 201 { user_id, full_name, email, is_verified, created_at }
 *
 * Notes:
 * - users.email is CITEXT (case-insensitive) in DB; simple equality works.
 * - A DB trigger already links pending shares (to_user_email -> to_user_id) on user insert.
 *   We also keep a backfill UPDATE here as a safety net (idempotent).
 */
router.post("/register", async (req, res) => {
  const client = await pool.connect();
  try {
    let { full_name, email, password } = req.body || {};
    full_name = normalizeStr(full_name);
    email = normalizeStr(email);

    if (!full_name || !email || !password) {
      return res.status(400).json({ error: "Missing full_name, email or password" });
    }

    // Hash password
    const password_hash = await bcrypt.hash(String(password), 10);

    await client.query("BEGIN");

    // Insert user (CITEXT handles case-insensitive uniqueness)
    const insertSql = `
      INSERT INTO users (full_name, email, password_hash)
      VALUES ($1, $2, $3)
      RETURNING user_id, full_name, email, is_verified, created_at
    `;
    const { rows } = await client.query(insertSql, [full_name, email, password_hash]);
    const newUser = rows[0];

    // Safety net: backfill any pending shares (trigger should do this already)
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
    // Unique violation (email already exists)
    if (e?.code === "23505") {
      return res.status(409).json({ error: "Email already registered" });
    }
    console.error("REGISTER_ERROR:", e);
    return res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

/**
 * POST /auth/login
 * body: { email, password }
 * success: 200 { token, user:{ user_id, full_name, email, is_verified, created_at } }
 */
router.post("/login", async (req, res) => {
  try {
    let { email, password } = req.body || {};
    email = normalizeStr(email);
    if (!email || !password) {
      return res.status(400).json({ error: "Missing email or password" });
    }

    // CITEXT comparison works with '='; no need for LOWER()
    const q = `
      SELECT user_id, full_name, email, password_hash, is_verified, created_at
      FROM users
      WHERE email = $1
      LIMIT 1
    `;
    const { rows } = await pool.query(q, [email]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const ok = await bcrypt.compare(String(password), user.password_hash);
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

/**
 * GET /auth/exists?email=...
 * success: 200 { exists: boolean }
 */
router.get("/exists", async (req, res) => {
  try {
    const email = normalizeStr(req.query.email || "");
    if (!email) return res.json({ exists: false });

    // CITEXT = case-insensitive, so '=' is enough
    const r = await pool.query(
      `SELECT 1 FROM users WHERE email = $1 LIMIT 1`,
      [email]
    );

    res.json({ exists: r.rowCount > 0 });
  } catch (err) {
    console.error("USER_EXISTS_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
