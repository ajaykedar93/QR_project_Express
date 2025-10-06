// middleware/upload.js
import multer from "multer";
import { v4 as uuid } from "uuid";
import path from "node:path";
import fs from "node:fs";

export const FILE_ROOT = process.env.FILE_ROOT || path.resolve("uploads");


fs.mkdirSync(FILE_ROOT, { recursive: true });

const ALLOWED_EXT = new Set([
  // docs
  "pdf", "txt", "md",
  // office
  "doc", "docx", "ppt", "pptx", "xls", "xlsx", "csv",
  // images
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg",
  // media
  "mp3", "wav", "ogg", "mp4", "webm", "mov", "m4a",
  // data/text
  "json", "xml", "yaml", "yml", "log",
  // archives (preview fallback only)
  "zip", "rar", "7z", "tar", "gz",
]);

const BLOCKED_EXT = new Set([
  "exe", "msi", "bat", "cmd", "sh", "ps1", "php", "jsp", "asp", "dll", "so",
]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {

    const userId = req.user?.user_id ? String(req.user.user_id) : "anonymous";
    const userDir = path.join(FILE_ROOT, userId);
    try {
      fs.mkdirSync(userDir, { recursive: true });
    } catch (e) {
      return cb(e);
    }
    cb(null, userDir);
  },
  filename: (_req, file, cb) => {
    
    const ext = (path.extname(file.originalname || "").toLowerCase()) || "";
    const name = `${Date.now()}-${uuid()}${ext}`;
    cb(null, name);
  },
});


function getExtLower(name = "") {

  return (path.extname(name).slice(1) || "").toLowerCase();
}

const fileFilter = (req, file, cb) => {
  const original = file?.originalname || "";
  if (!original.trim()) return cb(new Error("Empty filename"), false);

  const ext = getExtLower(original);


  if (BLOCKED_EXT.has(ext)) return cb(new Error("Blocked file type"), false);


  if (!ALLOWED_EXT.has(ext)) return cb(new Error("Unsupported file type"), false);

  cb(null, true);
};

const MAX_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 20 * 1024 * 1024); // default 20MB

export const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_BYTES },
});
