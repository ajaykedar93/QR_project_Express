// middleware/upload.js
import multer from "multer";
import { v4 as uuid } from "uuid";
import path from "path";
import fs from "fs";

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Save files in uploads/<user_id>/, or "anonymous" if no user
    const userId = req.user?.user_id || "anonymous";
    const dir = path.join(process.cwd(), "uploads", userId);

    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuid() + ext.toLowerCase());
  },
});

// Optional: filter + limits
const fileFilter = (req, file, cb) => {
  // Example: reject empty files or very large ones
  if (!file.originalname) return cb(new Error("Empty filename"), false);
  cb(null, true);
};

export const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB per file (adjust as needed)
});
