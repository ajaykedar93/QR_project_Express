import "dotenv/config";              // ✅ ESM-safe dotenv
import express from "express";
import cors from "cors";
import { pool } from "./db/db.js";  // Import DB pool

import authRoutes from "./routes/auth.routes.js";
import miscRoutes from "./routes/misc.routes.js";
import sharesRoutes from "./routes/shares.routes.js";
import documentsRoutes from "./routes/documents.routes.js";
import reduceRoutes from "./routes/reduce.js";

// Initialize Express app
const app = express();
app.set("trust proxy", 1);

// Middleware for CORS and JSON parsing
app.use(cors()); // or configure: cors({ origin: process.env.FRONTEND_ORIGIN || "*" })
app.use(express.json({ limit: "25mb" }));

// Simple route to check API status
app.get("/", (_req, res) => res.send("✅ QR-Docs API is running"));

// Use routes
app.use("/auth", authRoutes);
app.use("/misc", miscRoutes);
app.use("/shares", sharesRoutes);
app.use("/documents", documentsRoutes);
app.use("/api/reduce", reduceRoutes);

// 404 route if no routes match
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Error handler (handles any unhandled errors)
app.use((err, req, res, _next) => {
  console.error("[express] Unhandled error:", err?.stack || err);
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// Timeout handler for API requests (default to 30 seconds)
app.use((req, res, next) => {
  res.setTimeout(30000, () => { // Timeout after 30 seconds
    console.error("Request timed out!");
    res.status(408).send("Request Timeout");
  });
  next();
});

// Graceful Shutdown Logic
async function shutdown(signal) {
  console.log(`\n${signal} received: closing HTTP server...`);
  server.close(async (closeErr) => {
    if (closeErr) {
      console.error("Error closing HTTP server:", closeErr);
    }
    try {
      console.log("Closing PostgreSQL pool...");
      await pool.end();  // Gracefully close the DB connection pool
    } catch (dbErr) {
      console.error("Error closing DB pool:", dbErr);
    } finally {
      console.log("👋 Shutdown complete.");
      process.exit(closeErr ? 1 : 0);
    }
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Start the server
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

// Optional: Database connection test on startup
pool.connect()
  .then(client => {
    console.log("✅ Connected to PostgreSQL (Supabase)");
    client.release();
  })
  .catch(err => {
    console.error("❌ DB connection error:", err.message);
  });
