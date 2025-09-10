// index.js
import express from "express";
import cors from "cors";

// ---- Route imports ----
import authRoutes from "./routes/auth.routes.js";           // /auth/...
import miscRoutes from "./routes/misc.routes.js";           // /misc/...
import sharesRoutes from "./routes/shares.routes.js";       // /shares/...
import documentsRoutes from "./routes/documents.routes.js"; // /documents/...
import reduceRoutes from "./routes/reduce.js";              // /api/reduce/...

const app = express();

/* ---------------------------- Middleware ---------------------------- */
app.use(cors());
app.use(express.json({ limit: "25mb" })); // bump if you handle big files

/* --------------------------- Health check --------------------------- */
app.get("/", (_req, res) => res.send("✅ QR-Docs API is running"));

/* ----------------------------- Routes ------------------------------- */
app.use("/auth", authRoutes);
app.use("/misc", miscRoutes);
app.use("/shares", sharesRoutes);
app.use("/documents", documentsRoutes);
app.use("/api/reduce", reduceRoutes);

/* --------------------------- 404 fallback --------------------------- */
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

/* ------------------------ Global error handler ---------------------- */
app.use((err, req, res, _next) => {
  console.error("[express] Unhandled error:", err?.stack || err);
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ---------------------------- Start server -------------------------- */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
