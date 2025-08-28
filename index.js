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


const app = express();

// middleware
app.use(cors());                    // npm i cors
app.use(express.json());

// static (for testing previews)
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));
app.use("/qrcodes", express.static(path.join(process.cwd(), "qrcodes")));

// health
app.get("/", (_req, res) => res.send("API OK"));

// mount routes (all pages)

app.use("/auth", authRoutes);
app.use("/documents", docRoutes);
app.use("/shares", shareRoutes);
app.use("/otp", otpRoutes);


// 404 fallback
app.use((req, res) => res.status(404).json({ error: "Not found" }));

// error handler
app.use((err, _req, res, _next) => {
  console.error("UNHANDLED_ERROR:", err);
  res.status(500).json({ error: "Server error" });
});

const PORT =  5000;
app.listen(PORT, () => console.log(`✅ API running at http://localhost:${PORT}`));
