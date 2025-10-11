import "dotenv/config";  // ✅ ESM-safe dotenv
import express from "express";
import cors from "cors";
import { sendEmail } from './utils/mailer.js';  // Correct path for mailer.js

// Import routes
import authRoutes from "./routes/auth.routes.js";
import miscRoutes from "./routes/misc.routes.js";
import sharesRoutes from "./routes/shares.routes.js";
import documentsRoutes from "./routes/documents.routes.js";
import reduceRoutes from "./routes/reduce.js";

// Initialize Express app
const app = express();
app.use(cors());  // CORS middleware
app.use(express.json({ limit: "25mb" }));  // JSON parsing middleware

// Simple route to check API status
app.get("/", (_req, res) => res.send("✅ QR-Docs API is running"));

// Use route handlers
app.use("/auth", authRoutes);
app.use("/misc", miscRoutes);
app.use("/shares", sharesRoutes);
app.use("/documents", documentsRoutes);
app.use("/api/reduce", reduceRoutes);

// Route to send an email to a user
app.post('/send-email', async (req, res) => {
  const { email, subject, message } = req.body;

  if (!email || !subject || !message) {
    return res.status(400).send("Please provide 'email', 'subject', and 'message'.");
  }

  try {
    await sendEmail(email, subject, message);  // Send the email using the provided data
    res.status(200).send("Email sent successfully!");
  } catch (error) {
    res.status(500).send("Failed to send email.");
  }
});


// Start the server
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
