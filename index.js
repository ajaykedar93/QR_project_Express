// index.js
import express from "express";
import cors from "cors";

// ---- Route imports ----
import authRoutes from "./routes/auth.routes.js";          // /auth/register, /auth/login, /auth/exists
import miscRoutes from "./routes/misc.routes.js";          // any misc endpoints if you have them
import sharesRoutes from "./routes/shares.routes.js";      // /shares/...
import documentsRoutes from "./routes/documents.routes.js"; // /documents/...

const app = express();

// ---- Middleware ----
app.use(cors());
app.use(express.json());

// ---- Health check ----
app.get("/", (_req, res) => res.send("QR-Docs API OK"));

// ---- Routes ----
app.use("/auth", authRoutes);
app.use(miscRoutes);
app.use("/shares", sharesRoutes);
app.use("/documents", documentsRoutes);

// ---- 404 fallback ----
app.use((req, res) => res.status(404).json({ error: "Not found" }));

// ---- Start server on port 5000 ----
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
