// src/middleware/optionalAuth.js
import jwt from "jsonwebtoken";

/**
 * optionalAuth
 * - If an Authorization: Bearer <token> header is present AND valid, set req.user.
 * - If header is missing or token is invalid/expired, do NOT block the request; just continue.
 * - Requires JWT_SECRET in env to verify tokens.
 */
export function optionalAuth(req, _res, next) {
  const hdr = req.headers.authorization || "";
  const m = hdr.match(/^Bearer\s+(.+)$/i);
  if (!m) return next();

  const token = m[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // normalize the shape your app expects:
    req.user = {
      user_id: payload.user_id ?? payload.id ?? payload.sub,
      email: payload.email,
      ...payload,
    };
  } catch {
    // ignore invalid token; continue unauthenticated
  }
  next();
}
