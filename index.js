import "dotenv/config";  // ✅ ESM-safe dotenv
import express from "express";
import cors from "cors";

// Import routes
import authRoutes from "./routes/auth.routes.js";
import miscRoutes from "./routes/misc.routes.js";
import sharesRoutes from "./routes/shares.routes.js";
import documentsRoutes from "./routes/documents.routes.js";
import reduceRoutes from "./routes/reduce.js";
import testMailRoutes from "./routes/mail.test.js"; 

// Initialize Express app
const app = express();
app.use(cors());  // CORS middleware
app.use(express.json({ limit: "25mb" }));  // JSON parsing middleware
app.set("trust proxy", 1);

// Simple route to check API status
app.get("/", (_req, res) => res.send("✅ QR-Docs API is running"));

// Use route handlers
app.use("/auth", authRoutes);
app.use("/misc", miscRoutes);
app.use("/shares", sharesRoutes);
app.use("/documents", documentsRoutes);
app.use("/api/reduce", reduceRoutes);

app.use("/", testMailRoutes); // add test routes


// Start the server
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
