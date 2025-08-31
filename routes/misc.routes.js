// routes/misc.routes.js
import { Router } from "express";
import { pool } from "../db/db.js";

const router = Router();

/**
 * GET /auth/exists?email=
 * Used by the frontend to show "Registered ✅" vs "Not registered"
 */
router.get("/auth/exists", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim();
    if (!email) return res.json({ exists: false });
    const q = `SELECT 1 FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`;
    const r = await pool.query(q, [email]);
    res.json({ exists: !!r.rowCount });
  } catch (err) {
    console.error("AUTH_EXISTS_ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
