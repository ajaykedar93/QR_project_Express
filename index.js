// index.js
import express from "express";
import cors from "cors";

import authRoutes from "./routes/auth.routes.js";          
import miscRoutes from "./routes/misc.routes.js";          
import sharesRoutes from "./routes/shares.routes.js";       
import documentsRoutes from "./routes/documents.routes.js"; 
import reduceRoutes from "./routes/reduce.js";              

const app = express();

// Trust proxy setting for correct identification of client IP behind proxy
app.set('trust proxy', 1);  // This line will fix the 'X-Forwarded-For' error

app.use(cors());
app.use(express.json({ limit: "25mb" })); 

app.get("/", (_req, res) => res.send("✅ QR-Docs API is running"));

app.use("/auth", authRoutes);
app.use("/misc", miscRoutes);
app.use("/shares", sharesRoutes);
app.use("/documents", documentsRoutes);
app.use("/api/reduce", reduceRoutes);

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use((err, req, res, _next) => {
  console.error("[express] Unhandled error:", err?.stack || err);
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error" });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});  
