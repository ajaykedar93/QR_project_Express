// middleware/auth.js
import jwt from "jsonwebtoken";

export function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { user_id: payload.user_id, email: payload.email };
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}
