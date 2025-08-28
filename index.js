// index.js
import "dotenv/config";
import express from "express";
import path from "path";
import cors from "cors";

// init DB pool (logs connection once)
import { pool } from "./db/db.js";

// routes
import authRoutes from "./routes/auth.routes.js";
import docRoutes from "./routes/documents.routes.js";
import shareRoutes from "./routes/shares.routes.js";
import otpRoutes from "./routes/otp.routes.js";
import notifyRoutes from "./routes/notify.routes.js";

const app = express();

// middleware
app.use(cors());                    // npm i cors
app.use(express.json());

// Serve QR images (already in your server per earlier messages)
app.use("/qrcodes", express.static(path.join(process.cwd(), "qrcodes")));
// static (for testing previews)
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));


// health
app.get("/", (_req, res) => res.send("API OK"));

// mount routes (all pages)

app.use("/auth", authRoutes);
app.use("/documents", docRoutes);
app.use("/shares", shareRoutes);
app.use("/otp", otpRoutes);
app.use("/notify", notifyRoutes);

// 404 fallback
app.use((req, res) => res.status(404).json({ error: "Not found" }));

// error handler
app.use((err, _req, res, _next) => {
  console.error("UNHANDLED_ERROR:", err);
  res.status(500).json({ error: "Server error" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`API on http://10.207.99.247:${PORT}`)
);
