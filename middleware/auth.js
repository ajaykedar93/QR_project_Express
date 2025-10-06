// middleware/auth.js
import jwt from "jsonwebtoken";


export function auth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const [scheme, token] = header.split(" ");

    if (!scheme || scheme.toLowerCase() !== "bearer" || !token) {
      return res.status(401).json({ error: "Missing or malformed token" });
    }

    const secret = process.env.JWT_SECRET || "dev-secret";
    if (secret === "dev-secret") {
      console.warn("⚠️ JWT_SECRET not set. Using fallback dev-secret.");
    }

    const payload = jwt.verify(token, secret);

    req.user = {
      user_id: payload.user_id,
      email: payload.email,
    };

    next();
  } catch (err) {
    console.error("AUTH_ERROR:", err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
