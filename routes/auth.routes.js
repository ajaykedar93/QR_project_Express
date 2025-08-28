// routes/auth.routes.js
import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { pool } from "../db/db.js";

const router = Router();

/**
 * POST /auth/register
 * body: { full_name, email, password }
 * success: 201 { user_id, email, is_verified, created_at }
 *
 * Also backfills any existing shares that were created to this email
 * before the user registered (sets shares.to_user_id).
 */
router.post("/register", async (req, res) => {
  try {
    let { full_name, email, password } = req.body || {};
    if (!full_name || !email || !password) {
      return res.status(400).json({ error: "Missing fields" });
    }

    full_name = String(full_name).trim();
    email = String(email).trim();

    const hash = await bcrypt.hash(password, 10);

    // Insert user
    const insUser = `
      INSERT INTO users (full_name, email, password_hash)
      VALUES ($1,$2,$3)
      RETURNING user_id, email, is_verified, created_at
    `;
    const { rows } = await pool.query(insUser, [full_name, email, hash]);
    const newUser = rows[0];

    // Backfill pending shares that targeted this email before registration
    await pool.query(
      `UPDATE shares
         SET to_user_id = $1
       WHERE to_user_id IS NULL
         AND to_user_email IS NOT NULL
         AND LOWER(to_user_email) = LOWER($2)`,
      [newUser.user_id, newUser.email]
    );

    return res.status(201).json(newUser);
  } catch (e) {
    if (e?.code === "23505") {
      return res.status(409).json({ error: "Email already registered" });
    }
    console.error("REGISTER_ERROR:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /auth/login
 * body: { email, password }
 * success: 200 { token, user:{ user_id, email, is_verified } }
 */
router.post("/login", async (req, res) => {
  try {
    let { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Missing email or password" });
    }
    email = String(email).trim();

    const q = `
      SELECT user_id, email, password_hash, is_verified
      FROM users
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1
    `;
    const { rows } = await pool.query(q, [email]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    if (!process.env.JWT_SECRET) {
      console.warn("⚠️ JWT_SECRET is not set in environment variables.");
    }
    const token = jwt.sign(
      { user_id: user.user_id, email: user.email },
      process.env.JWT_SECRET || "dev-secret",
      { expiresIn: "7d" }
    );

    return res.json({
      token,
      user: {
        user_id: user.user_id,
        email: user.email,
        is_verified: user.is_verified,
      },
    });
  } catch (e) {
    console.error("LOGIN_ERROR:", e);
    return res.status(500).json({ error: "Server error" });
  }
});




router.get("/exists", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim();
    if (!email) return res.json({ exists: false });

    const r = await pool.query(
      `SELECT 1 FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`,
      [email]
    );

    res.json({ exists: r.rowCount > 0 });
  } catch (err) {
    console.error("USER_EXISTS_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
