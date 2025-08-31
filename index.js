// index.js
import "dotenv/config.js";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";

// DB (fail fast if misconfigured)
import { pool } from "./db/db.js";

// Routers
import authRouter from "./routes/auth.routes.js";
import documentsRouter from "./routes/documents.routes.js";
import sharesRouter from "./routes/shares.routes.js";
import otpRouter from "./routes/otp.routes.js";

// ---------- App / Paths ----------
const app = express();
app.set("trust proxy", 1);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- Env / URLs ----------
const PORT = Number(process.env.PORT || 5000);

// FRONTEND URL where users open QR links (used by share emails/QRs)
const APP_URL =
  (process.env.PUBLIC_APP_URL && process.env.PUBLIC_APP_URL.replace(/\/$/, "")) ||
  "http://localhost:5173";

// Optional public API base if you expose it to the browser
const API_URL =
  (process.env.PUBLIC_API_URL && process.env.PUBLIC_API_URL.replace(/\/$/, "")) ||
  `http://localhost:${PORT}`;

// Local dev origin (Vite)
const DEV_ORIGIN = "http://localhost:5173";

// ---------- CORS ----------
const allowlist = new Set(
  [APP_URL, API_URL, DEV_ORIGIN]
    .filter(Boolean)
    .map((u) => u.replace(/\/$/, ""))
);

app.use(
  cors({
    origin(origin, cb) {
      // Allow non-browser clients and same-origin
      if (!origin) return cb(null, true);
      const clean = origin.replace(/\/$/, "");
      return allowlist.has(clean) ? cb(null, true) : cb(new Error("CORS: Not allowed"));
    },
    credentials: true,
    exposedHeaders: ["Content-Disposition", "Content-Type", "Content-Length", "Accept-Ranges"],
  })
);

// ---------- Security / Logging ----------
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }, // allow file preview from other origins
  })
);
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// ---------- Body parsing ----------
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ---------- Health ----------
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "doc-share-api",
    time: new Date().toISOString(),
    app_url: APP_URL,
    api_url: API_URL,
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

// ---------- Static (uploads) ----------
const uploadsDir = path.join(process.cwd(), "uploads");
app.use("/uploads", express.static(uploadsDir, { fallthrough: true }));

// ---------- Routes ----------
app.use("/auth", authRouter);
app.use("/documents", documentsRouter);
app.use("/shares", sharesRouter);
app.use("/otp", otpRouter);

// ---------- 404 ----------
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ---------- Error handler ----------
app.use((err, req, res, _next) => {
  console.error("UNCAUGHT_ERROR:", err?.message || err);
  const status = err?.status || 500;
  res.status(status).json({ error: err?.message || "Server error" });
});

// ---------- Start ----------
app.listen(PORT, async () => {
  try {
    await pool.query("SELECT 1");
    console.log("✅ DB connected");
  } catch (e) {
    console.error("❌ DB connection failed:", e.message);
  }

  console.log(`🚀 API listening on http://localhost:${PORT}`);
  console.log(`   Frontend URL (PUBLIC_APP_URL): ${APP_URL}`);
  console.log(`   Public API URL (PUBLIC_API_URL): ${API_URL}`);
  console.log(`   CORS allowlist: ${Array.from(allowlist).join(", ") || "(none)"}`);
});

export default app;
