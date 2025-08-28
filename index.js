import "dotenv/config";
import express from "express";
import path from "path";
import cors from "cors";
import { fileURLToPath } from "url";

// init DB pool (ensures connection)
import { pool } from "./db/db.js";

// routes
import authRoutes from "./routes/auth.routes.js";
import docRoutes from "./routes/documents.routes.js";
import shareRoutes from "./routes/shares.routes.js";
import otpRoutes from "./routes/otp.routes.js";
import notifyRoutes from "./routes/notify.routes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// CORS (allow your Vercel app)
const ALLOW_ORIGIN = "https://qr-project-react.vercel.app";

app.use(cors({
  origin: ALLOW_ORIGIN,
  credentials: false,
  allowedHeaders: ["Content-Type", "Authorization", "x-user-id"],
  exposedHeaders: ["Content-Disposition","Content-Type","Content-Length","Accept-Ranges"],
}));

app.use(express.json());

// Static: serve QR images & uploaded docs
app.use("/qrcodes", express.static(path.join(process.cwd(), "qrcodes")));
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

// Health
app.get("/", (_req, res) => res.send("API OK"));

// Routes
app.use("/auth", authRoutes);
app.use("/documents", docRoutes);
app.use("/shares", shareRoutes);
app.use("/otp", otpRoutes);
app.use("/notify", notifyRoutes);

// 404
app.use((req, res) => res.status(404).json({ error: "Not found" }));

// Error handler
app.use((err, _req, res, _next) => {
  console.error("UNHANDLED_ERROR:", err);
  res.status(500).json({ error: "Server error" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ API running at http://localhost:${PORT}`));
