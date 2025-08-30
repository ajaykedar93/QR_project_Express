// index.js
import "dotenv/config.js";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";

// DB pool (ensures process exits if DB is misconfigured)
import { pool } from "./db/db.js";

// Routers
import authRouter from "./routes/auth.routes.js";
import documentsRouter from "./routes/documents.routes.js";
import sharesRouter from "./routes/shares.routes.js";
import otpRouter from "./routes/otp.routes.js";

// ---- Setup base app ----
const app = express();
app.set("trust proxy", 1); // Render/Proxies

// Resolve __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Config / CORS ----
const APP_URL = process.env.PUBLIC_APP_URL || "http://localhost:5173"; // Vercel (prod) or Vite (dev)
const API_URL = process.env.PUBLIC_API_URL || ""; // optional, if you expose API to browser
const DEV_ORIGIN = "http://localhost:5173";       // Vite default dev server

// Build allowed origins
const allowlist = new Set(
  [APP_URL, API_URL, DEV_ORIGIN]
    .filter(Boolean)
    .map((u) => u.replace(/\/$/, "")) // trim trailing slash
);

app.use(
  cors({
    origin(origin, cb) {
      // allow non-browser clients (e.g., curl, server-to-server)
      if (!origin) return cb(null, true);
      const clean = origin.replace(/\/$/, "");
      return allowlist.has(clean) ? cb(null, true) : cb(new Error("CORS: Not allowed"));
    },
    credentials: true,
    exposedHeaders: ["Content-Disposition", "Content-Type", "Content-Length", "Accept-Ranges"],
  })
);

// ---- Security / logging ----
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }, // allow serving files to other origins
  })
);
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// ---- Parsers ----
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ---- Health checks ----
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "doc-share-api",
    time: new Date().toISOString(),
    app_url: APP_URL,
  });
});

app.get("/healthz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (e) {
    console.error("DB_HEALTH_ERROR:", e);
    res.status(500).json({ ok: false, error: "DB not reachable" });
  }
});

// ---- Static files (uploads) ----
// If you're temporarily storing files on disk (for dev). In prod, prefer Supabase Storage/S3.
const uploadsDir = path.join(process.cwd(), "uploads");
app.use("/uploads", express.static(uploadsDir, { fallthrough: true }));

// ---- Mount routes ----
app.use("/auth", authRouter);
app.use("/documents", documentsRouter);
app.use("/shares", sharesRouter);
app.use("/otp", otpRouter);

// ---- 404 handler ----
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ---- Error handler ----
app.use((err, req, res, _next) => {
  console.error("UNCAUGHT_ERROR:", err?.message || err);
  const status = err?.status || 500;
  res.status(status).json({ error: err?.message || "Server error" });
});

// ---- Start server (Render sets PORT) ----
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, async () => {
  // Probe DB on start to fail fast if misconfigured
  try {
    await pool.query("SELECT 1");
    console.log(`✅ DB connected`);
  } catch (e) {
    console.error("❌ DB connection failed:", e.message);
  }

  console.log(`🚀 API listening on port ${PORT}`);
  console.log(`   CORS allowlist: ${Array.from(allowlist).join(", ") || "(none)"}`);
  console.log(`   Frontend URL (PUBLIC_APP_URL): ${APP_URL}`);
});

export default app;
